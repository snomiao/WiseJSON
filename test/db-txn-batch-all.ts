/**
 * test/db-txn-batch-all.test.ts
 * Tests for batch operations (insertMany, updateMany, removeMany)
 * and ACID-like transactions (commit/rollback).
 */

import path from 'path';
import fs from 'fs';
import assert from 'assert';
import { WiseJSON } from '../src/index.js';

import { fileURLToPath } from 'url';

// --- ESM Compatibility ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.resolve(__dirname, 'db-txn-batch-all');
const COL_NAME = 'txn_test';

/**
 * Interface for the test documents.
 */
interface TestDoc {
    _id: string;
    v?: number;
    even?: boolean;
    flag?: boolean | number;
}

/**
 * Cleanup helper for test environment.
 */
function cleanUp(): void {
    if (fs.existsSync(DB_PATH)) {
        fs.rmSync(DB_PATH, { recursive: true, force: true });
    }
}

async function main(): Promise<void> {
    console.log('=== DB TXN BATCH ALL TEST START ===');
    cleanUp();

    const db = new WiseJSON(DB_PATH);
    await db.init();

    const col = await db.getCollection<TestDoc>(COL_NAME);

    // 1. Batch Insert
    const batch: TestDoc[] = [];
    for (let i = 0; i < 100; i++) {
        batch.push({ _id: `k${i}`, v: i });
    }
    await col.insertMany(batch);
    assert.strictEqual(await col.count(), 100, 'Batch insert failed to insert 100 docs');

    // 2. Batch Update
    // Update documents where 'v' is even
    await col.updateMany((d: TestDoc) => (d.v || 0) % 2 === 0, { even: true });
    const allDocs = await col.find({});
    const evens = allDocs.filter(d => d.even);
    assert.strictEqual(evens.length, 50, 'Batch update should affect exactly 50 documents');

    // 3. Batch Remove
    // Remove documents where 'v' is less than 10
    await col.removeMany((d: TestDoc) => (d.v || 0) < 10);
    assert.strictEqual(await col.count(), 90, 'Batch remove failed to delete 10 docs');

    // 4. Transactions: Commit
    // Changes within a transaction should be visible after commit()
    const txn = db.beginTransaction();
    await txn.collection<TestDoc>(COL_NAME).insert({ _id: 'txnX', flag: true });
    await txn.collection<TestDoc>(COL_NAME).update('k11', { flag: true });
    await txn.commit();

    const txnX = await col.findOne({ _id: 'txnX' });
    const k11 = await col.findOne({ _id: 'k11' });
    assert.ok(txnX?.flag, 'Transactionally inserted doc should exist after commit');
    assert.ok(k11?.flag, 'Transactionally updated doc should reflect changes after commit');

    // 5. Transactions: Rollback
    // Changes within a transaction should be discarded after rollback()
    const txn2 = db.beginTransaction();
    await txn2.collection<TestDoc>(COL_NAME).insert({ _id: 'shouldNotExist', flag: 99 });
    await txn2.collection<TestDoc>(COL_NAME).remove('k12');
    await txn2.rollback();

    const shouldNotExist = await col.findOne({ _id: 'shouldNotExist' });
    const k12 = await col.findOne({ _id: 'k12' });
    assert.strictEqual(shouldNotExist, null, 'Inserted doc in rolled-back txn should not exist');
    assert.ok(k12, 'Removed doc in rolled-back txn should still exist in collection');

    await db.close();
    cleanUp();

    console.log('=== DB TXN BATCH ALL TEST PASSED ===');
}

main().catch(err => {
    console.error('\n🔥 TEST FAILED:', err);
    console.error(`\n❗ Test directory was not deleted for debugging: ${DB_PATH}`);
    process.exit(1);
});
