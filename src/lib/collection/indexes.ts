import { IndexDefinition, IndexOptions, IndexMetadata } from '../types.js';

/**
 * Manages collection indexes.
 */
export class IndexManager {
  public indexes: Map<string, IndexDefinition>; // fieldName -> { type, data, fieldName }
  private indexedFields: Set<string>;
  private collectionName: string;
  private logger: any;

  /**
   * @param {string} [collectionName='unknown'] - Collection name for logging.
   * @param {object} [logger] - Logger instance. If not passed, a default logger will be used.
   */
  constructor(collectionName = 'unknown', logger: any) {
    this.collectionName = collectionName;
    // +++ CHANGE: Store the passed logger or use fallback.
    this.logger = logger || require('../logger');
    this.indexes = new Map();
    this.indexedFields = new Set();
  }

  /**
   * Creates an index.
   * @param {string} fieldName
   * @param {{unique?: boolean}} [options]
   */
  public createIndex(fieldName: string, options: IndexOptions = {}): void {
    if (!fieldName || typeof fieldName !== 'string') {
      this.logger.error(
        `[IndexManager] fieldName must be a string for collection '${this.collectionName}', received: ${typeof fieldName} ('${fieldName}')`,
      );
      throw new Error(`IndexManager: fieldName must be a non-empty string`);
    }

    if (this.indexes.has(fieldName)) {
      const existingIndex = this.indexes.get(fieldName)!;
      const newIsUnique = options.unique === true;
      const existingIsUnique = existingIndex.type === 'unique';

      if (newIsUnique === existingIsUnique) {
        this.logger.warn(
          `[IndexManager] Index on field '${fieldName}' (type: ${existingIndex.type}) for collection '${this.collectionName}' already exists — skipping creation.`,
        );
        return;
      } else {
        this.logger.error(
          `[IndexManager] Attempted to change existing index type for field '${fieldName}' in collection '${this.collectionName}'. Existing: ${existingIndex.type}, New: ${newIsUnique ? 'unique' : 'standard'}. Delete the old index before creating a new one with a different type.`,
        );
        throw new Error(
          `IndexManager: index on field '${fieldName}' already exists with a different type. Delete it before recreating.`,
        );
      }
    }

    const isUnique = options.unique === true;

    const index: IndexDefinition = {
      fieldName,
      type: isUnique ? 'unique' : 'normal',
      data: new Map(), // value -> ID or Set<ID>
    };

    this.indexes.set(fieldName, index);
    this.indexedFields.add(fieldName);
    this.logger.log(
      `[IndexManager] Index on field '${fieldName}' (type: ${index.type}) for collection '${this.collectionName}' successfully created.`,
    );
  }

  /**
   * Deletes an index.
   * @param {string} fieldName
   */
  public dropIndex(fieldName: string): void {
    if (!this.indexes.has(fieldName)) {
      this.logger.warn(
        `[IndexManager] Attempted to delete non-existent index on field '${fieldName}' for collection '${this.collectionName}'. Operation skipped.`,
      );
      return;
    }
    this.indexes.delete(fieldName);
    this.indexedFields.delete(fieldName);
    this.logger.log(
      `[IndexManager] Index on field '${fieldName}' for collection '${this.collectionName}' successfully deleted.`,
    );
  }

  /**
   * Returns meta-information about indexes.
   * @returns {Array<{fieldName: string, type: string}>}
   */
  public getIndexesMeta(): IndexMetadata[] {
    return Array.from(this.indexes.values()).map((index) => ({
      fieldName: index.fieldName,
      type: index.type,
    }));
  }

  /**
   * Reconstructs indexes from data.
   * @param {Map<string, object>} documents
   */
  public rebuildIndexesFromData(documents: Map<string, any>): void {
    for (const fieldName of this.indexedFields) {
      const def = this.indexes.get(fieldName);
      if (!def) {
        this.logger.warn(
          `[IndexManager] Index definition for field '${fieldName}' not found during rebuild in collection '${this.collectionName}'.`,
        );
        continue;
      }
      def.data.clear();

      for (const [id, doc] of documents.entries()) {
        if (typeof doc !== 'object' || doc === null) continue;
        this.insertIntoIndex(def, doc[fieldName], id, true);
      }
    }
  }

