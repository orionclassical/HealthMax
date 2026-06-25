const supabase = require('../config/supabase');
const { goalToModifiers } = require('../services/personalizationService');

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

async function saveProfile(req, res) {
  try {
    const userId = req.user.id;
    const { username, age, weight, health_goal, dietary_preference } = req.body;

    // ── Validation ─────────────────────────────────────────────────────

    if (username) {
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

      // Check username not taken by someone else
      const { data: existingUsername } = await supabase
        .from('user_profiles')
        .select('user_id')
        .eq('username', username)
        .neq('user_id', userId)
        .single();

      if (existingUsername) {
        return res.status(400).json({
          success: false,
          message: 'Username is already taken',
        });
      }
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

    const modifiers = goalToModifiers(health_goal, dietary_preference);

    const { error } = await supabase.from('user_profiles').upsert({
      user_id: userId,
      ...(username && { username }),
      ...(age && { age }),
      ...(weight && { weight }),
      ...(health_goal && { health_goal }),
      ...(dietary_preference && { dietary_preference }),
      ...modifiers,
    });

    if (error) {
      return res.status(500).json({ success: false, message: error.message });
    }

    return res.json({
      success: true,
      message: 'Profile updated successfully',
      modifiers,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

async function getProfile(req, res) {
  try {
    const userId = req.user.id;

    const { data, error } = await supabase
      .from('user_profiles')
      .select('username, age, weight, health_goal, dietary_preference, sugar_modifier, salt_modifier, fat_modifier')
      .eq('user_id', userId)
      .single();

    if (error && error.code !== 'PGRST116') {
      return res.status(500).json({ success: false, message: error.message });
    }

    return res.json({ success: true, profile: data || null });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

// Return dropdown options (frontend calls this to populate the dropdowns)
async function getOptions(req, res) {
  return res.json({
    success: true,
    options: {
      dietary_preferences: DIETARY_OPTIONS,
      health_goals: HEALTH_GOAL_OPTIONS,
    },
  });
}

module.exports = { saveProfile, getProfile, getOptions };