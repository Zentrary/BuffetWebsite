// Import payment models and the shared billing calculation utility.
const Payment = require('../models/Payment');
const Order = require('../models/Order');
const Session = require('../models/Session');
const Table = require('../models/Table');
const { calculateTotal } = require('../utils/calculateBilling');
const { calculateCashChange } = require('../utils/calculateCashChange');
const { calculateOrderSubtotal } = require('../utils/calculateOrderSubtotal');
const { completeSeatedQueuesForSession } = require('../services/queueLifecycle');
const {
  evaluateBenefitForBill,
  settleSessionLoyalty,
} = require('../services/loyaltySqlService');
const {
  canCompletePayment,
  canTransitionTable,
} = require('../utils/sessionLifecycle');

function clampSessionDiscount(subtotal, discount) {
  const safeSubtotal = Math.max(0, Number(subtotal) || 0);
  const safeDiscount = Math.max(0, Number(discount) || 0);
  return Math.min(safeDiscount, safeSubtotal);
}

function buildSessionLoyaltyMeta(session) {
  if (!session || !session.memberId) return null;
  return {
    memberId: session.memberId,
    memberPhone: session.memberPhone || '',
    memberName: session.memberName || '',
    memberTierName: session.memberTierName || '',
    benefitType: session.benefitType || 'NONE',
    appliedPromotionId: session.appliedPromotionId || null,
    appliedPromoCode: session.appliedPromoCode || '',
    appliedPromoTitle: session.appliedPromoTitle || '',
    pointsToRedeem: Number(session.pointsToRedeem) || 0,
    pointsEarned: Number(session.pointsEarned) || 0,
  };
}

/**
 * Calculate and persist the current bill for a session.
 * @param {import('express').Request} req - Request with sessionId in body or params.
 * @param {import('express').Response} res - HTTP response.
 * @returns {Promise<import('express').Response>} JSON response with the billing breakdown.
 */
async function calculateBill(req, res) {
  try {
    const sessionId = req.body.sessionId || req.params.sessionId;
    const session = await Session.findById(sessionId);
    if (!session) {
      return res.status(404).json({ success: false, code: 'SESSION_NOT_FOUND', data: null, message: 'Session not found.' });
    }

    const orders = await Order.find({
      sessionId: session._id,
      status: { $ne: 'cancelled' },
    });
    const subtotal = calculateOrderSubtotal(orders);
    const bill = calculateTotal(subtotal, clampSessionDiscount(subtotal, session.discount));
    Object.assign(session, bill);
    await session.save();

    return res.status(200).json({
      success: true,
      data: { ...bill, loyalty: buildSessionLoyaltyMeta(session) },
      message: 'คำนวณยอดชำระสำเร็จ',
    });
  } catch (error) {
    console.error('Calculate bill failed:', error);
    const status = error.name === 'CastError' || error instanceof RangeError ? 400 : 500;
    return res.status(status).json({
      success: false,
      code: 'REQUEST_FAILED',
      data: null,
      message: status === 400 ? 'รูปแบบ ID ไม่ถูกต้อง' : 'เกิดข้อผิดพลาดในระบบ',
    });
  }
}

/**
 * Record a cash payment and mark its table for cleaning; QR requests remain pending.
 * @param {import('express').Request} req - Request containing sessionId and payment method.
 * @param {import('express').Response} res - HTTP response.
 * @returns {Promise<import('express').Response>} JSON response with the completed payment.
 */
