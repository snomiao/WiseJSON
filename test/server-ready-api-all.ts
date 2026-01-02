/**
 * test/server-ready-api.test.ts
 * Tests the high-level public API, lazy initialization via connect(),
 * and specialized error handling for production environments.
 */

import path from 'path';
import fs from 'fs';
import assert from 'assert';
import { connect, UniqueConstraintError, WiseJSON } from '../src/index.js';

import { fileURLToPath } from 'url';

// --- ESM Compatibility ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEST_DB_PATH = path.resolve(__dirname, 'server-api-test-db');

/**
 * Interface for the User document to ensure type safety in the test.
 */
interface UserDoc {
    _id?: string;
    name: string;
    email: string;
}

/**
 * Interface for Log documents.
 */
interface LogDoc {
    event: string;
    userId: string;
}

/**
 * Helper function for complete cleanup of the test directory.
 */
function cleanup(): void {
    if (fs.existsSync(TEST_DB_PATH)) {
        fs.rmSync(TEST_DB_PATH, { recursive: true, force: true });
    }
}

async function runServerReadyApiTest(): Promise<void> {
    console.log('=== SERVER-READY API TEST START ===');
    cleanup();
    
    let db: WiseJSON | undefined;

    try {
        // 1. Verify "Lazy" Initialization
        // We do NOT call db.init() explicitly; the first operation should trigger it.
        console.log('  [1] Initializing DB without explicit .init() call');
        db = connect(TEST_DB_PATH);
        assert.ok(db, 'DB instance should be successfully created');

        // 2. Using the getCollection() API
        console.log('  [2] Retrieving collection via getCollection()');
        const users = await db.getCollection<UserDoc>('users');
        assert.ok(users, 'Collection "users" should be retrieved');
        assert.strictEqual(await users.count(), 0, 'A new collection should be empty');

        // 3. Basic CRUD Operations
        console.log('  [3] Testing basic CRUD operations');
        await users.insert({ _id: 'user1', name: 'Alice', email: 'alice@example.com' });
        
        const alice = await users.findOne({ _id: 'user1' });
        assert.strictEqual(alice?.name, 'Alice', 'findOne should retrieve Alice');
        assert.strictEqual(await users.count(), 1, 'Collection count should be 1');

        // 4. UniqueConstraintError Validation
        console.log('  [4] Testing custom UniqueConstraintError handling');
        await users.createIndex('email', { unique: true });
        
        await assert.rejects(
            async () => {
                // Attempting to insert a duplicate email
                await users.insert({ name: 'Alicia', email: 'alice@example.com' });
            },
            (err: any) => {
                // Verify the error is the correct class and contains the expected metadata
                const isCorrectType = err instanceof UniqueConstraintError;
                const isCorrectField = err.fieldName === 'email';
                const isCorrectValue = err.value === 'alice@example.com';
                
                assert(isCorrectType, 'Error must be an instance of UniqueConstraintError');
                assert(isCorrectField, 'Error fieldName should be "email"');
                assert(isCorrectValue, 'Error value should be "alice@example.com"');
                
                return true; 
            },
            'Should throw UniqueConstraintError on duplicate email insertion'
        );
        console.log('  --- UniqueConstraintError successfully caught and verified');

        // 5. Multi-collection interaction
        console.log('  [5] Testing multi-collection operations');
        const logs = await db.getCollection<LogDoc>('logs');
        await logs.insert({ event: 'user_created', userId: 'user1' });
        assert.strictEqual(await logs.count(), 1, 'Logs collection should contain 1 entry');

        const collectionNames = await db.getCollectionNames();
        assert.deepStrictEqual(
            collectionNames.sort(), 
            ['logs', 'users'].sort(), 
            'getCollectionNames should return the correct list of collections'
        );

    } finally {
        // 6. Resource Cleanup
        console.log('  [6] Closing database and cleaning up temporary files');
        if (db) {
            await db.close();
        }
        cleanup();
        console.log('  --- Cleanup complete');
    }

    console.log('\n✅ === SERVER-READY API TEST PASSED SUCCESSFULLY ===');
}

// Execute the test runner
runServerReadyApiTest().catch(err => {
    console.error('\n🔥 === TEST FAILED ===');
    console.error(err);
    cleanup();
    process.exit(1);
});