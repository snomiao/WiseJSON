import { cleanupExpiredDocs, isAlive } from './ttl.js';
import { matchFilter } from './utils.js';
import { CollectionOps, Document, FilterQuery, Projection, TTLDocument, UpdateQuery } from '../types.js';

/**
 * Internal helper to apply update operators ($set, $inc, $unset, etc.) to a document.
 * If no $-prefixed operators are found, it performs a complete replacement of the document data.
 * * @param doc - The current version of the document.
 * @param updateQuery - The query object containing update instructions.
 * @returns A new document object with updates applied.
 */
function applyUpdateOperators<T extends Document>(doc: T & Document, updateQuery: UpdateQuery<T>): T & Document {
    let newDoc = { ...doc };
    const hasOperators = Object.keys(updateQuery).some(key => key.startsWith('$'));

    if (!hasOperators) {
        const { _id, createdAt } = newDoc;
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
                    (newDoc as any)[field] = ((newDoc as any)[field] || 0) + opArgs[field];
                }
                break;
            case '$unset':
                for (const field in opArgs) {
                    delete (newDoc as any)[field];
                }
                break;
            case '$push':
                for (const field in opArgs) {
                    if (!Array.isArray((newDoc as any)[field])) (newDoc as any)[field] = [];
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
                        (newDoc as any)[field] = (newDoc as any)[field].filter((item: any) => item !== opArgs[field]);
                    }
                }
                break;
        }
    }
    return newDoc;
}

/**
 * Internal helper to filter document fields based on a projection object.
 * Logic ensures that inclusion and exclusion aren't mixed, with the exception of the _id field.
 * * @param doc - The document to be projected.
 * @param projection - Map specifying fields to include (1) or exclude (0).
 * @returns A filtered version of the document.
 */
function applyProjection<T extends Document>(doc: T & Document, projection: Projection<T>): any {
    if (!projection || Object.keys(projection).length === 0) {
        return doc;
    }

    const newDoc: any = {};
    const values = Object.values(projection);
    const hasInclusion = values.some(v => v === 1);
    const hasExclusion = values.some(v => v === 0);

    if (hasInclusion && hasExclusion && !Object.prototype.hasOwnProperty.call(projection, '_id')) {
        throw new Error('Projection cannot have a mix of inclusion and exclusion.');
    }

    if (hasInclusion) {
        for (const key in projection) {
            if ((projection as any)[key] === 1 && Object.prototype.hasOwnProperty.call(doc, key)) {
                newDoc[key] = (doc as any)[key];
            }
        }
        if (projection['_id'] !== 0) {
            newDoc._id = doc._id;
        }
    } else {// Exception mode
        const excludedKeys = new Set(Object.keys(projection).filter(k => projection[k as keyof typeof projection] === 0));
        for (const key in doc) {
            if (!excludedKeys.has(key)) {
                newDoc[key] = (doc as any)[key];
            }
        }
    }

    return newDoc;
}


// --- Main API methods ---

/**
 * Fetches a document by its ID.
 * Returns null if the document does not exist or has expired based on TTL.
 * * @param id - Document unique identifier.
 */
export async function getById<T extends Document>(this: CollectionOps<T>, id: string): Promise<(T & Document) | null> {
    const doc = this.documents.get(id);
    return doc && isAlive(doc as TTLDocument) ? doc : null;
}

/**
 * Returns all documents in the collection that have not expired.
 * Automatically runs a TTL cleanup before returning values.
 */
export async function getAll<T extends Document>(this: CollectionOps<T>): Promise<(T & Document)[]> {
    cleanupExpiredDocs(this.documents as Map<string, TTLDocument>, (this as any)._indexManager);
    return Array.from(this.documents.values());
}

/**
 * Returns the number of documents matching a query.
 * If no query is provided, returns the total count of active documents.
 * * @param query - Optional filter object or function.
 */
export async function count<T extends Document>(this: CollectionOps<T>, query?: any): Promise<number> {
    cleanupExpiredDocs(this.documents as Map<string, TTLDocument>, (this as any)._indexManager);
    if (!query || Object.keys(query).length === 0) {
        return this.documents.size;
    }
    const results = await (this as any).find(query);
    return results.length;
}

/**
 * Performs a search for documents matching a filter.
 * Optimized to use indexes for exact matches and specific range operators ($gt, $lt, etc.).
 * * @param query - Filter object (MongoDB-style) or a function.
 * @param projection - Optional map to include/exclude specific fields.
 * @returns Array of matching (and projected) documents.
 */
