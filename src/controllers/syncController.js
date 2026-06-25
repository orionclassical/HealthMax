const supabase = require('../config/supabase');
const { updateGamification } = require('../services/gamificationService');

async function syncOfflineData(req, res) {
  try {
    const userId = req.user.id;
    const { localScans = [], localGamification = {} } = req.body;

    let syncedCount = 0;

    for (const scan of localScans) {
      // Check if product exists in cache
      const { data: product } = await supabase
        .from('products')
        .select('barcode')
        .eq('barcode', scan.barcode)
        .single();

      if (!product) continue; // Skip if product never cached

      // Check if scan already exists for that date
      const { data: existing } = await supabase
        .from('scans')
        .select('id')
        .eq('user_id', userId)
        .eq('barcode', scan.barcode)
        .gte('scanned_at', scan.date + 'T00:00:00')
        .lte('scanned_at', scan.date + 'T23:59:59')
        .single();

      if (existing) continue;

      await supabase.from('scans').insert({
        user_id: userId,
        barcode: scan.barcode,
        score: scan.score,
        scanned_at: new Date(scan.date).toISOString(),
      });

      syncedCount++;
    }

    // Merge gamification — use higher streak, add points
    const { data: cloudGam } = await supabase
      .from('gamification')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (cloudGam) {
      const mergedPoints = (cloudGam.total_points || 0) + (localGamification.points || 0);
      const mergedStreak = Math.max(cloudGam.current_streak || 0, localGamification.streak || 0);
      const mergedLongest = Math.max(cloudGam.longest_streak || 0, mergedStreak);

      const { count: totalScans } = await supabase
        .from('scans')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId);

      const { count: healthyScans } = await supabase
        .from('scans')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .gte('score', 4);

      const healthy_percentage = totalScans > 0
        ? Math.round((healthyScans / totalScans) * 100)
        : 0;

      await supabase.from('gamification').upsert({
        user_id: userId,
        total_points: mergedPoints,
        current_streak: mergedStreak,
        longest_streak: mergedLongest,
        healthy_percentage,
      });
    }

    return res.json({
      success: true,
      message: `Synced ${syncedCount} new scans`,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

module.exports = { syncOfflineData };