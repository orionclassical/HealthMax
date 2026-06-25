const supabase = require('../config/supabase');

async function getDashboard(req, res) {
  try {
    const userId = req.user.id;

    const { count: totalScans } = await supabase
      .from('scans')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);

    const { count: healthyScans } = await supabase
      .from('scans')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('score', 60);  // fixed: was 4, scores are 1-100

    const { data: gam } = await supabase
      .from('gamification')
      .select('total_points, current_streak, longest_streak, healthy_percentage, last_scan_date')
      .eq('user_id', userId)
      .single();

    // Compute healthy_percentage live from actual scan counts — never stale
    const liveHealthyPct = totalScans > 0
      ? Math.round((healthyScans / totalScans) * 100)
      : 0;

    // Derive streak_status from last_scan_date in Philippine time (UTC+8)
    let streak_status = null;
    if (gam?.last_scan_date) {
      const nowPH       = new Date(Date.now() + 8 * 60 * 60 * 1000);
      const todayPH     = nowPH.toISOString().slice(0, 10);
      const yesterdayPH = new Date(Date.now() + 8 * 60 * 60 * 1000 - 86400000)
                            .toISOString().slice(0, 10);

      if      (gam.last_scan_date === todayPH)      streak_status = 'scanned_today';
      else if (gam.last_scan_date === yesterdayPH)  streak_status = 'active';
      else                                           streak_status = 'broken';
    }

    return res.json({
      success: true,
      dashboard: {
        total_scans:        totalScans        || 0,
        healthy_scans:      healthyScans      || 0,
        healthy_percentage: liveHealthyPct,
        current_streak:     gam?.current_streak || 0,
        longest_streak:     gam?.longest_streak || 0,
        total_points:       gam?.total_points   || 0,
        streak_status,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

module.exports = { getDashboard };