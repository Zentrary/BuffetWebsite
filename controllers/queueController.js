// Import queue-related models and the QR generator.
const Queue = require('../models/Queue');
const QueueCounter = require('../models/QueueCounter');
const Table = require('../models/Table');
const Session = require('../models/Session');
const Order = require('../models/Order');
const ShopSettings = require('../models/ShopSettings');
const getBaseUrl = require('../utils/getBaseUrl');
const { generateQRCode } = require('../utils/qrGenerator');
const { SESSION_DURATION } = require('../config/constants');
const { calculateEndTime } = require('../utils/timer');
const {
  canTransitionQueue,
  canTransitionTable,
} = require('../utils/sessionLifecycle');
const {
  createQueueAccessToken,
  hashQueueAccessToken,
  hasQueueAccess,
} = require('../utils/queueAccess');

const MAX_PARTY_SIZE = 12;
const ZONE_RULES = {
  small: { minCapacity: 1, maxCapacity: 2, label: 'โต๊ะเล็ก' },
  medium: { minCapacity: 3, maxCapacity: 6, label: 'โต๊ะกลาง' },
  large: { minCapacity: 7, maxCapacity: 12, label: 'โต๊ะใหญ่' },
};

function zoneForCount(count) {
  if (count <= 2) return 'small';
  if (count <= 6) return 'medium';
  if (count <= 12) return 'large';
  return null;
}

function zoneLabel(zone) {
  return (ZONE_RULES[zone] && ZONE_RULES[zone].label) || zone;
}

async function getNextQueueNumber() {
  let counter;
  try {
    counter = await QueueCounter.findOneAndUpdate(
      { _id: 'queue-number' },
      { $inc: { sequence: 1 } },
      { new: true }
    );
  } catch (error) {
    if (error.code !== 11000) throw error;
  }
  if (!counter) {
    const [latest] = await Queue.aggregate([
      { $match: { queueNumber: /^Q\d+$/ } },
      {
        $project: {
          sequence: {
            $convert: {
              input: { $substrBytes: ['$queueNumber', 1, { $subtract: [{ $strLenBytes: '$queueNumber' }, 1] }] },
              to: 'long',
              onError: 0,
              onNull: 0,
            },
          },
        },
      },
      { $sort: { sequence: -1 } },
      { $limit: 1 },
    ]);
    try {
      await QueueCounter.updateOne(
        { _id: 'queue-number' },
        { $setOnInsert: { sequence: latest ? latest.sequence : 0 } },
        { upsert: true }
      );
    } catch (error) {
      if (error.code !== 11000) throw error;
    }
    counter = await QueueCounter.findOneAndUpdate(
      { _id: 'queue-number' },
      { $inc: { sequence: 1 } },
      { new: true }
    );
  }
  if (!counter || !Number.isSafeInteger(counter.sequence)) {
    throw new Error('Queue sequence counter is not available.');
  }
  return `Q${String(counter.sequence).padStart(3, '0')}`;
}

async function getQueueStatus(queue) {
  const startOfDay = new Date(queue.createdAt);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(startOfDay);
  endOfDay.setDate(endOfDay.getDate() + 1);
  const [waitingAhead, waitingCount, session] = await Promise.all([
    queue.status === 'waiting'
      ? Queue.countDocuments({
        status: 'waiting',
        $or: [
          { createdAt: { $gte: startOfDay, $lt: queue.createdAt } },
          { createdAt: queue.createdAt, _id: { $lt: queue._id } },
        ],
      })
      : 0,
    Queue.countDocuments({
      status: 'waiting',
      createdAt: { $gte: startOfDay, $lt: endOfDay },
    }),
    queue.sessionId ? Session.findById(queue.sessionId).select('endTime startTime status') : null,
  ]);
  return {
    _id: queue._id,
    queueNumber: queue.queueNumber,
    customerCount: queue.customerCount,
    status: queue.status,
    createdAt: queue.createdAt,
    calledAt: queue.calledAt,
    seatedAt: queue.seatedAt,
    waitingAhead,
    waitingCount,
    tableNumber: queue.tableId && queue.tableId.tableNumber,
    preferredZone: queue.preferredZone || null,
    preferredTableId: queue.preferredTableId || null,
    assignedTableId: queue.assignedTableId || null,
    assignmentNote: queue.assignmentNote || '',
    sessionId: queue.sessionId,
    startTime: session && session.startTime,
    endTime: session && session.endTime,
  };
}

