/**
 * test/db-sync-all.test.ts
 * Tests the synchronization engine, including PUSH/PULL logic,
 * idempotent batch handling, error recovery, and the quarantine system.
 */

import path from 'path';
import fs from 'fs/promises';
import http from 'http';
import assert from 'assert';
import { ApiClient, WiseJSON } from '../src/index.js';
import { fileURLToPath } from 'url';

// --- ESM Compatibility ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.resolve(__dirname, 'db-sync-all-data');
const COLLECTION_NAME = 'sync_test_collection';
const SERVER_PORT = 13337;
const SERVER_URL = `http://localhost:${SERVER_PORT}`;

// --- Interfaces for Sync Types ---
interface SyncOp {
    op: 'INSERT' | 'UPDATE' | 'REMOVE';
    doc?: any;
    id?: string;
    ts?: string;
    data?: any;
}

interface ServerState {
    opsLog: SyncOp[];
    receivedBatchIds: Set<string>;
    readonly server_lsn: number;
    rejectNextPush: boolean;
}

// --- Enhanced Mock Server ---
let mockServer: http.Server;
const serverState: ServerState = {
    opsLog: [],
    receivedBatchIds: new Set(),
    get server_lsn() { return this.opsLog.length; },
    rejectNextPush: false,
};

/**
 * Starts a local HTTP server to simulate a backend sync endpoint.
 */
function startMockServer(): Promise<void> {
    serverState.opsLog = [];
    serverState.receivedBatchIds.clear();
    serverState.rejectNextPush = false;

    mockServer = http.createServer((req, res) => {
        const url = new URL(req.url || '', `http://${req.headers.host}`);
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            res.setHeader('Content-Type', 'application/json');

            // Health Check
            if (req.method === 'GET' && url.pathname === '/sync/health') {
                res.writeHead(200);
                // console.log("HEALTH IS OK")
                res.end(JSON.stringify({ status: 'ok', lsn: serverState.server_lsn }));
            }
            // Full Snapshot retrieval
            else if (req.method === 'GET' && url.pathname === '/sync/snapshot') {
                res.writeHead(200);

                // console.log(serverState.opsLog, serverState.server_lsn, serverState.receivedBatchIds, "SERVER STATE GET /sync/snapshot")
                res.end(JSON.stringify({
                    server_lsn: serverState.server_lsn,
                    documents: serverState.opsLog.map(op => op.doc || op.data).filter(Boolean),
                }));
            }
            // Delta Pull (since_lsn)
            else if (req.method === 'GET' && url.pathname === '/sync/pull') {
                const sinceLsn = parseInt(url.searchParams.get('since_lsn') || '0', 10);
                const ops = serverState.opsLog.slice(sinceLsn);
                // console.log(serverState.opsLog, serverState.server_lsn, [...serverState.receivedBatchIds.values()], "SERVER STATE GET /sync/pull")
                res.writeHead(200);
                res.end(JSON.stringify({ server_lsn: serverState.server_lsn, ops }));
            }
            // Batch Push
            else if (req.method === 'POST' && url.pathname === '/sync/push') {
              console.log("PUSH /sync/push")
                if (serverState.rejectNextPush) {
                    serverState.rejectNextPush = false;
                    res.writeHead(500);
                    res.end(JSON.stringify({ error: "Internal Server Error From Mock" }));
                    return;
                }
                try {
                    const payload = JSON.parse(body);
                    // Check for duplicate batch IDs (Idempotency)
                    if (serverState.receivedBatchIds.has(payload.batchId)) {
                      // console.log("DUPLICATE /sync/push")
                        res.writeHead(200);
                        res.end(JSON.stringify({ status: 'duplicate_ignored', server_lsn: serverState.server_lsn }));
                        return;
                    }
                    serverState.receivedBatchIds.add(payload.batchId);
                    const ops = Array.isArray(payload.ops) ? payload.ops : [];
                    serverState.opsLog.push(...ops);
                    res.writeHead(200);
                    res.end(JSON.stringify({ status: 'ok', server_lsn: serverState.server_lsn }));
                } catch (e) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Bad request' }));
                }
            } else {
                res.writeHead(404);
                res.end(JSON.stringify({ error: `Not Found: ${req.method} ${url.pathname}` }));
            }
        });
    });

    return new Promise(resolve => {
        mockServer.listen(SERVER_PORT, () => {
            console.log(`  [MockServer] Started on port ${SERVER_PORT}`);
            resolve();
        });
    });
}

function stopMockServer(): Promise<void> {
    return new Promise(resolve => {
        if (mockServer && mockServer.listening) mockServer.close(() => resolve());
        else resolve();
    });
}

async function cleanUp(): Promise<void> {
    try {
        const exists = await fs.stat(DB_PATH).then(() => true).catch(() => false);
        if (exists) {
            await fs.rm(DB_PATH, { recursive: true, force: true });
        }
    } catch (err: any) {
        console.warn(`[Cleanup Warning] Could not remove test directory ${DB_PATH}:`, err.message);
    }
}

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

