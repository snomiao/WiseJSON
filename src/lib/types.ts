// ✅ Correct (Modern ESM style)
import { ApiClient } from './sync/api-client.js';
/**
 * Configuration for the collection's behavior and persistence.
 */
export interface CollectionOptions {
  /** Maximum size of a data segment in bytes before rotation (default: 2MB). */
  maxSegmentSizeBytes?: number;
  /** Frequency of automatic checkpoints in milliseconds (default: 5 minutes). */
  checkpointIntervalMs?: number;
  /** Frequency of TTL (Time-To-Live) expiration checks (default: 1 minute). */
  ttlCleanupIntervalMs?: number;
  /** Custom function to generate unique IDs for new documents. */
  idGenerator?: () => string;
  /** Number of historical checkpoint files to retain on disk. */
  checkpointsToKeep?: number;
  /** Maximum number of WAL entries before forcing a checkpoint. */
  maxWalEntriesBeforeCheckpoint?: number;
  /** Options for how the Write-Ahead Log is read during recovery. */
  walReadOptions?: ReadWalOptions;
  /** Custom logger instance (e.g., Winston or pino). */
  logger?: any;

  walSync?: boolean;

  apiClient?: ApiClient
}

/**
 * Real-time operational statistics for the collection.
 */
export interface CollectionStats {
  /** Total number of successful inserts in the current session. */
  inserts: number;
  /** Total number of successful updates in the current session. */
  updates: number;
  /** Total number of document removals. */
  removes: number;
  /** Number of times the collection has been cleared. */
  clears: number;
  /** Count of WAL entries that haven't been merged into a checkpoint yet. */
  walEntriesSinceCheckpoint: number;
  /** ISO timestamp of the last successful disk checkpoint. */
  lastCheckpointTimestamp: string | null;
  /** Total number of documents currently in memory. */
  count: number;
}

/**
 * Internal representation of a transaction log entry in the WAL.
 */
export interface WalTransactionEntry {
  /** Transaction identifier if this entry is part of a multi-op transaction. */
  txn?: string;
  /** Flag indicating if the entry was recovered from disk during initialization. */
  _txn_applied_from_wal?: boolean;
  /** The type of database operation performed. */
  type: 'insert' | 'insertMany' | 'update' | 'remove' | 'clear';
  /** Arguments passed to the operation (e.g., document data or ID). */
  args: any[];
  /** Unique transaction ID for cross-collection atomicity. */
  txid?: string;
  /** The primary key of the document affected. */
  id?: string;
}

/**
 * Represents a generic document stored in the database.
 * Users can extend this interface for their specific data models.
 */
export interface Document {
  _id?: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: any; // Allow arbitrary fields (Schema-less)
}

export interface TTLDocument extends Document {
    ttl?: number | null;
}


/** * A predicate function for custom filtering logic.
 * Returns true if the document matches the criteria.
 */
export type QueryPredicate<T> = (doc: T) => boolean;

type Primitives = string | number | boolean | Date | null;

export type Filter<T> = {
  [P in keyof T]?:
    | T[P]
    | FilterOperators<T[P] extends Array<infer U> ? U : T[P]>;
}  & {
  $or?: Filter<T>[];
  $and?: Filter<T>[];
};;

interface FilterOperators<T> {
  $eq?: T;
  $ne?: T;
  $gt?: T;
  $gte?: T;
  $lt?: T;
  $lte?: T;
  $in?: T[];      // This now refers to the element type 'U' if the field was an array
  $nin?: T[];
  $exists?: boolean;
  $regex?: string | RegExp;
}

export interface FindOneAndUpdateOptions{
  returnOriginal: boolean
}

// export type Filter<T> = {
//   [P in keyof T]?: T[P] | QueryOperator<T[P]>;
// } & {
//   $or?: Filter<T>[];
//   $and?: Filter<T>[];
// };


/**
 * Union type for queries:
 * Either a type-safe object filter or a custom predicate function.
 */
export type FilterQuery<T> = Filter<T> | QueryPredicate<T>;

/**
 * Supported operations for the Write-Ahead Log.
 */
export type WalOpType = 'INSERT' | 'BATCH_INSERT' | 'UPDATE' | 'REMOVE' | 'CLEAR';

/**
 * Represents a single line/entry in the WAL file.
 */
