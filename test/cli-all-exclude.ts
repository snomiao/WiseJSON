import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as assert from 'assert';

import { fileURLToPath } from 'url';

// --- ESM Compatibility ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Configuration ---
const DB_PATH = path.resolve(__dirname, 'cli-unified-db');
// We use 'tsx' to run the source TypeScript file directly for testing
const CLI_ENTRY = path.resolve(__dirname, '../cli/index.ts');
const CLI_COMMAND = `npx tsx ${CLI_ENTRY}`;

const TEST_COLLECTION = 'unified_users';
const DATA_FILE_PATH = path.join(__dirname, 'cliapi-import.json');
const EXPORT_JSON_PATH = path.join(__dirname, 'cli-unified-export.json');

/**
 * Clean up test artifacts
 */
function cleanUp(): void {
    if (fs.existsSync(DB_PATH)) {
        fs.rmSync(DB_PATH, { recursive: true, force: true });
    }
    [EXPORT_JSON_PATH, DATA_FILE_PATH].forEach(file => {
        if (fs.existsSync(file)) fs.unlinkSync(file);
    });
}

/**
 * Execute a CLI command and return stdout
 */
function runCli(command: string, options: { shouldFail?: boolean } = {}): string {
    const env = {
        ...process.env,
        WISE_JSON_PATH: DB_PATH,
        LOG_LEVEL: 'none',
        NODE_OPTIONS: '--no-warnings' // Suppress experimental warnings
    };

    const fullCommand = `${CLI_COMMAND} ${command}`;

    try {
        const stdout = execSync(fullCommand, { env, stdio: 'pipe' }).toString();

        if (options.shouldFail) {
            assert.fail(`Command "${command}" should have failed but succeeded.`);
        }
        return stdout.trim();
    } catch (error: any) {
        if (!options.shouldFail) {
            const stderr = error.stderr ? error.stderr.toString() : '';
            const stdout = error.stdout ? error.stdout.toString() : '';
            console.error(`❌ Command failed unexpectedly: ${fullCommand}`);
            console.error(`Stdout: ${stdout}`);
            console.error(`Stderr: ${stderr}`);
            throw error;
        }
        return error.stderr ? error.stderr.toString().trim() : '';
    }
}

async function main() {
    console.log('🚀 Starting Unified CLI Integration Tests...');
    cleanUp();

    try {
        // --- 0. Data Preparation ---
        const testUsers = Array.from({ length: 10 }, (_, i) => ({
            _id: `user${i}`,
            name: `User ${i}`,
            age: 20 + i,
            city: i % 2 === 0 ? 'New York' : 'London',
            tags: [`tag${i}`]
        }));
        fs.writeFileSync(DATA_FILE_PATH, JSON.stringify(testUsers));

        // --- 1. Write Protection ---
        console.log('  Testing write protection (read-only by default)...');
        runCli(`create-index ${TEST_COLLECTION} name`, { shouldFail: true });
        console.log('  ✅ Write protection works.');

        // --- 2. Basic CRUD via CLI ---
        console.log('  Testing import and collection visibility...');
        runCli(`import-collection ${TEST_COLLECTION} ${DATA_FILE_PATH} --allow-write`);

        const collections = runCli(`list-collections`);
        assert.ok(collections.includes(TEST_COLLECTION), 'Collection should be visible in list');

        const docsOutput = runCli(`show-collection ${TEST_COLLECTION}`);
        const docs = JSON.parse(docsOutput);
        assert.strictEqual(docs.length, 10, 'Should have imported 10 documents');

        const user3 = JSON.parse(runCli(`get-document ${TEST_COLLECTION} user3`));
        assert.strictEqual(user3.name, 'User 3');
        console.log('  ✅ Basic operations passed.');

        // --- 3. Filtering and Constraints ---
        console.log('  Testing filters and limits...');

        const filterObj = { city: 'New York' };
        // Handle cross-platform quoting for the JSON filter string
        const filterArg = os.platform() === 'win32'
            ? `"${JSON.stringify(filterObj).replace(/"/g, '\\"')}"`
            : `'${JSON.stringify(filterObj)}'`;

        const filteredDocs = JSON.parse(runCli(`show-collection ${TEST_COLLECTION} --filter=${filterArg}`));
        assert.strictEqual(filteredDocs.length, 5, 'Should filter correctly to 5 NYC users');

        const limited = JSON.parse(runCli(`show-collection ${TEST_COLLECTION} --limit=3`));
        assert.strictEqual(limited.length, 3, 'Limit flag failed');
        console.log('  ✅ Filtering passed.');

        // --- 4. Index Management ---
        console.log('  Testing index lifecycle...');
        runCli(`create-index ${TEST_COLLECTION} name --unique --allow-write`);
        let indexes = JSON.parse(runCli(`list-indexes ${TEST_COLLECTION}`));
        assert.ok(indexes.some((i: any) => i.fieldName === 'name'), 'Index missing');

        runCli(`drop-index ${TEST_COLLECTION} name --allow-write`);
        indexes = JSON.parse(runCli(`list-indexes ${TEST_COLLECTION}`));
        assert.strictEqual(indexes.length, 0, 'Index not dropped');
        console.log('  ✅ Indexing passed.');

        // --- 5. Destructive Operations ---
        console.log('  Testing safe vs forced drops...');
        runCli(`collection-drop ${TEST_COLLECTION} --allow-write`, { shouldFail: true });
        runCli(`collection-drop ${TEST_COLLECTION} --allow-write --force`);

        const finalCols = runCli('list-collections');
        assert.ok(!finalCols.includes(TEST_COLLECTION), 'Collection was not dropped');
        console.log('  ✅ Forced drop passed.');

    } finally {
        cleanUp();
    }

    console.log('🎉 ALL CLI TESTS PASSED SUCCESSFULLY');
}

main().catch(err => {
    console.error('\n🔥 TEST SUITE FAILED:', err);
    cleanUp();
    process.exit(1);
});