function getAccessToken(req) {
  const authorization = req.get('authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : (req.body && req.body.accessToken) || '';
}

function normalizePreferredTable(preferredTableId) {
  if (!preferredTableId) return null;
  const value = String(preferredTableId).trim();
  if (!/^[a-f\d]{24}$/i.test(value)) return null;
  return value;
}

/**
 * Create a queue entry with an atomic sequence, capacity validation, and optional table preference.
 * @param {import('express').Request} req - Request containing customer details and preferences.
 * @param {import('express').Response} res - HTTP response.
 * @returns {Promise<import('express').Response>} JSON response with the queue record.
 */
async function createQueue(req, res) {
  try {
    const { customerCount, customerName, customerPhone, preferredZone, preferredTableId } = req.body;
    const count = Number(customerCount);

    if (!Number.isInteger(count) || count < 1 || count > MAX_PARTY_SIZE) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_PARTY_SIZE',
        data: null,
        message: `จำนวนลูกค้าต้องอยู่ระหว่าง 1-${MAX_PARTY_SIZE} คน กรุณาแยกการจองหากเกิน ${MAX_PARTY_SIZE} คน`,
      });
    }

    const expectedZone = zoneForCount(count);
    let zone = preferredZone ? String(preferredZone) : null;
    if (zone && !ZONE_RULES[zone]) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_ZONE',
        data: null,
        message: 'โซนที่เลือกไม่ถูกต้อง',
      });
    }
    if (!zone) zone = expectedZone;
    const rule = ZONE_RULES[zone];
    if (count < rule.minCapacity || count > rule.maxCapacity) {
      return res.status(400).json({
        success: false,
        code: 'ZONE_CAPACITY_MISMATCH',
        data: null,
        message: `${rule.label}รับ ${rule.minCapacity}-${rule.maxCapacity} คน ลูกค้า ${count} คนไม่เข้าเกณฑ์`,
      });
    }

    // Validate preferred table if supplied.
    let preferredTable = null;
    const normalizedTableId = normalizePreferredTable(preferredTableId);
    if (normalizedTableId) {
      preferredTable = await Table.findById(normalizedTableId);
      if (!preferredTable) {
        return res.status(400).json({
          success: false,
          code: 'TABLE_NOT_FOUND',
          data: null,
          message: 'ไม่พบโต๊ะที่เลือก',
        });
      }
      if (preferredTable.zone !== zone) {
        return res.status(400).json({
          success: false,
          code: 'TABLE_ZONE_MISMATCH',
          data: null,
          message: 'โต๊ะที่เลือกไม่ตรงกับโซน',
        });
      }
      if (count < preferredTable.minCapacity || count > preferredTable.capacity) {
        return res.status(400).json({
          success: false,
          code: 'TABLE_CAPACITY_MISMATCH',
          data: null,
          message: `โต๊ะนี้รับ ${preferredTable.minCapacity}-${preferredTable.capacity} คน`,
        });
      }
      if (preferredTable.status !== 'available') {
        return res.status(409).json({
          success: false,
          code: 'TABLE_NOT_AVAILABLE',
          data: null,
          message: 'โต๊ะนี้ไม่ว่างในขณะนี้ กรุณาเลือกโต๊ะอื่นหรือปล่อยให้พนักงานจัดให้',
        });
      }
    }

    const accessToken = createQueueAccessToken();
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(startOfDay);
    endOfDay.setDate(endOfDay.getDate() + 1);
    const waitingAhead = await Queue.countDocuments({
      status: 'waiting',
      createdAt: { $gte: startOfDay, $lt: endOfDay },
    });

    let queueNumber;
    let queue;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      queueNumber = await getNextQueueNumber();
      try {
        queue = await Queue.create({
          queueNumber,
          customerCount: count,
          customerName,
          customerPhone,
          accessTokenHash: hashQueueAccessToken(accessToken),
          preferredZone: zone,
          preferredTableId: preferredTable ? preferredTable._id : null,
          autoAssign: !preferredTable,
        });
        break;
      } catch (error) {
        if (error.code !== 11000 || attempt === 2) throw error;
        console.warn('Queue number collided with an existing ticket; retrying allocation.');
      }
    }

    const io = req.app.get('io');
    if (io) {
      io.to('admin').emit('new_queue', {
        _id: queue._id,
        queueNumber: queue.queueNumber,
        customerCount: queue.customerCount,
        status: queue.status,
        preferredZone: queue.preferredZone,
        preferredTableId: queue.preferredTableId,
        createdAt: queue.createdAt,
      });
      io.to('customer').emit('queue_board_updated');
    }
    return res.status(201).json({
      success: true,
      data: {
        _id: queue._id,
        queueNumber: queue.queueNumber,
        customerCount: queue.customerCount,
        status: queue.status,
        preferredZone: queue.preferredZone,
        preferredTableId: queue.preferredTableId,
        createdAt: queue.createdAt,
        waitingAhead,
        waitingCount: waitingAhead + 1,
        accessToken,
      },
      message: 'สร้างคิวสำเร็จ',
    });
  } catch (error) {
    console.error('Create queue failed:', error);
    const status = error.name === 'ValidationError' || error.code === 11000 ? 400 : 500;
    return res.status(status).json({
      success: false,
      code: 'REQUEST_FAILED',
      data: null,
      message: status === 400 ? error.message : 'เกิดข้อผิดพลาดในระบบ',
    });
  }
}

/**
 * Retrieve queue entries, optionally filtered by status.
 * @param {import('express').Request} req - Request with an optional status query.
 * @param {import('express').Response} res - HTTP response.
 * @returns {Promise<import('express').Response>} JSON response with queue entries.
 */
