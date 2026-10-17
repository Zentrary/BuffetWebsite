// Import session workflow models and timing configuration.
const Table = require('../models/Table');
const Session = require('../models/Session');
const {
  canRequestCheckout,
  canResumeDining,
} = require('../utils/sessionLifecycle');
const { confirmQueue } = require('./queueController');

/**
 * Start a dine-in session for a called queue and its reserved table.
 * @param {import('express').Request} req - Request containing queueId.
 * @param {import('express').Response} res - HTTP response.
 * @returns {Promise<import('express').Response>} JSON response with session ID and end time.
 */
async function startSession(req, res) {
  req.params.id = req.body && req.body.queueId;
  req.get = req.get || (() => '');
  return confirmQueue(req, res);
}

/**
 * Retrieve a session and populate its queue and table.
 * @param {import('express').Request} req - Request with sessionId or id in route params.
 * @param {import('express').Response} res - HTTP response.
 * @returns {Promise<import('express').Response>} JSON response with the session.
 */
async function getSession(req, res) {
  try {
    const session = await Session.findById(req.params.sessionId || req.params.id)
      .populate('tableId')
      .populate('queueId');
    if (!session) {
      return res.status(404).json({ success: false, code: 'SESSION_NOT_FOUND', data: null, message: 'Session not found.' });
    }
    return res.status(200).json({ success: true, data: session, message: 'ดึงข้อมูลเซสชันสำเร็จ' });
  } catch (error) {
    console.error('Get session failed:', error);
    const status = error.name === 'CastError' ? 400 : 500;
    return res.status(status).json({
      success: false,
      code: 'REQUEST_FAILED',
      data: null,
      message: status === 400 ? 'รูปแบบ ID ไม่ถูกต้อง' : 'เกิดข้อผิดพลาดในระบบ',
    });
  }
}

/**
 * List sessions, filtered by status for staff checkout selection.
 * @param {import('express').Request} req - Request with an optional status query.
 * @param {import('express').Response} res - HTTP response.
 * @returns {Promise<import('express').Response>} JSON response containing matching sessions.
 */
async function getSessions(req, res) {
  try {
    const filter = req.query.status === 'active'
      ? { $or: [{ status: 'active' }, { status: 'expired', isPaid: false }] }
      : (req.query.status ? { status: req.query.status } : {});
    const sessions = await Session.find(filter)
      .populate('tableId', 'tableNumber zone')
      .populate('queueId', 'queueNumber customerName')
      .sort({ startTime: -1 })
      .limit(200);
    return res.status(200).json({ success: true, data: sessions, message: 'ดึงรายการเซสชันสำเร็จ' });
  } catch (error) {
    console.error('Get sessions failed:', error);
    return res.status(500).json({ success: false, code: 'REQUEST_FAILED', data: null, message: 'Request failed.' });
  }
}

/**
 * Reject legacy session-end requests that would bypass checkout and payment.
 * @param {import('express').Request} req - Authenticated staff request.
 * @param {import('express').Response} res - HTTP response.
 * @returns {Promise<import('express').Response>} Conflict response explaining the required workflow.
 */
async function endSession(req, res) {
  return res.status(409).json({
    success: false,
    code: 'PAYMENT_REQUIRED',
    data: null,
    message: 'ไม่สามารถจบเซสชันหรือคืนโต๊ะได้ก่อนลูกค้ายืนยันจบมื้อและบันทึกการชำระเงิน',
  });
}

