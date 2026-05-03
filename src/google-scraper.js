/**
 * google-scraper.js
 * Injected into Google Search pages opened by the extension's silent mode.
 * Waits for the AI answer to appear, extracts the language name, and sends
 * it back to background.js to be displayed in the floating player.
 */

(async () => {
  function logDebug(msg, data) {
    chrome.runtime.sendMessage({ type: "DEBUG_LOG", msg, data }).catch(() => {});
  }

  logDebug("Scraper injected, checking silent status...");

  const isSilent = await new Promise(resolve => {
    chrome.runtime.sendMessage({ type: "CHECK_SILENT_TAB" }, resolve);
  });

  logDebug(`CHECK_SILENT_TAB returned: ${isSilent}`);
  if (!isSilent) return;

  logDebug("Silent status confirmed. Waiting for page to load AI response...");

  // Known languages — we scan for these to find the AI's one-word answer.
  const KNOWN_LANGUAGES = new Set([
    "Hindi", "Telugu", "Tamil", "Kannada", "Malayalam", "Marathi", "Bengali",
    "Gujarati", "Punjabi", "Odia", "Urdu", "Sanskrit", "Assamese", "Maithili",
    "English", "Spanish", "French", "German", "Portuguese", "Russian",
    "Japanese", "Chinese", "Korean", "Arabic", "Turkish", "Italian",
    "Dutch", "Polish", "Swedish", "Greek", "Hebrew", "Thai", "Indonesian",
    "Vietnamese", "Persian", "Swahili", "Nepali", "Sinhala", "Burmese",
    "Khmer", "Lao", "Tibetan", "Mongolian", "Ukrainian", "Romanian",
    "Czech", "Slovak", "Hungarian", "Finnish", "Norwegian", "Danish",
    "Catalan", "Afrikaans", "Zulu", "Amharic", "Hausa", "Yoruba", "Igbo",
    "Tagalog", "Malay", "Javanese", "Sundanese", "Cebuano", "Hmong",
    "Latvian", "Lithuanian", "Estonian", "Azerbaijani", "Kazakh", "Uzbek",
    "Pashto", "Sindhi", "Kurdish", "Somali", "Albanian", "Serbian",
    "Croatian", "Bosnian", "Macedonian", "Bulgarian", "Belarusian",
    "Georgian", "Armenian", "Basque", "Welsh", "Irish", "Scots", "Latin",
    "Konkani", "Tulu", "Bodo", "Dogri", "Kashmiri", "Manipuri", "Santali"
  ]);

  const MAX_WAIT_MS = 20000;
  const POLL_INTERVAL_MS = 500;
  const maxAttempts = MAX_WAIT_MS / POLL_INTERVAL_MS;

  let extractedLanguage = null;
  let attempt = 0;

  while (attempt < maxAttempts) {
    // Get all text from the entire visible page body
    const allText = document.body ? document.body.innerText : "";

    if (allText.length > 100) {
      // Try to find a known language name in the page text
      // Look for lines that are just a language name (common in AI responses)
      const lines = allText.split(/\n/).map(l => l.trim()).filter(l => l.length > 0);

      logDebug(`Attempt ${attempt}: page has ${lines.length} lines, ${allText.length} chars`);

      for (const line of lines) {
        // Check if any known language name matches a line exactly or starts the line
        for (const lang of KNOWN_LANGUAGES) {
          if (line === lang || line.startsWith(lang + " ") || line.startsWith(lang + ".") || line.startsWith(lang + "\n")) {
            logDebug(`Found language match: "${lang}" in line: "${line.substring(0, 60)}"`);
            extractedLanguage = lang;
            break;
          }
        }
        if (extractedLanguage) break;
      }
    } else {
      logDebug(`Attempt ${attempt}: page text too short (${allText.length} chars), still loading...`);
    }

    if (extractedLanguage) break;

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    attempt++;
  }

  logDebug(`Loop exited. extractedLanguage=${extractedLanguage}, attempt=${attempt}`);

  const finalResult = extractedLanguage
    || "Language not found. Google AI may not have answered yet.";

  logDebug(`Sending SILENT_AI_RESULT: "${finalResult}"`);
  chrome.runtime.sendMessage({ type: "SILENT_AI_RESULT", text: finalResult });
})();
