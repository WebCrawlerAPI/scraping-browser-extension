const serverUrlInput = document.getElementById('serverUrl');
const pageLoadTimeoutInput = document.getElementById('pageLoadTimeout');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const reconnectBtn = document.getElementById('reconnectBtn');
const statusIndicator = document.getElementById('statusIndicator');
const connectionStatus = document.getElementById('connectionStatus');
const totalScrapedEl = document.getElementById('totalScraped');
const errorsEl = document.getElementById('errors');
const lastActivityEl = document.getElementById('lastActivity');
const debugBtn = document.getElementById('debugBtn');
const debugStatusEl = document.getElementById('debugStatus');

// Load current status
chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
  if (response) {
    updateUI(response);
  }
});

// Listen for status updates
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'STATUS_UPDATE') {
    updateUI(message);
  }
});

function updateUI({ config, stats, isProcessing }) {
  serverUrlInput.value = config.serverUrl;
  pageLoadTimeoutInput.value = config.pageLoadTimeout;

  // Update status indicator
  statusIndicator.className = 'status-indicator';

  if (isProcessing) {
    statusIndicator.classList.add('processing');
    connectionStatus.textContent = 'Processing...';
  } else if (stats.connectionState === 'connected') {
    statusIndicator.classList.add('connected');
    connectionStatus.textContent = 'Connected';
  } else if (stats.connectionState === 'connecting') {
    statusIndicator.classList.add('connecting');
    connectionStatus.textContent = 'Connecting...';
  } else {
    connectionStatus.textContent = 'Disconnected';
  }

  // Update buttons
  startBtn.disabled = config.enabled;
  stopBtn.disabled = !config.enabled;
  reconnectBtn.disabled = !config.enabled;

  // Update stats
  totalScrapedEl.textContent = stats.totalScraped;
  errorsEl.textContent = stats.errors;

  if (stats.lastActivity) {
    const date = new Date(stats.lastActivity);
    lastActivityEl.textContent = `Last activity: ${date.toLocaleTimeString()}`;
  }
}

function saveConfig() {
  const config = {
    serverUrl: serverUrlInput.value.trim(),
    pageLoadTimeout: parseInt(pageLoadTimeoutInput.value, 10) || 30000,
  };
  chrome.runtime.sendMessage({ type: 'UPDATE_CONFIG', config });
}

serverUrlInput.addEventListener('change', saveConfig);
pageLoadTimeoutInput.addEventListener('change', saveConfig);

startBtn.addEventListener('click', () => {
  saveConfig();
  chrome.runtime.sendMessage({ type: 'START' });
});

stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'STOP' });
});

reconnectBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'RECONNECT' });
});

const setDebugStatus = (text, isError = false) => {
  debugStatusEl.textContent = text;
  debugStatusEl.style.color = isError ? '#f87171' : '#9ca3af';
};

debugBtn.addEventListener('click', () => {
  debugBtn.disabled = true;
  setDebugStatus('Collecting snapshot...');

  chrome.runtime.sendMessage({ type: 'DEBUG_PAYLOAD' }, (response) => {
    debugBtn.disabled = false;

    if (chrome.runtime.lastError) {
      const message = chrome.runtime.lastError.message || 'Unknown runtime error';
      console.warn('[Scraper][popup] runtime error:', message);
      setDebugStatus(`Failed: ${message}`, true);
      return;
    }

    if (!response?.success || !response.payload) {
      const message = response?.error || 'No payload captured';
      console.warn('[Scraper][popup] debug error:', message, response);
      setDebugStatus(`Failed: ${message}`, true);
      return;
    }

    const payloadText = JSON.stringify(response.payload, null, 2);

    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      setDebugStatus('Clipboard API is unavailable', true);
      return;
    }

    navigator.clipboard.writeText(payloadText)
      .then(() => setDebugStatus('Copied payload to clipboard'))
      .catch((error) => setDebugStatus(`Copy failed: ${error.message}`, true));
  });
});
