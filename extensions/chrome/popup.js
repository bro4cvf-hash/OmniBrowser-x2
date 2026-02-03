// Display extension ID
document.getElementById("extensionId").textContent = chrome.runtime.id;

// Check connection status
chrome.runtime.sendMessage({ type: "getStatus" }, (response) => {
  const statusEl = document.getElementById("status");

  if (response?.connected) {
    statusEl.className = "status connected";
    statusEl.innerHTML = `
      <span class="dot green"></span>
      <span>Connected to OmniBrowser CLI</span>
    `;
  } else {
    statusEl.className = "status disconnected";
    statusEl.innerHTML = `
      <span class="dot red"></span>
      <span>Not connected - run <code>omnibrowser</code> in terminal</span>
    `;
  }
});
