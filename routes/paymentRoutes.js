// Import Express routing, payment authorization, and active-session validation.
const express = require('express');
const { protect, authorize } = require('../middlewares/authMiddleware');
const validateSession = require('../middlewares/validateSession');
const paymentController = require('../controllers/paymentController');

const router = express.Router();

// Calculate a bill only for an active session.
router.post('/calculate', validateSession({ allowExpired: true }), paymentController.calculateBill);

// Process a payment; administrators and waiters are permitted.
router.post('/process', protect, authorize('admin', 'manager', 'waiter'), paymentController.processPayment);

// List unpaid active or expired sessions for staff checkout cards.
router.get('/sessions', protect, authorize('admin', 'manager', 'waiter'), paymentController.getPaymentSessions);

// Retrieve payment history; only administrators may access it.
router.get('/history', protect, authorize('admin'), paymentController.getPaymentHistory);

router.post(
  '/confirm-qr/:paymentId',
  protect,
  authorize('admin', 'manager', 'waiter'),
  paymentController.confirmQrPayment
);

// Export the payment router for mounting at /api/payment.
module.exports = router;
