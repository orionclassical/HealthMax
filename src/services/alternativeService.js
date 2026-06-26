/**
 * alternativeService.js
 *
 * Finds healthier alternatives using a PRIORITY cascade:
 *
 *   TIER 1 — Gemini PH Alternatives (runs FIRST, independently)
 *     → If Gemini returns 3 results, global sources are skipped entirely.
 *     → If Gemini returns < 3 results, global sources fire to supplement.
 *
 *   TIER 2 — Global sources (only when Gemini PH comes up short):
 *     - Open Food Facts v1/v2
 *     - USDA FoodData Central
 *     - FatSecret Platform API
 *
 * Return order (frontend receives this order):
 *   [ph_alt_1, ph_alt_2, ph_alt_3, global_alt_1, global_alt_2, ...]
 *
 * Gemini PH alternatives are ALWAYS first so the frontend can render them
 * prominently in the "Available in the Philippines" section without needing
 * to re-sort.
 */

const supabase = require('../config/supabase');
const { calculateScore, normalizeNutrients } = require('./scoringService');
const { searchFatSecretByCategory }          = require('./fatSecretService');
const { getPhilippineAlternatives }          = require('./geminiService');

const OFF_BASE      = 'https://world.openfoodfacts.org';
const OFF_SEARCH    = `${OFF_BASE}/cgi/search.pl`;
const OFF_SEARCH_V2 = `${OFF_BASE}/api/v2/search`;

const USDA_BASE    = 'https://api.nal.usda.gov/fdc/v1';
const USDA_API_KEY = process.env.USDA_API_KEY;

// ─── Category helpers ─────────────────────────────────────────────────────────

function normalizeCategory(category) {
  if (!category) return 'general';
  return category.startsWith('en:') ? category.slice(3) : category;
}

function buildSearchTags(category) {
  const stripped = normalizeCategory(category);
  const parts    = stripped.split('-');
  const tags     = [stripped];

  for (let i = parts.length - 1; i >= 1; i--) {
    const tag = parts.slice(i).join('-');
    if (!tags.includes(tag)) tags.push(tag);
  }

  if (!tags.includes('snacks')) tags.push('snacks');
  tags.push('food');

  return tags;
}

// ─── Open Food Facts ──────────────────────────────────────────────────────────

async function searchOFFByCategory(category, pageSize = 30) {
  const tags = buildSearchTags(category);
  console.log(`[alternativeService] OFF search tags:`, tags);

  for (const tag of tags) {
    // Try v1
    try {
      const params = new URLSearchParams({
        action: 'process', tagtype_0: 'categories',
        tag_contains_0: 'contains', tag_0: tag,
        fields: [
          'code', 'product_name', 'brands', 'image_front_url',
          'nutriments', 'nova_group', 'additives_tags',
          'categories_tags', 'nutriscore_grade',
        ].join(','),
        json: '1', page_size: String(pageSize), page: '1',
        sort_by: 'unique_scans_n',
      });

      const res = await fetch(`${OFF_SEARCH}?${params}`, {
        headers: { 'User-Agent': 'HealthMax App - healthmax@example.com' },
        signal: AbortSignal.timeout(8000),
      });

      if (res.ok) {
        const data     = await res.json();
        const products = data.products || [];
        console.log(`[alternativeService] OFF v1 "${tag}": ${products.length} results`);
        if (products.length >= 5) return products;
      }
    } catch (err) {
      console.warn(`[alternativeService] OFF v1 "${tag}" failed:`, err.message);
    }

    // Try v2
    try {
      const params = new URLSearchParams({
        categories_tags: tag,
        fields: [
          'code', 'product_name', 'brands', 'image_front_url',
          'nutriments', 'nova_group', 'additives_tags',
          'categories_tags', 'nutriscore_grade',
        ].join(','),
        page_size: String(pageSize), page: '1', sort_by: 'unique_scans_n',
      });

      const res = await fetch(`${OFF_SEARCH_V2}?${params}`, {
        headers: { 'User-Agent': 'HealthMax App - healthmax@example.com' },
        signal: AbortSignal.timeout(8000),
      });

      if (res.ok) {
        const data     = await res.json();
        const products = data.products || [];
        console.log(`[alternativeService] OFF v2 "${tag}": ${products.length} results`);
        if (products.length >= 5) return products;
      }
    } catch (err) {
      console.warn(`[alternativeService] OFF v2 "${tag}" failed:`, err.message);
    }
  }

  return [];
}

