/**
 * gamificationController.js
 *
 * ALL FIXES APPLIED:
 *   1. Broken streak: returns current_streak=0 and streak_label='None' when
 *      streakStatus==='broken' instead of showing stale DB value
 *   2. bonus_points_today zeroed in response when last_scan_date !== today
 *   3. recalculateHealthyStats no longer fetches all rows — uses two COUNT
 *      queries which are lightweight and don't transfer row data
 *   4. nextBadges sorted by proximity (how close the user is) not insertion order
 *   5. Unknown badge IDs in DB are warned, not silently dropped
 *   6. weekly_points zeroed in response when weekly_reset_date is stale
 */

const supabase = require('../config/supabase');
const { getLevelInfo, BADGES, LEVELS, HEALTHY_SCORE_THRESHOLD } = require('../services/gamificationService');

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
 * FIX: Uses two COUNT queries instead of fetching all score rows.
 * COUNT(*) transfers only a single integer — safe to call on every GET.
 * Previously pulled every score row for the user on each request.
 */
async function recalculateHealthyStats(userId) {
  const [totalResult, healthyResult] = await Promise.all([
    supabase
      .from('scans')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId),
    supabase
      .from('scans')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('score', HEALTHY_SCORE_THRESHOLD),
  ]);

  if (totalResult.error || healthyResult.error) {
    console.warn('[getGamification] recalculateHealthyStats failed:',
      totalResult.error?.message ?? healthyResult.error?.message);
    return { total_scans: 0, healthy_scans: 0, healthy_percentage: 0 };
  }

  const totalScans   = totalResult.count   ?? 0;
  const healthyScans = healthyResult.count ?? 0;
  const healthy_percentage = totalScans > 0
    ? Math.round((healthyScans / totalScans) * 100)
    : 0;

  return { total_scans: totalScans, healthy_scans: healthyScans, healthy_percentage };
}

/**
 * FIX: Sorts unearned badges by how close the user is to earning them,
 * rather than returning arbitrary insertion-order results.
 *
 * Proximity rules per badge type:
 *   - scan_*:   distance = threshold - totalScans (lower = closer)
 *   - streak_*: distance = threshold - currentStreak
 *   - others:   distance = 999 (shown last)
 */
function getNextBadges(earnedSet, totalScans, currentStreak, limit = 3) {
  const SCAN_THRESHOLDS   = { scan_10: 10, scan_50: 50, scan_100: 100, scan_500: 500 };
  const STREAK_THRESHOLDS = { streak_3: 3, streak_7: 7, streak_14: 14, streak_30: 30, streak_90: 90 };

  return Object.values(BADGES)
    .filter(b => !earnedSet.has(b.id))
    .map(b => {
      let distance = 999;
      if (SCAN_THRESHOLDS[b.id] != null) {
        distance = Math.max(0, SCAN_THRESHOLDS[b.id] - totalScans);
      } else if (STREAK_THRESHOLDS[b.id] != null) {
        distance = Math.max(0, STREAK_THRESHOLDS[b.id] - currentStreak);
      }
      return { ...b, distance };
    })
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit)
    .map(({ distance: _d, ...badge }) => badge); // strip internal distance field
}

// ─── Controller ───────────────────────────────────────────────────────────────

