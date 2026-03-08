/* eslint-disable no-useless-escape */
/**
 * explorer/server.ts
 * WiseJSON Data Explorer - Lightweight HTTP Server
 */

import http from 'http';
import url from 'url';
import fs from 'fs';
import path from 'path';
import { analyzeDatabaseGraph } from './schema-analyzer.js';
import { WiseJSON } from '../src/index.js';
import logger from '../src/lib/logger.js';

// --- Configuration & Environment ---
const PORT = process.env['PORT'] || 3000;
const DB_PATH = process.env['WISE_JSON_PATH'] || path.resolve(process.cwd(), 'wise-json-db-data');
const AUTH_USER = process.env['WISEJSON_AUTH_USER'];
const AUTH_PASS = process.env['WISEJSON_AUTH_PASS'];
const USE_AUTH = !!(AUTH_USER && AUTH_PASS);
const ALLOW_WRITE = process.env['WISEJSON_EXPLORER_ALLOW_WRITE'] === 'true';

const LOGO_PATH = path.resolve(process.cwd(), 'logo.png');

const db = new WiseJSON(DB_PATH);

/**
 * Utility to send standardized JSON responses
 */
function sendJson(res: http.ServerResponse, statusCode: number, data: any) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
}

/**
 * Utility to send standardized Error responses
 */
function sendError(res: http.ServerResponse, statusCode: number, message: string) {
  sendJson(res, statusCode, { error: message });
}

/**
 * Basic Authentication check
 */
function checkAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (!USE_AUTH) return true;

  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="WiseJSON Data Explorer"' });
    res.end('Unauthorized');
    return false;
  }

  const b64 = authHeader.slice('Basic '.length).trim();
  const [user, pass] = Buffer.from(b64, 'base64').toString().split(':');

  if (user === AUTH_USER && pass === AUTH_PASS) return true;

  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="WiseJSON Data Explorer"' });
  res.end('Unauthorized');
  return false;
}

/**
 * Static file server for HTML/JS/CSS assets
 */
function serveStaticFile(filename: string, res: http.ServerResponse) {
  const potentialPaths = [
    path.join(__dirname, 'views', filename),
    path.join(__dirname, 'views', 'components', filename)
  ];

  const filePath = potentialPaths.find(p => fs.existsSync(p));
  if (!filePath) return sendError(res, 404, 'Static file not found.');

  const ext = path.extname(filePath);
  const contentTypes: Record<string, string> = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.png': 'image/png'
  };

  res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'text/plain' });
  fs.createReadStream(filePath).pipe(res);
}

/**
 * Parses filter_ queries into MongoDB-like filter objects
 */
function parseFilterFromQuery(query: url.UrlWithParsedQuery['query']): any {
  const filter: any = {};
  for (const [key, value] of Object.entries(query)) {
    if (key.startsWith('filter_') && typeof value === 'string') {
      const tail = key.slice('filter_'.length);
      const [field, op] = tail.split('__');
      let v: any = value;

      // Auto-convert numbers
      if (/^-?\d+(\.\d+)?$/.test(v)) v = parseFloat(v);

      if (op) {
        if (!filter[field]) filter[field] = {};
        filter[field][`$${op}`] = v;
      } else {
        filter[field] = v;
      }
    }
  }
  return filter;
}



/**
 * Main Request Routing Logic
 */
