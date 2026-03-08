/**
 * test/run-all-tests.ts
 * Orchestrator to run all TypeScript integration tests in sequence.
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

// --- ESM Compatibility ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Runs a single test file using 'tsx'.
 */
async function runTest(filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const testName = path.basename(filePath);
        console.log(`\n\n🚀 ===== Running test: ${testName} =====\n`);
        
        // Use 'npx tsx' to ensure the TypeScript file is executed correctly
        const child = spawn('npx', ['tsx', filePath], {
            stdio: 'inherit',
            env: { ...process.env, NODE_OPTIONS: '--no-warnings' }
        });

        child.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`❌ Test failed: ${testName} (exit code ${code})`));
            } else {
                console.log(`\n✅ PASSED: ${testName}`);
                resolve();
            }
        });
        
        child.on('error', (err) => {
             reject(new Error(`💥 Failed to start test: ${testName}. Error: ${err.message}`));
        });
    });
}

async function main() {
    console.log('🧪 Starting the WiseJSON test suite...');
    
    const testDir = __dirname;
    const allFilesInDir = await fs.readdir(testDir);
    
    // Find all files ending in .test.ts or -all.ts, excluding this runner
    const testFiles = allFilesInDir
        .filter(f => 
            (f.endsWith('.test.ts') || f.endsWith('-all.ts') || f.endsWith('-scenarios.ts')) 
            && f !== path.basename(__filename)
        )
        .map(f => path.join(testDir, f));

    if (testFiles.length === 0) {
        console.warn('⚠️ No test files found. Check your naming convention (*.test.ts or *-all.ts).');
        return;
    }

    console.log(`🔍 Found ${testFiles.length} test files to run.`);

    // Run tests sequentially to avoid port/database conflicts
    for (const file of testFiles) {
        try {
            await runTest(file);
        } catch (error: any) {
            console.error(`\n\n============================`);
            console.error(`🔥 CRITICAL FAILURE: ${error.message}`);
            console.error(`Aborting remaining tests.`);
            console.error(`============================`);
            process.exit(1);
        }
    }
    
    console.log('\n\n==========================================');
    console.log(`🎊 SUCCESS: All ${testFiles.length} tests passed!`);
    console.log('==========================================');
}

main().catch(error => {
    console.error('Unexpected error in test runner:', error);
    process.exit(1);
});