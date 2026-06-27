/**
 * fatSecretService.js
 *
 * FatSecret Platform REST API integration using OAuth 2.0 (Client Credentials flow).
 * Used as a fallback when Open Food Facts returns no usable data.
 *
 * Env vars required:
 *   FATSECRET_CLIENT_ID     – your OAuth 2.0 Client ID
 *   FATSECRET_CLIENT_SECRET – your OAuth 2.0 Client Secret
 *
 * FatSecret docs: https://platform.fatsecret.com/api/Default.aspx?screen=rapiref2
 */

const FATSECRET_TOKEN_URL = 'https://oauth.fatsecret.com/connect/token';
const FATSECRET_API_URL   = 'https://platform.fatsecret.com/rest/server.api';

// ─── Token cache (in-process; reuse until 60 s before expiry) ─────────────────
let _tokenCache = null; // { access_token, expires_at }

/**
 * Fetch (or reuse) an OAuth 2.0 bearer token.
 * @returns {Promise<string>} access_token
 */
async function getAccessToken() {
  const now = Date.now();

  if (_tokenCache && _tokenCache.expires_at > now + 60_000) {
    return _tokenCache.access_token;
  }

  const clientId     = process.env.FATSECRET_CLIENT_ID;
  const clientSecret = process.env.FATSECRET_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('[FatSecret] FATSECRET_CLIENT_ID / FATSECRET_CLIENT_SECRET not set in env');
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    scope:      'basic',
  });

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const res = await fetch(FATSECRET_TOKEN_URL, {
    method:  'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`[FatSecret] Token request failed ${res.status}: ${text}`);
  }

  const data = await res.json();
  _tokenCache = {
    access_token: data.access_token,
    expires_at:   now + (data.expires_in ?? 86400) * 1000,
  };

  console.log('[FatSecret] New access token obtained');
  return _tokenCache.access_token;
}

// ─── Raw API caller ───────────────────────────────────────────────────────────

/**
 * Call any FatSecret REST method.
 * @param {string} method  – FatSecret method name e.g. 'foods.search'
 * @param {Object} params  – additional query params
 * @returns {Promise<Object>} parsed JSON response body
 */
async function fatSecretCall(method, params = {}) {
  const token = await getAccessToken();

  const url = new URL(FATSECRET_API_URL);
  url.searchParams.set('method', method);
  url.searchParams.set('format', 'json');
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
    signal:  AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    throw new Error(`[FatSecret] API call ${method} failed: ${res.status}`);
  }

  return res.json();
}

// ─── Barcode lookup ───────────────────────────────────────────────────────────

/**
 * Look up a product by barcode (EAN/UPC) via FatSecret.
 * Returns our internal product shape, or null if not found.
 *
 * @param {string} barcode
 * @returns {Promise<Object|null>}
 */
async function fetchFromFatSecret(barcode) {
  try {
    console.log(`[FatSecret] Barcode lookup: ${barcode}`);

    // food.find_id_for_barcode → gives us the food_id
    const idData = await fatSecretCall('food.find_id_for_barcode', { barcode });

    const foodId = idData?.food_id?.value;
    if (!foodId) {
      console.log(`[FatSecret] Barcode ${barcode} not found`);
      return null;
    }

    // food.get.v4 → full nutrient details
    const foodData = await fatSecretCall('food.get.v4', { food_id: foodId });
    const food     = foodData?.food;
    if (!food) return null;

    // FatSecret returns multiple servings; prefer "100g" or first entry
    const servings = Array.isArray(food.servings?.serving)
      ? food.servings.serving
      : food.servings?.serving
        ? [food.servings.serving]
        : [];

    const serving100 =
      servings.find(s => s.serving_description?.toLowerCase().includes('100g')) ||
      servings.find(s => Number(s.metric_serving_amount) === 100) ||
      servings[0] ||
      null;

    if (!serving100) {
      console.log(`[FatSecret] No usable serving for food_id=${foodId}`);
      return null;
    }

    // Scale all values to per-100g if needed
    const amount = Number(serving100.metric_serving_amount) || 100;
    const scale  = 100 / amount;

    function scaleVal(v) {
      const n = parseFloat(v);
      return isNaN(n) ? null : +(n * scale).toFixed(4);
    }

    const rawNutrients = {
      energy_kcal_100g:     scaleVal(serving100.calories),
      energy_100g:          null,  // FatSecret gives kcal directly
      sugars_100g:          scaleVal(serving100.sugar),
      'saturated-fat_100g': scaleVal(serving100.saturated_fat),
      salt_100g:            null,  // FatSecret gives sodium, not salt
      // FatSecret sodium is in mg; convert to g for our normalizer
      sodium_100g:          serving100.sodium != null
                              ? scaleVal(serving100.sodium) / 1000
                              : null,
      fiber_100g:           scaleVal(serving100.fiber),
      proteins_100g:        scaleVal(serving100.protein),
      nova_group:           null,  // FatSecret doesn't classify NOVA
      additives_tags:       [],
    };

    console.log(`[FatSecret] Resolved nutrients for ${barcode}:`, JSON.stringify(rawNutrients));

    return {
      barcode,
      name:        food.food_name   || 'Unknown Product',
      brand:       food.brand_name  || 'Unknown Brand',
      category:    normalizeFatSecretCategory(food.food_type, food.food_sub_categories),
      image_url:   null,  // FatSecret REST API does not return product images
      nutriscore:  null,
      rawNutrients,
      source:      'fatsecret',
    };
  } catch (err) {
    console.error('[FatSecret] fetchFromFatSecret error:', err.message);
    return null;
  }
}

