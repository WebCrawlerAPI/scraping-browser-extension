// WebSocket Scraping Controller - Background Service Worker

let config = {
  serverUrl: 'ws://localhost:3001/ws',
  enabled: false,
  pageLoadTimeout: 30000,
  reconnectInterval: 3000,
  maxReconnectAttempts: 10,
};

let ws = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let isProcessing = false;

let stats = {
  totalScraped: 0,
  errors: 0,
  lastActivity: null,
  connectionState: 'disconnected', // disconnected, connecting, connected
};

// Load config from storage on startup
chrome.storage.local.get(['scraperConfig'], (result) => {
  if (result.scraperConfig) {
    config = { ...config, ...result.scraperConfig };
    if (config.enabled) {
      connect();
    }
  }
  broadcastStatus();
});

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'GET_STATUS':
      sendResponse({ config, stats, isProcessing });
      break;

    case 'UPDATE_CONFIG':
      config = { ...config, ...message.config };
      chrome.storage.local.set({ scraperConfig: config });
      broadcastStatus();
      sendResponse({ success: true });
      break;

    case 'START':
      config.enabled = true;
      chrome.storage.local.set({ scraperConfig: config });
      connect();
      sendResponse({ success: true });
      break;

    case 'STOP':
      config.enabled = false;
      chrome.storage.local.set({ scraperConfig: config });
      disconnect();
      sendResponse({ success: true });
      break;

    case 'RECONNECT':
      if (config.enabled) {
        disconnect();
        reconnectAttempts = 0;
        connect();
      }
      sendResponse({ success: true });
      break;

    case 'DEBUG_PAYLOAD':
      buildDebugPayload()
        .then((payload) => sendResponse({ success: true, payload }))
        .catch((error) => sendResponse({ success: false, error: error.message }));
      break;
  }
  return true;
});

function broadcastStatus() {
  chrome.runtime.sendMessage({
    type: 'STATUS_UPDATE',
    config,
    stats,
    isProcessing,
  }).catch(() => {
    // Popup might not be open
  });
}

function updateConnectionState(state) {
  stats.connectionState = state;
  broadcastStatus();
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  updateConnectionState('connecting');
  console.log('[Scraper] Connecting to', config.serverUrl);

  try {
    ws = new WebSocket(config.serverUrl);

    ws.onopen = () => {
      console.log('[Scraper] Connected');
      reconnectAttempts = 0;
      updateConnectionState('connected');

      // Send ready status
      send({
        type: 'STATUS',
        status: 'ready',
        timestamp: new Date().toISOString(),
      });
    };

    ws.onmessage = async (event) => {
      try {
        const message = JSON.parse(event.data);
        await handleMessage(message);
      } catch (error) {
        console.error('[Scraper] Failed to parse message:', error);
      }
    };

    ws.onclose = (event) => {
      console.log('[Scraper] Connection closed:', event.code, event.reason);
      ws = null;
      updateConnectionState('disconnected');

      if (config.enabled) {
        scheduleReconnect();
      }
    };

    ws.onerror = (error) => {
      console.error('[Scraper] WebSocket error:', error);
    };

  } catch (error) {
    console.error('[Scraper] Failed to create WebSocket:', error);
    updateConnectionState('disconnected');
    if (config.enabled) {
      scheduleReconnect();
    }
  }
}

function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (ws) {
    ws.close(1000, 'User disconnected');
    ws = null;
  }

  updateConnectionState('disconnected');
  console.log('[Scraper] Disconnected');
}

function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }

  if (reconnectAttempts >= config.maxReconnectAttempts) {
    console.log('[Scraper] Max reconnect attempts reached');
    config.enabled = false;
    chrome.storage.local.set({ scraperConfig: config });
    broadcastStatus();
    return;
  }

  reconnectAttempts++;
  const delay = Math.min(config.reconnectInterval * reconnectAttempts, 30000);

  console.log(`[Scraper] Reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${config.maxReconnectAttempts})`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (config.enabled) {
      connect();
    }
  }, delay);
}

function send(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
    return true;
  }
  return false;
}

async function handleMessage(message) {
  console.log('[Scraper] Received:', message.type, message.taskId || '');

  switch (message.type) {
    case 'SCRAPE':
      await handleScrapeCommand(message);
      break;

    case 'PING':
      send({ type: 'PONG', timestamp: new Date().toISOString() });
      break;

    case 'CANCEL':
      // Could implement task cancellation here
      console.log('[Scraper] Cancel requested');
      break;

    default:
      console.log('[Scraper] Unknown message type:', message.type);
  }
}

