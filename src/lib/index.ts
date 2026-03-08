
import * as fs from 'fs/promises';
import { Collection, } from './collection/core.js';
import { TransactionManager } from './collection/transaction-manager.js';
import { makeAbsolutePath, validateOptions } from './collection/utils.js';
import logger from './logger.js';
import { ConfigurationError, DocumentNotFoundError, UniqueConstraintError, WiseJSONError } from './errors.js';
import { CollectionOptions, Document } from './types.js';


const DEFAULT_PATH = process.env['WISE_JSON_PATH'] || makeAbsolutePath('wise-json-db-data');

export class WiseJSON {
  private static _hasGracefulShutdown = false;
  public dbRootPath: string;
  private options: Required<CollectionOptions>;
  private collections: Record<string, Collection<any>> = {};
  private _activeTransactions: TransactionManager[] = [];
  private _isInitialized = false;
  private _initPromise: Promise<void> | null = null;

  constructor(dbRootPath: string = DEFAULT_PATH, options: Partial<CollectionOptions> = {}) {
    this.dbRootPath = makeAbsolutePath(dbRootPath);
    // Use the utility to fill in defaults
    this.options = options as unknown as Required<CollectionOptions>;

    if (!WiseJSON._hasGracefulShutdown) {
      this._setupGracefulShutdown();
      WiseJSON._hasGracefulShutdown = true;
    }
  }

  public async init(): Promise<void> {
    if (this._initPromise) return this._initPromise;

    this._initPromise = (async () => {
      try {
        await fs.mkdir(this.dbRootPath, { recursive: true });
        this._isInitialized = true;
        logger.log(`[WiseJSON] Database at ${this.dbRootPath} initialized.`);
      } catch (err) {
        logger.error(`[WiseJSON] Critical error during database initialization:`, err);
        this._initPromise = null;
        throw err;
      }
    })();

    return this._initPromise;
  }

  private async _ensureInitialized(): Promise<void> {
    if (!this._isInitialized) await this.init();
  }

  /**
   * Returns a collection instance (Generic).
   */
  public async collection<T extends Document = any>(name: string, options: Partial<CollectionOptions> = {}): Promise<Collection<T>> {
    await this._ensureInitialized();
    if (!this.collections[name]) {
      // Pass the fully validated options down
      this.collections[name] = new Collection<T>(name, this.dbRootPath, {
        ...this.options,
        ...options
      });
    }
    return this.collections[name] as Collection<T>;
  }

  /**
   * Returns a fully initialized collection ready for operations.
   */
  public async getCollection<T extends Document = any>(name: string, options?: Partial<CollectionOptions>): Promise<Collection<T>> {
    const instance = await this.collection<T>(name, options);
    await instance.isReady;
    return instance;
  }

  public async getCollectionNames(): Promise<string[]> {
    await this._ensureInitialized();
    try {
      const items = await fs.readdir(this.dbRootPath, { withFileTypes: true });
      return items
        .filter(item =>
          item.isDirectory() &&
          !item.name.startsWith('.') &&
          !item.name.endsWith('.lock') &&
          item.name !== '_checkpoints' &&
          item.name !== 'node_modules'
        )
        .map(item => item.name);
    } catch (e: any) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  }

  public beginTransaction(): TransactionManager {
    if (!this._isInitialized) {
      throw new ConfigurationError("Database not initialized. Call db.init() first.");
    }
    const txn = new TransactionManager(this);
    this._activeTransactions.push(txn);
    return txn;
  }

  public async close(): Promise<void> {
    if (this._initPromise) await this._initPromise;

    const allCollections = Object.values(this.collections);
    for (const col of allCollections) {
      // The TS Collection.close() is now an async method that flushes data
      await col.close();
    }
    logger.log(`[WiseJSON] Database at ${this.dbRootPath} closed.`);
  }

  private _setupGracefulShutdown(): void {
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
    let isShuttingDown = false;

    const shutdownHandler = async () => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      try {
        logger.log(`\n[WiseJSON] Graceful shutdown initiated...`);
        await this.close();
      } catch (e) {
        logger.error('[WiseJSON] Error during shutdown:', e);
      } finally {
        setTimeout(() => process.exit(0), 100);
      }
    };

    signals.forEach(signal => process.on(signal, shutdownHandler));
  }

  public getActiveTransactions(): TransactionManager[] {
    return this._activeTransactions.filter(txn => txn.state === 'pending');
  }
}