export async function find<T extends Document>(this: CollectionOps<T>, query: any, projection: Projection<T> = {}): Promise<any[]> {
    const indexManager = (this as any)._indexManager;
    if(query)
      cleanupExpiredDocs(this.documents as Map<string, TTLDocument>, indexManager);

    if (typeof query === 'function') {
        const docs = Array.from(this.documents.values()).filter(doc => isAlive(doc as TTLDocument)).filter(query);
        return docs.map(doc => applyProjection(doc, projection));
    }

    if (typeof query === 'object' && query !== null) {
        let bestIndexField: { field: string, type: 'exact' | 'range' } | null = null;

        let initialDocIds: Set<string> | null = null;

        for (const fieldName in query) {
            const condition = query[fieldName];
            if (indexManager.indexes.has(fieldName)) {
                if (typeof condition !== 'object') {
                    bestIndexField = { field: fieldName, type: 'exact' };
                    break;
                }
                if (typeof condition === 'object' && Object.keys(condition).some(op => ['$gt', '$gte', '$lt', '$lte'].includes(op))) {
                    if (!bestIndexField) {
                        bestIndexField = { field: fieldName, type: 'range' };
                    }
                }
            }
        }

        if (bestIndexField) {
            initialDocIds = new Set();
            const indexDef = indexManager.indexes.get(bestIndexField.field);
            const condition = query[bestIndexField.field];

            if (bestIndexField.type === 'exact') {
                const ids = indexDef.type === 'unique'
                    ? [indexManager.findOneIdByIndex(bestIndexField.field, condition)].filter(Boolean)
                    : indexManager.findIdsByIndex(bestIndexField.field, condition);
                ids.forEach((id: string) => initialDocIds!.add(id));
            } else if (bestIndexField.type === 'range') {
                for (const [indexedValue, idsOrId] of indexDef.data.entries()) {
                    const pseudoDoc = { [bestIndexField.field]: indexedValue };
                    if (matchFilter(pseudoDoc, { [bestIndexField.field]: condition })) {
                        if (indexDef.type === 'unique') initialDocIds.add(idsOrId);
                        else (idsOrId as Set<string>).forEach(id => initialDocIds!.add(id));
                    }
                }
            }
        }

        const results: any[] = [];
        const source: any = initialDocIds !== null
          ? Array.from(initialDocIds).map(id => this.documents.get(id)).filter(Boolean)
          : this.documents.values();

        for (const doc of source) {
          if (isAlive(doc as TTLDocument) && matchFilter(doc, query)) {
            results.push(applyProjection(doc, projection));
          }
        }
        return results;
    }

    throw new Error('find: query must be a function or a filter object.');
}

/**
 * Finds the first document that matches the query.
 * * @param query - Filter object or function.
 * @param projection - Optional field mapping.
 * @returns The first found document or null.
 */
export async function findOne<T extends Document>(this: CollectionOps<T>, query: any, projection: Projection<T> = {}): Promise<any | null> {
    if (typeof query === 'function') {
        cleanupExpiredDocs(this.documents as Map<string, TTLDocument>, (this as any)._indexManager);
        for (const doc of this.documents.values()) {
            if (isAlive(doc as TTLDocument) && query(doc)) {
                return applyProjection(doc, projection);
            }
        }
        return null;
    }

    if (typeof query === 'object' && query !== null) {
        const results = await (this as any).find(query, projection);
        return results.length > 0 ? results[0] : null;
    }

    throw new Error('findOne: query must be a function or a filter object.');
}

/**
 * Finds a single document by filter and applies update operators.
 * * @param filter - Search criteria.
 * @param updateQuery - Update instructions ($set, $inc, etc.).
 * @returns Result object containing matchedCount and modifiedCount.
 */
export async function updateOne<T extends Document>(this: CollectionOps<T>, filter: any, updateQuery: UpdateQuery<T>): Promise<{ matchedCount: number, modifiedCount: number }> {
    const docToUpdate = await (this as any).findOne(filter);
    if (!docToUpdate) {
        return { matchedCount: 0, modifiedCount: 0 };
    }

    const newDocData = applyUpdateOperators(docToUpdate, updateQuery);
    const updatedDoc = await (this as any).update(docToUpdate._id, newDocData);

    return { matchedCount: 1, modifiedCount: updatedDoc ? 1 : 0 };
}

/**
 * Updates multiple documents that match the filter.
 * Uses index-optimized search to identify target documents before applying updates.
 * * @param filter - Search criteria.
 * @param updateQuery - Update instructions ($set, $inc, etc.).
 * @returns Result object containing matchedCount and modifiedCount.
 */