async function requestCheckout(req, res) {
  try {
    const session = await Session.findById(req.params.id);
    if (!session) {
      return res.status(404).json({ success: false, code: 'SESSION_NOT_FOUND', data: null, message: 'ไม่พบรอบรับประทานนี้' });
    }
    if (!await Table.exists({ _id: session.tableId, status: 'occupied', currentSessionId: session._id })) {
      return res.status(409).json({ success: false, code: 'SESSION_NOT_SEATED', data: null, message: 'กรุณายืนยันที่นั่งกับพนักงานก่อนจบมื้อ' });
    }
    if (session.checkoutRequestedAt && !session.isPaid) {
      return res.status(200).json({ success: true, data: session, message: 'แจ้งจบมื้อแล้ว กรุณาชำระเงินที่เคาน์เตอร์' });
    }
    if (!canRequestCheckout(session)) {
      return res.status(409).json({
        success: false,
        code: session.isPaid ? 'SESSION_ALREADY_PAID' : 'SESSION_NOT_ACTIVE',
        data: null,
        message: session.isPaid ? 'รอบรับประทานนี้ชำระเงินแล้ว' : 'ไม่สามารถแจ้งจบมื้อของรอบนี้ได้',
      });
    }

    const io = req.app.get('io');
    const table = io ? await Table.findById(session.tableId).select('tableNumber') : null;
    const requestedAt = new Date();
    const updatedSession = await Session.findOneAndUpdate(
      { _id: session._id, isPaid: false, status: { $in: ['active', 'expired'] }, checkoutRequestedAt: null },
      { $set: { checkoutRequestedAt: requestedAt } },
      { new: true }
    );
    if (!updatedSession) {
      const currentSession = await Session.findById(session._id);
      if (currentSession && currentSession.checkoutRequestedAt && !currentSession.isPaid) {
        return res.status(200).json({ success: true, data: currentSession, message: 'แจ้งจบมื้อแล้ว กรุณาชำระเงินที่เคาน์เตอร์' });
      }
      return res.status(409).json({ success: false, code: 'SESSION_NOT_ACTIVE', data: null, message: 'สถานะรอบรับประทานเปลี่ยนไป กรุณาโหลดหน้าใหม่' });
    }

    if (io) {
      io.to('admin').to('waiter').emit('checkout_requested', {
        sessionId: updatedSession._id,
        tableNumber: table && table.tableNumber,
        requestedAt: requestedAt.toISOString(),
      });
    }
    return res.status(200).json({ success: true, data: updatedSession, message: 'แจ้งจบมื้อแล้ว กรุณาชำระเงินที่เคาน์เตอร์' });
  } catch (error) {
    console.error('Request checkout failed:', error);
    const status = error.name === 'CastError' ? 400 : 500;
    return res.status(status).json({
      success: false,
      code: status === 400 ? 'INVALID_SESSION_ID' : 'REQUEST_FAILED',
      data: null,
      message: status === 400 ? 'รูปแบบรอบรับประทานไม่ถูกต้อง' : 'ไม่สามารถแจ้งจบมื้อได้ กรุณาลองอีกครั้ง',
    });
  }
}

async function resumeDining(req, res) {
  try {
    const session = await Session.findById(req.params.id);
    if (!session) {
      return res.status(404).json({ success: false, code: 'SESSION_NOT_FOUND', data: null, message: 'ไม่พบรอบรับประทานนี้' });
    }
    if (!await Table.exists({ _id: session.tableId, status: 'occupied', currentSessionId: session._id })) {
      return res.status(409).json({ success: false, code: 'SESSION_NOT_SEATED', data: null, message: 'กรุณายืนยันที่นั่งกับพนักงานก่อนดำเนินการต่อ' });
    }
    if (!canResumeDining(session)) {
      return res.status(409).json({
        success: false,
        code: session.isPaid ? 'SESSION_ALREADY_PAID' : 'SESSION_EXPIRED',
        data: null,
        message: 'ไม่สามารถกลับไปรับประทานต่อได้ เวลาหมดหรือมีการชำระเงินแล้ว',
      });
    }

    const updatedSession = await Session.findOneAndUpdate(
      { _id: session._id, status: 'active', isPaid: false, checkoutRequestedAt: session.checkoutRequestedAt, endTime: { $gt: new Date() } },
      { $unset: { checkoutRequestedAt: 1 } },
      { new: true }
    );
    if (!updatedSession) {
      return res.status(409).json({ success: false, code: 'SESSION_EXPIRED', data: null, message: 'เวลารับประทานหมดแล้ว ไม่สามารถกลับไปรับประทานต่อได้' });
    }
    return res.status(200).json({ success: true, data: updatedSession, message: 'กลับไปรับประทานต่อได้' });
  } catch (error) {
    console.error('Resume dining failed:', error);
    const status = error.name === 'CastError' ? 400 : 500;
    return res.status(status).json({
      success: false,
      code: status === 400 ? 'INVALID_SESSION_ID' : 'REQUEST_FAILED',
      data: null,
      message: status === 400 ? 'รูปแบบรอบรับประทานไม่ถูกต้อง' : 'ไม่สามารถกลับไปรับประทานต่อได้ กรุณาลองอีกครั้ง',
    });
  }
}

/**
 * Mark active sessions whose end time has passed as expired.
 * @param {import('express').Request} req - HTTP request.
 * @param {import('express').Response} res - HTTP response.
 * @returns {Promise<import('express').Response>} JSON response with expired session records.
 */
async function checkExpiredSessions(req, res) {
  try {
    const now = new Date();
    const expiredSessions = await Session.find({
      status: 'active',
      endTime: { $lte: now },
    });
    const ids = expiredSessions.map((session) => session._id);

    if (ids.length > 0) {
      await Session.updateMany(
        { _id: { $in: ids }, status: 'active' },
        { $set: { status: 'expired', actualEndTime: now } }
      );
    }

    return res.status(200).json({
      success: true,
      data: { count: ids.length, sessions: expiredSessions },
      message: 'ตรวจสอบเซสชันหมดเวลาสำเร็จ',
    });
  } catch (error) {
    console.error('Check expired sessions failed:', error);
    return res.status(500).json({ success: false, code: 'REQUEST_FAILED', data: null, message: 'Request failed.' });
  }
}

// Export session lifecycle handlers for route registration.
module.exports = {
  startSession,
  getSession,
  getSessions,
  endSession,
  requestCheckout,
  resumeDining,
  checkExpiredSessions,
};
