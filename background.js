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

async function sendToNativeHost(data) {
  if (nativePort) {
    const payload = await sanitizeNativeMessage(data);
    if (!payload) {
      return false;
    }
    nativePort.postMessage(payload);
    return true;
  }
  return false;
}

const MAX_NATIVE_MESSAGE_BYTES = 900 * 1024;
const HTML_TRUNCATION_SUFFIX = '\n<!-- truncated -->';

function utf8ByteLength(value) {
  return new TextEncoder().encode(value).length;
}

function truncateStringByBytes(value, maxBytes) {
  if (maxBytes <= 0) {
    return '';
  }
  const encoder = new TextEncoder();
  const bytes = encoder.encode(value);
  if (bytes.length <= maxBytes) {
    return value;
  }
  const decoder = new TextDecoder('utf-8');
  return decoder.decode(bytes.slice(0, maxBytes));
}

// Compress string using gzip and return base64 encoded result
async function compressToBase64(str) {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);

  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  writer.write(data);
  writer.close();

  const compressedChunks = [];
  const reader = cs.readable.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    compressedChunks.push(value);
  }

  // Combine chunks
  const totalLength = compressedChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const compressed = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of compressedChunks) {
    compressed.set(chunk, offset);
    offset += chunk.length;
  }

  // Convert to base64
  let binary = '';
  for (let i = 0; i < compressed.length; i++) {
    binary += String.fromCharCode(compressed[i]);
  }
  return btoa(binary);
}

