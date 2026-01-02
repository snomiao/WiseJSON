/**
 * test/db-functional-all.test.ts
 * Integration test covering CRUD, Indexing, TTL, Import/Export, and Recovery.
 */

import path from 'path';
import fs from 'fs';
import assert from 'assert';
import { fileURLToPath } from 'url';
import {WiseJSON} from '../src/lib/index.js';
import { cleanupExpiredDocs } from '../src/lib/collection/ttl.js';

// Helper for ESM __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.resolve(__dirname, 'db-functional-all');
const USERS = 'users';
const LOGS = 'logs';

/**
 * Interface for User documents
 */
interface UserDoc {
    _id?: string;
    name: string;
    age?: number;
    group?: number;
    ttl?: number;
}

/**
 * Interface for Log documents
 */
interface LogDoc {
    _id?: string;
    msg: string;
    level: string;
}

/**
 * Ensures a clean environment by removing the test database directory.
 */
function cleanUp(): void {
    if (fs.existsSync(DB_PATH)) {
        fs.rmSync(DB_PATH, { recursive: true, force: true });
    }
}

/**
 * Simple async delay helper.
 * @param ms milliseconds to sleep
 */
async function sleep(ms: number): Promise<void> {
    return new Promise(res => setTimeout(res, ms));
}

async function main(): Promise<void> {
    console.log('=== DB FUNCTIONAL ALL TEST START ===');
    cleanUp();

    // Initialize DB with a short TTL cleanup interval for testing
    const db = new WiseJSON(DB_PATH, { ttlCleanupIntervalMs: 500 });
    await db.init();

    // 1. Insertion, Reading, Indices
    // Using the modern getCollection API
    const users = await db.getCollection<UserDoc>(USERS);

    await users.insert({ name: 'Ivan', age: 25, group: 1 });
    await users.insert({ name: 'Petr', age: 30, group: 2 });
    await users.insert({ name: 'Svetlana', age: 22, group: 1 });

    await users.createIndex('group');
    await users.createIndex('name');

    assert.strictEqual(await users.count(), 3, 'Count after insert');

    // Replace obsolete methods with find/findOne for consistency
    const byGroup = await users.find({ group: 1 });
    assert.strictEqual(byGroup.length, 2, 'Index query group=1');

    const byName = await users.findOne({ name: 'Petr' });
    assert(byName && byName.age === 30, 'Index query by name');

    // 2. Update/Remove/Drop Index
    // We use the _id generated during the first insert
    if (byGroup[0]._id) {
        await users.update(byGroup[0]._id, { name: 'Ivanov' });
    }
    if (byGroup[1]._id) {
        await users.remove(byGroup[1]._id);
    }

    await users.dropIndex('group');
    await users.dropIndex('name');
    assert.strictEqual(await users.count(), 2, 'After update/remove');

    // 3. TTL auto-cleanup (document with ttl)
    await users.insert({ name: 'TTL', age: 99, ttl: 1000 });
    assert.strictEqual(await users.count(), 3, 'Count before TTL');

    // Wait for the document to expire
    await sleep(1100);

    // GUARANTEED manual cleanup to ensure test reliability!
    // Using internal properties (casting to any to access private members if necessary)
    cleanupExpiredDocs((users as any).documents, (users as any)._indexManager);

    assert.strictEqual(await users.count(), 2, 'TTL auto-cleanup 1');

    // 4. Export/Import (Massive)
    const arr: UserDoc[] = [];
    for (let i = 0; i < 5000; i++) {
        arr.push({ name: `N${i}`, group: i % 10 });
    }

    const exportFile = path.join(DB_PATH, 'export.json');
    await users.insertMany(arr);
    await users.exportJson(exportFile);

    // New logs collection
    // FIXED: Using the new API
    const logs = await db.getCollection<LogDoc>(LOGS);
    await logs.insert({ msg: 'log1', level: 'info' });

    // Verify export
    assert(fs.existsSync(exportFile), 'Export file exists');
    const exportedData = JSON.parse(fs.readFileSync(exportFile, 'utf8'));
    assert.strictEqual(exportedData.length, 5002, 'Exported count'); // 2 existing + 5000 inserted

    // 5. Import/Replace
    const importArr: UserDoc[] = [];
    for (let i = 0; i < 4000; i++) {
        importArr.push({ name: `Y${i}`, group: i % 4 });
    }

    const importFile = path.join(DB_PATH, 'import.json');
    fs.writeFileSync(importFile, JSON.stringify(importArr, null, 2));

    // Test importing with 'replace' mode
    await users.importJson(importFile, { mode: 'replace' });
    assert.strictEqual(await users.count(), 4000, 'Import replace');

    // 6. Checkpoint/wal/close/recover
    // Persist current state to disk
    await users.flushToDisk();
    await logs.flushToDisk();
    await db.close();

    // 7. Recovery: Re-open collections, data must be restored
    const db2 = new WiseJSON(DB_PATH);
    await db2.init();

    // FIXED: Using new API for recovery check
    const users2 = await db2.getCollection<UserDoc>(USERS);
    assert.strictEqual(await users2.count(), 4000, 'Recovery main');

    // FIXED: Using new API for logs recovery check
    const logs2 = await db2.getCollection<LogDoc>(LOGS);
    assert.strictEqual(await logs2.count(), 1, 'Logs recovery');

    await db2.close();
    cleanUp();

    console.log('=== DB FUNCTIONAL ALL TEST PASSED ===');
}

main().catch(err => {
    console.error('\n🔥 TEST FAILED:', err);
    console.error(`\n❗ DB was not deleted for manual debugging: ${DB_PATH}`);
    process.exit(1);
});
