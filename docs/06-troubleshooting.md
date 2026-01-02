docs/06-troubleshooting.md

# 06 - Troubleshooting and Troubleshooting (FAQ)

This section contains answers to frequently asked questions and solutions to common issues you may encounter when working with WiseJSON DB.

### Q1: My data isn't saved after I restart my application. What should I do?

**A1:** The most likely cause is that you're not closing the database properly before terminating your application. WiseJSON DB performs final data saving (including writing checkpoints and WAL compaction) when you call the `await db.close()` method.

- **Solution:** Ensure your code has a `finally` block or a process termination handler that calls `await db.close()`.

```javascript
let db;
try {
  db = new WiseJSON(dbPath);
  await db.init();
  // ... your work with the database ...
} catch (error) {
  console.error(error);
} finally {
  if (db) {
    await db.close(); // Required!
  }
}
```

- WiseJSON DB tries to automatically save when receiving `SIGINT` and `SIGTERM` signals, but this isn't always reliable, especially in the event of a crash. Explicitly calling `db.close()` is best practice.

### Q2: I get the error `Duplicate value '...' for unique index '...'`. What does this mean?

**A2:** This error occurs when you attempt an operation (`insert`, `insertMany`, `update`, `updateMany`) that would violate the uniqueness of a value in a field for which a unique index has been created.

- **Solution:**

1. **Validate the data:** Make sure that the value you are trying to insert or update is indeed unique for this field in the collection.
2. **Application logic:** You may need to add a check for the existence of such a value before performing the write operation.

```javascript
const existingDoc = await usersCollection.findOneByIndexedValue('email', newUser.email);
if (existingDoc) {
  console.error(`User with email ${newUser.email} already exists!`);
} else {
  await usersCollection.insert(newUser);
}
```

3. **Index Type:** If this field doesn't need to be strictly unique, you might want to drop the unique index and create a standard (non-unique) index instead, or not create an index at all if it's not frequently searched.

### Q3: How can I view the database contents manually (files on disk)?

**A3:** WiseJSON DB data is stored on the file system in the directory you specified when creating the WiseJSON instance. A subdirectory is created for each collection.

- **Collection Path:** `<dbPath>/<collectionName>/`
- **Checkpoints (Master Data):** `<dbPath>/<collectionName>/_checkpoints/`
  - This directory stores the checkpoint files. Each checkpoint consists of:
  - One `checkpoint_meta_<collectionName>_<timestamp>.json` file (collection metadata, including index information).
  - One or more `checkpoint_data_<collectionName>_<timestamp>_segX.json` files (segments containing document data in JSON array format).
  - The most recent data is typically found in the checkpoint files with the latest timestamp.
- **WAL (Write-Ahead Log):** `<dbPath>/<collectionName>/wal_<collectionName>.log`
  - This file contains operations performed since the last checkpoint. Each line is a JSON object describing the operation.
- **For easy viewing:**
  - Use the **Data Explorer** web interface (`wisejson-explorer-server`), which provides a GUI for viewing collections and documents. \* Use the CLI utility **`wisejson-explorer show-collection <collectionName>`** or **`wise-json find <collectionName>`**.

### Q4: My application crashes with the error `EMFILE: too many open files`.

**A4:** This operating system error means that your process has opened too many file descriptors. In the case of WiseJSON DB, this can happen if:

1. **`WiseJSON` instances or collections are not closed:** Each instance and collection holds file descriptors for WAL, checkpoints, and locks. If you continually create new `WiseJSON` instances or retrieve collections without closing them (using `db.close()`), the number of open files will grow.

    - **Solution:** Ensure that you use a single `WiseJSON` instance for the lifetime of your application (or properly manage its lifecycle). Call `db.close()` when the instance is no longer needed.

2. **Very frequent operations creating temporary files:** Although WiseJSON DB uses atomic writes to temporary files, with an extremely high frequency of such operations, it is theoretically possible to exhaust the limit if the OS does not keep up with the release of descriptors. However, this is less likely than the first reason.
3. **Other parts of your application also actively access files.**

- **Diagnostics:** Use operating system utilities (e.g., `lsof -p <PID>` on Linux/macOS) to check which files your process has open.

### Q5: How do I back up a WiseJSON DB database?

**A5:** Since WiseJSON DB is a file-based database, a backup can be made by simply copying the entire database directory (`dbPath`).

- **Recommendations:**

1. **Stop the application (or ensure there are no active write operations):** This ensures that all data is consistent and WAL files are not being modified.
2. **Copy the entire `dbPath`** directory to a safe location.

- If stopping the application is not possible, call await db.flushToDisk() for all active collections or await db.close() (if applicable) before copying to minimize the number of WAL operations that missed the last checkpoint. However, copying a live database without stopping writes does not guarantee 100% consistency at the time of copying, although the WAL recovery mechanism usually handles this when restoring from such a backup.

### Q6: What should I do if the WAL file or checkpoint file is corrupted?

**A6:** WiseJSON DB has mechanisms for handling these situations:

- **Corrupted WAL file:**
- When initializing a collection, if parsing a WAL row fails, by default (with `walReadOptions: { recover: false, strict: false }`) this row will be skipped, a warning will be printed to the console, and WiseJSON DB will attempt to continue loading.
- You can set the `walReadOptions: { recover: true }` option when creating a `WiseJSON` instance to more aggressively attempt to recover data, skipping broken rows.
- If the WAL is severely corrupted, you may lose operations performed after the last successful checkpoint. 
* **Corrupted checkpoint file:**
- If the checkpoint metadata file (`checkpoint_meta_...json`) or one of its data segments (`checkpoint_data_..._segX.json`) is corrupted (for example, invalid JSON), WiseJSON DB will attempt to ignore it during loading (with a warning) and load the previous available (uncorrupted) checkpoint, if one exists.
- If the most recent checkpoint is corrupted and there is no previous checkpoint, the collection may be initialized as empty (or with only WAL data, if it was applied to an empty state).
- **Restoring from backup:** If the corruption is severe, the best solution is to restore from the latest backup.

### Q7: Is there a limit on the size of a document or collection?

**A7:**

- **Document Size:** Theoretically, the size of a single JSON document is limited by the available RAM in Node.js (V8) for serialization/deserialization and processing. In practice, very large documents (many megabytes) may be inefficient to store and process. It is recommended to keep document sizes within reasonable limits.
- **Collection Size:** The total size of a collection (the combined size of all its documents and indexes) is limited by available disk space. WiseJSON DB uses sharded checkpoints to efficiently work with large collections, breaking data into smaller files when storing.
- **Number of Documents:** Limited primarily by performance and available resources (memory for storing Maps, disk space). With very large document counts (millions), the performance of operations without indexes or with complex find predicates may decrease.

### Q8: Can WiseJSON DB be used in multiple processes simultaneously?

**A8:** Yes, WiseJSON DB uses the `proper-lockfile` library to ensure security when accessing database files from multiple **different Node.js** processes running on the same machine and accessing the same database directory. This prevents data races and file corruption.

- Each write operation (insert, update, remove, clear, create/delete index, flushToDisk) at the collection level acquires an exclusive lock on the collection directory for the duration of the operation. If another process attempts to write to the same collection, it will wait for the lock to be released.
- Read operations typically do not require such strict locks and can be executed in parallel more efficiently, but they will always read the consistent state committed by the last write operation.

### Q9: How does WiseJSON DB ensure ACID properties for transactions?

**A9:** WiseJSON DB strives for ACID properties as follows:

- **Atomicity:**
- _At the single operation level:_ Each individual operation (insert, update, delete) is atomic due to a write to WAL before modifying the data in memory and the recovery mechanism.
- _At the transaction level (`db.beginTransaction()`):_ All operations within a `txn.commit()` block are written as a single block to the WAL files of all affected collections. If the write of this block to WAL or the subsequent application to memory is aborted, the uncommitted transaction block will not be applied during recovery, ensuring all-or-nothing atomicity for this block.
- **Consistency:**
- Unique indexes help maintain data consistency by preventing duplicates.
- Transactions move the database from one consistent state to another. If a transaction is aborted, the data is rolled back (or unapplied) to the previous consistent state. 
- **Isolation:**
- Operations within a transaction are not visible to other parts of the application (or other transactions) until `commit()` is called. This provides a basic level of isolation (read committed for data outside the transaction).
- WiseJSON DB does not implement complex SQL isolation levels (e.g., serializable). When accessed concurrently by multiple processes, `proper-lockfile` file locks at the collection directory level serialize write operations, providing filesystem-level isolation.
- **Durability:**
- Once a write operation (or transaction commit) successfully completes and the data is written to the WAL (and ultimately to the checkpoint), the data is considered persistent and will survive an application restart or system crash (subject to OS caching).

### Q10: [Checkpoint] WARN (or missing WARN) when deleting old checkpoints: `ENOENT`

When automatically rotating old checkpoints (when only a certain number of the most recent ones are kept, for example, `checkpointsToKeep: 5`), the system attempts to delete checkpoint files that are no longer needed.

- **If you see warnings like `[WARN] [Checkpoint] Failed to delete data/meta checkpoint: ... ENOENT: no such file or directory ...` (in older versions or with specific errors):**
  This means that the checkpoint file the system attempted to delete was no longer on disk. This is typically not a data integrity issue and can occur if the file was deleted manually or a previous cleanup operation was interrupted.

- **In current versions of WiseJSON DB:** The checkpoint cleanup logic has been improved. The `ENOENT` (file not found) error when attempting to delete a missing checkpoint file is no longer logged as a warning (`WARN`)\*\*, as it does not indicate a problem. However, if another error occurs when deleting the file (such as an `EACCES` access denied error), it may still be logged as a warning.

If you have other questions or problems, we recommend checking the project's GitHub Issues for similar situations or creating a new issue with a detailed description of the problem.
