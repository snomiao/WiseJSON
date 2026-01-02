/**
 * cli/actions.ts
 * Implementation of individual CLI commands.
 */

import fs from 'fs/promises';
import path from 'path';
import { confirmAction, prettyError, CliOptions } from './utils.js';
import { WiseJSON } from '../index.js';
import { flattenDocToCsv } from '../collection/utils.js';

/**
 * Interface for the registry entry of a CLI command.
 */
interface CliAction {
  handler: (db: WiseJSON, args: string[], options: CliOptions) => Promise<void>;
  isWrite: boolean;
  description: string;
}

/**
 * Ensures a collection exists before performing operations.
 */
async function assertCollectionExists(db: WiseJSON, collectionName: string): Promise<void> {
  const names = await db.getCollectionNames();
  if (!names.includes(collectionName)) {
    prettyError(`Collection "${collectionName}" does not exist.`);
  }
}

// =============================
// --- Read-Only Actions ---
// =============================

/**
 * Lists all available collections and their document counts.
 */
async function listCollectionsAction(db: WiseJSON): Promise<void> {
  const collections = await db.getCollectionNames();
  const result = await Promise.all(
    collections.map(async (name: string) => {
      const col = await db.getCollection(name);
      return { name, count: await col.count() };
    })
  );

  if (result.length === 0) {
    console.log('No collections found.');
    return;
  }
  console.table(result);
}

/**
 * Displays documents with support for filtering, sorting, and pagination.
 */
async function showCollectionAction(db: WiseJSON, args: string[], options: CliOptions): Promise<void> {
  const [collectionName] = args;
  if (!collectionName) prettyError('Usage: show-collection <collection> [options]');
  await assertCollectionExists(db, collectionName);

  const col = await db.getCollection(collectionName);

  const limit = parseInt((options['limit'] as string) || '10', 10);
  const offset = parseInt((options['offset'] as string) || '0', 10);
  const sortField = options['sort'] as string | undefined;
  const sortOrder = options['order'] || 'asc';
  const output = options['output'] || 'json';

  let filter = {};
  if (options['filter']) {
    try {
      filter = JSON.parse(options['filter'] as string);
    } catch (e: any) {
      prettyError(`Invalid JSON in --filter option: ${e.message}`);
    }
  }

  let docs = await col.find(filter);

  if (sortField) {
    docs.sort((a: any, b: any) => {
      if (a[sortField] === undefined) return 1;
      if (b[sortField] === undefined) return -1;
      if (a[sortField] < b[sortField]) return sortOrder === 'asc' ? -1 : 1;
      if (a[sortField] > b[sortField]) return sortOrder === 'asc' ? 1 : -1;
      return 0;
    });
  }

  docs = docs.slice(offset, offset + limit);

  if (output === 'csv') console.log(flattenDocToCsv(docs));
  else if (output === 'table') console.table(docs);
  else console.log(JSON.stringify(docs, null, 2));
}

/**
 * Lists all defined indexes for a specific collection.
 */
async function listIndexesAction(db: WiseJSON, args: string[]): Promise<void> {
  const [collectionName] = args;
  if (!collectionName) prettyError('Usage: list-indexes <collection>');
  await assertCollectionExists(db, collectionName);

  const col = await db.getCollection(collectionName);
  console.log(JSON.stringify(await col.getIndexes(), null, 2));
}

/**
 * Retrieves a single document by its unique ID.
 */
async function getDocumentAction(db: WiseJSON, args: string[]): Promise<void> {
  const [collectionName, docId] = args;
  if (!collectionName || !docId) prettyError('Usage: get-document <collection> <docId>');
  await assertCollectionExists(db, collectionName);

  const col = await db.getCollection(collectionName);
  const doc = await col.findOne({ _id: docId });
  if (!doc) {
    prettyError(`Document with ID "${docId}" not found in collection "${collectionName}".`);
  }
  console.log(JSON.stringify(doc, null, 2));
}

// =============================
// --- Write Actions ---
// =============================

/**
 * Creates a new index on a specific field.
 */
async function createIndexAction(db: WiseJSON, args: string[], options: CliOptions): Promise<void> {
  const [collectionName, fieldName] = args;
  if (!collectionName || !fieldName) prettyError('Usage: create-index <collection> <field> [--unique]');

  const col = await db.getCollection(collectionName);
  await col.createIndex(fieldName, { unique: !!options['unique'] });
  console.log(`Index on "${fieldName}" created successfully in "${collectionName}".`);
}

/**
 * Permanently deletes a collection and its files.
 */
async function dropCollectionAction(db: WiseJSON, args: string[], options: CliOptions): Promise<void> {
  const [collectionName] = args;
  if (!collectionName) prettyError('Usage: collection-drop <collection>');
  await assertCollectionExists(db, collectionName);

  const confirmed = await confirmAction(
    `Are you sure you want to PERMANENTLY delete the collection "${collectionName}"?`,
    options
  );

  if (confirmed) {
    // Accessing internal path for deletion
    const collectionPath = path.join((db as any).dbRootPath, collectionName);
    await fs.rm(collectionPath, { recursive: true, force: true });
    console.log(`Collection "${collectionName}" dropped successfully.`);
  } else {
    console.log('Operation cancelled.');
  }
}

/**
 * Inserts a single document provided as a JSON string.
 */
async function insertDocumentAction(db: WiseJSON, args: string[]): Promise<void> {
  const [collectionName, jsonString] = args;
  if (!collectionName || !jsonString) prettyError('Usage: doc-insert <collection> <json_string>');

  const col = await db.getCollection(collectionName);
  try {
    const doc = JSON.parse(jsonString);
    const inserted = await col.insert(doc);
    console.log(JSON.stringify(inserted, null, 2));
  } catch (e: any) {
    prettyError(`Failed to insert document: ${e.message}`);
  }
}

// --- Command Registry ---
export const actions: Record<string, CliAction> = {
  'list-collections': {
    handler: listCollectionsAction,
    isWrite: false,
    description: 'Lists all collections and their document counts.'
  },
  'show-collection': {
    handler: showCollectionAction,
    isWrite: false,
    description: 'Shows documents in a collection with pagination and filtering.'
  },
  'list-indexes': {
    handler: listIndexesAction,
    isWrite: false,
    description: 'Lists indexes for a collection.'
  },
  'get-document': {
    handler: getDocumentAction,
    isWrite: false,
    description: 'Gets a single document by its ID.'
  },
  'create-index': {
    handler: createIndexAction,
    isWrite: true,
    description: 'Creates an index on a field. Use --unique for a unique index.'
  },
  'collection-drop': {
    handler: dropCollectionAction,
    isWrite: true,
    description: 'Permanently deletes an entire collection. Use with caution.'
  },
  'doc-insert': {
    handler: insertDocumentAction,
    isWrite: true,
    description: 'Inserts a single document from a JSON string.'
  }
};
