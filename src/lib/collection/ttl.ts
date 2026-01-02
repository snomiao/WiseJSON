/**
 * Interface representing a document with potential TTL fields.
 */

import { TTLDocument } from "../types.js";
import { IndexManager } from "./indexes.js";

/**
 * Determines if a document is still "alive" based on TTL or expireAt fields.
 * If both criteria are missing, the document is considered permanent.
 * Uses Object.prototype.hasOwnProperty.call to check for property existence.
 * @param doc - The document to check.
 * @returns True if alive, false if expired.
 */
export function isAlive(doc: TTLDocument): boolean {
    if (!doc || typeof doc !== 'object') return false;

    // Check Absolute Expiration (expireAt)
    if (Object.prototype.hasOwnProperty.call(doc, 'expireAt')) {
        if (doc["expireAt"] !== null && doc["expireAt"] !== undefined) {
            const exp = typeof doc["expireAt"] === 'string' ? Date.parse(doc["expireAt"]) : Number(doc["expireAt"]);
            if (!isNaN(exp)) return Date.now() < exp;
        }
    }

    // Check Relative Expiration (ttl)
    if (Object.prototype.hasOwnProperty.call(doc, 'ttl')) {
        if (doc.ttl !== null && doc.ttl !== undefined) {
            const createdAtStr = doc.createdAt;
            if (!createdAtStr) return true;
            const createdAtMs = Date.parse(createdAtStr);
            const ttlMs = Number(doc.ttl);
            if (isNaN(createdAtMs) || isNaN(ttlMs)) return true;
            return Date.now() < (createdAtMs + ttlMs);
        }
    }

    return true;
}

/**
 * Scans a document Map and removes all expired entries.
 * Updates associated indexes if an IndexManager is provided.
 * @param documents - The collection's primary data storage.
 * @param indexManager - Optional manager to update after deletions.
 * @returns The total number of documents removed.
 */
export function cleanupExpiredDocs(
    documents: Map<string, TTLDocument>,
    indexManager?: IndexManager
): number {
    let removedCount = 0;
    if (!(documents instanceof Map)) return removedCount;

    const idsToRemove: string[] = [];
    for (const [id, doc] of documents.entries()) {
        if (!isAlive(doc)) idsToRemove.push(id);
    }

    for (const id of idsToRemove) {
        const docToRemove = documents.get(id);
        if (docToRemove) {
            documents.delete(id);
            if (indexManager && typeof indexManager.afterRemove === 'function') {
                indexManager.afterRemove(docToRemove);
            }
            removedCount++;
        }
    }
    return removedCount;
}
