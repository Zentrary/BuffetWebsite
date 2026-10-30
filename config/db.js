// Keep the system resolver on Vercel. Local environments may use the public
// resolvers below to work around ISP DNS failures for MongoDB SRV records.
const dns = require('dns');
if (!process.env.VERCEL) {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
}

const mongoose = require('mongoose');
const { repairQueueIndexesOnce } = require('../services/queueIndexes');

const DEFAULT_DB_NAME = process.env.DB_NAME || 'Buffetdb';
const connectionCache = global.__buffetMongoCache || { connection: null, promise: null };
global.__buffetMongoCache = connectionCache;

mongoose.connection.on('connected', () => {
  console.log('MongoDB connection established.');
});
mongoose.connection.on('error', (error) => {
  console.error('MongoDB connection error:', error.message);
});
mongoose.connection.on('disconnected', () => {
  connectionCache.connection = null;
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

  // Reuse an established connection, and share an in-flight connection attempt
  // between concurrent Vercel requests in the same warm function instance.
  if (mongoose.connection.readyState === 1) {
    return connectionCache.connection || mongoose;
  }
  if (connectionCache.promise) {
    return connectionCache.promise;
  }

  const uri = ensureDatabaseName(MONGO_URI);
  const pendingConnection = mongoose.connect(uri, {
    dbName: DEFAULT_DB_NAME,
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 45000,
    family: 4,
  }).then((connection) => {
    connectionCache.connection = connection;
    const activeDb = mongoose.connection.db?.databaseName || DEFAULT_DB_NAME;
    console.log(`MongoDB connected: ${connection.connection.host}`);
    console.log(`MongoDB database: ${activeDb}`);
    // Queue numbers restart per business day, which requires the legacy global
    // unique index on queueNumber to be gone. Repair it (and backfill old rows)
    // in the background so a deploy never leaves customers unable to take a queue.
    repairQueueIndexesOnce();
    return connection;
  }).catch((error) => {
    connectionCache.connection = null;
    console.error('MongoDB connection failed:', error.message);
    throw error;
  });

  connectionCache.promise = pendingConnection;
  try {
    return await pendingConnection;
  } finally {
    if (connectionCache.promise === pendingConnection) {
      connectionCache.promise = null;
    }
  }
}

module.exports = connectDB;
