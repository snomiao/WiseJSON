# 03 - Working with Transactions

Transactions in WiseJSON DB allow you to group multiple write operations (such as inserts, updates, and deletes) into a single atomic unit. This ensures that either all operations in a transaction are successfully executed and their changes are saved, or, if an error occurs at any stage before commit, none of the operations are applied, and the database remains in the state before the transaction began.

Transactions ensure data consistency when performing complex, multi-step changes and can affect one or more collections within a single database instance.

**This section assumes you already have an initialized WiseJSON instance (the db variable), as described in section 00-introduction-and-setup.md.**

## When to Use Transactions?

Transactions are indispensable in the following cases:

- **Atomicity of Multiple Operations**: When you need multiple related data changes to occur on an all-or-nothing basis. A classic example is transferring funds between accounts: a debit from one account and a credit to another must either both occur, or both must be reversed.
- **Data Consistency During Complex Updates**: If you're updating multiple logically related documents (possibly in different collections), a transaction will prevent a situation where some data is updated and some is not, due to an error mid-process.
- **Isolation**: Operations within a transaction are not visible to other parts of the application until the commit() call. This provides a basic level of isolation and prevents reading "dirty" or incomplete data.

## How to Work with Transactions

Working with transactions involves four main steps:

### Step 1: Beginning a Transaction

To begin a transaction, call the `db.beginTransaction()` method. This method returns a transaction object (TransactionManager), through which you will perform all subsequent operations.

```javascript
const txn = db.beginTransaction();
```

### Step 2: Obtaining Transactional Collections

To perform operations within a transaction, you must obtain the "transactional" version of the collection through the transaction object using the `txn.collection('collectionName')` method.

- **Important:** For transactional collections, you **DO NOT** need to call `initPromise`. It is assumed that the "parent" collections have already been initialized at application startup (e.g., `await db.collection('users').initPromise`).

```javascript
// Obtain wrappers for the collections that will participate in the transaction
const usersTxn = txn.collection('users');
const logsTxn = txn.collection('logs');
```

### Step 3: Executing Operations

You can now call the write methods (`insert`, `insertMany`, `update`, `remove`, `clear`) on these transactional collections.

- **Key Point:** These operations are not immediately applied to the database. They are merely logged within the transaction object and will only be executed as a single unit after `txn.commit()` is called.
- **Return Values:** Transactional write methods in the current implementation **do not** return the result of the operation (e.g., the inserted document). They return `Promise<void>`.
- **ID Generation:** If you need a new document ID for subsequent operations in the same transaction (for example, inserting a user and immediately writing a log with their ID), you must **generate this ID on the client side** before calling `insert`.

```javascript
// Generate the user ID in advance, as it will be needed for the log
const { v4: uuidv4 } = require('uuid');
const newUserId = uuidv4();

// Log operations in the transaction
await usersTxn.insert({
  _id: newUserId,
  name: 'Diana Prince',
  department: 'Justice League',
});

await logsTxn.insert({
  timestamp: new Date().toISOString(),
  action: 'USER_CREATED_IN_TXN',
  userId: newUserId, // Using a pre-generated ID
  details: 'User Diana Prince added via transaction',
});
```

### Step 4: Committing the transaction (`commit` or `rollback`)

You have two ways to commit a transaction:

- **`await txn.commit()`**: If all operations should be applied, call `commit()`. WiseJSON DB will atomically write all logged operations to the WAL files of the corresponding collections and apply the changes to the in-memory data. If a failure occurs at this stage, the WAL recovery mechanism ensures that the uncommitted transaction is not applied, preserving data integrity.
- **`await txn.rollback()`**: If an error occurs or you decide to roll back changes before calling `commit()`, call `rollback()`. This method simply rolls back all operations registered in the transaction, and no changes are made to the database.

#### Complete Example Scenario with `commit`

This example demonstrates creating a new user and writing a log about this event in a single atomic operation.

```javascript
const WiseJSON = require('wise-json-db');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

async function transactionCommitExample() {
  const db = new WiseJSON(path.resolve(__dirname, 'myAppDb'));
  await db.init();
  const usersCollection = await db.collection('users');
  await usersCollection.initPromise;
  const logsCollection = await db.collection('logs');
  await logsCollection.initPromise;

  // Begin a transaction
  const txn = db.beginTransaction();
  const newUserId = uuidv4();

  try {
    const txnUsers = txn.collection('users');
    const txnLogs = txn.collection('logs');

    console.log('Registering operations in the transaction...');
    await txnUsers.insert({
      _id: newUserId,
      name: 'Clark Kent',
      email: 'clark@dailyplanet.com',
    });
    await txnLogs.insert({
      event: 'USER_REGISTRATION_TXN',
      userId: newUserId,
      timestamp: new Date().toISOString(),
    });

    // If everything is successful, commit the transaction
    console.log('Committing the transaction...');
    await txn.commit();
    console.log('The transaction was successfully committed.');
  } catch (transactionError) {
    console.error('Error inside the transaction block, rolling back:', transactionError);
    await txn.rollback();
    console.log('The transaction was rolled back.');
  } finally {
    if (db) {
      await db.close();
    }
  }
}

transactionCommitExample();
```

#### Full Example Scenario with `rollback`

This example shows how a transaction is rolled back when an error occurs. Let's assume we have an 'accounts' collection with documents { \_id: 'acc1', balance: 100 } and { \_id: 'acc2', balance: 50 }.

```javascript
// ... initialize db and the 'accounts' collection ...

const txn = db.beginTransaction();
const transferAmount = 30;

try {
  const txnAccounts = txn.collection('accounts');

  // Withdraw from acc1
  await txnAccounts.update('acc1', { balance: 100 - transferAmount });
  console.log('Withdrawal scheduled.');

  // Simulate an error (for example, verification shows that the recipient is blocked)
  throw new Error('The recipient cannot accept the transfer!');

  // This code will not execute
  await txnAccounts.update('acc2', { balance: 50 + transferAmount });
  await txn.commit();
} catch (transactionError) {
  console.error('Error during transaction:', transactionError.message);
  console.log('Rolling back the transaction...');
  await txn.rollback();
  console.log('The transaction has been canceled. The balances remain unchanged.');
}

// A post-transaction check will show that the balances have not changed.
```

### Important Notes on Transactions

- **Performance**: Transactions, especially those involving many operations or collections, can be slightly slower than individual operations due to the overhead of managing transaction state and writing to WAL. Use them where data integrity is more important than maximum speed.
- **Commit Errors**: If `txn.commit()` throws an error (for example, due to an inability to write to disk), the data state will remain consistent. WiseJSON DB's WAL recovery mechanism will not reapply uncommitted transaction blocks on the next startup.
- **Long-running Transactions**: Avoid very long-running transactions that may hold resources for a long time. Although WiseJSON DB does not use traditional row/table locks until the commit, collection-level file locking may be applied when the transaction is committed.