async function getQueues(req, res) {
  try {
    const supportedStatuses = ['waiting', 'called', 'seated', 'cancelled', 'no_show'];
    if (req.query.status && !supportedStatuses.includes(req.query.status)) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_QUEUE_STATUS',
        data: null,
        message: 'สถานะคิวที่ระบุไม่ถูกต้อง',
      });
    }
    const filter = req.query.status
      ? { status: req.query.status }
      : { status: { $in: ['waiting', 'called', 'seated'] } };
    const queues = await Queue.find(filter)
      .populate('tableId')
      .populate('preferredTableId', 'tableNumber zone')
      .populate('sessionId', 'startTime endTime status isPaid')
      .sort({ createdAt: 1 });
    const activeQueues = queues.filter((queue) => (
      queue.status !== 'seated' || !queue.sessionId || !queue.sessionId.isPaid
    ));
    return res.status(200).json({ success: true, data: activeQueues, message: 'ดึงรายการคิวสำเร็จ' });
  } catch (error) {
    console.error('Get queues failed:', error);
    return res.status(500).json({ success: false, code: 'REQUEST_FAILED', data: null, message: 'Request failed.' });
  }
}

/**
 * Find the best table for a queue given its preferences and party size.
 * Priority: preferred table -> preferred zone -> smallest matching table.
 * @param {object} queue - Queue document.
 * @returns {Promise<{table: object|null, fallbackReason: string}>} Selected table and reason if different.
 */
async function findTableForQueue(queue) {
  const count = queue.customerCount;

  // 1) Preferred exact table if still available.
  if (queue.preferredTableId) {
    const preferred = await Table.findOne({
      _id: queue.preferredTableId,
      status: 'available',
      minCapacity: { $lte: count },
      capacity: { $gte: count },
    });
    if (preferred) return { table: preferred, fallbackReason: '' };
  }

  // 2) Preferred zone, smallest matching capacity.
  const zone = queue.preferredZone || zoneForCount(count);
  if (zone) {
    const rule = ZONE_RULES[zone];
    if (rule && count >= rule.minCapacity && count <= rule.maxCapacity) {
      const zoneMatch = await Table.findOne({
        status: 'available',
        zone,
        minCapacity: { $lte: count },
        capacity: { $gte: count },
      }).sort({ capacity: 1 });
      if (zoneMatch) {
        return {
          table: zoneMatch,
          fallbackReason: queue.preferredTableId ? 'preferred_table_taken' : '',
        };
      }
    }
  }

  // 3) Any available table that fits.
  const anyTable = await Table.findOne({
    status: 'available',
    minCapacity: { $lte: count },
    capacity: { $gte: count },
  }).sort({ capacity: 1 });
  if (anyTable) {
    return { table: anyTable, fallbackReason: 'zone_full' };
  }

  return { table: null, fallbackReason: 'no_table' };
}

/**
 * Call the first waiting party and reserve a suitable available table.
 * @param {import('express').Request} req - Request with no required body fields.
 * @param {import('express').Response} res - HTTP response.
 * @returns {Promise<import('express').Response>} JSON response with the called queue and table.
 */
