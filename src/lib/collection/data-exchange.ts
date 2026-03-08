import fs from 'fs/promises';
import logger from '../logger.js';
import { flattenDocToCsv } from './utils.js';
import {  DataExchangeContext, Document, ImportOptions } from '../types.js';

/**
 * Exports all active (non-expired) documents from the collection to a JSON file.
 * The output is formatted with a 2-space indentation for readability.
 * * @param filePath - The destination path on the filesystem.
 * @param options - Reserved for future configuration (currently unused).
 * @throws {Error} If file writing fails.
 */
export async function exportJson<T extends Document>(
    this: DataExchangeContext<T>,
    filePath: string,
    options: object = {}
): Promise<void> {
    const docs = await this.getAll();
    try {
        const jsonContent = JSON.stringify(docs, null, 2);
        await fs.writeFile(filePath, jsonContent, 'utf-8');
    } catch (error: any) {
        logger.error(`[Data Exchange] Error exporting JSON to ${filePath}:`, error);
        throw error;
    }
}

/**
 * Exports all active (non-expired) documents from the collection to a CSV file.
 * Uses a flattening utility to convert nested objects into a flat CSV structure.
 * * @param filePath - The destination path for the CSV file.
 * @throws {Error} If the flattening process or file writing fails.
 */
export async function exportCsv<T extends Document>(
    this: DataExchangeContext<T>,
    filePath: string
): Promise<void> {
    const docs = await this.getAll();

    if (docs.length === 0) {
        try {
            await fs.writeFile(filePath, '', 'utf-8'); // Create an empty file
        } catch (error: any) {
            logger.error(`[Data Exchange] Error creating empty CSV file ${filePath}:`, error);
            throw error;
        }
        return;
    }

    try {
      // Assume flattenDocToCsv is available.
      // If it's not a `this` method, it needs to be imported:
      // const { flattenDocToCsv } = require('./utils.js'); // or require('../utils') if it exists
      // In the current structure of core.js, it is imported and used,
      // so if data-exchange.js becomes part of Collection, this.flattenDocToCsv might not exist.
      // It's safer to import it directly if it's not on the Collection prototype.
      // Let's assume it needs to be imported:
        const csvData = flattenDocToCsv(docs);
        await fs.writeFile(filePath, csvData, 'utf-8');
    } catch (error: any) {
        logger.error(`[Data Exchange] Error exporting CSV to ${filePath}:`, error);
        throw error;
    }
}

/**
 * Imports documents from a JSON file into the collection.
 * Supports appending to current data or completely replacing the collection.
 * * @param filePath - Path to the JSON file containing an array of documents.
 * @param options - Configuration for the import mode ('append' | 'replace').
 * @throws {Error} If the file is not a valid JSON array or insertion fails.
 */
export async function importJson<T extends Document>(
    this: DataExchangeContext<T>,
    filePath: string,
    options: ImportOptions = {}
): Promise<void> {
    const mode = options.mode || 'append';
    let jsonData: any;

    try {
        const rawData = await fs.readFile(filePath, 'utf-8');
        jsonData = JSON.parse(rawData);
    } catch (error: any) {
        logger.error(`[Data Exchange] Error reading or parsing JSON file ${filePath}:`, error);
        throw error;
    }

    if (!Array.isArray(jsonData)) {
        const error = new Error('Import file must contain a JSON array of documents.');
        logger.error(`[Data Exchange] ${error.message}`);
        throw error;
    }

    if (jsonData.length === 0) {
        return;
    }

    try {
        if (mode === 'replace') {
            await this.clear(); // `this.clear()` - method from crud-ops (or ops.js)
        }

        // `this.insertMany()` is a method from crud-ops (or ops.js)
        // insertMany handles the WAL logging and statistics internally
        await this.insertMany(jsonData);
    } catch (error: any) {
        logger.error(`[Data Exchange] Error during import operation (mode: ${mode}):`, error);
        throw error;
    }
}
