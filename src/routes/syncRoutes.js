const express = require('express');
const router = express.Router();
const { syncOfflineData } = require('../controllers/syncController');
const { authenticate } = require('../middleware/authMiddleware');

router.post('/', authenticate, syncOfflineData);

module.exports = router;