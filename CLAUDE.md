# Browser Extension - Scraping Controller

Chrome extension for remote-controlled web scraping via WebSocket.

## Architecture

```
┌─────────────────┐         WebSocket         ┌─────────────────┐
│   Your Server   │◄────────────────────────►│    Extension    │
│                 │                           │                 │
│  Send SCRAPE    │─────────────────────────►│  Opens tab      │
│  commands       │                           │  Extracts HTML  │
│                 │◄─────────────────────────│  Returns RESULT │
└─────────────────┘                           └─────────────────┘
```

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | Chrome extension manifest (v3) |
| `background.js` | Service worker - WebSocket connection, tab management, scraping |
| `popup.html` | Extension popup UI |
| `popup.js` | Popup logic and state management |

## WebSocket Protocol

### Server → Extension

**SCRAPE command:**
```json
{
  "type": "SCRAPE",
  "taskId": "unique-task-id",
  "url": "https://example.com",
  "options": {
    "waitFor": 2000,
    "timeout": 30000
  }
}
```

**PING (keepalive):**
```json
{
  "type": "PING"
}
```

### Extension → Server

**RESULT (success):**
```json
{
  "type": "RESULT",
  "taskId": "unique-task-id",
  "url": "https://example.com",
  "success": true,
  "html": "<!DOCTYPE html>...",
  "title": "Page Title",
  "status_code": 200,
  "timestamp": "2025-01-01T12:00:00.000Z"
}
```

**RESULT (error):**
```json
{
  "type": "RESULT",
  "taskId": "unique-task-id",
  "url": "https://example.com",
  "success": false,
  "error": "Page load timeout",
  "status_code": 0,
  "timestamp": "2025-01-01T12:00:00.000Z"
}
```

**STATUS:**
```json
{
  "type": "STATUS",
  "status": "ready|processing",
  "taskId": "task-id-if-processing",
  "timestamp": "2025-01-01T12:00:00.000Z"
}
```

**PONG:**
```json
{
  "type": "PONG",
  "timestamp": "2025-01-01T12:00:00.000Z"
}
```

## Configuration

Stored in `chrome.storage.local` under key `scraperConfig`:

| Setting | Default | Description |
|---------|---------|-------------|
| `serverUrl` | `ws://localhost:3001` | WebSocket server URL |
| `enabled` | `false` | Whether connection is active |
| `pageLoadTimeout` | `30000` | Max time to wait for page load (ms) |
| `reconnectInterval` | `3000` | Base delay between reconnect attempts (ms) |
| `maxReconnectAttempts` | `10` | Max reconnection attempts before stopping |

## Reconnection Logic

- On disconnect, schedules reconnect with exponential backoff
- Delay: `min(reconnectInterval * attempts, 30000)` ms
- Resets attempt counter on successful connection
- Stops after `maxReconnectAttempts` failures

## Development

### Load Extension
1. Go to `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select this directory

### Debug
- Background script logs: `chrome://extensions/` → Extension → "Inspect views: service worker"
- Console shows: `[Scraper] Connected`, `[Scraper] Received: SCRAPE task_1`, etc.

## Server Implementation Notes

Your server should:

1. Accept WebSocket connections
2. Send `SCRAPE` commands when URLs need scraping
3. Handle `RESULT` messages with scraped HTML
4. Optionally send `PING` for keepalive (extension responds with `PONG`)
5. Track `STATUS` messages to know when extension is ready

Example minimal server (Node.js):
```javascript
import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ port: 3001 });

wss.on('connection', (ws) => {
  console.log('Extension connected');

  ws.on('message', (data) => {
    const msg = JSON.parse(data);

    if (msg.type === 'RESULT') {
      console.log('Got HTML:', msg.html?.length, 'chars');
    }

    if (msg.type === 'STATUS' && msg.status === 'ready') {
      // Extension is ready, can send SCRAPE command
      ws.send(JSON.stringify({
        type: 'SCRAPE',
        taskId: 'task_1',
        url: 'https://example.com'
      }));
    }
  });
});
```