async function callQueue(req, res) {
  let reservedTableId;
  let createdSessionId;
  try {
    const queue = await Queue.findOne({ status: 'waiting' }).sort({ createdAt: 1 });
    if (!queue) {
      return res.status(404).json({ success: false, code: 'NO_QUEUES_WAITING', data: null, message: 'There are no queues waiting to be called.' });
    }
    if (!canTransitionQueue(queue.status, 'called')) {
      return res.status(409).json({ success: false, code: 'QUEUE_TRANSITION_NOT_ALLOWED', data: null, message: 'สถานะคิวไม่อนุญาตให้เรียกคิวนี้' });
    }

    const { table, fallbackReason } = await findTableForQueue(queue);
    if (!table) {
      return res.status(409).json({ success: false, code: 'NO_AVAILABLE_TABLE', data: null, message: 'No available table can seat this party.' });
    }
    if (!canTransitionTable(table.status, 'reserved')) {
      return res.status(409).json({ success: false, code: 'TABLE_TRANSITION_NOT_ALLOWED', data: null, message: 'สถานะโต๊ะไม่อนุญาตให้เรียกคิวนี้' });
    }

    const reservedTable = await Table.findOneAndUpdate(
      { _id: table._id, status: 'available', currentSessionId: null },
      { $set: { status: 'reserved', currentSessionId: null, reservedForQueueId: queue._id } },
      { new: true }
    );
    if (!reservedTable) {
      return res.status(409).json({ success: false, code: 'TABLE_BUSY', data: null, message: 'The table was reserved by another request.' });
    }
    reservedTableId = reservedTable._id;

    const calledAt = new Date();
    const shopSettings = await ShopSettings.findById('shop-settings').select('diningDurationMinutes');
    const diningDuration = Number.isInteger(shopSettings && shopSettings.diningDurationMinutes)
      ? shopSettings.diningDurationMinutes
      : SESSION_DURATION;
    const session = await Session.create({
      queueId: queue._id,
      tableId: reservedTable._id,
      startTime: calledAt,
      endTime: calculateEndTime(calledAt, diningDuration),
    });
    createdSessionId = session._id;

    let assignmentNote = '';
    if (fallbackReason === 'preferred_table_taken') {
      assignmentNote = `โต๊ะที่เลือกถูกใช้แล้ว ระบบจัด ${reservedTable.tableNumber} แทน`;
    } else if (fallbackReason === 'zone_full') {
      assignmentNote = `โซนที่เลือกเต็ม ระบบจัด ${reservedTable.tableNumber} แทน`;
    }

    const calledQueue = await Queue.findOneAndUpdate(
      { _id: queue._id, status: 'waiting' },
      {
        $set: {
          status: 'called',
          calledAt,
          tableId: reservedTable._id,
          assignedTableId: reservedTable._id,
          assignmentNote,
          sessionId: session._id,
        },
      },
      { new: true }
    );
    if (!calledQueue) {
      await Session.findByIdAndDelete(session._id);
      await Table.findOneAndUpdate(
        { _id: reservedTable._id, status: 'reserved', currentSessionId: null },
        { $set: { status: 'available', currentSessionId: null, reservedForQueueId: null } }
      );
      reservedTableId = null;
      return res.status(409).json({ success: false, code: 'QUEUE_ALREADY_CALLED', data: null, message: 'The queue was called by another request.' });
    }
    reservedTableId = null;
    createdSessionId = null;

    const io = req.app.get('io');
    if (io) {
      const callEvent = {
        queue: {
          _id: calledQueue._id,
          queueNumber: calledQueue.queueNumber,
          status: calledQueue.status,
          calledAt: calledQueue.calledAt,
          sessionId: session._id,
          endTime: session.endTime,
          preferredTableId: calledQueue.preferredTableId,
          assignedTableId: calledQueue.assignedTableId,
          assignmentNote,
        },
        table: {
          _id: reservedTable._id,
          tableNumber: reservedTable.tableNumber,
          zone: reservedTable.zone,
        },
      };
      io.to(`queue_${calledQueue._id}`).emit('queue_called', callEvent);
      io.to('admin').to('waiter').emit('queue_called', callEvent);
      io.to('customer').emit('queue_board_updated');
      io.emit('table_board_updated');
    }
    return res.status(200).json({
      success: true,
      data: {
        queue: calledQueue,
        table: reservedTable,
        session: { _id: session._id, endTime: session.endTime },
        assignmentNote,
      },
      message: 'เรียกคิวสำเร็จ',
    });
  } catch (error) {
    if (createdSessionId) {
      try {
        await Session.findByIdAndDelete(createdSessionId);
      } catch (rollbackError) {
        console.error('Failed to remove session after queue-call error:', rollbackError);
      }
    }
    if (reservedTableId) {
      try {
        await Table.findOneAndUpdate(
          { _id: reservedTableId, status: 'reserved', currentSessionId: null },
          { $set: { status: 'available', currentSessionId: null, reservedForQueueId: null } }
        );
      } catch (rollbackError) {
        console.error('Failed to release reserved table after queue-call error:', rollbackError);
      }
    }
    console.error('Call queue failed:', error);
    return res.status(500).json({ success: false, code: 'REQUEST_FAILED', data: null, message: 'Request failed.' });
  }
}

/**
 * Cancel a queue entry that has not been seated.
 * @param {import('express').Request} req - Request with queueId in route params.
 * @param {import('express').Response} res - HTTP response.
 * @returns {Promise<import('express').Response>} JSON response with the cancelled queue.
 */
async function cancelQueue(req, res) {
  let queue;
  let cancelledQueue;
  let releasedTableId;
  let previousStatus;
  let cancellationCommitted = false;
  try {
    queue = await Queue.findById(req.params.queueId || req.params.id);
    if (!queue) {
      return res.status(404).json({ success: false, code: 'QUEUE_NOT_FOUND', data: null, message: 'Queue not found.' });
    }
    if (!canTransitionQueue(queue.status, 'cancelled')) {
      return res.status(409).json({ success: false, code: 'QUEUE_CANNOT_BE_CANCELLED', data: null, message: 'คิวนี้เริ่มใช้บริการหรือสิ้นสุดแล้ว จึงยกเลิกไม่ได้' });
    }

    previousStatus = queue.status;
    const session = queue.sessionId ? await Session.findById(queue.sessionId) : null;
    if (session && !queue.tableId) {
      return res.status(409).json({ success: false, code: 'QUEUE_STATE_CHANGED', data: null, message: 'ข้อมูลโต๊ะของคิวไม่ครบ กรุณาติดต่อผู้ดูแลระบบ' });
    }
    if (session && await Order.exists({ sessionId: session._id })) {
      return res.status(409).json({ success: false, code: 'QUEUE_ALREADY_SEATED', data: null, message: 'คิวนี้เริ่มสั่งอาหารแล้ว จึงยกเลิกไม่ได้' });
    }
    if (queue.status === 'called' && queue.tableId) {
      const reservedTable = await Table.findOne({
        _id: queue.tableId,
        status: 'reserved',
        currentSessionId: null,
      });
      if (!reservedTable || !canTransitionTable(reservedTable.status, 'available')) {
        return res.status(409).json({ success: false, code: 'TABLE_STATE_CHANGED', data: null, message: 'สถานะโต๊ะเปลี่ยนไปแล้ว จึงยกเลิกคิวนี้ไม่ได้' });
      }
    }

    cancelledQueue = await Queue.findOneAndUpdate(
      { _id: queue._id, status: queue.status },
      { $set: { status: 'cancelled' } },
      { new: true }
    );
    if (!cancelledQueue) {
      return res.status(409).json({ success: false, code: 'QUEUE_STATE_CHANGED', data: null, message: 'สถานะคิวเปลี่ยนไปแล้ว กรุณาโหลดรายการคิวใหม่' });
    }
    if (cancelledQueue.tableId) {
      const releasedTable = await Table.findOneAndUpdate(
        {
          _id: cancelledQueue.tableId,
          status: 'reserved',
          currentSessionId: null,
        },
        { $set: { status: 'available', currentSessionId: null, reservedForQueueId: null } },
        { new: true }
      );
      if (!releasedTable) {
        throw new Error('The reserved table could not be released during queue cancellation.');
      }
      releasedTableId = releasedTable._id;
      if (session) {
        const deletedSession = await Session.deleteOne({ _id: session._id, isPaid: false });
        if (deletedSession.deletedCount !== 1) {
          throw new Error('The unpaid queue session could not be removed during cancellation.');
        }
      }
    }
    cancellationCommitted = true;
    const io = req.app.get('io');
    if (io) {
      io.to(`queue_${cancelledQueue._id}`).emit('queue_cancelled', { queueId: cancelledQueue._id });
      io.to('customer').emit('queue_board_updated');
      io.to('admin').to('waiter').emit('queue_board_updated');
      io.emit('table_board_updated');
    }
    return res.status(200).json({ success: true, data: cancelledQueue, message: 'ยกเลิกคิวสำเร็จ' });
  } catch (error) {
    if (!cancellationCommitted && cancelledQueue) {
      try {
        if (releasedTableId) {
          await Table.findOneAndUpdate(
            { _id: releasedTableId, status: 'available', currentSessionId: null },
            { $set: { status: 'reserved' } }
          );
        }
        await Queue.findOneAndUpdate(
          { _id: cancelledQueue._id, status: 'cancelled' },
          { $set: { status: previousStatus } }
        );
      } catch (rollbackError) {
        console.error('Failed to restore queue or table after cancellation error:', rollbackError);
      }
    }
    console.error('Cancel queue failed:', error);
    return res.status(500).json({ success: false, code: 'REQUEST_FAILED', data: null, message: 'Request failed.' });
  }
}

