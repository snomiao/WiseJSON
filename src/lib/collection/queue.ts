import { LockableCollection } from "../types.js";

/**
 * Initializes a write queue on a collection instance.
 * Ensures that all data modifications are executed sequentially to maintain consistency.
 * @param collection - The collection instance to attach the queue to.
 */
export function createWriteQueue(collection: LockableCollection) {
    // 1. Initialize the state on the collection as per original logic
    // 1. Initialize the state on the collection as per original logic
  collection["_writeQueue"] = [] as Array<{
        opFn: () => Promise<any>,
        resolve: (val: any) => void,
        reject: (err: any) => void
    }>;
    collection["_writing"] = false;

    /**
     * Processes tasks in the queue one by one.
     * Automatically handles locking and unlocking for the duration of each operation.
     */
    /**
   * Processes tasks in the queue one by one.
   * Automatically handles locking and unlocking for the duration of each operation.
   */
  collection["_processQueue"] = async function (): Promise<void> {
        if (collection["_writing"] || collection["_writeQueue"].length === 0) return;

        collection["_writing"] = true;
        const task = collection["_writeQueue"].shift();

        if (!task) {
            collection["_writing"] = false;
            return;
        }

        try {
            await collection._acquireLock();
            const result = await task.opFn();
            task.resolve(result);
        } catch (err) {
            task.reject(err);
        } finally {
            await collection._releaseLockIfHeld();
            collection["_writing"] = false;
            // Use setImmediate to prevent potential stack overflow on extremely large queues
            setImmediate(() => collection["_processQueue"]());
        }
    };

    /**
     * Adds an operation to the queue.
     * @param opFn - operation function returning a Promise.
     */
    /**
   * Adds an operation to the queue.
   * @param opFn - operation function returning a Promise.
   */
  collection["_enqueue"] = function <T>(opFn: () => Promise<T>): Promise<T> {
        return new Promise((resolve, reject) => {
            collection["_writeQueue"].push({ opFn, resolve, reject });
            collection["_processQueue"]();
        });
    };

    // 2. IMPORTANT: Return the function so "this._enqueue = createWriteQueue(this)" works.
    return collection["_enqueue"];
}
