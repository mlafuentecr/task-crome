const settingsForm = document.getElementById("settings-form");
const settingsMessage = document.getElementById("settingsMessage");
const googleStatus = document.getElementById("googleStatus");
const authorizeGoogleButton = document.getElementById("authorizeGoogle");
const disconnectGoogleButton = document.getElementById("disconnectGoogle");
const redirectUri = document.getElementById("redirectUri");
const validationSummary = document.getElementById("validationSummary");
const notionValidation = document.getElementById("notionValidation");
const googleValidation = document.getElementById("googleValidation");

const defaultSettings = {
  notionToken: "",
  notionDatabaseId: "",
  notionTitleProperty: "Name",
  notionNotesProperty: "Notes",
  notionDueDateProperty: "Due",
  notionCompletedProperty: "",
  googleClientId: "",
  googleClientSecret: "",
  googleTaskListId: "@default",
  autoSyncEnabled: false,
  autoSyncMinutes: 15,
  conflictStrategy: "manual"
};

initialize();

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setMessage("", "");

  const formData = new FormData(settingsForm);
  const payload = Object.fromEntries(formData.entries());
  const autoSyncEnabled = document.getElementById("autoSyncEnabled").checked;

  try {
    await chrome.storage.sync.set({
      notionToken: String(payload.notionToken || "").trim(),
      notionDatabaseId: String(payload.notionDatabaseId || "").trim(),
      notionTitleProperty: String(payload.notionTitleProperty || "Name").trim() || "Name",
      notionNotesProperty: String(payload.notionNotesProperty || "Notes").trim() || "Notes",
      notionDueDateProperty: String(payload.notionDueDateProperty || "Due").trim() || "Due",
      notionCompletedProperty: String(payload.notionCompletedProperty || "").trim(),
      googleClientId: String(payload.googleClientId || "").trim(),
      googleClientSecret: String(payload.googleClientSecret || "").trim(),
      googleTaskListId: String(payload.googleTaskListId || "@default").trim() || "@default",
      autoSyncEnabled,
      autoSyncMinutes: Math.max(5, Number(payload.autoSyncMinutes || 15) || 15),
      conflictStrategy: String(payload.conflictStrategy || "manual")
    });

    await chrome.runtime.sendMessage({ type: "sync-config-updated" });

    setMessage("Settings saved.", "success");
    await runValidation();
    await refreshGoogleStatus();
  } catch (error) {
    setMessage(error.message, "error");
  }
});

authorizeGoogleButton.addEventListener("click", async () => {
  setMessage("", "");

  try {
    const response = await chrome.runtime.sendMessage({ type: "google-auth" });
    if (!response?.ok) {
      throw new Error(response?.error || "Could not authorize Google.");
    }

    setMessage("Google Tasks authorized successfully.", "success");
    await runValidation();
    await refreshGoogleStatus();
  } catch (error) {
    setMessage(error.message, "error");
  }
});

disconnectGoogleButton.addEventListener("click", async () => {
  setMessage("", "");

  try {
    const response = await chrome.runtime.sendMessage({ type: "google-signout" });
    if (!response?.ok) {
      throw new Error(response?.error || "Could not sign out.");
    }

    setMessage("Google session signed out.", "success");
    await runValidation();
    await refreshGoogleStatus();
  } catch (error) {
    setMessage(error.message, "error");
  }
});

async function initialize() {
  const stored = await chrome.storage.sync.get(defaultSettings);
  redirectUri.textContent = chrome.identity.getRedirectURL("oauth2");

  for (const [key, value] of Object.entries(stored)) {
    const field = document.getElementById(key);
    if (field) {
      if (field.type === "checkbox") {
        field.checked = Boolean(value);
      } else {
        field.value = value;
      }
    }
  }

  await runValidation();
  await refreshGoogleStatus();
}

async function refreshGoogleStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "get-status" });
    if (!response?.ok) {
      throw new Error(response?.error || "Could not validate status.");
    }

    if (!response.status.googleConfigured) {
      googleStatus.textContent = "Add the Client ID to enable Google Tasks.";
      return;
    }

    googleStatus.textContent = response.status.googleAuthenticated
      ? "Google Tasks connected."
      : "Google credentials saved. Google authorization is still required.";
  } catch (error) {
    googleStatus.textContent = error.message;
  }
}

function setMessage(text, type) {
  settingsMessage.textContent = text;
  settingsMessage.className = `message ${type}`.trim();
}

async function runValidation() {
  validationSummary.textContent = "Checking connections...";
  validationSummary.className = "message";
  notionValidation.textContent = "Checking Notion...";
  googleValidation.textContent = "Checking Google Tasks...";

  try {
    const response = await chrome.runtime.sendMessage({ type: "validate-connections" });
    if (!response?.ok) {
      throw new Error(response?.error || "Could not validate connections.");
    }

    const result = response.result;
    notionValidation.textContent = `${result.notion.label}: ${result.notion.detail}`;
    googleValidation.textContent = `${result.google.label}: ${result.google.detail}`;
    validationSummary.textContent = result.allHealthy
      ? "Everything looks connected."
      : `Checked at ${new Intl.DateTimeFormat("en", { dateStyle: "short", timeStyle: "short" }).format(new Date(result.checkedAt))}. Review the notes below.`;
    validationSummary.className = `message ${result.allHealthy ? "success" : ""}`.trim();
  } catch (error) {
    validationSummary.textContent = error.message;
    validationSummary.className = "message error";
    notionValidation.textContent = "Validation could not be completed.";
    googleValidation.textContent = "Validation could not be completed.";
  }
}
