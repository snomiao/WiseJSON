/* eslint-disable @typescript-eslint/no-empty-function */
import path from 'path';
import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import { CollectionEventEmitter } from './events.js';
import { IndexManager } from './indexes.js';
import { SyncManager } from '../sync/sync-manager.js';
import { UniqueConstraintError } from '../errors.js';
import * as utils from './utils.js';
import * as wal from '../wal-manager.js';
import * as checkpoint from '../checkpoint-manager.js';
import * as dataExchange from './data-exchange.js';

import { cleanupExpiredDocs, isAlive } from './ttl.js';
import { acquireCollectionLock, releaseCollectionLock } from './file-lock.js';
import { createWriteQueue } from './queue.js';
import { writeJsonFileSafe } from '../storage-utils.js';
import defaultLogger from '../logger.js';

import {
  IndexOptions,
  IndexMetadata,
  Document,
  CollectionStats,
  CollectionOptions,
  WalTransactionEntry,
  SyncManagerEventMap,
  CollectionEventMap,
  SyncOptions,
  SyncStatus,
} from '../types.js';
import { CollectionQueryBase } from './query.base.js';
import { exportJson } from './data-exchange.js';
import { ApiClient } from '../sync/api-client.js';

/**
 * The core Collection implementation responsible for data persistence,
 * Write-Ahead Logging (WAL), indexing, and optional cloud synchronization.
 */
export class Collection<T extends Document = any> extends CollectionQueryBase<T> {
  /** The unique name of the collection (used for folder naming). */
  public readonly name: string;
  /** The absolute root directory where the database resides. */
  public readonly dbRootPath: string;
  /** The specific directory path for this collection's data. */
  public readonly collectionDirPath: string;
  /** The subdirectory where segmented checkpoint JSON files are stored. */
  public readonly checkpointsDir: string;
  /** The absolute path to the Write-Ahead Log (.log) file. */
  public readonly walPath: string;
  /** Path to the log file used for storing failed remote operations for manual review. */
  public readonly quarantinePath: string;
  /** The consolidated configuration settings for this collection. */
  public readonly options: Required<CollectionOptions>;
  /** Logger instance used for system diagnostics (defaults to console). */
  public readonly logger: any;
  /** A promise that resolves to true once the collection has finished loading from disk. */
  public readonly isReady: Promise<boolean>;
  /** Manager handling WebSocket/Cloud synchronization logic. */
  public syncManager: SyncManager | null = null;

  /** Handles the internal indexing logic for fast lookups and unique constraints. */
  protected _indexManager: IndexManager;
  /** Internal event bus for broadcasting lifecycle events (insert, update, remove, etc). */
  protected _emitter: CollectionEventEmitter<T>;
  /** Live tracking of collection operations and WAL state. */
  protected _stats: CollectionStats;
  /** A serialized execution queue that prevents data race conditions during write operations. */
  protected _enqueue!: <R>(task: () => Promise<R>) => Promise<R>;

  /** Interval ID for the periodic flushToDisk persistence task. */
  private _checkpointTimerId: NodeJS.Timeout | null = null;
  /** Interval ID for the background removal of expired documents. */
  private _ttlCleanupTimer: NodeJS.Timeout | null = null;
  /** A cleanup function returned by the file-locking utility to release directory access. */
  private _releaseLock: (() => Promise<void>) | null = null;

  apiClient: ApiClient

  /**
   * @param name - The unique collection name.
   * @param dbRootPath - Path where the database folder resides.
   * @param options - Configuration for segments, WAL, and TTL.
   */
  constructor(name: string, dbRootPath: string, options: CollectionOptions = {}) {
    super();
    if (!utils.isNonEmptyString(name)) {
      throw new Error('Collection: collection name must be a non-empty string.');
    }

    this.name = name;
    this.dbRootPath = utils.makeAbsolutePath(dbRootPath);
    this.options = this._validateOptions(options);
    this.logger = this.options.logger || console;

    this.collectionDirPath = path.resolve(this.dbRootPath, this.name);
    this.checkpointsDir = path.join(this.collectionDirPath, '_checkpoints');
    this.walPath = wal.getWalPath(this.collectionDirPath, this.name);
    this.quarantinePath = path.join(this.collectionDirPath, `quarantine_${this.name}.log`);

    this._emitter = new CollectionEventEmitter(this.name);
    this._indexManager = new IndexManager(this.name, this.logger);

    this._stats = {
      inserts: 0, updates: 0, removes: 0, clears: 0,
      walEntriesSinceCheckpoint: 0,
      lastCheckpointTimestamp: null,
      count: 0,
    };

    createWriteQueue(this as any);
    this.isReady = this._initialize();
    this.apiClient = options.apiClient as ApiClient
  }

