// Import JWT verification to keep staff-only Socket.io rooms restricted.
const jwt = require('jsonwebtoken');
const Session = require('../models/Session');
const Queue = require('../models/Queue');
const { hasQueueAccess } = require('../utils/queueAccess');

const STAFF_ROLES = new Set(['admin', 'manager', 'kitchen', 'waiter']);
const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;
let socketServer;
let expirationInterval;
const expirationWarnings = new Map();

/**
 * Initialize Socket.io connection, room membership, and disconnect handling.
 * @param {import('socket.io').Server} io - Socket.io server instance.
 * @returns {import('socket.io').Server} The configured Socket.io server.
 */
function initSocket(io) {
  socketServer = io;
  if (expirationInterval) clearInterval(expirationInterval);

  io.use((socket, next) => {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (!token) {
      return next();
    }
    if (!process.env.JWT_SECRET) {
      return next(new Error('Socket authentication is not configured.'));
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.data.user = decoded;
      return next();
    } catch (error) {
      return next(new Error('Socket authentication token is invalid.'));
    }
  });

  io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id}`);
    let lastCheckoutRequestAt = 0;

    // Customers may join the public customer room; staff rooms require a valid role token.
    socket.on('joinRoom', async (roomOrPayload, acknowledge) => {
      const requestedRoom = typeof roomOrPayload === 'string'
        ? roomOrPayload
        : roomOrPayload && roomOrPayload.room;
      const roleToRoom = {
        admin: 'admin',
        manager: 'admin',
        kitchen: 'kitchen',
        waiter: 'waiter',
        customer: 'customer',
      };

      try {
        if (!Object.values(roleToRoom).includes(requestedRoom)) {
          if (typeof acknowledge === 'function') {
            acknowledge({ success: false, message: 'ไม่พบห้องที่ร้องขอ' });
          }
          return;
        }

        if (requestedRoom !== 'customer') {
          const user = socket.data.user;
          if (!user || !STAFF_ROLES.has(user.role) || roleToRoom[user.role] !== requestedRoom) {
            if (typeof acknowledge === 'function') {
              acknowledge({ success: false, message: 'ไม่มีสิทธิ์เข้าห้องนี้' });
            }
            return;
          }
        }

        await socket.join(requestedRoom);
        if (typeof acknowledge === 'function') {
          acknowledge({ success: true, room: requestedRoom });
        }
      } catch (error) {
        console.error('Socket room join failed:', error);
        if (typeof acknowledge === 'function') {
          acknowledge({ success: false, message: 'ไม่สามารถเข้าห้องได้' });
        }
      }
    });

    // Join a session-specific customer room after validating its MongoDB ID shape.
    socket.on('joinSession', async (sessionId, acknowledge) => {
      try {
        if (typeof sessionId !== 'string' || !OBJECT_ID_PATTERN.test(sessionId)) {
          if (typeof acknowledge === 'function') {
            acknowledge({ success: false, message: 'รูปแบบ Session ID ไม่ถูกต้อง' });
          }
          return;
        }

        if (!await Session.exists({ _id: sessionId })) {
          if (typeof acknowledge === 'function') {
            acknowledge({ success: false, message: 'ไม่พบเซสชัน' });
          }
          return;
        }

        const room = `customer_${sessionId}`;
        await socket.join(room);
        if (typeof acknowledge === 'function') {
          acknowledge({ success: true, room });
        }
      } catch (error) {
        console.error('Socket session room join failed:', error);
        if (typeof acknowledge === 'function') {
          acknowledge({ success: false, message: 'ไม่สามารถเข้าห้องเซสชันได้' });
        }
      }
    });

    // Join the queue-specific room after validating its MongoDB ID shape.
    socket.on('joinQueue', async (request, acknowledge) => {
      try {
        const queueId = typeof request === 'string' ? request : request && request.queueId;
        const accessToken = typeof request === 'string' ? request : request && request.accessToken;
        if (typeof queueId !== 'string' || !OBJECT_ID_PATTERN.test(queueId)) {
          if (typeof acknowledge === 'function') {
            acknowledge({ success: false, message: 'รูปแบบ Queue ID ไม่ถูกต้อง' });
          }
          return;
        }

        const queue = await Queue.findById(queueId).select('+accessTokenHash');
        if (!queue || !hasQueueAccess(queue, accessToken || String(queue._id))) {
          if (typeof acknowledge === 'function') {
            acknowledge({ success: false, message: 'ไม่พบคิวหรือรหัสกู้คืนไม่ถูกต้อง' });
          }
          return;
        }

        const room = `queue_${queueId}`;
        await socket.join(room);
        if (typeof acknowledge === 'function') {
          acknowledge({ success: true, room });
        }
      } catch (error) {
        console.error('Socket queue room join failed:', error);
        if (typeof acknowledge === 'function') {
          acknowledge({ success: false, message: 'ไม่สามารถเข้าห้องคิวได้' });
        }
      }
    });

    // Forward a customer's checkout request to authenticated staff rooms.
    socket.on('checkout_requested', async (request, acknowledge) => {
      const sessionId = request && request.sessionId;
      if (typeof sessionId !== 'string' || !OBJECT_ID_PATTERN.test(sessionId)) {
        if (typeof acknowledge === 'function') {
          acknowledge({ success: false, message: 'รูปแบบ Session ID ไม่ถูกต้อง' });
        }
        return;
      }

      if (Date.now() - lastCheckoutRequestAt < 5000) {
        if (typeof acknowledge === 'function') {
          acknowledge({ success: false, message: 'กรุณารอสักครู่ก่อนเรียกพนักงานอีกครั้ง' });
        }
        return;
      }

      try {
        const session = await Session.findById(sessionId).populate('tableId', 'tableNumber');
        if (!session || session.status !== 'active') {
          if (typeof acknowledge === 'function') {
            acknowledge({ success: false, message: 'ไม่พบเซสชันที่กำลังใช้งาน' });
          }
          return;
        }

        lastCheckoutRequestAt = Date.now();
        io.to('admin').to('waiter').emit('checkout_requested', {
          sessionId: session._id,
          tableNumber: session.tableId && session.tableId.tableNumber,
          requestedAt: new Date().toISOString(),
        });
        if (typeof acknowledge === 'function') {
          acknowledge({ success: true, message: 'ส่งคำขอเรียกพนักงานแล้ว' });
        }
      } catch (error) {
        console.error('Checkout request failed:', error);
        if (typeof acknowledge === 'function') {
          acknowledge({ success: false, message: 'ไม่สามารถส่งคำขอได้ กรุณาลองอีกครั้ง' });
        }
      }
    });

    // Log when a socket disconnects from the application.
    socket.on('disconnect', (reason) => {
      console.log(`Socket disconnected: ${socket.id} (${reason})`);
    });
  });

  /**
   * Notify customers once when their session enters each final time window.
   */
  async function notifyExpiringSessions() {
    const now = new Date();
    const cutoff = new Date(now.getTime() + 15 * 60 * 1000);
    try {
      const sessions = await Session.find({
        status: 'active',
        endTime: { $gt: now, $lte: cutoff },
      }).select('_id endTime');
      const currentIds = new Set(sessions.map((session) => session._id.toString()));

      for (const [sessionId] of expirationWarnings) {
        if (!currentIds.has(sessionId)) expirationWarnings.delete(sessionId);
      }

      for (const session of sessions) {
        const sessionId = session._id.toString();
        const remainingMs = session.endTime.getTime() - now.getTime();
        const thresholds = expirationWarnings.get(sessionId) || new Set();
        const warningWindows = remainingMs <= 5 * 60 * 1000 ? [15, 5] : [15];

        for (const minutes of warningWindows) {
          if (thresholds.has(minutes)) continue;
          io.to(`customer_${sessionId}`).emit('session_expiring', {
            sessionId,
            minutes,
            remainingMs,
            message: minutes === 5
              ? 'เหลือเวลาไม่เกิน 5 นาที กรุณาเตรียมชำระเงิน'
              : 'เหลือเวลาไม่เกิน 15 นาที',
          });
          thresholds.add(minutes);
        }
        expirationWarnings.set(sessionId, thresholds);
      }
    } catch (error) {
      console.error('Session expiry notification failed:', error);
    }
  }

  expirationInterval = setInterval(notifyExpiringSessions, 30 * 1000);
  if (typeof expirationInterval.unref === 'function') expirationInterval.unref();
  notifyExpiringSessions();

  return io;
}

/**
 * Emit an event with a payload to one Socket.io room.
 * @param {string} room - Target room name.
 * @param {string} event - Event name to emit.
 * @param {unknown} data - Event payload.
 * @returns {void} Emits the event to the selected room.
 */
function emitToRoom(room, event, data) {
  if (!socketServer) {
    throw new Error('Socket.io has not been initialized.');
  }
  if (typeof room !== 'string' || !room || typeof event !== 'string' || !event) {
    throw new TypeError('A room name and event name are required.');
  }
  socketServer.to(room).emit(event, data);
}

/**
 * Emit an event with a payload to all connected Socket.io clients.
 * @param {string} event - Event name to emit.
 * @param {unknown} data - Event payload.
 * @returns {void} Emits the event to all connected clients.
 */
function emitToAll(event, data) {
  if (!socketServer) {
    throw new Error('Socket.io has not been initialized.');
  }
  if (typeof event !== 'string' || !event) {
    throw new TypeError('An event name is required.');
  }
  socketServer.emit(event, data);
}

// Export Socket.io initialization and reusable emission helpers.
module.exports = { initSocket, emitToRoom, emitToAll };
