// Express router for SQL-backed Membership, Loyalty Points & Promotions endpoints.

const express = require('express');
const { protect, authorize } = require('../middlewares/authMiddleware');
const memberController = require('../controllers/memberController');

const router = express.Router();

// Connection status & cashier lookup endpoints (accessible to admin, manager, waiter).
router.get('/status', protect, authorize('admin', 'manager', 'waiter'), memberController.getStatus);
router.get('/lookup', protect, authorize('admin', 'manager', 'waiter'), memberController.lookupMember);
router.get('/promotions', protect, authorize('admin', 'manager', 'waiter'), memberController.getPromotions);
router.post('/', protect, authorize('admin', 'manager', 'waiter'), memberController.createMember);

// Admin & manager management endpoints.
router.get('/overview', protect, authorize('admin', 'manager'), memberController.getOverview);
router.get('/tiers', protect, authorize('admin', 'manager'), memberController.getTiers);
router.get('/transactions', protect, authorize('admin', 'manager'), memberController.getTransactions);
router.get('/', protect, authorize('admin', 'manager'), memberController.getMembers);
router.put('/:id', protect, authorize('admin', 'manager'), memberController.updateMember);
router.delete('/:id', protect, authorize('admin', 'manager'), memberController.deleteMember);
router.post('/:id/points', protect, authorize('admin', 'manager'), memberController.adjustPoints);

router.post('/promotions', protect, authorize('admin', 'manager'), memberController.createPromotion);
router.put('/promotions/:id', protect, authorize('admin', 'manager'), memberController.updatePromotion);
router.delete('/promotions/:id', protect, authorize('admin', 'manager'), memberController.deletePromotion);

module.exports = router;
