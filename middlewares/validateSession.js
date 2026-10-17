// Import the Session model used to validate a dine-in session.
const Session = require('../models/Session');
const Table = require('../models/Table');

/**
 * Ensure the session identified in the request exists and is still active.
 * @param {import('express').Request} req - Incoming HTTP request.
 * @param {import('express').Response} res - HTTP response.
 * @param {import('express').NextFunction} next - Express next middleware.
 * @returns {Promise<void>} Sends an error response or continues with req.session set.
 */
function validateSession({ allowExpired = false } = {}) {
  return async function validateSessionRequest(req, res, next) {
    const sessionId = (req.body && req.body.sessionId) || req.params.sessionId;

    if (!sessionId) {
      return res.status(404).json({ message: 'ไม่พบเซสชัน' });
    }

    try {
      const session = await Session.findById(sessionId);

      if (!session) {
        return res.status(404).json({ message: 'ไม่พบเซสชัน' });
      }

      const isExpired = session.status === 'expired' || new Date() > session.endTime;
      if (session.status !== 'active' && !(allowExpired && session.status === 'expired')) {
        return res.status(400).json({ message: 'เซสชันนี้สิ้นสุดแล้ว' });
      }
      if (session.isPaid) {
        return res.status(409).json({
          success: false,
          code: 'SESSION_ALREADY_PAID',
          data: null,
          message: 'เซสชันนี้ชำระเงินแล้ว',
        });
      }

      const table = await Table.findOne({
        _id: session.tableId,
        status: 'occupied',
        currentSessionId: session._id,
      });
      if (!table) {
        return res.status(409).json({
          success: false,
          code: 'SESSION_NOT_SEATED',
          data: null,
          message: 'กรุณายืนยันที่นั่งกับพนักงานก่อนสั่งอาหารหรือชำระเงิน',
        });
      }

      if (isExpired && session.status === 'active') {
        if (!allowExpired) {
          session.status = 'expired';
          await session.save();
          return res.status(400).json({ message: 'หมดเวลา' });
        }
        session.status = 'expired';
        session.actualEndTime = session.actualEndTime || new Date();
        await session.save();
      }

      req.session = session;
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

// Export middleware for routes that require an active dine-in session.
module.exports = validateSession;
