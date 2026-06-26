# Controllers Documentation

This folder contains all the controller functions for the FitMax backend API. Controllers contain the business logic and handle requests/responses for each route.

## Table of Contents

- [Auth Controller](#auth-controller)
- [Product Controller](#product-controller)
- [History Controller](#history-controller)
- [Gamification Controller](#gamification-controller)
- [Dashboard Controller](#dashboard-controller)
- [Profile Controller](#profile-controller)
- [Sync Controller](#sync-controller)

---

## Auth Controller

**File:** `authController.js`

### What the Code Does

1. **Register Function:**
   - Creates a new auth user in Supabase
   - Generates personalization modifiers based on health goal
   - Saves user profile with health information
   - Initializes gamification row for the user
   - Returns user data with generated modifiers

2. **Login Function:**
   - Authenticates user with email/password via Supabase
   - Returns JWT access token and user info

### Key Functions

| Function   | Description                          |
|------------|-------------------------------------|
| `register` | Create new user account            |
| `login`    | Authenticate existing user          |

### Dependencies

- `supabase` - For database operations
- `personalizationService` - For generating health modifiers

---

## Product Controller

**File:** `productController.js`

### What the Code Does

1. **Fetch from Open Food Facts:**
   - Queries the Open Food Facts API for product data
   - Safely extracts nutrients (sugar, salt, saturated fat, fiber, calories)
   - Handles various API response formats
   - Falls back to cache if product exists

2. **Product Lookup:**
   - Validates barcode format (8-14 digits)
   - Checks Supabase cache first
   - Fetches from Open Food Facts if not cached
   - Caches fetched products

3. **Score Calculation:**
   - Calculates base score using scoring service
   - Applies user personalization modifiers (if authenticated)
   - Generates health warnings
   - Determines score color (red/yellow/green)

4. **Alternatives:**
   - Finds healthier alternatives in same category
   - Returns top 3 products with higher scores

### Key Functions

| Function   | Description                          |
|------------|-------------------------------------|
| `getProduct` | Get product info with score        |

### Dependencies

- `axios` - For HTTP requests to Open Food Facts
- `supabase` - For caching products
- `scoringService` - For calculating health scores
- `alternativeService` - For finding alternatives
- `personalizationService` - For user modifiers

---

## History Controller

**File:** `historyController.js`

### What the Code Does

1. **Save Scan:**
   - Saves product scan to history
   - Updates gamification stats (points, streak)
   - Returns updated gamification data

2. **Get History:**
   - Retrieves user's scan history
   - Includes product details
   - Supports filtering by health status
   - Orders by most recent first

### Key Functions

| Function   | Description                          |
|------------|-------------------------------------|
| `saveScan`  | Save scan to history                |
| `getHistory` | Get user's scan history            |

### Dependencies

- `supabase` - For database operations
- `gamificationService` - For updating gamification stats

---

## Gamification Controller

**File:** `gamificationController.js`

### What the Code Does

1. **Get Gamification:**
   - Retrieves user's gamification data
   - Computes achievement badges based on stats
   - Returns gamification data with badges

### Badge Logic

| Badge ID        | Label              | Requirement                  |
|----------------|-------------------|----------------------------|
| centurion      | 💯 Centurion      | 100+ total points          |
| streak7        | 🔥 7-Day Streak   | 7+ day scanning streak    |
| health_hero    | 💚 Health Hero   | 80%+ healthy scans        |

### Key Functions

| Function       | Description                          |
|----------------|-------------------------------------|
| `getGamification` | Get user's gamification data  |

### Dependencies

- `supabase` - For database operations

---

## Dashboard Controller

**File:** `dashboardController.js`

### What the Code Does

1. **Get Dashboard:**
   - Counts total scans
   - Counts healthy scans (score ≥ 4)
   - Retrieves gamification stats
   - Calculates healthy percentage
   - Returns comprehensive dashboard data

### Key Functions

| Function    | Description                          |
|-------------|-------------------------------------|
| `getDashboard` | Get user dashboard data       |

### Dependencies

- `supabase` - For database operations

---

## Profile Controller

**File:** `profileController.js`

### What the Code Does

1. **Save Profile:**
   - Updates user profile in database
   - Regenerates personalization modifiers
   - Updates health goal preferences

2. **Get Profile:**
   - Retrieves user profile
   - Returns current preferences and modifiers

### Key Functions

| Function   | Description                          |
|------------|-------------------------------------|
| `saveProfile` | Save or update user profile    |
| `getProfile`  | Get user profile             |

### Dependencies

- `supabase` - For database operations
- `personalizationService` - For generating modifiers

---

## Sync Controller

**File:** `syncController.js`

### What the Code Does

1. **Sync Offline Data:**
   - Processes offline scans from mobile app
   - Checks for duplicates by date
   - Inserts new scans into database
   - Merges gamification stats
   - Uses higher streak, combines points

### Key Functions

| Function        | Description                          |
|----------------|-------------------------------------|
| `syncOfflineData` | Sync offline scan data        |

### Dependencies

- `supabase` - For database operations
- `gamificationService` - For updating gamification

---

## How to Test in Postman

### Prerequisites

1. Register and login to get access token
2. Use the token in Authorization header for protected endpoints

### Testing Sample Data

#### User Registration

```json
{
  "email": "test@example.com",
  "password": "SecurePassword123!",
  "age": 30,
  "weight": 75,
  "health_goal": "low-sugar",
  "dietary_preference": "vegetarian"
}
```

#### User Login

```json
{
  "email": "test@example.com",
  "password": "SecurePassword123!"
}
```

#### Save Product Scan

```json
{
  "barcode": "5000159484695",
  "score": 4
}
```

#### Sync Offline Data

```json
{
  "localScans": [
    {
      "barcode": "5000159484695",
      "score": 4,
      "date": "2024-01-15"
    }
  ],
  "localGamification": {
    "points": 20,
    "streak": 2
  }
}
```

---

## Database Tables Used

The controllers interact with the following Supabase tables:

- `auth.users` - Supabase built-in authentication
- `user_profiles` - User health profiles
- `products` - Cached product data
- `scans` - User scan history
- `gamification` - User gamification stats

---

## Error Handling

All controllers return consistent JSON responses:

```json
// Success
{
  "success": true,
  "data": { ... }
}

// Error
{
  "success": false,
  "message": "Error description"
}
```

---

## Middleware Used

- `authMiddleware` - Protects routes requiring authentication
- Validates JWT token from Supabase
- Attaches user object to request

---

## Services Used

| Controller       | Service Used                  |
|-----------------|----------------------------|
| Auth            | personalizationService        |
| Product         | scoringService             |
|                 | alternativeService       |
|                 | personalizationService    |
| History         | gamificationService      |
| Profile         | personalizationService    |
| Sync            | gamificationService       |
