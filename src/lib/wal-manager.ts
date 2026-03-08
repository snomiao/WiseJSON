import fs from 'fs/promises';
import path from 'path';
import { WalOp, ReadWalOptions, ITransactionState } from './types.js';

// wise-json/wal-manager.ts

/**
 * Returns the standard file path for a collection's WAL file.
 */
export function getWalPath(collectionDirPath: string, collectionName: string): string {
    return path.join(collectionDirPath, `wal_${collectionName}.log`);
}

/**
 * Ensures the WAL file and its parent directory exist.
 * +++ CHANGE: Added `logger` parameter +++
 * @param walPath - Full path to the WAL file.
 * @param collectionDirPath - Directory containing the collection.
 * @param logger - Logger instance.
 */
export async function initializeWal(walPath: string, collectionDirPath: string, logger: any): Promise<void> {
    const log = logger || require('./logger'); // Fallback for backward compatibility
    if (typeof walPath !== 'string') {
        log.error(`[WAL Critical] initializeWal: walPath is not a string! Type: ${typeof walPath}, Value: ${walPath}`);
        throw new TypeError('walPath must be a string in initializeWal');
    }
    await fs.mkdir(collectionDirPath, { recursive: true });
    try {
        await fs.access(walPath);
    } catch (e: any) {
        if (e.code === 'ENOENT') {
            await fs.writeFile(walPath, '', 'utf8');
        } else {
            throw e;
        }
    }
}

/**
 * Internal utility for async delays during retries.
 */
function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Appends text to the WAL and forces a physical sync to disk (fsync).
 * Includes retry logic for common filesystem errors (disk full, busy, etc.).
 * +++ CHANGE: Added `logger` parameter +++
 */
async function appendAndSyncWalRecord(
    walPath: string,
    text: string,
    logger: any,
    appendRetries = 5,
    fsyncRetries = 3,
    fsyncInitialDelayMs = 100
): Promise<void> {
    const log = logger || require('./logger');
    const lineToWrite = text + '\n';
    let lastAppendError: any = null;

    for (let i = 0; i <= appendRetries; i++) {
        try {
            await fs.appendFile(walPath, lineToWrite, 'utf8');
            lastAppendError = null;
            break;
        } catch (err: any) {
            lastAppendError = err;
            if (i < appendRetries && ['ENOSPC', 'EBUSY', 'EIO', 'EMFILE', 'EAGAIN'].includes(err.code)) {
                const wait = 100 * (i + 1);
                await delay(wait);
                continue;
            } else {
                log.error(`[WAL] appendFile error for WAL '${walPath}' (after ${i + 1} attempts): ${lastAppendError?.message}`);
                throw lastAppendError;
            }
        }
    }

    if (lastAppendError) {
        throw lastAppendError;
    }

    let fileHandle: any;
    let lastSyncError: any = null;
    let currentFsyncDelay = fsyncInitialDelayMs;

    for (let j = 0; j < fsyncRetries; j++) {
        fileHandle = undefined;
        try {
            fileHandle = await fs.open(walPath, 'r+');
            await fileHandle.sync();
            lastSyncError = null;
            break;
        } catch (syncErr: any) {
            lastSyncError = syncErr;
            log.warn(`[WAL] Sync error for file ${walPath} (attempt ${j + 1}/${fsyncRetries}): ${syncErr.message}`);
            if (j < fsyncRetries - 1) {
                await delay(currentFsyncDelay);
                currentFsyncDelay = Math.min(currentFsyncDelay * 2, 2000);
            }
        } finally {
            if (fileHandle) {
                try {
                    await fileHandle.close();
                } catch (closeErr: any) {
                    log.warn(`[WAL] Error closing fileHandle after sync attempt for ${walPath}: ${closeErr.message}`);
                }
            }
        }
    }

    if (lastSyncError) {
        log.error(`[WAL] CRITICAL ERROR: failed to perform sync for ${walPath} after ${fsyncRetries} attempts. Error: ${lastSyncError?.message}.`);
        throw lastSyncError;
    }
}

/**
 * Writes a single entry to the WAL.
 * +++ CHANGE: Added `logger` parameter +++
 */
export async function appendWalEntry(walPath: string, entry: any, logger: any): Promise<void> {
    // eslint-disable-next-line no-useless-catch
    try {
        await appendAndSyncWalRecord(walPath, JSON.stringify(entry), logger);
    } catch (err) {
        throw err;
    }
}

/**
 * Writes a block of operations wrapped in a transaction (START/OP/COMMIT).
 * This ensures "all or nothing" durability during a recovery.
 * +++ CHANGE: Added `logger` parameter +++
 */