  /**
   * Updates indexes after insertion.
   * @param {object} doc
   */
  public afterInsert(doc: any): void {
    if (typeof doc !== 'object' || doc === null) return;
    for (const fieldName of this.indexedFields) {
      const def = this.indexes.get(fieldName);
      if (def) this.insertIntoIndex(def, doc[fieldName], doc._id);
    }
  }

  /**
   * Updates indexes after removal.
   * @param {object} doc
   */
  public afterRemove(doc: any): void {
    if (typeof doc !== 'object' || doc === null) return;
    for (const fieldName of this.indexedFields) {
      const def = this.indexes.get(fieldName);
      if (def) this.removeFromIndex(def, doc[fieldName], doc._id);
    }
  }

  /**
   * Updates indexes after an update.
   * @param {object} oldDoc
   * @param {object} newDoc
   */
  public afterUpdate(oldDoc: any, newDoc: any): void {
    if (
      typeof oldDoc !== 'object' ||
      oldDoc === null ||
      typeof newDoc !== 'object' ||
      newDoc === null
    )
      return;

    for (const fieldName of this.indexedFields) {
      const def = this.indexes.get(fieldName);
      if (!def) continue;

      const oldVal = oldDoc[fieldName];
      const newVal = newDoc[fieldName];

      if (
        oldVal !== newVal ||
        (Object.prototype.hasOwnProperty.call(newDoc, fieldName) &&
          oldDoc[fieldName] === undefined) ||
        (Object.prototype.hasOwnProperty.call(oldDoc, fieldName) &&
          newDoc[fieldName] === undefined)
      ) {
        // Remove old value from the index
        this.removeFromIndex(def, oldVal, oldDoc._id);

        // Add new value to the index
        this.insertIntoIndex(def, newVal, newDoc._id);
      }
    }
  }

  /**
   * Internal helper to handle the logic of adding a value to the index.
   */
  private insertIntoIndex(
    def: IndexDefinition,
    value: any,
    docId: string,
    isRebuild = false,
  ): void {
    if (def.type === 'unique') {
      if (value !== undefined && value !== null) {
        if (def.data.has(value) && def.data.get(value) !== docId) {
          const errorMsg = `[IndexManager] ${isRebuild ? 'Uniqueness violation during rebuild' : 'CRITICAL ERROR: Duplicate value'} '${value}' in unique index '${def.fieldName}' (collection '${this.collectionName}') detected for ID '${docId}'.`;
          // eslint-disable-next-line @typescript-eslint/no-unused-expressions
          isRebuild ? this.logger.warn(errorMsg) : this.logger.error(errorMsg);
          if (!isRebuild) return;
        }
        def.data.set(value, docId);
      }
    } else {
      // standard
      if (!def.data.has(value)) {
        def.data.set(value, new Set<string>());
      }
      def.data.get(value).add(docId);
    }
  }

  /**
   * Internal helper to handle the logic of removing a value from the index.
   */
  private removeFromIndex(
    def: IndexDefinition,
    value: any,
    docId: string,
  ): void {
    if (def.type === 'unique') {
      if (value !== undefined && value !== null) {
        if (def.data.get(value) === docId) {
          def.data.delete(value);
        }
      }
    } else {
      // standard
      const set = def.data.get(value);
      if (set instanceof Set) {
        set.delete(docId);
        if (set.size === 0) def.data.delete(value);
      }
    }
  }

  /**
   * Index lookup (unique).
   * @param {string} fieldName
   * @param {any} value
   * @returns {string|null} - ID or null
   */
  public findOneIdByIndex(fieldName: string, value: any): string | null {
    const def = this.indexes.get(fieldName);
    if (!def || def.type !== 'unique') {
      return null;
    }
    return def.data.get(value) || null;
  }

  /**
   * Index lookup (standard).
   * @param {string} fieldName
   * @param {any} value
   * @returns {Set<string>} - a set of IDs (can be empty). Returns a COPY to prevent mutation.
   */
  public findIdsByIndex(fieldName: string, value: any): Set<string> {
    const def = this.indexes.get(fieldName);
    if (!def || def.type !== 'normal') {
      return new Set();
    }
    const internalSet = def.data.get(value);
    return internalSet ? new Set(internalSet) : new Set();
  }

  /**
   * Clears all index data.
   */
  public clearAllData(): void {
    for (const def of this.indexes.values()) {
      def.data.clear();
    }
  }
}
