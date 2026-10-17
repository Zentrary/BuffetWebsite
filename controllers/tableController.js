// Import the table model for table inventory and availability operations.
const Table = require('../models/Table');
const Session = require('../models/Session');
const { canTransitionTable } = require('../utils/sessionLifecycle');

const ZONE_RULES = {
  small: { minCapacity: 1, maxCapacity: 2 },
  medium: { minCapacity: 3, maxCapacity: 6 },
  large: { minCapacity: 7, maxCapacity: 12 },
};

async function getAllTables(req, res) {
  try {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.zone) filter.zone = req.query.zone;
    const tables = await Table.find(filter).populate('currentSessionId').sort({ tableNumber: 1 });
    return res.status(200).json({ success: true, data: tables, message: 'ดึงรายการโต๊ะสำเร็จ' });
  } catch (error) {
    console.error('Get tables failed:', error);
    return res.status(500).json({ success: false, code: 'REQUEST_FAILED', data: null, message: 'Request failed.' });
  }
}

async function createTable(req, res) {
  try {
    if (!req.user || !['admin', 'manager'].includes(req.user.role)) {
      return res.status(403).json({ success: false, code: 'FORBIDDEN', data: null, message: 'You are not allowed to perform this action.' });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const tableNumber = typeof body.tableNumber === 'string' ? body.tableNumber.trim() : '';
    const capacity = Number(body.capacity);
    const zone = body.zone === undefined ? 'small' : body.zone;
    const rule = ZONE_RULES[zone];

    if (!tableNumber || !Number.isInteger(capacity) || capacity < 1 || !rule) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_TABLE_DATA',
        data: null,
        message: 'กรุณาระบุหมายเลขโต๊ะ ความจุเป็นจำนวนเต็มบวก และประเภทโต๊ะที่ถูกต้อง',
      });
    }
    if (capacity < rule.minCapacity || capacity > rule.maxCapacity) {
      return res.status(400).json({
        success: false,
        code: 'CAPACITY_OUT_OF_ZONE_RANGE',
        data: null,
        message: `โซนนี้รับได้ ${rule.minCapacity}-${rule.maxCapacity} คน`,
      });
    }
    const minCapacity = Number(body.minCapacity) || rule.minCapacity;
    if (minCapacity < rule.minCapacity || minCapacity > capacity) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_MIN_CAPACITY',
        data: null,
        message: `ความจุขั้นต่ำต้องอยู่ระหว่าง ${rule.minCapacity} ถึง ${capacity}`,
      });
    }
    if (await Table.exists({ tableNumber })) {
      return res.status(409).json({
        success: false,
        code: 'TABLE_NUMBER_EXISTS',
        data: null,
        message: 'หมายเลขโต๊ะนี้มีอยู่แล้ว กรุณาใช้หมายเลขอื่น',
      });
    }
    const table = await Table.create({ tableNumber, capacity, minCapacity, zone });
    return res.status(201).json({ success: true, data: table, message: 'เพิ่มโต๊ะสำเร็จ' });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        code: 'TABLE_NUMBER_EXISTS',
        data: null,
        message: 'หมายเลขโต๊ะนี้มีอยู่แล้ว กรุณาใช้หมายเลขอื่น',
      });
    }
    console.error('Create table failed:', error);
    const status = error.name === 'ValidationError' ? 400 : 500;
    return res.status(status).json({
      success: false,
      code: status === 400 ? 'INVALID_TABLE_DATA' : 'REQUEST_FAILED',
      data: null,
      message: status === 400 ? 'ข้อมูลโต๊ะไม่ถูกต้อง' : 'เกิดข้อผิดพลาดในระบบ',
    });
  }
}