async function fetchOFFProduct(barcode) {
  try {
    const res = await fetch(`${OFF_BASE}/api/v2/product/${barcode}.json`, {
      headers: { 'User-Agent': 'HealthMax App - healthmax@example.com' },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.status === 1 ? data.product : null;
  } catch (err) {
    console.error('[alternativeService] OFF fetch failed:', err.message);
    return null;
  }
}

function extractOFFNutriments(product) {
  const n = product.nutriments || {};
  return {
    energy_kcal_100g:     n['energy-kcal_100g'] ?? n.energy_kcal ?? null,
    energy_100g:          n.energy_100g          ?? null,
    sugars_100g:          n.sugars_100g           ?? null,
    'saturated-fat_100g': n['saturated-fat_100g'] ?? null,
    sodium_100g:          n.sodium_100g            ?? null,
    salt_100g:            n.salt_100g              ?? null,
    fiber_100g:           n.fiber_100g             ?? null,
    proteins_100g:        n.proteins_100g          ?? null,
    nova_group:           product.nova_group        ?? null,
    additives_tags:       product.additives_tags     ?? [],
  };
}

function hasSufficientOFFData(product) {
  const n = product.nutriments || {};
  return (
    (n['energy-kcal_100g'] != null || n.energy_100g != null) &&
    n.sugars_100g != null &&
    (n.salt_100g  != null || n.sodium_100g != null)
  );
}

// ─── OFF image lookup (enriches USDA / FatSecret results) ────────────────────

async function fetchOFFImageForProduct(name, brand) {
  try {
    const namePart = name.split(' ').slice(0, 3).join(' ');
    const query    = brand ? `${brand} ${namePart}` : namePart;

    const params = new URLSearchParams({
      action: 'process', search_terms: query,
      fields: 'code,product_name,brands,image_front_url',
      json: '1', page_size: '5', page: '1',
    });

    const res = await fetch(`${OFF_SEARCH}?${params}`, {
      headers: { 'User-Agent': 'HealthMax App - healthmax@example.com' },
      signal:  AbortSignal.timeout(4000),
    });

    if (!res.ok) return null;
    const data     = await res.json();
    const products = data.products || [];
    const match    = products.find(p => p.image_front_url);
    return match?.image_front_url ?? null;
  } catch {
    return null;
  }
}

// ─── USDA FoodData Central ────────────────────────────────────────────────────

async function searchUSDA(category, pageSize = 20) {
  if (!USDA_API_KEY) {
    console.warn('[alternativeService] USDA_API_KEY not set — skipping USDA search');
    return [];
  }

  const keyword = normalizeCategory(category)
    .split('-').slice(0, 2).join(' ');

  console.log(`[alternativeService] USDA search keyword: "${keyword}"`);

  try {
    const url = `${USDA_BASE}/foods/search?api_key=${encodeURIComponent(USDA_API_KEY)}`;

    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: keyword, dataType: ['Branded'],
        pageSize, sortBy: 'dataType.keyword', sortOrder: 'asc',
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      console.warn(`[alternativeService] USDA returned ${res.status}: ${res.statusText}`);
      return [];
    }

    const data  = await res.json();
    const foods = data.foods || [];
    console.log(`[alternativeService] USDA returned ${foods.length} foods`);

    return foods.map(food => {
      const getNutrient = id =>
        food.foodNutrients?.find(fn => fn.nutrientId === id)?.value ?? null;

      const energy_kcal = getNutrient(1008);
      const sugar       = getNutrient(2000);
      const sat_fat     = getNutrient(1258);
      const sodium_mg   = getNutrient(1093);
      const fiber       = getNutrient(1079);
      const protein     = getNutrient(1003);

      if (energy_kcal == null && sugar == null) return null;

      return {
        _usda:          true,
        code:           String(food.fdcId),
        product_name:   food.description || 'Unknown',
        brands:         food.brandOwner  || '',
        image_url:      null,
        nova_group:     null,
        additives_tags: [],
        _nutrients: {
          energy_kcal_100g:     energy_kcal,
          sugars_100g:          sugar,
          'saturated-fat_100g': sat_fat,
          sodium_100g:          sodium_mg != null ? sodium_mg / 1000 : null,
          fiber_100g:           fiber,
          proteins_100g:        protein,
          nova_group:           null,
          additives_tags:       [],
        },
      };
    }).filter(Boolean);
  } catch (err) {
    console.error('[alternativeService] USDA search failed:', err.message);
    return [];
  }
}

// ─── Comparison explanation ───────────────────────────────────────────────────

function buildComparisonReason(currentNorm, altNorm, currentScore, altScore) {
  const reasons = [];

  if (currentNorm.sugar != null && altNorm.sugar != null) {
    const diff = currentNorm.sugar - altNorm.sugar;
    if (diff > 2) reasons.push(`${diff.toFixed(1)}g less sugar`);
  }
  if (currentNorm.sodium != null && altNorm.sodium != null) {
    const diff = currentNorm.sodium - altNorm.sodium;
    if (diff > 50) reasons.push(`${Math.round(diff)}mg less sodium`);
  }
  if (currentNorm.saturated_fat != null && altNorm.saturated_fat != null) {
    const diff = currentNorm.saturated_fat - altNorm.saturated_fat;
    if (diff > 0.5) reasons.push(`${diff.toFixed(1)}g less saturated fat`);
  }
  if (altNorm.fiber != null && currentNorm.fiber != null) {
    const diff = altNorm.fiber - currentNorm.fiber;
    if (diff > 0.5) reasons.push(`${diff.toFixed(1)}g more fiber`);
  }
  if (altNorm.protein != null && currentNorm.protein != null) {
    const diff = altNorm.protein - currentNorm.protein;
    if (diff > 1) reasons.push(`${diff.toFixed(1)}g more protein`);
  }
  if (
    altNorm.nova_group != null && currentNorm.nova_group != null &&
    altNorm.nova_group < currentNorm.nova_group
  ) {
    reasons.push(`less processed (NOVA ${altNorm.nova_group} vs ${currentNorm.nova_group})`);
  } else if (currentNorm.nova_group === 4 && altNorm.nova_group == null) {
    reasons.push('potentially less processed');
  }

  if (reasons.length === 0)
    reasons.push(`overall healthier profile (+${altScore - currentScore} pts)`);

  return `Better because: ${reasons.join(', ')}.`;
}

// ─── Score + shape a raw nutrients object into an alternative entry ───────────

function scoreAndShape({
  raw, code, name, brand, imageUrl, source,
  currentNorm, currentScore, modifiers, userContext,
  whereToBuy    = null,
  description   = null,
  geminiReason  = null,
}) {
  const { score, grade } = calculateScore(raw, modifiers, userContext);
  const norm             = normalizeNutrients(raw);
  const autoReason       = buildComparisonReason(currentNorm, norm, currentScore, score);

  return {
    barcode:      code,
    name:         name  || 'Unknown product',
    brand:        brand || '',
    score,
    grade,
    image_url:    imageUrl || null,
    reason:       geminiReason ?? autoReason,
    description:  description ?? null,
    source,
    nova_group:   norm.nova_group ?? null,
    where_to_buy: whereToBuy,
    _nutrients: {
      energy_kcal_100g:     raw.energy_kcal_100g     ?? null,
      sugars_100g:          raw.sugars_100g           ?? null,
      'saturated-fat_100g': raw['saturated-fat_100g'] ?? null,
      sodium_100g:          raw.sodium_100g           ?? null,
      fiber_100g:           raw.fiber_100g            ?? null,
      proteins_100g:        raw.proteins_100g         ?? null,
      nova_group:           raw.nova_group            ?? null,
      additives_tags:       raw.additives_tags        ?? [],
    },
  };
}

// ─── Shape Gemini PH results into standard alternative objects ────────────────

function shapeGeminiResults({ geminiResults, currentNorm, currentScore, modifiers, userContext }) {
  return geminiResults
    .slice(0, 3)
    .map(p => scoreAndShape({
      raw:          p._nutrients,
      code:         p.barcode,
      name:         p.name,
      brand:        p.brand,
      imageUrl:     p.image_url,
      source:       p.source,           // 'gemini_ph' or 'ph_fallback'
      whereToBuy:   p.where_to_buy ?? null,
      description:  p.description ?? null,
      geminiReason: p.reason ?? null,
      currentNorm,
      currentScore,
      modifiers,
      userContext,
    }));
}

// ─── Global sources (OFF + USDA + FatSecret + local DB) ──────────────────────
// Only called when Gemini PH returns fewer than 3 results.

async function fetchGlobalAlternatives({
  category, currentBarcode, currentScore,
  currentNorm, modifiers, userContext,
  needed = 3,
}) {
  console.log(`[alternativeService] Gemini PH came up short — fetching ${needed} global alt(s)...`);

  const [offProducts, usdaProducts, fsProducts] = await Promise.all([
    searchOFFByCategory(category).catch(err => {
      console.warn('[alternativeService] OFF failed:', err.message);
      return [];
    }),
    searchUSDA(category).catch(err => {
      console.warn('[alternativeService] USDA failed:', err.message);
      return [];
    }),
    searchFatSecretByCategory(category, 20).catch(err => {
      console.warn('[alternativeService] FatSecret failed:', err.message);
      return [];
    }),
  ]);

  // Score OFF
  const offScored = offProducts
    .filter(p => p.code && p.code !== currentBarcode && hasSufficientOFFData(p))
    .map(p => scoreAndShape({
      raw:          extractOFFNutriments(p),
      code:         p.code,
      name:         p.product_name,
      brand:        p.brands,
      imageUrl:     p.image_front_url,
      source:       'open_food_facts',
      currentNorm,
      currentScore,
      modifiers,
      userContext,
    }))
    .filter(p => p.score > currentScore)
    .sort((a, b) => b.score - a.score);

  console.log(`[alternativeService] OFF scored ${offScored.length} better alternatives`);

  // Score USDA
  const usdaScored = usdaProducts
    .filter(p => p.code !== currentBarcode)
    .map(p => scoreAndShape({
      raw:          p._nutrients,
      code:         p.code,
      name:         p.product_name,
      brand:        p.brands,
      imageUrl:     null,
      source:       'usda',
      currentNorm,
      currentScore,
      modifiers,
      userContext,
    }))
    .filter(p => p.score > currentScore)
    .sort((a, b) => b.score - a.score);

  usdaScored.forEach(p => {
    fetchOFFImageForProduct(p.name, p.brand)
      .then(image_url => { if (image_url) p.image_url = image_url; })
      .catch(() => {});
  });

  console.log(`[alternativeService] USDA scored ${usdaScored.length} better alternatives`);

  // Score FatSecret
  const fsScored = fsProducts
    .filter(p => p.code !== currentBarcode)
    .map(p => scoreAndShape({
      raw:          p._nutrients,
      code:         p.code,
      name:         p.product_name,
      brand:        p.brands,
      imageUrl:     null,
      source:       'fatsecret',
      currentNorm,
      currentScore,
      modifiers,
      userContext,
    }))
    .filter(p => p.score > currentScore)
    .sort((a, b) => b.score - a.score);

  fsScored.forEach(p => {
    fetchOFFImageForProduct(p.name, p.brand)
      .then(image_url => { if (image_url) p.image_url = image_url; })
      .catch(() => {});
  });

  console.log(`[alternativeService] FatSecret scored ${fsScored.length} better alternatives`);

  // Merge + top N
  let globalAlts = [...offScored, ...usdaScored, ...fsScored]
    .sort((a, b) => b.score - a.score)
    .slice(0, needed);

  // Supplement from local DB if still short
  if (globalAlts.length < needed) {
    console.log('[alternativeService] Supplementing global alts from local DB...');
    const categoryStripped = normalizeCategory(category);
    const { data: dbResults } = await supabase
      .from('products')
      .select('barcode, name, brand, base_score, image_url, nutrients, category')
      .or(`category.eq.${category},category.ilike.%${categoryStripped}%`)
      .neq('barcode', currentBarcode)
      .not('nutrients', 'is', null)
      .order('base_score', { ascending: false })
      .limit(10);

    const dbScored = (dbResults ?? [])
      .map(p => {
        if (!p.nutrients) return null;
        return scoreAndShape({
          raw:          p.nutrients,
          code:         p.barcode,
          name:         p.name,
          brand:        p.brand,
          imageUrl:     p.image_url,
          source:       'local_cache',
          currentNorm,
          currentScore,
          modifiers,
          userContext,
        });
      })
      .filter(p => p !== null && p.score > currentScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, needed - globalAlts.length);

    console.log(`[alternativeService] DB scored ${dbScored.length} better alternatives`);
    globalAlts = [...globalAlts, ...dbScored];
  }

  upsertToLocalCache(offScored).catch(err =>
    console.warn('[alternativeService] Cache upsert failed:', err.message)
  );

  return globalAlts;
}

// ─── Main: getAlternatives ────────────────────────────────────────────────────

async function getAlternatives({
  category,
  currentScore,
  currentBarcode,
  currentNutrients = {},
  modifiers        = {},
  userContext      = {},
}) {
  const currentNorm = normalizeNutrients(currentNutrients);

  // ── TIER 1: Gemini PH — runs independently and first ─────────────────────
  console.log('[alternativeService] Fetching Gemini PH alternatives first...');

  const geminiResults = await getPhilippineAlternatives(
    {
      name:         userContext.productName  ?? 'Unknown',
      brand:        userContext.productBrand ?? '',
      category,
      rawNutrients: currentNutrients,
    },
    currentScore
  ).catch(err => {
    console.warn('[alternativeService] Gemini PH failed:', err.message);
    return [];
  });

  const phAlts = shapeGeminiResults({
    geminiResults,
    currentNorm,
    currentScore,
    modifiers,
    userContext,
  });

  console.log(`[alternativeService] Gemini PH returned ${phAlts.length} alternatives`);

  // ── TIER 2: Global sources — only if Gemini returned fewer than 3 ─────────
  // This keeps Gemini as the sole source for PH alternatives when it's working.
  // When Gemini quota is exhausted, ph_fallback hardcoded data fills the gap
  // (handled inside geminiService.js), so global APIs are rarely needed.
  let globalAlts = [];

  if (phAlts.length < 3) {
    const needed = 3 - phAlts.length;
    globalAlts = await fetchGlobalAlternatives({
      category,
      currentBarcode,
      currentScore,
      currentNorm,
      modifiers,
      userContext,
      needed,
    });
  } else {
    console.log('[alternativeService] Gemini PH returned 3 results — skipping global API calls.');
  }

  // ── Return PH alternatives FIRST, then any global supplements ────────────
  const combined = [...phAlts, ...globalAlts];
  console.log(
    `[alternativeService] Total alternatives: ${combined.length}` +
    ` (${phAlts.length} PH, ${globalAlts.length} global supplement)`
  );
  return combined;
}

// ─── Cache upsert ─────────────────────────────────────────────────────────────

async function upsertToLocalCache(products) {
  const rows = products
    .filter(p => p.source === 'open_food_facts')
    .map(p => ({
      barcode:    p.barcode,
      name:       p.name,
      brand:      p.brand,
      base_score: p.score,
      image_url:  p.image_url,
      updated_at: new Date().toISOString(),
    }));

  if (rows.length === 0) return;

  await supabase
    .from('products')
    .upsert(rows, { onConflict: 'barcode', ignoreDuplicates: false });
}

// ─── Score a barcode on-demand ────────────────────────────────────────────────

async function scoreProductByBarcode(barcode, modifiers = {}, userContext = {}) {
  const product = await fetchOFFProduct(barcode);
  if (!product) return null;

  const raw                         = extractOFFNutriments(product);
  const { score, grade, breakdown } = calculateScore(raw, modifiers, userContext);

  return {
    barcode,
    name:      product.product_name,
    brand:     product.brands,
    score,
    grade,
    breakdown,
    image_url: product.image_front_url,
  };
}

module.exports = { getAlternatives, scoreProductByBarcode, fetchOFFProduct };