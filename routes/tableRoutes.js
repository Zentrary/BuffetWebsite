const express = require('express');
const { protect, authorize } = require('../middlewares/authMiddleware');
const tableController = require('../controllers/tableController');
const tableAvailabilityController = require('../controllers/tableAvailabilityController');

const router = express.Router();

router.get('/availability-by-zone', tableAvailabilityController.getAvailabilityByZone);
router.get('/zone/:zone', tableAvailabilityController.getTablesByZone);
router.get('/', tableController.getAllTables);
router.get('/available', tableController.getAvailableTables);

router.post('/', protect, authorize('admin', 'manager'), tableController.createTable);
router.put('/:tableId', protect, authorize('admin', 'manager'), tableController.updateTable);
router.delete('/:tableId', protect, authorize('admin'), tableController.deleteTable);
router.put('/:tableId/status', protect, authorize('admin', 'manager'), tableController.updateTableStatus);
router.post('/:tableId/clear', protect, authorize('admin', 'manager', 'waiter'), tableController.clearTable);

module.exports = router;