async function updateTable(req, res) {
  try {
    if (!req.user || !['admin', 'manager'].includes(req.user.role)) {
      return res.status(403).json({ success: false, code: 'FORBIDDEN', data: null, message: 'You are not allowed to perform this action.' });
    }
    const tableId = req.params.tableId || req.params.id;
    const table = await Table.findById(tableId);
    if (!table) {
      return res.status(404).json({ success: false, code: 'TABLE_NOT_FOUND', data: null, message: 'ไม่พบโต๊ะนี้' });
    }
    const body = req.body || {};
    const capacity = body.capacity !== undefined ? Number(body.capacity) : table.capacity;
    const zone = body.zone !== undefined ? body.zone : table.zone;
    const rule = ZONE_RULES[zone];
    if (!rule) {
      return res.status(400).json({ success: false, code: 'INVALID_ZONE', data: null, message: 'โซนไม่ถูกต้อง' });
    }
    if (!Number.isInteger(capacity) || capacity < rule.minCapacity || capacity > rule.maxCapacity) {
      return res.status(400).json({
        success: false,
        code: 'CAPACITY_OUT_OF_ZONE_RANGE',
        data: null,
        message: `โซนนี้รับได้ ${rule.minCapacity}-${rule.maxCapacity} คน`,
      });
    }
    const minCapacity = body.minCapacity !== undefined ? Number(body.minCapacity) : rule.minCapacity;
    if (minCapacity < rule.minCapacity || minCapacity > capacity) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_MIN_CAPACITY',
        data: null,
        message: `ความจุขั้นต่ำต้องอยู่ระหว่าง ${rule.minCapacity} ถึง ${capacity}`,
      });
    }

    // Allow changing tableNumber (rename) as long as it is unique and table is free.
    const newTableNumber = body.tableNumber !== undefined
      ? String(body.tableNumber).trim()
      : table.tableNumber;
    if (!newTableNumber) {
      return res.status(400).json({ success: false, code: 'INVALID_TABLE_DATA', data: null, message: 'หมายเลขโต๊ะห้ามว่าง' });
    }
    if (newTableNumber !== table.tableNumber) {
      if (table.status !== 'available' || table.currentSessionId) {
        return res.status(409).json({
          success: false,
          code: 'TABLE_IN_USE',
          data: null,
          message: 'เปลี่ยนชื่อโต๊ะได้เฉพาะเมื่อโต๊ะว่างและไม่มีลูกค้าเท่านั้น',
        });
      }
      const duplicate = await Table.exists({ tableNumber: newTableNumber, _id: { $ne: table._id } });
      if (duplicate) {
        return res.status(409).json({
          success: false,
          code: 'TABLE_NUMBER_EXISTS',
          data: null,
          message: 'หมายเลขโต๊ะนี้มีอยู่แล้ว กรุณาใช้หมายเลขอื่น',
        });
      }
    }

    if (zone !== table.zone && table.currentSessionId) {
      return res.status(409).json({
        success: false,
        code: 'TABLE_IN_USE',
        data: null,
        message: 'ไม่สามารถเปลี่ยนโซนได้ขณะมีลูกค้าใช้งานอยู่',
      });
    }

    table.tableNumber = newTableNumber;
    table.capacity = capacity;
    table.minCapacity = minCapacity;
    table.zone = zone;
    await table.save();
    return res.status(200).json({ success: true, data: table, message: 'อัปเดตโต๊ะสำเร็จ' });
  } catch (error) {
    console.error('Update table failed:', error);
    if (error.code === 11000) {
      return res.status(409).json({ success: false, code: 'TABLE_NUMBER_EXISTS', data: null, message: 'หมายเลขโต๊ะนี้มีอยู่แล้ว' });
    }
    return res.status(500).json({ success: false, code: 'REQUEST_FAILED', data: null, message: 'เกิดข้อผิดพลาดในระบบ' });
  }
}

async function deleteTable(req, res) {
  try {
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({ success: false, code: 'FORBIDDEN', data: null, message: 'ลบโต๊ะได้เฉพาะผู้ดูแลระบบ' });
    }
    const tableId = req.params.tableId || req.params.id;
    const table = await Table.findById(tableId);
    if (!table) {
      return res.status(404).json({ success: false, code: 'TABLE_NOT_FOUND', data: null, message: 'ไม่พบโต๊ะนี้' });
    }
    if (table.status !== 'available' || table.currentSessionId || table.reservedForQueueId) {
      return res.status(409).json({
        success: false,
        code: 'TABLE_IN_USE',
        data: null,
        message: 'ลบได้เฉพาะโต๊ะว่างที่ไม่มีลูกค้า ไม่มีการจอง และไม่มีการทำความสะอาดค้างอยู่',
      });
    }
    const activeSession = await Session.exists({ tableId: table._id, status: { $in: ['active', 'expired'] }, isPaid: false });
    if (activeSession) {
      return res.status(409).json({
        success: false,
        code: 'TABLE_IN_USE',
        data: null,
        message: 'มีรอบรับประทานที่ยังไม่ปิดอยู่บนโต๊ะนี้ ไม่สามารถลบได้',
      });
    }
    await Table.deleteOne({ _id: table._id });
    const io = req.app.get('io');
    if (io) io.to('admin').to('waiter').emit('table_board_updated');
    return res.status(200).json({ success: true, data: { _id: table._id }, message: `ลบโต๊ะ ${table.tableNumber} แล้ว` });
  } catch (error) {
    console.error('Delete table failed:', error);
    return res.status(500).json({ success: false, code: 'REQUEST_FAILED', data: null, message: 'เกิดข้อผิดพลาดในระบบ' });
  }
}

