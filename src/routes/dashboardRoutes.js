const express = require('express');
const router = express.Router();
const { getDashboard } = require('../controllers/dashboardController');
const { authenticate } = require('../middleware/authMiddleware');

router.get('/', authenticate, getDashboard);

module.exports = router;