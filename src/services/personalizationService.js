/**
 * Converts user health goals into scoring modifiers.
 */
function buildModifiers(profile) {
  const modifiers = {
    sugar_modifier: profile.sugar_modifier || 1,
    salt_modifier: profile.salt_modifier || 1,
    fat_modifier: profile.fat_modifier || 1,
  };
  return modifiers;
}

function goalToModifiers(health_goal, dietary_preference) {
  let sugar_modifier = 1;
  let salt_modifier = 1;
  let fat_modifier = 1;

  if (health_goal === 'low-sugar' || health_goal === 'diabetic-friendly') {
    sugar_modifier = health_goal === 'diabetic-friendly' ? 2.0 : 1.5;
  }
  if (health_goal === 'low-salt' || health_goal === 'hypertension') {
    salt_modifier = 1.5;
  }
  if (health_goal === 'heart-health' || health_goal === 'low-fat') {
    fat_modifier = 1.5;
  }

  return { sugar_modifier, salt_modifier, fat_modifier };
}

module.exports = { buildModifiers, goalToModifiers };