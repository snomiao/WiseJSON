import lockfile from 'proper-lockfile';
import { ReleaseLockFn } from '../types.js';



/**
 * Acquires an exclusive file-system lock on a directory.
 * Used to prevent race conditions during write operations across processes.
 * @param dirPath - Path to the collection directory.
 * @param options - Custom retry and timeout settings for the lock.
 * @returns A promise resolving to a release function.
 * @throws {Error} if the lock could not be obtained.
 */
export async function acquireCollectionLock(
    dirPath: string,
    options: lockfile.LockOptions = {}
): Promise<ReleaseLockFn> {
    return lockfile.lock(dirPath, {
        retries: {
            retries: 10,
            factor: 1.5,
            minTimeout: 100,
            maxTimeout: 1000
        },
        stale: 60000,
        ...options
    });
}

/**
 * Safely releases a previously acquired file-system lock.
 * Prevents errors if the lock was already released or never established.
 * @param releaseLock - The release function returned by acquireCollectionLock.
 */
export async function releaseCollectionLock(releaseLock: ReleaseLockFn | undefined | null): Promise<void> {
    if (releaseLock) {
        try {
            await releaseLock();
        } catch {
            // Errors during release are ignored to prevent process interruption
        }
    }
}
