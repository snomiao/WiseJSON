# 01 - Working with Collections and Documents

This section covers in detail the basic data management operations (CRUD - Create, Read, Update, Delete) in WiseJSON DB collections, as well as setting the time-to-live (TTL) for documents.

**This section assumes you already have an initialized `db` instance and have obtained a `collection` instance, as described in `00-introduction-and-setup.md`.**

## Adding Documents (Create)

### How to insert a single document (`insert`)

The `collection.insert(document)` method is used to add a single new document to a collection.

* **Parameters:**
* `document {object}`: The JavaScript object you want to save.
* If you provide an `_id` field in the `document` object, it will be used as a unique identifier.
* If the _id field is not provided, WiseJSON DB will automatically generate a unique _id (according to the idGenerator option).
* **Returns:** `Promise<object>` - A promise that resolves to the inserted document object. This object will contain the fields `_id`, `createdAt` (creation time in ISO string format), and `updatedAt` (last updated time, initially the same as `createdAt`).
* **Errors:** May throw an error if, for example, the index is not unique.

**Example:**

```javascript
// Add a new document with an auto-ID
const newUser = await usersCollection.insert({
name: 'Alice Wonder',
email: 'alice@example.com',
age: 30
});
console.log('Added user:', newUser);
// Sample output newUser:
// {
// name: 'Alice Wonder',
// email: 'alice@example.com',
// age: 30,
// _id: 'generated_id',
// createdAt: '2023-10-27T10:00:00.000Z',
// updatedAt: '2023-10-27T10:00:00.000Z'
// }

// Add a document with a predefined _id
const specificUser = await usersCollection.insert({
_id: 'user123',
name: 'Bob The Builder',
role: 'admin'
});
console.log('Added user with specific ID:', specificUser);
```

### How to add multiple documents at once (`insertMany`)

The `collection.insertMany(documentsArray)` method allows you to efficiently add an array of documents in a single operation.

* **Parameters:**
* `documentsArray {Array<object>}`: An array of JavaScript objects to insert.
* **Returns:** `Promise<Array<object>>` - A promise that resolves to an array of inserted documents, each containing `_id`, `createdAt`, and `updatedAt`.
* **Error Handling:** If an error occurs during processing (such as a unique index violation), the operation is aborted and an error is thrown. Documents before the problematic one may already have been inserted.

**Example:**

```javascript
const newProducts = [
{ name: 'Laptop', category: 'Electronics', price: 1200 },
{ name: 'Smartphone', category: 'Electronics', price: 800 },
{ _id: 'book-451', name: 'Fahrenheit 451', category: 'Books', price: 15 }
];

const insertedProducts = await productsCollection.insertMany(newProducts);
console.log(`Successfully added ${insertedProducts.length} products.`);
```

### How to add a document with a limited time to live (TTL)

WiseJSON DB allows you to set a time to live for documents, after which they will be automatically deleted. This is done using the `ttl` or `expireAt` fields in the document itself.

* **`ttl {number}`**: The document's lifetime in milliseconds since its creation (the `createdAt` field).
* **`expireAt {number | string}`**: The exact time (Unix timestamp in milliseconds or an ISO 8601 string) when the document should expire and be deleted.

If both fields are specified, `expireAt` takes precedence. Expired documents are purged periodically.

**Example:**

```javascript
// A document that will "die" 10 seconds after creation
await tempCollection.insert({
message: 'This message will disappear in 10 seconds.',
ttl: 10000 // 10 seconds
});

// A document that will expire at a certain time
await tempCollection.insert({
data: 'Information valid for 1 minute.',
expireAt: Date.now() + 60000 // After 60 seconds
});
```

## Reading Documents (Read)

A description of read operations (`getById`, `find`, `findOne`) using powerful filters and indexes is in the following section: **`02-querying-and-indexing.md`**.

## Updating Documents (Update)

WiseJSON DB offers several methods for updating documents.

**Example:**

```javascript
const userToUpdate = await usersCollection.findOne({ email: 'alice@example.com' });
if (userToUpdate) {
const updatedUser = await usersCollection.update(userToUpdate._id, {
age: 31,
status: 'active' // Add a new field
});
console.log('User after update:', updatedUser);
}
```

### Advanced updating with filters and operators

For more complex updates, methods that accept a **filter** for searching documents and **update operators**, similar to MongoDB, are used.

**Basic update operators:**
* `$set`: Sets the value of a field.
* `$inc`: Increments (or decrements) a numeric field. 
* `$unset`: Removes a field from a document.
* `$push`: Adds an element to an array.

#### Updating a single document by filter (`updateOne`)

The `collection.updateOne(filter, update)` method finds the **first** document matching `filter` and applies the changes described in `update` to it.