async function processPayment(req, res) {
  try {
    const { sessionId, method = 'cash', receivedAmount } = req.body;
    if (!['cash', 'qr_payment'].includes(method)) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_PAYMENT_METHOD',
        data: null,
        message: 'รองรับเฉพาะเงินสดและ QR Payment',
      });
    }
    const session = await Session.findById(sessionId);
    if (!session) {
      return res.status(404).json({ success: false, code: 'SESSION_NOT_FOUND', data: null, message: 'Session not found.' });
    }
    if (session.isPaid) {
      return res.status(409).json({ success: false, code: 'SESSION_ALREADY_PAID', data: null, message: 'This session has already been paid.' });
    }
    if (!canCompletePayment(session)) {
      return res.status(409).json({
        success: false,
        code: 'CHECKOUT_CONFIRMATION_REQUIRED',
        data: null,
        message: 'กรุณารอให้ลูกค้ายืนยันจบมื้อก่อนรับชำระเงิน',
      });
    }

    const table = await Table.findOne({
      _id: session.tableId,
      status: 'occupied',
      currentSessionId: session._id,
    });
    if (!table || !canTransitionTable(table.status, 'cleaning', { isPaid: true })) {
      return res.status(409).json({
        success: false,
        code: 'TABLE_NOT_READY_FOR_PAYMENT',
        data: null,
        message: 'ไม่พบโต๊ะที่กำลังใช้งานในรอบนี้ กรุณาตรวจสอบสถานะโต๊ะก่อนรับชำระ',
      });
    }

    const orders = await Order.find({ sessionId: session._id, status: { $ne: 'cancelled' } });
    const subtotal = calculateOrderSubtotal(orders);
    Object.assign(session, calculateTotal(subtotal, clampSessionDiscount(subtotal, session.discount)));
    const now = new Date();
    const userId = req.user && (req.user.id || req.user._id);
    if (method === 'qr_payment') {
      const existingPendingPayment = await Payment.findOne({
        sessionId: session._id,
        method: 'qr_payment',
        status: 'pending',
      });
      if (existingPendingPayment) {
        if (existingPendingPayment.amount !== session.grandTotal) {
          existingPendingPayment.amount = session.grandTotal;
          await existingPendingPayment.save();
        }
        return res.status(202).json({
          success: true,
          data: existingPendingPayment,
          message: 'มีรายการ QR รอตรวจสอบอยู่แล้ว ยังไม่ถือว่าชำระเงินสำเร็จ',
        });
      }
      const pendingPayment = await Payment.create({
        sessionId: session._id,
        amount: session.grandTotal,
        method: 'qr_payment',
        status: 'pending',
        receivedBy: userId || undefined,
      });
      return res.status(202).json({
        success: true,
        data: pendingPayment,
        message: 'บันทึกรายการ QR เป็นรอตรวจสอบแล้ว ยังไม่ถือว่าชำระเงินสำเร็จ',
      });
    }
    const cashDetails = calculateCashChange(session.grandTotal, Number(receivedAmount));
    const previousStatus = session.status;
    const previousActualEndTime = session.actualEndTime;
    const paidSession = await Session.findOneAndUpdate(
      {
        _id: session._id,
        status: previousStatus,
        isPaid: false,
        checkoutRequestedAt: session.checkoutRequestedAt,
      },
      {
        $set: {
          isPaid: true,
          paidAt: now,
          status: 'completed',
          actualEndTime: session.actualEndTime || now,
          subtotal: session.subtotal,
          serviceCharge: session.serviceCharge,
          vat: session.vat,
          grandTotal: session.grandTotal,
        },
      },
      { new: true }
    );
    if (!paidSession) {
      return res.status(409).json({ success: false, code: 'SESSION_ALREADY_PAID', data: null, message: 'มีการเปลี่ยนแปลงสถานะรอบนี้ กรุณาโหลดข้อมูลใหม่' });
    }

    let payment;
    let tableWasMarkedForCleaning = false;
    let tableForCleaning;
    try {
      payment = await Payment.create({
        sessionId: paidSession._id,
        amount: paidSession.grandTotal,
        method,
        cashReceived: cashDetails.cashReceived,
        changeDue: cashDetails.changeDue,
        status: 'completed',
        paidAt: now,
        receivedBy: userId || undefined,
      });
      tableForCleaning = await Table.findOneAndUpdate(
        {
          _id: paidSession.tableId,
          status: 'occupied',
          currentSessionId: paidSession._id,
        },
        {
          $set: {
            status: 'cleaning',
            currentSessionId: null,
            reservedForQueueId: null,
            lastSessionId: paidSession._id,
          },
        },
        { new: true }
      );
      tableWasMarkedForCleaning = Boolean(tableForCleaning);
      if (!tableForCleaning || !canTransitionTable(table.status, 'cleaning', { isPaid: paidSession.isPaid })) {
        throw new Error('Table state changed before payment could be completed.');
      }
      await Payment.updateMany(
        { sessionId: paidSession._id, method: 'qr_payment', status: 'pending' },
        { $set: { status: 'failed' } }
      );
    } catch (error) {
      let rollbackFailed = false;
      if (tableWasMarkedForCleaning) {
        try {
          const restoredTable = await Table.updateOne(
            { _id: paidSession.tableId, status: 'cleaning', lastSessionId: paidSession._id },
            { $set: { status: 'occupied', currentSessionId: paidSession._id, lastSessionId: null } }
          );
          if (restoredTable.modifiedCount !== 1) rollbackFailed = true;
        } catch (rollbackError) {
          rollbackFailed = true;
          console.error('Payment table rollback failed:', rollbackError);
        }
      }
      if (payment) {
        try {
          await Payment.deleteOne({ _id: payment._id });
        } catch (rollbackError) {
          rollbackFailed = true;
          console.error('Payment record rollback failed:', rollbackError);
        }
      }
      try {
        const rollbackSet = {
          isPaid: false,
          status: previousStatus,
        };
        const rollbackUnset = { paidAt: 1 };
        if (previousActualEndTime) rollbackSet.actualEndTime = previousActualEndTime;
        else rollbackUnset.actualEndTime = 1;
        const rollback = await Session.updateOne(
          { _id: paidSession._id, isPaid: true, paidAt: now },
          {
            $set: rollbackSet,
            $unset: rollbackUnset,
          }
        );
        if (rollback.modifiedCount !== 1) rollbackFailed = true;
      } catch (rollbackError) {
        rollbackFailed = true;
        console.error('Payment session rollback failed:', rollbackError);
      }
      if (rollbackFailed) {
        console.error('Payment rollback was incomplete:', { sessionId: paidSession._id });
      }
      throw error;
    }

    // The meal is paid: close the seated queue so it leaves the staff board.
    try {
      await completeSeatedQueuesForSession(paidSession._id, { io: req.app.get('io'), reason: 'payment completed' });
    } catch (queueError) {
      console.error('Closing seated queue after payment failed:', queueError);
    }

    let loyalty = null;
    if (paidSession.memberId) {
      try {
        loyalty = await settleSessionLoyalty(paidSession, {
          username: (req.user && req.user.username) || 'staff',
        });
        if (loyalty && !loyalty.alreadySettled) {
          await Session.updateOne(
            { _id: paidSession._id },
            {
              $set: {
                pointsEarned: loyalty.pointsEarned || 0,
                loyaltyProcessedAt: new Date(),
                memberTierName: (loyalty.member && loyalty.member.tierName) || paidSession.memberTierName,
              },
            }
          );
        }
      } catch (loyaltyError) {
        console.error('SQL loyalty settlement after cash payment failed:', loyaltyError.message);
      }
    }

    const io = req.app.get('io');
    if (io) {
      const event = { payment, sessionId: session._id, amount: payment.amount, loyalty };
      io.to('admin').emit('payment_completed', event);
      // Notify the customer's own room so the browser can redirect to feedback.
      io.to(`customer_${session._id}`).emit('payment_completed', event);
      io.to('admin').to('waiter').emit('table_waiting_for_cleaning', {
        table: tableForCleaning,
        sessionId: session._id,
      });
    }
    return res.status(201).json({ success: true, data: payment, loyalty, message: 'บันทึกการชำระเงินสำเร็จ' });
  } catch (error) {
    const status = error.name === 'CastError'
      || error.name === 'ValidationError'
      || error instanceof RangeError
      ? 400
      : 500;
    if (status === 500) console.error('Process payment failed:', error);
    return res.status(status).json({
      success: false,
      code: error.code || 'REQUEST_FAILED',
      data: null,
      message: status === 400 ? error.message : 'เกิดข้อผิดพลาดในระบบ',
    });
  }
}