export interface WalEntry<T extends Document = Document> {
  id?: string;           // Used for UPDATE/REMOVE
  op: WalOpType;         // The operation type
  doc?: T;               // Used for single INSERT
  docs?: T[];            // Used for BATCH_INSERT
  data?: Partial<T>;     // Used for UPDATE payload
  _txnId?: string;       // Transaction ID (if part of a txn)
}

/**
 * Internal interface for the in-memory index structure.
 */
export interface IndexMeta {
  fieldName: string;
  type: 'normal' | 'unique';
}

/**
 * Configuration options passed to the WiseJSON constructor.
 */
export interface WiseOptions {
  checkpointInterval?: number;  // Default: 30000ms
  walThreshold?: number;        // Default: 1000 entries
  ttlCheckInterval?: number;    // Default: 10000ms
  verbose?: boolean;            // Enable debug logging
}


/**
 * Represents the lifecycle stages of an atomic transaction.
 * * - `pending`: The initial state where operations are being queued in memory.
 * - `committing`: The transition state while data is being flushed to the WAL (Write-Ahead Log).
 * - `committed`: The final successful state; changes are permanent in memory and on disk.
 * - `aborted`: The failure/rollback state; all queued changes have been discarded.
 */
export type TransactionState = 'pending' | 'committing' | 'committed' | 'aborted';

/**
 * Represents a single logged operation within a transaction.
 * These operations are buffered and applied atomically only upon a successful commit.
 */
export interface TransactionOp {
    /** The name of the collection this operation targets. */
    colName: string;

    /** * The type of database modification to perform.
     * Includes single/batch writes, updates, deletions, or collection wipes.
     */
    type: 'insert' | 'insertMany' | 'update' | 'remove' | 'clear';

    /** * The arguments passed to the operation (e.g., the document body,
     * search filters, or unique identifiers).
     */
    args: any[];

    /** ISO 8601 timestamp indicating when this specific operation was queued. */
    ts: string;
}


/**
 * Interface for collection instances that require exclusive access during
 * critical operations (e.g., WAL writes or Checkpointing).
 * * Implements a locking mechanism to prevent race conditions when multiple
 * asynchronous operations or processes attempt to modify the same data file.
 */
export interface LockableCollection {
    /**
     * Attempts to acquire an exclusive lock on the collection resources.
     * Returns a Promise that resolves once the lock is successfully granted.
     * Usually relies on a file-system level lock (e.g., proper-lockfile).
     */
    _acquireLock: () => Promise<void>;

    /**
     * Releases the currently held lock if it exists.
     * This method is safe to call even if the lock has already been released
     * or was never acquired, preventing "double-release" errors.
     */
    _releaseLockIfHeld: () => Promise<void>;

    /** * Flexible indexer to allow access to standard Collection methods
     * and internal properties without strict type blocking.
     */
    [key: string]: any;
}

/**
 * Interface for MongoDB-style update operators.
 */
export interface UpdateQuery<T> {
    $set?: Partial<T>;
    $inc?: Partial<Record<keyof T, number>>;
    $unset?: Partial<Record<keyof T, any>>;
    $push?: Partial<Record<keyof T, any | { $each: any[] }>>;
    $pull?: Partial<Record<keyof T, any>>;
    [key: string]: any;
}



/**
 * Interface for Field Projections (1 for inclusion, 0 for exclusion).
 */
export type Projection<T> = Partial<Record<keyof (T & Document), 0 | 1>>;

/**
 * Interface representing the internal state and methods of a Collection
 * required for data operations.
 */
export interface CollectionOps<T extends object> {
    documents: Map<string, T & Document>;
    options: any;
    _stats: {
        inserts: number;
        updates: number;
        removes: number;
        clears: number;
        walEntriesSinceCheckpoint: number;
    };
    isPlainObject: (obj: any) => boolean;
    _idGenerator: () => string;
    _enqueue: <R>(task: () => Promise<R>) => Promise<R>;
    _enqueueDataModification: (
        walPayload: any,
        opType: string,
        transformFn: (prev: any, next: any) => any,
        meta?: any
    ) => Promise<any>;
    _acquireLock: () => Promise<void>;
    _releaseLockIfHeld: () => Promise<void>;
}


/**
 * Internal representation of a collection index.
 * Stores the mapping between document field values and their corresponding IDs.
 */
export interface IndexDefinition {
  /** The name of the document field being indexed. */
  fieldName: string;