/**
 * Retrieve a queue entry by its MongoDB identifier.
 * @param {import('express').Request} req - Request with queueId or id in route params.
 * @param {import('express').Response} res - HTTP response.
 * @returns {Promise<import('express').Response>} JSON response with the queue entry.
 */
async function getQueueById(req, res) {
  try {
    const queue = await Queue.findById(req.params.queueId || req.params.id)
      .select('queueNumber customerCount status createdAt calledAt seatedAt tableId sessionId preferredZone preferredTableId assignedTableId assignmentNote +accessTokenHash')
      .populate('tableId', 'tableNumber')
      .populate('preferredTableId', 'tableNumber zone');
    if (!queue) {
      return res.status(404).json({ success: false, code: 'QUEUE_NOT_FOUND', data: null, message: 'Queue not found.' });
    }
    if (!hasQueueAccess(queue, getAccessToken(req) || String(queue._id))) {
      return res.status(404).json({ success: false, code: 'QUEUE_NOT_FOUND', data: null, message: 'ไม่พบคิวหรือรหัสกู้คืนไม่ถูกต้อง' });
    }
    return res.status(200).json({
      success: true,
      data: await getQueueStatus(queue),
      message: 'ดึงข้อมูลคิวสำเร็จ',
    });
  } catch (error) {
    console.error('Get queue failed:', error);
    const status = error.name === 'CastError' ? 400 : 500;
    return res.status(status).json({
      success: false,
      code: 'REQUEST_FAILED',
      data: null,
      message: status === 400 ? 'รูปแบบ ID ไม่ถูกต้อง' : 'เกิดข้อผิดพลาดในระบบ',
    });
  }
}

async function recoverQueue(req, res) {
  try {
    const accessToken = req.body && req.body.accessToken;
    const accessTokenHash = hashQueueAccessToken(accessToken);
    if (!accessTokenHash && !/^[a-f\d]{24}$/i.test(accessToken || '')) {
      return res.status(400).json({ success: false, code: 'INVALID_QUEUE_RECOVERY_CODE', data: null, message: 'รหัสกู้คืนคิวไม่ถูกต้อง' });
    }
    const queue = await (accessTokenHash
      ? Queue.findOne({ accessTokenHash })
      : Queue.findOne({ _id: accessToken, accessTokenHash: { $exists: false } }))
      .select('queueNumber customerCount status createdAt calledAt seatedAt tableId sessionId preferredZone preferredTableId assignedTableId assignmentNote +accessTokenHash')
      .populate('tableId', 'tableNumber')
      .populate('preferredTableId', 'tableNumber zone');
    if (!queue) {
      return res.status(404).json({ success: false, code: 'QUEUE_NOT_FOUND', data: null, message: 'ไม่พบคิวสำหรับรหัสกู้คืนนี้' });
    }
    return res.status(200).json({
      success: true,
      data: await getQueueStatus(queue),
      message: 'กู้คืนคิวสำเร็จ',
    });
  } catch (error) {
    console.error('Recover queue failed:', error);
    return res.status(500).json({ success: false, code: 'REQUEST_FAILED', data: null, message: 'ไม่สามารถกู้คืนคิวได้ กรุณาลองอีกครั้ง' });
  }
}

