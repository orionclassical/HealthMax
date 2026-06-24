const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Admin client — bypasses RLS (use only in backend)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = supabase;