export async function updateMany<T extends Document>(this: CollectionOps<T>, filter: any, updateQuery: UpdateQuery<T>): Promise<{ matchedCount: number, modifiedCount: number }> {
    const docsToUpdate = await (this as any).find(filter);
    if (docsToUpdate.length === 0) {
        return { matchedCount: 0, modifiedCount: 0 };
    }

    let modifiedCount = 0;
    for (const doc of docsToUpdate) {
        const result = await (this as any).updateOne({ _id: doc._id }, updateQuery);
        if (result.modifiedCount > 0) {
            modifiedCount++;
        }
    }

    return { matchedCount: docsToUpdate.length, modifiedCount };
}

/**
 * Finds one document, updates it, and returns either the original or the updated version.
 * * @param filter - Search criteria.
 * @param updateQuery - Update operators.
 * @param options - Set returnOriginal to true to get the document state before update.
 */
export async function findOneAndUpdate<T extends Document>(this: CollectionOps<T>, filter: FilterQuery<T>, updateQuery: UpdateQuery<T>, options: { returnOriginal?: boolean } = {}): Promise<any | null> {
    const { returnOriginal = false } = options;
    const docToUpdate = await (this as any).findOne(filter);
    if (!docToUpdate) return null;

    const newDocData = applyUpdateOperators(docToUpdate, updateQuery);
    const updatedDoc = await (this as any).update(docToUpdate._id, newDocData);

    return returnOriginal ? docToUpdate : updatedDoc;
}

/**
 * Deletes the first document matching the filter.
 * * @param filter - Search criteria.
 * @returns Result object with deletedCount.
 */
export async function deleteOne<T extends Document>(this: CollectionOps<T>, filter: any): Promise<{ deletedCount: number }> {
    const docToRemove = await (this as any).findOne(filter);
    if (!docToRemove) {
        return { deletedCount: 0 };
    }
    const success = await (this as any).remove(docToRemove._id);
    return { deletedCount: success ? 1 : 0 };
}

/**
 * Deletes multiple documents matching the filter.
 * * @param filter - Search criteria.
 * @returns Result object with deletedCount.
 */
export async function deleteMany<T extends Document>(this: CollectionOps<T>, filter: any): Promise<{ deletedCount: number }> {
    const docsToRemove = await (this as any).find(filter);
    const idsToRemove = docsToRemove.map((d: { _id: any; }) => d._id);
    if (idsToRemove.length === 0) {
        return { deletedCount: 0 };
    }

    const deletedCount = await (this as any).removeMany((doc: any) => idsToRemove.includes(doc._id));
    return { deletedCount };
}

/**
 * [Legacy] Directly searches an index for documents with a specific field value.
 * * @param fieldName - The indexed field to search.
 * @param value - The value to look for.
 */
export async function findByIndexedValue<T extends Document>(this: CollectionOps<T>, fieldName: string, value: any): Promise<(T & Document)[]> {
    cleanupExpiredDocs(this.documents as Map<string, TTLDocument>, (this as any)._indexManager);

    const index = (this as any)._indexManager.indexes.get(fieldName);
    if (!index) return [];

    let idsToFetch = new Set<string>();
    if (index.type === 'unique') {
        const id = (this as any)._indexManager.findOneIdByIndex(fieldName, value);
        if (id) idsToFetch.add(id);
    } else {
        idsToFetch = (this as any)._indexManager.findIdsByIndex(fieldName, value);
    }

    const result: (T & Document)[] = [];
    for (const id of idsToFetch) {
        const doc = this.documents.get(id);
        if (doc && isAlive(doc as TTLDocument)) {
            result.push(doc);
        }
    }
    return result;
}

/**
 * [Legacy] Finds the first document matching an indexed value.
 * * @param fieldName - The indexed field to search.
 * @param value - The value to look for.
 */
export async function findOneByIndexedValue<T extends Document>(this: CollectionOps<T>, fieldName: string, value: any): Promise<(T & Document) | null> {
    const index = (this as any)._indexManager.indexes.get(fieldName);
    if (!index) return null;

    if (index.type === 'unique') {
        const id = (this as any)._indexManager.findOneIdByIndex(fieldName, value);
        if (id) {
            const potentialDoc = this.documents.get(id);
            if (potentialDoc && isAlive(potentialDoc as TTLDocument)) {
                return potentialDoc;
            }
        }
        return null;
    } else {
        const results = await (this as any).findByIndexedValue(fieldName, value);
        return results.length > 0 ? results[0] : null;
    }
}
