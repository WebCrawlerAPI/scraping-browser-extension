# Native Messaging Host

HTTP server that bridges external clients to the Chrome extension for web scraping.

## Why This Exists

Chrome's Manifest V3 terminates extension background scripts after ~30 seconds of inactivity. This native host runs as a separate process that Chrome can't kill, providing a persistent HTTP API for scraping requests.

## How It Works

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                  CHROME                                      │
│  ┌─────────────────┐                                                        │
│  │    Extension    │    Chrome Native                                       │
│  │   (popup.js +   │    Messaging API                                       │
│  │  background.js) │         (stdio)                                        │
│  └────────┬────────┘                                                        │
│           │                                                                 │
└───────────┼─────────────────────────────────────────────────────────────────┘
            │
            ▼
┌───────────────────────┐         ┌─────────────────────────┐
│     Native Host       │         │     HTTP Clients        │
│      (Node.js)        │◄────────│  (curl, your server,    │
│                       │  HTTP   │   API consumers, etc.)  │
│  - Runs as separate   │  POST   │                         │
│    process            │ /scrape └─────────────────────────┘
│  - Hono HTTP server   │
│  - Port 3002 default  │
└───────────────────────┘
```

**Flow:**
1. HTTP client sends POST /scrape → Native Host
2. Native Host forwards SCRAPE command → Extension (via stdio)
3. Extension opens tab, captures content
4. Extension sends RESULT → Native Host (via stdio)
5. Native Host returns HTTP response → Client

## Installation

### 1. Find Your Extension ID

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top right toggle)
3. Find "Scraping Controller"
4. Copy the **ID** (32-character string like `cigpoehhihgofakjfekijajiafildcap`)

### 2. Install Native Host

```bash
cd native-host
pnpm install
./install.sh YOUR_EXTENSION_ID
```

This will:
- Install Node.js dependencies
- Create a wrapper script
- Register the native host with Chrome

### 3. Reload Extension

1. Go to `chrome://extensions/`
2. Click the **refresh icon** on "Scraping Controller"

### 4. Connect

1. Click the extension icon in Chrome toolbar
2. Click **Connect**
3. Status should show "Connected"

## HTTP API

### POST /scrape

```bash
curl -X POST http://localhost:3002/scrape \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"url": "https://example.com"}'
```

**Response:**
```json
{
  "html": "<!DOCTYPE html>...",
  "status_code": 200,
  "content_size": 12345,
  "final_url": "https://example.com"
}
```

### GET /health

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" http://localhost:3002/health
```

**Response:**
```json
{
  "status": "ok",
  "pending": 0,
  "timestamp": "2025-01-01T12:00:00.000Z"
}
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SCRAPER_PORT` | `3002` | HTTP server port |
| `SCRAPER_AUTH_TOKEN` | (none) | Bearer token for API authentication. If not set, API is unprotected |

## Debugging

Watch logs in real-time:
```bash
tail -f /tmp/scraper-native-host.log
```

Check Chrome extension errors:
1. Go to `chrome://extensions/`
2. Click "Inspect views: service worker"
3. Check Console tab

## Uninstall

```bash
./uninstall.sh
```

## Requirements

- Node.js 18+
- Chrome or Chromium browser
