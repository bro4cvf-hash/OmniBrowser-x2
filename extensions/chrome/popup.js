const command = `omnibrowser install-host --extension-id ${chrome.runtime.id}`;
let connected = false;
let configuration = null;
let busy = false;
document.getElementById("openSidebar").addEventListener("click", async () => {
  try {
    const window = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: window.id });
  } catch {
    document.getElementById("sidebarFeedback").textContent = "Could not open the sidebar. Reload the extension in Chrome 116 or newer.";
  }
});
document.getElementById("extensionId").value = chrome.runtime.id;
document.getElementById("installCommand").textContent = command;

function refreshStatus() {
  chrome.runtime.sendMessage({ type: "getStatus" }, response => {
    const error = chrome.runtime.lastError;
    connected = !error && response?.connected === true && response?.relayAvailable === true;
    configuration = connected ? response.mcpConfig : null;
    document.getElementById("status").className = `status ${connected ? "connected" : "disconnected"}`;
    document.getElementById("statusTitle").textContent = connected ? "Chrome connected" : "Chrome disconnected";
    document.getElementById("statusDetail").textContent = connected
      ? "Ready to use tabs in this profile."
      : (response?.connectionError ? "Connection unavailable. Run the installer, then click Connect."
        : "Click Connect to allow your AI app to use this profile.");
    document.getElementById("toggleConnection").textContent = connected ? "Disconnect" : "Connect";
    document.getElementById("copyConfig").disabled = !configuration;
    document.getElementById("aiConfig").textContent = configuration
      ? JSON.stringify(configuration, null, 2) : "Connect to Chrome to show your settings.";
  });
}

document.getElementById("toggleConnection").addEventListener("click", () => {
  const button = document.getElementById("toggleConnection");
  busy = true;
  button.disabled = true;
  button.textContent = connected ? "Disconnecting…" : "Connecting…";
  chrome.runtime.sendMessage({ type: connected ? "disconnect" : "connect" }, () => {
    const error = chrome.runtime.lastError;
    if (error) document.getElementById("statusDetail").textContent = "Connection failed. Reload the extension and try again.";
    busy = false;
    button.disabled = false;
    refreshStatus();
  });
});

async function copyText(text, buttonId, feedbackId) {
  const button = document.getElementById(buttonId);
  button.disabled = true;
  try {
    await navigator.clipboard.writeText(text);
    document.getElementById(feedbackId).textContent = "Copied.";
  } catch {
    document.getElementById(feedbackId).textContent = "Select the settings above and copy them manually.";
  } finally {
    button.disabled = false;
  }
}

document.getElementById("copyCommand").addEventListener("click", () =>
  copyText(command, "copyCommand", "copyFeedback"));
document.getElementById("copyConfig").addEventListener("click", () => {
  if (configuration) return copyText(JSON.stringify(configuration, null, 2), "copyConfig", "configFeedback");
});

refreshStatus();
// Popup timers disappear when Chrome closes the popup.
setInterval(() => { if (!busy) refreshStatus(); }, 1000);