async function sanitizeNativeMessage(message) {
  const raw = JSON.stringify(message);
  if (utf8ByteLength(raw) <= MAX_NATIVE_MESSAGE_BYTES) {
    return message;
  }

  if (typeof message.html !== 'string') {
    console.warn('[Scraper] Message too large and no html to truncate.');
    return {
      ...message,
      error: 'Message too large',
      success: false,
    };
  }

  // Try compression first
  const originalHtmlBytes = utf8ByteLength(message.html);
  console.log('[Scraper] HTML too large, attempting compression...', {
    originalHtmlBytes,
    maxBytes: MAX_NATIVE_MESSAGE_BYTES,
  });

  try {
    const compressedBase64 = await compressToBase64(message.html);
    const compressedMessage = {
      ...message,
      html: undefined,
      html_compressed: compressedBase64,
      compression: 'gzip+base64',
      original_html_bytes: originalHtmlBytes,
    };
    delete compressedMessage.html;

    const compressedSize = utf8ByteLength(JSON.stringify(compressedMessage));
    console.log('[Scraper] Compression result:', {
      originalHtmlBytes,
      compressedSize,
      compressionRatio: (compressedSize / originalHtmlBytes * 100).toFixed(1) + '%',
    });

    if (compressedSize <= MAX_NATIVE_MESSAGE_BYTES) {
      return compressedMessage;
    }

    console.warn('[Scraper] Even compressed message is too large, falling back to truncation');
  } catch (compressionError) {
    console.warn('[Scraper] Compression failed, falling back to truncation:', compressionError.message);
  }

  // Fallback to truncation
  const base = {
    ...message,
    html: '',
    truncated: true,
    original_html_bytes: originalHtmlBytes,
  };
  const baseBytes = utf8ByteLength(JSON.stringify(base));
  const remainingBytes = MAX_NATIVE_MESSAGE_BYTES - baseBytes;
  if (remainingBytes <= 0) {
    console.warn('[Scraper] Message too large even after dropping html.');
    return base;
  }

  const suffixBytes = utf8ByteLength(HTML_TRUNCATION_SUFFIX);
  const htmlBudget = Math.max(0, remainingBytes - suffixBytes);
  const truncatedHtml = `${truncateStringByBytes(message.html, htmlBudget)}${HTML_TRUNCATION_SUFFIX}`;
  console.warn('[Scraper] Truncated html to fit native message size.', {
    originalHtmlBytes,
    truncatedHtmlBytes: utf8ByteLength(truncatedHtml),
    maxBytes: MAX_NATIVE_MESSAGE_BYTES,
  });

  return {
    ...message,
    html: truncatedHtml,
    truncated: true,
    original_html_bytes: originalHtmlBytes,
  };
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
    await sendToNativeHost({
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
    await sendToNativeHost({
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
  await sendToNativeHost({
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

    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId !== undefined) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }

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

    await chrome.tabs.update(tab.id, { active: true });
    await sleep(250);

    // Extract content
    const content = await getPageContent(tab.id, {
      rootSelector: null,
      includeDocument: true,
      waitForShadowRoots: true,
      shadowRootTimeout: options.shadowRootTimeout || 5000,
      waitForSelector: options.waitForSelector,
      waitForSelectorTimeout: options.waitForSelectorTimeout || 10000,
      waitForSelectorPollInterval: options.waitForSelectorPollInterval || 250,
    });

    if (!content?.html) {
      console.warn('[Scraper] Empty HTML extracted for', finalUrl);
    } else {
      const shadowTemplates = (content.html.match(/shadowroot=/g) || []).length;
      console.log('[Scraper] HTML length:', content.html.length, 'shadow templates:', shadowTemplates);
    }

    if (!content) {
      throw new Error('Failed to extract page content');
    }

    // Send result
    await sendToNativeHost({
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

    await sendToNativeHost({
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
    await sendToNativeHost({
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

async function getPageContent(tabId, options = {}) {
  console.log('[Scraper] getPageContent start', {
    tabId,
    hasWaitForSelector: Boolean(options.waitForSelector),
    hasWaitForShadowRoots: Boolean(options.waitForShadowRoots),
  });
  
  if (options.waitForSelector) {
    const timeout = options.waitForSelectorTimeout || 10000;
    const pollInterval = options.waitForSelectorPollInterval || 250;
    const startedAt = Date.now();
    let selectorFound = false;

    while (Date.now() - startedAt < timeout) {
      const [{ result: selectorInfo } = {}] = await chrome.scripting.executeScript({
        target: { tabId },
        func: checkSelectorPresence,
        args: [options.waitForSelector],
      });

      if (selectorInfo?.found) {
        console.log('[Scraper][selector] found after', Date.now() - startedAt, 'ms', 'selector:', options.waitForSelector);
        selectorFound = true;
        break;
      }

      await sleep(pollInterval);
    }

    if (!selectorFound) {
      console.log('[Scraper][selector] not found after', Date.now() - startedAt, 'ms', 'selector:', options.waitForSelector);
    }
  }

  if (options.waitForShadowRoots) {
    const timeout = options.shadowRootTimeout || 5000;
    const pollInterval = options.shadowRootPollInterval || 250;
    const startedAt = Date.now();
    let shadowFound = false;

    while (Date.now() - startedAt < timeout) {
      const [{ result: shadowInfo } = {}] = await chrome.scripting.executeScript({
        target: { tabId },
        func: checkShadowRoots,
        world: 'MAIN',
      });

      console.log('[Scraper][shadow] check result:', shadowInfo);
      if (shadowInfo?.count > 0) {
        console.log('[Scraper][shadow] ready after', Date.now() - startedAt, 'ms', 'hosts:', shadowInfo.hosts);
        shadowFound = true;
        break;
      }

      await sleep(pollInterval);
    }

    if (!shadowFound) {
      console.log('[Scraper][shadow] none detected after', Date.now() - startedAt, 'ms');
    }
  }

  const pageOptions = {
    rootSelector: options.rootSelector,
    includeDocument: options.includeDocument,
  };

  let results = [];
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractPageContent,
      args: [pageOptions],
      world: 'MAIN',
    });
  } catch (error) {
    console.warn('[Scraper] executeScript failed:', error?.message || error);
    throw new Error(error?.message || 'Failed to inject content script');
  }

  console.log('[Scraper] executeScript results:', JSON.stringify(results, null, 2));

  const content = results[0]?.result || null;
  if (!content) {
    console.warn('[Scraper] getPageContent returned null - script likely threw an error');
  } else if (!content.html) {
    console.warn('[Scraper] getPageContent empty result', {
      tabId,
      error: content?.error || null,
      keys: Object.keys(content),
    });
  }
  return content;
}

async function buildDebugPayload() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!activeTab?.id) {
    console.warn('[Scraper][debug] no active tab');
    throw new Error('No active tab available');
  }
  console.log('[Scraper][debug] capturing active tab', {
    tabId: activeTab.id,
    url: activeTab.url,
  });

  const content = await getPageContent(activeTab.id, {
    rootSelector: null,
    includeDocument: true,
  });

  if (!content?.html) {
    console.warn('[Scraper][debug] empty content', {
      tabId: activeTab.id,
      error: content?.error || null,
    });
    throw new Error(content?.error || 'Failed to capture page content');
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
function extractPageContent({
  rootSelector,
  includeDocument = false,
} = {}) {
  const startTime = performance.now();
  try {
    console.log('[extractPageContent] start', { rootSelector, includeDocument });
    console.log('[extractPageContent] chrome.dom available:', typeof chrome !== 'undefined' && typeof chrome.dom !== 'undefined');
    console.log('[extractPageContent] chrome.dom.openOrClosedShadowRoot available:', typeof chrome !== 'undefined' && typeof chrome.dom?.openOrClosedShadowRoot === 'function');
    console.log('[extractPageContent] document.body.getHTML available:', typeof document.body.getHTML === 'function');

    function allShadowRoots(root) {
      const elements = [...root.querySelectorAll('*')].filter((el) => el instanceof HTMLElement);
      console.log('[allShadowRoots] elements count:', elements.length);

      const roots = elements
        .map((el) => {
          if (typeof chrome !== 'undefined' && typeof chrome.dom?.openOrClosedShadowRoot === 'function') {
            try {
              return chrome.dom.openOrClosedShadowRoot(el);
            } catch (e) {
              return el.shadowRoot;
            }
          }
          return el.shadowRoot;
        })
        .filter((o) => o);

      console.log('[allShadowRoots] shadow roots found:', roots.length);
      return [...roots, ...roots.flatMap(allShadowRoots)];
    }

    // If a specific selector is requested, extract just that element
    if (rootSelector) {
      const root = document.querySelector(rootSelector);
      console.log('[extractPageContent] rootSelector result:', root ? root.tagName : 'null');
      if (!root) {
        return {
          html: '',
          title: document.title,
          durationMs: Math.round(performance.now() - startTime),
        };
      }

      const shadowRoots = allShadowRoots(root);
      const attributes = Array.from(root.attributes)
        .map((attr) => `${attr.name}="${attr.value}"`)
        .join(' ');
      const tagName = root.tagName.toLowerCase();
      const innerHTML = typeof root.getHTML === 'function'
        ? root.getHTML({ shadowRoots })
        : root.innerHTML;

      console.log('[extractPageContent] rootSelector innerHTML length:', innerHTML.length);

      return {
        html: `<${tagName}${attributes ? ' ' + attributes : ''}>${innerHTML}</${tagName}>`,
        title: document.title,
        durationMs: Math.round(performance.now() - startTime),
      };
    }

    // Build full document content
    let content = '';
    console.log('[extractPageContent] document.childNodes count:', document.childNodes.length);

    for (const node of document.childNodes) {
      console.log('[extractPageContent] processing node:', node.nodeType, node.nodeName);

      switch (node) {
        case document.documentElement:
          console.log('[extractPageContent] matched documentElement, children count:', document.documentElement.children.length);
          for (const child of document.documentElement.children) {
            console.log('[extractPageContent] processing child:', child.tagName);
            if (child === document.body) {
              const bodyAttrs = Array.from(document.body.attributes)
                .map((attr) => `${attr.name}="${attr.value}"`)
                .join(' ');
              console.log('[extractPageContent] body attributes:', bodyAttrs);

              const shadowRoots = allShadowRoots(document.body);
              console.log('[extractPageContent] body shadow roots:', shadowRoots.length);

              let bodyContent;
              if (typeof document.body.getHTML === 'function') {
                bodyContent = document.body.getHTML({ shadowRoots });
                console.log('[extractPageContent] used getHTML, length:', bodyContent.length);
              } else {
                bodyContent = document.body.innerHTML;
                console.log('[extractPageContent] used innerHTML fallback, length:', bodyContent.length);
              }

              content +=
                '<body ' +
                bodyAttrs +
                '>' +
                bodyContent +
                '</body>';
            } else {
              content += child.outerHTML;
              console.log('[extractPageContent] added child outerHTML, content length now:', content.length);
            }
          }
          break;
        default:
          const serialized = new XMLSerializer().serializeToString(node);
          content += serialized;
          console.log('[extractPageContent] serialized node:', serialized.substring(0, 100));
          break;
      }
    }

    console.log('[extractPageContent] content length before wrap:', content.length);

    // Wrap in html tag if includeDocument is true
    if (includeDocument && document.documentElement) {
      const htmlAttributes = Array.from(document.documentElement.attributes)
        .map((attr) => `${attr.name}="${attr.value}"`)
        .join(' ');
      content = `<html${htmlAttributes ? ' ' + htmlAttributes : ''}>${content}</html>`;

      // Add doctype if present
      if (document.doctype) {
        const { name, publicId, systemId } = document.doctype;
        const publicPart = publicId ? ` PUBLIC "${publicId}"` : '';
        const systemPart = systemId ? ` "${systemId}"` : '';
        content = `<!DOCTYPE ${name}${publicPart}${systemPart}>${content}`;
      }
    }

    console.log('[extractPageContent] final content length:', content.length);

    return {
      html: content,
      title: document.title,
      durationMs: Math.round(performance.now() - startTime),
    };
  } catch (error) {
    console.error('[extractPageContent] error:', error);
    console.error('[extractPageContent] error stack:', error.stack);
    return null;
  }
}

function checkShadowRoots() {
  try {
    const chromeApi = globalThis.chrome;

    // Diagnostic info
    const diagnostics = {
      chromeExists: typeof chrome !== 'undefined',
      chromeDomExists: typeof chrome !== 'undefined' && typeof chrome.dom !== 'undefined',
      openOrClosedExists: typeof chrome !== 'undefined' && typeof chrome.dom?.openOrClosedShadowRoot === 'function',
      globalThisChromeExists: typeof globalThis.chrome !== 'undefined',
      globalThisChromeDomExists: typeof globalThis.chrome?.dom !== 'undefined',
    };

    const getShadowRoot = (node) => {
      if (!(node instanceof HTMLElement)) {
        return null;
      }
      if (chromeApi?.dom?.openOrClosedShadowRoot) {
        try {
          return chromeApi.dom.openOrClosedShadowRoot(node) || null;
        } catch (e) {
          return node.shadowRoot || null;
        }
      }
      return node.shadowRoot || null;
    };

    // Count elements with open shadowRoot (always accessible)
    const allElements = Array.from(document.querySelectorAll('*'));
    const openShadowCount = allElements.filter((el) => el.shadowRoot).length;

    const hostCandidates = allElements.filter((node) => getShadowRoot(node));
    const hosts = hostCandidates.slice(0, 5).map((node) => {
      const tag = node.tagName ? node.tagName.toLowerCase() : 'unknown';
      const id = node.id ? `#${node.id}` : '';
      const className = node.className ? `.${String(node.className).trim().replace(/\s+/g, '.')}` : '';
      return `${tag}${id}${className}`;
    });

    // Extra diagnostics
    const bodyLength = document.body?.innerHTML?.length || 0;
    const firstFewTags = allElements.slice(0, 10).map((el) => el.tagName.toLowerCase());
    const customElements = allElements.filter((el) => el.tagName.includes('-')).map((el) => el.tagName.toLowerCase());
    const uniqueCustomElements = [...new Set(customElements)];

    // Debug c-wiz specifically
    const cwizElements = Array.from(document.querySelectorAll('c-wiz'));
    const cwizDebug = cwizElements.slice(0, 3).map((el) => {
      let chromeDomResult = 'not called';
      let chromeDomError = null;
      if (chromeApi?.dom?.openOrClosedShadowRoot) {
        try {
          const result = chromeApi.dom.openOrClosedShadowRoot(el);
          chromeDomResult = result ? 'ShadowRoot' : 'null';
        } catch (e) {
          chromeDomError = e.message;
        }
      }
      return {
        tagName: el.tagName,
        shadowRoot: el.shadowRoot ? 'exists' : 'null',
        chromeDomResult,
        chromeDomError,
        hasChildNodes: el.childNodes.length,
        innerHTML: el.innerHTML.substring(0, 100),
      };
    });

    // Compare getHTML vs innerHTML
    const getHTMLLength = typeof document.body.getHTML === 'function'
      ? document.body.getHTML({ shadowRoots: [] }).length
      : 'N/A';
    const innerHTMLLength = document.body.innerHTML.length;

    // Check for the specific table content
    const targetTable = document.querySelector('table tbody tr td div');
    const tableContent = targetTable ? targetTable.textContent.substring(0, 100) : 'not found';
    const allTbodies = document.querySelectorAll('tbody').length;
    const allTables = document.querySelectorAll('table').length;

    // Deep dive into table structure
    const tbody2 = document.querySelectorAll('tbody')[1];
    const tbody2Debug = tbody2 ? {
      childCount: tbody2.children.length,
      innerHTML: tbody2.innerHTML.substring(0, 200),
      firstRowHTML: tbody2.querySelector('tr')?.innerHTML?.substring(0, 200) || 'no tr',
    } : 'tbody[1] not found';

    // Check all table cells
    const allTds = document.querySelectorAll('table td');
    const tdsWithText = Array.from(allTds).filter(td => td.textContent.trim().length > 0);
    const tdsSample = Array.from(allTds).slice(0, 5).map(td => ({
      text: td.textContent.substring(0, 50),
      html: td.innerHTML.substring(0, 100),
      childCount: td.children.length,
    }));

    return {
      count: hostCandidates.length,
      openShadowCount,
      hosts,
      diagnostics,
      totalElements: allElements.length,
      bodyLength,
      firstFewTags,
      customElementsCount: customElements.length,
      uniqueCustomElements: uniqueCustomElements.slice(0, 10),
      documentReadyState: document.readyState,
      url: window.location.href,
      cwizCount: cwizElements.length,
      cwizDebug,
      getHTMLLength,
      innerHTMLLength,
      allTables,
      allTbodies,
      tableContent,
      tbody2Debug,
      totalTds: allTds.length,
      tdsWithTextCount: tdsWithText.length,
      tdsSample,
    };
  } catch (error) {
    return {
      error: error.message,
      stack: error.stack,
    };
  }
}

function checkSelectorPresence(selector) {
  try {
    const node = document.querySelector(selector);
    return {
      found: Boolean(node),
    };
  } catch (error) {
    return {
      found: false,
      error: error.message,
    };
  }
}
