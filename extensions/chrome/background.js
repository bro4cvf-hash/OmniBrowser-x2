/**
 * OmniBrowser Chrome Extension - Background Service Worker
 *
 * Communicates with OmniBrowser CLI via Native Messaging.
 * Exposes browser automation capabilities without requiring Chrome restart.
 */

const NATIVE_HOST_NAME = "com.omnibrowser.host";

let nativePort = null;
let debuggerAttached = new Map(); // tabId -> attached

// ============================================================================
// Native Messaging
// ============================================================================

function connectToNativeHost() {
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);

    nativePort.onMessage.addListener((message) => {
      console.log("[OmniBrowser] Received from host:", message);
      handleNativeMessage(message);
    });

    nativePort.onDisconnect.addListener(() => {
      console.log("[OmniBrowser] Disconnected from native host");
      if (chrome.runtime.lastError) {
        console.error("[OmniBrowser] Error:", chrome.runtime.lastError.message);
      }
      nativePort = null;

      // Try to reconnect after a delay
      setTimeout(connectToNativeHost, 5000);
    });

    console.log("[OmniBrowser] Connected to native host");

    // Send initial handshake
    sendToHost({ type: "handshake", extensionId: chrome.runtime.id });

  } catch (error) {
    console.error("[OmniBrowser] Failed to connect:", error);
  }
}

function sendToHost(message) {
  if (nativePort) {
    nativePort.postMessage(message);
  } else {
    console.error("[OmniBrowser] Not connected to native host");
  }
}

// ============================================================================
// Message Handlers
// ============================================================================

async function handleNativeMessage(message) {
  const { id, action, params } = message;

  try {
    let result;

    switch (action) {
      case "ping":
        result = { pong: true, timestamp: Date.now() };
        break;

      case "getTabs":
        result = await getTabs();
        break;

      case "getActiveTab":
        result = await getActiveTab();
        break;

      case "createTab":
        result = await createTab(params.url);
        break;

      case "closeTab":
        result = await closeTab(params.tabId);
        break;

      case "navigate":
        result = await navigate(params.tabId, params.url);
        break;

      case "screenshot":
        result = await screenshot(params.tabId);
        break;

      case "getPageContent":
        result = await getPageContent(params.tabId);
        break;

      case "executeScript":
        result = await executeScript(params.tabId, params.code);
        break;

      case "click":
        result = await click(params.tabId, params.x, params.y);
        break;

      case "type":
        result = await type(params.tabId, params.text);
        break;

      case "getConsoleMessages":
        result = await getConsoleMessages(params.tabId);
        break;

      case "attachDebugger":
        result = await attachDebugger(params.tabId);
        break;

      case "detachDebugger":
        result = await detachDebugger(params.tabId);
        break;

      case "sendDebuggerCommand":
        result = await sendDebuggerCommand(params.tabId, params.method, params.commandParams);
        break;

      default:
        throw new Error(`Unknown action: ${action}`);
    }

    sendToHost({ id, success: true, result });

  } catch (error) {
    sendToHost({ id, success: false, error: error.message });
  }
}

// ============================================================================
// Tab Management
// ============================================================================

async function getTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.map(tab => ({
    id: tab.id,
    url: tab.url,
    title: tab.title,
    active: tab.active,
    windowId: tab.windowId,
    index: tab.index,
  }));
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return null;
  return {
    id: tab.id,
    url: tab.url,
    title: tab.title,
    windowId: tab.windowId,
  };
}

async function createTab(url = "about:blank") {
  const tab = await chrome.tabs.create({ url });
  return { id: tab.id, url: tab.url };
}

async function closeTab(tabId) {
  await chrome.tabs.remove(tabId);
  return { closed: true };
}

