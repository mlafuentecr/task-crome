const launcherStatus = document.getElementById("launcherStatus");
const openSidePanelButton = document.getElementById("openSidePanel");
const openOptionsButton = document.getElementById("openOptions");
const openOptionsPrimaryButton = document.getElementById("openOptionsPrimary");

initialize();

openSidePanelButton.addEventListener("click", async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.windowId) {
      throw new Error("Could not find the active tab.");
    }

    await chrome.sidePanel.open({ windowId: tab.windowId });
    window.close();
  } catch (error) {
    launcherStatus.textContent = error.message || "Could not open the side panel.";
  }
});

openOptionsButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

openOptionsPrimaryButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

async function initialize() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "get-status" });
    if (!response?.ok) {
      throw new Error(response?.error || "Could not load status.");
    }

    const status = response.status;
    launcherStatus.textContent = [
      `Notion: ${status.notionConfigured ? "ready" : "pending"}`,
      `Google: ${status.googleConfigured ? "configured" : "pending"}`,
      `Auth: ${status.googleAuthenticated ? "connected" : "pending"}`
    ].join(" | ");
  } catch (error) {
    launcherStatus.textContent = error.message;
  }
}
