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
const QueueCounter = require('../models/QueueCounter');
const ShopSettings = require('../models/ShopSettings');
const { getBusinessDateKey } = require('../utils/businessDay');

async function main() {
  const apply = process.argv.includes('--apply');
  await connectDB();

  const settings = (await ShopSettings.findById('shop-settings').lean()) || {};
  console.log(`Shop hours: ${settings.openTime || '10:30'} -> ${settings.closeTime || '03:00'} (${settings.timezone || 'Asia/Bangkok'})`);

  const queues = await Queue.find({ $or: [{ businessDate: null }, { businessDate: { $exists: false } }] })
    .select('queueNumber createdAt sequence')
    .sort({ createdAt: 1 })
    .lean();
  console.log(`Queues missing a business date: ${queues.length}`);

  const perDay = new Map();
  const updates = [];
  for (const queue of queues) {
    const businessDate = getBusinessDateKey(settings, new Date(queue.createdAt || Date.now()));
    const sequence = Number(String(queue.queueNumber || '').replace(/\D/g, '')) || null;
    updates.push({ id: queue._id, businessDate, sequence });
    if (sequence && (!perDay.has(businessDate) || perDay.get(businessDate) < sequence)) {
      perDay.set(businessDate, sequence);
    }
  }

  for (const [date, seq] of perDay) console.log(`  ${date}: highest sequence ${seq}`);
  // Counters that already exist must not be lowered.
  const existing = await QueueCounter.find({ _id: /^queue-number:/ }).lean();
  const existingByDate = new Map(existing.map((row) => [row._id.replace('queue-number:', ''), row.sequence]));
  const counterPlan = [...perDay.entries()].map(([date, seq]) => ({
    id: `queue-number:${date}`,
    sequence: Math.max(seq, existingByDate.get(date) || 0),
  }));
  for (const row of counterPlan) console.log(`  counter ${row.id} -> ${row.sequence}`);

  const indexes = await Queue.collection.indexes();
  const legacy = indexes.find((index) => index.name === 'queueNumber_1');
  console.log(`Legacy unique index on queueNumber: ${legacy ? 'present (will be dropped)' : 'not found'}`);

  if (!apply) {
    console.log('\nDry run only. Re-run with --apply to migrate.');
    return;
  }

  if (updates.length) {
    const result = await Queue.bulkWrite(updates.map((row) => ({
      updateOne: {
        filter: { _id: row.id },
        update: { $set: { businessDate: row.businessDate, sequence: row.sequence } },
      },
    })));
    console.log(`Updated ${result.modifiedCount || 0} queue(s).`);
  }

  for (const row of counterPlan) {
    await QueueCounter.findOneAndUpdate(
      { _id: row.id },
      { $max: { sequence: row.sequence } },
      { upsert: true }
    );
  }
  console.log(`Counters written: ${counterPlan.length}`);

  if (legacy) {
    await Queue.collection.dropIndex('queueNumber_1');
    console.log('Dropped legacy index queueNumber_1 ');
  }
  // Guard against duplicated numbers inside the same day before creating the index.
  const duplicate = await Queue.aggregate([
    { $match: { businessDate: { $type: 'string' } } },
    { $group: { _id: { businessDate: '$businessDate', queueNumber: '$queueNumber' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: 5 },
  ]);
  if (duplicate.length) {
    console.warn('Duplicate numbers per business day detected — fix these before the unique index can be created:');
    duplicate.forEach((row) => console.warn(`  ${row._id.businessDate} ${row._id.queueNumber} x${row.count}`));
    return;
  }
  await Queue.syncIndexes();
  console.log('Indexes synchronised (businessDate + queueNumber).');
}

main()
  .catch((error) => {
    console.error('Migration failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close().catch(() => {});
  });
