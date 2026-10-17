// Import Express routing, role middleware, and menu handlers.
const express = require('express');
const { protect, authorize } = require('../middlewares/authMiddleware');
const menuController = require('../controllers/menuController');
const uploadImage = require('../middlewares/uploadImage');

const router = express.Router();

// List menus, optionally filtered by category and availability.
router.get('/', menuController.getAllMenus);

// Retrieve one menu item by its identifier.
router.get('/:id', menuController.getMenuById);

// Add a menu item; administrators and managers are permitted.
router.post('/', protect, authorize('admin', 'manager'), menuController.createMenu);
router.post('/image', protect, authorize('admin', 'manager'), uploadImage.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, code: 'INVALID_IMAGE', message: 'รองรับเฉพาะ JPG, PNG, WEBP หรือ GIF ขนาดไม่เกิน 5 MB' });
  return res.status(201).json({ success: true, data: { imageUrl: `/uploads/${req.file.filename}` } });
});

// Update a menu item; administrators and managers are permitted.
router.put('/:id', protect, authorize('admin', 'manager'), menuController.updateMenu);

// Delete a menu item; only administrators are permitted.
router.delete('/:id', protect, authorize('admin'), menuController.deleteMenu);

// Toggle menu availability; admins, managers, and kitchen staff are permitted.
router.put(
  '/:id/availability',
  protect,
  authorize('admin', 'manager', 'kitchen'),
  menuController.toggleAvailability
);

// Export the menu router for mounting at /api/menu.
module.exports = router;
