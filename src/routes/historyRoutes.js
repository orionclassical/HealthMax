const express = require('express');
const router = express.Router();
const { saveScan, getHistory, getScanDetail, archiveScan, restoreScan } = require('../controllers/historyController');
const { authenticate } = require('../middleware/authMiddleware');

router.post('/', authenticate, saveScan);
router.get('/', authenticate, getHistory);
router.get('/:scanId', authenticate, getScanDetail);
router.patch('/:scanId/archive', authenticate, archiveScan);
router.patch('/:scanId/restore', authenticate, restoreScan);

module.exports = router;