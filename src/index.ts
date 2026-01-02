import { Collection } from './lib/collection/core.js';
import { TransactionManager } from './lib/collection/transaction-manager.js';
import { WiseJSONError, UniqueConstraintError, DocumentNotFoundError, ConfigurationError } from './lib/errors.js';
import {WiseJSON} from './lib/index.js'
import logger from './lib/logger.js';
import { SyncManager } from './lib/sync/sync-manager.js';

import * as  WALManager from './lib/wal-manager.js';
import * as  CheckpointManager from './lib/checkpoint-manager.js';
import { ApiClient } from './lib/sync/api-client.js';

/**
 * index.ts (Package Root)
 * Primary entry point for the WiseJSON library.
 */

/**
 * Configuration options for the WiseJSON instance.
 */
export interface WiseJSONOptions {
  ttlCleanupIntervalMs?: number;
  walReadOptions?: {
    recover?: boolean;
    strict?: boolean;
  };
  maxSegmentSizeBytes?: number;
  checkpointsToKeep?: number;
  checkpointIntervalMs?: number;
  [key: string]: any;
}

/**
 * Factory function to create a WiseJSON instance.
 * This is the recommended entry point for most users.
 * * @param dbRootPath - Path to the database root directory.
 * @param options - Configuration options for persistence, TTL, and sync.
 * @returns A new WiseJSON instance.
 */
export function connect(dbRootPath: string, options?: WiseJSONOptions): WiseJSON {
  const db = new WiseJSON(dbRootPath, options);
  // Note: `init()` is handled lazily upon the first data access,
  // so the user does not need to call it explicitly.
  return db;
}

// ===========================================
// --- Public Package API ---
// ===========================================

export {
  // --- Core ---
  WiseJSON,
  Collection,

  // --- Custom Errors (for try...catch blocks) ---
  WiseJSONError,
  UniqueConstraintError,
  DocumentNotFoundError,
  ConfigurationError,

  // --- Advanced Components and Utilities ---
  SyncManager,
  TransactionManager,
  logger,
  ApiClient,

  // --- Low-level components (for advanced scenarios or testing) ---
  WALManager,
  CheckpointManager
};

// Default export for compatibility with CommonJS and simpler imports
export default {
  WiseJSON,
  connect,
  Collection,
  WiseJSONError,
  ApiClient,
  UniqueConstraintError,
  DocumentNotFoundError,
  ConfigurationError,
  SyncManager,
  TransactionManager,
  logger,
  WALManager,
  CheckpointManager
};
