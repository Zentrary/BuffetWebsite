// Import Express routing, authorization middleware, and session validation.
const express = require('express');
const { protect, authorize } = require('../middlewares/authMiddleware');
const validateSession = require('../middlewares/validateSession');
const orderController = require('../controllers/orderController');
const requireShopOpen = require('../middlewares/requireShopOpen');
const { rateLimit, keyByIp, keyBySession } = require('../middlewares/rateLimit');

const router = express.Router();

// Customer creates an order — limited per session to prevent spam.
router.post(
  '/',
  rateLimit({ name: 'order-create', windowMs: 60_000, max: 10, keyGenerator: keyBySession }),
  validateSession(),
  requireShopOpen,
  orderController.createOrder
);

// Retrieve kitchen and waiter orders.
router.get(
  '/',
  protect,
  authorize('admin', 'kitchen', 'waiter'),
  orderController.getOrdersForStaff
);

// List all orders belonging to a specific session — limited per IP.
router.get(
  '/session/:sessionId',
  rateLimit({ name: 'order-read-session', windowMs: 60_000, max: 60, keyGenerator: keyByIp }),
  orderController.getOrdersBySession
);

// Retrieve one order by its identifier.
router.get('/:id', orderController.getOrderById);

// Customer cancels their own order (pending only) — limited per session.
router.post(
  '/:id/customer-cancel',
  rateLimit({ name: 'order-cancel-customer', windowMs: 60_000, max: 5, keyGenerator: keyBySession }),
  orderController.cancelOrderByCustomer
);

// Staff advances order status.
router.put(
  '/:id/status',
  protect,
  authorize('admin', 'kitchen', 'waiter'),
  orderController.updateOrderStatus
);

// Staff updates one item status.
router.put(
  '/:id/item/:itemId/status',
  protect,
  authorize('kitchen', 'waiter'),
  orderController.updateItemStatus
);

// Staff cancels an order.
router.post('/:id/cancel', protect, authorize('admin', 'waiter'), orderController.cancelOrder);

module.exports = router;