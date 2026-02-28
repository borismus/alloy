/**
 * Alloy Server - HTTP API for filesystem operations
 *
 * Enables web/mobile access to Alloy by exposing the vault over HTTP.
 * Run with: node --import tsx server/index.ts
 */

import express, { Request, Response, NextFunction } from 'express';
import compression from 'compression';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import chokidar from 'chokidar';
import fs from 'fs/promises';
import { existsSync, statSync } from 'fs';
import path from 'path';

const app = express();

// CORS middleware for dev server
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

const PORT = parseInt(process.env.PORT || '3001', 10);
const VAULT_PATH = process.env.VAULT_PATH || process.cwd();
const AUTH_TOKEN = process.env.ALLOY_AUTH_TOKEN;

console.log(`[Server] Starting with VAULT_PATH=${VAULT_PATH}`);

// Auth middleware - skip for localhost and Tailscale, require token for other remote
app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  const ip = req.ip || req.socket.remoteAddress || '';

  // Allow localhost
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
    return next();
  }

  // Allow Tailscale IPs (100.x.x.x range)
  if (ip.startsWith('100.') || ip.startsWith('::ffff:100.')) {
    return next();
  }

  if (!AUTH_TOKEN) {
    return res.status(500).json({ error: 'Server not configured for remote access (no auth token)' });
  }

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token !== AUTH_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

app.use(compression());
app.use(express.json({ limit: '50mb' }));

// Request timing logger - tracks API call frequency during load
let requestCount = 0;
let lastRequestTime = Date.now();
let sessionStart = Date.now();
app.use('/api/fs', (req: Request, _res: Response, next: NextFunction) => {
  const now = Date.now();
  // Reset counter on new session (2s gap between requests = new page load)
  if (now - lastRequestTime > 2000) {
    if (requestCount > 0) {
      console.log(`[API] --- Previous session: ${requestCount} requests in ${lastRequestTime - sessionStart}ms ---`);
    }
    requestCount = 0;
    sessionStart = now;
    console.log(`[API] --- New session ---`);
  }
  requestCount++;
  lastRequestTime = now;
  const elapsed = now - sessionStart;
  console.log(`[API] #${requestCount} +${elapsed}ms ${req.path} ${req.body?.path || ''}`);
  next();
});

// Helper to resolve paths safely within vault
function resolvePath(requestPath: string): string {
  // Normalize and join with vault path
  const resolved = path.resolve(VAULT_PATH, requestPath.replace(/^\/+/, ''));

  // Security: ensure resolved path is within vault
  if (!resolved.startsWith(path.resolve(VAULT_PATH))) {
    throw new Error('Path traversal not allowed');
  }

  return resolved;
}

// FS Endpoints

app.post('/api/fs/readTextFile', async (req: Request, res: Response) => {
  try {
    const filePath = resolvePath(req.body.path);
    const content = await fs.readFile(filePath, 'utf-8');
    res.json({ content });
  } catch (err) {
    res.status(404).json({ error: `File not found: ${req.body.path}` });
  }
});

app.post('/api/fs/writeTextFile', async (req: Request, res: Response) => {
  try {
    const filePath = resolvePath(req.body.path);
    await fs.writeFile(filePath, req.body.content, 'utf-8');
    res.json({});
  } catch (err) {
    res.status(500).json({ error: `Failed to write: ${req.body.path}` });
  }
});

app.post('/api/fs/readFile', async (req: Request, res: Response) => {
  try {
    const filePath = resolvePath(req.body.path);
    const data = await fs.readFile(filePath);
    res.json({ data: data.toString('base64') });
  } catch (err) {
    res.status(404).json({ error: `File not found: ${req.body.path}` });
  }
});

app.post('/api/fs/writeFile', async (req: Request, res: Response) => {
  try {
    const filePath = resolvePath(req.body.path);
    const data = Buffer.from(req.body.data, 'base64');
    await fs.writeFile(filePath, data);
    res.json({});
  } catch (err) {
    res.status(500).json({ error: `Failed to write: ${req.body.path}` });
  }
});

app.post('/api/fs/readDir', async (req: Request, res: Response) => {
  try {
    const dirPath = resolvePath(req.body.path);
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const result = entries.map(entry => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
      isSymlink: entry.isSymbolicLink(),
    }));
    res.json({ entries: result });
  } catch (err) {
    res.status(404).json({ error: `Directory not found: ${req.body.path}` });
  }
});

// Batch read: read headers of all files in a directory (1 request instead of N)
// Returns first `bytes` of each file matching `ext` filter
app.post('/api/fs/readDirHeaders', async (req: Request, res: Response) => {
  try {
    const dirPath = resolvePath(req.body.path);
    const ext: string = req.body.ext || '';
    const maxBytes: number = req.body.bytes || 512;
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const files: Record<string, string> = {};
    await Promise.all(
      entries
        .filter(e => e.isFile() && (!ext || e.name.endsWith(ext)))
        .map(async (entry) => {
          const fd = await fs.open(path.join(dirPath, entry.name), 'r');
          const buf = Buffer.alloc(maxBytes);
          const { bytesRead } = await fd.read(buf, 0, maxBytes, 0);
          await fd.close();
          files[entry.name] = buf.toString('utf-8', 0, bytesRead);
        })
    );
    res.json({ files });
  } catch (err) {
    res.status(404).json({ error: `Directory not found: ${req.body.path}` });
  }
});

