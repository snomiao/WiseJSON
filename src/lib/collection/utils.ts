import path from 'path';
import { CollectionOptions } from '../types.js';
import defaultLogger from '../logger.js';

export interface QueryOperators {
    $gt?: any;
    $gte?: any;
    $lt?: any;
    $lte?: any;
    $ne?: any;
    $in?: any[];
    $nin?: any[];
    $exists?: boolean;
    $regex?: string | RegExp;
    $options?: string;
}

export type Filter = {
    [key: string]: any;
    $or?: Filter[];
    $and?: Filter[];
};

/**
 * Generates a unique ID (short, simple).
 */
export const defaultIdGenerator = (): string => {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
};

/**
 * Checks if value is a non-empty string.
 */
export const isNonEmptyString = (value: any): value is string => {
    return typeof value === 'string' && value.length > 0;
};

/**
 * Checks if value is a plain object.
 */
export const isPlainObject = (value: any): value is Record<string, any> => {
    return Object.prototype.toString.call(value) === '[object Object]';
};

/**
 * Converts path to absolute path.
 */
export const makeAbsolutePath = (p: string): string => {
    return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
};

/**
 * Validates and fills collection options with defaults.
 */
export const validateOptions = (opts: CollectionOptions = {}): Required<CollectionOptions> => {
    return {
        maxSegmentSizeBytes: opts.maxSegmentSizeBytes ?? 2 * 1024 * 1024,
        checkpointIntervalMs: opts.checkpointIntervalMs ?? 60000,
        ttlCleanupIntervalMs: opts.ttlCleanupIntervalMs ?? 60000,
        walSync: opts.walSync ?? false,

        idGenerator: opts.idGenerator ?? defaultIdGenerator,
        checkpointsToKeep: opts.checkpointsToKeep ?? 5,
        maxWalEntriesBeforeCheckpoint: opts.maxWalEntriesBeforeCheckpoint ?? 1000,
        walReadOptions: { recover: false, strict: false, ...opts.walReadOptions },
        logger: opts.logger ?? defaultLogger,
        apiClient: opts.apiClient!
    };
};

/**
 * Converts an array of documents to a CSV string.
 */
export const flattenDocToCsv = (docs: Record<string, any>[]): string => {
    if (!Array.isArray(docs) || docs.length === 0) return '';

    const fields = Array.from(new Set(docs.flatMap(doc => Object.keys(doc))));

    const escape = (v: any): string | any => {
        if (typeof v === 'string' && (v.includes(',') || v.includes('"') || v.includes('\n'))) {
            return `"${v.replace(/"/g, '""')}"`;
        }
        return v;
    };

    const header = fields.join(',');
    const rows = docs.map(doc =>
        fields.map(f => escape(doc[f] ?? '')).join(',')
    );

    return [header, ...rows].join('\n');
};

/**
 * MongoDB-style filter matching logic.
 */
export const matchFilter = (doc: Record<string, any>, filter: Filter): boolean => {
    if (!isPlainObject(filter) || !isPlainObject(doc)) {
        return false;
    }

    if (Array.isArray(filter.$or)) {
        return filter.$or.some(f => matchFilter(doc, f));
    }

    if (Array.isArray(filter.$and)) {
        return filter.$and.every(f => matchFilter(doc, f));
    }

    for (const key of Object.keys(filter)) {
        if (key === '$or' || key === '$and') continue;

        const cond = filter[key];
        const value = doc[key];

        if (isPlainObject(cond)) {
            for (const op of Object.keys(cond)) {
                const opVal = (cond as QueryOperators)[op as keyof QueryOperators];
                let match = true;

                switch (op) {
                    case '$gt':   if (!(value > opVal)) match = false; break;
                    case '$gte':  if (!(value >= opVal)) match = false; break;
                    case '$lt':   if (!(value < opVal)) match = false; break;
                    case '$lte':  if (!(value <= opVal)) match = false; break;
                    case '$ne':   if (value === opVal) match = false; break;
                    case '$eq':   if (value !== opVal) match = false; break;

                    case '$in': {
                        if (!Array.isArray(opVal)) {
                            match = false;
                        } else if (Array.isArray(value)) {
                            match = value.some(item => (opVal as any[]).includes(item));
                        } else {
                            match = (opVal as any[]).includes(value);
                        }
                        break;
                    }
                    case '$nin': {
                        if (!Array.isArray(opVal)) {
                            match = false;
                        } else if (Array.isArray(value)) {
                            match = !value.some(item => (opVal as any[]).includes(item));
                        } else {
                            match = !(opVal as any[]).includes(value);
                        }
                        break;
                    }
                    case '$exists':
                        if ((value !== undefined) !== opVal) match = false;
                        break;
                    case '$regex': {
                        if (typeof value !== 'string') {
                            match = false;
                        } else {
                            try {
                                const re = new RegExp(opVal as string, (cond as any).$options || '');
                                if (!re.test(value)) match = false;
                            } catch {
                                match = false;
                            }
                        }
                        break;
                    }
                    case '$options': break; // Handled by $regex
                    default:
                        match = false;
                        break;
                }
                if (!match) return false;
            }
        } else {
            if (value !== cond) return false;
        }
    }
    return true;
};
