import { isAlive } from './ttl.js';
import logger from '../logger.js';
import { CollectionOps, Document } from '../types.js';


/**
 * Inserts a single document into the collection.
 * Validates object type, generates a unique _id, and sets timestamps.
 * The operation is enqueued to ensure atomicity and proper locking.
 * * @param doc - The document object to insert.
 * @returns The inserted document with generated metadata (_id, createdAt, updatedAt).
 * @throws {Error} If the argument is not a plain object.
 */
export async function insert<T extends Document>(this: CollectionOps<T>, doc: T): Promise<T> {
    if (!this.isPlainObject(doc)) {
        throw new Error('insert: argument must be an object.');
    }
    return this._enqueue(async () => {
        const _id = (doc as any)._id || this._idGenerator();
        const now = new Date().toISOString();
        const finalDoc = {
            ...doc,
            _id,
            createdAt: (doc as any).createdAt || now,
            updatedAt: now,
        } as T & Document;

        const result = await this._enqueueDataModification(
            { op: 'INSERT', doc: finalDoc },
            'INSERT',
            (_prev, insertedDoc) => insertedDoc
        );
        this._stats.inserts++;
        return result;
    });
}

/**
 * Inserts multiple documents in chunks to maintain performance.
 * Splits the array into smaller batches based on configuration to avoid oversized WAL entries.
 * The entire process is wrapped in a single queue task for collection-level atomicity.
 * * @param docs - An array of document objects to insert.
 * @returns A promise resolving to an array of all successfully inserted documents.
 */
export async function insertMany<T extends Document>(this: CollectionOps<T>, docs: T[]): Promise<(T & Document)[]> {
    if (!Array.isArray(docs)) {
        throw new Error('insertMany: argument must be an array.');
    }
    if (docs.length === 0) {
        return [];
    }

    // Maximum number of documents in a single BATCH_INSERT WAL record.
    // Can be made configurable via this.options, if needed.
    const MAX_DOCS_PER_BATCH_WAL_ENTRY = this.options?.maxDocsPerBatchWalEntry || 1000;
    // If maxDocsPerBatchWalEntry isn't in this.options, we use the default of 1000.

    // The entire insertMany operation (including all chunks) must be atomic
    // from a collection locking perspective, so we wrap everything in a single _enqueue.

    return this._enqueue(async () => {
        await this._acquireLock();// Acquire the lock at the beginning
        const allInsertedDocs: (T & Document)[] = [];
        let totalProcessed = 0;

        try {
            for (let i = 0; i < docs.length; i += MAX_DOCS_PER_BATCH_WAL_ENTRY) {
                const chunk = docs.slice(i, i + MAX_DOCS_PER_BATCH_WAL_ENTRY);
                const now = new Date().toISOString();

                const preparedChunk = chunk.map(doc => ({
                    ...doc,
                    _id: (doc as any)._id || this._idGenerator(),
                    createdAt: (doc as any).createdAt || now,
                    updatedAt: now,
                })) as (T & Document)[];

                // Each chunk is written as a separate BATCH_INSERT operation to the WAL.
                // _enqueueDataModification writes to the WAL and applies it to memory.
                // Important: _enqueueDataModification itself should not call _acquireLock/_releaseLock,
                // since we are already under a shared lock.
                const insertedChunk = await this._enqueueDataModification(
                    { op: 'BATCH_INSERT', docs: preparedChunk },
                    'BATCH_INSERT',
                    (_prev, inserted) => inserted
                );

                if (Array.isArray(insertedChunk)) {
                    allInsertedDocs.push(...insertedChunk);
                    this._stats.inserts += insertedChunk.length;
                    totalProcessed += insertedChunk.length;
                } else {
                  // This should not happen if _enqueueDataModification for BATCH_INSERT returns an array
                  logger.warn(`[Ops] insertMany: _enqueueDataModification for chunk did not return an array.`);
                }
            }
            return allInsertedDocs;
        } catch (error: any) {
          // If an error occurs while processing any of the chunks (for example, a uniqueness violation
          // that was checked inside _enqueueDataModification, or a WAL write error for the chunk),
          // the entire insertMany operation is rolled back (since we are under the same _enqueue).
          // In the current implementation, _enqueueDataModification itself will throw an error, and it will be caught
          // by the error handler in _processQueue, which will call task.reject(err).
          // So here we simply re-project the error.
            logger.error(`[Ops] insertMany: error during chunk processing: ${error.message}.`);
            throw error;
        } finally {
            await this._releaseLockIfHeld();
        }
    });
}

/**
 * Updates an existing document identified by its ID.
 * Merges new data into the document and refreshes the updatedAt timestamp.
 * * @param id - The unique ID of the document to update.
 * @param updates - An object containing the fields to be updated.
 * @returns The updated document, or null if the document was not found.
 */
export async function update<T extends Document>(this: CollectionOps<T>, id: string, updates: Partial<T>): Promise<(T & Document) | null> {
    if (typeof id !== 'string' || id.length === 0) {
        throw new Error('update: id must be a non-empty string.');
    }
    if (!this.isPlainObject(updates)) {
        throw new Error('update: updates must be an object.');
    }

    return this._enqueue(async () => {
        if (!this.documents.has(id)) {
            return null;
        }
        const now = new Date().toISOString();
        const result = await this._enqueueDataModification(
            { op: 'UPDATE', id, data: { ...updates, updatedAt: now } },
            'UPDATE',
            (_prev, updatedDoc) => updatedDoc,
            { idToUpdate: id }
        );
        if (result) {
            this._stats.updates++;
        }
        return result;
    });
}