async function getGamification(req, res) {
  try {
    const userId       = req.user.id;
    const todayStr     = getTodayStr();
    const yesterdayStr = getYesterdayStr();
    const lastMondayStr = getLastMondayStr();

    const { data, error } = await supabase
      .from('gamification')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error && error.code !== 'PGRST116') {
      return res.status(500).json({ success: false, message: error.message });
    }

    // Default empty state for brand-new users
    const gam = data || {
      total_points:       0,
      weekly_points:      0,
      total_xp:           0,
      current_streak:     0,
      longest_streak:     0,
      healthy_percentage: 0,
      avg_score_last10:   0,
      badges:             [],
      last_scan_date:     null,
      bonus_points_today: 0,
      weekly_reset_date:  null,
    };

    // ── Streak status ─────────────────────────────────────────────────────
    const lastScan = gam.last_scan_date ?? null;

    let streakStatus = 'none';
    if      (lastScan === todayStr)     streakStatus = 'scanned_today';
    else if (lastScan === yesterdayStr) streakStatus = 'active';
    else if (lastScan)                  streakStatus = 'broken';

    // FIX: when streak is broken, return 0 not the stale DB value.
    // The DB gets corrected on the next scan via updateGamification.
    // Showing the old value (e.g. "7-day streak") when it's broken misleads users.
    const current_streak = streakStatus === 'broken' ? 0 : (gam.current_streak ?? 0);
    const longest_streak = gam.longest_streak ?? 0;

    const streakLabel = current_streak >= 365 ? 'Legendary'
                      : current_streak >= 180 ? 'Elite'
                      : current_streak >= 90  ? 'Master'
                      : current_streak >= 30  ? 'Expert'
                      : current_streak >= 14  ? 'Advanced'
                      : current_streak >= 7   ? 'Rising'
                      : current_streak >= 3   ? 'Building'
                      : current_streak >= 1   ? 'Starting'
                      : 'None';

    // ── Weekly points: zero out if reset is stale ─────────────────────────
    // The actual DB value gets corrected on the next scan.
    const weeklyResetStale = !gam.weekly_reset_date || gam.weekly_reset_date < lastMondayStr;
    const weekly_points    = weeklyResetStale ? 0 : (gam.weekly_points ?? 0);

    // FIX: zero out bonus_points_today in response if last scan wasn't today.
    // The service resets this during a scan write, but the read path never did.
    const bonus_points_today = lastScan === todayStr ? (gam.bonus_points_today ?? 0) : 0;

    // ── Healthy stats ─────────────────────────────────────────────────────
    // FIX: uses COUNT queries — does not fetch all rows.
    // Only recalculate if user has at least one scan (avoid unnecessary queries).
    let healthyStats = {
      total_scans:        0,
      healthy_scans:      0,
      healthy_percentage: gam.healthy_percentage ?? 0,
    };

    if (lastScan) {
      healthyStats = await recalculateHealthyStats(userId);

      // Fix stale stored value in background if it drifted
      if (healthyStats.healthy_percentage !== (gam.healthy_percentage ?? 0)) {
        supabase
          .from('gamification')
          .update({ healthy_percentage: healthyStats.healthy_percentage })
          .eq('user_id', userId)
          .then(() => {})
          .catch(err => console.warn('[getGamification] Background update failed:', err.message));
      }
    }

    // ── Level info ────────────────────────────────────────────────────────
    const levelInfo = getLevelInfo(gam.total_xp ?? 0);

    // ── Hydrate badge objects from stored IDs ─────────────────────────────
    const badgeIds = Array.isArray(gam.badges) ? gam.badges : [];

    // FIX: warn on unknown IDs so renames surface immediately
    const hydratedBadges = badgeIds
      .map(id => {
        if (!BADGES[id]) {
          console.warn(`[getGamification] Unknown badge ID in DB: "${id}"`);
          return null;
        }
        return BADGES[id];
      })
      .filter(Boolean);

    const earnedSet = new Set(badgeIds);

    // ── Next badges — sorted by proximity ────────────────────────────────
    // FIX: previously returned first 3 in definition order regardless of distance.
    const nextBadges = getNextBadges(
      earnedSet,
      healthyStats.total_scans,
      current_streak,
      3
    );

    // ── Weekly reset countdown ────────────────────────────────────────────
    // daysUntilReset = calendar days until next Monday 00:00.
    // Monday=1 → 7 (reset just happened, next in a week)
    // Sunday=0 → 1
    // Other    → 8 - dayOfWeek
    const dayOfWeek      = new Date().getDay();
    const daysUntilReset = dayOfWeek === 0 ? 1 : dayOfWeek === 1 ? 7 : 8 - dayOfWeek;
    const nextResetDate  = new Date();
    nextResetDate.setDate(nextResetDate.getDate() + daysUntilReset);

    return res.json({
      success: true,
      gamification: {
        // Points
        total_points:       gam.total_points    ?? 0,
        weekly_points,                                      // FIX: 0 when reset stale
        bonus_points_today,                                 // FIX: 0 when not scanned today

        // Streak
        current_streak,                                     // FIX: 0 when broken
        longest_streak,
        streak_label:       streakLabel,
        streak_status:      streakStatus,

        // Health stats
        healthy_percentage: healthyStats.healthy_percentage,
        avg_score_last10:   gam.avg_score_last10 ?? 0,
        total_scans:        healthyStats.total_scans,       // FIX: was hardcoded 0
        healthy_scans:      healthyStats.healthy_scans,     // FIX: was hardcoded 0

        // Level & XP
        total_xp:           gam.total_xp         ?? 0,
        level:              levelInfo.level,
        level_title:        levelInfo.title,
        level_progress:     levelInfo.level_progress,
        xp_into_level:      levelInfo.xp_into_level,
        xp_for_next:        levelInfo.xp_for_next,
        next_level_title:   levelInfo.next_title,

        // Badges
        badges:             hydratedBadges,
        next_badges:        nextBadges,                     // FIX: sorted by proximity
        badges_count:       hydratedBadges.length,
        total_badges:       Object.keys(BADGES).length,

        // Dates & weekly reset
        last_scan_date:     lastScan,
        days_until_reset:   daysUntilReset,
        next_reset_date:    nextResetDate.toISOString().split('T')[0],
        weekly_reset_stale: weeklyResetStale,

        // Meta
        levels:             LEVELS,
        healthy_threshold:  HEALTHY_SCORE_THRESHOLD,
      },
    });
  } catch (err) {
    console.error('[getGamification] Error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
}

module.exports = { getGamification };