  /**
   * Orchestrates the startup sequence: folder creation, checkpoint loading, and WAL replay.
   * @internal
   */
  private async _initialize(): Promise<boolean> {
    try {
      await fs.mkdir(this.collectionDirPath, { recursive: true });
      await fs.mkdir(this.checkpointsDir, { recursive: true });

      await wal.initializeWal(this.walPath, this.collectionDirPath, this.logger);

      const loaded = await checkpoint.loadLatestCheckpoint(this.checkpointsDir, this.name, this.logger);
      this.documents = loaded.documents;
      this._stats.lastCheckpointTimestamp = loaded.timestamp || null;

      for (const idx of loaded.indexesMeta || []) {
        try {
          this._indexManager.createIndex(idx.fieldName, { unique: idx.type === 'unique' });
        } catch (e) { /* ignore existing */ }
      }
      this._indexManager.rebuildIndexesFromData(this.documents);

      const walEntries = await wal.readWal(this.walPath, this._stats.lastCheckpointTimestamp, {
        ...this.options.walReadOptions,
        isInitialLoad: true,
        logger: this.logger
      });

      for (const entry of walEntries) {
        if (entry.txn === 'op' && entry._txn_applied_from_wal) {
          await this._applyTransactionWalOp(entry, true);
        } else if (!entry.txn) {
          this._applyWalEntryToMemory(entry, false, true);
        }
      }

      this._stats.walEntriesSinceCheckpoint = walEntries.length;
      this._indexManager.rebuildIndexesFromData(this.documents);

      this._startCheckpointTimer();
      this._startTtlCleanupTimer();

      this._emitter.emit('initialized');
      return true;
    } catch (err) {
      this.logger.error(`Init failed for ${this.name}:`, err);
      throw err;
    }
  }

  /** * Satisfies parent requirement to lock the file system for this collection.
   * @protected
   */
  protected async _acquireLock(): Promise<void> {
    if (this._releaseLock) return;
    this._releaseLock = await acquireCollectionLock(this.collectionDirPath);
  }

  /** * Safely releases the file system lock if it is currently held.
   * @protected
   */
  protected async _releaseLockIfHeld(): Promise<void> {
    if (this._releaseLock) {
      await releaseCollectionLock(this._releaseLock);
      this._releaseLock = null;
    }
  }

  /**
   * Segments memory data into JSON files and clears the WAL.
   * This is the primary persistence mechanism used for recovery and startup.
   * @public
   */
  public async flushToDisk(): Promise<void> {
    return this._enqueue(async () => {
      cleanupExpiredDocs(this.documents as any, this._indexManager);
      const timestamp = new Date().toISOString();
      const tsFile = timestamp.replace(/[:.]/g, '-');

      const meta = {
        collectionName: this.name,
        timestamp,
        documentCount: this.documents.size,
        indexesMeta: this._indexManager.getIndexesMeta() || []
      };
      await writeJsonFileSafe(path.join(this.checkpointsDir, `checkpoint_meta_${this.name}_${tsFile}.json`), meta, null);

      const docs = Array.from(this.documents.values());
      let segIdx = 0, currentSeg: T[] = [], currentSize = 2;

      for (const d of docs) {
        const dStr = JSON.stringify(d);
        const dSize = Buffer.byteLength(dStr, 'utf8') + (currentSeg.length > 0 ? 1 : 0);
        if (currentSize + dSize > this.options.maxSegmentSizeBytes && currentSeg.length > 0) {
          await writeJsonFileSafe(path.join(this.checkpointsDir, `checkpoint_data_${this.name}_${tsFile}_seg${segIdx++}.json`), currentSeg, null);
          currentSeg = []; currentSize = 2;
        }
        currentSeg.push(d);
        currentSize += dSize;
      }
      if (currentSeg.length > 0) {
        await writeJsonFileSafe(path.join(this.checkpointsDir, `checkpoint_data_${this.name}_${tsFile}_seg${segIdx++}.json`), currentSeg, null);
      }

      this._stats.lastCheckpointTimestamp = timestamp;
      this._stats.walEntriesSinceCheckpoint = 0;
      await wal.compactWal(this.walPath, timestamp, this.logger);
      if (this.options.checkpointsToKeep > 0) {
        await checkpoint.cleanupOldCheckpoints(this.checkpointsDir, this.name, this.options.checkpointsToKeep, this.logger);
      }
      this._emitter.emit('checkpoint', { timestamp });
    });
  }