async function updateTableStatus(req, res) {
  return res.status(409).json({
    success: false,
    code: 'TABLE_STATUS_WORKFLOW_REQUIRED',
    data: null,
    message: 'เปลี่ยนสถานะโต๊ะด้วยตนเองไม่ได้ กรุณาทำรายการผ่านขั้นตอนเรียกคิว ชำระเงิน และทำความสะอาด',
  });
}

async function clearTable(req, res) {
  try {
    const tableId = req.params.tableId || req.params.id;
    const currentTable = await Table.findById(tableId);
    if (!currentTable) {
      return res.status(404).json({ success: false, code: 'TABLE_NOT_FOUND', data: null, message: 'ไม่พบโต๊ะนี้' });
    }
    if (currentTable.status !== 'cleaning') {
      return res.status(409).json({
        success: false,
        code: 'TABLE_NOT_CLEANING',
        data: null,
        message: 'ทำความสะอาดได้เฉพาะโต๊ะที่ชำระเงินแล้วและอยู่ในสถานะรอทำความสะอาด',
      });
    }
    let session = null;
    if (currentTable.lastSessionId) {
      session = await Session.findOne({ _id: currentTable.lastSessionId, isPaid: true });
    }
    if (!session) {
      session = await Session.findOne({ tableId: currentTable._id, isPaid: true }).sort({ paidAt: -1, updatedAt: -1 });
    }
    if (!session) {
      console.warn('[clearTable] no paid session found for', currentTable.tableNumber, '- clearing anyway');
    }
    const lastSessionId = currentTable.lastSessionId || (session && session._id) || null;
    const table = await Table.findOneAndUpdate(
      { _id: currentTable._id, status: 'cleaning' },
      { $set: { status: 'available', currentSessionId: null, reservedForQueueId: null, lastSessionId } },
      { new: true, runValidators: true }
    );
    if (!table) {
      return res.status(409).json({ success: false, code: 'TABLE_STATE_CHANGED', data: null, message: 'สถานะโต๊ะเปลี่ยนไปแล้ว กรุณาโหลดผังโต๊ะใหม่' });
    }
    const io = req.app.get('io');
    if (io) {
      io.to('admin').to('waiter').emit('table_cleared', table);
      io.emit('table_board_updated');
    }
    return res.status(200).json({ success: true, data: table, message: 'เคลียร์โต๊ะสำเร็จ' });
  } catch (error) {
    console.error('Clear table failed:', error);
    const status = error.name === 'CastError' ? 400 : 500;
    return res.status(status).json({
      success: false,
      code: 'REQUEST_FAILED',
      data: null,
      message: status === 400 ? 'รูปแบบ ID ไม่ถูกต้อง' : 'เกิดข้อผิดพลาดในระบบ',
    });
  }
}

async function getAvailableTables(req, res) {
  try {
    const tables = await Table.find({ status: 'available' }).sort({ capacity: 1 });
    return res.status(200).json({ success: true, data: tables, message: 'ดึงโต๊ะว่างสำเร็จ' });
  } catch (error) {
    console.error('Get available tables failed:', error);
    return res.status(500).json({ success: false, code: 'REQUEST_FAILED', data: null, message: 'Request failed.' });
  }
}

module.exports = {
  getAllTables,
  createTable,
  updateTable,
  deleteTable,
  updateTableStatus,
  clearTable,
  getAvailableTables,
  ZONE_RULES,
};