const YOUTUBE_SETTINGS_KEY = "settings:youtube-api-key";
const SEARCH_MODE_KEY = "settings:search-mode";
const SIDEPANEL_TIMEOUT_KEY = "settings:sidepanel-timeout";
const AUTO_LOOKUP_KEY = "settings:auto-lookup";
const DEFAULT_TIMEOUT = 10;

// ── YouTube API key ─────────────────────────────────────────────────────────

const form = document.getElementById("settingsForm");
const apiKeyInput = document.getElementById("apiKey");
const clearButton = document.getElementById("clearKey");
const toggleButton = document.getElementById("toggleKey");
const statusBadge = document.getElementById("statusBadge");
const message = document.getElementById("message");

loadSettings();

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const apiKey = apiKeyInput.value.trim();

  if (!apiKey) {
    showMessage(message, "Paste a YouTube Data API key before saving.", true);
    return;
  }

  await chrome.storage.local.set({
    [YOUTUBE_SETTINGS_KEY]: apiKey
  });

  updateYouTubeStatus(apiKey);
  showMessage(message, "YouTube API key saved.");
});

clearButton.addEventListener("click", async () => {
  await chrome.storage.local.remove(YOUTUBE_SETTINGS_KEY);
  apiKeyInput.value = "";
  updateYouTubeStatus("");
  showMessage(message, "YouTube API key cleared.");
});

toggleButton.addEventListener("click", () => {
  const isPassword = apiKeyInput.type === "password";
  apiKeyInput.type = isPassword ? "text" : "password";
  toggleButton.textContent = isPassword ? "Hide" : "Show";
});

async function loadSettings() {
  const saved = await chrome.storage.local.get([
    YOUTUBE_SETTINGS_KEY,
    SEARCH_MODE_KEY,
    SIDEPANEL_TIMEOUT_KEY,
    AUTO_LOOKUP_KEY
  ]);

  // YouTube
  const apiKey = typeof saved[YOUTUBE_SETTINGS_KEY] === "string" ? saved[YOUTUBE_SETTINGS_KEY] : "";
  apiKeyInput.value = apiKey;
  updateYouTubeStatus(apiKey);

  // Side panel / Search Mode
  const searchMode = typeof saved[SEARCH_MODE_KEY] === "string" ? saved[SEARCH_MODE_KEY] : "silent";
  const timeout = typeof saved[SIDEPANEL_TIMEOUT_KEY] === "number"
    ? saved[SIDEPANEL_TIMEOUT_KEY]
    : DEFAULT_TIMEOUT;
  const autoLookupEnabled = saved[AUTO_LOOKUP_KEY] === true;

  searchModeSelect.value = searchMode;
  autolookupToggle.checked = autoLookupEnabled;
  sidepanelTimeout.value = timeout;
  applyTimeoutRowState(searchMode);
  updateSidePanelBadge(searchMode);
}

function updateYouTubeStatus(apiKey) {
  const hasYouTubeKey = Boolean(apiKey.trim());

  if (hasYouTubeKey) {
    statusBadge.textContent = "YouTube ready";
  } else {
    statusBadge.textContent = "Optional APIs off";
  }

  statusBadge.classList.toggle("is-ready", hasYouTubeKey);
  statusBadge.classList.toggle("is-missing", !hasYouTubeKey);
}

function showMessage(el, text, isError = false) {
  el.textContent = text;
  el.style.color = isError ? "#ffb4b4" : "#a7f3c2";
}

// ── Side Panel / Search Mode settings ────────────────────────────────────────

const sidepanelForm = document.getElementById("sidepanelForm");
const searchModeSelect = document.getElementById("searchMode");
const autolookupToggle = document.getElementById("autolookupToggle");
const sidepanelTimeout = document.getElementById("sidepanelTimeout");
const timeoutRow = document.getElementById("timeoutRow");
const sidepanelBadge = document.getElementById("sidepanelBadge");
const sidepanelMessage = document.getElementById("sidepanelMessage");
const incognitoWarning = document.getElementById("incognitoWarning");
const btnOpenExtSettings = document.getElementById("btnOpenExtSettings");

if (btnOpenExtSettings) {
  btnOpenExtSettings.addEventListener("click", () => {
    chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
  });
}

chrome.extension.isAllowedIncognitoAccess().then((isAllowed) => {
  if (!isAllowed) {
    incognitoWarning.style.display = "block";
  }
});

searchModeSelect.addEventListener("change", () => {
  const mode = searchModeSelect.value;
  applyTimeoutRowState(mode);
  updateSidePanelBadge(mode);
});

sidepanelForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const mode = searchModeSelect.value;
  const autoLookup = autolookupToggle.checked;
  const rawTimeout = parseInt(sidepanelTimeout.value, 10);
  const timeout = Number.isFinite(rawTimeout)
    ? Math.min(Math.max(rawTimeout, 5), 300)
    : DEFAULT_TIMEOUT;

  sidepanelTimeout.value = timeout;

  await chrome.storage.local.set({
    [SEARCH_MODE_KEY]: mode,
    [SIDEPANEL_TIMEOUT_KEY]: timeout,
    [AUTO_LOOKUP_KEY]: autoLookup
  });

  updateSidePanelBadge(mode);
  showMessage(sidepanelMessage, "Settings saved.");
});

function applyTimeoutRowState(mode) {
  const isSilent = mode === "silent";
  timeoutRow.classList.toggle("timeout-row--active", isSilent);
  timeoutRow.setAttribute("aria-hidden", String(!isSilent));
  sidepanelTimeout.disabled = !isSilent;
}

function updateSidePanelBadge(mode) {
  let text = "Silent";
  if (mode === "tab") text = "Normal Tab";
  if (mode === "incognito") text = "Incognito";

  sidepanelBadge.textContent = text;
  sidepanelBadge.classList.toggle("is-ready", mode === "silent" || mode === "tab" || mode === "incognito");
  sidepanelBadge.classList.toggle("is-missing", false);
}

