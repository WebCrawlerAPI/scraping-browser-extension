// HTTP Scraping Controller - Background Service Worker
// Uses Native Messaging Host with HTTP server for receiving scrape requests

console.log('[Scraper] Service worker starting at', new Date().toISOString());

// Icon colors for different states
const STATUS_COLORS = {
  disconnected: '#ef4444', // red
  connecting: '#fbbf24',   // yellow/amber
  connected: '#4ade80',    // green
};

// Draw robot icon with status indicator
function updateIcon(status) {
  const size = 32;
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Clear
  ctx.clearRect(0, 0, size, size);

  // Robot head (rounded rectangle)
  ctx.fillStyle = '#6366f1';
  ctx.beginPath();
  ctx.roundRect(4, 6, 24, 20, 4);
  ctx.fill();

  // Antenna
  ctx.strokeStyle = '#6366f1';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(16, 6);
  ctx.lineTo(16, 2);
  ctx.stroke();
  ctx.fillStyle = '#6366f1';
  ctx.beginPath();
  ctx.arc(16, 2, 2, 0, Math.PI * 2);
  ctx.fill();

  // Eyes
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(11, 14, 3, 0, Math.PI * 2);
  ctx.arc(21, 14, 3, 0, Math.PI * 2);
  ctx.fill();

  // Pupils
  ctx.fillStyle = '#1e1b4b';
  ctx.beginPath();
  ctx.arc(11, 14, 1.5, 0, Math.PI * 2);
  ctx.arc(21, 14, 1.5, 0, Math.PI * 2);
  ctx.fill();

  // Mouth
  ctx.fillStyle = '#1e1b4b';
  ctx.fillRect(10, 20, 12, 2);

  // Status indicator dot (bottom right)
  const dotColor = STATUS_COLORS[status] || STATUS_COLORS.disconnected;
  ctx.fillStyle = dotColor;
  ctx.beginPath();
  ctx.arc(26, 26, 5, 0, Math.PI * 2);
  ctx.fill();

  // Dot border
  ctx.strokeStyle = '#1a1a2e';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(26, 26, 5, 0, Math.PI * 2);
  ctx.stroke();

  // Set the icon
  const imageData = ctx.getImageData(0, 0, size, size);
  chrome.action.setIcon({ imageData: { 32: imageData } });
}

const NATIVE_HOST_NAME = 'com.webcrawlerapi.scraper';

let config = {
  enabled: false,
  pageLoadTimeout: 30000,
  reconnectInterval: 3000,
};

let nativePort = null;
let isProcessing = false;

let stats = {
  totalScraped: 0,
  errors: 0,
  lastActivity: null,
  connectionState: 'disconnected',
};

// Set initial icon
updateIcon('disconnected');

// Load config from storage on startup
chrome.storage.local.get(['scraperConfig'], (result) => {
  if (result.scraperConfig) {
    config = { ...config, ...result.scraperConfig };
    if (config.enabled) {
      connectToNativeHost();
    }
  }
  updateIcon(stats.connectionState);
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
      connectToNativeHost();
      sendResponse({ success: true });
      break;

    case 'STOP':
      config.enabled = false;
      chrome.storage.local.set({ scraperConfig: config });
      disconnectFromNativeHost();
      sendResponse({ success: true });
      break;

    case 'RECONNECT':
      if (config.enabled) {
        disconnectFromNativeHost();
        setTimeout(() => connectToNativeHost(), 100);
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
  updateIcon(stats.connectionState);
  chrome.runtime.sendMessage({
    type: 'STATUS_UPDATE',
    config,
    stats,
    isProcessing,
  }).catch(() => {
    // Popup might not be open
  });
}

function connectToNativeHost() {
  if (nativePort) {
    console.log('[Scraper] Already connected to native host');
    return;
  }

  console.log('[Scraper] Connecting to native host:', NATIVE_HOST_NAME);
  stats.connectionState = 'connecting';
  broadcastStatus();

  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);

    nativePort.onMessage.addListener((message) => {
      console.log('[Scraper] From native host:', message.type);
      handleNativeMessage(message);
    });

    nativePort.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError;
      console.log('[Scraper] Native host disconnected:', error?.message || 'unknown');
      nativePort = null;
      stats.connectionState = 'disconnected';
      broadcastStatus();

      // Try to reconnect if still enabled
      if (config.enabled) {
        setTimeout(() => connectToNativeHost(), config.reconnectInterval);
      }
    });

    // Native host starts HTTP server automatically on connection
    stats.connectionState = 'connected';
    broadcastStatus();

  } catch (error) {
    console.error('[Scraper] Failed to connect to native host:', error);
    stats.connectionState = 'disconnected';
    broadcastStatus();
  }
}

