# Services Documentation

This folder contains all the business logic services for the FitMax backend API. Services contain pure functions and logic that can be used by controllers.

## Table of Contents

- [Scoring Service](#scoring-service)
- [Personalization Service](#personalization-service)
- [Gamification Service](#gamification-service)
- [Alternative Service](#alternative-service)

---

## Scoring Service

**File:** `scoringService.js`

### What the Code Does

1. **Calculate Score:**
   - Calculates health score from 1-5 based on nutrient values
   - Applies personalization modifiers for user-specific scoring
   - Penalizes high sugar, salt, and saturated fat
   - Rewards high fiber content

2. **Generate Warnings:**
   - Generates health warnings based on nutrient levels
   - Considers personalization modifiers
   - Provides actionable health advice

3. **Get Score Color:**
   - Maps numeric score to color: red (1-2), yellow (3), green (4-5)
   - Used for UI display

### Score Calculation Logic

| Condition                  | Score Change |
|---------------------------|--------------|
| Sugar > 15g (per 100g)    | -2           |
| Sugar > 5g (per 100g)     | -1           |
| Salt > 1g (per 100g)      | -2           |
| Salt > 0.5g (per 100g)    | -1           |
| Saturated Fat > 10g       | -2           |
| Saturated Fat > 3g       | -1           |
| Fiber ≥ 3g                | +1           |
| Fiber < 1g                | -1           |

### Key Functions

| Function           | Description                          |
|--------------------|-------------------------------------|
| `calculateScore`   | Calculate health score 1-5         |
| `generateWarnings`| Generate health warnings            |
| `getScoreColor`    | Get color for score (red/yellow/green) |

### Parameters

```javascript
// calculateScore(nutrients, modifiers)
nutrients = {
  sugar: number,        // grams per 100g
  salt: number,        // grams per 100g
  saturated_fat: number, // grams per 100g
  fiber: number        // grams per 100g
}

modifiers = {
  sugar_modifier: number,  // default: 1
  salt_modifier: number,   // default: 1
  fat_modifier: number     // default: 1
}
```

---

## Personalization Service

**File:** `personalizationService.js`

### What the Code Does

1. **Goal to Modifiers:**
   - Converts user health goals into scoring modifiers
   - Adjusts how nutrients are scored based on health goals

2. **Build Modifiers:**
   - Extracts modifiers from user profile
   - Returns default values if not set

### Health Goal Mappings

| Health Goal            | Sugar Modifier | Salt Modifier | Fat Modifier |
|----------------------|----------------|----------------|--------------|
| `low-sugar`          | 1.5            | 1              | 1            |
| `diabetic-friendly` | 2.0            | 1              | 1            |
| `low-salt`           | 1              | 1.5            | 1            |
| `hypertension`      | 1              | 1.5            | 1            |
| `heart-health`      | 1              | 1              | 1.5          |
| `low-fat`           | 1              | 1              | 1.5          |
| Default              | 1              | 1              | 1            |

### Key Functions

| Function          | Description                          |
|-------------------|-------------------------------------|
| `goalToModifiers` | Convert health goal to modifiers    |
| `buildModifiers`  | Build modifiers from user profile   |

---

## Gamification Service

**File:** `gamificationService.js`

### What the Code Does

1. **Update Gamification:**
   - Updates points based on scan score
   - Rewards: 10 points (score ≥ 4), 5 points (score = 3)
   - Tracks daily scanning streaks
   - Calculates healthy scan percentage
   - Updates last scan date

2. **Streak Logic:**
   - If scanned yesterday → increment streak
   - If scanned today → maintain streak
   - Otherwise → reset streak to 1
   - Updates longest streak if current > longest

### Points System

| Scan Score | Points Awarded |
|-----------|---------------|
| 5         | +10           |
| 4         | +10           |
| 3         | +5            |
| 2         | 0             |
| 1         | 0             |

### Key Functions

| Function           | Description                          |
|--------------------|-------------------------------------|
| `updateGamification` | Update gamification after scan       |

### Parameters

```javascript
// updateGamification(userId, score)
userId = "user-uuid"  // Supabase user ID
score = 4             // 1-5
```

---

## Alternative Service

**File:** `alternativeService.js`

### What the Code Does

1. **Get Alternatives:**
   - Finds healthier alternatives in same product category
   - Returns top 3 products with higher base scores
   - Excludes current product from results

### Key Functions

| Function        | Description                          |
|-----------------|-------------------------------------|
| `getAlternatives` | Get healthier product alternatives |

### Parameters

```javascript
// getAlternatives(category, currentScore, currentBarcode)
category = "Chocolate"    // Product category
currentScore = 2        // Current product score
currentBarcode = "..."   // Current product barcode
```

### Return Value

```javascript
[
  {
    "barcode": "...",
    "name": "Healthier Product",
    "brand": "Brand Name",
    "base_score": 4,
    "image_url": "https://..."
  }
]
```

---

## How to Test in Postman

These services are tested indirectly through the API endpoints. Here's how to verify each service's behavior:

### Test Scoring Service

1. Scan different products with varying nutrient levels
2. Compare scores:

| Product Type       | Expected Score |
|-------------------|----------------|
| Fresh fruit       | 4-5            |
| Processed snack   | 1-2            |
| Healthy cereal   | 3-4            |

### Test Personalization Service

1. Register with different health goals
2. Scan same product with different goals
3. Compare personalized scores:

```json
// Goal: low-sugar
{
  "score": 3
}

// Goal: default (no health goal)
{
  "score": 4
}
```

### Test Gamification Service

1. Make scans on consecutive days
2. Check streak incrementing

```json
// Day 1
{
  "current_streak": 1,
  "total_points": 10
}

// Day 2 (consecutive)
{
  "current_streak": 2,
  "total_points": 20
}
```

### Test Alternative Service

1. Scan a product with low score
2. Check alternatives in response:

```json
{
  "product": {
    "name": "Chocolate Bar",
    "score": 2
  },
  "alternatives": [
    {
      "name": "Dark Chocolate 70%",
      "base_score": 4
    }
  ]
}
```

---

## Dependencies

These services are decoupled from Supabase controllers and can be tested independently:

- **scoringService** - Pure JavaScript, no external dependencies
- **personalizationService** - Pure JavaScript, no external dependencies
- **gamificationService** - Uses Supabase client
- **alternativeService** - Uses Supabase client

---

## Notes for Testing

1. Use valid barcodes from Open Food Facts database
2. Test edge cases:
   - Very high nutrient values
   - Zero nutrients
   - Missing nutrient data
3. Test personalization with all health goals
4. Test streak logic across date boundaries
5. Verify badge unlocking thresholds
