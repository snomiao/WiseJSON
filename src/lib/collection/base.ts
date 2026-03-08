import { isAlive } from './ttl.js';
import logger from '../logger.js';
import * as utils from './utils.js';
import {
  Document,
  CollectionOptions,
  CollectionStats,
  UpdateResult,
  UpdateQuery,
  Filter,
} from '../types.js';
import { IndexManager } from './indexes.js';

/**
 * Base class providing core CRUD operations.
 * This class is abstract because it relies on the persistence, locking,
 * and queueing logic implemented in the final Collection class.
 */
export abstract class CollectionBase<T extends Document> {
  // Primary in-memory data store
  public documents: Map<string, T> = new Map();

  // Abstract requirements to be fulfilled by the child Collection class
  protected abstract options: Required<CollectionOptions>;
  protected abstract _stats: CollectionStats;
  protected abstract _idGenerator: () => string;
  protected abstract _enqueue<R>(task: () => Promise<R>): Promise<R>;
  protected abstract _enqueueDataModification<R>(
    data: any,
    opType: string,
    getResult: (prev: any, next: any) => R,
    options?: any,
  ): Promise<R>;
  protected abstract _acquireLock(): Promise<void>;
  protected abstract _releaseLockIfHeld(): Promise<void>;

  protected abstract _indexManager: IndexManager;

  // Utility exposed to the base methods
  protected isPlainObject = utils.isPlainObject;

  /**
   * Inserts a single document into the collection.
   * Validates object type, generates a unique _id, and sets timestamps.
   */
  public async insert(doc: T): Promise<T> {
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
      } as T;

      const result = await this._enqueueDataModification(
        { op: 'INSERT', doc: finalDoc },
        'INSERT',
        (_prev, insertedDoc) => insertedDoc,
      );
      this._stats.inserts++;
      return result;
    });
  }

  /**
   * Inserts multiple documents in chunks to maintain performance.
   */
  public async insertMany(docs: T[]): Promise<T[]> {
    if (!Array.isArray(docs)) {
      throw new Error('insertMany: argument must be an array.');
    }
    if (docs.length === 0) {
      return [];
    }

    const MAX_DOCS_PER_BATCH_WAL_ENTRY =
      this.options.maxWalEntriesBeforeCheckpoint || 1000;

    return this._enqueue(async () => {
      await this._acquireLock();
      const allInsertedDocs: T[] = [];

      try {
        for (let i = 0; i < docs.length; i += MAX_DOCS_PER_BATCH_WAL_ENTRY) {
          const chunk = docs.slice(i, i + MAX_DOCS_PER_BATCH_WAL_ENTRY);
          const now = new Date().toISOString();

          const preparedChunk = chunk.map((doc) => ({
            ...doc,
            _id: (doc as any)._id || this._idGenerator(),
            createdAt: (doc as any).createdAt || now,
            updatedAt: now,
          })) as T[];

          const insertedChunk = await this._enqueueDataModification(
            { op: 'BATCH_INSERT', docs: preparedChunk },
            'BATCH_INSERT',
            (_prev, inserted) => inserted,
          );

          if (Array.isArray(insertedChunk)) {
            allInsertedDocs.push(...insertedChunk);
            this._stats.inserts += insertedChunk.length;
          } else {
            logger.warn(
              `[Ops] insertMany: _enqueueDataModification did not return an array.`,
            );
          }
        }
        return allInsertedDocs;
      } catch (error: any) {
        logger.error(
          `[Ops] insertMany error during chunk processing: ${error.message}.`,
        );
        throw error;
      } finally {
        await this._releaseLockIfHeld();
      }
    });
  }

  /**
   * Updates an existing document identified by its ID.
   */
  public async update(id: string, updates: Partial<T>): Promise<T | null> {
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
        { idToUpdate: id },
      );
      if (result) {
        this._stats.updates++;
      }
      return result;
    });
  }

  /**
   * Removes a document from the collection by its ID.
   */
  public async remove(id: string): Promise<boolean> {
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
        { idToRemove: id },
      );

      if (success) {
        this._stats.removes++;
      }
      return success;
    });
  }

  /**
   * Removes multiple documents that satisfy the provided predicate.
   */
  public async removeMany(predicate: (doc: T) => boolean): Promise<number> {
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
    for (const id of idsToRemove) {
      try {
        const success = await this.remove(id);
        if (success) {
          removedCount++;
        }
      } catch (error: any) {
        logger.error(
          `[Ops] Error removing document ID '${id}' in removeMany: ${error.message}`,
        );
        throw error;
      }
    }
    return removedCount;
  }

  /**
   * Completely clears all documents from the collection.
   */
  public async clear(): Promise<boolean> {
    return this._enqueue(async () => {
      const success = await this._enqueueDataModification(
        { op: 'CLEAR' },
        'CLEAR',
        () => true,
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

  // /**
  //  * Returns the current number of documents in the collection.
  //  */
  // public get count(): number {
  //   return this.documents.size;
  // }
}
