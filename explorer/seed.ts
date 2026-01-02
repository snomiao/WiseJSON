/**
 * explorer/seed.ts
 * Database seeding script to populate WiseJSON with realistic mock data
 * for testing and demonstration purposes.
 */

import path from 'path';
import fs from 'fs';
import { WiseJSON } from '../src/index.js';

// --- Configuration ---
const DB_PATH = process.env['WISE_JSON_PATH'] || path.resolve(process.cwd(), 'wise-json-db-data');
const USER_COUNT = 150;
const ORDER_COUNT = 400;
const LOG_COUNT = 1000;

// --- Mock Data Constants ---
const FIRST_NAMES = ['Ivan', 'Peter', 'Alice', 'Elena', 'Dmitry', 'Maria', 'Sergey', 'Anna'];
const LAST_NAMES = ['Ivanov', 'Petrov', 'Smirnova', 'Popova', 'Volkov', 'Kuznetsova', 'Zaitsev'];
const CITIES = ['Moscow', 'St. Petersburg', 'Novosibirsk', 'Ekaterinburg', 'Kazan', 'London'];
const TAGS = ['dev', 'qa', 'pm', 'design', 'js', 'python', 'go', 'devops', 'vip'];
const LOG_LEVELS = ['INFO', 'WARN', 'ERROR', 'DEBUG'];
const LOG_COMPONENTS = ['API', 'WebApp', 'PaymentGateway', 'AuthService'];
const ORDER_STATUSES = ['pending', 'shipped', 'delivered', 'cancelled'];
const PRODUCTS = [
    { name: 'Laptop Pro', price: 120000 },
    { name: 'Smartphone X', price: 80000 },
    { name: 'Wireless Headphones', price: 15000 },
    { name: 'Smart Watch', price: 25000 }
];

// --- Interfaces for Seed Data ---
interface UserSeed {
    _id: string;
    name: string;
    email: string;
    age: number;
    city: string;
    tags: string[];
    active: boolean;
    managerId?: string;
    expireAt?: number;
}

interface OrderSeed {
    userId: string;
    status: string;
    products: typeof PRODUCTS;
    totalAmount: number;
    createdAt: string;
}

interface LogSeed {
    level: string;
    component: string;
    message: string;
    timestamp: string;
    ttl?: number;
    userId?: string;
}

// --- Helper Functions ---
const getRandom = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
const getRandomInt = (min: number, max: number): number => Math.floor(Math.random() * (max - min + 1)) + min;



async function seedDatabase() {
    console.log(`\n🌱 Starting database seeding at: ${DB_PATH}`);

    if (fs.existsSync(DB_PATH)) {
        console.log('   - Removing existing database directory...');
        fs.rmSync(DB_PATH, { recursive: true, force: true });
    }

    const db = new WiseJSON(DB_PATH);
    await db.init();
    console.log('   - Database initialized.');

    try {
        // --- 1. Users Collection ---
        console.log(`\n👤 Generating ${USER_COUNT} users...`);
        const usersCollection = await db.getCollection<UserSeed>('users');

        const users: UserSeed[] = [];
        for (let i = 0; i < USER_COUNT; i++) {
            const user: UserSeed = {
                _id: `user_${i}`,
                name: `${getRandom(FIRST_NAMES)} ${getRandom(LAST_NAMES)}`,
                email: `user${i}@example.com`,
                age: getRandomInt(18, 65),
                city: getRandom(CITIES),
                tags: [getRandom(TAGS), getRandom(TAGS)].filter((v, i, a) => a.indexOf(v) === i),
                active: Math.random() > 0.2,
            };
            if (i % 10 === 0) {
                user.managerId = `user_${getRandomInt(0, USER_COUNT - 1)}`;
            }
            if (i % 25 === 0) {
                user.expireAt = Date.now() + 3600 * 1000; // Expire in 1 hour
            }
            users.push(user);
        }
        await usersCollection.insertMany(users);

        console.log('   - Creating indexes for "users"...');
        await usersCollection.createIndex('city');
        await usersCollection.createIndex('age');
        await usersCollection.createIndex('email', { unique: true });
        console.log(`✅ "users" collection created with ${await usersCollection.count()} documents.`);

        // --- 2. Orders Collection ---
        console.log(`\n🛒 Generating ${ORDER_COUNT} orders...`);
        const ordersCollection = await db.getCollection<OrderSeed>('orders');

        const orders: OrderSeed[] = [];
        for (let i = 0; i < ORDER_COUNT; i++) {
            const productCount = getRandomInt(1, 3);
            const orderProducts = Array.from({ length: productCount }, () => getRandom(PRODUCTS));
            orders.push({
                userId: `user_${getRandomInt(0, USER_COUNT - 1)}`,
                status: getRandom(ORDER_STATUSES),
                products: orderProducts,
                totalAmount: orderProducts.reduce((sum, p) => sum + p.price, 0),
                createdAt: new Date(Date.now() - getRandomInt(0, 30) * 86400000).toISOString(),
            });
        }
        await ordersCollection.insertMany(orders);

        console.log('   - Creating indexes for "orders"...');
        await ordersCollection.createIndex('userId');
        await ordersCollection.createIndex('status');
        console.log(`✅ "orders" collection created with ${await ordersCollection.count()} documents.`);

        // --- 3. Logs Collection ---
        console.log(`\n📄 Generating ${LOG_COUNT} logs...`);
        const logsCollection = await db.getCollection<LogSeed>('logs');

        const logs: LogSeed[] = [];
        for (let i = 0; i < LOG_COUNT; i++) {
            const log: LogSeed = {
                level: getRandom(LOG_LEVELS),
                component: getRandom(LOG_COMPONENTS),
                message: `Operation ${i} completed with status code ${getRandomInt(200, 500)}.`,
                timestamp: new Date(Date.now() - getRandomInt(0, 24 * 60) * 60000).toISOString(),
            };
            if (log.level === 'DEBUG') {
                log.ttl = 5 * 60 * 1000; // TTL: 5 minutes
            }
            if (i % 5 === 0) {
                log.userId = `user_${getRandomInt(0, USER_COUNT - 1)}`;
            }
            logs.push(log);
        }
        await logsCollection.insertMany(logs);

        console.log('   - Creating index for "logs"...');
        await logsCollection.createIndex('level');
        console.log(`✅ "logs" collection created with ${await logsCollection.count()} documents.`);

    } catch (error) {
        console.error('\n🔥 Seed failed:', error);
    } finally {
        if (db) {
            console.log('\n- Closing database connection and flushing WAL...');
            await db.close();
        }
    }

    console.log('\n✨ Database seeding complete! ✨');
    console.log('You can now start the explorer: node dist/explorer/server.js');
}

seedDatabase();
