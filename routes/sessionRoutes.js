// Import Express routing, authentication middleware, and session handlers.
const express = require('express');
const { protect, authorize } = require('../middlewares/authMiddleware');
const sessionController = require('../controllers/sessionController');

const router = express.Router();

// Start a session for a queue that has already been called.
router.post('/start', sessionController.startSession);

// List sessions for staff, optionally filtered by status.
router.get('/', protect, authorize('admin', 'manager', 'waiter'), sessionController.getSessions);

// Retrieve session details, including its table and queue.
router.get('/:id', sessionController.getSession);

// Record the customer's explicit request to finish the meal and pay.
router.post('/:id/checkout', sessionController.requestCheckout);

// Allow the customer to resume only while the session remains active and unpaid.
router.post('/:id/resume', sessionController.resumeDining);

// Retained for compatibility; a staff request cannot end an unpaid dining session.
router.post('/end', protect, authorize('admin'), sessionController.endSession);

// Export the session router for mounting at /api/session.
module.exports = router;
