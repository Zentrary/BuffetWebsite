const express = require('express');
const { protect, authorize } = require('../middlewares/authMiddleware');
const reportController = require('../controllers/reportController');

const router = express.Router();
const adminOnly = [protect, authorize('admin', 'manager')];

router.get('/daily-sales', ...adminOnly, reportController.getDailySales);
router.get('/top-menus', ...adminOnly, reportController.getTopMenus);
router.get('/dining-time', ...adminOnly, reportController.getAverageDiningTime);
router.get('/queue-stats', ...adminOnly, reportController.getQueueStats);
router.get('/dashboard', ...adminOnly, reportController.getDashboardSummary);
router.get('/summary', ...adminOnly, reportController.getSummaryReport);
router.get('/hourly-sales', ...adminOnly, reportController.getHourlySales);
router.get('/payment-methods', ...adminOnly, reportController.getPaymentMethods);
router.get('/session-durations', ...adminOnly, reportController.getSessionDurations);
router.get('/zone-sales', ...adminOnly, reportController.getZoneSales);
router.get('/bills', ...adminOnly, reportController.getBills);
router.get('/menu-trends', ...adminOnly, reportController.getMenuTrends);
router.get('/staff-performance', ...adminOnly, reportController.getStaffPerformance);
router.get('/peak-hours', ...adminOnly, reportController.getPeakHours);
router.get('/feedback-summary', ...adminOnly, reportController.getFeedbackSummary);
router.get('/comparison', ...adminOnly, reportController.getComparison);
router.get('/export-excel', ...adminOnly, reportController.exportExcel);

module.exports = router;