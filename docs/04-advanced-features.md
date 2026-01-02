# 04 - Advanced Features and Configuration

This section covers advanced WiseJSON DB features that allow you to fine-tune database behavior, manage data via the command line (CLI), and perform import/export operations.

## Configuring a WiseJSON Instance

When creating a new WiseJSON instance, you can pass a second argument—an object with configuration options—to tailor the database to your application's needs.

**Syntax:**
`const db = new WiseJSON(dbPath, options);`

### Main available options:

* **`ttlCleanupIntervalMs {number}`**
* **Description:** The interval in milliseconds at which the database will automatically check and delete documents with expired TTL.
* **Default:** `60000` (1 minute).
* **Example:** `3600000` to check once per hour.

* **`checkpointIntervalMs {number}`**
* **Description:** The interval in milliseconds for automatically creating checkpoints (data snapshots). Checkpoints speed up startup and recovery.
* **Default:** `300000` (5 minutes).
* **Example:** `0` to disable timer-based checkpoint creation.

* **`maxWalEntriesBeforeCheckpoint {number}`**
* **Description:** The maximum number of write-ahead log (WAL) entries after which a checkpoint creation process will be forced, regardless of the timer.
* **Default:** `1000`.

* **`checkpointsToKeep {number}`**
* **Description:** The number of recent checkpoints to keep on disk. Older ones will be automatically deleted to save space.
* **Default:** `5`.
* **Minimum value:** `1`.

* **`idGenerator {function}`**
* **Description:** A user-defined function for generating `_id` for documents if `_id` is not provided during insertion. Should return a unique string.
* **Default:** A function that generates `uuid v4`.
* **Example:** ``() => doc-${Date.now()}``

* **`walReadOptions {object}`**
* **Description:** Options for processing WAL files at startup, especially if they are corrupted. * **Default:** `{ recover: false, strict: false }`. In this mode, corrupted WAL lines are skipped and a warning is issued.
  * **Options:**
    * `recover: true`: Aggressively attempt to recover data, skipping corrupted WAL lines.
    * `strict: true`: Raise an error at the first WAL line parsing error, stopping initialization.

**Example of using options:**

```javascript
const { v4: uuidv4 } = require('uuid');

const dbOptions = {
checkpointIntervalMs: 10 * 60 * 1000, // Checkpoint every 10 minutes
checkpointsToKeep: 3, // Keep the last 3 checkpoints
idGenerator: () => `user-${uuidv4()}`, // Custom ID
walReadOptions: { recover: true } // Attempt to recover from corrupted WAL
};

const db = new WiseJSON('/path/to/my-app-db', dbOptions);
```

## Data Import and Export (via API)

You can easily transfer data to and from collections using built-in methods.

* **`collection.exportJson(filePath)`**: Saves all "live" documents of a collection to the specified file in JSON format (an array of objects).
```javascript
await usersCollection.exportJson('./backups/users_backup.json');
```
* **`collection.exportCsv(filePath, options)`**: Saves data in CSV format. Separators and headers can be customized.
```javascript
await usersCollection.exportCsv('./backups/users_backup.csv');
```
* **`collection.importJson(filePath, options)`**: Imports documents from a JSON file.
  * `options.mode`:
    * `'append'` (default): Appends documents from a file to existing ones in the collection.
    * `'replace'`: **Completely clears** the collection before importing documents from a file. 

```javascript
// Add new users from a file
await usersCollection.importJson('./new_users.json');

// Completely replace the data in the collection
await productsCollection.importJson('./full_product_list.json', { mode: 'replace' });
```

## Command Line Interface (CLI)

WiseJSON DB includes a powerful command-line tool, `wisejson-explorer`, for database administration without writing code.

**Important:**
* **DB Path:** Specify the path to your database using the `WISE_JSON_PATH` environment variable.
* **Write Permission:** To execute commands that modify data (`import`, `create-index`, `doc-remove`, etc.), you must use the `--allow-write` global flag.

**Example Commands:**

### Commands for reading and analyzing data

* **`list-collections`**: Show all collections and the number of documents in them.
```bash
wisejson-explorer list-collections
```
* **`show-collection <collectionName>`**: Show documents in a collection with filtering, sorting, and pagination.
```bash
# Show the first 5 documents from 'users', sorted by age (descending)
wisejson-explorer show-collection users --limit 5 --sort age --order desc

# Find users over 30 using a JSON filter
wisejson-explorer show-collection users --filter '{"age":{"$gt":30}}'
```
* **`get-document <collectionName> <documentId>`**: Get a single document by its `_id`.
* **`list-indexes <collectionName>`**: Show a list of indexes for a collection.
* **`export-collection <collectionName> <filename>`**: Export a collection to a file (JSON by default, CSV via option).
```bash
wisejson-explorer export-collection users users_backup.csv --output csv
```

### Commands for data management (require `--allow-write`)

* **`doc-insert <collectionName> '<json_string>'`**: Insert a single new document. The JSON string must be enclosed in quotes.
* **`doc-remove <collectionName> <documentId>`**: Delete a document by `_id`.
* **`import-collection <collectionName> <filename>`**: Import documents from a JSON file.
* **`create-index <collectionName> <fieldName>`**: Create an index.
* **`drop-index <collectionName> <fieldName>`**: Delete an index.

## Data Explorer (Web Interface)

For visual viewing and management of your data, you can launch the built-in web interface. It has powerful features, including an interactive data schema map and a visual query builder.

### Starting the Server

Start the server with one of the following commands from the root of your project:
```bash
# If wisejson-explorer is installed globally or as a dependency
wisejson-explorer-server

# Or directly via Node.js
node explorer/server.js
```
By default, the interface will be accessible at **http://127.0.0.1:3000**. You can change the port using the `PORT` environment variable.

### Operation Modes

Data Explorer can operate in two modes to ensure the security of your data.

#### 1. Read-Only Mode — Default

This is the most secure mode and is used by default. In it, you can:
* View an interactive map of the data schema.
* View a list of collections and their contents.
* Use a powerful visual designer to filter data.
* Sort and view documents page by page.
* View a list of existing indexes.

In this mode, it is **impossible** to modify or delete any data.

#### 2. Write-Enabled Mode

To perform operations that modify data (deleting documents, creating and deleting indexes), you must start the server with the special environment variable 'WISEJSON_EXPLORER_ALLOW_WRITE=true'.

**Caution:** Use this mode with caution, as changes made through the interface are irreversible.

**How ​​to run in write mode:**

* **For Linux or macOS:**
```bash
WISEJSON_EXPLORER_ALLOW_WRITE=true node explorer/server.js
```
* **For Windows (in the CMD terminal):**
```bash
set "WISEJSON_EXPLORER_ALLOW_WRITE=true" && node explorer/server.js
```
* **For Windows (in PowerShell):**
```powershell
$env:WISEJSON_EXPLORER_ALLOW_WRITE="true"; node explorer/server.js
```

When this mode is active, additional controls will appear in the interface:
* **"Delete"** buttons for deleting documents in the table.
* A form for **creating new indexes**.
* Use the **"×"** buttons to **delete existing indexes**.

### Access Protection

To password-protect your Data Explorer, use the `WISEJSON_AUTH_USER` and `WISEJSON_AUTH_PASS` environment variables when starting the server:
```bash
WISEJSON_AUTH_USER=admin WISEJSON_AUTH_PASS=mySuperSecretPassword node explorer/server.js
