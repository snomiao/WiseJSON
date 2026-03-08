import path from 'path';
import fs from 'fs/promises';
import { cleanupExpiredDocs } from './collection/ttl.js';
import { CheckpointLoadResult, CheckpointMeta, Document } from './types.js';



/**
 * Internal helper to list checkpoint files (meta or data) for a specific collection.
 */
async function getCheckpointFiles(
    checkpointsDir: string,
    collectionName: string,
    type: 'meta' | 'data' = 'meta',
    logger: any
): Promise<string[]> {
    try {
        try {
            await fs.access(checkpointsDir);
        } catch (accessError: any) {
            if (accessError.code === 'ENOENT') return [];
            throw accessError;
        }
        const files = await fs.readdir(checkpointsDir);
        return files
            .filter(f => f.startsWith(`checkpoint_${type}_${collectionName}_`) && f.endsWith('.json'))
            .sort();
    } catch (e: any) {
        logger.error(`[Checkpoint] Error reading checkpoint directory ${checkpointsDir}: ${e.message}`);
        throw e;
    }
}

/**
 * Extracts the file-system timestamp string from a meta filename.
 */
function extractTimestampFromMetaFile(metaFileName: string, collectionName: string): string | null {
    const escapedName = collectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^checkpoint_meta_${escapedName}_([\\dTZ-]+)\\.json$`);
    const match = metaFileName.match(re);
    return match ? match[1] : null;
}

/**
 * Finds and loads the most recent valid checkpoint for a collection.
 * It iterates backwards through meta files until a complete and valid set of segments is found.
 * * @param checkpointsDir - Path to the checkpoints directory.
 * @param collectionName - Name of the collection to load.
 * @param logger - Logger instance for reporting progress/warnings.
 */
export async function loadLatestCheckpoint(
    checkpointsDir: string,
    collectionName: string,
    logger: any
): Promise<CheckpointLoadResult> {
    const metaFiles = await getCheckpointFiles(checkpointsDir, collectionName, 'meta', logger);

    if (metaFiles.length === 0) {
        logger.log(`[Checkpoint] No meta-checkpoints found for '${collectionName}'. Initializing empty.`);
        return { documents: new Map(), indexesMeta: [], timestamp: null };
    }

    // Iterate from newest to oldest
    for (let i = metaFiles.length - 1; i >= 0; i--) {
        const currentMetaFile = metaFiles[i];
        const timestampFromFile = extractTimestampFromMetaFile(currentMetaFile, collectionName);

        if (!timestampFromFile) {
            logger.warn(`[Checkpoint] Failed to extract timestamp from '${currentMetaFile}'. Skipping.`);
            continue;
        }

        const allDataFilesRaw = await getCheckpointFiles(checkpointsDir, collectionName, 'data', logger);
        const escapedName = collectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const dataSegmentFiles = allDataFilesRaw.filter(f => {
            const segMatch = f.match(new RegExp(`^checkpoint_data_${escapedName}_${timestampFromFile}_seg\\d+\\.json$`));
            return !!segMatch;
        });
        dataSegmentFiles.sort();

        let metaContent: CheckpointMeta;
        try {
            const rawMeta = await fs.readFile(path.join(checkpointsDir, currentMetaFile), 'utf8');
            metaContent = JSON.parse(rawMeta);
            if (!metaContent.timestamp || typeof metaContent.timestamp !== 'string') {
                logger.warn(`[Checkpoint] Meta-file '${currentMetaFile}' lacks valid timestamp. Skipping.`);
                continue;
            }
        } catch (e: any) {
            logger.warn(`[Checkpoint] Error reading meta-file '${currentMetaFile}': ${e.message}. Skipping.`);
            continue;
        }

        // Handle empty collection checkpoints
        if (metaContent.documentCount === 0 && dataSegmentFiles.length === 0) {
            return { documents: new Map(), indexesMeta: metaContent.indexesMeta || [], timestamp: metaContent.timestamp };
        }

        if (metaContent.documentCount > 0 && dataSegmentFiles.length === 0) {
            logger.warn(`[Checkpoint] Meta-file for '${collectionName}' expects docs but segments are missing. Skipping.`);
            continue;
        }

        const documents = new Map<string, any>();
        let allSegmentsLoadedSuccessfully = true;

        for (const segFile of dataSegmentFiles) {
            try {
                const segmentDocsArray = JSON.parse(await fs.readFile(path.join(checkpointsDir, segFile), 'utf8'));
                if (Array.isArray(segmentDocsArray)) {
                    for (const doc of segmentDocsArray) {
                        if (doc && typeof doc._id !== 'undefined') {
                            documents.set(doc._id, doc);
                        }
                    }
                } else {
                    allSegmentsLoadedSuccessfully = false;
                    break;
                }
            } catch (e: any) {
                logger.warn(`[Checkpoint] Error loading data-segment '${segFile}': ${e.message}`);
                allSegmentsLoadedSuccessfully = false;
                break;
            }
        }

        if (!allSegmentsLoadedSuccessfully) continue;

        const removedByTtl = cleanupExpiredDocs(documents as Map<string, Document>);
        if (removedByTtl > 0) {
            logger.log(`[Checkpoint] Removed ${removedByTtl} expired documents during load of '${collectionName}'.`);
        }

        return {
            documents,
            indexesMeta: metaContent.indexesMeta || [],
            timestamp: metaContent.timestamp
        };
    }

    return { documents: new Map(), indexesMeta: [], timestamp: null };
}

/**
 * Removes old checkpoint files to save disk space, keeping only the 'keep' most recent versions.
 * Includes a retry mechanism for file deletion to handle potential OS locks.
 * * @param checkpointsDir - Directory to clean.
 * @param collectionName - Target collection.
 * @param keep - Number of recent checkpoints to retain.
 * @param logger - Logger instance.
 */
export async function cleanupOldCheckpoints(
    checkpointsDir: string,
    collectionName: string,
    keep = 5,
    logger: any
): Promise<void> {
    if (keep <= 0) return;

    const metaFiles = await getCheckpointFiles(checkpointsDir, collectionName, 'meta', logger);
    const allDataFiles = await getCheckpointFiles(checkpointsDir, collectionName, 'data', logger);

    if (metaFiles.length <= keep) return;

    const metaFilesToRemove = metaFiles.slice(0, metaFiles.length - keep);
    const timestampsToKeep = new Set(
        metaFiles.slice(-keep).map(f => extractTimestampFromMetaFile(f, collectionName)).filter(Boolean)
    );

    const unlinkWithRetry = async (filePath: string, fileName: string) => {
        let retries = 10;
        let delay = 500;
        while (retries > 0) {
            try {
                await fs.unlink(filePath);
                return true;
            } catch (err: any) {
                if (err.code === 'ENOENT') return true;
                retries--;
                if (retries === 0) {
                    logger.warn(`[Checkpoint] Failed to delete '${fileName}' after retries: ${err.message}`);
                    return false;
                }
                await new Promise(r => setTimeout(r, delay));
                delay = Math.min(delay + 500, 3000);
            }
        }
        return false;
    };

    // Remove meta files
    for (const file of metaFilesToRemove) {
        await unlinkWithRetry(path.join(checkpointsDir, file), file);
    }

    // Remove orphaned data segments
    const escapedName = collectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const dataFilesToRemove = allDataFiles.filter(dataFile => {
        const match = dataFile.match(new RegExp(`^checkpoint_data_${escapedName}_([\\dTZ-]+)_seg\\d+\\.json$`));
        const dataTimestamp = match ? match[1] : null;
        return dataTimestamp && !timestampsToKeep.has(dataTimestamp);
    });

    for (const file of dataFilesToRemove) {
        await unlinkWithRetry(path.join(checkpointsDir, file), file);
    }
}
