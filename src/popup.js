const YOUTUBE_SETTINGS_KEY = "settings:youtube-api-key";
const GEMINI_SETTINGS_KEY = "settings:gemini-api-key";
const EXTENSION_ENABLED_KEY = "settings:extension-enabled";

const statusText = document.getElementById("statusText");
const openOptionsButton = document.getElementById("openOptions");
const extensionToggle = document.getElementById("extensionToggle");

initPopup();

openOptionsButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

extensionToggle.addEventListener("change", () => {
  chrome.storage.local.set({ [EXTENSION_ENABLED_KEY]: extensionToggle.checked });
});

async function initPopup() {
  const saved = await chrome.storage.local.get([YOUTUBE_SETTINGS_KEY, GEMINI_SETTINGS_KEY, EXTENSION_ENABLED_KEY]);
  
  const isEnabled = saved[EXTENSION_ENABLED_KEY] !== false;
  extensionToggle.checked = isEnabled;
  const apiKey = typeof saved[YOUTUBE_SETTINGS_KEY] === "string" ? saved[YOUTUBE_SETTINGS_KEY].trim() : "";
  const geminiApiKey = typeof saved[GEMINI_SETTINGS_KEY] === "string" ? saved[GEMINI_SETTINGS_KEY].trim() : "";

  if (apiKey && geminiApiKey) {
    statusText.textContent = "YouTube fallback and language detection are enabled.";
  } else if (apiKey) {
    statusText.textContent = "YouTube fallback is enabled.";
  } else if (geminiApiKey) {
    statusText.textContent = "Language detection is enabled.";
  } else {
    statusText.textContent = "Optional API keys are not set.";
  }
}
