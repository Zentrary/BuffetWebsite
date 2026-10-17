// One-time migration: rename zones indoor/outdoor/vip -> small/medium/large
// and backfill minCapacity based on zone capacity rules.
//
// Usage:  node scripts/migrate-zones.js
//
// Safe to run more than once; already-migrated rows are skipped.

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Table = require('../models/Table');
const Queue = require('../models/Queue');

const ZONE_RENAME = {
  indoor: 'small',
  outdoor: 'medium',
  vip: 'large',
};

const ZONE_RULES = {
  small: { minCapacity: 1, maxCapacity: 2 },
  medium: { minCapacity: 3, maxCapacity: 6 },
  large: { minCapacity: 7, maxCapacity: 12 },
};

async function migrateTables() {
  const report = { renamed: 0, minCapacityBackfilled: 0, capacityNormalized: 0, skipped: 0 };

  const tables = await Table.find({}).lean();
  for (const table of tables) {
    const updates = {};

    // 1) Rename zone
    const newZone = ZONE_RENAME[table.zone] || table.zone;
    if (ZONE_RENAME[table.zone]) {
      updates.zone = newZone;
    }

    // 2) Backfill minCapacity
    if (typeof table.minCapacity !== 'number' || table.minCapacity === 1) {
      const rule = ZONE_RULES[newZone];
      if (rule) {
        updates.minCapacity = rule.minCapacity;
      }
    }

    // 3) Warn if capacity is above zone max
    const rule = ZONE_RULES[newZone];
    if (rule && table.capacity > rule.maxCapacity) {
      console.warn(
        `[migrate] table ${table.tableNumber} capacity ${table.capacity} exceeds zone max ${rule.maxCapacity} for ${newZone}`
      );
    }

    if (Object.keys(updates).length === 0) {
      report.skipped += 1;
      continue;
    }

    await Table.updateOne({ _id: table._id }, { $set: updates });
    if (updates.zone) report.renamed += 1;
    if (updates.minCapacity) report.minCapacityBackfilled += 1;
  }

  return report;
}

async function migrateQueues() {
  // Existing queues have no preferredZone; leave null so staff assigns by count.
  const result = await Queue.updateMany(
    { preferredZone: { $exists: false } },
    { $set: { preferredZone: null, autoAssign: true } }
  );
  return { updated: result.modifiedCount || 0 };
}

async function main() {
  await connectDB();
  try {
    console.log('[migrate-zones] starting');

    const tableReport = await migrateTables();
    console.log('[migrate-zones] tables:', JSON.stringify(tableReport));

    const queueReport = await migrateQueues();
    console.log('[migrate-zones] queues:', JSON.stringify(queueReport));

    const remainingOld = await Table.countDocuments({
      zone: { $in: Object.keys(ZONE_RENAME) },
    });
    if (remainingOld > 0) {
      console.warn(`[migrate-zones] still ${remainingOld} tables with old zone names — rerun`);
    } else {
      console.log('[migrate-zones] complete');
    }
  } catch (error) {
    console.error('[migrate-zones] failed:', error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

main();