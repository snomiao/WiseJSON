/**
 * test/test-index-proxy-all.test.ts
 * Verifies that the library entry point correctly exposes the modernized
 * CRUD API and that the proxying to the Collection class is working as intended.
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { WiseJSON } from '../src/lib/index.js';

import { fileURLToPath } from 'url';

// --- ESM Compatibility ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Interface for document used in proxy testing.
 */
interface ProxyTestDoc {
  id: number;
  name: string;
}

(async () => {
  // Create a unique temporary directory for this test run
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wisejson-proxy-test-'));
  const dbPath = path.join(tmpDir, 'db-dir');
  let db: WiseJSON;

  // Ensure clean state
  if (fs.existsSync(dbPath)) {
    fs.rmSync(dbPath, { recursive: true, force: true });
  }

  try {
    // Import the package entry point
    const wise = await import('../src/index.js');

    assert.strictEqual(typeof wise.connect, 'function', 'The connect factory must be a function');

    // Initialize database instance using the factory
    db = wise.connect(dbPath);

    // Retrieve the collection using the modern async API
    const users = await db.getCollection<ProxyTestDoc>('users-proxy-test');

    // 1. Verify existence of the modern CRUD API methods
    const methods = [
      'insert', 'insertMany',
      'find', 'findOne',
      'updateOne', 'updateMany',
      'deleteOne', 'deleteMany'
    ];

    methods.forEach(m => {
      assert.strictEqual(typeof (users as any)[m], 'function', `Method ${m} should exist on the collection`);
    });



    // 2. Test: insert + findOne
    await users.insert({ id: 1, name: 'Alice' });
    const f1 = await users.findOne({ id: 1 });
    assert.strictEqual(f1?.name, 'Alice', 'findOne should successfully retrieve Alice');

    // 3. Test: insertMany + find
    await users.insertMany([
      { id: 2, name: 'Bob' },
      { id: 3, name: 'Carol' }
    ]);
    assert.strictEqual(await users.count(), 3, 'Collection count should be 3 after batch insertion');

    // 4. Test: updateOne (using MongoDB-style $set operator)
    await users.updateOne({ id: 3 }, { $set: { name: 'Caroline' } });
    const caroline = await users.findOne({ id: 3 });
    assert.strictEqual(caroline?.name, 'Caroline', 'updateOne should update the name field');

    // 5. Test: deleteOne
    await users.deleteOne({ id: 1 });
    assert.strictEqual(await users.count(), 2, 'Collection count should be 2 after deleteOne');

    // 6. Test: deleteMany (using MongoDB-style $in operator)
    await users.deleteMany({ id: { $in: [2, 3] } });
    assert.strictEqual(await users.count(), 0, 'Collection should be empty after deleteMany');

    // 7. Cleanup DB connection
    if (db && typeof db.close === 'function') {
      await db.close();
    }

    console.log('✓ test-index-proxy.ts: All proxy interface checks passed');
    process.exit(0);

  } catch (err) {
    console.error('✗ test-index-proxy.ts: Failed to verify proxy interface', err);
    process.exit(1);
  } finally {
    // Final cleanup of temporary files
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      console.warn('Could not remove temporary test files:', cleanupErr);
    }
  }
})();
