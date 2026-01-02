import * as fs from 'fs/promises';
import * as path from 'path';
import { isAlive } from './ttl.js';
import { WalEntry, WalOpType } from '../types.js';


/**
 * Serializes a WAL entry to a JSON string with a trailing newline.
 */
export function walEntryToString(entry: WalEntry): string {
  return JSON.stringify(entry) + '\n';
}

/**
 * Reads and parses all entries from a physical WAL file.
 */
export async function readWalEntries(walFile: string): Promise<WalEntry[]> {
  try {
    const raw = await fs.readFile(walFile, 'utf8');
    const lines = raw.trim().split('\n');
    const entries: WalEntry[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed));
      } catch {
        // Ignore malformed JSON lines (potential partial writes)
      }
    }
    return entries;
  } catch (e: any) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

/**
 * Resolves the WAL path from a collection object and reads its entries.
 */
export async function readWal(collection: any): Promise<WalEntry[]> {
  if (!collection) {
    throw new Error('[readWal] Collection is undefined/null. Verify sync-manager call.');
  }

  // Attempt to resolve walPath from multiple common internal property names
  const walPath = collection._walPath ||
                 collection.walPath ||
                 collection._wal?.path ||
                 collection._wal?.walPath;

  if (!walPath) {
    throw new Error(
      `[readWal] Could not determine WAL path for collection: ${collection.name || 'unknown'}`
    );
  }

  return readWalEntries(walPath);
}

/**
 * Factory for memory-application and data modification logic.
 */
export function createWalOps(context: {
  documents: Map<string, any>;
  indexManager: any;
  _emitter: any;
  _updateIndexesAfterInsert?: (doc: any) => void;
  _updateIndexesAfterRemove?: (doc: any) => void;
  _updateIndexesAfterUpdate?: (oldDoc: any, newDoc: any) => void;
  _triggerCheckpointIfRequired?: (entry: WalEntry) => void;
  walPath: string;
}) {
  const { documents, _emitter, walPath } = context;

  /**
   * Directly updates the in-memory Map based on a WAL entry.
   */
  function applyWalEntryToMemory(entry: WalEntry, emit = true): void {
    switch (entry.op) {
      case 'INSERT': {
        const doc = entry.doc;
        if (doc) {
          documents.set(doc._id!, doc);
          context._updateIndexesAfterInsert?.(doc);
          if (emit) _emitter.emit('insert', doc);
        }
        break;
      }
      case 'BATCH_INSERT': {
        const docs = Array.isArray(entry.docs) ? entry.docs : [];
        for (const doc of docs) {
          if (doc) {
            documents.set(doc._id!, doc);
            context._updateIndexesAfterInsert?.(doc);
            if (emit) _emitter.emit('insert', doc);
          }
        }
        break;
      }
      case 'UPDATE': {
        const id = entry.id;
        const prev = id ? documents.get(id) : null;
        if (prev && isAlive(prev)) {
          const updated = { ...prev, ...entry.data };
          documents.set(id!, updated);
          context._updateIndexesAfterUpdate?.(prev, updated);
          if (emit) _emitter.emit('update', updated, prev);
        }
        break;
      }
      case 'REMOVE': {
        const id = entry.id;
        const prev = id ? documents.get(id) : null;
        if (prev) {
          documents.delete(id!);
          context._updateIndexesAfterRemove?.(prev);
          if (emit) _emitter.emit('remove', prev);
        }
        break;
      }
      case 'CLEAR': {
        const docsToRemove = Array.from(documents.values());
        documents.clear();
        if (context._updateIndexesAfterRemove) {
          for (const doc of docsToRemove) context._updateIndexesAfterRemove(doc);
        }
        if (emit) _emitter.emit('clear');
        break;
      }
    }
  }

  /**
   * Enqueues a data modification: validates uniqueness, writes to WAL, then updates memory.
   */
  async function enqueueDataModification<T>(
    entry: WalEntry,
    opType: WalOpType,
    getResult?: (err: Error | undefined, result: any) => T
  ): Promise<T | void> {

    // Uniqueness validation logic
    if ((opType === 'INSERT' || opType === 'BATCH_INSERT') && context.indexManager) {
      const docsToCheck = opType === 'INSERT' ? [entry.doc] : (entry.docs || []);
      const uniqueIndexes = (context.indexManager.getIndexesMeta() || []).filter((m: any) => m.type === 'unique');

      for (const doc of docsToCheck) {
        for (const idx of uniqueIndexes) {
          const val = doc?.[idx.fieldName];
          if (val !== undefined && val !== null) {
            const indexData = context.indexManager.indexes.get(idx.fieldName)?.data;
            if (indexData?.has(val) && indexData.get(val) !== doc?._id) {
              throw new Error(`Duplicate value '${val}' for unique index '${idx.fieldName}'`);
            }
          }
        }
      }
    }

    // Persist to disk
    await fs.mkdir(path.dirname(walPath), { recursive: true });
    await fs.appendFile(walPath, walEntryToString(entry), 'utf8');

    // Update memory
    applyWalEntryToMemory(entry, true);

    // Maintenance
    context._triggerCheckpointIfRequired?.(entry);

    // Resolve result
    const next = opType === 'REMOVE' ? null : (entry.doc || entry.docs || documents.get(entry.id!));
    return getResult ? getResult(undefined, next) : undefined;
  }

  return {
    applyWalEntryToMemory,
    enqueueDataModification,
  };
}