export async function writeTransactionBlock(
    walPath: string,
    txid: string,
    ops: WalOp[],
    logger: any
): Promise<void> {
    const nowISO = new Date().toISOString();
    const block: any[] = [];
    block.push({ txn: 'start', id: txid, ts: nowISO });
    for (const op of ops) {
        block.push({
            txn: 'op',
            txid,
            col: op.colName,
            type: op.type,
            args: op.args,
            ts: op.ts || nowISO
        });
    }
    block.push({ txn: 'commit', id: txid, ts: new Date().toISOString() });

    const fullTextBlock = block.map(e => JSON.stringify(e)).join('\n');

    // eslint-disable-next-line no-useless-catch
    try {
        await appendAndSyncWalRecord(walPath, fullTextBlock, logger);
    } catch (err) {
        throw err;
    }
}

/**
 * Reads and parses the WAL file, reconstructing transactions and filtering by timestamp.
 */
export async function readWal(
    walPath: string,
    sinceTimestamp: string | null = null,
    options: ReadWalOptions = {}
): Promise<any[]> {
    // +++ CHANGE: Get logger from options or use fallback +++
    const log = options.logger || require('./logger');
    const effectiveOptions = { strict: false, recover: false, isInitialLoad: false, ...options };

    let rawContent: string;
    try {
        rawContent = await fs.readFile(walPath, 'utf8');
    } catch (e: any) {
        if (e.code === 'ENOENT') return [];
        throw e;
    }

    const lines = rawContent.trim().split('\n');
    const recoveredEntries: any[] = [];
    const transactionStates: Record<string, ITransactionState> = {};

    let cutoffDateTime: number | null = null;
    if (sinceTimestamp) {
        try {
            cutoffDateTime = Date.parse(sinceTimestamp);
            if (isNaN(cutoffDateTime)) {
                log.warn(`[WAL] Invalid sinceTimestamp '${sinceTimestamp}' while reading ${walPath}. Time filtering disabled.`);
                cutoffDateTime = null;
            }
        } catch (e: any) {
            log.warn(`[WAL] Error parsing sinceTimestamp '${sinceTimestamp}' (${e.message}) while reading ${walPath}. Time filtering disabled.`);
            cutoffDateTime = null;
        }
    }

    for (const [idx, line] of lines.entries()) {
        const currentLineNumber = idx + 1;
        if (!line.trim()) continue;

        const MAX_LINE_LEN = 20 * 1024 * 1024;
        if (line.length > MAX_LINE_LEN) {
            const msg = `[WAL] Line ${currentLineNumber} in ${walPath} exceeds length limit (${line.length} > ${MAX_LINE_LEN}), skipping.`;
            if (effectiveOptions.strict) {
                log.error(msg + " (strict mode)");
                throw new Error(msg);
            }
            log.warn(msg);
            continue;
        }

        let entry: any;
        try {
            entry = JSON.parse(line);
        } catch (e: any) {
            const errorContext = `JSON parse error on line ${currentLineNumber} in ${walPath}: ${e.message}.`;
            const linePreview = line.substring(0, 150) + (line.length > 150 ? '...' : '');

            if (typeof effectiveOptions.onError === 'function') {
                try { effectiveOptions.onError(e, line, currentLineNumber); }
                catch (userCallbackError: any) { log.error(`[WAL] Error in user onError callback: ${userCallbackError.message}`); }
            }

            if (effectiveOptions.strict) {
                log.error(errorContext + ` Content (start): "${linePreview}" (strict mode).`);
                throw new Error(errorContext + ` (strict mode).`);
            }
            log.warn(errorContext + ` Content (start): "${linePreview}" (line skipped).`);
            continue;
        }

        if (typeof entry !== 'object' || entry === null) {
            log.warn(`[WAL] Entry on line ${currentLineNumber} in ${walPath} is not an object. Skipped.`);
            continue;
        }

        if (entry.txn) {
            const txTimestampStr = entry.ts;
            const txId = entry.id || entry.txid;

            if (!txId) {
                log.warn(`[WAL] Transaction entry '${entry.txn}' without ID on line ${currentLineNumber}. Ignored.`);
                continue;
            }

            if (entry.txn === 'start') {
                if (transactionStates[txId]) {
                     log.warn(`[WAL] Duplicate TXN_START '${txId}' on line ${currentLineNumber}. Old one cancelled.`);
                }
                transactionStates[txId] = { ops: [], committed: false, startLine: currentLineNumber, timestampStr: txTimestampStr };
            } else if (entry.txn === 'op') {
                if (!transactionStates[txId] || transactionStates[txId].committed) {
                    continue;
                }
                transactionStates[txId].ops.push(entry);
            } else if (entry.txn === 'commit') {
                if (!transactionStates[txId] || transactionStates[txId].committed) {
                    continue;
                }
                transactionStates[txId].committed = true;
                transactionStates[txId].commitLine = currentLineNumber;
                transactionStates[txId].commitTimestampStr = txTimestampStr;
            }
        } else {
            const entryTsSource = entry.doc?.updatedAt ||
                                  (Array.isArray(entry.docs) && entry.docs.length > 0 && entry.docs[0]?.updatedAt) ||
                                  entry.data?.updatedAt ||
                                  entry.ts;

            let entryDateTime = entryTsSource ? Date.parse(entryTsSource) : null;

            if (entryTsSource && isNaN(entryDateTime as number)) {
                entryDateTime = null;
            }

            if (cutoffDateTime !== null && (entryDateTime === null || (entryDateTime as number) <= cutoffDateTime)) {
                continue;
            }
            recoveredEntries.push(entry);
        }
    }

    for (const txid of Object.keys(transactionStates)) {
        const state = transactionStates[txid];
        if (state.committed) {
            let txCommitDateTime = state.commitTimestampStr ? Date.parse(state.commitTimestampStr) : null;
            if(state.commitTimestampStr && isNaN(txCommitDateTime as number)) txCommitDateTime = null;

            if (cutoffDateTime !== null && (txCommitDateTime === null || (txCommitDateTime as number) <= cutoffDateTime)) {
                continue;
            }
            for (const op of state.ops) {
                recoveredEntries.push({ ...op, _txn_applied_from_wal: true, _tx_origin_id: txid });
            }
        } else {
            log.warn(`[WAL] Transaction ${txid} (started on line ${state.startLine}) in ${walPath} is incomplete (no COMMIT) and ignored.`);
        }
    }

    const logMsg = `[WAL] WAL reading complete for ${walPath}. Lines processed: ${lines.length}. Entries to apply: ${recoveredEntries.length}.` +
                   (sinceTimestamp ? ` (Time filter: after ${sinceTimestamp})` : ``);

    if (effectiveOptions.isInitialLoad) {
         log.log(logMsg.replace('[WAL]', '[WAL Init]'));
    }

    return recoveredEntries;
}

