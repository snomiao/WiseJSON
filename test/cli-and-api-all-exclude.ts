import { execSync, spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import http from 'http';
import assert from 'assert';

import { fileURLToPath } from 'url';

// --- ESM Compatibility ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Configuration ---
const DB_PATH = path.resolve(__dirname, 'cli-and-api-db');
// Ensure we use the .ts extension for tsx
const CLI_ENTRY = path.resolve(__dirname, '../cli/index.ts');
const CLI_COMMAND = `npx tsx ${CLI_ENTRY}`;
// If explorer/server.ts is a TS file, run it with tsx as well
const SERVER_PATH = path.resolve(__dirname, '../explorer/server.ts');
const SERVER_COMMAND = `npx tsx ${SERVER_PATH}`;

const BASE_URL = 'http://127.0.0.1:3101';
const TEST_COLLECTION = 'cliapi_users';
const DATA_FILE = path.join(__dirname, 'cliapi-import.json');
const EXPORT_JSON = path.join(__dirname, 'cliapi-export.json');
const EXPORT_CSV = path.join(__dirname, 'cliapi-export.csv');
const AUTH_USER = 'apitest';
const AUTH_PASS = 'secret';

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

/**
 * Cleanup database and temp files.
 */
async function cleanUp(): Promise<void> {
    if (fs.existsSync(DB_PATH)) {
        await fsp.rm(DB_PATH, { recursive: true, force: true });
    }
    const tempFiles = [DATA_FILE, EXPORT_JSON, EXPORT_CSV];
    for (const file of tempFiles) {
        if (fs.existsSync(file)) {
            try {
                await fsp.unlink(file);
            } catch (e: any) {
                // Ignore errors if file is already deleted or locked
            }
        }
    }
}

/**
 * Execute a CLI command and return stdout.
 */
function runCli(command: string, opts: { shouldFail?: boolean } = {}): string {
    const env = {
        ...process.env,
        WISE_JSON_PATH: DB_PATH,
        LOG_LEVEL: 'none',
        NODE_OPTIONS: '--no-warnings'
    };
    const fullCommand = `${CLI_COMMAND} ${command}`;
    try {
        const stdout = execSync(fullCommand, { env, stdio: 'pipe' }).toString();
        if (opts.shouldFail) assert.fail(`Command "${command}" should have failed.`);
        return stdout.trim();
    } catch (error: any) {
        if (!opts.shouldFail) {
            const stderr = error.stderr ? error.stderr.toString() : '';
            const stdout = error.stdout ? error.stdout.toString() : '';
            console.error(`❌ CLI Error: ${fullCommand}\nSTDOUT: ${stdout}\nSTDERR: ${stderr}`);
            throw error;
        }
        return error.stderr ? error.stderr.toString().trim() : '';
    }
}

/**
 * Simple HTTP helper for testing REST endpoints.
 */
function fetchJson(url: string, options: { auth?: boolean } = {}): Promise<{ status: number; data: any }> {
    return new Promise((resolve, reject) => {
        const httpOpts: http.RequestOptions = {
            headers: {},
            method: 'GET'
        };
        if (options.auth) {
            const credentials = Buffer.from(`${AUTH_USER}:${AUTH_PASS}`).toString('base64');
            (httpOpts.headers as any)!['Authorization'] = `Basic ${credentials}`;
        }

        const req = http.request(url, httpOpts, res => {
            let data = '';
            res.on('data', chunk => (data += chunk));
            res.on('end', () => {
                if (res.statusCode && res.statusCode >= 400) {
                   return reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                }
                try {
                    resolve({ status: res.statusCode || 0, data: JSON.parse(data) });
                } catch (e) { resolve({ status: res.statusCode || 0, data }); }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

/**
 * Wait for server to become responsive.
 */
async function waitServerStart(): Promise<void> {
    for (let i = 0; i < 50; i++) {
        try {
            await fetchJson(`${BASE_URL}/api/collections`, { auth: true });
            return;
        } catch (e) {
            await sleep(200);
        }
    }
    throw new Error('Server timeout: 127.0.0.1:3101 is not responding.');
}

async function main() {
    console.log('🚀 Starting Hybrid CLI/API Integration Tests...');
    await cleanUp();

    let serverProc: ChildProcess | undefined;

    try {
        // --- 1. CLI OPERATIONS ---
        console.log('  Testing CLI Data Setup...');
        const testUsers = Array.from({ length: 30 }, (_, i) => ({
            _id: `user${i}`,
            name: `User${i}`,
            age: 20 + i,
            group: i % 3
        }));
        await fsp.writeFile(DATA_FILE, JSON.stringify(testUsers, null, 2));

        // CLI logic: Import -> Export JSON -> Export CSV
        runCli(`import-collection ${TEST_COLLECTION} ${DATA_FILE} --mode=replace --allow-write`);
        runCli(`export-collection ${TEST_COLLECTION} ${EXPORT_JSON}`);
        runCli(`export-collection ${TEST_COLLECTION} ${EXPORT_CSV} --output=csv`);

        assert.ok(fs.existsSync(EXPORT_JSON), 'JSON export failed');
        assert.ok(fs.existsSync(EXPORT_CSV), 'CSV export failed');
        console.log('  ✅ CLI Setup successful.');

        // --- 2. API SERVER TESTS ---
        console.log('  Starting Explorer Server...');
        // Split SERVER_COMMAND into binary and arguments for spawn
        const [cmd, ...args] = SERVER_COMMAND.split(' ');

        serverProc = spawn(cmd, args, {
            stdio: 'pipe',
            env: {
                ...process.env,
                WISE_JSON_PATH: DB_PATH,
                PORT: '3101',
                LOG_LEVEL: 'none',
                WISEJSON_AUTH_USER: AUTH_USER,
                WISEJSON_AUTH_PASS: AUTH_PASS,
            }
        });

        // Pipe server logs for better debugging if the server fails
        serverProc.stdout?.on('data', (d) => { if(process.env['DEBUG']) console.log(`[Server]: ${d}`); });
        serverProc.stderr?.on('data', (d) => console.error(`[Server Error]: ${d}`));

        await waitServerStart();

        console.log('  Testing API Endpoints...');

        // Check Collection List
        const collections = await fetchJson(`${BASE_URL}/api/collections`, { auth: true });
        assert.ok(collections.data.some((c: any) => c.name === TEST_COLLECTION), 'Collection not found in API');

        // Check Limit
        const limitedDocs = await fetchJson(`${BASE_URL}/api/collections/${TEST_COLLECTION}?limit=5`, { auth: true });
        assert.strictEqual(limitedDocs.data.length, 5, 'API Limit filter failed');

        // Check Auth
        await assert.rejects(
            fetchJson(`${BASE_URL}/api/collections`, { auth: false }),
            /HTTP 401/,
            'API Security Breach: Accessed without credentials'
        );

        console.log('  ✅ API checks passed.');

    } finally {
        if (serverProc) {
            console.log('  Stopping server...');
            serverProc.kill('SIGTERM');
        }
        await sleep(500);
        await cleanUp();
    }

    console.log('🎉 ALL HYBRID TESTS PASSED.');
}



main().catch(async err => {
    console.error('\n🔥 TEST FAILURE:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
