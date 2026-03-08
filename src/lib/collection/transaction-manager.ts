import { v4 as uuidv4 } from 'uuid';
import logger from '../logger.js';
import { WiseJSON } from '../index.js';
import {TransactionState, TransactionOp, Document} from '../types.js';

// We import the type only, and use dynamic import for the implementation to avoid cycles
import type * as WalManagerType from '../wal-manager.js';
import type * as CollectionType from './core.js';


/**
 * Manages atomic operations across one or multiple collections.
 * Uses a two-phase approach: log all operations to WAL first, then apply to memory.
 */
export class TransactionManager {
    public txid: string;
    public state: TransactionState = 'pending';
    private _db: WiseJSON;
    private _ops: TransactionOp[] = [];
    private _collections: Record<string, any> = {};

    constructor(db: WiseJSON) {
        this._db = db;
        this.txid = `txn_${uuidv4()}`;
    }

    /**
     * Returns a proxy interface for a collection that queues operations
     * instead of executing them immediately.
     */
    public collection<T extends Document>(name: string) {
        if (!this._collections[name]) {
            this._collections[name] = this._createCollectionProxy<T>(name);
        }
        return this._collections[name] as CollectionType.Collection<T>;
    }

    private _createCollectionProxy<T>(name: string) {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const self = this;
        return {
            insert(doc: T) {
                self._ops.push({ colName: name, type: 'insert', args: [doc], ts: new Date().toISOString() });
                return Promise.resolve();
            },
            insertMany(docs: T[]) {
                self._ops.push({ colName: name, type: 'insertMany', args: [docs], ts: new Date().toISOString() });
                return Promise.resolve();
            },
            update(id: string, updates: Partial<T>) {
                self._ops.push({ colName: name, type: 'update', args: [id, updates], ts: new Date().toISOString() });
                return Promise.resolve();
            },
            remove(id: string) {
                self._ops.push({ colName: name, type: 'remove', args: [id], ts: new Date().toISOString() });
                return Promise.resolve();
            },
            clear() {
                self._ops.push({ colName: name, type: 'clear', args: [], ts: new Date().toISOString() });
                return Promise.resolve();
            }
        } as unknown as Partial<CollectionType.Collection>;
    }

    /**
     * Commits the transaction.
     * 1. Writes a transactional block to each collection's WAL.
     * 2. Applies operations to in-memory documents.
     */
    public async commit(): Promise<void> {
        if (this.state !== 'pending') {
            throw new Error(`Transaction ${this.txid} already ${this.state}`);
        }

        this.state = 'committing';

        // Use dynamic import to prevent circular dependency with Collection/WiseJSON
        // @ts-expect-error just leave it bro
        const walManager: typeof WalManagerType = await import('../wal-manager') //require('../wal-manager.js');
        const groupedOps = this._groupOpsByCollection();

        // Phase 1: Persistence (WAL)
        for (const [colName, opsInCollection] of Object.entries(groupedOps)) {
            try {
                const collectionInstance = await this._db.getCollection(colName);
                // opsInCollection now contains operations, each of which has its own 'ts' field
                await walManager.writeTransactionBlock(collectionInstance.walPath, this.txid, opsInCollection, logger);
            } catch (err: any) {
                this.state = 'aborted';
                const errMsg = `TransactionManager: WAL write failed for '${this.txid}' in "${colName}": ${err.message}`;
                logger.error(errMsg, err.stack);
                throw new Error(errMsg);
            }
        }

        // Phase 2: Memory Application
        for (const op of this._ops) {
            try {
                const collectionInstance = await this._db.getCollection(op.colName);
                // initPromise should have already resolved above for each affected collection
                switch (op.type) {
                    case 'insert':
                        await (collectionInstance as any)._applyTransactionInsert(op.args[0], this.txid);
                        break;
                    case 'insertMany':
                        await (collectionInstance as any)._applyTransactionInsertMany(op.args[0], this.txid);
                        break;
                    case 'update':
                        await (collectionInstance as any)._applyTransactionUpdate(op.args[0], op.args[1], this.txid);
                        break;
                    case 'remove':
                        await (collectionInstance as any)._applyTransactionRemove(op.args[0], this.txid);
                        break;
                    case 'clear':
                        await (collectionInstance as any)._applyTransactionClear(this.txid);
                        break;
                    default:
                        throw new Error(`Unknown transaction operation: ${op.type}`);
                }
            } catch (err: any) {
                logger.error(`TransactionManager: Error applying ${op.type} for txid ${this.txid}. ${err.message}`, err.stack);
            }
        }

        this.state = 'committed';
    }

    /**
     * Aborts the transaction and clears queued operations.
     */
    public async rollback(): Promise<void> {
        if (this.state !== 'pending') {
            if (this.state === 'committing' || this.state === 'committed') {
                throw new Error(`Transaction ${this.txid} cannot be rolled back, state is ${this.state}`);
            }
            // If 'aborted', then a repeated rollback does nothing; you don't need to throw an error.
            // logger.warn(`[TransactionManager] Rollback attempt on transaction ${this.txid} which is already ${this.state}.`);
            return; // Already aborted or in progress/completed
        }

        this.state = 'aborted';
        this._ops = [];
    }

    private _groupOpsByCollection(): Record<string, TransactionOp[]> {
        const grouped: Record<string, TransactionOp[]> = {};
        for (const op of this._ops) { // op here already contains 'ts'
            if (!grouped[op.colName]) {
                grouped[op.colName] = [];
            }
            grouped[op.colName].push(op);
        }
        return grouped;
    }
}
