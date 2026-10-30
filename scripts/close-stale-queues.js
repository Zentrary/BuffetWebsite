#!/usr/bin/env node
// Close queue entries that got stuck in "seated" before the lifecycle fix.
//
// Usage:
//   node scripts/close-stale-queues.js            # dry run (default, prints only)
//   node scripts/close-stale-queues.js --apply    # actually close the queues
//
// A seated queue is considered stale when its dining session is missing, paid,
// cancelled or completed, or when the session never went live at all.
require('dotenv').config();

const connectDB = require('../config/db');
const mongoose = require('mongoose');
const Session = require('../models/Session');
const Queue = require('../models/Queue');
const { findStaleSeatedQueueIds } = require('../services/queueLifecycle');

async function main() {
  const apply = process.argv.includes('--apply');
  await connectDB();

  const staleIds = await findStaleSeatedQueueIds(Session);
  const total = await Queue.countDocuments({ status: 'seated' });
  console.log(`Seated queues: ${total}`);
  console.log(`Stale seated queues: ${staleIds.length}`);

  if (!staleIds.length) {
    console.log('Nothing to do. All seated queues still have a live dining session.');
    return;
  }

  const preview = await Queue.find({ _id: { $in: staleIds } })
    .select('queueNumber seatedAt sessionId createdAt')
    .sort({ createdAt: 1 })
    .lean();
  for (const queue of preview.slice(0, 50)) {
    console.log(`  ${queue.queueNumber} seated=${queue.seatedAt ? queue.seatedAt.toISOString() : '-'} session=${queue.sessionId || '-'}`);
  }
  if (preview.length > 50) console.log(`  … and ${preview.length - 50} more`);

  if (!apply) {
    console.log('\nDry run only. Re-run with --apply to close these queues.');
    return;
  }

  const result = await Queue.updateMany(
    { _id: { $in: staleIds }, status: 'seated' },
    { $set: { status: 'completed', completedAt: new Date() } }
  );
  console.log(`Closed ${result.modifiedCount || 0} seated queue(s).`);
}

main()
  .catch((error) => {
    console.error('Failed to close stale queues:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close().catch(() => {});
  });
