# 07 - Advanced Data Synchronization (WiseJSON Sync)

WiseJSON DB offers a powerful and reliable bidirectional data synchronization system between a local database and a remote server. This system is designed with fault tolerance, predictability, and developer transparency in mind.

## Key Principles and Features

* **PULL -> PUSH Model**: To reduce conflicts, the client first requests and applies changes from the server (`PULL`), and only then sends its local changes (`PUSH`).
* **Tokenization (LSN)**: Instead of unreliable client timestamps, synchronization uses the server's **LSN** (Log Sequence Number)—a monotonically increasing number representing the last operation. This ensures that the client receives all changes and doesn't miss anything, regardless of the time settings. 
* **PUSH Idempotency**: Each batch of local changes is sent with a unique ID (`batchId`). The server tracks received IDs and ignores duplicates, preventing data reapplication during network failures.
* **Batching**: Large numbers of local changes are automatically split into small batches for sending, preventing errors associated with large request bodies.
* **Adaptive Interval**: `SyncManager` automatically adjusts the synchronization frequency. During periods of inactivity, the interval increases, and during periods of activity, it decreases, reducing network load.
* **Quarantine Mechanism**: If a failed operation is received from the server that cannot be applied (for example, due to a unique index violation), it does not stop the entire synchronization, but is instead placed in a special log file `quarantine_<collection>.log` for later analysis. 
* **Heartbeat**: To ensure the connection remains active during periods of inactivity, `SyncManager` periodically sends lightweight health checks to the server.
* **Transparent error handling**: All synchronization errors (network or server) do not crash the application, but generate a `sync:error` event, which you can subscribe to.

## How to use

### Step 1: Connection and configuration

You can enable synchronization for a collection using the `collection.enableSync()` method.

```javascript
const WiseJSON = require('wise-json-db');
// Important: apiClient is imported from the root module, not from wise-json/sync
const { apiClient: ApiClient } = require('wise-json-db');
const path = require('path');

async function setupSync() {
// 1. Initialize the database and collection
const db = new WiseJSON(path.resolve(__dirname, 'my-sync-db'));
await db.init();
const articles = await db.collection('articles');
await articles.initPromise;

// 2. Create an API client instance
const apiClientInstance = new ApiClient(
'https://api.example.com', // Your server's base URL
'YOUR-SECRET-API-KEY' // Your API key
);

// 3. Enable synchronization by passing the client and other options
articles.enableSync({
apiClient: apiClientInstance,
// These parameters are required for internal validation, even if apiClient is passed
url: 'https://api.example.com',
apiKey: 'YOUR-SECRET-API-KEY',

// Optional parameters for fine-tuning
minSyncIntervalMs: 10000, // min. interval (10 sec)
maxSyncIntervalMs: 300000, // max. interval (5 min)
pushBatchSize: 200, // send 200 operations at a time
});
}
```

### Step 2: Handling Sync Events

This is the most important step in building a reliable application. Subscribe to events to understand what's happening with synchronization.

```javascript
// Subscribe to events BEFORE actively working with the collection

// Successful completion of the full PULL -> PUSH cycle
articles.on('sync:success', (payload) => {
console.log(`[SYNC] Cycle completed. Activity: ${payload.activityDetected}. Server LSN: ${payload.lsn}`);
});

// Critical error in the sync cycle
articles.on('sync:error', (errorPayload) => {
console.error(`[SYNC ERROR] ${errorPayload.message}`, errorPayload.originalError);
// Here you can display a notification to the user or log it to the monitoring system
});

// The operation from the server has been quarantined
articles.on('sync:quarantine', (quarantinePayload) => {
console.warn('[SYNC QUARANTINE] Failed to apply operation:', quarantinePayload.operation);
console.warn('Reason:', quarantinePayload.error.message);
});

// Other useful debugging events:
articles.on('sync:initial_start', () => console.log('[SYNC] Initial full sync...'));
articles.on('sync:initial_complete', (p) => console.log(`[SYNC] Initial sync complete. Loaded: ${p.documentsLoaded} doc.`));
articles.on('sync:push_success', (p) => console.log(`[SYNC] Successfully sent batch ${p.batchId} (${p.pushed} operations).`));
articles.on('sync:pull_success', (p) => console.log(`[SYNC] Received ${p.pulled} operations from the server.`));
```
### Step 3: Working with Data and Manual Management

After enabling sync, simply work with the collection as usual. All changes (insert, update, remove) will be automatically queued for submission.

```javascript
// This change will be automatically submitted to the server in the next sync cycle
await articles.insert({ title: 'New article', content: '...' });

// You can force a sync cycle at any time
await articles.triggerSync();

// Get the current sync status
const status = articles.getSyncStatus();
console.log(status); // { state: 'idle', isSyncing: false, ... }

// Disable sync (e.g., when the user logs out)
articles.disableSync();
```
## Server API Requirements

For WiseJSON Sync to work correctly, your backend must implement the following endpoints:

### GET /sync/snapshot

* **Purpose:** For the initial full sync.
* **Response:**
```json
{
"server_lsn": 12345,
"documents": [
{ "_id": "...", "title": "...", "createdAt": "...", "updatedAt": "..." },
// ...
]
}
```

### GET /sync/pull?since_lsn=\<number>

* **Purpose:** Get the delta (new operations) from the server.
* **Parameter:** `since_lsn` is the latest LSN known to the client. The server should return all operations with LSN > `since_lsn`.
* **Response:**
```json
{
"server_lsn": 12350,
"ops": [
{ "op": "INSERT", "doc": { "_id": "doc1", "data": "..." } },
{ "op": "UPDATE", "id": "doc2", "data": { "status": "done" } }
]
}
```

### POST /sync/push

* **Purpose:** Receive a batch of operations from the client.
* **Request Body:**
```json
{
"batchId": "unique-batch-id-uuid",
"ops": [ /* array of operations from client WAL */ ]
}
```
* **Logic:** The server **MUST** check `batchId` for uniqueness. If a batch with this ID has already been processed, the server should return a successful response but not retry the operations (idempotence).
* **Response:**
```json
{
"status": "ok",
"server_lsn": 12355
}
```
### GET /sync/health

* **Purpose:** Check server availability.
* **Response:**
```json
{
"status": "ok"
}
```

With this advanced synchronization system, you can create reliable offline applications or distributed systems with a central server, confident in the integrity and security of your data.