  /**
   * Enables the synchronization engine for this collection.
   * * Configures a SyncManager, forwards internal sync events to the collection emitter,
   * and initiates the synchronization loop.
   * * @param syncOptions - Configuration including remote URL and API credentials.
   * @throws {Error} If required synchronization parameters are missing.
   */
  public enableSync(syncOptions: SyncOptions): void {
    if (this.syncManager) {
      this.logger.warn(`[Sync] Sync for collection '${this.name}' is already enabled.`);
      return;
    }

    const { url, apiKey } = syncOptions;
    if (!url || !apiKey) {
      throw new Error('Sync requires `url` and `apiKey`.');
    }

    // Initialize the SyncManager with this collection instance
    this.syncManager = new SyncManager({
      collection: this,
      apiClient: this.apiClient,
      logger: this.logger,
      ...syncOptions,
    });

    this.syncManager.start();
  }

  /**
   * Gracefully stops the synchronization engine and cleans up the SyncManager instance.
   */
  public disableSync(): void {
    if (this.syncManager) {
      this.syncManager.stop();
      this.syncManager = null;
      this.logger.log(`[Sync] Sync for collection '${this.name}' stopped.`);
    }
  }

  /**
   * Manually triggers a synchronization cycle (Push and Pull).
   * * @returns A promise that resolves when the synchronization cycle completes.
   */
  public async triggerSync(): Promise<void> {
    if (!this.syncManager) {
      this.logger.warn(`[Sync] Cannot trigger sync for '${this.name}', sync is not enabled.`);
      return Promise.resolve();
    }
    return this.syncManager.runSync();
  }

  /**
   * Retrieves the current status of the synchronization engine.
   * * @returns An object containing the current sync state, LSN, and progress.
   */
  public getSyncStatus(): SyncStatus {
    if (!this.syncManager) {
      return {
        state: 'disabled',
        isSyncing: false,
        lastKnownServerLSN: 0,
        initialSyncComplete: false,
      };
    }
    return this.syncManager.getStatus();
  }

  /**
   * Routes complex transactional operations (from WAL or sync) to specific memory handlers.
   * @param entry - The transactional operation entry.
   * @param isInitialLoad - Whether this is being applied during collection startup.
   * @internal
   */
  public async _applyTransactionWalOp(entry: WalTransactionEntry, isInitialLoad = false): Promise<void> {
    const txidForLog = entry.txid || entry.id || 'unknown_txid';
    switch (entry.type) {
      case 'insert': await this._applyTransactionInsert(entry.args[0], txidForLog, isInitialLoad); break;
      case 'insertMany': await this._applyTransactionInsertMany(entry.args[0], txidForLog, isInitialLoad); break;
      case 'update': await this._applyTransactionUpdate(entry.args[0], entry.args[1], txidForLog, isInitialLoad); break;
      case 'remove': await this._applyTransactionRemove(entry.args[0], txidForLog, isInitialLoad); break;
      case 'clear': await this._applyTransactionClear(txidForLog, isInitialLoad); break;
      default:
        this.logger.warn(`[Collection] Unknown transactional op '${(entry as any).type}' for ${this.name}, txid: ${txidForLog}`);
    }
  }

  /** Handles a single document insertion within a transaction. */
  private async _applyTransactionInsert(docData: any, txid: string, isInitialLoad = false) {
    const _id = docData._id || this._idGenerator();
    if (!isInitialLoad && this.documents.has(_id)) {
      throw new Error(`Cannot apply transaction insert: document ${_id} already exists.`);
    }
    const now = new Date().toISOString();
    const finalDoc = { ...docData, _id, createdAt: docData.createdAt || now, updatedAt: docData.updatedAt || now, _txn: txid };
    this.documents.set(_id, finalDoc);
    this._indexManager.afterInsert(finalDoc);
    this._stats.inserts++;
    this._emitter.emit('insert', finalDoc);
    return finalDoc;
  }