/**
 * Return unpaid sessions and itemized bill summaries for the staff checkout board.
 * @param {import('express').Request} req - Authenticated staff request.
 * @param {import('express').Response} res - HTTP response.
 * @returns {Promise<import('express').Response>} Session cards with current bill totals.
 */
async function getPaymentSessions(req, res) {
  try {
    const sessions = await Session.find({
      status: { $in: ['active', 'expired'] },
      isPaid: false,
    })
      .populate('tableId', 'tableNumber zone')
      .populate('queueId', 'queueNumber customerName customerPhone')
      .sort({ startTime: -1 })
      .limit(200);
    const sessionIds = sessions.map((session) => session._id);
    const orders = sessionIds.length
      ? await Order.find({ sessionId: { $in: sessionIds }, status: { $ne: 'cancelled' } })
        .select('sessionId items')
        .lean()
      : [];
    const pendingPayments = sessionIds.length
      ? await Payment.find({
        sessionId: { $in: sessionIds },
        method: 'qr_payment',
        status: 'pending',
      }).select('sessionId amount createdAt').lean()
      : [];
    const ordersBySession = new Map();
    const pendingBySession = new Map(pendingPayments.map((payment) => [String(payment.sessionId), payment]));
    for (const order of orders) {
      const sessionId = String(order.sessionId);
      const currentOrders = ordersBySession.get(sessionId) || [];
      currentOrders.push(order);
      ordersBySession.set(sessionId, currentOrders);
    }
    const data = sessions.map((session) => {
      const sessionOrders = ordersBySession.get(String(session._id)) || [];
      const itemsByMenu = new Map();
      for (const order of sessionOrders) {
        for (const item of order.items || []) {
          if (item.itemStatus === 'cancelled') continue;
          const menuKey = String(item.menuId || item.name);
          const current = itemsByMenu.get(menuKey) || {
            name: item.name,
            quantity: 0,
            price: Number(item.price) || 0,
          };
          current.quantity += Number(item.quantity) || 0;
          itemsByMenu.set(menuKey, current);
        }
      }
      const items = [...itemsByMenu.values()];
      const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
      return {
        _id: session._id,
        table: session.tableId,
        queue: session.queueId,
        status: session.status,
        startTime: session.startTime,
        endTime: session.endTime,
        checkoutRequestedAt: session.checkoutRequestedAt,
        pendingPayment: pendingBySession.get(String(session._id)) || null,
        items,
        itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
        bill: calculateTotal(subtotal, clampSessionDiscount(subtotal, session.discount)),
        loyalty: buildSessionLoyaltyMeta(session),
      };
    });
    return res.status(200).json({ success: true, data, message: 'ดึงรายการรอชำระสำเร็จ' });
  } catch (error) {
    console.error('Get payment sessions failed:', error);
    return res.status(500).json({ success: false, code: 'REQUEST_FAILED', data: null, message: 'ไม่สามารถโหลดรายการรอชำระได้' });
  }
}

