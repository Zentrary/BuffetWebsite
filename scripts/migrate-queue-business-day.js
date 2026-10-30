#!/usr/bin/env node
// Migrate existing queues to business-day numbering.
//
// Queue numbers now restart at Q001 on every business day, so each queue needs a
// `businessDate` + `sequence`, the counter document becomes per-day, and the old
// globally-unique index on `queueNumber` must be replaced by
// { businessDate, queueNumber }.
//
// Usage:
//   node scripts/migrate-queue-business-day.js            # dry run (default)
//   node scripts/migrate-queue-business-day.js --apply    # write the changes
require('dotenv').config();

const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Queue = require('../models/Queue');
const ShopSettings = require('../models/ShopSettings');
const { repairQueueIndexes } = require('../services/queueIndexes');
const { LEGACY_INDEX_NAME } = require('../services/queueNumbering');
const { getBusinessDateKey } = require('../utils/businessDay');

async function main() {
  const apply = process.argv.includes('--apply');
  await connectDB();

  const settings = (await ShopSettings.findById('shop-settings').lean()) || {};
  console.log(`Shop hours: ${settings.openTime || '10:30'} -> ${settings.closeTime || '03:00'} (${settings.timezone || 'Asia/Bangkok'})`);

  const pending = await Queue.countDocuments({ $or: [{ businessDate: null }, { businessDate: { $exists: false } }] });
  const indexes = await Queue.collection.indexes();
  const legacy = indexes.find((index) => index.name === LEGACY_INDEX_NAME && index.unique && !index.partialFilterExpression);
  console.log(`Queues missing a business date: ${pending}`);
  console.log(`Legacy unique index on queueNumber: ${legacy ? 'present (will be dropped)' : 'not found'}`);

  if (!apply) {
    // Show what the per-day counters will look like before writing anything.
    const sample = await Queue.find({ $or: [{ businessDate: null }, { businessDate: { $exists: false } }] })
      .select('queueNumber createdAt')
      .sort({ createdAt: 1 })
      .limit(2000)
      .lean();
    const perDay = new Map();
    for (const queue of sample) {
      const date = getBusinessDateKey(settings, new Date(queue.createdAt || Date.now()));
      const seq = Number(String(queue.queueNumber || '').replace(/\D/g, '')) || 0;
      if (!perDay.has(date) || perDay.get(date) < seq) perDay.set(date, seq);
    }
    for (const [date, seq] of perDay) console.log(`  ${date}: highest sequence ${seq}`);
    console.log('\nDry run only. Re-run with --apply to migrate.');
    return;
  }

  // Same repair the app runs on connect: backfill, drop the legacy index, sync.
  const summary = await repairQueueIndexes({ logger: console });
  console.log(`Backfilled ${summary.backfilled} queue(s); legacy index dropped: ${summary.droppedLegacyIndex}; indexes synced: ${summary.indexesSynced}`);
}

main()
  .catch((error) => {
    console.error('Migration failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close().catch(() => {});
  });
