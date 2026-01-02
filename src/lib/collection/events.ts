import logger from '../logger.js';
import { CollectionEventMap } from '../types.js';


/**
 * EventEmitter class for local events in a Collection.
 */
export class CollectionEventEmitter<DocT, T = CollectionEventMap<DocT>> {
    // We use a more specific type than 'Function' to satisfy the linter
    private _listeners: { [K in keyof T]?: Array<(...args: any[]) => void | Promise<void>> } = {};
    private _collectionName: string;

    // New: Storage for the most recent payload of each event
    private _eventBuffer: { [K in keyof T]?: T[K] } = {};

    constructor(collectionName = 'unnamed') {
        this._collectionName = collectionName;
    }

    /**
     * Subscribe to an event.
     * @param eventName
     * @param listener
     */
    on<K extends keyof T>(eventName: K, listener: (args: T[K]) => void | Promise<void>): void {
        if (typeof listener !== 'function') {
            throw new Error(`Collection (${this._collectionName}): listener must be a function.`);
        }


        if (!this._listeners[eventName]) {
            this._listeners[eventName] = [];
        }

        this._listeners[eventName]!.push(listener);

        // --- NEW LOGIC: REPLAY ---
        // If we have a buffered event of this type, send it to the new listener immediately
        if (this._eventBuffer[eventName] !== undefined) {
            const bufferedArgs = this._eventBuffer[eventName]!;
            setTimeout(() => { // Using timeout to ensure listener is fully registered
                try {
                    listener(bufferedArgs);
                } catch (e) {
                    console.error("Error replaying buffered event", e);
                }
            }, 0);
        }
    }

    /**
     * Unsubscribe from an event. If listener is not specified — removes all.
     * @param eventName
     * @param listener
     */
    off<K extends keyof T>(eventName: K, listener?: (args: T[K]) => void | Promise<void>): void {
        const listeners = this._listeners[eventName];
        if (!listeners) return;

        if (!listener) {
            delete this._listeners[eventName];
        } else {
            this._listeners[eventName] = listeners.filter(l => l !== listener);
            if (this._listeners[eventName]!.length === 0) {
                delete this._listeners[eventName];
            }
        }
    }

    /**
     * Emit an event.
     * @param eventName
     * @param args
     */
    emit<K extends keyof T>(
      eventName: K,
      ...args: T[K] extends void ? [] : [T[K]]
      // args: T[K]
    ): void {
      // --- NEW LOGIC: BUFFERING ---
        // Store the latest payload so future listeners can see it
      (this._eventBuffer  as any)[eventName] = args;

      const listeners = this._listeners[eventName];
      if (!listeners || listeners.length === 0) return;

        // Filter out undefined arguments as per original logic
        const filteredArgs = args.filter(arg => arg !== undefined);

        for (const listener of listeners) {
            try {
                const result = listener(filteredArgs);
                if (result instanceof Promise) {
                    result.catch(e =>
                        logger.error(`Collection (${this._collectionName}) async event error '${String(eventName)}': ${e.message}`)
                    );
                }
            } catch (e: any) {
                logger.error(`Collection (${this._collectionName}) sync event error '${String(eventName)}': ${e.message}`);
            }
        }
    }
}

export default CollectionEventEmitter;