function disconnectFromNativeHost() {
  if (nativePort) {
    nativePort.disconnect();
    nativePort = null;
  }
  stats.connectionState = 'disconnected';
  broadcastStatus();
  console.log('[Scraper] Disconnected from native host');
}

function sendToNativeHost(data) {
  if (nativePort) {
    nativePort.postMessage(data);
    return true;
  }
  return false;
}

function handleNativeMessage(message) {
  // Native host now sends SCRAPE commands directly (no wrapper)
  switch (message.type) {
    case 'SCRAPE':
      handleScrapeCommand(message);
      break;

    case 'PING':
      sendToNativeHost({ type: 'PONG', timestamp: new Date().toISOString() });
      break;

    case 'CANCEL':
      console.log('[Scraper] Cancel requested');
      break;

    default:
      console.log('[Scraper] Unknown message type:', message.type);
  }
}

async function handleScrapeCommand(message) {
  const { taskId, url, options = {} } = message;

  if (!url) {
    sendToNativeHost({
      type: 'RESULT',
      taskId,
      success: false,
      error: 'URL is required',
      status_code: 0,
      final_url: url,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (isProcessing) {
    sendToNativeHost({
      type: 'RESULT',
      taskId,
      success: false,
      error: 'Already processing another task',
      status_code: 0,
      final_url: url,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  isProcessing = true;
  broadcastStatus();

  // Notify native host we're starting
  sendToNativeHost({
    type: 'STATUS',
    status: 'processing',
    taskId,
    timestamp: new Date().toISOString(),
  });

  let tab = null;
  let statusCode = 200;
  let finalUrl = url;

  try {
    // Create new tab
    tab = await chrome.tabs.create({
      url,
      active: false,
    });

    // Wait for page to load
    const timeout = options.timeout || config.pageLoadTimeout;
    const loadResult = await waitForTabLoadWithStatus(tab.id, url, timeout);
    statusCode = loadResult.statusCode || 200;

    // Additional wait if specified
    if (options.waitFor) {
      await sleep(options.waitFor);
    } else {
      await sleep(1000);
    }

    // Get final URL after any redirects
    const tabInfo = await chrome.tabs.get(tab.id);
    finalUrl = tabInfo.url || url;

    // Extract content
    const content = await getPageContent(tab.id);

    if (!content) {
      throw new Error('Failed to extract page content');
    }

    // Send result
    sendToNativeHost({
      type: 'RESULT',
      taskId,
      url,
      final_url: finalUrl,
      success: true,
      html: content.html,
      title: content.title,
      status_code: statusCode,
      timestamp: new Date().toISOString(),
    });

    stats.totalScraped++;
    stats.lastActivity = new Date().toISOString();
    console.log('[Scraper] Task completed:', taskId, 'status:', statusCode, 'final_url:', finalUrl);

  } catch (error) {
    console.error('[Scraper] Task error:', error.message);
    stats.errors++;
    stats.lastActivity = new Date().toISOString();

    let errorStatusCode = 0;
    if (error.message.includes('net::ERR_')) {
      errorStatusCode = 0;
    } else if (error.message.includes('403')) {
      errorStatusCode = 403;
    } else if (error.message.includes('404')) {
      errorStatusCode = 404;
    } else if (error.message.includes('500')) {
      errorStatusCode = 500;
    }

    sendToNativeHost({
      type: 'RESULT',
      taskId,
      url,
      final_url: finalUrl,
      success: false,
      error: error.message,
      status_code: errorStatusCode,
      timestamp: new Date().toISOString(),
    });

  } finally {
    if (tab) {
      try {
        await chrome.tabs.remove(tab.id);
      } catch (e) {
        // Tab might already be closed
      }
    }

    isProcessing = false;
    broadcastStatus();

    // Notify native host we're ready again
    sendToNativeHost({
      type: 'STATUS',
      status: 'ready',
      timestamp: new Date().toISOString(),
    });
  }
}

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

    if (chrome.webRequest) {
      webRequestListener = (details) => {
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
    final_url: activeTab.url,
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