* **Parameters:**
* `filter {object}`: The filter object to search for (syntax as in `find`).
* `update {object}`: An object with update operators.
* **Returns:** `Promise<{ matchedCount: number, modifiedCount: number }>`
* `matchedCount`: The number of found documents (0 or 1).
* `modifiedCount`: The number of actually modified documents (0 or 1).

**Example:**

```javascript
// Increase user 'Alice''s age by 1 and set her new status
const filter = { email: 'alice@example.com' };
const update = {
$inc: { age: 1 },
$set: { lastSeen: new Date().toISOString() }
};

const result = await usersCollection.updateOne(filter, update);
console.log(`Found to update: ${result.matchedCount}, modified: ${result.modifiedCount}`);
```

#### Updating multiple documents by filter (`updateMany`)

The `collection.updateMany(filter, update)` method applies changes to **all** documents that match `filter`.

* **Parameters:** Similar to `updateOne`.
* **Returns:** `Promise<{ matchedCount: number, modifiedCount: number }>`

**Example:**

```javascript
// Give a 10% discount on all books in stock
const filter = { category: 'Books', stock: { $gt: 0 } };
const update = { $set: { onSale: true, discount: 0.1 } };

const result = await productsCollection.updateMany(filter, update);
console.log(`Products found for discount: ${result.matchedCount}, updated: ${result.modifiedCount}`);
```

#### Find and update atomically (`findOneAndUpdate`)

This method finds a single document, updates it, and returns it. Ideal for scenarios where you need to retrieve a document in its old or new state immediately after a change (e.g., for counters).

* **Parameters:**
* `filter {object}`: Filter to search for.
* `update {object}`: Object with update operators.
* `options.returnOriginal {boolean}`: If `false` (default), returns the document **after** the update. If `true`, returns the document **before** the update.
* **Returns:** `Promise<object | null>` - The document (before or after the update) or `null` if nothing was found.

**Example:**

```javascript
// Reserve one item and return its state *before* the reservation
const filter = { name: 'Laptop', stock: { $gt: 0 } };
const update = { $inc: { stock: -1 } };
const options = { returnOriginal: true };

const originalProductState = await productsCollection.findOneAndUpdate(filter, update, options);

if (originalProductState) {
console.log(`Product successfully reserved. Stock balance was: ${originalProductState.stock}`);
}
```

## Deleting Documents (Delete)

### How to delete a single document by ID (`remove`)

The `collection.remove(id)` method deletes a single document from the collection by its `_id`.

* **Parameters:**
* `id {string}`: The unique `_id` of the document to delete.
* **Returns:** `Promise<boolean>` - `true` if the document was found and removed, otherwise `false`.

**Example:**

```javascript
const wasRemoved = await itemsCollection.remove('some-item-id');
console.log(`The document was removed: ${wasRemoved}`);
```

### Advanced deletion with filters

#### Deleting a single document by filter (`deleteOne`)

The `collection.deleteOne(filter)` method deletes the **first** document matching `filter`.

* **Parameters:**
* `filter {object}`: Filter for finding the document to delete.
* **Returns:** `Promise<{ deletedCount: number }>` - An object where `deletedCount` is 0 or 1.

**Example:**

```javascript
// Delete one inactive log
const result = await logsCollection.deleteOne({ level: 'debug', processed: true });
console.log(`Logs deleted: ${result.deletedCount}`);
```

#### Deleting multiple documents by filter (`deleteMany`)

The `collection.deleteMany(filter)` method deletes **all** documents matching `filter`.

* **Parameters:**
* `filter {object}`: Filter for finding documents to delete.
* **Returns:** `Promise<{ deletedCount: number }>` - An object with the number of deleted documents.

**Example:**

```javascript
// Delete all expired user sessions
const filter = {
userId: 'user-123',
expiresAt: { $lt: new Date().toISOString() }
};

const result = await sessionsCollection.deleteMany(filter);
console.log(`Expired sessions deleted: ${result.deletedCount}`);
```

### How to clear all documents from a collection

The `collection.clear()` method removes **all** documents from the collection. Use with caution.

* **Parameters:** None.
* **Returns:** `Promise<boolean>` - A promise that resolves to `true` upon successful clearing.

**Example:**

```javascript
const clearResult = await logsCollection.clear();
console.log(`Result of clearing the collection: ${clearResult}`);
```

## Counting Documents (`count`)

The `collection.count()` method returns the number of live (not expired by TTL) documents in the collection.

* **Parameters:** None.
* **Returns:** `Promise<number>` - A promise that resolves to a number of documents.

**Example:**

```javascript
const totalUsers = await usersCollection.count();
console.log(`Total users in the system: ${totalUsers}`);
```
In the next section, we'll take a detailed look at how to effectively search and filter documents using `find`, `findOne`, and indexes.
