const YOUTUBE_SETTINGS_KEY = "settings:youtube-api-key";

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
    showMessage("Paste a YouTube Data API key before saving.", true);
    return;
  }

  await chrome.storage.local.set({
    [YOUTUBE_SETTINGS_KEY]: apiKey
  });

  updateStatus(apiKey);
  showMessage("YouTube API key saved.");
});

clearButton.addEventListener("click", async () => {
  await chrome.storage.local.remove(YOUTUBE_SETTINGS_KEY);
  apiKeyInput.value = "";
  updateStatus("");
  showMessage("YouTube API key cleared.");
});

toggleButton.addEventListener("click", () => {
  const isPassword = apiKeyInput.type === "password";
  apiKeyInput.type = isPassword ? "text" : "password";
  toggleButton.textContent = isPassword ? "Hide" : "Show";
});

async function loadSettings() {
  const saved = await chrome.storage.local.get([YOUTUBE_SETTINGS_KEY]);
  const apiKey = typeof saved[YOUTUBE_SETTINGS_KEY] === "string" ? saved[YOUTUBE_SETTINGS_KEY] : "";

  apiKeyInput.value = apiKey;
  updateStatus(apiKey);
}

function updateStatus(apiKey) {
  const hasYouTubeKey = Boolean(apiKey.trim());

  if (hasYouTubeKey) {
    statusBadge.textContent = "YouTube ready";
  } else {
    statusBadge.textContent = "Optional APIs off";
  }

  statusBadge.classList.toggle("is-ready", hasYouTubeKey);
  statusBadge.classList.toggle("is-missing", !hasYouTubeKey);
}

function showMessage(text, isError = false) {
  message.textContent = text;
  message.style.color = isError ? "#ffb4b4" : "#a7f3c2";
}
