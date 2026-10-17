// ใช้ Public DNS สำหรับค้นหา SRV record ของ MongoDB Atlas
const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);

const mongoose = require('mongoose');

const DEFAULT_DB_NAME = process.env.DB_NAME || 'Buffetdb';

// Cache connection สำหรับ serverless (Vercel)
let cachedConnection = global.__mongoConnection || null;
if (!cachedConnection) {
  cachedConnection = null;
}

mongoose.connection.on('connected', () => {
  console.log('MongoDB connection established.');
});
mongoose.connection.on('error', (error) => {
  console.error('MongoDB connection error:', error.message);
});
mongoose.connection.on('disconnected', () => {
  console.warn('MongoDB connection disconnected.');
});

function ensureDatabaseName(uri) {
  if (!uri) return uri;
  const [base, query] = uri.split('?');
  const slashIndex = base.indexOf('/');
  const afterHost = slashIndex >= 0 ? base.slice(slashIndex + 1) : '';
  if (afterHost && afterHost.length > 0) {
    return query ? `${base}?${query}` : base;
  }
  const normalizedBase = base.endsWith('/') ? `${base}${DEFAULT_DB_NAME}` : `${base}/${DEFAULT_DB_NAME}`;
  return query ? `${normalizedBase}?${query}` : normalizedBase;
}

async function connectDB() {
  const { MONGO_URI } = process.env;

  if (!MONGO_URI) {
    throw new Error('MONGO_URI is not configured.');
  }

  // ถ้ามี connection อยู่แล้ว → ใช้ต่อ (Serverless reuse)
  if (cachedConnection && mongoose.connection.readyState === 1) {
    return cachedConnection;
  }

  const uri = ensureDatabaseName(MONGO_URI);

  try {
    const connection = await mongoose.connect(uri, {
      dbName: DEFAULT_DB_NAME,
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      family: 4,
    });
    cachedConnection = connection;
    global.__mongoConnection = connection;
    const activeDb = mongoose.connection.db?.databaseName || DEFAULT_DB_NAME;
    console.log(`MongoDB connected: ${connection.connection.host}`);
    console.log(`MongoDB database: ${activeDb}`);
    return connection;
  } catch (error) {
    console.error('MongoDB connection failed:', error.message);
    throw error;
  }
}

module.exports = connectDB;