  /** Handles multiple document insertions within a transaction. */
  private async _applyTransactionInsertMany(docsData: any[], txid: string, isInitialLoad = false) {
    if (!isInitialLoad) {
      for (const d of docsData) {
        const _id = d._id || this._idGenerator();
        if (this.documents.has(_id)) throw new Error(`Document ${_id} already exists.`);
      }
    }
    const now = new Date().toISOString(), insertedDocs = [];
    for (const d of docsData) {
      const _id = d._id || this._idGenerator();
      const finalDoc = { ...d, _id, createdAt: d.createdAt || now, updatedAt: d.updatedAt || now, _txn: txid };
      this.documents.set(_id, finalDoc);
      this._indexManager.afterInsert(finalDoc);
      this._stats.inserts++;
      this._emitter.emit('insert', finalDoc);
      insertedDocs.push(finalDoc);
    }
    return insertedDocs;
  }

  /** Handles a document update within a transaction. */
  private async _applyTransactionUpdate(id: string, updates: any, txid: string, isInitialLoad = false) {
    const oldDoc = this.documents.get(id);
    if (!oldDoc && !isInitialLoad) throw new Error(`Document ${id} not found.`);
    if (!oldDoc) return null;
    const { _id, createdAt, ...rest } = updates;
    const now = new Date().toISOString();
    const newDoc = { ...oldDoc, ...rest, updatedAt: updates.updatedAt || now, _txn: txid };
    this.documents.set(id, newDoc);
    this._indexManager.afterUpdate(oldDoc, newDoc);
    this._stats.updates++;
    this._emitter.emit('update', {
      newDoc, oldDoc,
      id
    });
    return newDoc;
  }

  /** Handles document removal within a transaction. */
  private async _applyTransactionRemove(id: string, txid: string, isInitialLoad = false) {
    const doc = this.documents.get(id);
    if (!doc) return false;
    this.documents.delete(id);
    this._indexManager.afterRemove(doc);
    this._stats.removes++;
    this._emitter.emit('remove', {doc});
    return true;
  }

  /** Handles collection clearing within a transaction. */
  private async _applyTransactionClear(txid: string, isInitialLoad = false) {
    const clearedCount = this.documents.size;
    this.documents.clear();
    this._indexManager.clearAllData();
    this._stats.clears++;
    this._stats.inserts = 0; this._stats.updates = 0; this._stats.removes = 0;
    this._stats.walEntriesSinceCheckpoint = 0;
    this._emitter.emit('trnx:clear', { clearedCount, _txn: txid });
    return true;
  }

  /**
   * Directly modifies memory Map and indexes based on a standard WAL entry.
   * @param entry - The WAL entry object.
   * @param emitEvents - Whether to broadcast events to listeners.
   * @param isInitialLoad - Whether this is being applied during startup.
   * @internal
   */
  protected _applyWalEntryToMemory(entry: any, emitEvents = true, isInitialLoad = false) {
    switch (entry.op) {
      case 'INSERT': {
        const doc = entry.doc;
        if (!doc || !doc._id) throw new Error('Cannot apply INSERT: document or _id missing.');
        if (!isInitialLoad && this.documents.has(doc._id) && !entry._remote) {
            throw new Error(`Cannot apply INSERT: document ${doc._id} already exists.`);
        }
        this.documents.set(doc._id, doc);
        this._indexManager.afterInsert(doc);
        if (emitEvents) this._emitter.emit('insert', doc);
        break;
      }
      case 'BATCH_INSERT': {
        const docs = Array.isArray(entry.docs) ? entry.docs : [];
        if (!isInitialLoad) {
          for (const d of docs) {
            if (!d?._id) throw new Error('Cannot apply BATCH_INSERT: _id missing.');
            if (this.documents.has(d._id) && !entry._remote) throw new Error(`Duplicate _id ${d._id}`);
          }
        }
        for (const d of docs) {
          this.documents.set(d._id, d);
          this._indexManager.afterInsert(d);
          if (emitEvents) this._emitter.emit('insert', d);
        }
        break;
      }
      case 'UPDATE': {
        const id = entry.id;
        const data = entry.data;
        const prev = this.documents.get(id);
        if (!prev) {
          if (isInitialLoad && data) {
            const newDoc = { _id: id, createdAt: new Date().toISOString(), ...data, updatedAt: data.updatedAt || new Date().toISOString() };
            this.documents.set(id, newDoc);
            this._indexManager.afterInsert(newDoc);
            if (emitEvents) this._emitter.emit('insert', newDoc);
            return;
          }
          if (!entry._remote) throw new Error(`Document ${id} not found.`);
          return;
        }
        const updated = { ...prev, ...data };
        this.documents.set(id, updated);
        this._indexManager.afterUpdate(prev, updated);
        if (emitEvents) this._emitter.emit('update', { id, oldDoc: prev, newDoc: updated });
        break;
      }
      case 'REMOVE': {
        const doc = this.documents.get(entry.id);
        if (doc) {
          this.documents.delete(entry.id);
          this._indexManager.afterRemove(doc);
          if (emitEvents) this._emitter.emit('remove', {doc});
        }
        break;
      }
      case 'CLEAR':
        { const count = this.documents.size;
        this.documents.clear();
        this._indexManager.clearAllData();
        if (emitEvents) this._emitter.emit('clear', { clearedCount: count });
        break; }
      default: throw new Error(`Unknown op: ${entry.op}`);
    }
  }