async function confirmQueue(req, res) {
  let transitionedQueueId;
  let confirmationSessionId;
  try {
    const queue = await Queue.findById(req.params.queueId || req.params.id || (req.body && req.body.queueId))
      .select('queueNumber status calledAt seatedAt tableId sessionId +accessTokenHash')
      .populate('tableId', 'tableNumber');
    if (!queue || !hasQueueAccess(queue, getAccessToken(req) || String(queue._id))) {
      return res.status(404).json({ success: false, code: 'QUEUE_NOT_FOUND', data: null, message: 'ไม่พบคิวหรือรหัสกู้คืนไม่ถูกต้อง' });
    }
    if (queue.status === 'seated' && queue.sessionId) {
      const seatedSession = await Session.findOne({ _id: queue.sessionId, status: 'active', isPaid: false });
      const seatedTable = seatedSession
        ? await Table.findOne({ _id: queue.tableId, status: 'occupied', currentSessionId: seatedSession._id })
        : null;
      if (seatedSession && seatedTable) {
        return res.status(200).json({
          success: true,
          data: await getQueueStatus(queue),
          message: 'ยืนยันที่นั่งแล้ว',
        });
      }
      return res.status(409).json({ success: false, code: 'QUEUE_STATE_CHANGED', data: null, message: 'สถานะคิวหรือโต๊ะเปลี่ยนไปแล้ว กรุณาติดต่อพนักงาน' });
    }
    if (!canTransitionQueue(queue.status, 'seated') || !queue.tableId || !queue.sessionId) {
      return res.status(409).json({ success: false, code: 'QUEUE_NOT_CALLED', data: null, message: 'คิวนี้ยังไม่ถูกเรียก หรือไม่สามารถยืนยันที่นั่งได้' });
    }

    const now = new Date();
    const session = await Session.findOne({
      _id: queue.sessionId,
      queueId: queue._id,
      tableId: queue.tableId,
      status: 'active',
      isPaid: false,
      endTime: { $gt: now },
    });
    if (!session) {
      return res.status(409).json({ success: false, code: 'QUEUE_CALL_EXPIRED', data: null, message: 'เวลารอบนี้หมดแล้ว กรุณาติดต่อพนักงานเพื่อดำเนินการต่อ' });
    }

    const seatedQueue = await Queue.findOneAndUpdate(
      { _id: queue._id, status: 'called', sessionId: session._id },
      { $set: { status: 'seated', seatedAt: now } },
      { new: true }
    );
    if (!seatedQueue) {
      const currentQueue = await Queue.findById(queue._id)
        .select('queueNumber status createdAt calledAt seatedAt tableId sessionId')
        .populate('tableId', 'tableNumber');
      if (currentQueue && currentQueue.status === 'seated') {
        const currentTable = await Table.findOne({
          _id: queue.tableId,
          status: 'occupied',
          currentSessionId: session._id,
        });
        if (currentTable) {
          return res.status(200).json({ success: true, data: await getQueueStatus(currentQueue), message: 'ยืนยันที่นั่งแล้ว' });
        }
      }
      return res.status(409).json({ success: false, code: 'QUEUE_STATE_CHANGED', data: null, message: 'สถานะคิวเปลี่ยนไปแล้ว กรุณาโหลดข้อมูลใหม่' });
    }
    transitionedQueueId = seatedQueue._id;
    confirmationSessionId = session._id;

    const occupiedTable = await Table.findOneAndUpdate(
      { _id: queue.tableId, status: 'reserved', currentSessionId: null },
      { $set: { status: 'occupied', currentSessionId: session._id, reservedForQueueId: null } },
      { new: true }
    );
    if (!occupiedTable) {
      const restoredQueue = await Queue.findOneAndUpdate(
        { _id: seatedQueue._id, status: 'seated', sessionId: session._id },
        { $set: { status: 'called' }, $unset: { seatedAt: 1 } }
      );
      if (!restoredQueue) {
        throw new Error('Queue state could not be restored after the reserved table changed.');
      }
      transitionedQueueId = null;
      return res.status(409).json({ success: false, code: 'TABLE_STATE_CHANGED', data: null, message: 'โต๊ะถูกเปลี่ยนสถานะแล้ว กรุณาติดต่อพนักงาน' });
    }
    transitionedQueueId = null;

    const io = req.app.get('io');
    if (io) {
      const payload = { queueId: seatedQueue._id, sessionId: session._id, table: occupiedTable };
      io.to(`queue_${seatedQueue._id}`).emit('queue_seated', payload);
      io.to('admin').to('waiter').emit('queue_seated', payload);
      io.to('customer').emit('queue_board_updated');
      io.emit('table_board_updated');
    }
    const populatedQueue = await Queue.findById(seatedQueue._id)
      .select('queueNumber customerCount status createdAt calledAt seatedAt tableId sessionId')
      .populate('tableId', 'tableNumber');
    return res.status(200).json({ success: true, data: await getQueueStatus(populatedQueue), message: 'ยืนยันที่นั่งแล้ว' });
  } catch (error) {
    if (transitionedQueueId) {
      try {
        await Queue.findOneAndUpdate(
          { _id: transitionedQueueId, status: 'seated', sessionId: confirmationSessionId },
          { $set: { status: 'called' }, $unset: { seatedAt: 1 } }
        );
      } catch (rollbackError) {
        console.error('Failed to restore called queue after seat-confirmation error:', rollbackError);
      }
    }
    console.error('Confirm queue failed:', error);
    const status = error.name === 'CastError' ? 400 : 500;
    return res.status(status).json({
      success: false,
      code: status === 400 ? 'INVALID_QUEUE_ID' : 'REQUEST_FAILED',
      data: null,
      message: status === 400 ? 'รูปแบบคิวไม่ถูกต้อง' : 'ไม่สามารถยืนยันที่นั่งได้ กรุณาลองอีกครั้ง',
    });
  }
}

