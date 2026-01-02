# 05 - Common Scenarios and Cheat Sheet

This section contains ready-made code examples for solving typical problems using WiseJSON DB, as well as a short and up-to-date cheat sheet for basic operations. These scenarios will help you quickly integrate the database into your projects.

## Scenario 1: User Profile Storage

**Task:** Create a simple storage for user profiles with a unique email address, the ability to search, add, and update information.

```javascript
const WiseJSON = require('wise-json-db');
const path = require('path');

async function userProfileManagement() {
const dbPath = path.resolve(__dirname, 'userProfilesDb');
let db;

try {
db = new WiseJSON(dbPath);
await db.init();
console.log('The profiles database has been initialized.');

const profiles = await db.getCollection('profiles');
await profiles.clear(); // Let's clear it for clarity.

// Create a unique index by email for quick search and to prevent duplicates.
await profiles.createIndex('email', { unique: true });
console.log('A unique index by "email" has been created.');

// Adding new profiles
await profiles.insertMany([
{ name: 'Elena Smirnova', email: 'elena@example.com', age: 28, city: 'Moscow' },
{ name: 'Alexey Ivanov', email: 'alex@example.com', age: 34, city: 'Saint Petersburg' }
]);
console.log('Profiles added.');

// Attempting to add a user with an existing email (will raise an error)
try {
await profiles.insert({ name: 'Another Elena', email: 'elena@example.com', age: 30 });
} catch (e) {
console.log(`\nExpected error: ${e.message}`); // Report a uniqueness violation
}

// Search for a profile by email (automatically uses the index)
console.log('\n Searching for Alexey's profile by email...');
const foundAlex = await profiles.findOne({ email: 'alex@example.com' });
if (foundAlex) {
console.log('Found profile:', foundAlex);

// Updating Alexey's profile information
console.log('\nUpdating Alexey's age and city...');
const updatedAlex = await profiles.update(foundAlex._id, { age: 35, city: 'Novosibirsk' });
console.log('Updated Alexey's profile:', updatedAlex);
}

// Get all profiles
console.log('\nAll profiles in the database:');
const allProfiles = await profiles.getAll();
allProfiles.forEach(p => console.log(`- ${p.name}, email: ${p.email}, age: ${p.age}`));

} catch (error) {
console.error('Error in profile management script:', error);
} finally {
if (db) await db.close();
}
}

userProfileManagement();
```

## Scenario 2: Logging Events with Auto-Delete (TTL)

**Task:** Write application events to a log collection. Old or temporary logs should be automatically deleted after a specified time.

```javascript
const WiseJSON = require('wise-json-db');
const path = require('path');

async function eventLoggingWithTTL() {
  const dbPath = path.resolve(__dirname, 'eventLogsDb');
  // Set up frequent TTL checking for the demo (every 3 seconds)
  const db = new WiseJSON(dbPath, { ttlCleanupIntervalMs: 3000 });
  await db.init();

  const eventLogs = await db.collection('event_logs');
  await eventLogs.initPromise;
  await eventLogs.clear();

  console.log('Logging events...');
  await eventLogs.insert({
    level: 'INFO',
    message: 'The application has started.',
    ttl: 7 * 24 * 60 * 60 * 1000, // This log will live for 7 days
  });
  await eventLogs.insert({
    level: 'DEBUG',
    message: 'Debug message, will disappear in 5 seconds.',
    ttl: 5000, // 5 seconds
  });

  console.log(`Current number of logs: ${await eventLogs.count()}`); // Waiting for 2

  console.log('Waiting for 6 seconds for the debug log to expire...');
  await new Promise((resolve) => setTimeout(resolve, 6000));

  // TTL clearing will occur either on a timer or on the next read (e.g., count).
  const countAfterTTL = await eventLogs.count();
  console.log(`Number of logs after wait: ${countAfterTTL}`); // Waiting for 1

  await db.close();
}

eventLoggingWithTTL();
```

## Scenario 3: Atomic Registration (Transaction)

**Task:** When registering a new user, we need to create a record about them in the `users` collection and simultaneously create a record about their initial balance in the `balances` collection. Both operations must either succeed or fail.