  /** * The constraint type:
   * - `unique`: Ensures no two documents share the same value for this field.
   * - `normal`: Allows multiple documents to share the same value.
   */
  type: 'normal' | 'unique';

  /** * The underlying data store for the index:
   * - For `unique`: `Map<FieldValue, DocumentId>`
   * - For `normal`: `Map<FieldValue, Set<DocumentId>>`
   */
  data: Map<any, any>;
}

/**
 * Lightweight metadata describing an index, used for persistence and
 * high-level index management without exposing the raw data Map.
 */
export interface IndexMetadata {
  /** The name of the field this index tracks. */
  fieldName: string;

  /** The index constraint (unique or non-unique). */
  type: 'normal' | 'unique';
}

/**
 * Configuration options provided by the user when creating a new index.
 */
export interface IndexOptions {
  /** * If true, the database will throw an error if an insertion or update
   * results in a duplicate value for the indexed field.
   */
  unique?: boolean;
}


/**
 * Type definition for the lock release function returned by proper-lockfile.
 */
export type ReleaseLockFn = () => Promise<void>;


/**
 * Type representing the mapping of event names to their argument arrays.
 */
export type CollectionEventMap<T> = DataEvents<T> & SyncManagerEventMap & OtherEventsMap;

export interface DataEvents<T> {
    'initialized': void;

    // Data Mutation
    'insert': { doc: T };
    'insertMany': { docs: T[] };
    'update': { id: string; oldDoc: T; newDoc: T };
    'delete': { id: string; doc: T };
    'remove': {doc: T}

    // Maintenance
    'clear': { clearedCount: number};
    'index:rebuild': { fieldName: string };
    'ttl:cleanup': { expiredCount: number };

    // Persistence
    'flush': { timestamp: number; reason: string };
    'closed': void
}

export interface OtherEventsMap{
  'checkpoint': { timestamp: string | number },
  'trnx:clear': { clearedCount: number, _txn: string }
}

/**
 * Options for the import operation.
 */
export interface ImportOptions {
    /** * 'append' adds documents to current state,
     * 'replace' wipes the collection before inserting.
     */
    mode?: 'append' | 'replace';
}

/**
 * Interface representing the required collection methods for data exchange.
 * This allows the functions to be bound to the main Collection class.
 */
export interface DataExchangeContext<T extends Document> extends CollectionOps<T> {
    getAll: () => Promise<(T & Document)[]>;
    insertMany: (docs: T[]) => Promise<(T & Document)[]>;
    clear: () => Promise<boolean>;
}

export interface UpdateResult {
    matchedCount: number;
    modifiedCount: number;
}


/**
 * Configuration for WiseJSON server endpoints.
 */
export interface ApiEndpoints {
    snapshot: string;
    pull: string;
    push: string;
    health: string;
    [key: string]: string;
}


/**
 * Interface for the API Client required by SyncManager.
 */
export interface SyncApiClient {
    get: (url: string) => Promise<any>;
    post: (url: string, data: any) => Promise<any>;
}

/**
 * Configuration options for the SyncManager.
 */
export interface SyncManagerOptions {
    collection: any;
    apiClient: SyncApiClient;
    logger?: any;
    minSyncIntervalMs?: number;
    maxSyncIntervalMs?: number;
    heartbeatIntervalMs?: number;
    pushBatchSize?: number;
    autoStartLoop?: boolean;
}


/**
 * Metadata structure stored in checkpoint meta files.
 */
export interface CheckpointMeta {
    timestamp: string;
    documentCount: number;
    indexesMeta: any[];
}

/**
 * The result of a successful checkpoint load.
 */
export interface CheckpointLoadResult {
    documents: Map<string, any>;
    indexesMeta: any[];
    timestamp: string | null;
}


/**
 * Represents the available severity levels for the logger.
 * Hierarchy: error (0) < warn (1) < log (2) < debug (3)
 */
export type LogLevelName = 'error' | 'warn' | 'log' | 'debug';

/**
 * ANSI escape codes for terminal string styling.
 * Used to provide visual distinction between log levels in the console.
 */
export const colors = {
    reset: "\x1b[0m",
    gray: "\x1b[90m",
    red: "\x1b[31m",
    yellow: "\x1b[33m",
    cyan: "\x1b[36m",
} as const;

