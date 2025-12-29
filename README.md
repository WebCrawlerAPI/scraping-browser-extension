# Scraping Controller Chrome Extension

Remote-controlled scraping helper that opens tabs on your machine, captures the rendered HTML, and streams results back to your server over WebSocket.

## Features
- Connects to your server via WebSocket (`ws://localhost:3001/ws` by default).
- Receives `SCRAPE` commands, opens tabs off-screen, extracts full HTML + title, returns `RESULT`.
- UI popup to start/stop, reconnect, set server URL and page-load timeout, and view live stats.
- Auto-reconnect with backoff and basic HTTP status capture via `webRequest`.

## Install & Load
1. Open Chrome → `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this folder (`supcop/browser-extension`).
4. Pin the extension if you want quick access to the popup.

## Using the Extension
1. Open the popup and set **WebSocket Server URL** (e.g., `ws://localhost:3001/ws`).
2. (Optional) Adjust **Page Load Timeout (ms)**.
3. Click **Connect**. Status will show Connecting/Connected; Disconnect and Reconnect are available.
4. Your server can now send `SCRAPE` commands; the extension will return `RESULT` messages with HTML and status.
5. Stats in the popup show pages scraped, errors, and last activity timestamp.

Configuration is stored in `chrome.storage.local` under `scraperConfig` so it persists between sessions.

## WebSocket Protocol (summary)
- **From server**
  - `SCRAPE`: `{ type: "SCRAPE", taskId, url, options?: { waitFor?, timeout? } }`
  - `PING`: `{ type: "PING" }`
- **From extension**
  - `STATUS`: `{ type: "STATUS", status: "ready"|"processing", taskId?, timestamp }`
  - `RESULT` success: `{ type: "RESULT", taskId, url, success: true, html, title, status_code, timestamp }`
  - `RESULT` error: `{ type: "RESULT", taskId, url, success: false, error, status_code, timestamp }`
  - `PONG`: `{ type: "PONG", timestamp }`

Minimal Node.js server snippet:
```js
import { WebSocketServer } from 'ws';
const wss = new WebSocketServer({ port: 3001 });

wss.on('connection', (ws) => {
  console.log('Extension connected');
  ws.on('message', (data) => console.log('From extension', data.toString()));
  ws.send(JSON.stringify({ type: 'SCRAPE', taskId: 'task_1', url: 'https://example.com' }));
});
```

## Debugging
- Background logs: `chrome://extensions` → this extension → **Service worker** inspect.
- Network/status: popup shows connection state and reconnection attempts log in console.
- Tasks may be closed if timeouts hit (`pageLoadTimeout` or `options.timeout` from server).

## Permissions
`tabs`, `activeTab`, `scripting`, `storage`, `webRequest`, and `<all_urls>` host access are required to open tabs, inject the scraper, and capture HTTP status codes.