```javascript
const WiseJSON = require('wise-json-db');
const path = require('path');
const { v4: uuidv4 } = require('uuid'); // To generate an ID

async function userRegistrationWithBalance() {
  const dbPath = path.resolve(__dirname, 'registrationDb');
  const db = new WiseJSON(dbPath);
  await db.init();

  const users = await db.collection('users_reg');
  await users.initPromise;
  const balances = await db.collection('balances_reg');
  await balances.initPromise;
  await users.clear();
  await balances.clear();

  // Generate the user ID in advance, as it is needed for both operations
  const newUserId = uuidv4();

  const txn = db.beginTransaction();
  console.log(`\nBeginning a transaction to register user ${newUserId}...`);

  try {
    const txnUsers = txn.collection('users_reg');
    const txnBalances = txn.collection('balances_reg');

    // Operation 1: Create a user
    await txnUsers.insert({
      _id: newUserId,
      name: 'New User',
      email: 'newuser@example.com',
    });

    // Operation 2: Creating the initial balance
    await txnBalances.insert({
      userId: newUserId,
      currency: 'RUB',
      amount: 0,
    });

    console.log('Applying the transaction (commit)...');
    await txn.commit();
    console.log('The registration transaction was successfully applied.');
  } catch (transactionError) {
    console.error('Transaction error, rolling back:', transactionError.message);
    await txn.rollback();
  }

  // Check that both records were created
  const registeredUser = await users.getById(newUserId);
  const userBalance = await balances.findOne({ userId: newUserId });
  console.log('User created:', !!registeredUser);
  console.log('Balance created:', !!userBalance);

  await db.close();
}

userRegistrationWithBalance();
```

## Cheatsheet for Basic Operations

| Task                                     | API Method / Code Example                                                         |
| :--------------------------------------- | :-------------------------------------------------------------------------------- |
| **Initialization**                       |                                                                                   |
| Include the library                      | `const WiseJSON = require('wise-json-db');`                                       |
| Create and initialize the DB             | `const db = new WiseJSON('path/to/db'); await db.init();`                         |
| Get/create and initialize the collection | `const col = await db.collection('name'); await col.initPromise;`                 |
| Close the DB (save everything)           | `await db.close();`                                                               |
| **Documents - Create**                   |                                                                                   |
| Insert a single document                 | `await col.insert({ name: 'A', value: 1 });`                                      |
| Insert an array of documents             | `await col.insertMany([{ name: 'B' }, { name: 'C' }]);`                           |
| Insert a document with a TTL (1 hour)    | `await col.insert({ data: 'temp', ttl: 3600000 });`                               |
| **Documents - Read**                     |                                                                                   |
| Get a document by ID                     | `const doc = await col.getById('someId123');`                                     |
| Get all documents                        | `const allDocs = await col.getAll();`                                             |
| Find documents by condition              | `await col.find({ age: { $gt: 30 }, status: 'active' });`                         |
| Find one document by condition           | `await col.findOne({ email: 'a@b.c' });`                                          |
| Count the number of documents            | `const count = await col.count();`                                                |
| **Documents - Update**                   |                                                                                   |
| Update a document by ID (partially)      | `await col.update('id123', { status: 'completed', score: 100 });`                 |
| Update one by filter (with operators)    | `await col.updateOne({ status: 'pending' }, { $set: { status: 'processing' } });` |
| Update multiple by filter                | `await col.updateMany({ category: 'X' }, { $set: { processed: true } });`         |
| Find and update (return new)             | `await col.findOneAndUpdate({ status: 'new' }, { $set: { status: 'claimed' } });` |
| **Documents - Delete**                   |                                                                                   |
| Delete document by ID                    | `await col.remove('id456');`                                                      |
| Delete one by filter                     | `await col.deleteOne({ status: 'archived' });`                                    |
| Delete multiple by filter                | `await col.deleteMany({ timestamp: { $lt: Date.now() - 86400000 } });`            |
| Clear the entire collection              | `await col.clear();`                                                              |

| **Indexes**