// ─── Category normaliser ──────────────────────────────────────────────────────

/**
 * Map FatSecret food_type / sub-categories to our internal en: tag format.
 */
function normalizeFatSecretCategory(foodType, subCategories) {
  if (Array.isArray(subCategories) && subCategories.length) {
    // Use the most specific sub-category, slugified
    const slug = subCategories[subCategories.length - 1]
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    return `en:${slug}`;
  }
  if (foodType) {
    return `en:${foodType.toLowerCase().replace(/\s+/g, '-')}`;
  }
  return 'general';
}

// ─── Category search (for alternatives) ──────────────────────────────────────

/**
 * Search FatSecret for foods matching a keyword derived from category.
 * Returns an array of products in our internal rawNutrients format, ready
 * to be scored by alternativeService.
 *
 * @param {string} category – our internal category string (e.g. 'en:biscuits')
 * @param {number} maxResults
 * @returns {Promise<Array>}
 */
async function searchFatSecretByCategory(category, maxResults = 20) {
  try {
    const keyword = category
      .replace(/^en:/, '')
      .split('-')
      .slice(0, 2)
      .join(' ');

    console.log(`[FatSecret] Category search: "${keyword}"`);

    const data = await fatSecretCall('foods.search', {
      search_expression: keyword,
      max_results:       maxResults,
      page_number:       0,
    });

    const foods = Array.isArray(data?.foods?.food)
      ? data.foods.food
      : data?.foods?.food
        ? [data.foods.food]
        : [];

    console.log(`[FatSecret] Category search returned ${foods.length} results`);

    // foods.search returns lightweight entries; we need to fetch details per food
    // to get per-100g nutrients. Limit to 8 detail fetches to stay within rate limits.
    const detailPromises = foods.slice(0, 8).map(f =>
      fatSecretCall('food.get.v4', { food_id: f.food_id })
        .then(d => d?.food ?? null)
        .catch(() => null)
    );

    const details = await Promise.all(detailPromises);

    return details
      .filter(Boolean)
      .map(food => {
        const servings = Array.isArray(food.servings?.serving)
          ? food.servings.serving
          : food.servings?.serving ? [food.servings.serving] : [];

        const serving100 =
          servings.find(s => s.serving_description?.toLowerCase().includes('100g')) ||
          servings.find(s => Number(s.metric_serving_amount) === 100) ||
          servings[0] || null;

        if (!serving100) return null;

        const amount = Number(serving100.metric_serving_amount) || 100;
        const scale  = 100 / amount;
        function sv(v) { const n = parseFloat(v); return isNaN(n) ? null : +(n * scale).toFixed(4); }

        const rawNutrients = {
          energy_kcal_100g:     sv(serving100.calories),
          energy_100g:          null,
          sugars_100g:          sv(serving100.sugar),
          'saturated-fat_100g': sv(serving100.saturated_fat),
          salt_100g:            null,
          sodium_100g:          serving100.sodium != null ? sv(serving100.sodium) / 1000 : null,
          fiber_100g:           sv(serving100.fiber),
          proteins_100g:        sv(serving100.protein),
          nova_group:           null,
          additives_tags:       [],
        };

        // Require at minimum calories + one other nutrient
        if (rawNutrients.energy_kcal_100g == null) return null;
        if (rawNutrients.sugars_100g == null && rawNutrients.proteins_100g == null) return null;

        return {
          _fatsecret:   true,
          code:         `fs-${food.food_id}`,  // prefix avoids collision with barcodes
          product_name: food.food_name  || 'Unknown',
          brands:       food.brand_name || '',
          image_url:    null,
          nova_group:   null,
          additives_tags: [],
          _nutrients:   rawNutrients,
        };
      })
      .filter(Boolean);
  } catch (err) {
    console.error('[FatSecret] searchFatSecretByCategory error:', err.message);
    return [];
  }
}

module.exports = {
  fetchFromFatSecret,
  searchFatSecretByCategory,
};