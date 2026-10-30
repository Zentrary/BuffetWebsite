// Import Express routing, authentication middleware, and queue handlers.
const express = require('express');
const { protect, authorize } = require('../middlewares/authMiddleware');
const queueController = require('../controllers/queueController');
const requireQueueAccepting = require('../middlewares/requireQueueAccepting');
const { rateLimit, keyByIp } = require('../middlewares/rateLimit');

const router = express.Router();

router.post(
  '/',
  rateLimit({ name: 'queue-create', windowMs: 60_000, max: 30, keyGenerator: keyByIp }),
  requireQueueAccepting,
  queueController.createQueue
);

// Public: TV display data (no auth, safe public info only).
router.get(
  '/display',
  rateLimit({
    name: 'queue-display',
    windowMs: 60_000,
    max: 180,
    keyGenerator: keyByIp,
    message: 'เรียกดูข้อมูลจอแสดงคิวบ่อยเกินไป',
  }),
  queueController.getDisplayData
);

router.get('/', protect, authorize('admin', 'manager', 'waiter'), queueController.getQueues);
router.post('/call', protect, authorize('admin', 'manager', 'waiter'), queueController.callQueue);

router.post(
  '/recover',
  rateLimit({
    name: 'queue-recover',
    windowMs: 15 * 60_000,
    max: 5,
    keyGenerator: keyByIp,
    message: 'พยายามกู้คืนคิวหลายครั้งเกินไป กรุณารอ 15 นาทีแล้วลองใหม่',
  }),
  queueController.recoverQueue
);

router.post(
  '/recover-by-id',
  rateLimit({ name: 'queue-recover-by-id', windowMs: 15 * 60_000, max: 10, keyGenerator: keyByIp }),
  queueController.recoverQueueById
);

router.get('/entry-qr', protect, authorize('admin', 'manager', 'waiter'), queueController.getEntryQRCode);
router.get('/:id/ticket', protect, authorize('admin', 'manager', 'waiter'), queueController.getTicketData);
router.post('/cancel/:id', protect, authorize('admin', 'manager', 'waiter'), queueController.cancelQueue);
// Close a seated queue when the party is done (payment/clearTable do this too).
router.post('/:id/complete', protect, authorize('admin', 'manager', 'waiter'), queueController.completeQueue);

// Customer cancels their own queue (uses accessToken, not JWT).
router.post(
  '/:id/customer-cancel',
  rateLimit({ name: 'queue-cancel-customer', windowMs: 60_000, max: 5, keyGenerator: keyByIp }),
  queueController.cancelQueueByCustomer
);

router.post('/:id/confirm', rateLimit({ name: 'queue-confirm', windowMs: 60_000, max: 10, keyGenerator: keyByIp }), queueController.confirmQueue);
router.get('/:id', rateLimit({ name: 'queue-read', windowMs: 60_000, max: 120, keyGenerator: keyByIp }), queueController.getQueueById);

module.exports = router;