async function handleScrapeCommand(message) {
  const { taskId, url, options = {} } = message;

  if (!url) {
    send({
      type: 'RESULT',
      taskId,
      success: false,
      error: 'URL is required',
      status_code: 0,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (isProcessing) {
    send({
      type: 'RESULT',
      taskId,
      success: false,
      error: 'Already processing another task',
      status_code: 0,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  isProcessing = true;
  broadcastStatus();

  // Notify server we're starting
  send({
    type: 'STATUS',
    status: 'processing',
    taskId,
    timestamp: new Date().toISOString(),
  });

  let tab = null;
  let statusCode = 200; // Default to 200 for successful page loads

  try {
    // Create new tab
    tab = await chrome.tabs.create({
      url,
      active: false,
    });

    // Wait for page to load and capture status code via webRequest if available
    const timeout = options.timeout || config.pageLoadTimeout;
    const loadResult = await waitForTabLoadWithStatus(tab.id, url, timeout);
    statusCode = loadResult.statusCode || 200;

    // Additional wait if specified
    if (options.waitFor) {
      await sleep(options.waitFor);
    } else {
      // Default small delay for JS execution
      await sleep(1000);
    }

    // Extract content
    const content = await getPageContent(tab.id);

    if (!content) {
      throw new Error('Failed to extract page content');
    }

    // Send result immediately
    send({
      type: 'RESULT',
      taskId,
      url,
      success: true,
      html: content.html,
      title: content.title,
      status_code: statusCode,
      timestamp: new Date().toISOString(),
    });

    stats.totalScraped++;
    stats.lastActivity = new Date().toISOString();
    console.log('[Scraper] Task completed:', taskId, 'status:', statusCode);

  } catch (error) {
    console.error('[Scraper] Task error:', error.message);
    stats.errors++;
    stats.lastActivity = new Date().toISOString();

    // Try to determine status code from error message
    let errorStatusCode = 0;
    if (error.message.includes('net::ERR_')) {
      errorStatusCode = 0; // Network error
    } else if (error.message.includes('403')) {
      errorStatusCode = 403;
    } else if (error.message.includes('404')) {
      errorStatusCode = 404;
    } else if (error.message.includes('500')) {
      errorStatusCode = 500;
    }

    send({
      type: 'RESULT',
      taskId,
      url,
      success: false,
      error: error.message,
      status_code: errorStatusCode,
      timestamp: new Date().toISOString(),
    });

  } finally {
    // Close the tab
    if (tab) {
      try {
        await chrome.tabs.remove(tab.id);
      } catch (e) {
        // Tab might already be closed
      }
    }

    isProcessing = false;
    broadcastStatus();

    // Notify server we're ready again
    send({
      type: 'STATUS',
      status: 'ready',
      timestamp: new Date().toISOString(),
    });
  }
}

function waitForTabLoad(tabId, timeout) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Page load timeout'));
    }, timeout);

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timeoutId);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };

    chrome.tabs.onUpdated.addListener(listener);

    // Check if already loaded
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        clearTimeout(timeoutId);
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error('Tab not found'));
        return;
      }
      if (tab && tab.status === 'complete') {
        clearTimeout(timeoutId);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });
}

// Enhanced version that captures HTTP status code
function waitForTabLoadWithStatus(tabId, targetUrl, timeout) {
  return new Promise((resolve, reject) => {
    let statusCode = 200;
    let webRequestListener = null;

    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error('Page load timeout'));
    }, timeout);

    const cleanup = () => {
      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(tabListener);
      if (webRequestListener && chrome.webRequest) {
        chrome.webRequest.onHeadersReceived.removeListener(webRequestListener);
      }
    };

    // Listen for HTTP response headers to capture status code
    if (chrome.webRequest) {
      webRequestListener = (details) => {
        // Match the main frame request for our tab
        if (details.tabId === tabId && details.type === 'main_frame') {
          statusCode = details.statusCode;
          console.log('[Scraper] Captured status code:', statusCode, 'for URL:', details.url);
        }
      };

      chrome.webRequest.onHeadersReceived.addListener(
        webRequestListener,
        { urls: ['<all_urls>'], tabId: tabId },
        []
      );
    }

    const tabListener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        cleanup();
        resolve({ statusCode });
      }
    };

    chrome.tabs.onUpdated.addListener(tabListener);

    // Check if already loaded
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        cleanup();
        reject(new Error('Tab not found'));
        return;
      }
      if (tab && tab.status === 'complete') {
        cleanup();
        resolve({ statusCode });
      }
    });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getPageContent(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: extractPageContent,
  });

  const content = results[0]?.result || null;

  if (content?.visited) {
    console.log('[Scraper][serialize] visited count:', content.visited.length);
    console.log('[Scraper][serialize] nodes:', content.visited);
    delete content.visited;
  }

  return content;
}

async function buildDebugPayload() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!activeTab?.id) {
    throw new Error('No active tab available');
  }

  const content = await getPageContent(activeTab.id);

  if (!content) {
    throw new Error('Failed to capture page content');
  }

  return {
    type: 'RESULT',
    taskId: 'debug_snapshot',
    url: activeTab.url,
    success: true,
    html: content.html,
    title: content.title,
    status_code: 200,
    timestamp: new Date().toISOString(),
  };
}

// Runs in page context
function extractPageContent() {
  const voidElements = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
    'param', 'source', 'track', 'wbr', 'basefont', 'bgsound', 'frame', 'keygen',
  ]);

  const visited = [];

  const escapeText = (text) => text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const escapeAttribute = (value) => value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');

  const serializeNode = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      return escapeText(node.textContent || '');
    }

    if (node.nodeType === Node.COMMENT_NODE) {
      return `<!--${node.nodeValue || ''}-->`;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return '';
    }

    const tagName = node.tagName.toLowerCase();
    const debugLabel = [tagName, node.id ? `#${node.id}` : '', node.className ? `.${String(node.className).trim().replace(/\s+/g, '.')}` : '']
      .join('')
      .replace(/\.+$/, '');
    visited.push(debugLabel || tagName);
    const attributes = Array.from(node.attributes)
      .map((attr) => `${attr.name}="${escapeAttribute(attr.value)}"`)
      .join(' ');

    let html = `<${tagName}${attributes ? ' ' + attributes : ''}>`;

    if (!voidElements.has(tagName)) {
      node.childNodes.forEach((child) => {
        html += serializeNode(child);
      });

      if (node.shadowRoot) {
        html += `<template shadowroot="${node.shadowRoot.mode}">`;
        node.shadowRoot.childNodes.forEach((child) => {
          html += serializeNode(child);
        });
        html += '</template>';
      }

      html += `</${tagName}>`;
    }

    return html;
  };

  const root = document.querySelector('main') || document.body || document.documentElement;

  return {
    html: serializeNode(root),
    title: document.title,
    visited,
  };
}