async function navigate(tabId, url) {
  await chrome.tabs.update(tabId, { url });

  // Wait for navigation to complete
  return new Promise((resolve) => {
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve({ navigated: true, url });
      }
    };
    chrome.tabs.onUpdated.addListener(listener);

    // Timeout after 30 seconds
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve({ navigated: true, url, timeout: true });
    }, 30000);
  });
}

// ============================================================================
// Screenshot
// ============================================================================

async function screenshot(tabId) {
  // Activate the tab first
  const tab = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });

  // Small delay to ensure tab is visible
  await new Promise(r => setTimeout(r, 100));

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "png"
  });

  // Return base64 data (strip the data:image/png;base64, prefix)
  const base64Data = dataUrl.replace(/^data:image\/png;base64,/, "");
  return { screenshot: base64Data };
}

// ============================================================================
// Page Content & Scripts
// ============================================================================

async function getPageContent(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      return {
        html: document.documentElement.outerHTML,
        text: document.body.innerText,
        title: document.title,
        url: window.location.href,
      };
    },
  });

  return results[0]?.result || null;
}

async function executeScript(tabId, code) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: new Function(code),
  });

  return results[0]?.result;
}

// ============================================================================
// Input Simulation (via Debugger API)
// ============================================================================

async function attachDebugger(tabId) {
  if (debuggerAttached.get(tabId)) {
    return { attached: true, alreadyAttached: true };
  }

  await chrome.debugger.attach({ tabId }, "1.3");
  debuggerAttached.set(tabId, true);
  return { attached: true };
}

async function detachDebugger(tabId) {
  if (!debuggerAttached.get(tabId)) {
    return { detached: true, wasNotAttached: true };
  }

  await chrome.debugger.detach({ tabId });
  debuggerAttached.delete(tabId);
  return { detached: true };
}

async function sendDebuggerCommand(tabId, method, commandParams = {}) {
  // Auto-attach if needed
  if (!debuggerAttached.get(tabId)) {
    await attachDebugger(tabId);
  }

  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, commandParams, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result);
      }
    });
  });
}

async function click(tabId, x, y) {
  await sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x, y,
    button: "left",
    clickCount: 1,
  });

  await sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x, y,
    button: "left",
  });

  return { clicked: true, x, y };
}

async function type(tabId, text) {
  for (const char of text) {
    await sendDebuggerCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyDown",
      text: char,
    });
    await sendDebuggerCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
    });
  }

  return { typed: true, length: text.length };
}

// ============================================================================
// Console Messages (via Debugger API)
// ============================================================================

const consoleMessages = new Map(); // tabId -> messages[]

async function getConsoleMessages(tabId) {
  // Enable console if not already
  if (!debuggerAttached.get(tabId)) {
    await attachDebugger(tabId);
    await sendDebuggerCommand(tabId, "Console.enable");
    await sendDebuggerCommand(tabId, "Runtime.enable");
  }

  return consoleMessages.get(tabId) || [];
}

// Listen for console messages
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method === "Console.messageAdded" || method === "Runtime.consoleAPICalled") {
    const tabId = source.tabId;
    if (!consoleMessages.has(tabId)) {
      consoleMessages.set(tabId, []);
    }
    consoleMessages.get(tabId).push({
      timestamp: Date.now(),
      method,
      params,
    });

    // Keep only last 100 messages per tab
    const messages = consoleMessages.get(tabId);
    if (messages.length > 100) {
      messages.shift();
    }
  }
});

// Clean up when debugger detaches
chrome.debugger.onDetach.addListener((source, reason) => {
  debuggerAttached.delete(source.tabId);
  console.log(`[OmniBrowser] Debugger detached from tab ${source.tabId}: ${reason}`);
});

// ============================================================================
// Initialization
// ============================================================================

// Connect on startup
connectToNativeHost();

// Also listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "getStatus") {
    sendResponse({
      connected: nativePort !== null,
      debuggerTabs: Array.from(debuggerAttached.keys()),
    });
  }
  return true;
});

console.log("[OmniBrowser] Background service worker started");