// --- Main Test Suite ---
async function main() {
    console.log('=== DB SYNC ALL TEST START ===');
    await cleanUp();
    await startMockServer();
    let db: WiseJSON | undefined;

    try {
        db = new WiseJSON(DB_PATH);
        await db.init();

        // Using the modern getCollection API
        const col = await db.getCollection<any>(COLLECTION_NAME);

        const testApiClient = new ApiClient(SERVER_URL, 'test-key');

        col.enableSync({
            apiClient: testApiClient,
            url: SERVER_URL,
            apiKey: 'test-key',
            autoStartLoop: false
        });



        // --- Test 1: Initial Sync and PUSH ---
        console.log('  --- Test 1: Initial Sync and PUSH ---');
        await col.triggerSync(); // Perform initial handshake

        await col.insert({ _id: 'doc1', name: 'Alice' });
        await col.triggerSync(); // Manual push trigger

        assert.strictEqual(serverState.opsLog.length, 1, 'Test 1.1: Server should have received 1 operation');
        assert.strictEqual(serverState.opsLog[0].doc.name, 'Alice', 'Test 1.2: Document data is correct on server');
        const lastBatchId = Array.from(serverState.receivedBatchIds).pop();
        console.log('  --- Test 1 PASSED ---');

        // --- Test 2: PULL ---
        console.log('  --- Test 2: PULL ---');
        // Simulate an external change on the server
        serverState.opsLog.push({
            op: 'INSERT',
            doc: { _id: 'doc2', name: 'Bob', updatedAt: new Date().toISOString() },
            ts: new Date().toISOString()
        });

        await col.triggerSync(); // Pull change from server
        const doc2 = await col.findOne({ _id: 'doc2' });
        assert.ok(doc2, 'Test 2.1: doc2 should be created locally via pull');
        console.log('  --- Test 2 PASSED ---');

        // --- Test 3: Idempotent PUSH ---
        console.log('  --- Test 3: Idempotent PUSH ---');
        assert.ok(serverState.receivedBatchIds.has(lastBatchId!), 'Test 3.1: Server should remember previous batch ID');
        const currentLogLength = serverState.opsLog.length;

        // Manually send duplicate batch
        await testApiClient.post('/sync/push', {
            batchId: lastBatchId,
            ops: [{ op: 'INSERT', doc: { _id: 'doc1', name: 'Alice' } }]
        });

        assert.strictEqual(serverState.opsLog.length, currentLogLength, 'Test 3.2: Server must not apply duplicate batch');
        console.log('  --- Test 3 PASSED ---');

        // --- Test 4: Push Error Handling and Recovery ---
        console.log('  --- Test 4: PUSH Error Handling ---');
        serverState.rejectNextPush = true;
        await col.insert({ _id: 'doc3', name: 'Charlie' });

        // This sync should fail because of mockServer.rejectNextPush
        await col.triggerSync().catch(() => {/* */});

        assert.strictEqual(serverState.opsLog.some(op => op.doc?._id === 'doc3'), false, 'Test 4.1: doc3 should not be on server after failed push');

        // Next sync should succeed and include the pending doc3
        await col.triggerSync();
        assert.strictEqual(serverState.opsLog.some(op => op.doc?._id === 'doc3'), true, 'Test 4.2: doc3 should be sent after recovery');
        console.log('  --- Test 4 PASSED ---');

        // --- Test 5: Quarantine Logic ---
        console.log('  --- Test 5: Quarantine ---');
        const quarantineFile = (col as any).quarantinePath;
        if (await fs.stat(quarantineFile).catch(() => false)) await fs.unlink(quarantineFile);

        // Create a malformed operation that bypasses high-level checks but fails during memory application
        // An INSERT without a `doc` field will trigger the internal application error.
        serverState.opsLog.push({ op: 'INSERT', id: 'malformed-op-for-quarantine' } as any);

        await col.triggerSync();

        // Wait slightly for async file writing to complete
        await sleep(100);

        const quarantineExists = await fs.stat(quarantineFile).then(() => true).catch(() => false);
        assert.ok(quarantineExists, 'Test 5.1: Quarantine file should be created for malformed server operations');

        if (quarantineExists) {
            const quarantineContent = await fs.readFile(quarantineFile, 'utf-8');
            assert.ok(quarantineContent.includes('malformed-op-for-quarantine'), 'Test 5.2: Quarantine file content should include the bad operation ID');
            await fs.unlink(quarantineFile).catch(() => {/* EMPTY */});
        }
        console.log('  --- Test 5 PASSED ---');

    } finally {
        if (db) await db.close();
        await stopMockServer();
        await cleanUp();
    }
    console.log('=== DB SYNC ALL TEST PASSED SUCCESSFULLY ===');
}

main().catch(async (err) => {
    console.error('\n🔥 TEST FAILED:', err);
    if (err.stack) console.error(err.stack);
    await stopMockServer().catch(() => {/* */});
    process.exit(1);
});
