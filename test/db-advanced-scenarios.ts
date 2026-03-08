/**
 * test/db-advanced-scenarios.test.ts
 * Advanced integration tests for TTL, WAL recovery, Indexing, and Checkpoints.
 */

import path from 'path';
import fs from 'fs/promises';
import assert from 'assert';
import { appendWalEntry, getWalPath, initializeWal } from '../src/lib/wal-manager.js';
import { WiseJSON } from '../src/lib/index.js';
import { cleanupExpiredDocs } from '../src/lib/collection/ttl.js';
import logger from '../src/lib/logger.js';

import { fileURLToPath } from 'url';

// --- ESM Compatibility ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_ROOT_PATH = path.resolve(__dirname, 'db-advanced-test-data');
const COLLECTION_NAME = 'advanced_tests_col';

/**
 * Interface for test documents with TTL support.
 */
interface AdvancedDoc {
  _id: string;
  data?: string;
  name?: string;
  value?: number;
  text?: string;
  expireAt?: number | string | null;
  ttl?: number;
  createdAt?: string;
}

/**
 * Clean up database directory helper.
 */
async function cleanUpDbDirectory(dbPath: string): Promise<void> {
  try {
    const exists = await fs.stat(dbPath).then(() => true).catch(() => false);
    if (exists) {
      await fs.rm(dbPath, { recursive: true, force: true });
    }
  } catch (error: any) {
    if (error.code !== 'ENOENT') {
      console.error(`[Test Cleanup] Error removing directory ${dbPath}:`, error);
    }
  }
}

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

/**
 * Test 1: TTL Edge Cases
 * Verifies how the database handles expired, invalid, and null TTL values.
 */
async function testTtlEdgeCases(): Promise<void> {
  console.log('  --- Running TTL Edge Cases Test ---');
  const dbPath = path.join(DB_ROOT_PATH, 'ttl_edge');
  await cleanUpDbDirectory(dbPath);

  const db = new WiseJSON(dbPath, { ttlCleanupIntervalMs: 20000 });
  await db.init();
  const col = await db.getCollection<AdvancedDoc>(COLLECTION_NAME);

  const now = Date.now();
  const createdAtISO = new Date(now).toISOString();

  // Insert various TTL scenarios
  await col.insert({ _id: 'expired_past', data: 'past', expireAt: now - 10000 });
  await col.insert({ _id: 'invalid_expire', data: 'invalid', expireAt: 'not-a-date' as any });
  await col.insert({ _id: 'ttl_zero', data: 'zero_ttl', ttl: 0, createdAt: new Date(now - 1).toISOString() });
  await col.insert({ _id: 'ttl_short', data: 'short_ttl', ttl: 200, createdAt: createdAtISO });
  await col.insert({ _id: 'normal_doc', data: 'normal' });
  await col.insert({ _id: 'null_expire', data: 'null_expire', expireAt: null });
  await col.insert({ _id: 'undefined_ttl', data: 'undefined_ttl', ttl: undefined, createdAt: createdAtISO });

  // Internal document map should have 7 items before logic filtering
  assert.strictEqual((col as any).documents.size, 7, 'Initial raw document count in map should be 7');
  assert.strictEqual(await col.count(), 5, 'Count after first cleanup (expired_past, ttl_zero removed)');

  await sleep(300);
  cleanupExpiredDocs((col as any).documents, (col as any)._indexManager);

  assert.strictEqual(await col.count(), 4, 'Final count after short TTL expired and explicit cleanup');
  assert.strictEqual(await col.findOne({ _id: 'expired_past' }), null, 'Document with past expireAt should be removed');

  const docInvalid = await col.findOne({ _id: 'invalid_expire' });
  assert.ok(docInvalid, 'Document with invalid expireAt should remain');

  await db.close();
  await cleanUpDbDirectory(dbPath);
  console.log('  --- TTL Edge Cases Test PASSED ---');
}

/**
 * Test 2: Corrupted WAL Recovery
 * Ensures the WAL manager can skip corrupted lines and recover valid operations.
 */
async function testCorruptedWalRecovery(): Promise<void> {
  console.log('  --- Running Corrupted WAL Recovery Test ---');
  const dbPath = path.join(DB_ROOT_PATH, 'wal_corrupt');
  await cleanUpDbDirectory(dbPath);

  const colDir = path.join(dbPath, COLLECTION_NAME);
  await fs.mkdir(colDir, { recursive: true });

  const walPath = getWalPath(colDir, COLLECTION_NAME);
  await initializeWal(walPath, colDir, logger);

  // Manually build a WAL with a corrupted line
  await appendWalEntry(walPath, { op: 'INSERT', doc: { _id: 'doc1', name: 'Valid Doc 1', value: 10 } }, logger);
  await appendWalEntry(walPath, { op: 'INSERT', doc: { _id: 'doc2', name: 'Valid Doc 2', value: 20 } }, logger);
  await fs.appendFile(walPath, 'this is not a valid json line that will be skipped\n', 'utf8');
  await appendWalEntry(walPath, { op: 'INSERT', doc: { _id: 'doc3', name: 'Valid Doc 3 After Corrupt', value: 30 } }, logger);
  await appendWalEntry(walPath, { op: 'UPDATE', id: 'doc1', data: { name: 'Updated Doc 1', value: 15 } }, logger);
  await appendWalEntry(walPath, { op: 'REMOVE', id: 'doc2' }, logger);

  const db = new WiseJSON(dbPath, { walReadOptions: { recover: true, strict: false } });
  await db.init();
  const col = await db.getCollection<AdvancedDoc>(COLLECTION_NAME);

  assert.strictEqual(await col.count(), 2, 'Should recover 2 documents (doc1 updated, doc3 inserted)');

  const doc1 = await col.findOne({ _id: 'doc1' });
  assert.strictEqual(doc1?.name, 'Updated Doc 1', 'doc1 should be correctly updated');

  await db.close();
  await cleanUpDbDirectory(dbPath);
  console.log('  --- Corrupted WAL Recovery Test PASSED ---');
}

