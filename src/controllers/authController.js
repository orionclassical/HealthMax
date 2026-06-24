const supabase = require('../config/supabase');
const { goalToModifiers } = require('../services/personalizationService');

// Valid dietary preference options
const DIETARY_OPTIONS = [
  'balanced',
  'vegetarian',
  'vegan',
  'pescatarian',
  'keto',
  'halal',
  'gluten-free',
  'dairy-free',
];

const HEALTH_GOAL_OPTIONS = [
  'low-sugar',
  'diabetic-friendly',
  'low-salt',
  'hypertension',
  'heart-health',
  'low-fat',
  'general-wellness',
];

async function register(req, res) {
  try {
    const {
      email,
      password,
      username,
      age,
      weight,
      health_goal,
      dietary_preference,
    } = req.body;

    // ── Validation ─────────────────────────────────────────────────────

    if (!email || !password || !username) {
      return res.status(400).json({
        success: false,
        message: 'email, password, and username are required',
      });
    }

    if (username.length < 3 || username.length > 50) {
      return res.status(400).json({
        success: false,
        message: 'Username must be between 3 and 50 characters',
      });
    }

    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return res.status(400).json({
        success: false,
        message: 'Username can only contain letters, numbers, and underscores',
      });
    }

    if (dietary_preference && !DIETARY_OPTIONS.includes(dietary_preference)) {
      return res.status(400).json({
        success: false,
        message: `Invalid dietary preference. Must be one of: ${DIETARY_OPTIONS.join(', ')}`,
      });
    }

    if (health_goal && !HEALTH_GOAL_OPTIONS.includes(health_goal)) {
      return res.status(400).json({
        success: false,
        message: `Invalid health goal. Must be one of: ${HEALTH_GOAL_OPTIONS.join(', ')}`,
      });
    }

    // ── Check if username already taken ────────────────────────────────
    const { data: existingUsername } = await supabase
      .from('user_profiles')
      .select('username')
      .eq('username', username)
      .maybeSingle();

    if (existingUsername) {
      return res.status(400).json({
        success: false,
        message: 'Username is already taken',
      });
    }

    // ── Create auth user ───────────────────────────────────────────────
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (error) {
      return res.status(400).json({ success: false, message: error.message });
    }

    const userId = data.user.id;

    // ── Build modifiers from health goal ───────────────────────────────
    const modifiers = goalToModifiers(health_goal, dietary_preference);

    // ── Save profile ───────────────────────────────────────────────────
    const { error: profileError } = await supabase.from('user_profiles').insert({
      user_id: userId,
      username,
      age: age || null,
      weight: weight || null,
      health_goal: health_goal || null,
      dietary_preference: dietary_preference || null,
      ...modifiers,
    });

    if (profileError) {
      console.error('Profile save failed:', profileError.message);
      return res.status(201).json({
        success: true,
        warning: 'Account created but profile could not be saved. Please update via /api/profile.',
        user: data.user,
      });
    }

    // ── Initialize gamification row ────────────────────────────────────
    await supabase.from('gamification').insert({
      user_id: userId,
      total_points: 0,
      current_streak: 0,
      longest_streak: 0,
      healthy_percentage: 0,
    });

    return res.status(201).json({
      success: true,
      message: 'Account created successfully',
      user: {
        id: userId,
        email: data.user.email,
        username,
      },
      modifiers,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

async function login(req, res) {
  try {
    const { email, password } = req.body;

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      return res.status(401).json({ success: false, message: error.message });
    }

    // Fetch profile to include username in response
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('username, health_goal, dietary_preference, age, weight')
      .eq('user_id', data.user.id)
      .single();

    return res.json({
      success: true,
      access_token: data.session.access_token,
      user: {
        id: data.user.id,
        email: data.user.email,
        username: profile?.username || null,
        health_goal: profile?.health_goal || null,
        dietary_preference: profile?.dietary_preference || null,
        age: profile?.age || null,
        weight: profile?.weight || null,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

module.exports = { register, login };