// Import feedback and session models for feedback creation and lookup.
const Feedback = require('../models/Feedback');
const Session = require('../models/Session');

/**
 * Create feedback for a session and infer its table from the session when omitted.
 * @param {import('express').Request} req - Request containing sessionId, rating, and optional comment.
 * @param {import('express').Response} res - HTTP response.
 * @returns {Promise<import('express').Response>} JSON response with the new feedback.
 */
async function createFeedback(req, res) {
  try {
    const { sessionId, rating, comment } = req.body;
    const session = await Session.findById(sessionId);
    if (!session) {
      return res.status(404).json({ success: false, code: 'SESSION_NOT_FOUND', data: null, message: 'Session not found.' });
    }

    const feedback = await Feedback.create({
      sessionId: session._id,
      tableId: session.tableId,
      rating,
      comment,
    });
    return res.status(201).json({ success: true, data: feedback, message: 'ส่งความคิดเห็นสำเร็จ' });
  } catch (error) {
    console.error('Create feedback failed:', error);
    const status = error.name === 'CastError' || error.name === 'ValidationError' ? 400 : 500;
    return res.status(status).json({
      success: false,
      code: 'REQUEST_FAILED',
      data: null,
      message: status === 400 ? error.message : 'เกิดข้อผิดพลาดในระบบ',
    });
  }
}

/**
 * Retrieve all feedback entries; this endpoint must be mounted behind admin authorization.
 * @param {import('express').Request} req - Authenticated HTTP request.
 * @param {import('express').Response} res - HTTP response.
 * @returns {Promise<import('express').Response>} JSON response with all feedback.
 */
async function getAllFeedbacks(req, res) {
  try {
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({ success: false, code: 'FORBIDDEN', data: null, message: 'You are not allowed to perform this action.' });
    }
    const feedbacks = await Feedback.find()
      .populate('sessionId')
      .populate('tableId')
      .sort({ createdAt: -1 });
    return res.status(200).json({ success: true, data: feedbacks, message: 'ดึงรีวิวสำเร็จ' });
  } catch (error) {
    console.error('Get feedbacks failed:', error);
    return res.status(500).json({ success: false, code: 'REQUEST_FAILED', data: null, message: 'Request failed.' });
  }
}

/**
 * Retrieve feedback entries for a particular session.
 * @param {import('express').Request} req - Request with sessionId in params or query.
 * @param {import('express').Response} res - HTTP response.
 * @returns {Promise<import('express').Response>} JSON response with session feedback.
 */
async function getFeedbackBySession(req, res) {
  try {
    const sessionId = req.params.sessionId || req.query.sessionId;
    const feedbacks = await Feedback.find({ sessionId }).sort({ createdAt: -1 });
    return res.status(200).json({ success: true, data: feedbacks, message: 'ดึงรีวิวของเซสชันสำเร็จ' });
  } catch (error) {
    console.error('Get feedback by session failed:', error);
    const status = error.name === 'CastError' ? 400 : 500;
    return res.status(status).json({
      success: false,
      code: 'REQUEST_FAILED',
      data: null,
      message: status === 400 ? 'รูปแบบ ID ไม่ถูกต้อง' : 'เกิดข้อผิดพลาดในระบบ',
    });
  }
}

// Export feedback handlers for route registration.
module.exports = { createFeedback, getAllFeedbacks, getFeedbackBySession };