/**
 * Numeric priority for each log level.
 * Higher values indicate more verbose logging.
 */
export const levels: Record<LogLevelName, number> = {
    error: 0,
    warn: 1,
    log: 2,
    debug: 3,
};

/**
 * Map of log levels to their respective ANSI color codes.
 * Ensures consistent visual branding for different message types.
 */
export const colorMap: Record<LogLevelName, string> = {
    error: colors.red,
    warn: colors.yellow,
    log: colors.cyan,
    debug: colors.gray,
};


/**
 * Represents a single operation within a transaction block.
 */
export interface WalOp {
    colName: string;
    type: string;
    args: any;
    ts?: string;
}

/**
 * Options for reading the WAL file, allowing for strict validation or recovery modes.
 */
export interface ReadWalOptions {
    strict?: boolean;
    recover?: boolean;
    isInitialLoad?: boolean;
    logger?: any;
    onError?: (err: Error, line: string, lineNum: number) => void;
}

/**
 * Internal state tracker for multi-line transactions during WAL replay.
 */
export interface ITransactionState {
    ops: any[];
    committed: boolean;
    startLine: number;
    timestampStr?: string;
    commitLine?: number;
    commitTimestampStr?: string;
}


/**
 * Context for where the sync failure occurred
 */
export type SyncPhase = 'initial_sync' | 'pull' | 'push' | 'heartbeat' | 'cycle_logic';

/**
 * Configuration options for enabling collection synchronization.
 */
export interface SyncOptions {
  url: string;
  apiKey: string;
  apiClient?: any;
  autoStartLoop?: boolean;
  syncIntervalMs?: number;
  [key: string]: any; // Allows for additional options passed to SyncManager
}

/**
 * Represents the current state and metrics of the sync process.
 */
export interface SyncStatus {
  state: 'disabled' | 'active' | 'error' | 'stopped' | 'idle' | 'syncing';
  isSyncing: boolean;
  lastKnownServerLSN: number;
  initialSyncComplete: boolean;
  lastError?: string;
}

export interface SyncManagerEventMap {
    'sync:start': { lsn: number };
    'sync:success': { type: string; lsn: number; activityDetected: boolean };
    'sync:error': { message: string; originalError: any };
    'sync:initial_start': void; // No payload
    'sync:initial_complete': { message?: string; documentsLoaded?: number; lsn?: number };
    'sync:pull_success': { pulled: number; lsn: number };
    'sync:push_success': { pushed: number; batchId: string; lsn: number };
    'sync:heartbeat_success': void; // No payload
    'sync:conflict_resolved': { type: string, reason: string, docId: string },
    'sync:quarantine': { quarantinedAt:string, operation: WalOp, error: { message: string, stack: any } }
}
// Sync Lifecycle Payloads
/** 'sync:start' */
export interface SyncStartPayload {
    lsn: number; // The LSN the client is starting from
}

/** 'sync:success' */
export interface SyncSuccessPayload {
    type: 'full_cycle_complete';
    lsn: number;              // The new server LSN reached
    activityDetected: boolean; // Whether any data was actually pulled or pushed
}

/** 'sync:initial_start' (No payload emitted in current code) */
export type SyncInitialStartPayload = void;

/** 'sync:initial_complete' */
export interface SyncInitialCompletePayload {
    message?: string;        // Used for fallback/warning messages
    documentsLoaded?: number; // Total count of docs from snapshot
    lsn?: number;            // The LSN established by the snapshot
}

// Operation-Specific Payloads
/** 'sync:pull_success' */
export interface SyncPullSuccessPayload {
    pulled: number; // Number of operations received from server
    lsn: number;    // The LSN returned by the server
}

/** 'sync:push_success' */
export interface SyncPushSuccessPayload {
    pushed: number;  // Number of operations in the batch
    batchId: string; // The unique ID of the pushed batch
    lsn: number;     // The LSN returned by the server after processing
}

/** 'sync:heartbeat_success' (No payload emitted in current code) */
export type SyncHeartbeatSuccessPayload = void;

// Error Payload
/** 'sync:error' */
export interface SyncErrorPayload {
    message: string;          // Formatted error message
    phase?: SyncPhase;        // Which step failed
    originalError: Error;     // The raw Error object
    batchId?: string;         // Only present if failure happened during a Push batch
    lsn?: number;             // The LSN at the time of failure
}

