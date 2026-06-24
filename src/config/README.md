# Config Documentation

This folder contains configuration files for the FitMax backend API.

## Table of Contents

- [Supabase Configuration](#supabase-configuration)

---

## Supabase Configuration

**File:** `supabase.js`

### What the Code Does

1. **Initialize Supabase Client:**
   - Creates Supabase client using environment variables
   - Provides database and auth functionality

### Environment Variables Required

```env
SUPABASE_URL=your_supabase_url
SUPABASE_KEY=your_supabase_anon_key
```

### Usage

```javascript
const supabase = require('./config/supabase');

// Database operations
const { data, error } = await supabase
  .from('table_name')
  .select('*')
  .eq('column', value);

// Auth operations
const { data, error } = await supabase.auth.signInWithPassword({
  email: 'user@example.com',
  password: 'password'
});
```

---

## How to Test in Postman

The Supabase client is used internally by all API endpoints. To test the configuration:

### Test 1: Health Check

- **Method:** GET
- **URL:** `http://localhost:3000/health`

**Expected Response:**
```json
{
  "status": "ok"
}
```

### Test 2: Database Connection

Make any authenticated API request - if returns 500 with database error, check Supabase configuration.

---

## Database Tables

The following tables are expected in Supabase:

| Table Name         | Description                    |
|-------------------|--------------------------------|
| `user_profiles`   | User health profiles          |
| `products`        | Cached product data            |
| `scans`           | User scan history              |
| `gamification`    | User gamification stats        |

---

## Environment Setup

1. Create a Supabase project
2. Get `SUPABASE_URL` and `SUPABASE_KEY` from settings
3. Create required tables using Supabase SQL editor:

```sql
-- User profiles table
CREATE TABLE user_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID UNIQUE REFERENCES auth.users(id),
  age INTEGER,
  weight DECIMAL,
  health_goal VARCHAR(50),
  dietary_preference VARCHAR(50),
  sugar_modifier DECIMAL DEFAULT 1,
  salt_modifier DECIMAL DEFAULT 1,
  fat_modifier DECIMAL DEFAULT 1,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Products cache table
CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  barcode VARCHAR(20) UNIQUE NOT NULL,
  name VARCHAR(255),
  brand VARCHAR(255),
  category VARCHAR(100),
  image_url TEXT,
  sugar DECIMAL,
  salt DECIMAL,
  saturated_fat DECIMAL,
  fiber DECIMAL,
  calories DECIMAL,
  base_score INTEGER,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Scans history table
CREATE TABLE scans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id),
  barcode VARCHAR(20),
  score INTEGER,
  scanned_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  FOREIGN KEY (barcode) REFERENCES products(barcode)
);

-- Gamification table
CREATE TABLE gamification (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID UNIQUE REFERENCES auth.users(id),
  total_points INTEGER DEFAULT 0,
  current_streak INTEGER DEFAULT 0,
  longest_streak INTEGER DEFAULT 0,
  healthy_percentage INTEGER DEFAULT 0,
  last_scan_date DATE
);
```

---

## Notes

- Supabase client handles both database and authentication
- Row Level Security (RLS) policies should be configured for production
- The client uses theAnon Key for public operations
- Admin operations require service_role key
