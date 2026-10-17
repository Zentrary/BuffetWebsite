// Import Express routing, admin authorization, and feedback handlers.
const express = require('express');
const { protect, authorize } = require('../middlewares/authMiddleware');
const feedbackController = require('../controllers/feedbackController');
const { rateLimit, keyBySession, keyByIp } = require('../middlewares/rateLimit');

const router = express.Router();

// Submit feedback — 3 per hour per session.
router.post(
  '/',
  rateLimit({ name: 'feedback-create', windowMs: 60 * 60_000, max: 3, keyGenerator: keyBySession }),
  feedbackController.createFeedback
);

// List all feedback — admin only.
router.get('/', protect, authorize('admin'), feedbackController.getAllFeedbacks);

// Feedback for one session.
router.get(
  '/session/:sessionId',
  rateLimit({ name: 'feedback-read', windowMs: 60_000, max: 60, keyGenerator: keyByIp }),
  feedbackController.getFeedbackBySession
);

module.exports = router;