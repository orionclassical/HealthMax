const supabase = require('../config/supabase');
const { getLevelInfo } = require('../services/gamificationService');

async function getLeaderboard(req, res) {
  try {
    const userId = req.user.id;

    const { data: gamData, error: gamError } = await supabase
      .from('gamification')
      .select(`
        user_id,
        total_points,
        weekly_points,
        total_xp,
        current_streak,
        longest_streak,
        healthy_percentage,
        avg_score_last10,
        badges
      `)
      .order('total_points', { ascending: false })
      .limit(50);

    if (gamError) {
      console.error('[getLeaderboard] gamification fetch error:', gamError);
      return res.status(500).json({ success: false, message: gamError.message });
    }

    if (!gamData || gamData.length === 0) {
      return res.json({ success: true, leaderboard: [], my_rank: null });
    }

    const userIds = gamData.map(g => g.user_id);
    if (!userIds.includes(userId)) userIds.push(userId);

    const { data: profileData, error: profileError } = await supabase
      .from('user_profiles')
      .select('user_id, username')
      .in('user_id', userIds);

    if (profileError) {
      console.error('[getLeaderboard] profile fetch error:', profileError);
    }

    const profileMap = {};
    (profileData || []).forEach(p => {
      profileMap[p.user_id] = p;
    });

    const getStreakLabel = (streak) => {
      if (streak >= 365) return 'Legendary';
      if (streak >= 180) return 'Elite';
      if (streak >= 90)  return 'Master';
      if (streak >= 30)  return 'Expert';
      if (streak >= 14)  return 'Advanced';
      if (streak >= 7)   return 'Rising';
      if (streak >= 3)   return 'Building';
      if (streak >= 1)   return 'Starting';
      return 'None';
    };

    const leaderboard = gamData.map((row, index) => {
      const levelInfo = getLevelInfo(row.total_xp ?? 0);
      const streak    = row.current_streak ?? 0;

      return {
        rank:               index + 1,
        user_id:            row.user_id,
        username:           profileMap[row.user_id]?.username ?? 'Anonymous',
        avatar_url:         null,
        is_me:              row.user_id === userId,
        total_points:       row.total_points       ?? 0,
        weekly_points:      row.weekly_points      ?? 0,
        level:              levelInfo.level,
        level_title:        levelInfo.title,
        level_progress:     levelInfo.level_progress,
        total_xp:           row.total_xp            ?? 0,
        current_streak:     streak,
        longest_streak:     row.longest_streak      ?? 0,
        streak_label:       getStreakLabel(streak),
        healthy_percentage: row.healthy_percentage  ?? 0,
        avg_score_last10:   row.avg_score_last10    ?? 0,
        badge_count:        (row.badges ?? []).length,
      };
    });

    const myEntry = leaderboard.find(e => e.is_me);
    if (myEntry) {
      return res.json({ success: true, leaderboard, my_rank: myEntry });
    }

    const lowestPoints = gamData[gamData.length - 1]?.total_points ?? 0;

    const { count, error: countError } = await supabase
      .from('gamification')
      .select('*', { count: 'exact', head: true })
      .gt('total_points', lowestPoints);

    if (countError) {
      console.error('[getLeaderboard] count query error:', countError);
    }

    const { data: myRow, error: myRowError } = await supabase
      .from('gamification')
      .select('total_points, weekly_points, total_xp, current_streak, longest_streak, healthy_percentage, avg_score_last10, badges')
      .eq('user_id', userId)
      .maybeSingle();

    if (myRowError) {
      console.error('[getLeaderboard] myRow fetch error:', myRowError);
    }

    let my_rank = null;

    if (myRow) {
      const myLevelInfo = getLevelInfo(myRow.total_xp ?? 0);
      const myStreak    = myRow.current_streak ?? 0;

      my_rank = {
        rank:               (count ?? 0) + 1,
        user_id:            userId,
        username:           profileMap[userId]?.username ?? 'Anonymous',
        avatar_url:         null,
        is_me:              true,
        total_points:       myRow.total_points       ?? 0,
        weekly_points:      myRow.weekly_points      ?? 0,
        level:              myLevelInfo.level,
        level_title:        myLevelInfo.title,
        level_progress:     myLevelInfo.level_progress,
        total_xp:           myRow.total_xp            ?? 0,
        current_streak:     myStreak,
        longest_streak:     myRow.longest_streak      ?? 0,
        streak_label:       getStreakLabel(myStreak),
        healthy_percentage: myRow.healthy_percentage  ?? 0,
        avg_score_last10:   myRow.avg_score_last10    ?? 0,
        badge_count:        (myRow.badges ?? []).length,
      };
    }

    return res.json({ success: true, leaderboard, my_rank });

  } catch (err) {
    console.error('[getLeaderboard] Unhandled error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
}

module.exports = { getLeaderboard };