/**
 * Generate a reusable QR code that opens the customer queue form.
 * @param {import('express').Request} req - Authenticated staff request.
 * @param {import('express').Response} res - Express response.
 * @returns {Promise<import('express').Response>} The queue URL and QR data URL.
 */
async function getEntryQRCode(req, res) {
  try {
    const queueUrl = `${getBaseUrl(req)}/queue.html`;
    const qrCodeData = await generateQRCode(queueUrl);
    res.set('Cache-Control', 'no-store');
    return res.status(200).json({
      success: true,
      data: { queueUrl, qrCodeData },
      message: 'สร้าง QR สำหรับรับคิวแล้ว',
    });
  } catch (error) {
    console.error('Create queue entry QR failed:', error);
    return res.status(500).json({
      success: false,
      code: 'REQUEST_FAILED',
      data: null,
      message: 'Unable to create the queue entry QR code.',
    });
  }
}

// Export queue endpoints for route registration.

/**
 * Recover a queue using its MongoDB _id. Used when the customer scans the QR
 * printed on their physical ticket. The id space is 96-bit; brute-forcing is
 * impractical and the endpoint is rate-limited.
 * @param {import('express').Request} req - Request with queueId.
 * @param {import('express').Response} res - HTTP response.
 * @returns {Promise<import('express').Response>} JSON response with the queue.
 */
async function recoverQueueById(req, res) {
  try {
    const queueId = (req.body && req.body.queueId) || req.query.queueId;
    if (!/^[a-f\d]{24}$/i.test(String(queueId || ''))) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_QUEUE_RECOVERY_CODE',
        data: null,
        message: 'รหัสคิวไม่ถูกต้อง',
      });
    }
    const queue = await Queue.findById(queueId)
      .select('queueNumber customerCount status createdAt calledAt seatedAt tableId sessionId preferredZone preferredTableId assignedTableId assignmentNote')
      .populate('tableId', 'tableNumber')
      .populate('preferredTableId', 'tableNumber zone');
    if (!queue) {
      return res.status(404).json({ success: false, code: 'QUEUE_NOT_FOUND', data: null, message: 'ไม่พบคิวนี้' });
    }
    return res.status(200).json({
      success: true,
      data: await getQueueStatus(queue),
      message: 'เปิดคิวสำเร็จ',
    });
  } catch (error) {
    console.error('Recover queue by id failed:', error);
    return res.status(500).json({ success: false, code: 'REQUEST_FAILED', data: null, message: 'ไม่สามารถเปิดคิวได้' });
  }
}

/**
 * Return all data needed to render an 80mm ticket, including the QR data URL.
 * Staff-only endpoint.
 * @param {import('express').Request} req - Request with queue id in route params.
 * @param {import('express').Response} res - HTTP response.
 * @returns {Promise<import('express').Response>} JSON response with ticket data.
 */