/**
 * Compacts the WAL by removing entries that occur before a specific checkpoint timestamp.
 * +++ CHANGE: Added `logger` parameter +++
 */
export async function compactWal(walPath: string, checkpointTimestamp: string | null = null, logger: any): Promise<void> {
    const log = logger || require('./logger');
    if (!checkpointTimestamp) {
        return;
    }

    let checkpointTimeNum: number;
    try {
        checkpointTimeNum = Date.parse(checkpointTimestamp);
        if (isNaN(checkpointTimeNum)) {
            log.error(`[WAL] Invalid checkpointTimestamp '${checkpointTimestamp}' during WAL compaction ${walPath}. CANCELLED.`);
            return;
        }
    } catch (e: any) {
        log.error(`[WAL] Error parsing checkpointTimestamp '${checkpointTimestamp}' (${e.message}) during WAL compaction ${walPath}. CANCELLED.`);
        return;
    }

    const allCurrentWalEntries = await readWal(walPath, null, { recover: true, strict: false, logger: log });
    const entriesToKeep: any[] = [];

    for (const entry of allCurrentWalEntries) {
        let entryTime: number | null = null;
        if (entry._txn_applied_from_wal && entry.ts) {
            entryTime = Date.parse(entry.ts);
        } else if (!entry.txn) {
             const entryTsSource = entry.doc?.updatedAt ||
                                   (Array.isArray(entry.docs) && entry.docs.length > 0 && entry.docs[0]?.updatedAt) ||
                                   entry.data?.updatedAt ||
                                   entry.ts;
             entryTime = entryTsSource ? Date.parse(entryTsSource) : null;
        }

        if (entryTime !== null && !isNaN(entryTime)) {
            if (entryTime > checkpointTimeNum) {
                entriesToKeep.push(entry);
            }
        }
    }

    const cleanEntriesToKeep = entriesToKeep.map(e => {
        const { _txn_applied_from_wal, _tx_origin_id, ...rest } = e;
        return rest;
    });

    const newWalContent = cleanEntriesToKeep.map(e => JSON.stringify(e)).join('\n') + (cleanEntriesToKeep.length > 0 ? '\n' : '');

    let attempt = 0;
    const maxAttempts = 3;
    while (true) {
        try {
            await fs.writeFile(walPath, newWalContent, 'utf8');
            let fileHandleCompact: any;
            try {
                fileHandleCompact = await fs.open(walPath, 'r+');
                await fileHandleCompact.sync();
            } catch (syncErr: any) {
                log.warn(`[WAL] Sync error after overwriting WAL ${walPath} during compaction: ${syncErr.message}`);
            } finally {
                if (fileHandleCompact !== undefined) {
                    await fileHandleCompact.close().catch((closeErr: any) => log.warn(`[WAL] Error closing fileHandle for WAL ${walPath} after sync in compactWal: ${closeErr.message}`));
                }
            }
            log.log(`[WAL] WAL compaction for ${walPath} complete. Remaining entries: ${cleanEntriesToKeep.length} (was before filtering: ${allCurrentWalEntries.length}).`);
            break;
        } catch (err: any) {
            attempt++;
            if (attempt < maxAttempts) {
                await delay(100 * attempt);
            } else {
                log.error(`[WAL] CRITICAL ERROR overwriting WAL ${walPath} during compaction (after ${maxAttempts} attempts): ${err.message}.`);
                break;
            }
        }
    }
}
