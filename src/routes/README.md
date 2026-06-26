# API Routes Documentation

This folder contains all the route definitions for the FitMax backend API. Routes define the API endpoints and connect them to their corresponding controller functions.

## Table of Contents

- [Auth Routes](#auth-routes)
- [Product Routes](#product-routes)
- [History Routes](#history-routes)
- [Gamification Routes](#gamification-routes)
- [Dashboard Routes](#dashboard-routes)
- [Profile Routes](#profile-routes)
- [Sync Routes](#sync-routes)

---

## Auth Routes

**File:** `authRoutes.js`

**Base URL:** `/api/auth`

### Endpoints

| Method | Endpoint   | Description         | Auth Required |
|--------|-----------|---------------------|---------------|
| POST   | `/register` | Register new user  | No            |
| POST   | `/login`    | Login user          | No            |

---

## Product Routes

**File:** `productRoutes.js`

**Base URL:** `/api/product`

### Endpoints

| Method | Endpoint      | Description                    | Auth Required |
|--------|--------------|--------------------------------|---------------|
| GET    | `/:barcode`  | Get product by barcode         | Optional      |

**Note:** Authentication is optional - works for both guest and authenticated users.

---

## History Routes

**File:** `historyRoutes.js`

**Base URL:** `/api/history`

### Endpoints

| Method | Endpoint | Description           | Auth Required |
|--------|----------|----------------------|---------------|
| POST   | `/`      | Save scan to history  | Yes           |
| GET    | `/`      | Get scan history     | Yes           |

**Query Parameters (GET):**
- `filter` - Filter by health status: `all` (default), `healthy` (score ≥ 4), `unhealthy` (score ≤ 2)

---

## Gamification Routes

**File:** `gamificationRoutes.js`

**Base URL:** `/api/gamification`

### Endpoints

| Method | Endpoint | Description              | Auth Required |
|--------|----------|--------------------------|---------------|
| GET    | `/`      | Get user's gamification | Yes           |

---

## Dashboard Routes

**File:** `dashboardRoutes.js`

**Base URL:** `/api/dashboard`

### Endpoints

| Method | Endpoint | Description              | Auth Required |
|--------|----------|--------------------------|---------------|
| GET    | `/`      | Get user dashboard data | Yes           |

---

## Profile Routes

**File:** `profileRoutes.js`

**Base URL:** `/api/profile`

### Endpoints

| Method | Endpoint | Description           | Auth Required |
|--------|----------|----------------------|---------------|
| POST   | `/`      | Save user profile    | Yes           |
| GET    | `/`      | Get user profile    | Yes           |

---

## Sync Routes

**File:** `syncRoutes.js`

**Base URL:** `/api/sync`

### Endpoints

| Method | Endpoint | Description              | Auth Required |
|--------|----------|--------------------------|---------------|
| POST   | `/`      | Sync offline scan data   | Yes           |

---

## How to Test in Postman

### Global Setup

1. Open Postman
2. Create a new collection (e.g., "FitMax API")
3. Set base URL: `http://localhost:3000` (or your deployed URL)

### Testing Auth Endpoints

#### 1. Register User

- **Method:** POST
- **URL:** `{{baseURL}}/api/auth/register`
- **Headers:** `Content-Type: application/json`
- **Body (JSON):**
```json
{
  "email": "testuser@example.com",
  "password": "TestPassword123!",
  "age": 30,
  "weight": 75,
  "health_goal": "low-sugar",
  "dietary_preference": "vegetarian"
}
```

**Expected Response:**
```json
{
  "success": true,
  "message": "Account created successfully",
  "user": {
    "id": "user-uuid",
    "email": "testuser@example.com"
  },
  "modifiers": {
    "sugar_modifier": 1.5,
    "salt_modifier": 1,
    "fat_modifier": 1
  }
}
```

#### 2. Login User

- **Method:** POST
- **URL:** `{{baseURL}}/api/auth/login`
- **Headers:** `Content-Type: application/json`
- **Body (JSON):**
```json
{
  "email": "testuser@example.com",
  "password": "TestPassword123!"
}
```

**Expected Response:**
```json
{
  "success": true,
  "access_token": "jwt-token-here",
  "user": {
    "id": "user-uuid",
    "email": "testuser@example.com"
  }
}
```

**Note:** Save the `access_token` for authenticated endpoints.

### Testing Product Endpoints

#### 3. Get Product (Guest)

- **Method:** GET
- **URL:** `{{baseURL}}/api/product/5000159484695`
- **Headers:** None required

**Expected Response:**
```json
{
  "success": true,
  "source": "open_food_facts",
  "product": {
    "barcode": "5000159484695",
    "name": "Barrett's P准",
    "brand": "Cadbury",
    "category": "Chocolate",
    "image_url": "https://...",
    "nutrients": {
      "sugar": 56,
      "salt": 0.2,
      "saturated_fat": 10,
      "fiber": 2,
      "calories": 520
    },
    "score": 2,
    "score_color": "red",
    "warnings": ["⚠ High sugar may increase risk of obesity and diabetes."],
    "alternatives": [...]
  }
}
```

#### 4. Get Product (Authenticated)

- **Method:** GET
- **URL:** `{{baseURL}}/api/product/5000159484695`
- **Headers:** 
  - `Authorization: Bearer {{access_token}}`

### Testing History Endpoints

#### 5. Save Scan

- **Method:** POST
- **URL:** `{{baseURL}}/api/history`
- **Headers:** 
  - `Content-Type: application/json`
  - `Authorization: Bearer {{access_token}}`
- **Body (JSON):**
```json
{
  "barcode": "5000159484695",
  "score": 3
}
```

**Expected Response:**
```json
{
  "success": true,
  "gamification": {
    "total_points": 10,
    "current_streak": 1,
    "longest_streak": 1,
    "healthy_percentage": 50
  }
}
```

#### 6. Get History

- **Method:** GET
- **URL:** `{{baseURL}}/api/history?filter=all`
- **Headers:** 
  - `Authorization: Bearer {{access_token}}`

**Optional Query:** `?filter=healthy` or `?filter=unhealthy`

**Expected Response:**
```json
{
  "success": true,
  "history": [
    {
      "id": 1,
      "score": 3,
      "scanned_at": "2024-01-15T10:30:00Z",
      "products": {
        "barcode": "5000159484695",
        "name": "Cadbury Chocolate",
        "brand": "Cadbury",
        "category": "Chocolate",
        "image_url": "https://..."
      }
    }
  ]
}
```

### Testing Dashboard Endpoints

#### 7. Get Dashboard

- **Method:** GET
- **URL:** `{{baseURL}}/api/dashboard`
- **Headers:** 
  - `Authorization: Bearer {{access_token}}`

**Expected Response:**
```json
{
  "success": true,
  "dashboard": {
    "total_scans": 10,
    "healthy_scans": 7,
    "healthy_percentage": 70,
    "current_streak": 3,
    "longest_streak": 5,
    "total_points": 85
  }
}
```

### Testing Profile Endpoints

#### 8. Save Profile

- **Method:** POST
- **URL:** `{{baseURL}}/api/profile`
- **Headers:** 
  - `Content-Type: application/json`
  - `Authorization: Bearer {{access_token}}`
- **Body (JSON):**
```json
{
  "age": 28,
  "weight": 70,
  "health_goal": "heart-health",
  "dietary_preference": "vegan"
}
```

**Expected Response:**
```json
{
  "success": true,
  "message": "Profile saved",
  "modifiers": {
    "sugar_modifier": 1,
    "salt_modifier": 1,
    "fat_modifier": 1.5
  }
}
```

#### 9. Get Profile

- **Method:** GET
- **URL:** `{{baseURL}}/api/profile`
- **Headers:** 
  - `Authorization: Bearer {{access_token}}`

**Expected Response:**
```json
{
  "success": true,
  "profile": {
    "user_id": "user-uuid",
    "age": 28,
    "weight": 70,
    "health_goal": "heart-health",
    "dietary_preference": "vegan",
    "sugar_modifier": 1,
    "salt_modifier": 1,
    "fat_modifier": 1.5
  }
}
```

### Testing Gamification Endpoints

#### 10. Get Gamification

- **Method:** GET
- **URL:** `{{baseURL}}/api/gamification`
- **Headers:** 
  - `Authorization: Bearer {{access_token}}`

**Expected Response:**
```json
{
  "success": true,
  "gamification": {
    "user_id": "user-uuid",
    "total_points": 85,
    "current_streak": 3,
    "longest_streak": 5,
    "healthy_percentage": 70,
    "badges": [
      { "id": "centurion", "label": "💯 Centurion", "description": "Earned 100 points" }
    ]
  }
}
```

### Testing Sync Endpoints

#### 11. Sync Offline Data

- **Method:** POST
- **URL:** `{{baseURL}}/api/sync`
- **Headers:** 
  - `Content-Type: application/json`
  - `Authorization: Bearer {{access_token}}`
- **Body (JSON):**
```json
{
  "localScans": [
    {
      "barcode": "5000159484695",
      "score": 4,
      "date": "2024-01-10"
    },
    {
      "barcode": "4006381333931",
      "score": 2,
      "date": "2024-01-11"
    }
  ],
  "localGamification": {
    "points": 25,
    "streak": 2
  }
}
```

**Expected Response:**
```json
{
  "success": true,
  "message": "Synced 2 new scans"
}
```

---

## Sample Barcodes for Testing

| Barcode         | Product Name        | Category     |
|----------------|-------------------|--------------|
| 5000159484695  | Cadbury Dairy Milk | Chocolate   |
| 4006381333931  | Haribo Goldbears | Candy       |
| 7622210449283  | Oreo Cookies     | Snacks      |
| 8076809513753  | Barilla Pasta    | Pasta       |

---

## Environment Variables

For testing, ensure you have:

```
SUPABASE_URL=your_supabase_url
SUPABASE_KEY=your_supabase_anon_key
PORT=3000