  async compactWalAfterPush() {
    this.logger.log(`[Collection] Compacting local state for '${this.name}' after successful sync push by flushing to disk.`);
    return this.flushToDisk();
  }

  /** * Validates unique constraints, appends to the WAL, and triggers the in-memory update.
   * @internal
   */
  protected async _enqueueDataModification(entry: any, opType: string, getResultFn?: (err: any, res: any) => any) {
    this._validateUniqueConstraints(entry, opType);
    await wal.appendWalEntry(this.walPath, { ...entry, opId: uuidv4() }, this.logger);
    this._applyWalEntryToMemory(entry, true);
    this._handlePotentialCheckpointTrigger();
    const result = opType === 'INSERT' ? entry.doc : (opType === 'BATCH_INSERT' ? entry.docs : this.documents.get(entry.id));
    return getResultFn ? getResultFn(undefined, result) : result;
  }

  /**
   * Processes operations received from a remote sync server. Handles timestamp-based conflict resolution.
   * @param remoteOp - The operation received from the sync manager.
   * @internal
   */
  public async _applyRemoteOperation(remoteOp: any) {
    if (!remoteOp?.op) return;
    return this._enqueue(async () => {
      const docId = remoteOp.id || remoteOp.doc?._id;
      const localDoc = docId ? this.documents.get(docId) : null;

      if (remoteOp.op === 'INSERT' && localDoc) return;
      if (remoteOp.op === 'UPDATE' && !localDoc) return;

      const remoteTsStr = remoteOp.ts || remoteOp.doc?.updatedAt || remoteOp.data?.updatedAt;
      if (localDoc && remoteTsStr) {
        const remoteTs = new Date(remoteTsStr).getTime();
        const localTs = new Date(localDoc.updatedAt!).getTime();
        if (localTs > remoteTs) {
          this._emitter.emit('sync:conflict_resolved', { type: 'ignored_remote', reason: 'local_is_newer', docId });
          return;
        }
      }

      try {
        this._applyWalEntryToMemory(remoteOp, true, false);
        await wal.appendWalEntry(this.walPath, { ...remoteOp, _remote: true }, this.logger);
      } catch (err: any) {
        await this._quarantineOperation(remoteOp, err);
      }
    });
  }

  /** Logs a failed remote operation to the quarantine file for safety. */
  private async _quarantineOperation(op: any, error: any) {
    const entry = { quarantinedAt: new Date().toISOString(), operation: op, error: { message: error.message, stack: error.stack } };
    await fs.appendFile(this.quarantinePath, JSON.stringify(entry) + '\n', 'utf8');
    this._emitter.emit('sync:quarantine', entry);
  }

  /** Scans unique indexes to ensure a write operation does not violate constraints. */
  private _validateUniqueConstraints(entry: any, opType: string) {
    const uniques = this._indexManager.getIndexesMeta().filter(i => i.type === 'unique');
    if (uniques.length === 0) return;

    const check = (doc: any, id?: string) => {
      for (const idx of uniques) {
        const val = doc[idx.fieldName];
        if (val === undefined || val === null) continue;
        const existingId = this._indexManager.findOneIdByIndex(idx.fieldName, val);
        if (existingId && existingId !== id) throw new UniqueConstraintError(idx.fieldName, val);
      }
    };

    if (opType === 'INSERT') check(entry.doc);
    else if (opType === 'BATCH_INSERT') entry.docs.forEach((d: any) => check(d));
    else if (opType === 'UPDATE') check(entry.data, entry.id);
  }

