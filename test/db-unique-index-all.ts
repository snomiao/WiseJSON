/**
 * test/db-unique-index-all.test.ts
 * Tests for unique index constraints and error handling.
 */

import path from 'path';
import fs from 'fs';
import assert from 'assert';
import { WiseJSON } from '../src/index.js';
import { UniqueConstraintError } from '../src/lib/errors.js';

import { fileURLToPath } from 'url';

// --- ESM Compatibility ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.resolve(__dirname, 'db-unique-index-all');
const COL_NAME = 'uniq_test';

/**
 * Interface for User documents to ensure type-safe testing.
 */
interface User {
    _id?: string;
    email: string;
    name: string;
}

/**
 * Cleanup helper to remove test artifacts.
 */
function cleanUp(): void {
    if (fs.existsSync(DB_PATH)) {
        fs.rmSync(DB_PATH, { recursive: true, force: true });
    }
}

async function main(): Promise<void> {
    console.log('=== DB UNIQUE INDEX ALL TEST START ===');
    cleanUp();

    const db = new WiseJSON(DB_PATH);
    await db.init();

    // Using the modern getCollection API with generic type
    const col = await db.getCollection<User>(COL_NAME);

    // 1. Create a unique index
    await col.createIndex('email', { unique: true });

    // 2. Insert the first document
    await col.insert({ email: 'u1@mail.com', name: 'User1' });
    assert.strictEqual(await col.count(), 1, 'Insert first should succeed');

    // 3. Attempt to insert a second doc with the same email — must throw!
    await assert.rejects(
        async () => {
            await col.insert({ email: 'u1@mail.com', name: 'User2' });
        },
        UniqueConstraintError,
        'Should throw UniqueConstraintError on duplicate insert'
    );

    // 4. Batch insert with one duplicate — should fail the entire operation or throw
    await assert.rejects(
        async () => {
            await col.insertMany([
                { email: 'u2@mail.com', name: 'User2' },
                { email: 'u1@mail.com', name: 'User3' } // Duplicate of u1
            ]);
        },
        UniqueConstraintError,
        'Should throw UniqueConstraintError on batch insert with duplicate'
    );

    // 5. Batch insert without duplicates — should pass
    await col.insertMany([
        { email: 'u2@mail.com', name: 'User2' },
        { email: 'u3@mail.com', name: 'User3' }
    ]);
    assert.strictEqual(await col.count(), 3, 'Batch insert OK');

    // 6. Update: attempt to change email to an existing one — error
    const user3 = await col.findOne({ email: 'u3@mail.com' });
    assert.ok(user3?._id, 'User3 should be found and have an _id');

    await assert.rejects(
        async () => {
            // Attempting to set email 'u2@mail.com' which is already taken
            await col.update(user3!._id!, { email: 'u2@mail.com' });
        },
        UniqueConstraintError,
        'Should throw UniqueConstraintError on update with duplicate value'
    );

    // 7. Update without conflict — should pass
    await col.update(user3!._id!, { email: 'u4@mail.com' });
    const byEmail = await col.find({ email: 'u4@mail.com' });
    assert(byEmail.length === 1 && byEmail[0].name === 'User3', 'Update unique ok');

    await db.close();
    cleanUp();

    console.log('=== DB UNIQUE INDEX ALL TEST PASSED ===');
}

main().catch(err => {
    console.error('\n🔥 TEST FAILED:', err);
    console.error(`\n❗ Files were not deleted for manual debugging: ${DB_PATH}`);
    process.exit(1);
});
