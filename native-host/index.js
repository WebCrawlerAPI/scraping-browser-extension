#!/usr/bin/env node

const { serve } = require('@hono/node-server');
const { Hono } = require('hono');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');

const gunzipAsync = promisify(zlib.gunzip);

// Log to file for debugging
const LOG_FILE = '/tmp/scraper-native-host.log';

function log(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;
  fs.appendFileSync(LOG_FILE, line);
}

log('Native host starting...');

// Load config from config.json
const configPath = path.join(__dirname, 'config.json');
let config = {};
if (fs.existsSync(configPath)) {
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    log('Loaded config from config.json');
  } catch (e) {
    log(`Failed to parse config.json: ${e.message}`);
  }
}

// Configuration
const PORT = parseInt(process.env.SCRAPER_PORT || config.port || '3002', 10);
const DEFAULT_TIMEOUT = 60000;
const AUTH_TOKEN = process.env.SCRAPER_AUTH_TOKEN || config.authToken || '';

if (!AUTH_TOKEN) {
  log('WARNING: SCRAPER_AUTH_TOKEN not set - API will be unprotected!');
}

// Pending requests: Map<taskId, {resolve, reject, timer}>
const pendingRequests = new Map();

// Native messaging protocol helpers
const MAX_MESSAGE_BYTES = 1024 * 1024;
const OVERSIZE_LOG_WINDOW_MS = 5000;
let oversizeLogCount = 0;
let lastOversizeLogAt = 0;

function readMessage() {
  return new Promise((resolve, reject) => {
    // Read 4-byte length header
    const lengthBuffer = Buffer.alloc(4);
    let bytesRead = 0;

    const readLength = () => {
      const chunk = process.stdin.read(4 - bytesRead);
      if (chunk === null) {
        process.stdin.once('readable', readLength);
        return;
      }

      chunk.copy(lengthBuffer, bytesRead);
      bytesRead += chunk.length;

      if (bytesRead < 4) {
        process.stdin.once('readable', readLength);
        return;
      }

      const messageLength = lengthBuffer.readUInt32LE(0);
      if (messageLength > MAX_MESSAGE_BYTES) {
        discardBody(messageLength)
          .then(() => reject(new Error('Message too large')))
          .catch(reject);
        return;
      }

      readBody(messageLength);
    };

    const discardBody = (length) => {
      return new Promise((discardResolve, discardReject) => {
        let remaining = length;
        const discardChunk = () => {
          const chunk = process.stdin.read(Math.min(remaining, 64 * 1024));
          if (chunk === null) {
            process.stdin.once('readable', discardChunk);
            return;
          }

          remaining -= chunk.length;
          if (remaining > 0) {
            process.stdin.once('readable', discardChunk);
            return;
          }
          discardResolve();
        };

        discardChunk();
      });
    };

    const readBody = (length) => {
      const messageBuffer = Buffer.alloc(length);
      let bodyBytesRead = 0;

      const readChunk = () => {
        const chunk = process.stdin.read(length - bodyBytesRead);
        if (chunk === null) {
          process.stdin.once('readable', readChunk);
          return;
        }

        chunk.copy(messageBuffer, bodyBytesRead);
        bodyBytesRead += chunk.length;

        if (bodyBytesRead < length) {
          process.stdin.once('readable', readChunk);
          return;
        }

        try {
          const message = JSON.parse(messageBuffer.toString('utf8'));
          resolve(message);
        } catch (e) {
          reject(e);
        }
      };

      readChunk();
    };

    readLength();
  });
}

function sendMessage(message) {
  const messageString = JSON.stringify(message);
  const messageBuffer = Buffer.from(messageString, 'utf8');
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32LE(messageBuffer.length, 0);

  process.stdout.write(lengthBuffer);
  process.stdout.write(messageBuffer);

  log(`Sent to extension: ${message.type}`);
}