  /** Merges user-provided options with system defaults. */
  private _validateOptions(opts: CollectionOptions): Required<CollectionOptions> {
    return utils.validateOptions(opts)
  }

  /** Default ID generator bridging the options to the class logic. */
  protected _idGenerator = (): string => this.options.idGenerator();

  /** Starts the recurring persistence timer. */
  private _startCheckpointTimer() {
    this.stopCheckpointTimer();
    if (this.options.checkpointIntervalMs > 0) {
      this._checkpointTimerId = setInterval(() => this.flushToDisk().catch(() => {}), this.options.checkpointIntervalMs);
      if (this._checkpointTimerId?.unref) this._checkpointTimerId.unref();
    }
  }

  /** Starts the recurring TTL cleanup timer. */
  private _startTtlCleanupTimer() {
    this._stopTtlCleanupTimer()
    if (this.options.ttlCleanupIntervalMs > 0) {
      this._ttlCleanupTimer = setInterval(() => cleanupExpiredDocs(this.documents as any, this._indexManager), this.options.ttlCleanupIntervalMs);
      if (this._ttlCleanupTimer?.unref) this._ttlCleanupTimer.unref();
    }
  }

  /** Checks if the WAL entry count has reached the threshold to trigger an auto-checkpoint. */
  private _handlePotentialCheckpointTrigger() {
    this._stats.walEntriesSinceCheckpoint++;
    if (this.options.maxWalEntriesBeforeCheckpoint > 0 && this._stats.walEntriesSinceCheckpoint >= this.options.maxWalEntriesBeforeCheckpoint) {
      this.flushToDisk().catch(() => {});
    }
  }

  /** * Stops the background persistence timer.
   * @public
   */
  public stopCheckpointTimer() {
    if (this._checkpointTimerId) {
      clearInterval(this._checkpointTimerId);
      this._checkpointTimerId = null;
    }
  }

  /** * Stops the TTL cleanup timer.
   * @private
   */
  private _stopTtlCleanupTimer() {
    if (this._ttlCleanupTimer) {
      clearInterval(this._ttlCleanupTimer);
      this._ttlCleanupTimer = null;
    }
  }

  /** * Shuts down the collection, stopping all timers, flushing data to disk, and releasing file locks.
   * @public
   */
  public async close() {
    if (this.syncManager) this.syncManager.stop();
    this.stopCheckpointTimer();
    this._stopTtlCleanupTimer()
    await this.flushToDisk();
    await this._releaseLockIfHeld();
    this._emitter.emit('closed');
  }

  /** * Returns the current usage and health statistics of the collection.
   * @public
   */
  public stats(): CollectionStats {
    cleanupExpiredDocs(this.documents as any, this._indexManager);
    return { ...this._stats, count: this.documents.size };
  }

  /** * Creates a new index on the specified field and rebuilds index data.
   * @param fieldName - The field to index.
   * @param options - Configuration for index uniqueness.
   * @public
   */
  public async createIndex(fieldName: string, options: IndexOptions = {}): Promise<void> {
    return this._enqueue(async () => {
      this._indexManager.createIndex(fieldName, options);
      this._indexManager.rebuildIndexesFromData(this.documents);
    });
  }

  async dropIndex(fieldName: string) {
    return this._enqueue(async () => {
        this._indexManager.dropIndex(fieldName);
    });
  }

  async getIndexes() {
    return this._indexManager.getIndexesMeta();
  }

  /**
     * Exports collection to JSON
     */
    public exportJson = dataExchange.exportJson.bind(this as any);

    /**
     * Exports collection to CSV
     */
    public exportCsv = dataExchange.exportCsv.bind(this as any);

    /**
     * Imports documents from JSON
     */
    public importJson = dataExchange.importJson.bind(this as any);

  /** Register an event listener. */
  public on<K extends keyof CollectionEventMap<T>>(event: K, listener: (payload: CollectionEventMap<T>[K]) => void) { this._emitter.on(event, listener); }
  /** Remove an event listener. */
  public off<K extends keyof CollectionEventMap<T>>(event: K, fn: (...args: any[]) => void) { this._emitter.off(event, fn); }

}
