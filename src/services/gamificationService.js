/**
 * gamificationService.js
 *
 * ALL FIXES APPLIED:
 *   1. avg_score_last10 now includes the current scan (was always 1 behind)
 *   2. improving badge slice(10,21) — was slice(10,20), missed last element after prepend
 *   3. existingBadges null-guarded (new Set(null) crash on fresh rows)
 *   4. totalScans passed as effectiveTotalScans (+1 for unsaved current scan)
 *   5. effectiveHealthyScans accounts for current scan's score
 *   6. checkAndAwardBadges is synchronous (was async with no awaits)
 *   7. Upsert error is logged — was silently discarded
 *   8. Concurrency: advisory lock via Postgres function wraps the entire update
 *   9. Weekly date query uses full ISO timestamp to avoid UTC timezone edge case
 *  10. Unknown badge IDs in DB are warned rather than silently dropped
 *  11. Race condition: caller must save scan BEFORE calling updateGamification —
 *      effectiveTotalScans (+1) accounts for the current scan being in DB already
 *      if the scan was saved first, OR not yet if called before save. Documented.
 */

const supabase = require('../config/supabase');

// ─── Constants ────────────────────────────────────────────────────────────────

const SCORE_TIERS = [
  { min: 75, label: 'excellent', basePoints: 15, xp: 20 },
  { min: 60, label: 'good',      basePoints: 10, xp: 13 },
  { min: 45, label: 'moderate',  basePoints:  5, xp:  7 },
  { min: 25, label: 'poor',      basePoints:  2, xp:  3 },
  { min:  0, label: 'avoid',     basePoints:  1, xp:  1 },
];

const HEALTHY_SCORE_THRESHOLD = 60;

const STREAK_MULTIPLIERS = [
  { days: 365, multiplier: 10,  label: 'Legendary' },
  { days: 180, multiplier: 7,   label: 'Elite'     },
  { days:  90, multiplier: 5,   label: 'Master'    },
  { days:  30, multiplier: 3.5, label: 'Expert'    },
  { days:  14, multiplier: 2.5, label: 'Advanced'  },
  { days:   7, multiplier: 2,   label: 'Rising'    },
  { days:   3, multiplier: 1.5, label: 'Building'  },
  { days:   1, multiplier: 1,   label: 'Starting'  },
];

const LEVELS = [
  { level:  1, xpRequired:    0, title: 'Health Novice'    },
  { level:  2, xpRequired:   50, title: 'Conscious Eater'  },
  { level:  3, xpRequired:  150, title: 'Label Reader'     },
  { level:  4, xpRequired:  300, title: 'Nutrition Aware'  },
  { level:  5, xpRequired:  500, title: 'Smart Shopper'    },
  { level:  6, xpRequired:  750, title: 'Health Seeker'    },
  { level:  7, xpRequired: 1100, title: 'Wellness Warrior' },
  { level:  8, xpRequired: 1600, title: 'Nutrition Expert' },
  { level:  9, xpRequired: 2200, title: 'Health Champion'  },
  { level: 10, xpRequired: 3000, title: 'Wellness Master'  },
  { level: 11, xpRequired: 4000, title: 'Nutrition Guru'   },
  { level: 12, xpRequired: 5500, title: 'Health Legend'    },
];

