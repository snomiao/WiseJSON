/**
 * test/db-ttl-all.test.ts
 * Integration test for document expiration and automatic cleanup logic.
 */

import path from 'path';
import fs from 'fs';
import assert from 'assert';
import { WiseJSON } from '../src/index.js';
import { cleanupExpiredDocs } from '../src/lib/collection/ttl.js';

import { fileURLToPath } from 'url';

// --- ESM Compatibility ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.resolve(__dirname, 'db-ttl-all');
const COL_NAME = 'ttl_test';

/**
 * Interface representing documents with optional TTL.
 */
interface TTLDoc {
    _id: string;
    val?: number;
    x?: number;
    ttl?: number;
}

/**
 * Utility to remove the test database directory.
 */
function cleanUp(): void {
    if (fs.existsSync(DB_PATH)) {
        fs.rmSync(DB_PATH, { recursive: true, force: true });
    }
}

/**
 * Helper to pause execution for TTL intervals.
 * @param ms Milliseconds to wait.
 */
async function sleep(ms: number): Promise<void> {
    return new Promise(res => setTimeout(res, ms));
}

async function main(): Promise<void> {
    console.log('=== DB TTL ALL TEST START ===');
    cleanUp();

    // Initialize with a high-frequency cleanup interval (500ms) for testing
    const db = new WiseJSON(DB_PATH, { ttlCleanupIntervalMs: 500 });
    await db.init();

    const col = await db.getCollection<TTLDoc>(COL_NAME);

    // 1. Insert documents: one with 1s TTL, one persistent
    await col.insert({ _id: 'a', val: 1, ttl: 1000 });
    await col.insert({ _id: 'b', val: 2 });

    assert.strictEqual(await col.count(), 2, 'Count after initial insert');

    // 2. Wait for auto-cleanup cycle to trigger
    await sleep(1500);

    // Document 'a' should be removed by the background timer
    assert.strictEqual(await col.count(), 1, 'Count after TTL cleanup');
    const docB = await col.findOne({ _id: 'b' });
    assert(docB && docB.val === 2, 'Persistent document "b" should survive');

    // 3. Batch insertion with short TTL (500ms)
    const batch: TTLDoc[] = [];
    for (let i = 0; i < 10; i++) {
        batch.push({ _id: `t${i}`, x: i, ttl: 500 });
    }
    await col.insertMany(batch);

    // Wait for the batch documents to expire
    await sleep(700);

    // Verify all t0-t9 are gone, and b still remains
    assert.strictEqual(await col.count(), 1, 'All expired batch docs should be removed');

    // 4. Manual cleanup call verification
    await col.insert({ _id: 'c', val: 3 });
    await col.insert({ _id: 'd', val: 4, ttl: 100 });

    await sleep(150);

    // Explicitly trigger cleanup logic using internal document map and index manager
    cleanupExpiredDocs((col as any).documents, (col as any)._indexManager);

    assert.strictEqual(await col.findOne({ _id: 'd' }), null, 'Document "d" should be expired and manually cleaned');
    assert(await col.findOne({ _id: 'c' }), 'Persistent document "c" must remain');

    await db.close();
    cleanUp();

    console.log('=== DB TTL ALL TEST PASSED ===');
}

main().catch(err => {
    console.error('\n🔥 TEST FAILED:', err);
    console.error(`\n❗ Test directory was not deleted for debugging: ${DB_PATH}`);
    process.exit(1);
});
