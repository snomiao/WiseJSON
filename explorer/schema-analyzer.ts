/**
 * explorer/schema-analyzer.ts
 * Analyzes collection structures to determine field types, indexing status,
 * and infer relationships between different data sets.
 */

import { Collection, WiseJSON } from "../src/index";

/**
 * Metadata for an individual field within a collection.
 */
interface FieldInfo {
  name: string;
  types: string[];
  isIndexed: boolean;
  isUnique?: boolean;
}

/**
 * Metadata representing a collection's structure.
 */
interface CollectionMetadata {
  name: string;
  docCount: number;
  fields: FieldInfo[];
}

/**
 * Metadata representing an inferred foreign-key relationship.
 */
interface Relationship {
  source: string;
  sourceField: string;
  target: string;
  targetField: string;
}

/**
 * Analyzes a single collection to extract its schema definition based on a sample of documents.
 * @param collection - The collection instance to analyze.
 * @returns A promise resolving to the collection's metadata.
 */
async function analyzeCollection(collection: Collection<any>): Promise<CollectionMetadata> {
  const SAMPLE_SIZE = 100; // Analyze the first 100 documents to infer types
  const fieldsMap = new Map<string, { name: string; types: Set<string>; isIndexed: boolean; isUnique?: boolean }>();

  // Retrieve current indexing state
  const indexes = await collection.getIndexes();
  const indexedFields = new Map(indexes.map(idx => [idx.fieldName, idx]));

  // Retrieve a sample of the data
  const allDocs = await collection.find({});
  const sampleDocs = allDocs.slice(0, SAMPLE_SIZE);

  for (const doc of sampleDocs) {
    for (const key in doc) {
      if (!fieldsMap.has(key)) {
        fieldsMap.set(key, { name: key, types: new Set<string>(), isIndexed: false });
      }

      const fieldInfo = fieldsMap.get(key)!;

      // Infer Data Type
      const value = doc[key];
      if (value === null) fieldInfo.types.add('null');
      else if (Array.isArray(value)) fieldInfo.types.add('array');
      else fieldInfo.types.add(typeof value);

      // Check for Indexing
      if (indexedFields.has(key)) {
        const indexMetadata = indexedFields.get(key)!;
        fieldInfo.isIndexed = true;
        fieldInfo.isUnique = (indexMetadata as any).type === 'unique';
      }
    }
  }

  // Transform internal Set to Array for JSON serialization compatibility
  const finalFields: FieldInfo[] = Array.from(fieldsMap.values()).map(f => ({
    ...f,
    types: Array.from(f.types)
  }));

  return {
    name: collection.name,
    docCount: allDocs.length,
    fields: finalFields,
  };
}

/**
 * Detects potential relationships between collections using naming heuristics.
 * For example: 'userId' in collection 'orders' suggests a link to '_id' in 'users'.
 * @param collectionsData - Array of analyzed collection metadata.
 * @returns An array of detected relationships.
 */
function detectRelationships(collectionsData: CollectionMetadata[]): Relationship[] {
  const links: Relationship[] = [];
  const collectionNames = new Set(collectionsData.map(c => c.name));

  for (const sourceCollection of collectionsData) {
    for (const sourceField of sourceCollection.fields) {
      const fieldName = sourceField.name;

      // Ignore primary IDs for link detection
      if (fieldName === '_id') continue;

      let potentialTargetName: string | null = null;

      // Heuristic: look for fields ending in 'Id' or '_id'
      if (fieldName.toLowerCase().endsWith('id')) {
        potentialTargetName = fieldName.slice(0, -2);
      } else if (fieldName.toLowerCase().endsWith('_id')) {
        potentialTargetName = fieldName.slice(0, -3);
      }

      if (potentialTargetName) {
        // Match against singular and plural collection names
        const targetSingular = potentialTargetName;
        const targetPlural = `${potentialTargetName}s`;

        const findTarget = [targetPlural, targetSingular].find(name => collectionNames.has(name));

        if (findTarget) {
          links.push({
            source: sourceCollection.name,
            sourceField: fieldName,
            target: findTarget,
            targetField: '_id',
          });
        }
      }
    }
  }
  return links;
}

/**
 * Entry point: Analyzes the entire database to return a structural graph.
 * Useful for visual schema representations and ER diagrams.
 * @param db - The WiseJSON database instance.
 */
export async function analyzeDatabaseGraph(db: WiseJSON): Promise<{ collections: CollectionMetadata[], links: Relationship[] }> {
  const collectionNames = await db.getCollectionNames();

  const collectionsData = await Promise.all(
    collectionNames.map(async name => {
      const col = await db.getCollection(name);
      return analyzeCollection(col);
    })
  );

  const links = detectRelationships(collectionsData);

  return {
    collections: collectionsData,
    links,
  };
}
