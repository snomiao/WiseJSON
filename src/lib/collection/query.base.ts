import { cleanupExpiredDocs, isAlive } from './ttl.js';
import { matchFilter } from './utils.js';
import {
  Document,
  Filter,
  FilterQuery,
  FindOneAndUpdateOptions,
  Projection,
  TTLDocument,
  UpdateQuery,
  UpdateResult,
} from '../types.js';
import { CollectionBase } from './base.js';
import logger from '../logger.js';

export abstract class CollectionQueryBase<
  T extends Document,
> extends CollectionBase<T> {
  // Internal helpers assumed to exist in QueryBase
  // protected abstract cleanupExpiredDocs(): void;
  // protected abstract isAlive(doc: T): boolean;
  // --- Internal Helpers ---

  protected applyUpdateOperators(doc: T, updateQuery: UpdateQuery<T>): T {
    let newDoc = { ...doc };
    const hasOperators = Object.keys(updateQuery).some((key) =>
      key.startsWith('$'),
    );

    if (!hasOperators) {
      const { _id, createdAt } = newDoc as any;
      newDoc = { ...(updateQuery as any), _id, createdAt };
      return newDoc;
    }

    for (const op in updateQuery) {
      const opArgs = (updateQuery as any)[op];
      switch (op) {
        case '$set':
          Object.assign(newDoc, opArgs);
          break;
        case '$inc':
          for (const field in opArgs) {
            (newDoc as any)[field] =
              ((newDoc as any)[field] || 0) + opArgs[field];
          }
          break;
        case '$unset':
          for (const field in opArgs) {
            delete (newDoc as any)[field];
          }
          break;
        case '$push':
          for (const field in opArgs) {
            if (!Array.isArray((newDoc as any)[field]))
              (newDoc as any)[field] = [];
            if (opArgs[field] && opArgs[field].$each) {
              (newDoc as any)[field].push(...opArgs[field].$each);
            } else {
              (newDoc as any)[field].push(opArgs[field]);
            }
          }
          break;
        case '$pull':
          for (const field in opArgs) {
            if (Array.isArray((newDoc as any)[field])) {
              (newDoc as any)[field] = (newDoc as any)[field].filter(
                (item: any) => item !== opArgs[field],
              );
            }
          }
          break;
      }
    }
    return newDoc;
  }

  protected applyProjection(doc: T, projection: Projection<T>): any {
    if (!projection || Object.keys(projection).length === 0) return doc;

    const newDoc: any = {};
    const values = Object.values(projection);
    const hasInclusion = values.some((v) => v === 1);
    const hasExclusion = values.some((v) => v === 0);

    if (
      hasInclusion &&
      hasExclusion &&
      !Object.prototype.hasOwnProperty.call(projection, '_id')
    ) {
      throw new Error(
        'Projection cannot have a mix of inclusion and exclusion.',
      );
    }

    if (hasInclusion) {
      for (const key in projection) {
        if (
          (projection as any)[key] === 1 &&
          Object.prototype.hasOwnProperty.call(doc, key)
        ) {
          newDoc[key] = (doc as any)[key];
        }
      }
      if (projection['_id'] !== 0) newDoc._id = (doc as any)._id;
    } else {
      const excludedKeys = new Set(
        Object.keys(projection).filter((k) => (projection as any)[k] === 0),
      );
      for (const key in doc) {
        if (!excludedKeys.has(key)) {
          newDoc[key] = (doc as any)[key];
        }
      }
    }
    return newDoc;
  }

  // --- Public Query API ---

  public async getById(id: string): Promise<T | null> {
    const doc = this.documents.get(id);
    return doc && isAlive(doc as TTLDocument) ? doc : null;
  }

  public async getAll(): Promise<T[]> {
    cleanupExpiredDocs(
      this.documents as Map<string, TTLDocument>,
      this._indexManager,
    );
    return Array.from(this.documents.values());
  }

  public async count(query?: FilterQuery<T>): Promise<number> {
    cleanupExpiredDocs(
      this.documents as Map<string, TTLDocument>,
      this._indexManager,
    );
    if (!query || Object.keys(query).length === 0) {
      return this.documents.size;
    }
    const results = await this.find(query);
    return results.length;
  }

  public async find(
    query: FilterQuery<T>,
    projection: Projection<T> = {},
  ): Promise<T[]> {
    if (query)
      cleanupExpiredDocs(
        this.documents as Map<string, TTLDocument>,
        this._indexManager,
      );

    if (typeof query === 'function') {
      const docs = Array.from(this.documents.values())
        .filter((doc) => isAlive(doc as TTLDocument))
        .filter(query);
      return docs.map((doc) => this.applyProjection(doc, projection));
    }

    if (typeof query === 'object' && query !== null) {
      let bestIndexField: { field: string; type: 'exact' | 'range' } | null =
        null;
      let initialDocIds: Set<string> | null = null;

      for (const fieldName in query) {
        const condition = query[fieldName];
        if (this._indexManager.indexes.has(fieldName)) {
          if (typeof condition !== 'object') {
            bestIndexField = { field: fieldName, type: 'exact' };
            break;
          }
          if (
            typeof condition === 'object' &&
            Object.keys(condition).some((op) =>
              ['$gt', '$gte', '$lt', '$lte'].includes(op),
            )
          ) {
            if (!bestIndexField)
              bestIndexField = { field: fieldName, type: 'range' };
          }
        }
      }

      if (bestIndexField) {
        initialDocIds = new Set();
        const indexDef = this._indexManager.indexes.get(bestIndexField.field)!;
        const condition = query[bestIndexField.field];

        if (bestIndexField.type === 'exact') {
          const ids =
            indexDef?.type === 'unique'
              ? [
                  this._indexManager.findOneIdByIndex(
                    bestIndexField.field,
                    condition,
                  ),
                ].filter(Boolean)
              : this._indexManager.findIdsByIndex(
                  bestIndexField.field,
                  condition,
                );
          ids.forEach((id: any) => initialDocIds!.add(id));
        } else if (bestIndexField.type === 'range') {
          for (const [indexedValue, idsOrId] of indexDef.data.entries()) {
            const pseudoDoc = { [bestIndexField.field]: indexedValue };
            if (matchFilter(pseudoDoc, { [bestIndexField.field]: condition })) {
              if (indexDef.type === 'unique') initialDocIds.add(idsOrId);
              else
                (idsOrId as Set<string>).forEach((id) =>
                  initialDocIds!.add(id),
                );
            }
          }
        }
      }

      const results: any[] = [];
      const source: any =
        initialDocIds !== null
          ? Array.from(initialDocIds)
              .map((id) => this.documents.get(id))
              .filter(Boolean)
          : this.documents.values();

      for (const doc of source) {
        if (isAlive(doc as TTLDocument) && matchFilter(doc, query)) {
          results.push(this.applyProjection(doc, projection));
        }
      }
      return results;
    }
    throw new Error('find: query must be a function or a filter object.');
  }

  public async findOne(
    query: FilterQuery<T>,
    projection: Projection<T> = {},
  ): Promise<any | null> {
    if (typeof query === 'function') {
      cleanupExpiredDocs(
        this.documents as Map<string, TTLDocument>,
        this._indexManager,
      );
      for (const doc of this.documents.values()) {
        if (isAlive(doc as TTLDocument) && query(doc)) {
          return this.applyProjection(doc, projection);
        }
      }
      return null;
    }
    const results = await this.find(query, projection);
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Finds a single document and updates it based on the provided filter and operators.
   * * @template T - The document schema type.
   * @param {Filter<T>} filter - The selection criteria for the update.
   * @param {UpdateQuery<T>} updateQuery - The update operations to apply (e.g., $set, $inc).
   * @param {FindOneAndUpdateOptions} [options={}] - Configuration options for the operation.
   * @param {boolean} [options.returnOriginal=false] - If true, returns the document before the update was applied.
   * @returns {Promise<T | null>} The updated or original document, or null if no document matched the filter.
   */
  async findOneAndUpdate(
    filter: FilterQuery<T>,
    updateQuery: UpdateQuery<T>,
    options: FindOneAndUpdateOptions = { returnOriginal: false },
  ): Promise<T | null> {
    const { returnOriginal = false } = options;

    // Locate the document to be updated
    const docToUpdate = await this.findOne(filter as FilterQuery<T>);

    // If no match is found, return null immediately
    if (!docToUpdate) {
      return null;
    }

    /**
     * NOTE: We are currently using this.update for simplicity.
     * In the future, we should call _enqueueDataModification directly to retrieve
     * both the old and new documents within a single atomic operation for better performance.
     */

    // Calculate the new state of the document by applying atomic operators ($set, $inc, etc.)
    const newDocData = this.applyUpdateOperators(docToUpdate, updateQuery as UpdateQuery<T>);


    // Execute the update via the core CRUD operation
    const updatedDoc = await this.update(docToUpdate._id, newDocData);

    // Return the state requested by the user options
    return returnOriginal ? docToUpdate : updatedDoc;
  }

  // They are here cos of 'filter'
  public async updateOne(
    filter: FilterQuery<T>,
    updateQuery: UpdateQuery<T>,
  ): Promise<{ matchedCount: number; modifiedCount: number }> {
    const docToUpdate = await this.findOne(filter);
    if (!docToUpdate) return { matchedCount: 0, modifiedCount: 0 };

    const newDocData = this.applyUpdateOperators(docToUpdate, updateQuery);
    const updatedDoc = await this.update(docToUpdate._id, newDocData);
    return { matchedCount: 1, modifiedCount: updatedDoc ? 1 : 0 };
  }

  /**
   * Updates multiple documents in the collection matching the given filter.
   * * This method is polymorphic and supports two distinct modes:
   * 1. **Functional Mode**: Uses a predicate function to iterate over documents.
   * In this mode, `update` is treated as a partial document replacement.
   * 2. **Declarative Mode**: Uses a MongoDB-style Filter object.
   * In this mode, `update` supports atomic operators ($set, $inc, etc.) via the base class.
   *
   * @param filter - A query object {@link Filter} or a synchronous predicate function.
   * @param update - An {@link UpdateQuery} containing operators or a {@link Partial} document.
   * @returns If a function is provided as a filter, returns the count of updated documents (`number`).
   * If a filter object is provided, returns an {@link UpdateResult} object.
   * @throws {Error} If an update operation fails during the iteration.
   */
  public async updateMany(
    filter: Filter<T> | ((doc: T) => boolean),
    update: UpdateQuery<T> | Partial<T>,
  ): Promise<UpdateResult | number> {
    // --- MODE 1: Functional Predicate ---
    // If the filter is a function, we perform a manual scan of the in-memory documents.
    if (typeof filter === 'function' && this.isPlainObject(update)) {
      const idsToUpdate: string[] = [];

      // Collect IDs of all active documents that satisfy the predicate.
      for (const [id, doc] of this.documents.entries()) {
        // isAlive checks for expiration or pending deletion status.
        if (isAlive(doc) && filter(doc)) {
          idsToUpdate.push(id);
        }
      }

      // Short-circuit if no matching documents are found.
      if (idsToUpdate.length === 0) {
        return 0;
      }

      let successfullyUpdatedCount = 0;

      // Perform sequential updates. This ensures the WAL and persistence
      // layers handle each change correctly through the standard update path.
      for (const id of idsToUpdate) {
        try {
          const updatedDoc = await this.update(id, update as Partial<T>);
          if (updatedDoc) {
            successfullyUpdatedCount++;
          }
        } catch (error: any) {
          logger.error(
            `[Ops] Error updating document ID '${id}' in updateMany: ${error.message}`,
          );
          // Re-throwing ensures the caller is aware the batch operation was interrupted.
          throw error;
        }
      }
      return successfullyUpdatedCount;
    }

    // --- MODE 2: Declarative Object Filter ---
    // If the filter is not a function, we delegate to the query engine to find documents.
    // This path supports index optimization and atomic update operators ($set, $inc).
    const docsToUpdate = await (this as any).find(filter);
    let modifiedCount = 0;

    for (const doc of docsToUpdate) {
      // Use updateOne to leverage operator logic ($set/$inc) and maintain index consistency.
      const result = await (this as any).updateOne({ _id: doc._id }, update);
      if (result.modifiedCount > 0) {
        modifiedCount++;
      }
    }

    return {
      matchedCount: docsToUpdate.length,
      modifiedCount,
    };
  }

  public async deleteOne(
    filter: FilterQuery<T>,
  ): Promise<{ deletedCount: number }> {
    const docToRemove = await this.findOne(filter);
    if (!docToRemove) return { deletedCount: 0 };
    const success = await this.remove(docToRemove._id);
    return { deletedCount: success ? 1 : 0 };
  }

  public async deleteMany(
    filter: FilterQuery<T>,
  ): Promise<{ deletedCount: number }> {
    const docsToRemove = await this.find(filter);
    const idsToRemove = docsToRemove.map((d) => d._id);
    if (idsToRemove.length === 0) return { deletedCount: 0 };

    const deletedCount = await this.removeMany((doc: any) =>
      idsToRemove.includes(doc._id),
    );
    return { deletedCount };
  }

  /**
   * [Legacy] Finds the first document matching an indexed value.
   * * @param fieldName - The indexed field to search.
   * @param value - The value to look for.
   */
  public async findByIndexedValue(fieldName: string, value: any): Promise<T[]> {
    // 1. Housekeeping: ensure we aren't returning dead docs
    cleanupExpiredDocs(this.documents, this._indexManager);

    const index = this._indexManager.indexes.get(fieldName);
    if (!index) {
      logger.warn(
        `No index found for field: ${fieldName}. Falling back to manual search.`,
      );
      return this.find({ [fieldName]: value } as any);
    }

    let idsToFetch: Set<string>;
    if (index.type === 'unique') {
      idsToFetch = new Set();
      const id = this._indexManager.findOneIdByIndex(fieldName, value);
      if (id) idsToFetch.add(id);
    } else {
      idsToFetch = this._indexManager.findIdsByIndex(fieldName, value);
    }

    const result: T[] = [];
    for (const id of idsToFetch) {
      const doc = this.documents.get(id);
      // Double check existence and TTL status
      if (doc && isAlive(doc)) {
        result.push(doc);
      }
    }
    return result;
  }

  /**
   * [Legacy] Directly searches an index for documents with a specific field value.
   * * @param fieldName - The indexed field to search.
   * @param value - The value to look for.
   */
  public async findOneByIndexedValue(
    fieldName: string,
    value: any,
  ): Promise<T | null> {
    const index = this._indexManager.indexes.get(fieldName);
    if (!index) return this.findOne({ [fieldName]: value } as any);

    if (index.type === 'unique') {
      const id = this._indexManager.findOneIdByIndex(fieldName, value);
      if (id) {
        const potentialDoc = this.documents.get(id);
        if (potentialDoc && isAlive(potentialDoc)) {
          return potentialDoc;
        }
      }
      return null;
    } else {
      // For non-unique, get the set and take the first valid one
      const results = await this.findByIndexedValue(fieldName, value);
      return results.length > 0 ? results[0] : null;
    }
  }
}
