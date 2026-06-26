const supabase = require('../config/supabase');
const { updateGamification } = require('../services/gamificationService');
const { normalizeNutrients } = require('../services/scoringService');

// ── Helper: normalize nutrients for frontend ───────────────────────────────────
function toFrontendNutrients(raw) {
  if (!raw) return null;
  if (raw.sugar_g !== undefined || raw.energy_kcal !== undefined) return raw;
  const norm = normalizeNutrients(raw);
  return {
    sugar_g:         norm.sugar,
    saturated_fat_g: norm.saturated_fat,
    sodium_mg:       norm.sodium,
    energy_kcal:     norm.energy_kcal,
    fiber_g:         norm.fiber,
    protein_g:       norm.protein,
    nova_group:      norm.nova_group,
    additives_count: norm.additives_count,
  };
}

// ── Helper: dedicated column values from normalized nutrients ──────────────────
function dedicatedColumnsFromNormalized(nutrients, score) {
  if (!nutrients) return {};
  return {
    calories:      nutrients.energy_kcal      ?? null,
    sugar:         nutrients.sugar_g           ?? null,
    saturated_fat: nutrients.saturated_fat_g   ?? null,
    fiber:         nutrients.fiber_g           ?? null,
    salt:          nutrients.sodium_mg != null
                     ? +(nutrients.sodium_mg / 1000 * 2.5).toFixed(4)
                     : null,
    base_score:    score,
    updated_at:    new Date().toISOString(),
  };
}

