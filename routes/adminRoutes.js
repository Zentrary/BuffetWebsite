const express = require('express');
const { protect, authorize } = require('../middlewares/authMiddleware');
const adminController = require('../controllers/adminController');

const router = express.Router();
router.use(protect, authorize('admin', 'manager'));
router.post('/session/:id/force-complete', adminController.forceCompleteSession);
router.post('/session/:id/force-free', adminController.forceFreeSession);
router.post('/table/:id/force-free', adminController.forceFreeTable);
router.post('/queue/:id/force-cancel', adminController.forceCancelQueue);
router.post('/reconcile', adminController.reconcileNow);
module.exports = router;