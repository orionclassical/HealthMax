const express = require('express');
const router = express.Router();
const { getProduct } = require('../controllers/productController');
const { authenticate } = require('../middleware/authMiddleware');

// Auth is optional — works for guest too
router.get('/:barcode', async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader) {
    authenticate(req, res, () => getProduct(req, res));
  } else {
    req.user = null;
    getProduct(req, res);
  }
});

module.exports = router;