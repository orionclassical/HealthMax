/**
 * openaiService.js
 *
 * OpenAI integration (GPT-4.1 Mini / GPT-4o Mini).
 * Two responsibilities:
 *
 *   1. fillMissingNutrients(product)
 *   2. getPhilippineAlternatives(product, currentScore)
 *
 * Env var required:
 *   OPENAI_API_KEY — API key from https://platform.openai.com/api-keys
 *
 * CHANGELOG (alternatives fix):
 *   - Root cause of "chips -> romaine lettuce": when a scanned product has
 *     no OFF category, categoryLabel fell back to "general", giving the
 *     model no signal about product FORM. Prompt now derives a form hint
 *     from the product name itself and hard-bans cross-category swaps.
 *   - Added dedupe: alternatives can no longer repeat each other or the
 *     scanned product name.
 *   - Added nova_group + additives_count to the schema (were hardcoded
 *     null before), so scoring/frontend table isn't missing data.
 *   - Switched alternatives call to Structured Outputs (json_schema,
 *     strict) so malformed/partial JSON can't slip through — removes the
 *     need for the forgiving-parser fallback path on this call and cuts
 *     retries.
 *   - Trimmed max_tokens and prompt verbosity to cut cost/latency.
 */

const OPENAI_MODEL   = 'gpt-4.1-mini';
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

// ─── Sentinel error so callers can distinguish quota from other errors ─────────

class OpenAIQuotaError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'OpenAIQuotaError';
  }
}

// ─── Raw OpenAI caller ────────────────────────────────────────────────────────
// responseFormat is now overridable so we can request Structured Outputs
// (json_schema + strict) for calls that need a guaranteed shape, while
// fillMissingNutrients keeps the looser json_object mode it already relies on.

async function callOpenAI(prompt, maxOutputTokens = 2048, responseFormat = { type: 'json_object' }) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error('[OpenAI] OPENAI_API_KEY not set in env');
  }

  const body = {
    model: OPENAI_MODEL,

    messages: [
      {
        role: 'system',
        content:
          'You are a raw data API engine. Do not write markdown blocks such as triple backticks. Do not add conversational introductions or closing text. Return only valid minified JSON matching the requested schema layout.'
      },
      {
        role: 'user',
        content: prompt
      }
    ],

    temperature: 0.2,
    max_tokens: maxOutputTokens,

    response_format: responseFormat,
  };

  const res = await fetch(OPENAI_API_URL, {
    method: 'POST',

    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },

    body: JSON.stringify(body),

    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');

    const isQuota =
      res.status === 429 ||
      errText.includes('quota') ||
      errText.includes('billing') ||
      errText.includes('rate_limit') ||
      errText.includes('insufficient_quota');

    if (isQuota) {
      console.warn(
        `[OpenAI] Quota/spending limit hit (HTTP ${res.status}) — falling back to hardcoded PH data.`
      );

      throw new OpenAIQuotaError(
        `OpenAI quota exceeded (HTTP ${res.status})`
      );
    }

    throw new Error(
      `[OpenAI] API error ${res.status}: ${errText.slice(0, 200)}`
    );
  }

  const data = await res.json();

  const finishReason = data?.choices?.[0]?.finish_reason;

  if (finishReason && finishReason !== 'stop') {
    console.warn(`[OpenAI] Finish reason: ${finishReason}`);
  }

  const text = data?.choices?.[0]?.message?.content;

  if (!text) {
    console.error(
      '[OpenAI] Full response:',
      JSON.stringify(data).slice(0, 500)
    );

    throw new Error('[OpenAI] Empty response from API');
  }

  console.log('[OpenAI] Raw response snippet:', text.slice(0, 100));

  return text;
}

// ─── JSON parser — very forgiving (still used by fillMissingNutrients) ───────