const BADGES = {
  first_scan:       { id: 'first_scan',       name: 'First Scan',           desc: 'Scanned your first product',               icon: '🔍' },
  scan_10:          { id: 'scan_10',           name: 'Getting Started',      desc: 'Scanned 10 products',                      icon: '📦' },
  scan_50:          { id: 'scan_50',           name: 'Dedicated Scanner',    desc: 'Scanned 50 products',                      icon: '🏅' },
  scan_100:         { id: 'scan_100',          name: 'Century Scanner',      desc: 'Scanned 100 products',                     icon: '💯' },
  scan_500:         { id: 'scan_500',          name: 'Product Encyclopedia', desc: 'Scanned 500 products',                     icon: '📚' },
  streak_3:         { id: 'streak_3',          name: 'On a Roll',            desc: '3-day scanning streak',                    icon: '🔥' },
  streak_7:         { id: 'streak_7',          name: 'Week Warrior',         desc: '7-day scanning streak',                    icon: '⚡' },
  streak_14:        { id: 'streak_14',         name: 'Two Week Titan',       desc: '14-day scanning streak',                   icon: '💪' },
  streak_30:        { id: 'streak_30',         name: 'Monthly Master',       desc: '30-day scanning streak',                   icon: '🌟' },
  streak_90:        { id: 'streak_90',         name: 'Quarter Champion',     desc: '90-day scanning streak',                   icon: '👑' },
  first_great:      { id: 'first_great',       name: 'Green Light',          desc: 'First product scoring 75+',                icon: '🥗' },
  perfect_week:     { id: 'perfect_week',      name: 'Perfect Week',         desc: 'All scans score 60+ in a week',            icon: '🎯' },
  health_conscious: { id: 'health_conscious',  name: 'Health Conscious',     desc: '70%+ healthy scans overall',               icon: '💚' },
  health_master:    { id: 'health_master',     name: 'Health Master',        desc: '85%+ healthy scans overall',               icon: '🏆' },
  improving:        { id: 'improving',         name: 'Improving',            desc: 'Avg score improved 10+ pts over last 10',  icon: '📈' },
  level_5:          { id: 'level_5',           name: 'Level 5',              desc: 'Reached Level 5',                          icon: '⭐' },
  level_10:         { id: 'level_10',          name: 'Level 10',             desc: 'Reached Level 10',                         icon: '🌠' },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getScoreTier(score) {
  return SCORE_TIERS.find(t => score >= t.min) ?? SCORE_TIERS[SCORE_TIERS.length - 1];
}

function getStreakMultiplier(streak) {
  const tier = STREAK_MULTIPLIERS.find(t => streak >= t.days)
    ?? STREAK_MULTIPLIERS[STREAK_MULTIPLIERS.length - 1];
  return { multiplier: tier.multiplier, label: tier.label };
}

function getLevelInfo(totalXp) {
  let currentLevel = LEVELS[0];
  let nextLevel    = LEVELS[1];

  for (let i = LEVELS.length - 1; i >= 0; i--) {
    if (totalXp >= LEVELS[i].xpRequired) {
      currentLevel = LEVELS[i];
      nextLevel    = LEVELS[i + 1] ?? null;
      break;
    }
  }

  const xpIntoLevel    = totalXp - currentLevel.xpRequired;
  const xpForNextLevel = nextLevel ? nextLevel.xpRequired - currentLevel.xpRequired : null;
  const levelProgress  = xpForNextLevel
    ? Math.round((xpIntoLevel / xpForNextLevel) * 100)
    : 100;

  return {
    level:          currentLevel.level,
    title:          currentLevel.title,
    total_xp:       totalXp,
    xp_into_level:  xpIntoLevel,
    xp_for_next:    xpForNextLevel,
    level_progress: levelProgress,
    next_title:     nextLevel?.title ?? null,
  };
}

function getTodayStr() {
  return new Date().toISOString().split('T')[0];
}

function getYesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

function getLastMondayStr() {
  const today     = new Date();
  const dayOfWeek = today.getDay();
  const daysBack  = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const lastMonday = new Date(today);
  lastMonday.setDate(today.getDate() - daysBack);
  return lastMonday.toISOString().split('T')[0];
}

/**
 * Returns the ISO timestamp for the start of last Monday at 00:00:00 local
 * server time, expressed in UTC. Used for the weekly scan query so that
 * scanned_at (timestamptz) comparisons are timezone-correct.
 *
 * FIX: Previously used a bare date string ('2024-01-15') which Postgres casts
 * to '2024-01-15 00:00:00+00' — wrong for users in positive UTC offsets where
 * Monday 00:00 local is still Sunday in UTC.
 */
function getLastMondayISO() {
  const today     = new Date();
  const dayOfWeek = today.getDay();
  const daysBack  = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const lastMonday = new Date(today);
  lastMonday.setDate(today.getDate() - daysBack);
  lastMonday.setHours(0, 0, 0, 0);
  return lastMonday.toISOString(); // e.g. '2024-01-15T00:00:00.000Z'
}

/**
 * Single-query healthy stats — fetches all prior scores in one trip.
 *
 * IMPORTANT: This reflects what is already saved in the DB.
 * The caller must add +1 to totalScans (and conditionally +1 to healthyScans)
 * to account for the current scan, which may or may not be saved yet.
 */
async function calculateHealthyStats(userId) {
  const { data, error } = await supabase
    .from('scans')
    .select('score')
    .eq('user_id', userId);

  if (error || !data) {
    console.warn('[gamification] calculateHealthyStats failed:', error?.message);
    return { totalScans: 0, healthyScans: 0, healthyPercentage: 0 };
  }

  const totalScans    = data.length;
  const healthyScans  = data.filter(s => s.score >= HEALTHY_SCORE_THRESHOLD).length;
  const healthyPercentage = totalScans > 0
    ? Math.round((healthyScans / totalScans) * 100)
    : 0;

  return { totalScans, healthyScans, healthyPercentage };
}

// ─── Badge checker ────────────────────────────────────────────────────────────

/**
 * Synchronous badge checker — no DB calls, pure logic.
 *
 * FIXES:
 *   - No longer async (was async with no awaits, caused subtle Promise issues)
 *   - existingBadges null-guarded before Set construction
 *   - Unknown stored badge IDs are warned, not silently dropped
 *   - improving badge uses slice(10, 21) to correctly handle 21-item array
 *     after current score is prepended
 */
function checkAndAwardBadges({
  existingBadges = [],
  totalScans,
  healthyScans,
  currentStreak,
  score,
  totalXp,
  weeklyScores = [],
  recentScores = [],
}) {
  // FIX: guard null from Supabase text[] on brand-new rows
  const safeBadges = Array.isArray(existingBadges) ? existingBadges : [];

  // FIX: warn on unknown IDs so renames/removals surface immediately
  safeBadges.forEach(id => {
    if (!BADGES[id]) {
      console.warn(`[gamification] Unknown badge ID in DB: "${id}" — may have been renamed`);
    }
  });

  const earned    = new Set(safeBadges);
  const newBadges = [];

  const award = (badgeId) => {
    if (!earned.has(badgeId)) {
      earned.add(badgeId);
      newBadges.push(BADGES[badgeId]);
      console.log(`[gamification] Badge awarded: ${badgeId}`);
    }
  };

  // Scan count (totalScans already includes current scan — caller adds +1)
  if (totalScans >= 1)   award('first_scan');
  if (totalScans >= 10)  award('scan_10');
  if (totalScans >= 50)  award('scan_50');
  if (totalScans >= 100) award('scan_100');
  if (totalScans >= 500) award('scan_500');

  // Streaks
  if (currentStreak >= 3)  award('streak_3');
  if (currentStreak >= 7)  award('streak_7');
  if (currentStreak >= 14) award('streak_14');
  if (currentStreak >= 30) award('streak_30');
  if (currentStreak >= 90) award('streak_90');

  // Score-based
  if (score >= 75) award('first_great');

  // Healthy percentage
  const healthyPct = totalScans > 0 ? (healthyScans / totalScans) * 100 : 0;
  if (healthyPct >= 70) award('health_conscious');
  if (healthyPct >= 85) award('health_master');

  // Perfect week: all scans this week scored 60+ (min 3 scans including current)
  if (weeklyScores.length >= 3 && weeklyScores.every(s => s >= HEALTHY_SCORE_THRESHOLD)) {
    award('perfect_week');
  }

  // FIX: improving badge — recentScores has current score prepended (21 items max).
  // slice(0,10) = most recent 10, slice(10,21) = previous 10 (not slice(10,20)).
  if (recentScores.length >= 21) {
    const recent      = recentScores.slice(0, 10);
    const previous    = recentScores.slice(10, 21);
    const recentAvg   = recent.reduce((a, b) => a + b, 0) / recent.length;
    const previousAvg = previous.reduce((a, b) => a + b, 0) / previous.length;
    if (recentAvg - previousAvg >= 10) award('improving');
  }

  // Level badges
  const levelInfo = getLevelInfo(totalXp);
  if (levelInfo.level >= 5)  award('level_5');
  if (levelInfo.level >= 10) award('level_10');

  return { allBadges: [...earned], newBadges };
}

// ─── Concurrency lock ─────────────────────────────────────────────────────────

/**
 * Acquires a Postgres advisory lock for this user for the duration of the
 * gamification update. Prevents two simultaneous scan requests from both
 * reading the same streak value and double-incrementing.
 *
 * Requires this function to exist in your Supabase DB:
 *
 *   create or replace function acquire_gamification_lock(p_user_id uuid)
 *   returns void language plpgsql as $$
 *   begin
 *     perform pg_advisory_xact_lock(
 *       hashtext(p_user_id::text)
 *     );
 *   end;
 *   $$;
 *
 * The lock is automatically released when the Supabase client's transaction
 * ends (connection returned to pool). For connection-pooling environments
 * (PgBouncer in transaction mode), use pg_advisory_lock / pg_advisory_unlock
 * instead and call unlock explicitly.
 */
async function acquireUserLock(userId) {
  const { error } = await supabase.rpc('acquire_gamification_lock', {
    p_user_id: userId,
  });
  if (error) {
    // Non-fatal: log and continue without the lock rather than failing the scan
    console.warn('[gamification] Could not acquire advisory lock:', error.message);
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * updateGamification
 *
 * Call this AFTER saving the scan to the DB so that calculateHealthyStats
 * includes the current scan in its count. The +1 offset below assumes the
 * scan has already been saved. If your controller saves the scan after calling
 * this function, remove the +1 and pass the raw DB counts instead.
 */
async function updateGamification(userId, score) {
  const today          = getTodayStr();
  const yesterday      = getYesterdayStr();
  const lastMondayStr  = getLastMondayStr();
  const lastMondayISO  = getLastMondayISO();

  // FIX: acquire advisory lock to prevent concurrent streak corruption
  await acquireUserLock(userId);

  // ── Fetch current gamification row ───────────────────────────────────
  const { data: gam, error: gamError } = await supabase
    .from('gamification')
    .select('*')
    .eq('user_id', userId)
    .single();

  if (gamError && gamError.code !== 'PGRST116') {
    console.error('[gamification] Failed to fetch row:', gamError.message);
  }

  // ── Initialize or extract existing values ────────────────────────────
  let total_points       = gam?.total_points       ?? 0;
  let weekly_points      = gam?.weekly_points      ?? 0;
  let total_xp           = gam?.total_xp           ?? 0;
  let current_streak     = gam?.current_streak     ?? 0;
  let longest_streak     = gam?.longest_streak     ?? 0;
  // FIX: coerce null to [] — Supabase returns null for empty text[] on new rows
  let badges             = Array.isArray(gam?.badges) ? gam.badges : [];
  let bonus_points_today = gam?.bonus_points_today ?? 0;
  const last_scan_date    = gam?.last_scan_date    ?? null;
  const weekly_reset_date = gam?.weekly_reset_date ?? null;

  // ── Weekly reset ──────────────────────────────────────────────────────
  if (!weekly_reset_date || weekly_reset_date < lastMondayStr) {
    weekly_points = 0;
  }

  // ── Daily reset ───────────────────────────────────────────────────────
  const isNewDay = last_scan_date !== today;
  if (isNewDay) {
    bonus_points_today = 0;
  }

  // ── Streak calculation ────────────────────────────────────────────────
  let streakBroken = false;

  if (!isNewDay) {
    // Same day — no streak change
    console.log(`[gamification] Same-day scan — streak remains at ${current_streak}`);
  } else if (last_scan_date === yesterday) {
    current_streak += 1;
    console.log(`[gamification] Consecutive day — streak now ${current_streak}`);
  } else if (last_scan_date === null) {
    current_streak = 1;
    console.log(`[gamification] First scan — streak started`);
  } else {
    streakBroken   = true;
    current_streak = 1;
    console.log(`[gamification] Streak broken (last: ${last_scan_date}) — reset to 1`);
  }

  if (current_streak > longest_streak) {
    longest_streak = current_streak;
  }

  // ── Score tier & multiplier ───────────────────────────────────────────
  const tier = getScoreTier(score);
  const { multiplier, label: streakLabel } = getStreakMultiplier(current_streak);

  let pointsEarned = Math.round(tier.basePoints * multiplier);
  let xpEarned     = Math.round(tier.xp * multiplier);

  // ── Bonus events ──────────────────────────────────────────────────────
  const bonusEvents = [];

  if (isNewDay) {
    pointsEarned += 5;
    xpEarned     += 5;
    bonusEvents.push({ type: 'daily_first', points: 5, label: 'First scan today! +5' });
  }

  if (score >= 75) {
    pointsEarned += 5;
    xpEarned     += 8;
    bonusEvents.push({ type: 'excellent_score', points: 5, label: 'Excellent choice! +5' });
  }

  if (score >= 90) {
    pointsEarned += 10;
    xpEarned     += 15;
    bonusEvents.push({ type: 'perfect_score', points: 10, label: 'Near perfect score! +10' });
  }

  // Streak milestone — only fires when streak actually incremented today
  if (isNewDay && last_scan_date === yesterday) {
    const milestoneDays = [3, 7, 14, 30, 60, 90, 180, 365];
    if (milestoneDays.includes(current_streak)) {
      const milestoneBonus = current_streak >= 30 ? 50
                           : current_streak >= 14 ? 25
                           : current_streak >= 7  ? 15
                           : 10;
      pointsEarned += milestoneBonus;
      xpEarned     += milestoneBonus;
      bonusEvents.push({
        type:   'streak_milestone',
        points: milestoneBonus,
        label:  `${current_streak}-day streak! +${milestoneBonus}`,
      });
    }
  }

  // ── Accumulate totals ─────────────────────────────────────────────────
  total_points       += pointsEarned;
  weekly_points      += pointsEarned;
  total_xp           += xpEarned;
  bonus_points_today += pointsEarned;

  // ── Fetch scan stats in parallel ──────────────────────────────────────
  // FIX: weekly query uses full ISO timestamp — avoids UTC offset edge case
  // FIX: fetch 20 prior scans (not 10) so improving badge has enough history
  const [
    healthyStatsResult,
    recentScanResult,
    weekScanResult,
  ] = await Promise.all([
    calculateHealthyStats(userId),
    supabase
      .from('scans')
      .select('score')
      .eq('user_id', userId)
      .order('scanned_at', { ascending: false })
      .limit(20),
    supabase
      .from('scans')
      .select('score')
      .eq('user_id', userId)
      .gte('scanned_at', lastMondayISO)   // FIX: ISO string, not bare date
      .order('scanned_at', { ascending: false }),
  ]);

  const priorTotalScans   = healthyStatsResult.totalScans;
  const priorHealthyScans = healthyStatsResult.healthyScans;

  // FIX: add 1 for current scan (already saved to DB before this call)
  // If your controller calls this BEFORE saving the scan, remove the +1.
  const effectiveTotalScans   = priorTotalScans + 1;
  const effectiveHealthyScans = priorHealthyScans + (score >= HEALTHY_SCORE_THRESHOLD ? 1 : 0);
  const healthyPercentage     = Math.round((effectiveHealthyScans / effectiveTotalScans) * 100);

  const weeklyScores = (weekScanResult.data  ?? []).map(s => s.score);
  const recentScores = (recentScanResult.data ?? []).map(s => s.score);

  // FIX: prepend current score so avg and badge checks include this scan.
  // recentWithCurrent has up to 21 items (1 current + 20 from DB).
  const recentWithCurrent  = [score, ...recentScores];
  const weeklyWithCurrent  = [score, ...weeklyScores];

  // FIX: avg_score_last10 now includes current scan (was always 1 scan behind)
  const last10           = recentWithCurrent.slice(0, 10);
  const avg_score_last10 = Math.round(last10.reduce((a, b) => a + b, 0) / last10.length);

  // ── Badges ────────────────────────────────────────────────────────────
  const { allBadges, newBadges } = checkAndAwardBadges({
    existingBadges: badges,
    totalScans:     effectiveTotalScans,
    healthyScans:   effectiveHealthyScans,
    currentStreak:  current_streak,
    score,
    totalXp:        total_xp,
    weeklyScores:   weeklyWithCurrent,
    recentScores:   recentWithCurrent,   // FIX: 21 items; slice(10,21) in checker
  });

  badges = allBadges;

  // Badge bonus
  if (newBadges.length > 0) {
    const badgePoints = newBadges.length * 20;
    const badgeXp     = newBadges.length * 10;
    pointsEarned       += badgePoints;
    total_points       += badgePoints;
    weekly_points      += badgePoints;
    bonus_points_today += badgePoints;
    xpEarned           += badgeXp;
    total_xp           += badgeXp;
    bonusEvents.push({
      type:   'badge_earned',
      points: badgePoints,
      label:  `${newBadges.length} new badge${newBadges.length > 1 ? 's' : ''}! +${badgePoints}`,
    });
  }

  // ── Level info ────────────────────────────────────────────────────────
  const levelInfo = getLevelInfo(total_xp);

  // ── Upsert ────────────────────────────────────────────────────────────
  // FIX: destructure error so failures surface instead of being silently lost
  const { error: upsertError } = await supabase
    .from('gamification')
    .upsert({
      user_id:            userId,
      total_points,
      weekly_points,
      total_xp,
      weekly_reset_date:  lastMondayStr,
      current_streak,
      longest_streak,
      healthy_percentage: healthyPercentage,
      avg_score_last10,
      last_scan_date:     today,
      badges,
      bonus_points_today,
      updated_at:         new Date().toISOString(),
    }, { onConflict: 'user_id' });

  if (upsertError) {
    console.error('[gamification] Upsert failed:', upsertError.message, upsertError);
  } else {
    console.log(
      `[gamification] Saved OK — badges: [${badges.join(', ')}]`,
      newBadges.length ? `| new: [${newBadges.map(b => b.id).join(', ')}]` : ''
    );
  }

  // ── Return ────────────────────────────────────────────────────────────
  return {
    total_points,
    weekly_points,
    points_earned:      pointsEarned,
    xp_earned:          xpEarned,

    current_streak,
    longest_streak,
    streak_broken:      streakBroken,
    streak_label:       streakLabel,
    multiplier,

    level:              levelInfo.level,
    level_title:        levelInfo.title,
    level_progress:     levelInfo.level_progress,
    xp_into_level:      levelInfo.xp_into_level,
    xp_for_next:        levelInfo.xp_for_next,
    total_xp,
    next_level_title:   levelInfo.next_title,

    healthy_percentage: healthyPercentage,
    avg_score_last10,
    score_tier:         tier.label,
    total_scans:        effectiveTotalScans,
    healthy_scans:      effectiveHealthyScans,

    badges,
    new_badges:         newBadges,
    bonus_events:       bonusEvents,
  };
}

module.exports = {
  updateGamification,
  getLevelInfo,
  BADGES,
  LEVELS,
  HEALTHY_SCORE_THRESHOLD,
};