// Import Express routing, authentication middleware, and auth handlers.
const express = require('express');
const { protect, authorize } = require('../middlewares/authMiddleware');
const authController = require('../controllers/authController');
const { rateLimit, keyByIp } = require('../middlewares/rateLimit');

const router = express.Router();

// Staff login — strict IP limit to slow credential guessing.
router.post(
  '/login',
  rateLimit({
    name: 'auth-login',
    windowMs: 15 * 60_000,
    max: 5,
    keyGenerator: keyByIp,
    message: 'เข้าสู่ระบบผิดหลายครั้งเกินไป กรุณารอ 15 นาทีแล้วลองใหม่',
  }),
  authController.login
);

// Current staff profile.
router.get('/me', protect, authController.getMe);

// Register new staff — admin only.
router.post('/register', protect, authorize('admin'), authController.register);

// List staff — admin only.
router.get('/staff', protect, authorize('admin'), authController.getStaff);

// Update staff — admin only.
router.put('/staff/:id', protect, authorize('admin'), authController.updateStaff);

// Delete staff — admin only.
router.delete('/staff/:id', protect, authorize('admin'), authController.deleteStaff);

module.exports = router;