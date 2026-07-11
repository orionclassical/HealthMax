/**
 * productController.js
 *
 * Data source lookup order:
 *   1. Supabase local cache          (fastest)
 *   2. Open Food Facts API           (primary)
 *   3. FatSecret REST API            (fallback)
 *   4. Gemini AI — nutrient fill     (fills null fields, even on cached products)
 *
 * Alternatives cascade (inside alternativeService):
 *   1. Open Food Facts
 *   2. USDA FoodData Central
 *   3. FatSecret
 *   4. Gemini PH (always returns something — real PH brands or hardcoded fallback)
 *   5. Local Supabase cache
 */

const axios    = require('axios');
const supabase = require('../config/supabase');
const {
  calculateScore, generateWarnings, generateDescription,
  getScoreColor, normalizeNutrients,
} = require('../services/scoringService');
const { getAlternatives }    = require('../services/alternativeService');
const { buildModifiers }     = require('../services/personalizationService');
const { fetchFromFatSecret } = require('../services/fatSecretService');
const { fillMissingNutrients } = require('../services/geminiService');

const OFF_BASE_URL = 'https://world.openfoodfacts.org/api/v0/product';

// ─── Open Food Facts ──────────────────────────────────────────────────────────

async function fetchFromOFF(barcode) {
  try {
    const url = `${OFF_BASE_URL}/${barcode}.json`;
    console.log(`[OFF] Fetching: ${url}`);

    const response = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'FitMax/1.0 (fitmax@gmail.com)' },
    });

    const data = response.data;
    if (!data || data.status === 0 || !data.product) {
      console.log(`[OFF] Product not found: ${barcode}`);
      return null;
    }

    const p = data.product;
    const n = p.nutriments || {};

    const rawNutrients = {
      energy_kcal_100g:
        n['energy-kcal_100g'] ?? n['energy-kcal'] ?? null,
      energy_100g:
        n['energy_100g'] ?? n['energy'] ?? null,
      sugars_100g:
        n['sugars_100g'] ?? n['sugars'] ?? null,
      'saturated-fat_100g':
        n['saturated-fat_100g'] ?? n['saturated-fat'] ?? null,
      salt_100g:
        n['salt_100g'] ?? n['salt'] ?? null,
      sodium_100g:
        n['sodium_100g'] ?? n['sodium'] ?? null,
      fiber_100g:
        n['fiber_100g'] ?? n['fiber'] ?? n['fibers_100g'] ?? n['fibers'] ?? null,
      proteins_100g:
        n['proteins_100g'] ?? n['proteins'] ?? n['protein_100g'] ?? n['protein'] ?? null,
      nova_group:     p.nova_group     ?? null,
      additives_tags: p.additives_tags ?? [],
    };

    console.log(`[OFF] Raw nutriments for ${barcode}:`, JSON.stringify(rawNutrients));

    let category = 'general';
    if (p.categories_tags?.length) {
      const enTags = p.categories_tags.filter(c => c.startsWith('en:'));
      if (enTags.length) category = enTags[enTags.length - 1];
    }

    return {
      barcode,
      name:        p.product_name_en || p.product_name || 'Unknown Product',
      brand:       p.brands          || 'Unknown Brand',
      category,
      image_url:   p.image_front_url || p.image_url || null,
      nutriscore:  p.nutriscore_grade?.toUpperCase() ?? null,
      rawNutrients,
      source:      'open_food_facts',
    };
  } catch (err) {
    console.error('[OFF] Error:', err.code === 'ECONNABORTED' ? 'Timeout' : err.message);
    return null;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hasMinimalNutrientData(rawNutrients) {
  if (!rawNutrients) return false;
  const hasCalories =
    rawNutrients.energy_kcal_100g != null || rawNutrients.energy_100g != null;
  const hasMacro =
    rawNutrients.sugars_100g           != null ||
    rawNutrients.proteins_100g         != null ||
    rawNutrients['saturated-fat_100g'] != null;
  return hasCalories && hasMacro;
}

function countMissingNutrients(rawNutrients) {
  const keys = [
    'energy_kcal_100g', 'sugars_100g', 'saturated-fat_100g',
    'sodium_100g', 'fiber_100g', 'proteins_100g',
  ];
  return keys.filter(k => rawNutrients == null || rawNutrients[k] == null).length;
}

function isCacheStale(cached) {
  if (!cached) return false;
  const nutrients = cached.nutrients ?? {};
  return countMissingNutrients(nutrients) >= 5;
}

// ─── Controller ───────────────────────────────────────────────────────────────

async function getProduct(req, res) {
  try {
    const { barcode } = req.params;
    const userId      = req.user?.id;

    if (!/^\d{8,14}$/.test(barcode)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid barcode format. Must be 8–14 digits.',
      });
    }

    // ── STEP 1: Check Supabase cache ──────────────────────────────────
    let { data: cached } = await supabase
      .from('products')
      .select('*')
      .eq('barcode', barcode)
      .single();

    // Treat stale cache entries (all-null nutrients) as a miss
    if (isCacheStale(cached)) {
      console.log(`[Cache STALE] ${barcode} — nutrients all null, re-fetching`);
      cached = null;
    }

    let productData  = null;
    let rawNutrients = {};
    let dataSource   = 'cache';

    if (cached) {
      console.log(`[Cache HIT] ${barcode}`);
      productData  = cached;
      rawNutrients = cached.nutrients ?? {};
    } else {
      // ── STEP 2a: Open Food Facts ──────────────────────────────────
      console.log(`[Cache MISS] ${barcode} — calling Open Food Facts`);
      const offProduct = await fetchFromOFF(barcode);

      if (offProduct && hasMinimalNutrientData(offProduct.rawNutrients)) {
        productData  = offProduct;
        rawNutrients = offProduct.rawNutrients;
        dataSource   = 'open_food_facts';
        console.log(`[Source] Using Open Food Facts data for ${barcode}`);
      } else {
        // ── STEP 2b: FatSecret fallback ───────────────────────────
        if (offProduct) {
          console.log(`[OFF] Insufficient nutrient data for ${barcode} — trying FatSecret`);
        } else {
          console.log(`[OFF] No product found for ${barcode} — trying FatSecret`);
        }

        const fsProduct = await fetchFromFatSecret(barcode);

        if (fsProduct && hasMinimalNutrientData(fsProduct.rawNutrients)) {
          productData  = fsProduct;
          rawNutrients = fsProduct.rawNutrients;
          dataSource   = 'fatsecret';
          console.log(`[Source] Using FatSecret data for ${barcode}`);
        } else if (offProduct) {
          // Keep sparse OFF data — at least we have name/image
          productData  = offProduct;
          rawNutrients = offProduct.rawNutrients;
          dataSource   = 'open_food_facts';
          console.log(`[Source] Using sparse OFF data for ${barcode} (no FatSecret match)`);
        } else {
          return res.status(404).json({
            success: false,
            message: 'Product not found in any data source. Try scanning another barcode or add it manually.',
          });
        }
      }
    }

    // ── STEP 3: Gemini — fill missing nutrients ───────────────────────
    let estimatedFields = [];
    let aiEstimated     = false;

    const missingCount = countMissingNutrients(rawNutrients);
    if (missingCount > 0) {
      console.log(`[Gemini] ${missingCount} missing nutrient fields — asking AI to fill`);
      try {
        const filled = await fillMissingNutrients({
          name:         productData.name,
          brand:        productData.brand,
          category:     productData.category ?? 'general',
          rawNutrients,
        });
        rawNutrients    = filled.patchedNutrients;
        estimatedFields = filled.estimatedFields;
        aiEstimated     = filled.aiEstimated;

        if (aiEstimated) {
          console.log(`[Gemini] AI estimated: ${estimatedFields.join(', ')}`);
        }
      } catch (err) {
        console.error('[Gemini] fillMissingNutrients failed (non-fatal):', err.message);
      }
    }

    // ── STEP 4: User personalization ──────────────────────────────────
    let modifiers   = {};
    let userContext = {};

    if (userId) {
      const { data: profile } = await supabase
        .from('UserProfiles')
        .select('sugar_modifier, salt_modifier, fat_modifier, health_goal, dietary_preference')
        .eq('user_id', userId)
        .single();

      if (profile) {
        modifiers   = buildModifiers(profile);
        userContext = {
          health_goal:        profile.health_goal,
          dietary_preference: profile.dietary_preference,
        };
        console.log(`[Personalization] user=${userId} goal=${userContext.health_goal}`);
      }
    }

    // ── STEP 5: Score ─────────────────────────────────────────────────
    const { score, grade, breakdown } = calculateScore(rawNutrients, modifiers, userContext);
    const { warnings, tips }          = generateWarnings(rawNutrients, modifiers, userContext);
    const description                  = generateDescription(score, breakdown, userContext);
    const color                        = getScoreColor(score);
    const norm                         = normalizeNutrients(rawNutrients);

    const category = productData.category ?? 'general';

    // ── STEP 6: Cache / update ────────────────────────────────────────
    if (!cached) {
      const { error: insertError } = await supabase
        .from('products')
        .upsert({
          barcode:          productData.barcode ?? barcode,
          name:             productData.name,
          brand:            productData.brand,
          category,
          image_url:        productData.image_url,
          nutrients:        rawNutrients,
          estimated_fields: estimatedFields,
          calories:         norm.energy_kcal      ?? null,
          sugar:            norm.sugar            ?? null,
          saturated_fat:    norm.saturated_fat    ?? null,
          fiber:            norm.fiber            ?? null,
          salt:             rawNutrients.salt_100g ??
                              (norm.sodium != null
                                ? +(norm.sodium / 1000 * 2.5).toFixed(4)
                                : null),
          base_score:       score,
          data_source:      dataSource,
          updated_at:       new Date().toISOString(),
        }, { onConflict: 'barcode' });

      if (insertError) {
        console.error('[Cache] Upsert failed:', insertError.message);
      } else {
        console.log(`[Cache SET] ${barcode} (source: ${dataSource}, ai_estimated: ${aiEstimated})`);
      }
    }

    // ── STEP 7: Alternatives ──────────────────────────────────────────
    // getAlternatives already includes Gemini PH as Tier 4 internally.
    // No separate Gemini PH call here — avoids wasting free tier quota.
    const alternatives = await getAlternatives({
      category,
      currentScore:     score,
      currentBarcode:   barcode,
      currentNutrients: rawNutrients,
      modifiers,
      userContext: {
        ...userContext,
        productName:  productData.name,   // used by Gemini tier inside alternativeService
        productBrand: productData.brand,
      },
    });

    // ── STEP 8: data_limitations flags ───────────────────────────────
    const dataLimitations = [];
    if (dataSource === 'fatsecret') {
      dataLimitations.push(
        'nutriscore_unavailable',
        'nova_unavailable',
        'additives_unavailable',
      );
    }

    // ── STEP 9: Respond ───────────────────────────────────────────────
    return res.json({
      success: true,
      source:  cached ? 'cache' : dataSource,
      ...(dataLimitations.length && { data_limitations: dataLimitations }),
      product: {
        barcode,
        name:       productData.name,
        brand:      productData.brand,
        category,
        image_url:  productData.image_url  ?? null,
        nutriscore: productData.nutriscore ?? null,
        nutrients: {
          sugar_g:         norm.sugar,
          saturated_fat_g: norm.saturated_fat,
          sodium_mg:       norm.sodium,
          energy_kcal:     norm.energy_kcal,
          fiber_g:         norm.fiber,
          protein_g:       norm.protein,
          nova_group:      norm.nova_group,
          additives_count: norm.additives_count,
        },
        evaluation: {
          score,
          grade,
          color,
          display:   `${score}/100`,
          breakdown,
        },
        description,
        warnings,
        tips,
        alternatives: alternatives.map(alt => ({
          barcode:      alt.barcode,
          name:         alt.name,
          brand:        alt.brand,
          score:        alt.score,
          grade:        alt.grade,
          image_url:    alt.image_url    ?? null,
          reason:       alt.reason       ?? null,
          description:  alt.description  ?? null,
          source:       alt.source       ?? null,
          where_to_buy: alt.where_to_buy ?? null,
          nova_group:   alt.nova_group   ?? null,
          _nutrients:   alt._nutrients   ?? null,
        })),
        ai_nutrition: {
          estimated: aiEstimated,
          fields:    estimatedFields,
        },
      },
    });
  } catch (err) {
    console.error('[getProduct] Unexpected error:', err);
    return res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
}

module.exports = { getProduct };