// ── saveScan ───────────────────────────────────────────────────────────────────
async function saveScan(req, res) {
  try {
    const userId = req.user.id;
    const { barcode, score, product, description } = req.body;
    const alternatives = req.body.alternatives ?? [];
    const warnings    = req.body.warnings    ?? [];
    const tips        = req.body.tips        ?? [];

    console.log(`[saveScan] barcode=${barcode} score=${score} alts=${alternatives.length} desc=${!!description}`);

    if (!barcode || score === undefined) {
      return res.status(400).json({ success: false, message: 'barcode and score are required' });
    }

    if (typeof score !== 'number' || score < 0 || score > 100) {
      return res.status(400).json({ success: false, message: 'score must be a number between 0 and 100' });
    }

    // ── STEP 1: Ensure product row exists ─────────────────────────────
    const { data: existing } = await supabase
      .from('products')
      .select('barcode')
      .eq('barcode', barcode)
      .single();

    if (!existing) {
      const row = product
        ? {
            barcode:    product.barcode   ?? barcode,
            name:       product.name      ?? 'Unknown Product',
            brand:      product.brand     ?? 'Unknown Brand',
            category:   product.category  ?? 'general',
            image_url:  product.image_url ?? null,
            nutrients:  product.nutrients ?? null,
            ...dedicatedColumnsFromNormalized(product.nutrients, score),
          }
        : {
            barcode,
            name:       'Unknown Product',
            brand:      'Unknown Brand',
            category:   'general',
            base_score: score,
            updated_at: new Date().toISOString(),
          };

      const { error: upsertError } = await supabase
        .from('products')
        .upsert(row, { onConflict: 'barcode' });

      if (upsertError) {
        console.error('[saveScan] Failed to upsert product:', upsertError.message);
        return res.status(500).json({ success: false, message: 'Failed to cache product before saving scan.' });
      }
    } else if (product?.nutrients) {
      await supabase
        .from('products')
        .update({
          nutrients: product.nutrients,
          ...dedicatedColumnsFromNormalized(product.nutrients, score),
        })
        .eq('barcode', barcode);
    }

    // ── STEP 2: Insert scan ───────────────────────────────────────────
    // NOTE: if your scans table does NOT have a description column yet, run:
    //   ALTER TABLE scans ADD COLUMN IF NOT EXISTS description text DEFAULT NULL;
    const insertPayload = { user_id: userId, barcode, score };

    if (typeof description === 'string' && description.length > 0) {
      insertPayload.description = description;
    }
    if (warnings.length > 0) insertPayload.warnings = warnings;
    if (tips.length > 0)     insertPayload.tips     = tips;

    const { data: scan, error: scanError } = await supabase
      .from('scans')
      .insert(insertPayload)
      .select('id')
      .single();

    if (scanError) {
      console.error('[saveScan] Insert scan error:', scanError.message);
      return res.status(500).json({ success: false, message: scanError.message });
    }

    // Fallback: if .select('id') returned nothing (e.g. RLS blocks read-back),
    // fetch the scan id manually using the unique (user_id, barcode, created timestamp).
    let scanId = scan?.id;
    if (!scanId) {
      console.warn('[saveScan] scan.id not returned from insert — fetching manually');
      const { data: fallback } = await supabase
        .from('scans')
        .select('id')
        .eq('user_id', userId)
        .eq('barcode', barcode)
        .order('scanned_at', { ascending: false })
        .limit(1)
        .single();
      scanId = fallback?.id ?? null;
    }

    console.log(`[saveScan] scan inserted id=${scanId}`);

    // ── STEP 3: Save alternatives ─────────────────────────────────────
    if (scanId && alternatives.length > 0) {
      const altRows = alternatives.map(alt => ({
        scan_id:   scanId,
        barcode:   alt.barcode   ?? null,
        name:      alt.name      ?? null,
        brand:     alt.brand     ?? null,
        image_url: alt.image_url ?? null,
        score:     alt.score     ?? null,
        grade:     alt.grade     ?? null,
        reason:    alt.reason    ?? null,
      }));

      console.log(`[saveScan] Inserting ${altRows.length} alternatives for scan ${scanId}`);

      const { error: altError } = await supabase
        .from('scan_alternatives')
        .insert(altRows);

      if (altError) {
        // Log full error so we know exactly why it failed
        console.error('[saveScan] Failed to save alternatives:', altError.message, altError.details, altError.hint);
      } else {
        console.log(`[saveScan] Alternatives saved successfully`);
      }
    } else {
      console.log(`[saveScan] No alternatives to save (scanId=${scanId} alts=${alternatives.length})`);
    }

    // ── STEP 4: Update gamification ───────────────────────────────────
    const gamification = await updateGamification(userId, score);

    return res.json({ success: true, gamification });
  } catch (err) {
    console.error('[saveScan] Unexpected error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
}

// ── getHistory ─────────────────────────────────────────────────────────────────
async function getHistory(req, res) {
  try {
    const userId = req.user.id;
    const { filter = 'all' } = req.query;

    let query = supabase
      .from('scans')
      .select(`
        id,
        score,
        scanned_at,
        description,
        warnings,
        tips,
        products (
          barcode,
          name,
          brand,
          category,
          image_url,
          nutrients,
          base_score
        )
      `)
      .eq('user_id', userId)
      .is('archived_at', null)              // ← exclude archived scans
      .order('scanned_at', { ascending: false });

    if (filter === 'healthy')   query = query.gte('score', 60);
    if (filter === 'unhealthy') query = query.lt('score', 45);

    const { data, error } = await query;

    if (error) return res.status(500).json({ success: false, message: error.message });

    const history = (data ?? []).map(scan => ({
      ...scan,
      products: scan.products
        ? { ...scan.products, nutrients: toFrontendNutrients(scan.products.nutrients) }
        : scan.products,
    }));

    return res.json({ success: true, history });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

// ── getScanDetail ──────────────────────────────────────────────────────────────
async function getScanDetail(req, res) {
  try {
    const userId = req.user.id;
    const { scanId } = req.params;

    const { data: scan, error: scanError } = await supabase
      .from('scans')
      .select(`
        id,
        score,
        scanned_at,
        description,
        warnings,
        tips,
        products (
          barcode,
          name,
          brand,
          category,
          image_url,
          nutrients,
          base_score
        )
      `)
      .eq('id', scanId)
      .eq('user_id', userId)
      .single();

    if (scanError || !scan) {
      return res.status(404).json({ success: false, message: 'Scan not found.' });
    }

    const normalizedScan = {
      ...scan,
      products: scan.products
        ? { ...scan.products, nutrients: toFrontendNutrients(scan.products.nutrients) }
        : scan.products,
    };

    const { data: alternatives, error: altFetchError } = await supabase
      .from('scan_alternatives')
      .select('barcode, name, brand, image_url, score, grade, reason')
      .eq('scan_id', scanId)
      .order('score', { ascending: false });

    if (altFetchError) {
      console.error('[getScanDetail] Failed to fetch alternatives:', altFetchError.message);
    }

    return res.json({
      success: true,
      scan: { ...normalizedScan, alternatives: alternatives ?? [] },
    });
  } catch (err) {
    console.error('[getScanDetail] Unexpected error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
}

// ── archiveScan ────────────────────────────────────────────────────────────────
async function archiveScan(req, res) {
  try {
    const userId = req.user.id;
    const { scanId } = req.params;

    const { error } = await supabase
      .from('scans')
      .update({ archived_at: new Date().toISOString() })
      .eq('id', scanId)
      .eq('user_id', userId);     // ownership guard — user can only archive their own scans

    if (error) {
      console.error('[archiveScan] Error:', error.message);
      return res.status(500).json({ success: false, message: error.message });
    }

    return res.json({ success: true, message: 'Scan archived.' });
  } catch (err) {
    console.error('[archiveScan] Unexpected error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
}

// ── restoreScan ────────────────────────────────────────────────────────────────
async function restoreScan(req, res) {
  try {
    const userId = req.user.id;
    const { scanId } = req.params;

    const { error } = await supabase
      .from('scans')
      .update({ archived_at: null })
      .eq('id', scanId)
      .eq('user_id', userId);     // ownership guard — user can only restore their own scans

    if (error) {
      console.error('[restoreScan] Error:', error.message);
      return res.status(500).json({ success: false, message: error.message });
    }

    return res.json({ success: true, message: 'Scan restored.' });
  } catch (err) {
    console.error('[restoreScan] Unexpected error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
}

module.exports = { saveScan, getHistory, getScanDetail, archiveScan, restoreScan };