/**
 * Updates multiple documents that match a specific query function.
 * Filters the collection for alive documents and enqueues individual update tasks.
 * * @param queryFn - A predicate function that receives a document and returns true for a match.
 * @param updates - An object containing the fields to be updated in matching documents.
 * @returns The count of successfully updated documents.
 */
export async function updateMany<T extends Document>(this: CollectionOps<T>, queryFn: (doc: T & Document) => boolean, updates: Partial<T>): Promise<number> {
    if (typeof queryFn !== 'function') {
        throw new Error('updateMany: queryFn must be a function.');
    }
    if (!this.isPlainObject(updates)) {
        throw new Error('updateMany: updates must be an object.');
    }
    // We collect the ID BEFORE putting it into the queue, so as not to iterate over the mutable collection.
    const idsToUpdate: string[] = [];
    // This part runs outside of _enqueue, reading the current state of this.documents.
    // This is fine, since the actual changes will be in _enqueue.
    for (const [id, doc] of this.documents.entries()) {
        if (isAlive(doc) && queryFn(doc)) {
            idsToUpdate.push(id);
        }
    }

    if (idsToUpdate.length === 0) {
        return 0;
    }

    // All updates to updateMany are performed within a single _enqueue call
    // to ensure atomicity across the entire updateMany operation, if possible.
    // However, this.update itself calls _enqueue inside the loop.
    // To make updateMany truly atomic (all or nothing for all found documents),
    // a different design for _enqueueDataModification would be required, accepting an array of updates.
    // The current implementation makes each individual update operation atomic, but not the entire updateMany.

    // We'll keep the current implementation, where each update is a separate queued operation.
    // This is simpler, but less atomic for the entire set.
    let successfullyUpdatedCount = 0;
    for (const id of idsToUpdate) {
        try {
          // Each this.update will be queued and executed sequentially.
            const updatedDoc = await (this as any).update(id, updates);
            if (updatedDoc) {
                successfullyUpdatedCount++;
            }
        } catch (error: any) {
          // If one of the updates fails (for example, a uniqueness violation),
          // then updateMany is aborted here, and previous successful updates remain.
            logger.error(`[Ops] Error updating document ID '${id}' in updateMany: ${error.message}`);
            throw error;
        }
    }
    return successfullyUpdatedCount;
}

/**
 * Removes a document from the collection by its ID.
 * The removal is logged in the WAL and applied to memory after acquisition of the lock.
 * * @param id - The unique ID of the document to remove.
 * @returns True if the document was successfully removed, false if it didn't exist.
 */
export async function remove<T extends Document>(this: CollectionOps<T>, id: string): Promise<boolean> {
    if (typeof id !== 'string' || id.length === 0) {
        throw new Error('remove: id must be a non-empty string.');
    }

    if (!this.documents.has(id)) {
        return false;
    }

    return this._enqueue(async () => {
        if (!this.documents.has(id)) {
            return false;
        }

        const success = await this._enqueueDataModification(
            { op: 'REMOVE', id },
            'REMOVE',
            (_prev, _next) => true,
            { idToRemove: id }
        );

        if (success) {
            this._stats.removes++;
        }
        return success;
    });
}

/**
 * Removes multiple documents that satisfy the provided predicate.
 * Collects IDs first to prevent iteration issues while the collection is being modified.
 * * @param predicate - A function that returns true for documents to be deleted.
 * @returns The number of documents removed.
 */
export async function removeMany<T extends Document>(this: CollectionOps<T>, predicate: (doc: T & Document) => boolean): Promise<number> {
    if (typeof predicate !== 'function') {
        throw new Error('removeMany: predicate must be a function.');
    }

    const idsToRemove: string[] = [];
    for (const [id, doc] of this.documents.entries()) {
        if (isAlive(doc) && predicate(doc)) {
            idsToRemove.push(id);
        }
    }

    if (idsToRemove.length === 0) {
        return 0;
    }

    let removedCount = 0;
    for (const id of idsToRemove) {// Same as updateMany, loop outside _enqueue
        try {
            const success = await (this as any).remove(id);
            if (success) {
                removedCount++;
            }
        } catch (error: any) {
            logger.error(`[Ops] Error removing document ID '${id}' in removeMany: ${error.message}`);
            throw error;
        }
    }
    return removedCount;
}

/**
 * Completely clears all documents from the collection.
 * Resets memory storage, clears indexes, and resets internal operation statistics.
 * * @returns True if the collection was successfully cleared.
 */
export async function clear<T extends Document>(this: CollectionOps<T>): Promise<boolean> {
    return this._enqueue(async () => {
        const success = await this._enqueueDataModification(
            { op: 'CLEAR' },
            'CLEAR',
            () => true
        );

        if (success) {
            this._stats.clears++;
            this._stats.inserts = 0;
            this._stats.updates = 0;
            this._stats.removes = 0;
            this._stats.walEntriesSinceCheckpoint = 0;
        }
        return success;
    });
}
