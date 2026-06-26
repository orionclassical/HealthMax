# Middleware Documentation

This folder contains middleware functions for the FitMax backend API. Middleware functions intercept requests to add authentication, logging, or other functionality.

## Table of Contents

- [Auth Middleware](#auth-middleware)

---

## Auth Middleware

**File:** `authMiddleware.js`

### What the Code Does

1. **Extract Token:**
   - Reads Bearer token from Authorization header
   - Validates header format

2. **Verify Token:**
   - Uses Supabase auth to verify JWT token
   - Retrieves user from token
   - Attaches user to request object

3. **Error Handling:**
   - Returns 401 if no token provided
   - Returns 401 if token is invalid/expired

### Key Functions

| Function       | Description                          |
|-----------------|-------------------------------------|
| `authenticate`  | Authenticate JWT token             |

### Request Flow

```
Request → Auth Header → Extract Token → Verify with Supabase → Attach User → Next()
```

---

## How to Test in Postman

### Test 1: Missing Token (Should Fail)

- **Method:** GET
- **URL:** `/api/history`
- **Headers:** None

**Expected Response:**
```json
{
  "success": false,
  "message": "No token provided"
}
```

### Test 2: Invalid Token (Should Fail)

- **Method:** GET
- **URL:** `/api/history`
- **Headers:** 
  - `Authorization: Bearer invalid-token`

**Expected Response:**
```json
{
  "success": false,
  "message": "Invalid or expired token"
}
```

### Test 3: Valid Token (Should Pass)

- **Method:** GET
- **URL:** `/api/history`
- **Headers:** 
  - `Authorization: Bearer {{valid_access_token}}`

**Expected Response:**
```json
{
  "success": true,
  "history": [...]
}
```

---

## Protected Routes

The following routes require authentication via this middleware:

| Route               | File                   |
|--------------------|-----------------------|
| `/api/history`     | historyRoutes.js      |
| `/api/gamification`| gamificationRoutes.js |
| `/api/dashboard`   | dashboardRoutes.js   |
| `/api/profile`     | profileRoutes.js     |
| `/api/sync`        | syncRoutes.js        |

---

## Notes

- The `productRoutes.js` has optional authentication - it checks for auth header but continues if missing
- Auth middleware should be added before controller functions in route definitions
- The middleware attaches `req.user` containing the authenticated user's information
