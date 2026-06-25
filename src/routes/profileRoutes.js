const express = require('express');
const router = express.Router();
const { saveProfile, getProfile, getOptions } = require('../controllers/profileController');
const { authenticate } = require('../middleware/authMiddleware');
router.get('/options', authenticate, getOptions);
router.post('/', authenticate, saveProfile);
router.get('/', authenticate, getProfile);

module.exports = router;