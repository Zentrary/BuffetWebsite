const express = require('express');
const { protect, authorize } = require('../middlewares/authMiddleware');
const settingsController = require('../controllers/settingsController');
const uploadImage = require('../middlewares/uploadImage');

const router = express.Router();
router.get('/public', settingsController.getPublicSettings);
router.get('/shop', protect, authorize('admin'), settingsController.getSettings);
router.put('/shop', protect, authorize('admin'), settingsController.updateSettings);
router.post('/shop/open', protect, authorize('admin'), settingsController.openShopEarly);
router.post('/shop/image', protect, authorize('admin'), uploadImage.single('image'), settingsController.uploadShopImage);
router.get('/favicon', settingsController.getFavicon);
exports.getFavicon = async (req, res) => {
  try {
    const settings = await Settings.findOne().lean();
    const target = (settings && (settings.logoUrl || settings.logo)) || '/assets/images/favicon.png';
    res.redirect(302, target);
  } catch (error) {
    res.redirect(302, '/assets/images/favicon.png');
  }
};
module.exports = router;