async function getTicketData(req, res) {
  try {
    const queue = await Queue.findById(req.params.id)
      .populate('tableId', 'tableNumber')
      .populate('preferredTableId', 'tableNumber zone');
    if (!queue) {
      return res.status(404).json({ success: false, code: 'QUEUE_NOT_FOUND', data: null, message: 'ไม่พบคิวนี้' });
    }

    const settings = await ShopSettings.findById('shop-settings')
      .select('restaurantName phone address logoUrl');
    const baseUrl = getBaseUrl(req);
    const ticketUrl = `${baseUrl}/queue.html?recover=${queue._id}`;
    const qrCodeData = await generateQRCode(ticketUrl);

    res.set('Cache-Control', 'no-store');
    return res.status(200).json({
      success: true,
      data: {
        _id: queue._id,
        queueNumber: queue.queueNumber,
        customerCount: queue.customerCount,
        customerName: queue.customerName || '',
        customerPhone: queue.customerPhone || '',
        status: queue.status,
        createdAt: queue.createdAt,
        calledAt: queue.calledAt,
        tableNumber: queue.tableId && queue.tableId.tableNumber ? queue.tableId.tableNumber : '',
        restaurantName: (settings && settings.restaurantName) || 'Smart Queue',
        phone: (settings && settings.phone) || '',
        address: (settings && settings.address) || '',
        logoUrl: (settings && settings.logoUrl) || '/assets/images/logo.png',
        ticketUrl,
        qrCodeData,
      },
      message: 'ดึงข้อมูลบัตรคิวสำเร็จ',
    });
  } catch (error) {
    console.error('Get ticket data failed:', error);
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
 * Customer cancels their own queue using the access token.
 * Allowed only for 'waiting' or 'called' status.
 * @param {import('express').Request} req - Request with queue id and accessToken.
 * @param {import('express').Response} res - HTTP response.
 * @returns {Promise<import('express').Response>} JSON response with the cancelled queue.
 */
async function cancelQueueByCustomer(req, res) {
  try {
    const queueId = req.params.id;
    const accessToken = (req.body && req.body.accessToken)
      || (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!queueId || !accessToken) {
      return res.status(400).json({ success: false, code: 'INVALID_QUEUE_RECOVERY_CODE', data: null, message: 'ไม่พบรหัสคิว' });
    }

    const queue = await Queue.findById(queueId).select('+accessTokenHash');
    if (!queue || !hasQueueAccess(queue, accessToken)) {
      return res.status(404).json({ success: false, code: 'QUEUE_NOT_FOUND', data: null, message: 'ไม่พบคิวหรือรหัสไม่ถูกต้อง' });
    }
    if (!['waiting', 'called'].includes(queue.status)) {
      return res.status(409).json({
        success: false,
        code: 'QUEUE_CANNOT_BE_CANCELLED',
        data: null,
        message: 'คิวนี้เริ่มใช้บริการหรือสิ้นสุดแล้ว จึงยกเลิกไม่ได้',
      });
    }

    const previousStatus = queue.status;
    const session = queue.sessionId ? await Session.findById(queue.sessionId) : null;

    const cancelledQueue = await Queue.findOneAndUpdate(
      { _id: queue._id, status: previousStatus },
      { $set: { status: 'cancelled' } },
      { new: true }
    );
    if (!cancelledQueue) {
      return res.status(409).json({ success: false, code: 'QUEUE_STATE_CHANGED', data: null, message: 'สถานะคิวเปลี่ยนไปแล้ว กรุณาโหลดใหม่' });
    }

    // Release reserved table if there was one.
    if (cancelledQueue.tableId) {
      await Table.updateOne(
        { _id: cancelledQueue.tableId, status: 'reserved', currentSessionId: null },
        { $set: { status: 'available', currentSessionId: null, reservedForQueueId: null } }
      );
    }
    // Delete the auto-created session if not yet paid.
    if (session && !session.isPaid) {
      await Session.deleteOne({ _id: session._id, isPaid: false });
    }

    const io = req.app.get('io');
    if (io) {
      io.to(`queue_${cancelledQueue._id}`).emit('queue_cancelled', { queueId: cancelledQueue._id });
      io.to('customer').emit('queue_board_updated');
      io.to('admin').to('waiter').emit('queue_board_updated');
      io.emit('table_board_updated');
    }
    return res.status(200).json({ success: true, data: cancelledQueue, message: 'ยกเลิกคิวสำเร็จ' });
  } catch (error) {
    console.error('Customer cancel queue failed:', error);
    return res.status(500).json({ success: false, code: 'REQUEST_FAILED', data: null, message: 'ไม่สามารถยกเลิกคิวได้ กรุณาลองใหม่' });
  }
}

async function getDisplayData(req, res) {
  try {
    const [called, waiting, totalWaiting] = await Promise.all([
      Queue.find({ status: 'called' })
        .populate('tableId', 'tableNumber zone')
        .populate('assignedTableId', 'tableNumber zone')
        .sort({ calledAt: -1 })
        .limit(20)
        .lean(),
      Queue.find({ status: 'waiting' })
        .select('queueNumber customerCount preferredZone createdAt')
        .sort({ createdAt: 1 })
        .limit(50)
        .lean(),
      Queue.countDocuments({ status: 'waiting' }),
    ]);

    // Never hide a called queue just because its table reference is missing.
    // The TV board shows it with a "assigning a table" fallback instead.
    const nowServing = called.map((q) => {
      const table = (q.tableId && q.tableId.tableNumber)
        ? q.tableId
        : (q.assignedTableId && q.assignedTableId.tableNumber ? q.assignedTableId : null);
      return {
        _id: String(q._id),
        queueNumber: q.queueNumber,
        status: q.status,
        tableNumber: (table && table.tableNumber) || null,
        zone: (table && table.zone) || q.preferredZone || null,
        customerCount: q.customerCount,
        calledAt: q.calledAt,
      };
    });

    const waitingList = waiting.map((q) => ({
      _id: String(q._id),
      queueNumber: q.queueNumber,
      customerCount: q.customerCount,
      preferredZone: q.preferredZone || null,
      createdAt: q.createdAt,
    }));

    res.set('Cache-Control', 'no-store');
    return res.status(200).json({
      success: true,
      data: {
        nowServing,
        waiting: waitingList,
        totalWaiting,
        updatedAt: new Date().toISOString(),
      },
      message: 'ดึงข้อมูลจอแสดงคิวสำเร็จ',
    });
  } catch (error) {
    console.error('Get display data failed:', error);
    return res.status(500).json({
      success: false,
      code: 'REQUEST_FAILED',
      data: null,
      message: 'ไม่สามารถโหลดข้อมูลจอแสดงคิวได้',
    });
  }
}

module.exports = {
  createQueue, getQueues, callQueue, cancelQueue, cancelQueueByCustomer,
  getQueueById, recoverQueue, recoverQueueById, confirmQueue,
  getNextQueueNumber, getEntryQRCode, getTicketData,
  findTableForQueue, zoneForCount, ZONE_RULES, MAX_PARTY_SIZE,
  getDisplayData,
};