app.post('/api/fs/mkdir', async (req: Request, res: Response) => {
  try {
    const dirPath = resolvePath(req.body.path);
    await fs.mkdir(dirPath, { recursive: req.body.options?.recursive ?? true });
    res.json({});
  } catch (err) {
    res.status(500).json({ error: `Failed to create directory: ${req.body.path}` });
  }
});

app.post('/api/fs/remove', async (req: Request, res: Response) => {
  try {
    const targetPath = resolvePath(req.body.path);
    await fs.rm(targetPath, { recursive: true, force: true });
    res.json({});
  } catch (err) {
    res.status(500).json({ error: `Failed to remove: ${req.body.path}` });
  }
});

app.post('/api/fs/exists', async (req: Request, res: Response) => {
  try {
    const targetPath = resolvePath(req.body.path);
    const exists = existsSync(targetPath);
    res.json({ exists });
  } catch (err) {
    res.json({ exists: false });
  }
});

app.post('/api/fs/stat', async (req: Request, res: Response) => {
  try {
    const targetPath = resolvePath(req.body.path);
    const stats = statSync(targetPath);
    res.json({
      mtime: stats.mtime.toISOString(),
      size: stats.size,
      isDirectory: stats.isDirectory(),
      isFile: stats.isFile(),
    });
  } catch (err) {
    res.status(404).json({ error: `Path not found: ${req.body.path}` });
  }
});

// HTTP proxy endpoint - forwards external requests server-side to avoid CORS/localhost issues
app.post('/api/proxy', async (req: Request, res: Response) => {
  const { url, method, headers, body } = req.body;

  if (!url || !method) {
    return res.status(400).json({ error: 'Missing url or method' });
  }

  const controller = new AbortController();

  // Cancel upstream request if client disconnects
  req.on('close', () => controller.abort());

  try {
    const upstreamResponse = await globalThis.fetch(url, {
      method,
      headers: headers || {},
      body: body || undefined,
      signal: controller.signal,
    });

    // Forward status code
    res.status(upstreamResponse.status);

    // Forward response headers as x-proxied-* to avoid Express conflicts
    for (const [key, value] of upstreamResponse.headers.entries()) {
      res.setHeader(`x-proxied-${key}`, value);
    }

    // Also set content-type directly so the browser can interpret the stream
    const contentType = upstreamResponse.headers.get('content-type');
    if (contentType) {
      res.setHeader('content-type', contentType);
    }

    // Stream the response body
    if (upstreamResponse.body) {
      const reader = upstreamResponse.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const canContinue = res.write(value);
          if (!canContinue) {
            await new Promise<void>(resolve => res.once('drain', resolve));
          }
        }
      } catch {
        reader.cancel();
      }
      res.end();
    } else {
      res.end();
    }
  } catch (error) {
    if (!res.headersSent) {
      if (error instanceof Error && error.name === 'AbortError') {
        return; // Client disconnected, nothing to send
      }
      res.status(502).json({
        error: `Proxy error: ${error instanceof Error ? error.message : String(error)}`,
      });
    } else {
      res.end();
    }
  }
});

// Path utility endpoint (for join)
app.post('/api/path/join', (req: Request, res: Response) => {
  const segments: string[] = req.body.segments || [];
  res.json({ path: path.join(...segments) });
});

// Serve hashed assets with immutable caching (Vite includes content hash in filenames)
app.use('/assets', express.static(path.join(process.cwd(), 'dist-web', 'assets'), {
  maxAge: '1y',
  immutable: true,
}));

// Serve other static files (index.html, manifest, icons) with revalidation
app.use(express.static(path.join(process.cwd(), 'dist-web'), {
  maxAge: 0,
  etag: true,
  lastModified: true,
}));

// SPA fallback - serve index.html for non-API routes
app.use((req: Request, res: Response, next: NextFunction) => {
  if (!req.path.startsWith('/api') && req.method === 'GET') {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(process.cwd(), 'dist-web', 'index.html'));
  } else {
    next();
  }
});

// Create HTTP server
const server = createServer(app);

// WebSocket server for file watching
const wss = new WebSocketServer({ server, path: '/api/watch' });

// Set up file watcher
const watcher = chokidar.watch(VAULT_PATH, {
  ignoreInitial: true,
  ignored: /(^|[\/\\])\../, // ignore dotfiles
  persistent: true,
});

watcher.on('all', (event, filePath) => {
  // Convert absolute path to relative path within vault
  const relativePath = path.relative(VAULT_PATH, filePath);

  // Map chokidar events to Tauri-style events
  let eventType: object;
  switch (event) {
    case 'add':
    case 'addDir':
      eventType = { create: { kind: event === 'addDir' ? 'folder' : 'file' } };
      break;
    case 'change':
      eventType = { modify: { kind: 'data' } };
      break;
    case 'unlink':
    case 'unlinkDir':
      eventType = { remove: { kind: event === 'unlinkDir' ? 'folder' : 'file' } };
      break;
    default:
      eventType = { other: {} };
  }

  const message = JSON.stringify({
    type: eventType,
    paths: [relativePath],
  });

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
});

wss.on('connection', (ws: WebSocket) => {
  console.log('[WebSocket] Client connected for file watching');

  ws.on('close', () => {
    console.log('[WebSocket] Client disconnected');
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`[Server] Running on http://localhost:${PORT}`);
  console.log(`[Server] Watching vault at: ${VAULT_PATH}`);
  if (AUTH_TOKEN) {
    console.log('[Server] Remote access enabled (auth token configured)');
  } else {
    console.log('[Server] Local access only (no auth token)');
  }
});
