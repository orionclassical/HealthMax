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

async function callOpenAI(prompt, maxOutputTokens = 2048) {
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

    response_format: {
      type: 'json_object'
    }
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

// ─── JSON parser — very forgiving ────────────────────────────────────────────

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

  const prompt = `
You are a nutrition database expert.

Estimate missing nutrient values per 100g for this food product.

Product: ${name}
Brand: ${brand || 'Unknown'}
Category: ${category || 'general'}

Known nutrients per 100g:
${knownLines || 'none'}

Missing fields to estimate per 100g:
${missingKeys.join(', ')}

Units:
- energy_kcal_100g = kcal
- sugars_100g = g
- saturated-fat_100g = g
- sodium_100g = g (NOT mg)
- fiber_100g = g
- proteins_100g = g

Return ONLY a flat JSON object containing the missing keys.

Example:
{
  "sugars_100g": 8.5,
  "fiber_100g": 2.1
}
`;

  try {
    const text = await callOpenAI(prompt, 512);

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

  const prompt = `
Act as a Philippine grocery and nutrition expert.

List EXACTLY 3 healthier alternatives available in the Philippines.

Product Context:
- Name: ${name}
- Brand: ${brand || 'Unknown'}
- Category: ${categoryLabel}
- Current Nutrients/100g: ${nutrientSummary || 'unknown'}

RULES:
1. Alternatives MUST stay within the same category.
2. Alternatives MUST exist in Philippine stores.
3. Alternatives MUST be nutritionally healthier.
4. sodium_100g MUST be in grams.
5. Return ONLY valid JSON.

Return this exact schema:

{
  "alternatives": [
    {
      "name": "Alternative Product Name",
      "brand": "Brand Name",
      "where_to_buy": "SM, Puregold",
      "energy_kcal_100g": 0,
      "sugars_100g": 0,
      "saturated_fat_100g": 0,
      "sodium_100g": 0,
      "fiber_100g": 0,
      "proteins_100g": 0,
      "reason": "One short sentence.",
      "description": "2-3 sentence nutrition explanation."
    }
  ]
}
`;

  try {

    const text = await callOpenAI(prompt, 2048);

    const parsed = parseOpenAIJSON(text);

    const alternatives = Array.isArray(parsed)
      ? parsed
      : parsed.alternatives;

    if (!Array.isArray(alternatives)) {
      throw new Error(
        '[OpenAI] Response did not evaluate to a JSON array.'
      );
    }

    return alternatives.slice(0, 3).map(item => ({

      barcode: `ph-alternative-${slugify(item.name)}`,

      name:
        item.name || 'Unknown Alternative',

      brand:
        item.brand || 'Unknown Brand',

      image_url: null,

      score: null,

      grade: null,

      where_to_buy:
        item.where_to_buy || 'PH Supermarkets',

      reason:
        item.reason ||
        'Healthier choice in this category.',

      description:
        item.description || '',

      source: 'openai_ph_alternative',

      nova_group: null,

      _nutrients: {

        energy_kcal_100g:
          toNum(item.energy_kcal_100g),

        sugars_100g:
          toNum(item.sugars_100g),

        'saturated-fat_100g':
          toNum(item.saturated_fat_100g),

        sodium_100g:
          toNum(item.sodium_100g),

        fiber_100g:
          toNum(item.fiber_100g),

        proteins_100g:
          toNum(item.proteins_100g),

        nova_group: null,

        additives_tags: [],
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