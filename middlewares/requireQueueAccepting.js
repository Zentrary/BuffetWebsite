const ShopSettings = require('../models/ShopSettings');
const { getQueueAcceptance } = require('../utils/businessDay');

/**
 * Block new queue tickets once the business day stops accepting them.
 *
 * The shop may close at 03:00 but stop taking queues at 02:00, so this checks
 * both the opening hours and the separate `lastQueueTime` cut-off. Staff can
 * still call, seat, pay, and clear tables after the cut-off — only *new*
 * customers are turned away.
 */
async function requireQueueAccepting(req, res, next) {
  try {
    const settings = await ShopSettings.findById('shop-settings');
    const acceptance = settings
      ? getQueueAcceptance(settings)
      : { accepting: false, reason: 'closed', businessDate: null, cutoffAt: null, closesAt: null };

    if (acceptance.accepting) return next();

    const messages = {
      test_mode: 'ร้านกำลังทดสอบระบบ จึงยังไม่เปิดรับคิวจากลูกค้าจริง',
      cutoff: 'ปิดรับคิวสำหรับวันนี้แล้ว กรุณาติดต่อพนักงาน',
      closed: 'ร้านยังไม่เปิดให้บริการในขณะนี้',
    };
    return res.status(503).json({
      success: false,
      code: acceptance.reason === 'test_mode' ? 'SHOP_TEST_MODE' : 'QUEUE_CLOSED',
      data: acceptance,
      message: messages[acceptance.reason] || messages.closed,
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = requireQueueAccepting;
