/**
 * test/db-extended-api-all.test.ts
 * Tests the extended MongoDB-like API including atomic updates,
 * deletions, findAndModify logic, and field projections.
 */

import path from 'path';
import fs from 'fs';
import assert from 'assert';
import { fileURLToPath } from 'url';
import { WiseJSON } from '../src/index.js';

// --- ESM Compatibility ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.resolve(__dirname, 'db-extended-api-all');
const COLLECTION_NAME = 'extended_api_tests';

/**
 * Interface for our Product documents to ensure type-safe queries and updates.
 */
interface Product {
    _id?: string;
    name: string;
    category: string;
    price: number;
    stock: number;
    tags: string[];
    status?: string;
    on_sale?: boolean;
    createdAt?: string;
    updatedAt?: string;
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
 * Helper function to retrieve a clean object without internal meta-fields.
 * @param doc The document to clean
 * @returns An object containing only the domain data
 */
function getCleanDoc(doc: any): Partial<Product> | null {
    if (!doc) return null;
    const { _id, createdAt, updatedAt, ...rest } = doc;
    return rest;
}

async function main(): Promise<void> {
    console.log('=== DB EXTENDED API TEST START ===');
    cleanUp();

    const db = new WiseJSON(DB_PATH);
    await db.init();
    const col = await db.collection<Product>(COLLECTION_NAME);
    await col.isReady;

    // --- Data Preparation ---
    const testData: Product[] = [
        { name: 'Product A', category: 'books', price: 20, stock: 100, tags: ['fiction'] },
        { name: 'Product B', category: 'electronics', price: 200, stock: 50, tags: ['gadget', 'new'] },
        { name: 'Product C', category: 'books', price: 15, stock: 120, tags: ['non-fiction', 'history'] },
        { name: 'Product D', category: 'electronics', price: 150, stock: 75, tags: ['audio', 'new'] },
        { name: 'Product E', category: 'clothing', price: 50, stock: 200, tags: ['sale'] }
    ];
    await col.insertMany(testData);


    // --- Test 1: updateOne ---
    console.log('  --- Testing updateOne ---');
    // Atomic update using $set and $inc
    let updateResult: any = await col.updateOne(
        { name: 'Product A' },
        { $set: { price: 25, status: 'reviewed' }, $inc: { stock: -5 } } as any
    );
    assert.deepStrictEqual(updateResult, { matchedCount: 1, modifiedCount: 1 }, 'updateOne should match and modify 1 doc');

    const productA = await col.findOne({ name: 'Product A' });
    assert.ok(productA, 'Product A should exist');
    assert.strictEqual(productA!.price, 25, 'updateOne: price should be updated via $set');
    assert.strictEqual(productA!.stock, 95, 'updateOne: stock should be decremented via $inc');
    assert.strictEqual(productA!.status, 'reviewed', 'updateOne: new field should be added via $set');
    console.log('  --- updateOne PASSED ---');


    // --- Test 2: updateMany ---
    console.log('  --- Testing updateMany ---');
    updateResult = await col.updateMany(
        { category: 'electronics' },
        { $set: { on_sale: true }, $inc: { price: -10 } }
    );
    assert.deepStrictEqual(updateResult, { matchedCount: 2, modifiedCount: 2 }, 'updateMany should match and modify 2 docs');

    const electronics = await col.find({ category: 'electronics' });
    assert.ok(electronics.every(d => d.on_sale === true), 'updateMany: all electronics should be on sale');
    assert.strictEqual(electronics.find(d => d.name === 'Product B')?.price, 190, 'updateMany: Product B price should be 190');
    assert.strictEqual(electronics.find(d => d.name === 'Product D')?.price, 140, 'updateMany: Product D price should be 140');
    console.log('  --- updateMany PASSED ---');


    // --- Test 3: deleteOne and deleteMany ---
    console.log('  --- Testing deleteOne and deleteMany ---');
    let deleteResult = await col.deleteOne({ name: 'Product E' });
    assert.deepStrictEqual(deleteResult, { deletedCount: 1 }, 'deleteOne should delete 1 doc');
    assert.strictEqual(await col.count(), 4, 'Count should be 4 after deleteOne');

    deleteResult = await col.deleteMany({ category: 'books' });
    assert.deepStrictEqual(deleteResult, { deletedCount: 2 }, 'deleteMany should delete 2 docs');
    assert.strictEqual(await col.count(), 2, 'Count should be 2 after deleteMany');
    console.log('  --- deleteOne and deleteMany PASSED ---');


    // --- Test 4: findOneAndUpdate ---
    console.log('  --- Testing findOneAndUpdate ---');
    // Returns the new document by default
    let fnuResult = await col.findOneAndUpdate(
        { name: 'Product B' },
        { $inc: { stock: 10 } }
    );

    console.log(fnuResult, 'findOneAndUpdate')
    assert.strictEqual(fnuResult?.stock, 60, 'findOneAndUpdate should return updated doc by default');

    // Returns original document with the returnOriginal option
    fnuResult = await col.findOneAndUpdate(
        { name: 'Product D' },
        { $set: { stock: 0 } },
        { returnOriginal: true }
    );
    assert.strictEqual(fnuResult?.stock, 75, 'findOneAndUpdate with returnOriginal should return original doc');

    const productDAfter = await col.findOne({ name: 'Product D' });
    assert.strictEqual(productDAfter?.stock, 0, 'Document D should be updated in DB after findOneAndUpdate');
    console.log('  --- findOneAndUpdate PASSED ---');


    // --- Test 5: Projections ---
    console.log('  --- Testing projections ---');

    // Inclusion projections (only return specific fields)
    let projectedDocs = await col.find({ category: 'electronics' }, { name: 1, price: 1 } as any);
    assert.strictEqual(Object.keys(projectedDocs[0]).length, 3, 'Inclusion projection should have 3 keys (_id, name, price)');
    assert.deepStrictEqual(getCleanDoc(projectedDocs[0]), { name: 'Product B', price: 190 }, 'Inclusion projection result is incorrect');

    // Inclusion projection with _id suppression
    projectedDocs = await col.find({ category: 'electronics' }, { name: 1, price: 1, _id: 0 } as any);
    assert.strictEqual(Object.keys(projectedDocs[0]).length, 2, 'Inclusion projection with _id:0 should have 2 keys');
    assert.deepStrictEqual(projectedDocs[0], { name: 'Product B', price: 190 }, 'Inclusion projection with _id:0 result is incorrect');

    // Exclusion projections (hide specific fields)
    const exclusionResult: any = await col.findOne({ name: 'Product B' }, { tags: 0, on_sale: 0 } as any);
    assert.ok(!Object.prototype.hasOwnProperty.call(exclusionResult, 'tags'), 'Exclusion projection should not have "tags" field');
    assert.ok(!Object.prototype.hasOwnProperty.call(exclusionResult,'on_sale'), 'Exclusion projection should not have "on_sale" field');
    assert.ok(Object.prototype.hasOwnProperty.call(exclusionResult,'price'), 'Exclusion projection should have "price" field');
    console.log('  --- projections PASSED ---');


    await db.close();
    cleanUp();

    console.log('=== DB EXTENDED API TEST PASSED SUCCESSFULLY ===');
}

main().catch(err => {
    console.error('\n🔥 TEST FAILED:', err);
    console.error(`\n❗ Test directory was not deleted for debugging purposes: ${DB_PATH}`);
    process.exit(1);
});
