const express = require('express');
const router = express.Router();
const { getGamification } = require('../controllers/gamificationController');
const { authenticate } = require('../middleware/authMiddleware');

router.get('/', authenticate, getGamification);

module.exports = router;