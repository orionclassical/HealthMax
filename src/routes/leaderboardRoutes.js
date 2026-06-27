// routes/leaderboardRoutes.js
const express = require('express');
const router = express.Router();
const { getLeaderboard } = require('../controllers/leaderboardController');
const { authenticate } = require('../middleware/authMiddleware');

router.get('/', authenticate, getLeaderboard);

module.exports = router;