/**
 * Retrieve payment records, optionally filtered by session.
 * @param {import('express').Request} req - Request with an optional sessionId query.
 * @param {import('express').Response} res - HTTP response.
 * @returns {Promise<import('express').Response>} JSON response with payment history.
 */
async function getPaymentHistory(req, res) {
  try {
    const filter = req.query.sessionId ? { sessionId: req.query.sessionId } : {};
    const payments = await Payment.find(filter)
      .populate('sessionId')
      .populate('receivedBy', 'username fullName')
      .sort({ paidAt: -1 });
    return res.status(200).json({ success: true, data: payments, message: 'ดึงประวัติการชำระเงินสำเร็จ' });
  } catch (error) {
    console.error('Get payment history failed:', error);
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
 * Staff confirms a QR payment after checking the customer's transfer slip.
 * Marks the payment as completed and moves the table to cleaning.
 * @param {import('express').Request} req - Request with paymentId in params.
 * @param {import('express').Response} res - HTTP response.
 * @returns {Promise<import('express').Response>} JSON response with the completed payment.
 */
async function confirmQrPayment(req, res) {
  try {
    const paymentId = req.params.paymentId;
    const userId = req.user && (req.user.id || req.user._id);
    const payment = await Payment.findById(paymentId);
    if (!payment) {
      return res.status(404).json({ success: false, code: 'PAYMENT_NOT_FOUND', data: null, message: 'ไม่พบรายการชำระเงินนี้' });
    }
    if (payment.status === 'completed') {
      return res.status(409).json({ success: false, code: 'PAYMENT_ALREADY_COMPLETED', data: null, message: 'รายการนี้ยืนยันไปแล้ว' });
    }
    if (!['awaiting_confirmation', 'pending'].includes(payment.status)) {
      return res.status(409).json({ success: false, code: 'PAYMENT_STATE_CHANGED', data: null, message: 'สถานะรายการนี้ไม่พร้อมยืนยัน' });
    }

    const session = await Session.findById(payment.sessionId);
    if (!session) {
      return res.status(404).json({ success: false, code: 'SESSION_NOT_FOUND', data: null, message: 'ไม่พบรอบรับประทานของรายการนี้' });
    }
    if (session.isPaid) {
      return res.status(409).json({ success: false, code: 'SESSION_ALREADY_PAID', data: null, message: 'รอบนี้ชำระเงินแล้ว' });
    }

    const table = await Table.findOne({
      _id: session.tableId,
      status: 'occupied',
      currentSessionId: session._id,
    });
    if (!table || !canTransitionTable(table.status, 'cleaning', { isPaid: true })) {
      return res.status(409).json({
        success: false,
        code: 'TABLE_NOT_READY_FOR_PAYMENT',
        data: null,
        message: 'ไม่พบโต๊ะที่กำลังใช้งานสำหรับรอบนี้',
      });
    }

    const orders = await Order.find({ sessionId: session._id, status: { $ne: 'cancelled' } });
    const subtotal = calculateOrderSubtotal(orders);
    Object.assign(session, calculateTotal(subtotal, clampSessionDiscount(subtotal, session.discount)));

    const now = new Date();
    const previousStatus = session.status;
    const previousActualEndTime = session.actualEndTime;

    const paidSession = await Session.findOneAndUpdate(
      {
        _id: session._id,
        isPaid: false,
        status: previousStatus,
        checkoutRequestedAt: session.checkoutRequestedAt,
      },
      {
        $set: {
          isPaid: true,
          paidAt: now,
          status: 'completed',
          actualEndTime: session.actualEndTime || now,
          subtotal: session.subtotal,
          serviceCharge: session.serviceCharge,
          vat: session.vat,
          grandTotal: session.grandTotal,
        },
      },
      { new: true }
    );
    if (!paidSession) {
      return res.status(409).json({ success: false, code: 'SESSION_ALREADY_PAID', data: null, message: 'มีการเปลี่ยนแปลงสถานะรอบนี้ กรุณาโหลดข้อมูลใหม่' });
    }

    let completedPayment;
    let tableForCleaning;
    try {
      completedPayment = await Payment.findOneAndUpdate(
        { _id: payment._id, status: { $in: ['awaiting_confirmation', 'pending'] } },
        {
          $set: {
            status: 'completed',
            paidAt: now,
            amount: paidSession.grandTotal,
            confirmedBy: userId || undefined,
            confirmedAt: now,
          },
        },
        { new: true }
      );
      if (!completedPayment) {
        throw new Error('Payment was already confirmed by another request.');
      }

      tableForCleaning = await Table.findOneAndUpdate(
        {
          _id: paidSession.tableId,
          status: 'occupied',
          currentSessionId: paidSession._id,
        },
        {
          $set: {
            status: 'cleaning',
            currentSessionId: null,
            reservedForQueueId: null,
            lastSessionId: paidSession._id,
          },
        },
        { new: true }
      );
      if (!tableForCleaning) {
        throw new Error('Table state changed before QR confirmation could complete.');
      }

      // Fail any other pending QR attempts for this session.
      await Payment.updateMany(
        { sessionId: paidSession._id, _id: { $ne: payment._id }, status: { $in: ['pending', 'awaiting_confirmation'] } },
        { $set: { status: 'failed' } }
      );
    } catch (error) {
      // Rollback: session back to pre-paid state, payment back to awaiting_confirmation.
      let rollbackFailed = false;
      try {
        const rollbackSet = { isPaid: false, status: previousStatus };
        const rollbackUnset = { paidAt: 1 };
        if (previousActualEndTime) rollbackSet.actualEndTime = previousActualEndTime;
        else rollbackUnset.actualEndTime = 1;
        const r = await Session.updateOne(
          { _id: paidSession._id, isPaid: true, paidAt: now },
          { $set: rollbackSet, $unset: rollbackUnset }
        );
        if (r.modifiedCount !== 1) rollbackFailed = true;
      } catch (e) { rollbackFailed = true; console.error('QR session rollback failed:', e); }

      if (tableForCleaning) {
        try {
          await Table.updateOne(
            { _id: paidSession.tableId, status: 'cleaning', lastSessionId: paidSession._id },
            { $set: { status: 'occupied', currentSessionId: paidSession._id, lastSessionId: null } }
          );
        } catch (e) { rollbackFailed = true; console.error('QR table rollback failed:', e); }
      }
      if (completedPayment) {
        try {
          await Payment.updateOne(
            { _id: completedPayment._id, status: 'completed' },
            { $set: { status: 'awaiting_confirmation', paidAt: null } }
          );
        } catch (e) { rollbackFailed = true; console.error('QR payment rollback failed:', e); }
      }
      if (rollbackFailed) console.error('QR confirmation rollback was incomplete:', { sessionId: paidSession._id });
      throw error;
    }

    // QR payment confirmed: the meal is over, so close the seated queue.
    try {
      await completeSeatedQueuesForSession(paidSession._id, { io: req.app.get('io'), reason: 'QR payment confirmed' });
    } catch (queueError) {
      console.error('Closing seated queue after QR payment failed:', queueError);
    }

    let loyalty = null;
    if (paidSession.memberId) {
      try {
        loyalty = await settleSessionLoyalty(paidSession, {
          username: (req.user && req.user.username) || 'staff',
        });
        if (loyalty && !loyalty.alreadySettled) {
          await Session.updateOne(
            { _id: paidSession._id },
            {
              $set: {
                pointsEarned: loyalty.pointsEarned || 0,
                loyaltyProcessedAt: new Date(),
                memberTierName: (loyalty.member && loyalty.member.tierName) || paidSession.memberTierName,
              },
            }
          );
        }
      } catch (loyaltyError) {
        console.error('SQL loyalty settlement after QR payment failed:', loyaltyError.message);
      }
    }

    const io = req.app.get('io');
    if (io) {
      const event = { payment: completedPayment, sessionId: paidSession._id, amount: completedPayment.amount, loyalty };
      io.to('admin').emit('payment_completed', event);
      io.to(`customer_${paidSession._id}`).emit('payment_completed', event);
      io.to('admin').to('waiter').emit('table_waiting_for_cleaning', {
        table: tableForCleaning,
        sessionId: paidSession._id,
      });
    }

    return res.status(200).json({
      success: true,
      data: completedPayment,
      loyalty,
      message: 'ยืนยันการชำระเงินสำเร็จ',
    });
  } catch (error) {
    console.error('Confirm QR payment failed:', error);
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
 * Link a SQL Member and optional Tier/Promo discount to an unpaid dining session.
 */
async function applyLoyaltyBenefit(req, res) {
  try {
    const { sessionId, memberId, benefitType = 'NONE', promotionId = null } = req.body || {};
    const session = await Session.findById(sessionId);
    if (!session) {
      return res.status(404).json({ success: false, code: 'SESSION_NOT_FOUND', data: null, message: 'ไม่พบรอบรับประทานนี้' });
    }
    if (session.isPaid || session.status === 'completed' || session.status === 'cancelled') {
      return res.status(409).json({ success: false, code: 'SESSION_ALREADY_PAID', data: null, message: 'รอบรับประทานนี้ปิดหรือชำระเงินไปแล้ว' });
    }

    const orders = await Order.find({ sessionId: session._id, status: { $ne: 'cancelled' } });
    const subtotal = calculateOrderSubtotal(orders);

    const evaluated = await evaluateBenefitForBill({
      memberId,
      benefitType,
      promotionId,
      subtotal,
    });

    const clampedDiscount = clampSessionDiscount(subtotal, evaluated.discountAmount);
    const bill = calculateTotal(subtotal, clampedDiscount);

    Object.assign(session, bill, {
      memberId: evaluated.member.memberId,
      memberPhone: evaluated.member.phone,
      memberName: evaluated.member.fullName,
      memberTierName: evaluated.member.tierName,
      benefitType: evaluated.benefitType,
      appliedPromotionId: evaluated.appliedPromotionId,
      appliedPromoCode: evaluated.appliedPromoCode,
      appliedPromoTitle: evaluated.appliedPromoTitle,
      pointsToRedeem: evaluated.pointsToRedeem,
    });
    await session.save();

    await Payment.updateMany(
      { sessionId: session._id, method: 'qr_payment', status: { $in: ['pending', 'awaiting_confirmation'] } },
      { $set: { amount: session.grandTotal } }
    );

    const io = req.app.get('io');
    if (io) {
      const payload = { sessionId: session._id, bill, loyalty: buildSessionLoyaltyMeta(session) };
      io.to(`customer_${session._id}`).emit('bill_updated', payload);
      io.to('admin').emit('bill_updated', payload);
    }

    return res.status(200).json({
      success: true,
      data: {
        bill,
        loyalty: buildSessionLoyaltyMeta(session),
        member: evaluated.member,
      },
      message: clampedDiscount > 0
        ? `ใช้สิทธิ์ส่วนลด ฿${clampedDiscount.toFixed(2)} สำเร็จ`
        : `ผูกสมาชิก ${evaluated.member.fullName} สำหรับสะสมแต้มสำเร็จ`,
    });
  } catch (error) {
    const status = error.status || (error.name === 'CastError' || error instanceof RangeError ? 400 : 500);
    if (status >= 500) console.error('Apply loyalty benefit failed:', error);
    return res.status(status).json({
      success: false,
      code: error.code || 'REQUEST_FAILED',
      data: null,
      message: error.message || 'ไม่สามารถใช้สิทธิ์สมาชิกได้',
    });
  }
}

/**
 * Remove any linked SQL Member & discount from an unpaid dining session.
 */
async function clearLoyaltyBenefit(req, res) {
  try {
    const sessionId = req.params.sessionId || (req.body && req.body.sessionId);
    const session = await Session.findById(sessionId);
    if (!session) {
      return res.status(404).json({ success: false, code: 'SESSION_NOT_FOUND', data: null, message: 'ไม่พบรอบรับประทานนี้' });
    }
    if (session.isPaid || session.status === 'completed' || session.status === 'cancelled') {
      return res.status(409).json({ success: false, code: 'SESSION_ALREADY_PAID', data: null, message: 'รอบรับประทานนี้ปิดหรือชำระเงินไปแล้ว' });
    }

    const orders = await Order.find({ sessionId: session._id, status: { $ne: 'cancelled' } });
    const subtotal = calculateOrderSubtotal(orders);
    const bill = calculateTotal(subtotal, 0);

    Object.assign(session, bill, {
      memberId: null,
      memberPhone: '',
      memberName: '',
      memberTierName: '',
      benefitType: '',
      appliedPromotionId: null,
      appliedPromoCode: '',
      appliedPromoTitle: '',
      pointsToRedeem: 0,
    });
    await session.save();

    await Payment.updateMany(
      { sessionId: session._id, method: 'qr_payment', status: { $in: ['pending', 'awaiting_confirmation'] } },
      { $set: { amount: session.grandTotal } }
    );

    const io = req.app.get('io');
    if (io) {
      const payload = { sessionId: session._id, bill, loyalty: null };
      io.to(`customer_${session._id}`).emit('bill_updated', payload);
      io.to('admin').emit('bill_updated', payload);
    }

    return res.status(200).json({
      success: true,
      data: { bill, loyalty: null },
      message: 'ยกเลิกการใช้สิทธิ์สมาชิก/คูปองแล้ว',
    });
  } catch (error) {
    const status = error.name === 'CastError' ? 400 : 500;
    if (status >= 500) console.error('Clear loyalty benefit failed:', error);
    return res.status(status).json({
      success: false,
      code: 'REQUEST_FAILED',
      data: null,
      message: 'ไม่สามารถยกเลิกสิทธิ์ส่วนลดได้',
    });
  }
}

// Export payment handlers for route registration.
module.exports = {
  calculateBill,
  getPaymentSessions,
  processPayment,
  getPaymentHistory,
  confirmQrPayment,
  applyLoyaltyBenefit,
  clearLoyaltyBenefit,
};