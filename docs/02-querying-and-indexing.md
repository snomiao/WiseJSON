docs/02-querying-and-indexing.md
# 02 - Data Querying and Indexing

This section covers how to retrieve documents from WiseJSON DB collections. We'll cover both basic ID searching and powerful queries using filters, operators, and indexes to speed up operations.

**This section assumes you already have an initialized `WiseJSON` instance and a working collection, as described in the previous sections.**

## Basic Reading Methods

### Getting a document by its ID (`getById`)

This is the fastest and most direct way to retrieve a single document if you know its unique `_id`.

* **Parameters:**
* `id {string}`: The unique `_id` of the document to retrieve.
* **Returns:** `Promise<object | null>` - A promise that resolves to the found document object. If a document with the specified `id` doesn't exist or its TTL has expired, the promise resolves to `null`.

**Example:**

```javascript
const article = await articlesCollection.getById('article-123');
if (article) {
console.log('Article found:', article);
} else {
console.log('Article with ID "article-123" not found.');
}
```

### How to get all documents from a collection (`getAll`)

The `collection.getAll()` method retrieves all "live" (not expired by TTL) documents from the collection.

* **Warning:** Use this method with caution on very large collections, as it loads all documents into memory.
* **Parameters:** None.
* **Returns:** `Promise<Array<object>>` - A promise that resolves to an array of all found documents.

**Example:**

```javascript
const allTasks = await tasksCollection.getAll();
console.log(`${allTasks.length} tasks found.`);
```

## Advanced Queries with `find` and `findOne`

For flexible searching by various criteria, WiseJSON DB provides the `find` and `findOne` methods, which support a powerful query syntax similar to MongoDB.

### Searching for Multiple Documents by Condition (`find`)

The `collection.find(query, projection)` method finds all documents that match a given filter.

* **Parameters:**
* `query {object}`: A filter object describing the search conditions. This is the basic and recommended method.
* `projection {object}` (optional): An object specifying which fields to include or exclude from the resulting documents (see below).
* **Returns:** `Promise<Array<object>>` - A promise that resolves to an array of documents matching the query.

#### Query Syntax

A filter object consists of `field: value` pairs for exact matching or uses special operators for more complex conditions.

**Comparison Operators:**
* `$eq`: equal to (usually omitted, ` { age: 30 } ` is equivalent to ` { age: { $eq: 30 } } `)
* `$ne`: not equal to (`!=`)
* `$gt`: greater than (`>`)
* `$gte`: greater than or equal to (`>=`)
* `$lt`: less than (`<`)
* `$lte`: less than or equal to (`<=`)
* `$in`: the field value is in the specified array
* `$nin`: the field value is not in the specified array

**Logical Operators:**
* `$or`: matches any of the conditions in the array. ` { $or: [ { <condition1> }, { <condition2> } ] } `
* `$and`: matches all conditions in the array. Usually implicit, but useful for complex groupings.

**Element Operators:**
* `$exists`: whether the field exists (`true`) or does not exist (`false`).

**Example 1: Simple Filter**
Find all users from the city 'Moscow'.
```javascript
const moscowUsers = await usersCollection.find({ city: 'Moscow' });
```

**Example 2: Using Comparison Operators**
Find all users over 30 but under 40.
```javascript
const usersInTheir30s = await usersCollection.find({
age: { $gt: 30, $lt: 40 }
});
```

**Example 3: Using the `$in` Operator**
Find products from the 'Electronics' or 'Books' categories.
```javascript
const desiredProducts = await productsCollection.find({
category: { $in: ['Electronics', 'Books'] }
});
```

**Example 4: Complex query with `$or` logic**
Find all active users from New York OR all users with the tag 'vip'.
```javascript
const query = {
$or: [
{ city: 'New York', status: 'active' }, // Condition 1
{ tags: 'vip' } // Condition 2 (for array fields, a simple match works like "contains")
]
};
const results = await usersCollection.find(query);
```

### Find a single document by condition (`findOne`)