function parseOpenAIJSON(text) {
  let clean = text
    .replace(/^```json\s*/im, '')
    .replace(/^```\s*/m, '')
    .replace(/```\s*$/m, '')
    .trim();

  try {
    return JSON.parse(clean);
  } catch {}

  const arrayMatch  = clean.match(/\[[\s\S]*\]/);
  const objectMatch = clean.match(/\{[\s\S]*\}/);

  if (arrayMatch) {
    try {
      return JSON.parse(arrayMatch[0]);
    } catch {}
  }

  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]);
    } catch {}
  }

  throw new Error(
    `[OpenAI] Could not parse JSON from response: ${clean.slice(0, 200)}`
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toNum(v) {
  if (v == null) return null;

  const n = parseFloat(
    String(v).replace(/[^0-9.\-]/g, '')
  );

  return isNaN(n) || n < 0 ? null : n;
}

function slugify(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30);
}

function normalizeName(str) {
  return String(str || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// ─── Nutrient keys ────────────────────────────────────────────────────────────

const NUTRIENT_KEYS = [
  'energy_kcal_100g',
  'sugars_100g',
  'saturated-fat_100g',
  'sodium_100g',
  'fiber_100g',
  'proteins_100g',
];

// ─── 1. Fill missing nutrients ────────────────────────────────────────────────

async function fillMissingNutrients(product) {
  const { name, brand, category, rawNutrients } = product;

  const missingKeys = NUTRIENT_KEYS.filter(
    k => rawNutrients[k] == null
  );

  if (missingKeys.length === 0) {
    return {
      patchedNutrients: rawNutrients,
      estimatedFields: [],
      aiEstimated: false
    };
  }

  console.log(
    `[OpenAI] Estimating missing nutrients for "${name}": ${missingKeys.join(', ')}`
  );

  const knownLines = NUTRIENT_KEYS
    .filter(k => rawNutrients[k] != null)
    .map(k => `${k}: ${rawNutrients[k]}`)
    .join(', ');

  const prompt = `Nutrition DB expert. Estimate missing per-100g values.
Product: ${name} | Brand: ${brand || 'Unknown'} | Category: ${category || 'general'}
Known: ${knownLines || 'none'}
Missing: ${missingKeys.join(', ')}
Units: energy_kcal_100g=kcal, sugars_100g=g, saturated-fat_100g=g, sodium_100g=g (not mg), fiber_100g=g, proteins_100g=g
Return ONLY a flat JSON object with the missing keys, e.g. {"sugars_100g":8.5,"fiber_100g":2.1}`;

  try {
    const text = await callOpenAI(prompt, 300);

    const parsed = parseOpenAIJSON(text);

    const patch = {};

    for (const key of missingKeys) {
      const val = toNum(
        parsed[key] ??
        parsed[key.replace('-', '_')] ??
        null
      );

      if (val !== null) {
        patch[key] = val;
      }
    }

    const estimatedFields = Object.keys(patch);

    console.log('[OpenAI] Estimated:', patch);

    return {
      patchedNutrients: {
        ...rawNutrients,
        ...patch
      },

      estimatedFields,

      aiEstimated: estimatedFields.length > 0,
    };

  } catch (err) {

    if (err instanceof OpenAIQuotaError) {
      console.warn(
        '[OpenAI] fillMissingNutrients skipped — quota exceeded.'
      );
    } else {
      console.error(
        '[OpenAI] fillMissingNutrients failed:',
        err.message
      );
    }

    return {
      patchedNutrients: rawNutrients,
      estimatedFields: [],
      aiEstimated: false
    };
  }
}

// ─── 2. Philippines-specific alternatives ────────────────────────────────────

// Guarantees the model returns exactly this shape — no partial/malformed
// JSON, no missing nutrition fields silently defaulting to null.
const ALTERNATIVES_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'ph_alternatives',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        alternatives: {
          type: 'array',
          minItems: 3,
          maxItems: 3,
          items: {
            type: 'object',
            properties: {
              name:                { type: 'string' },
              brand:               { type: 'string' },
              where_to_buy:        { type: 'string' },
              energy_kcal_100g:    { type: 'number' },
              sugars_100g:         { type: 'number' },
              saturated_fat_100g:  { type: 'number' },
              sodium_100g:         { type: 'number' },
              fiber_100g:          { type: 'number' },
              proteins_100g:       { type: 'number' },
              nova_group:          { type: 'number', description: '1-4, NOVA processing classification' },
              additives_count:     { type: 'number' },
              reason:              { type: 'string', description: 'Max 12 words.' },
              description:         { type: 'string', description: 'Max 20 words.' },
            },
            required: [
              'name', 'brand', 'where_to_buy',
              'energy_kcal_100g', 'sugars_100g', 'saturated_fat_100g',
              'sodium_100g', 'fiber_100g', 'proteins_100g',
              'nova_group', 'additives_count', 'reason', 'description',
            ],
            additionalProperties: false,
          },
        },
      },
      required: ['alternatives'],
      additionalProperties: false,
    },
  },
};

/**
 * Infers a coarse "product form" from the name when category is missing
 * or generic. This is what stops the model from drifting into unrelated
 * food categories (e.g. suggesting produce for a packaged snack) when
 * category = 'general'.
 */
function inferFormHint(name, category) {
  const lower = `${name} ${category || ''}`.toLowerCase();
  const forms = [
    { test: /chip|crisp|cracker/,           label: 'packaged salty snack' },
    { test: /soda|soft drink|juice|drink/,  label: 'beverage' },
    { test: /noodle|pancit|instant/,        label: 'instant noodle/meal' },
    { test: /candy|chocolate|gummy|sweet/,  label: 'confectionery' },
    { test: /biscuit|cookie|wafer/,         label: 'biscuit/cookie' },
    { test: /bread|pandesal|loaf/,          label: 'bread/bakery' },
    { test: /cereal|oats/,                  label: 'breakfast cereal' },
    { test: /yogurt|milk|dairy/,            label: 'dairy product' },
  ];
  const match = forms.find(f => f.test.test(lower));
  return match ? match.label : null;
}

async function getPhilippineAlternatives(
  product,
  currentScore = 0
) {

  const {
    name,
    brand,
    category,
    rawNutrients
  } = product;

  const nutrientSummary = NUTRIENT_KEYS
    .filter(k => rawNutrients[k] != null)
    .map(k => `${k}: ${rawNutrients[k]}`)
    .join(', ');

  const categoryLabel = (category || 'general')
    .replace(/-/g, ' ')
    .toLowerCase();

  const formHint = inferFormHint(name, category);

  const prompt = `Philippine grocery nutrition expert task.

SCANNED ITEM: "${name}" by ${brand || 'unknown brand'}
CATEGORY: ${categoryLabel}${formHint ? ` (product form: ${formHint})` : ''}
NUTRIENTS/100g: ${nutrientSummary || 'unknown — infer typical values for this exact product type'}

Suggest EXACTLY 3 healthier alternatives sold in PH stores.

STRICT RULES:
- Alternatives MUST be the same product FORM as the scanned item${formHint ? ` (${formHint})` : ''}. A packaged/processed item must be replaced by another packaged/processed item of the same kind — NEVER substitute raw fruit, vegetables, or an unrelated food category.
- All 3 alternatives must be different from each other and from "${name}".
- Each must be genuinely healthier: lower sugar/sodium/saturated fat, higher fiber/protein, or a lower NOVA processing group.
- sodium_100g in grams, not mg.
- reason ≤12 words, description ≤20 words.

JSON only, matching the schema exactly.`;

  try {

    const text = await callOpenAI(prompt, 700, ALTERNATIVES_SCHEMA);

    const parsed = JSON.parse(text); // Structured Outputs guarantees valid, schema-conformant JSON

    const rawAlternatives = parsed.alternatives || [];

    // Dedupe: against the scanned product and against each other.
    const seen = new Set([normalizeName(name)]);
    const deduped = [];

    for (const item of rawAlternatives) {
      const key = normalizeName(item.name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      deduped.push(item);
    }

    if (deduped.length === 0) {
      console.warn('[OpenAI] All alternatives were duplicates/invalid — returning none.');
      return [];
    }

    return deduped.map(item => ({

      barcode: `ph-alternative-${slugify(item.name)}`,

      name: item.name || 'Unknown Alternative',

      brand: item.brand || 'Unknown Brand',

      image_url: null,

      score: null,

      grade: null,

      where_to_buy: item.where_to_buy || 'PH Supermarkets',

      reason: item.reason || 'Healthier choice in this category.',

      description: item.description || '',

      source: 'openai_ph_alternative',

      nova_group: toNum(item.nova_group),

      _nutrients: {

        energy_kcal_100g: toNum(item.energy_kcal_100g),

        sugars_100g: toNum(item.sugars_100g),

        'saturated-fat_100g': toNum(item.saturated_fat_100g),

        sodium_100g: toNum(item.sodium_100g),

        fiber_100g: toNum(item.fiber_100g),

        proteins_100g: toNum(item.proteins_100g),

        nova_group: toNum(item.nova_group),

        additives_tags: Array(Math.max(0, Math.round(toNum(item.additives_count) ?? 0))).fill('unspecified'),
      },
    }));

  } catch (err) {

    if (err instanceof OpenAIQuotaError) {
      console.warn(
        '[OpenAI] getPhilippineAlternatives skipped — quota exceeded.'
      );
    } else {
      console.error(
        '[OpenAI] getPhilippineAlternatives failed:',
        err.message
      );
    }

    return [];
  }
}

module.exports = {
  fillMissingNutrients,
  getPhilippineAlternatives,
};