async function requestHandler(req: http.IncomingMessage, res: http.ServerResponse) {
  if (!checkAuth(req, res)) return;

  const parsedUrl = url.parse(req.url || '/', true);
  const { pathname, query } = parsedUrl;
  const method = (req.method || 'GET').toUpperCase();

  // Favicon Handling
  if (pathname === '/favicon.ico') {
    if (fs.existsSync(LOGO_PATH)) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      fs.createReadStream(LOGO_PATH).pipe(res);
    } else {
      res.writeHead(204);
      res.end();
    }
    return;
  }

  // Static Assets
  if (pathname === '/') return serveStaticFile('index.html', res);
  if (pathname?.startsWith('/static/')) return serveStaticFile(pathname.slice('/static/'.length), res);

  // API: Permissions
  if (pathname === '/api/permissions' && method === 'GET') {
    return sendJson(res, 200, { writeMode: ALLOW_WRITE });
  }

  // API: Collection List
  if (pathname === '/api/collections' && method === 'GET') {
    const names = await db.getCollectionNames();
    const result = await Promise.all(names.map(async (name) => {
      const col = await db.getCollection(name);
      return { name, count: await col.count() };
    }));
    return sendJson(res, 200, result);
  }

  // API: Schema Graph Analysis
  if (pathname === '/api/schema-graph' && method === 'GET') {
    try {
      const graphData = await analyzeDatabaseGraph(db);
      return sendJson(res, 200, graphData);
    } catch (error: any) {
      logger.error(`[Server] Schema analysis error: ${error.message}`);
      return sendError(res, 500, 'Failed to analyze schema.');
    }
  }

  // API: Documents in Collection (with pagination/sort/filter)
  const collectionRouteMatch = pathname?.match(/^\/api\/collections\/([^\/]+)\/?$/);
  if (collectionRouteMatch && method === 'GET') {
    const colName = decodeURIComponent(collectionRouteMatch[1]);
    const col = await db.getCollection(colName);

    const queryFilter = parseFilterFromQuery(query);
    let jsonFilter = {};
    if (query['filter'] && typeof query['filter'] === 'string') {
      try { jsonFilter = JSON.parse(query['filter']); } catch { /* empty */ }
    }

    const docs = await col.find({ ...queryFilter, ...jsonFilter });

    if (query['sort'] && typeof query['sort'] === 'string') {
      const sortField = query['sort'];
      docs.sort((a: any, b: any) => {
        if (a[sortField] < b[sortField]) return query['order'] === 'desc' ? 1 : -1;
        if (a[sortField] > b[sortField]) return query['order'] === 'desc' ? -1 : 1;
        return 0;
      });
    }

    const offset = parseInt(query['offset'] as string || '0', 10);
    const limit = parseInt(query['limit'] as string || '10', 10);
    return sendJson(res, 200, docs.slice(offset, offset + limit));
  }

  // API: Collection Stats & Indexes
  const statsRouteMatch = pathname?.match(/^\/api\/collections\/([^\/]+)\/stats$/);
  if (statsRouteMatch && method === 'GET') {
    const colName = decodeURIComponent(statsRouteMatch[1]);
    const col = await db.getCollection(colName);
    const stats = await col.stats();
    const indexes = await col.getIndexes();
    return sendJson(res, 200, { ...stats, indexes });
  }

  // API: Individual Document (GET / DELETE)
  const docRouteMatch = pathname?.match(/^\/api\/collections\/([^\/]+)\/doc\/(.+)$/);
  if (docRouteMatch) {
    const colName = decodeURIComponent(docRouteMatch[1]);
    const docId = decodeURIComponent(docRouteMatch[2]);
    const col = await db.getCollection(colName);

    if (method === 'GET') {
      const doc = await col.findOne({ _id: docId });
      return doc ? sendJson(res, 200, doc) : sendError(res, 404, 'Document not found.');
    }

    if (method === 'DELETE') {
      if (!ALLOW_WRITE) return sendError(res, 403, 'Write operations disabled.');
      const success = await col.deleteOne({ _id: docId });
      return success ? sendJson(res, 200, { message: 'Document removed' }) : sendError(res, 404, 'Document not found.');
    }
  }

  return sendError(res, 404, 'Not Found');
}

/**
 * Server Lifecycle
 */
async function startServer() {
  await db.init();
  const server = http.createServer((req, res) => {
    requestHandler(req, res).catch(err => {
      logger.error(`[Server] Unhandled request error: ${err.message}`);
      sendError(res, 500, 'Internal Server Error');
    });
  });

  server.listen(PORT, () => {
    logger.log(`[Explorer] Running at http://localhost:${PORT}/`);
    if (USE_AUTH) logger.log(`[Explorer] Basic Auth enabled for user: ${AUTH_USER}`);
    if (!ALLOW_WRITE) logger.warn('[Explorer] Running in READ-ONLY mode.');
  });
}

startServer();