/**
 * Test 3: Index Edge Cases
 * Tests idempotent index creation and prevents invalid type changes.
 */
async function testIndexEdgeCases(): Promise<void> {
  console.log('  --- Running Index Edge Cases Test ---');
  const dbPath = path.join(DB_ROOT_PATH, 'index_edge');
  await cleanUpDbDirectory(dbPath);

  const db = new WiseJSON(dbPath);
  await db.init();
  const col = await db.getCollection<AdvancedDoc>(COLLECTION_NAME);

  // 1. Create standard index
  await col.createIndex('email', { unique: false });
  const indexes = await col.getIndexes();
  assert.strictEqual(indexes.length, 1);

  // 2. Idempotent check: Creating identical index should not throw
  await col.createIndex('email', { unique: false });

  // 3. Changing type of existing index should throw
  await assert.rejects(
    async () => await col.createIndex('email', { unique: true }),
    /already exists/i,
    'Should throw error when changing index type without dropping'
  );

  await db.close();
  await cleanUpDbDirectory(dbPath);
  console.log('  --- Index Edge Cases Test PASSED ---');
}

/**
 * Test 4: Segmented Checkpoint Cleanup
 * Verifies that the database correctly rotates segmented checkpoint files.
 */
async function testSegmentedCheckpointCleanup(): Promise<void> {
  console.log('  --- Running Segmented Checkpoint Cleanup Test ---');
  const dbPath = path.join(DB_ROOT_PATH, 'checkpoint_cleanup_seg');
  await cleanUpDbDirectory(dbPath);

  const dbOptions = {
    maxSegmentSizeBytes: 50, // Small segments to force splitting
    checkpointsToKeep: 2,
    checkpointIntervalMs: 300000,
  };

  const db = new WiseJSON(dbPath, dbOptions);
  await db.init();
  const col = await db.getCollection<AdvancedDoc>(COLLECTION_NAME);

  // Generate multiple checkpoints
  for (let i = 0; i < 4; i++) {
    await col.insert({ _id: `doc_seg_${i}`, text: 'Large content to fill segments'.repeat(5) });
    await col.flushToDisk();
    await sleep(50);
  }

  const checkpointsDir = path.join(dbPath, COLLECTION_NAME, '_checkpoints');
  const files = await fs.readdir(checkpointsDir);

  const metaFiles = files.filter(f => f.startsWith(`checkpoint_meta_`));
  assert.strictEqual(metaFiles.length, dbOptions.checkpointsToKeep, 'Should strictly keep only N checkpoints');

  await db.close();
  await cleanUpDbDirectory(dbPath);
  console.log('  --- Segmented Checkpoint Cleanup Test PASSED ---');
}

async function main() {
  console.log('=== ADVANCED SCENARIOS DB TEST START ===');
  try {
    await fs.mkdir(DB_ROOT_PATH, { recursive: true });

    await testTtlEdgeCases();
    await testCorruptedWalRecovery();
    await testIndexEdgeCases();
    await testEmptyDbOperations(); // Assuming implemented similarly to original
    await testSegmentedCheckpointCleanup();

    console.log('=== ADVANCED SCENARIOS DB TEST PASSED SUCCESSFULLY ===');
  } catch (error) {
    console.error('\n🔥 ADVANCED SCENARIOS TEST FAILED:', error);
    process.exitCode = 1;
  }
}

async function testEmptyDbOperations(): Promise<void> {
    console.log('  --- Running Empty DB Operations Test ---');
    const dbPath = path.join(DB_ROOT_PATH, 'empty_db_ops');
    await cleanUpDbDirectory(dbPath);

    const db = new WiseJSON(dbPath);
    await db.init();

    const names = await db.getCollectionNames();
    assert.deepStrictEqual(names, []);

    const col = await db.getCollection('non_existent_col');
    const colPath = path.join(dbPath, 'non_existent_col');
    const colDirExists = await fs.stat(colPath).then(stat => stat.isDirectory()).catch(() => false);
    assert.ok(colDirExists);

    await db.close();
    await cleanUpDbDirectory(dbPath);
    console.log('  --- Empty DB Operations Test PASSED ---');
}

main().catch(err => {
  console.error('\n🔥 UNHANDLED ERROR:', err);
  process.exitCode = 1;
});
