import fs from 'fs/promises';
import logger from './logger.js';

/**
 * Checks if a file or directory exists at the given path.
 * @param filePath - The path to check.
 * @returns Promise resolving to true if path is accessible.
 */
export async function pathExists(filePath: string): Promise<boolean> {
    try {
        await fs.access(filePath);
        return true;
    } catch (err: any) {
        if (err.code === 'ENOENT') return false;
        // ASSUMPTION: For other errors (e.g. access denied) return false, but log.
        logger.warn(`[StorageUtils] Path "${filePath}" not accessible: ${err.code}`);
        return false;
    }
}

/**
 * Ensures a directory exists by creating it recursively if necessary.
 * @param dirPath - Target directory path.
 */
export async function ensureDirectoryExists(dirPath: string): Promise<void> {
    try {
        await fs.mkdir(dirPath, { recursive: true });
    } catch (err: any) {
        if (err.code !== 'EEXIST') {
          // ASSUMPTION: Directory creation error is critical, re-throwing the error.
            logger.error(`[StorageUtils] Error creating directory "${dirPath}": ${err.message}`);
            throw err;
        }
    }
}

/**
 * Writes data to a file atomically using a temporary file and rename strategy.
 * This prevents data corruption if the system crashes during a write operation.
 * @param filePath - Final destination path.
 * @param data - The object to serialize as JSON.
 * @param jsonIndent - Number of spaces for JSON formatting.
 */
export async function writeJsonFileSafe(
    filePath: string,
    data: any,
    jsonIndent: number | null = null
): Promise<void> {
    const tmpPath = `${filePath}.${Date.now()}-${Math.random().toString(36).substring(2, 10)}.tmp`;

    try {
        const json = JSON.stringify(data, null, jsonIndent ?? undefined);
        await fs.writeFile(tmpPath, json, 'utf-8');
        try {
            await fs.rename(tmpPath, filePath);
        } catch (err: any) {
          // ASSUMPTION: If renaming fails, we try to delete the tmp file and throw the error above.
            logger.error(`[StorageUtils] Rename failed: ${tmpPath} -> ${filePath}`);
            await deleteFileIfExists(tmpPath);
            throw err;
        }
    } catch (err: any) {
      // If we couldn't delete the tmp file, we only log it and don't throw the error again.
        logger.error(`[StorageUtils] JSON write error for "${filePath}": ${err.message}`);
        await deleteFileIfExists(tmpPath);
        throw err;
    }
}

/**
 * Reads and parses a JSON file from disk.
 * @param filePath - Path to the file.
 * @returns The parsed object, or null if the file does not exist.
 * @throws {Error} if JSON parsing fails.
 */
export async function readJsonFile<T = any>(filePath: string): Promise<T | null> {
    try {
        const raw = await fs.readFile(filePath, 'utf-8');
        try {
            return JSON.parse(raw) as T;
        } catch (parseErr: any) {
          // ASSUMPTION: A corrupted JSON file is a fatal error.
            logger.error(`[StorageUtils] JSON parse error in "${filePath}": ${parseErr.message}`);
            throw parseErr;
        }
    } catch (err: any) {
      // ASSUMPTION: Read errors other than ENOENT are critical, forwarding further.
        if (err.code === 'ENOENT') return null;
        throw err;
    }
}

/**
 * Safely copies a file (e.g., for creating a backup).
 * If the destination file already exists, it will be overwritten.
 * @param src - Source file path.
 * @param dst - Destination file path.
 * @throws {Error} If the copy operation fails.
 */
export async function copyFileSafe(src: string, dst: string): Promise<void> {
    try {
        await fs.copyFile(src, dst);
    } catch (err: any) {
        // ASSUMPTION: Copy errors are critical, propagate to the caller.
        logger.error(`[StorageUtils] Copy error from "${src}" to "${dst}": ${err.message}`);
        throw err;
    }
}

/**
 * Deletes a file if it exists on the filesystem.
 * @param filePath - Path to the file to be removed.
 * @remarks Logs a warning but does not throw an error if deletion or existence check fails.
 */
export async function deleteFileIfExists(filePath: string): Promise<void> {
    try {
        // We check existence first to avoid unnecessary error noise for missing files
        if (await pathExists(filePath)) {
            await fs.unlink(filePath);
        }
    } catch (err: any) {
        /**
         * ASSUMPTION: Failure to delete a file or check its presence is not
         * critical to the core system flow; we log the warning and continue.
         */
        logger.warn(`[StorageUtils] Failed to clean up file at "${filePath}": ${err.message}`);
    }
}
