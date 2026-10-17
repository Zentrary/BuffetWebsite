// Load environment variables before initializing application modules.
require('dotenv').config();

// Import the libraries and database connection required by the server.
const express = require('express');
const cors = require('cors');
const http = require('http');
const os = require('os');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const connectDB = require('./config/db');
const { initSocket } = require('./sockets/socketHandler');
const authRoutes = require('./routes/authRoutes');
const queueRoutes = require('./routes/queueRoutes');
const sessionRoutes = require('./routes/sessionRoutes');
const menuRoutes = require('./routes/menuRoutes');
const orderRoutes = require('./routes/orderRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const feedbackRoutes = require('./routes/feedbackRoutes');
const tableRoutes = require('./routes/tableRoutes');
const reportRoutes = require('./routes/reportRoutes');
const settingsRoutes = require('./routes/settingsRoutes');
const adminRoutes = require('./routes/adminRoutes');
const { startShopSchedule } = require('./services/shopSchedule');
const { startReconcileLoop } = require('./services/reconcileState');
const { errorHandler, notFound } = require('./middlewares/errorHandler');
const { rateLimit, keyByIp } = require('./middlewares/rateLimit');

// ค้นหา IPv4 ของเครื่องที่เชื่อมต่อเครือข่าย เพื่อแสดง URL สำหรับมือถือ
function getLanIPv4() {
  const interfaces = os.networkInterfaces();
  for (const addresses of Object.values(interfaces)) {
    const address = (addresses || []).find((item) => (
      (item.family === 'IPv4' || item.family === 4) && !item.internal
    ));
    if (address) return address.address;
  }
  return null;
}

// Create the Express application and its HTTP server for Socket.io.
const app = express();
const httpServer = http.createServer(app);

// Configure Socket.io on the same HTTP server as Express.
const io = new Server(httpServer, {
  cors: {
    origin: process.env.CLIENT_ORIGIN || '*',
    methods: ['GET', 'POST'],
  },
});

// Make Socket.io available to request handlers through req.app.get('io').
app.set('io', io);

// Register the required request parsing, cross-origin, and static-file middleware.
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(express.static('public'));
app.use('/api', rateLimit({
  name: 'api-global',
  windowMs: 60_000,
  max: 300,
  keyGenerator: keyByIp,
  message: 'คุณเรียกใช้งานบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่',
}));

// Mount each feature router under its API prefix.
app.use('/api/auth', authRoutes);
app.use('/api/queue', queueRoutes);
app.use('/api/session', sessionRoutes);
app.use('/api/menu', menuRoutes);
app.use('/api/order', orderRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/table', tableRoutes);
app.use('/api/report', reportRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/admin', adminRoutes);

// Register not-found handling after all routes and error handling last.
app.use(notFound);
app.use(errorHandler);

// Connect to MongoDB before accepting incoming HTTP and Socket.io traffic.
async function startServer() {
  const port = Number.parseInt(process.env.PORT, 10) || 3000;

  try {
    await connectDB();
    await new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(port, '0.0.0.0', () => {
        httpServer.removeListener('error', reject);
        console.log(`Server listening on port ${port}`);
        console.log(`Local:   http://localhost:${port}`);
        const lanIPv4 = getLanIPv4();
        if (lanIPv4) {
          console.log(`LAN:     http://${lanIPv4}:${port}`);
        } else {
          console.warn('LAN:     No non-internal IPv4 network interface was found.');
        }
        if (process.env.PUBLIC_BASE_URL && process.env.PUBLIC_BASE_URL.trim()) {
          console.log(`Public:  ${process.env.PUBLIC_BASE_URL.trim().replace(/\/+$/, '')}`);
        } else {
          console.log('Public:  Use a reverse-proxy HTTPS tunnel; QR links follow its forwarded host and protocol.');
        }
        // Initialize socket notifications only after the server has bound its port.
        initSocket(io);
        startShopSchedule(io);
        startReconcileLoop(io);
        resolve();
      });
    });
  } catch (error) {
    if (error.code === 'EADDRINUSE') {
      console.error(`Server startup failed: port ${port} is already in use. Stop the other server or set a different PORT in .env.`);
    } else {
      console.error('Server startup failed:', error.message);
    }
    if (mongoose.connection.readyState !== 0) {
      try {
        await mongoose.disconnect();
      } catch (disconnectError) {
        console.error('MongoDB disconnect after startup failure failed:', disconnectError.message);
      }
    }
    process.exitCode = 1;
  }
}

// Start the application and expose a rejected startup promise as a process error.
if (require.main === module) {
  startServer().catch((error) => {
    console.error('Unexpected startup error:', error);
    process.exitCode = 1;
  });
} else {
  // บน Vercel: เชื่อมต่อ DB แต่ไม่ listen
  connectDB().catch((error) => {
    console.error('MongoDB connection failed:', error.message);
  });
}

module.exports = app;