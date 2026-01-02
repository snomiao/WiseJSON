# 00 - Introduction and Configuration

Welcome to WiseJSON DB—a fast, reliable, and easy-to-use embeddable JSON database for Node.js. It's designed for high performance and data durability thanks to logging (WAL), checkpoints, atomic transactions, and index support.

This document will help you get started quickly with WiseJSON DB.

## Key Concepts

* **Database:** Physical storage on disk, represented by a single directory. Contains one or more collections.
* **Collection:** Analogous to a table in SQL or a collection in MongoDB. It's a named group of JSON documents.
* **Document:** A single record in a collection, represented by a JavaScript object. Each document has a unique _id field.

## Installation

Install the package using npm or yarn:

```bash
npm install wise-json-db
# or
yarn add wise-json-db
```
This will install the `wise-json-db` package and all required dependencies (`uuid`, `proper-lockfile`).

## Quick Start

This example shows the full workflow: initialization, creation, reading, updating, and deleting data.

```javascript
// Include the library
const WiseJSON = require('wise-json-db');
const path = require('path');

async function main() {
// 1. Specify the path where the database will be stored.
const dbPath = path.resolve(__dirname, 'myAppData');

// 2. Create or open a DB instance and wait for it to initialize.
const db = new WiseJSON(dbPath);
await db.init();

// 3. Get (or create) the 'users' collection and wait for it to be ready.
const users = await db.collection('users');
await users.initPromise;

// To keep the example clean, we'll clear the collection before starting.
await users.clear();

// 4. Insert documents.
await users.insert({ name: 'Alice', age: 30, city: 'New York' });
await users.insertMany([
{ name: 'Bob', age: 25, city: 'London' },
{ name: 'Charlie', age: 35, city: 'New York' }
]);
console.log(`After inserting a document into the collection, ${await users.count()}.`);

// 5. Search documents
const userBob = await users.findOne({ name: 'Bob' });
console.log('Found Bob:', userBob);

const usersFromNY = await users.find({ city: 'New York' });
console.log(`Users from New York: ${usersFromNY.length}`);

// 6. Update the document
if (userBob) {
await users.update(userBob._id, { age: 26, status: 'active' });
const updatedBob = await users.getById(userBob._id);
console.log('Updated Bob:', updatedBob);
}

// 7. Delete the document
const charlie = await users.findOne({ name: 'Charlie' });
if (charlie) {
await users.remove(charlie._id);
console.log(`User Charlie has been removed. Documents remaining: ${await users.count()}`);
}

// 8. Be sure to close the database to save all changes.
await db.close();
console.log('The database has been closed.');
}

main().catch(console.error);
```

## Public API Structure

The main export of the `wise-json-db` package provides access to key classes and functions:

```javascript
const {
WiseJSON, // Main database class
Collection, // Collection class (for type hinting or extensions)
SyncManager, // Sync manager (for advanced scenarios)
// and other utilities...
} = require('wise-json-db');
```

### `new WiseJSON(dbPath, [options])`

Constructor for creating a DB instance.

* `dbPath {string}`: Path to the database root directory.
* `options {CollectionOptions}` (optional): Object for fine-tuning.

### `db` Instance Methods

* **`await db.init(): Promise<void>`**: Asynchronously initializes the database. **Must be called** after creating the instance.
* **`await db.collection(name): Promise<Collection>`**: Returns a collection instance. Don't forget to await `collection.initPromise`.
* **`await db.close(): Promise<void>`**: Gracefully closes the database, saving all unsaved data and releasing locks. **Must be called** before application termination.
* **`db.beginTransaction(): TransactionManager`**: Begins a new transaction.

### Main Collection Methods

| Method | Description |
| ------------------------------ | -------------------------------------------------------------------------- |
| `await collection.insert(doc)` | Insert a single document. |
| `await collection.insertMany(docs)`| Insert an array of documents. |
| `await collection.find(filter)` | Find all documents matching the filter (query object). |
| `await collection.findOne(filter)` | Find the first document matching the filter. |
| `await collection.update(id, data)`| Partially update a document by its `_id`. |
| `await collection.updateMany(filter, update)`| Update all documents by filter (using the `$set`, `$inc` operators). |
| `await collection.remove(id)` | Delete a document by its `_id`. |
| `await collection.deleteMany(filter)` | Delete all documents matching the filter. |
| `await collection.count()` | Count the number of documents in the collection. |
| `await collection.clear()` | Delete all documents from the collection. |

> **Note:** `filter` for `find`, `findOne`, and `deleteMany` is an object describing the search conditions, similar to MongoDB (e.g., `{ age: { $gt: 25 } }`).

## Next Steps

Now that you're familiar with the basics, you can move on to more detailed learning:

* **[01 - Working with Collections and Documents](01-collections-and-documents.md)**
* **[02 - Data Querying and Indexing](02-querying-and-indexing.md)**
* **[03 - Working with Transactions](03-transactions.md)**
* **[04 - Advanced Features and Configuration](04-advanced-features.md)**