Works similar to `find`, but returns only the first document found that satisfies the condition, or `null`. This is more efficient if you only need one result or are checking for the existence of a document.

* **Parameters and Return Value:** Similar to `find`, but returns a `Promise<object | null>`.

**Example:**
Find a single user with the email address 'admin@example.com'.
```javascript
const adminUser = await usersCollection.findOne({ email: 'admin@example.com' });
if (adminUser) {
console.log('Administrator found:', adminUser);
}
```

### Projections: Selecting the Right Fields

Sometimes you don't need all the fields in a document, but only some of them. Projections allow you to specify which fields to include or exclude from the result. This reduces the amount of data transferred and can improve performance.

Projections are passed as the second argument to `find` and `findOne`.
* `{ field: 1 }`: Include the field `field`.
* `{ field: 0 }`: Exclude the field `field`.

**Rules:**
1. You cannot mix inclusion and exclusion modes in a single projection object (except for the special case of excluding `_id`).
2. The `_id` field is included by default. To exclude it, you must explicitly specify `{ _id: 0 }`.

**Example 1: Including Specific Fields**
Get only the names and email addresses of all users, leaving `_id` as the default.
```javascript
const userList = await usersCollection.find({}, { name: 1, email: 1 });
// Result: [{ _id: '...', name: '...', email: '...' }, ...]
```

**Example 2: Including fields but excluding `_id`**

```javascript
const userListNoId = await usersCollection.find({}, { name: 1, email: 1, _id: 0 });
// Result: [{ name: '...', email: '...' }, ...]
```

**Example 3: Excluding fields**
Get all user data except their detailed history and tags. 
```javascript
const usersWithoutHistory = await usersCollection.find({}, { history: 0, tags: 0 });
```

## Speeding Up Search with Indexes

Indexes are special data structures that allow the database to find documents much faster without iterating through the entire collection. WiseJSON DB **automatically uses existing indexes** if a field in the query is indexed and used for exact match search (`{ field: 'value' }`) or with range operators (`$gt`, `$lt`, etc.).

### How to Create an Index (`createIndex`)

The `collection.createIndex(fieldName, options)` method creates an index for the specified field.

* **Parameters:**
* `fieldName {string}`: The name of the field to index.
* `options {object}` (optional):
* `unique {boolean}`: If `true`, the index will be unique. This ensures that no two documents have the same value in this field. Attempting to insert a duplicate will result in an error. Defaults to `false`.

**Example:**
```javascript
// Create a standard (non-unique) index on the 'city' field for fast city searching
await customersCollection.createIndex('city');

// Create a unique index on the 'email' field to ensure that no two users have the same email
await customersCollection.createIndex('email', { unique: true });
```

### Managing Indexes

* **`collection.getIndexes()`**: Returns an array of objects describing all existing indexes in the collection. 
```javascript
const indexes = await customersCollection.getIndexes();
// Sample output: [{ fieldName: 'city', type: 'standard' }, { fieldName: 'email', type: 'unique' }]
console.log('Current indexes:', indexes);
```
* **`collection.dropIndex(fieldName)`**: Removes an index from the specified field.
```javascript
await customersCollection.dropIndex('city');
console.log('The index on the "city" field has been removed.');
```

### Index Search Methods (for Backward Compatibility)

While the modern `find` method automatically uses indexes, the following methods are retained for backward compatibility and, in some cases, for explicitly specifying index searches. They may be less flexible than `find`.

* **`collection.findByIndexedValue(fieldName, value)`**: Finds all documents with the exact value `value` in the indexed field `fieldName`. This is equivalent to `find({ [fieldName]: value })`.
* **`collection.findOneByIndexedValue(fieldName, value)`**: Finds a single document. This is equivalent to `findOne({ [fieldName]: value })`.

**Example:**
```javascript
// These two calls will produce the same result, but `find` is more versatile.
const usersFromSpb_legacy = await usersCollection.findByIndexedValue('city', 'Saint Petersburg');
const usersFromSpb_modern = await usersCollection.find({ city: 'Saint Petersburg' });
```
