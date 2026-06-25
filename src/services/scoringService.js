/**
 * scoringService.js
 */

// ─── Thresholds (per 100g) ────────────────────────────────────────────────────

const THRESHOLDS = {
  sugar: [
    { limit: 45,   penalty: 10 },
    { limit: 40,   penalty: 9  },
    { limit: 36,   penalty: 8  },
    { limit: 31,   penalty: 7  },
    { limit: 27,   penalty: 6  },
    { limit: 22.5, penalty: 5  },
    { limit: 18,   penalty: 4  },
    { limit: 13.5, penalty: 3  },
    { limit: 9,    penalty: 2  },
    { limit: 4.5,  penalty: 1  },
  ],
  saturated_fat: [
    { limit: 10, penalty: 10 },
    { limit: 9,  penalty: 9  },
    { limit: 8,  penalty: 8  },
    { limit: 7,  penalty: 7  },
    { limit: 6,  penalty: 6  },
    { limit: 5,  penalty: 5  },
    { limit: 4,  penalty: 4  },
    { limit: 3,  penalty: 3  },
    { limit: 2,  penalty: 2  },
    { limit: 1,  penalty: 1  },
  ],
  sodium: [
    { limit: 900, penalty: 10 },
    { limit: 810, penalty: 9  },
    { limit: 720, penalty: 8  },
    { limit: 630, penalty: 7  },
    { limit: 540, penalty: 6  },
    { limit: 450, penalty: 5  },
    { limit: 360, penalty: 4  },
    { limit: 270, penalty: 3  },
    { limit: 180, penalty: 2  },
    { limit: 90,  penalty: 1  },
  ],
  energy_kcal: [
    { limit: 800, penalty: 10 },
    { limit: 720, penalty: 9  },
    { limit: 640, penalty: 8  },
    { limit: 560, penalty: 7  },
    { limit: 480, penalty: 6  },
    { limit: 400, penalty: 5  },
    { limit: 320, penalty: 4  },
    { limit: 240, penalty: 3  },
    { limit: 160, penalty: 2  },
    { limit: 80,  penalty: 1  },
  ],
  fiber: [
    { limit: 4.7, points: 5 },
    { limit: 3.7, points: 4 },
    { limit: 2.8, points: 3 },
    { limit: 1.9, points: 2 },
    { limit: 0.9, points: 1 },
  ],
  protein: [
    { limit: 8,   points: 5 },
    { limit: 6.4, points: 4 },
    { limit: 4.8, points: 3 },
    { limit: 3.2, points: 2 },
    { limit: 1.6, points: 1 },
  ],
};

const NOVA_SCORE_CAP = {
  4: 40,
  3: 60,
  2: 100,
  1: 100,
};