function generateTaskId() {
  return `task_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

// Decompress base64+gzip encoded HTML
async function decompressHtml(compressedBase64) {
  try {
    // Decode base64 to buffer
    const compressedBuffer = Buffer.from(compressedBase64, 'base64');
    // Decompress gzip
    const decompressedBuffer = await gunzipAsync(compressedBuffer);
    // Convert to string
    return decompressedBuffer.toString('utf8');
  } catch (error) {
    log(`Decompression error: ${error.message}`);
    throw error;
  }
}

async function handleExtensionMessage(message) {
  log(`Received from extension: ${message.type}`);

  if (message.type === 'RESULT') {
    const { taskId } = message;
    const pending = pendingRequests.get(taskId);

    if (pending) {
      clearTimeout(pending.timer);
      pendingRequests.delete(taskId);

      if (message.success) {
        let html = message.html;

        // Handle compressed HTML
        if (message.html_compressed && message.compression === 'gzip+base64') {
          try {
            html = await decompressHtml(message.html_compressed);
            log(`Decompressed HTML: ${message.original_html_bytes} bytes -> ${html.length} chars`);
          } catch (error) {
            log(`Failed to decompress HTML: ${error.message}`);
            pending.resolve({
              error: `Decompression failed: ${error.message}`,
              status_code: 0,
              content_size: 0,
              final_url: message.final_url || message.url,
            });
            return;
          }
        }

        pending.resolve({
          html: html,
          status_code: message.status_code,
          content_size: html ? html.length : 0,
          final_url: message.final_url || message.url,
        });
      } else {
        pending.resolve({
          error: message.error,
          status_code: message.status_code || 0,
          content_size: 0,
          final_url: message.final_url || message.url,
        });
      }
    } else {
      log(`No pending request found for taskId: ${taskId}`);
    }
  } else if (message.type === 'PONG') {
    // Response to keep-alive ping
  } else if (message.type === 'STATUS') {
    // Status update from extension
    log(`Extension status: ${message.status}`);
  }
}

// Create Hono app
const app = new Hono();

// Bearer token authentication middleware
app.use('*', async (c, next) => {
  // Skip auth if no token is configured
  if (!AUTH_TOKEN) {
    return next();
  }

  const authHeader = c.req.header('Authorization');

  if (!authHeader) {
    return c.json({ error: 'Authorization header required' }, 401);
  }

  if (!authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Invalid authorization format. Use: Bearer <token>' }, 401);
  }

  const token = authHeader.slice(7); // Remove 'Bearer ' prefix

  if (token !== AUTH_TOKEN) {
    return c.json({ error: 'Invalid token' }, 401);
  }

  return next();
});

// Health endpoint
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    pending: pendingRequests.size,
    timestamp: new Date().toISOString(),
  });
});

// Scrape endpoint
app.post('/scrape', async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch (e) {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { url, options = {} } = body;

  if (!url) {
    return c.json({ error: 'URL is required' }, 400);
  }

  const taskId = generateTaskId();
  const timeout = options.timeout || DEFAULT_TIMEOUT;

  log(`Scrape request: ${taskId} -> ${url}`);

  // Create promise for this request
  const resultPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(taskId);
      resolve({
        error: 'Request timeout',
        status_code: 0,
        content_size: 0,
        final_url: url,
      });
    }, timeout);

    pendingRequests.set(taskId, { resolve, reject, timer });
  });

  // Send SCRAPE command to extension
  sendMessage({
    type: 'SCRAPE',
    taskId,
    url,
    options,
  });

  // Wait for result
  const result = await resultPromise;

  log(`Scrape result: ${taskId} -> ${result.error ? 'error' : 'success'}`);

  if (result.error) {
    return c.json(result, 500);
  }

  return c.json(result);
});

// Start HTTP server
let server;

function startServer() {
  server = serve({
    fetch: app.fetch,
    port: PORT,
  }, (info) => {
    log(`HTTP server listening on port ${info.port}`);
  });
}

// Main loop - read messages from extension
async function main() {
  process.stdin.on('end', () => {
    log('Extension disconnected (stdin closed)');
    if (server) {
      server.close();
    }
    process.exit(0);
  });

  // Start HTTP server
  startServer();

  while (true) {
    try {
      const message = await readMessage();
      handleExtensionMessage(message);
    } catch (error) {
      if (error.message === 'Message too large') {
        oversizeLogCount += 1;
        const now = Date.now();
        if (now - lastOversizeLogAt > OVERSIZE_LOG_WINDOW_MS) {
          log(`Error: ${error.message} (count=${oversizeLogCount})`);
          lastOversizeLogAt = now;
          oversizeLogCount = 0;
        }
        continue;
      }
      // EOF or other error
      log(`Read error: ${error.message}`);
      break;
    }
  }
}

main().catch((error) => {
  log(`Fatal error: ${error.message}`);
  process.exit(1);
});