// FIX 2: Implicit processing penalty when NOVA is unknown
// High-fat, high-calorie products without NOVA data (e.g., USDA foods like fries)
// get a penalty based on their nutrient profile that correlates with processing
const IMPLICIT_PROCESSING_MAX_CAP = 65; // Unknown NOVA products cap at 65 max
const IMPLICIT_PROCESSING_THRESHOLDS = {
  // If fat > 8g AND calories > 350, it's likely deep-fried / ultra-processed
  high_fat_calorie: { saturated_fat: 8, energy_kcal: 350, cap: 45 },
  // If fat > 5g AND calories > 300, it's probably processed
  moderate_fat_calorie: { saturated_fat: 5, energy_kcal: 300, cap: 55 },
  // If fat > 3g AND calories > 250, treat with caution
  mild_fat_calorie: { saturated_fat: 3, energy_kcal: 250, cap: 60 },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getPenalty(value, thresholds) {
  if (value == null || isNaN(value)) return 0;
  for (const { limit, penalty } of thresholds) {
    if (value >= limit) return penalty;
  }
  return 0;
}

function getPoints(value, thresholds) {
  if (value == null || isNaN(value)) return 0;
  for (const { limit, points } of thresholds) {
    if (value >= limit) return points;
  }
  return 0;
}

/**
 * FIX 2: Determine implicit processing cap when NOVA data is unavailable.
 * Uses saturated fat + calorie density as proxies for processing level.
 * French fries: ~4-7g sat fat, ~300-400 kcal → gets capped at 45-55.
 */
function getImplicitProcessingCap(nutrients) {
  const fat    = nutrients.saturated_fat ?? 0;
  const energy = nutrients.energy_kcal ?? 0;

  // Check thresholds from strictest to loosest
  const { high_fat_calorie, moderate_fat_calorie, mild_fat_calorie } = IMPLICIT_PROCESSING_THRESHOLDS;

  if (fat >= high_fat_calorie.saturated_fat && energy >= high_fat_calorie.energy_kcal) {
    return high_fat_calorie.cap;
  }
  if (fat >= moderate_fat_calorie.saturated_fat && energy >= moderate_fat_calorie.energy_kcal) {
    return moderate_fat_calorie.cap;
  }
  if (fat >= mild_fat_calorie.saturated_fat && energy >= mild_fat_calorie.energy_kcal) {
    return mild_fat_calorie.cap;
  }

  return IMPLICIT_PROCESSING_MAX_CAP; // default cap for unknown NOVA
}

/**
 * Normalizes raw OFF nutrient keys to our internal format.
 *
 * KEY FIX: OFF uses 'energy-kcal_100g' with a DASH, not underscore.
 * We must check BOTH variants plus all other key aliases OFF uses.
 */
function normalizeNutrients(raw = {}) {
  // ── Energy ──────────────────────────────────────────────────────────
  // OFF key is 'energy-kcal_100g' (dash) — this was the main bug.
  // We check every possible variant to be safe.
  let energy_kcal =
    raw['energy-kcal_100g'] ??   // ← correct OFF key (dash) — was missing!
    raw['energy-kcal']      ??   // plain key without _100g suffix
    raw.energy_kcal_100g    ??   // underscore variant (our internal format)
    raw.energy_kcal         ??   // plain underscore
    null;

  // If still null, fall back to kJ and convert
  if (energy_kcal == null && raw.energy_100g != null) {
    energy_kcal = raw.energy_100g / 4.184;
  }
  if (energy_kcal == null && raw.energy != null) {
    energy_kcal = raw.energy / 4.184;
  }

  // ── Sugar ────────────────────────────────────────────────────────────
  const sugar =
    raw.sugars_100g ??
    raw.sugars      ??
    null;

  // ── Saturated fat ────────────────────────────────────────────────────
  // OFF key uses a dash: 'saturated-fat_100g'
  const saturated_fat =
    raw['saturated-fat_100g'] ??
    raw['saturated-fat']      ??
    raw.saturated_fat_100g    ??
    raw.saturated_fat         ??
    null;

  // ── Sodium ───────────────────────────────────────────────────────────
  // OFF gives sodium in grams — convert to mg
  let sodium = null;
  if (raw.sodium_100g != null) {
    sodium = raw.sodium_100g * 1000;       // g → mg
  } else if (raw.sodium != null) {
    sodium = raw.sodium * 1000;            // g → mg
  } else if (raw.salt_100g != null) {
    sodium = raw.salt_100g * 400;          // salt g → sodium mg
  } else if (raw.salt != null) {
    sodium = raw.salt * 400;
  }

  // ── Fiber ────────────────────────────────────────────────────────────
  const fiber =
    raw.fiber_100g  ??
    raw.fiber       ??
    raw.fibers_100g ??
    raw.fibers      ??
    null;

  // ── Protein ──────────────────────────────────────────────────────────
  const protein =
    raw.proteins_100g ??
    raw.proteins      ??
    raw.protein_100g  ??
    raw.protein       ??
    null;

  // ── Additives ────────────────────────────────────────────────────────
  const additives_count = Array.isArray(raw.additives_tags)
    ? raw.additives_tags.length
    : (raw.additives_count ?? 0);

  // ── NOVA ─────────────────────────────────────────────────────────────
  const nova_group = raw.nova_group ?? null;

  return {
    energy_kcal,
    sugar,
    saturated_fat,
    sodium,
    fiber,
    protein,
    additives_count,
    nova_group,
  };
}

// ─── Core Scorer ──────────────────────────────────────────────────────────────

function calculateScore(rawNutrients, modifiers = {}, userContext = {}) {
  const n = normalizeNutrients(rawNutrients);

  const {
    sugar_modifier = 1,
    salt_modifier  = 1,
    fat_modifier   = 1,
  } = modifiers;

  // ── Penalties ──────────────────────────────────────────────────────
  const sugarPenalty  = getPenalty((n.sugar         ?? 0) * sugar_modifier, THRESHOLDS.sugar);
  const fatPenalty    = getPenalty((n.saturated_fat ?? 0) * fat_modifier,   THRESHOLDS.saturated_fat);
  const sodiumPenalty = getPenalty((n.sodium        ?? 0) * salt_modifier,  THRESHOLDS.sodium);
  const energyPenalty = getPenalty(n.energy_kcal    ?? 0,                   THRESHOLDS.energy_kcal);
  const additivesPenalty = Math.min(15, n.additives_count * 1.0);

  const totalNegative = sugarPenalty + fatPenalty + sodiumPenalty
                      + energyPenalty + additivesPenalty;

  // ── Bonuses ────────────────────────────────────────────────────────
  const fiberPoints   = getPoints(n.fiber   ?? 0, THRESHOLDS.fiber);
  const proteinPoints = getPoints(n.protein ?? 0, THRESHOLDS.protein);
  const totalPositive = fiberPoints + proteinPoints;

  // ── Health-goal adjustment ─────────────────────────────────────────
  let goalAdjustment = 0;
  const goal = userContext.health_goal;
  if (goal === 'low-sugar'     && (n.sugar         ?? 0) > 5)   goalAdjustment -= 5;
  if (goal === 'low-sugar'     && (n.sugar         ?? 0) <= 2)  goalAdjustment += 3;
  if (goal === 'high-protein'  && (n.protein       ?? 0) >= 6)  goalAdjustment += 5;
  if (goal === 'weight-loss'   && (n.energy_kcal   ?? 0) > 400) goalAdjustment -= 5;
  if (goal === 'heart-healthy' && (n.sodium        ?? 0) > 450) goalAdjustment -= 5;
  if (goal === 'heart-healthy' && (n.saturated_fat ?? 0) > 3)   goalAdjustment -= 3;

  // ── Raw score ──────────────────────────────────────────────────────
  const NEGATIVE_SCALE = 2.0;
  const rawScore = 100
    - (totalNegative * NEGATIVE_SCALE)
    + (totalPositive * 2)
    + goalAdjustment;

  const uncappedScore = Math.round(Math.min(100, Math.max(0, rawScore)));

  // ── NOVA hard cap (or implicit processing cap) ────────────────────
  let novaCap = 100;
  let capSource = 'none';

  if (n.nova_group != null) {
    // Known NOVA → use explicit cap
    novaCap = NOVA_SCORE_CAP[n.nova_group] ?? 100;
    capSource = `nova_${n.nova_group}`;
  } else {
    // FIX 2: Unknown NOVA → use implicit processing cap based on fat + calories
    novaCap = getImplicitProcessingCap(n);
    capSource = `implicit_processing`;
  }

  const score = Math.min(uncappedScore, novaCap);
  const processingPenalty = uncappedScore - score;

  return {
    score,
    grade: scoreToGrade(score),
    breakdown: {
      penalties: {
        sugar:         sugarPenalty,
        saturated_fat: fatPenalty,
        sodium:        sodiumPenalty,
        energy:        energyPenalty,
        additives:     additivesPenalty,
        processing:    processingPenalty,
      },
      bonuses: {
        fiber:           fiberPoints,
        protein:         proteinPoints,
        goal_adjustment: goalAdjustment,
      },
      effective_nutrients: {
        sugar_g:         n.sugar,
        saturated_fat_g: n.saturated_fat,
        sodium_mg:       n.sodium,
        energy_kcal:     n.energy_kcal,
        fiber_g:         n.fiber,
        protein_g:       n.protein,
        nova_group:      n.nova_group,
        additives_count: n.additives_count,
      },
      nova_cap_applied: uncappedScore !== score,
      cap_source:       capSource,       // NEW: indicates which cap was used
      nova_cap:         novaCap,          // NEW: the actual cap value
      uncapped_score:   uncappedScore,
    },
  };
}

// ─── Grade & Color ────────────────────────────────────────────────────────────

function scoreToGrade(score) {
  if (score >= 75) return 'A';
  if (score >= 60) return 'B';
  if (score >= 45) return 'C';
  if (score >= 25) return 'D';
  return 'E';
}

function getScoreColor(score) {
  if (score >= 75) return 'green';
  if (score >= 60) return 'lime';
  if (score >= 45) return 'yellow';
  if (score >= 25) return 'orange';
  return 'red';
}

// ─── Warnings & Tips ──────────────────────────────────────────────────────────

function generateWarnings(rawNutrients, modifiers = {}, userContext = {}) {
  const n = normalizeNutrients(rawNutrients);
  const { sugar_modifier = 1, salt_modifier = 1, fat_modifier = 1 } = modifiers;
  const warnings = [];
  const tips     = [];

  const effectiveSugar  = (n.sugar         ?? 0) * sugar_modifier;
  const effectiveSodium = (n.sodium        ?? 0) * salt_modifier;
  const effectiveFat    = (n.saturated_fat ?? 0) * fat_modifier;

  if (n.nova_group === 4)
    warnings.push('🔴 Ultra-processed food (NOVA 4) — associated with higher risk of chronic disease.');
  else if (n.nova_group === 3)
    warnings.push('🟡 Processed food (NOVA 3) — prefer minimally processed alternatives when possible.');

  if (n.additives_count > 8)
    warnings.push(`🔴 Contains ${n.additives_count} additives — high additive load associated with adverse health effects with frequent consumption.`);
  else if (n.additives_count > 4)
    warnings.push(`⚠ Contains ${n.additives_count} additives — some may have adverse effects with frequent consumption.`);

  if (effectiveSugar > 22.5)
    warnings.push('🔴 Very high sugar — significantly increases risk of obesity, insulin resistance, and type 2 diabetes.');
  else if (effectiveSugar > 9)
    warnings.push('🟡 Moderate-high sugar — limit frequency of consumption.');

  if (effectiveSodium > 600)
    warnings.push('🔴 Very high sodium — major risk factor for hypertension and cardiovascular disease.');
  else if (effectiveSodium > 300)
    warnings.push('🟡 Moderate sodium — be mindful of total daily intake.');

  if (effectiveFat > 5)
    warnings.push('🔴 High saturated fat — raises LDL cholesterol.');
  else if (effectiveFat > 2)
    warnings.push('🟡 Moderate saturated fat — consume in moderation.');

  if ((n.fiber ?? 0) < 1.5)
    tips.push('💡 Low fiber — look for whole grain or high-fiber alternatives.');
  if ((n.protein ?? 0) < 2)
    tips.push('💡 Low protein — consider pairing with a protein-rich food.');

  const goal = userContext.health_goal;
  if (goal === 'low-sugar'    && effectiveSugar > 5)
    tips.push('💡 Your low-sugar goal: this product has notable sugar content — limit to occasional consumption.');
  if (goal === 'high-protein' && (n.protein ?? 0) < 5)
    tips.push('💡 Your high-protein goal: this product is not a strong protein source.');
  if (goal === 'weight-loss'  && (n.energy_kcal ?? 0) > 400)
    tips.push('💡 Your weight-loss goal: this is a calorie-dense product — watch portion size.');

  return { warnings, tips };
}

// ─── Description ──────────────────────────────────────────────────────────────

function generateDescription(score, breakdown, userContext = {}) {
  const p    = breakdown?.penalties           ?? {};
  const b    = breakdown?.bonuses             ?? {};
  const n    = breakdown?.effective_nutrients ?? {};
  const goal = userContext.health_goal;
  const novaCapped = breakdown?.nova_cap_applied ?? false;
  const capSource  = breakdown?.cap_source      ?? 'none';

  let opening = '';
  if (score >= 75)      opening = 'This is a solid, nutritious choice.';
  else if (score >= 60) opening = 'This product is reasonably healthy but has some areas to watch.';
  else if (score >= 45) opening = 'This product is moderate — fine occasionally, but not ideal regularly.';
  else if (score >= 25) opening = 'This product has several nutritional concerns worth noting.';
  else                  opening = 'This product scores poorly across multiple nutritional criteria.';

  let novaSentence = '';
  if (novaCapped) {
    const novaGroup = n.nova_group;
    const uncapped  = breakdown?.uncapped_score ?? score;
    if (novaGroup != null) {
      if (novaGroup === 4) {
        novaSentence = `Despite a nutrient-only score of ${uncapped}/100, the ultra-processed classification (NOVA 4) caps this product at 40 — processing level is a strong independent predictor of health outcomes.`;
      } else if (novaGroup === 3) {
        novaSentence = `The processed classification (NOVA 3) caps the score at 60, reflecting that processing level matters beyond individual nutrients.`;
      }
    } else if (capSource === 'implicit_processing') {
      // FIX 2: Describe implicit cap for USDA/unknown NOVA products
      const cap = breakdown?.nova_cap ?? score;
      if (cap <= 45) {
        novaSentence = `Without NOVA classification data, this product's high fat and calorie density suggest heavy processing — the score is capped at ${cap}/100.`;
      } else if (cap <= 55) {
        novaSentence = `Without NOVA classification data, this product's fat and calorie profile suggest moderate processing — the score is capped at ${cap}/100.`;
      } else {
        novaSentence = `Without NOVA classification data, the score is capped at ${cap}/100 as a precaution against unknown processing levels.`;
      }
    }
  }

  const concerns = [];

  if ((p.sugar ?? 0) >= 5)
    concerns.push(`high sugar (${n.sugar_g?.toFixed(1) ?? '?'}g per 100g)`);
  else if ((p.sugar ?? 0) >= 2)
    concerns.push(`moderate sugar (${n.sugar_g?.toFixed(1) ?? '?'}g per 100g)`);

  if ((p.sodium ?? 0) >= 5)
    concerns.push(`very high sodium (${n.sodium_mg != null ? Math.round(n.sodium_mg) : '?'}mg per 100g)`);
  else if ((p.sodium ?? 0) >= 3)
    concerns.push(`elevated sodium (${n.sodium_mg != null ? Math.round(n.sodium_mg) : '?'}mg per 100g)`);

  if ((p.saturated_fat ?? 0) >= 5)
    concerns.push(`high saturated fat (${n.saturated_fat_g?.toFixed(1) ?? '?'}g per 100g)`);
  else if ((p.saturated_fat ?? 0) >= 2)
    concerns.push(`moderate saturated fat (${n.saturated_fat_g?.toFixed(1) ?? '?'}g per 100g)`);

  if ((p.energy ?? 0) >= 5)
    concerns.push(`high calorie density (${n.energy_kcal != null ? Math.round(n.energy_kcal) : '?'} kcal per 100g)`);

  if ((p.additives ?? 0) >= 5)
    concerns.push(`${n.additives_count} additives`);

  const positives = [];

  if ((b.fiber ?? 0) >= 4)
    positives.push(`excellent fiber (${n.fiber_g?.toFixed(1) ?? '?'}g)`);
  else if ((b.fiber ?? 0) >= 2)
    positives.push(`decent fiber (${n.fiber_g?.toFixed(1) ?? '?'}g)`);

  if ((b.protein ?? 0) >= 4)
    positives.push(`good protein (${n.protein_g?.toFixed(1) ?? '?'}g)`);
  else if ((b.protein ?? 0) >= 2)
    positives.push(`moderate protein (${n.protein_g?.toFixed(1) ?? '?'}g)`);

  let concernSentence = '';
  if (concerns.length === 1) {
    concernSentence = `The main nutrient concern is its ${concerns[0]}.`;
  } else if (concerns.length === 2) {
    concernSentence = `Key nutrient concerns are its ${concerns[0]} and ${concerns[1]}.`;
  } else if (concerns.length >= 3) {
    const last = concerns[concerns.length - 1];
    const rest = concerns.slice(0, -1);
    concernSentence = `Key nutrient concerns include its ${rest.join(', ')}, and ${last}.`;
  }

  let positiveSentence = '';
  if (positives.length === 1) {
    positiveSentence = `On the plus side, it has ${positives[0]}.`;
  } else if (positives.length >= 2) {
    positiveSentence = `On the plus side, it provides ${positives.join(' and ')}.`;
  }

  let goalNote = '';
  if (goal === 'low-sugar'     && (p.sugar   ?? 0) >= 2)
    goalNote = 'Given your low-sugar goal, you may want to limit how often you consume this.';
  else if (goal === 'low-sugar' && (p.sugar  ?? 0) === 0)
    goalNote = 'The low sugar content aligns well with your low-sugar goal.';
  else if (goal === 'high-protein' && (b.protein ?? 0) >= 3)
    goalNote = 'The protein content supports your high-protein goal.';
  else if (goal === 'high-protein' && (b.protein ?? 0) === 0)
    goalNote = 'This product is not a strong source of protein for your high-protein goal.';
  else if (goal === 'weight-loss'  && (p.energy  ?? 0) >= 4)
    goalNote = 'The high calorie density is worth watching for your weight-loss goal.';
  else if (goal === 'heart-healthy' && ((p.sodium ?? 0) >= 4 || (p.saturated_fat ?? 0) >= 4))
    goalNote = 'The sodium and fat levels are a concern for your heart-healthy goal.';

  return [opening, novaSentence, concernSentence, positiveSentence, goalNote]
    .filter(Boolean)
    .join(' ');
}

module.exports = {
  calculateScore,
  generateWarnings,
  generateDescription,
  getScoreColor,
  scoreToGrade,
  normalizeNutrients,
};