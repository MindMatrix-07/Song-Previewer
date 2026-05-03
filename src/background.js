const ITUNES_SEARCH_URL = "https://itunes.apple.com/search";
const YOUTUBE_SEARCH_URL = "https://www.googleapis.com/youtube/v3/search";
const OFFSCREEN_URL = "src/offscreen.html";
const CACHE_TTL_MS = 1000 * 60 * 60 * 24;
const CACHE_VERSION = 10;
const YOUTUBE_SETTINGS_KEY = "settings:youtube-api-key";
const SEARCH_MODE_KEY = "settings:search-mode";
const SIDEPANEL_TIMEOUT_KEY = "settings:sidepanel-timeout";
const SIDEPANEL_QUERY_SESSION_KEY = "session:sidepanel-query";
const SIDEPANEL_FOLLOWUP_SESSION_KEY = "session:sidepanel-followup";
const SIDEPANEL_ALARM = "sidepanel-autoclose";
const SIDEPANEL_TABID_SESSION_KEY = "session:sidepanel-tabid";
const DEFAULT_SIDEPANEL_TIMEOUT = 10;

let creatingOffscreenDocument;

// Track states
let cachedSearchMode = "silent";
let cachedSidePanelTimeout = DEFAULT_SIDEPANEL_TIMEOUT;

chrome.storage.local.get([SEARCH_MODE_KEY, SIDEPANEL_TIMEOUT_KEY]).then((saved) => {
  cachedSearchMode = typeof saved[SEARCH_MODE_KEY] === "string" ? saved[SEARCH_MODE_KEY] : "silent";
  cachedSidePanelTimeout = typeof saved[SIDEPANEL_TIMEOUT_KEY] === "number"
    ? saved[SIDEPANEL_TIMEOUT_KEY]
    : DEFAULT_SIDEPANEL_TIMEOUT;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[SEARCH_MODE_KEY]) {
    cachedSearchMode = typeof changes[SEARCH_MODE_KEY].newValue === "string" ? changes[SEARCH_MODE_KEY].newValue : "silent";
  }
  if (changes[SIDEPANEL_TIMEOUT_KEY]) {
    cachedSidePanelTimeout = typeof changes[SIDEPANEL_TIMEOUT_KEY].newValue === "number"
      ? changes[SIDEPANEL_TIMEOUT_KEY].newValue
      : DEFAULT_SIDEPANEL_TIMEOUT;
  }
});

// Rolling debug log (last 30 entries).
const debugLog = [];
function dbg(msg, data = {}) {
  const entry = { ts: new Date().toISOString().slice(11, 23), msg, data };
  debugLog.push(entry);
  if (debugLog.length > 30) debugLog.shift();
  console.log(`[SongPreviewer BG] ${msg}`, data);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "SONG_PREVIEW_FROM_SELECTION") {
    handleSelectionPreview(message.text, message.context, message.resultOffset)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Preview failed."
        });
      });

    return true;
  }

  if (message?.type === "STOP_SONG_PREVIEW") {
    stopPreview()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Could not stop preview."
        });
      });

    return true;
  }

  if (message?.type === "SEARCH_SONG_LANGUAGE") {
    dbg("SEARCH_SONG_LANGUAGE received", { query: message.query, cachedSearchMode });

    // Do the async follow-up work
    handleSongLanguageSearch(message.query, sender)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        dbg("SEARCH_SONG_LANGUAGE async error", { error: err?.message });
        sendResponse({ ok: false, error: err?.message });
      });
    return true;
  }

  if (message?.type === "CHECK_SILENT_TAB") {
    chrome.storage.local.get("silentTabs").then(data => {
      const silentTabs = data.silentTabs || {};
      sendResponse(!!silentTabs[sender.tab?.id]);
    });
    return true;
  }

  if (message?.type === "SILENT_AI_RESULT") {
    const silentTabId = sender.tab?.id;
    const resultText = message.text;

    chrome.storage.local.get("silentTabs").then(async (data) => {
      const silentTabs = data.silentTabs || {};
      const silentInfo = silentTabs[silentTabId];
      if (silentTabId && silentInfo) {
        const callerTabId = silentInfo.callerTabId;
        const isWindow = silentInfo.isWindow;
        delete silentTabs[silentTabId];
        await chrome.storage.local.set({ silentTabs });

        // Close the silent tab or its window
        if (isWindow) {
          try {
            const tabInfo = await chrome.tabs.get(silentTabId);
            if (tabInfo && tabInfo.windowId) {
              chrome.windows.remove(tabInfo.windowId).catch(() => {});
            }
          } catch {}
        } else {
          try { chrome.tabs.remove(silentTabId); } catch {}
        }
        
        try { chrome.alarms.clear(`KILL_SILENT_TAB_${silentTabId}`); } catch {}

        // Send the result to the caller tab
        if (callerTabId) {
          chrome.tabs.sendMessage(callerTabId, {
            type: "SHOW_AI_LANGUAGE",
            text: resultText
          }).catch(() => {});
        }
      }
    });
    return true;
  }

  if (message?.type === "GET_DEBUG_INFO") {
    chrome.storage.local.get([
      SEARCH_MODE_KEY,
      SIDEPANEL_TIMEOUT_KEY,
      YOUTUBE_SETTINGS_KEY
    ]).then(async (localData) => {
      let sessionData = {};
      try { sessionData = await chrome.storage.session.get(null); } catch {}
      let alarms = [];
      try { alarms = await chrome.alarms.getAll(); } catch {}

      sendResponse({
        searchMode: localData[SEARCH_MODE_KEY],
        sidePanelTimeout: localData[SIDEPANEL_TIMEOUT_KEY],
        cachedSearchMode,
        cachedSidePanelTimeout,
        hasYouTubeKey: Boolean(localData[YOUTUBE_SETTINGS_KEY]),
        hasSidePanelAPI: Boolean(chrome.sidePanel),
        sessionData,
        alarms: alarms.map(a => ({ name: a.name, scheduledTime: new Date(a.scheduledTime).toISOString() })),
        log: [...debugLog]
      });
    }).catch((err) => {
      sendResponse({ error: err?.message, log: [...debugLog] });
    });
    return true;
  }

  if (message?.type === "DEBUG_LOG") {
    dbg(`[Scraper] ${message.msg}`, message.data);
    return true;
  }


  return false;
});

// ---------------------------------------------------------------------------
// Silent Tab fail-safe alarm
// ---------------------------------------------------------------------------

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name.startsWith("KILL_SILENT_TAB_")) {
    const tabId = parseInt(alarm.name.replace("KILL_SILENT_TAB_", ""), 10);
    
    const data = await chrome.storage.local.get("silentTabs");
    const silentTabs = data.silentTabs || {};
    const silentInfo = silentTabs[tabId];
    
    if (silentInfo) {
      const callerTabId = silentInfo.callerTabId;
      const isWindow = silentInfo.isWindow;
      delete silentTabs[tabId];
      await chrome.storage.local.set({ silentTabs });

      // Kill the tab or window
      if (isWindow) {
        try {
          const tabInfo = await chrome.tabs.get(tabId);
          if (tabInfo && tabInfo.windowId) {
            chrome.windows.remove(tabInfo.windowId).catch(() => {});
          }
        } catch {}
      } else {
        try { chrome.tabs.remove(tabId); } catch {}
      }

      // Notify caller
      if (callerTabId) {
        chrome.tabs.sendMessage(callerTabId, {
          type: "SHOW_AI_LANGUAGE",
          text: "Google AI took too long. Please try Normal or Incognito search."
        }).catch(() => {});
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Song language: silent tab vs. tab logic
// ---------------------------------------------------------------------------

async function handleSongLanguageSearch(songQuery, sender) {
  const cleanQuery = songQuery.trim();
  const aiQuery = `What language is the song "${cleanQuery}"?`;

  const searchMode = cachedSearchMode;

  dbg("handleSongLanguageSearch (async)", { searchMode });

  if (searchMode === "silent") {
    // Extremely strict prompt so the AI never adds extra text
    const silentQuery = `What language is the song "${cleanQuery}"? Think and search web before showing results. Reply with ONLY the language name in a single word. Do not add any other text.`;
    await openSilentBackgroundTab(silentQuery, sender.tab?.id);
  } else if (searchMode === "incognito") {
    await openIncognitoWindow(aiQuery);
  } else {
    dbg("Falling back to normal tab", { reason: "setting is tab" });
    openLanguageInTab(aiQuery);
  }
}

async function openIncognitoWindow(aiQuery) {
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(aiQuery)}&udm=50`;

  let currentWin = null;
  try { currentWin = await chrome.windows.getLastFocused(); } catch {}

  const width = 420;
  let height = 900;
  let left = undefined;
  let top = undefined;

  if (currentWin && currentWin.left !== undefined && currentWin.width !== undefined && currentWin.height !== undefined) {
    height = currentWin.height;
    left = currentWin.left + currentWin.width - width;
    top = currentWin.top;
  }

  try {
    await chrome.windows.create({
      url: searchUrl,
      width, height, left, top,
      type: "popup",
      incognito: true
    });
  } catch (err) {
    dbg("Incognito failed (missing permission?), falling back to normal", { error: err?.message });
    openLanguageInTab(aiQuery);
  }
}

// Persistent background tab for silent searches
let silentTabId = null;

// Clean up if the user manually closes the silent tab
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === silentTabId) {
    silentTabId = null;
    dbg("Silent search tab was closed, will open a new one next time.");
  }
});

async function openSilentBackgroundTab(aiQuery, callerTabId) {
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(aiQuery)}&udm=50`;

  if (callerTabId) {
    chrome.tabs.sendMessage(callerTabId, {
      type: "SHOW_AI_LANGUAGE",
      text: "Search in progress..."
    }).catch(() => {});
  }

  // Known languages list
  const KNOWN_LANGUAGES = [
    "Arabic", "Assamese", "Bengali", "Bikol", "Brazilian Portuguese",
    "Bulgarian", "Cebuano", "Chinese", "Croatian", "Czech", "Danish",
    "Dutch", "English", "Finnish", "French", "German", "Greek",
    "Haitian Creole", "Haryanvi", "Hausa", "Hebrew", "Hindi", "Hungarian",
    "Igbo", "Indonesian", "Italian", "Japanese", "Javanese", "Korean",
    "Lingála", "Malay", "Malayalam", "Marathi", "Nepali", "Norwegian",
    "Odia", "Persian", "Punjabi", "Polish", "Portuguese", "Romanian",
    "Russian", "Sanskrit", "Shona", "Slovak", "Spanish", "Sundanese",
    "Swedish", "Tagalog", "Tamil", "Telugu", "Thai", "Tsonga", "Turkish",
    "Ukrainian", "Urdu", "Venda", "Vietnamese", "Yoruba", "Xhosa", "Zulu"
  ];

  let usingExistingTab = false;
  let baseTextLength = 0; // How much text was already in the chat before our question

  // --- Check if we have a live persistent tab ---
  if (silentTabId !== null) {
    try {
      await chrome.tabs.get(silentTabId); // throws if tab doesn't exist
      usingExistingTab = true;
      dbg(`Reusing existing silent tab ${silentTabId}, sending follow-up...`);

      // Snapshot the current text length so we only scan NEW replies
      const snapResults = await chrome.scripting.executeScript({
        target: { tabId: silentTabId },
        func: () => document.body?.innerText?.length || 0
      });
      baseTextLength = snapResults?.[0]?.result || 0;

      // Type the follow-up question into the existing AI chat
      await chrome.scripting.executeScript({
        target: { tabId: silentTabId },
        func: (query) => {
          const textareas = document.querySelectorAll("textarea");
          let box = null;
          for (const ta of textareas) {
            const ph = ta.placeholder?.toLowerCase() || "";
            if (ph.includes("follow up") || ph.includes("ask anything") || ph.includes("message")) {
              box = ta; break;
            }
          }
          if (!box) {
            // Fallback: just click the first visible textarea
            box = Array.from(textareas).find(t => t.offsetParent !== null);
          }
          if (box) {
            box.focus();
            const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
            nativeSetter.call(box, query);
            box.dispatchEvent(new Event("input", { bubbles: true }));
            setTimeout(() => {
              box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
              const btn = box.closest("form")?.querySelector('button[type="submit"], button[aria-label*="send" i]');
              if (btn) btn.click();
            }, 300);
          }
        },
        args: [aiQuery]
      });
    } catch {
      // Tab is gone
      silentTabId = null;
      usingExistingTab = false;
    }
  }

  // --- Open a new tab if we don't have a live one ---
  if (!usingExistingTab) {
    dbg(`Opening new silent background window (minimized)...`);
    // Open in a minimized window so it's completely out of sight
    const win = await chrome.windows.create({
      url: searchUrl,
      state: "minimized",
      focused: false
    });
    silentTabId = win.tabs[0].id;
    dbg(`New silent tab ${silentTabId} in window ${win.id}`);
    // Wait for the page + AI to load before first scan
    await new Promise(r => setTimeout(r, 4500));
  } else {
    // Shorter wait for follow-up response
    await new Promise(r => setTimeout(r, 2500));
  }

  // --- Poll for a language in the (new) text ---
  const MAX_WAIT_MS = 20000;
  const POLL_INTERVAL_MS = 800;
  const start = Date.now();
  let found = null;
  let captchaDetected = false;

  while (!found && !captchaDetected && (Date.now() - start) < MAX_WAIT_MS) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: silentTabId },
        func: (langs, baseLen) => {
          const fullText = document.body?.innerText || "";

          if (fullText.includes("detected unusual traffic") || fullText.includes("not a robot")) {
            return { lang: null, snippet: "", captcha: true };
          }

          // For first search (baseLen=0): scan only the LAST 2000 chars where
          // the AI response sits. For follow-ups: scan only the new text added.
          const textToScan = baseLen > 0
            ? fullText.substring(baseLen)
            : fullText.substring(Math.max(0, fullText.length - 2000));

          // Split into clean lines
          const lines = textToScan.split("\n").map(l => l.trim()).filter(l => l.length > 0);
          const snippet = lines.slice(0, 2).join(" | ").substring(0, 100);

          // Check line-by-line for strict equality or prefix (matches AI output reliably, ignores UI)
          for (const line of lines) {
            for (const lang of langs) {
              const lowerLine = line.toLowerCase();
              const lowerLang = lang.toLowerCase();
              
              if (lowerLine === lowerLang || 
                  lowerLine.startsWith(lowerLang + " ") || 
                  lowerLine.startsWith(lowerLang + ".") ||
                  lowerLine.startsWith("**" + lowerLang + "**") ||
                  lowerLine === `language: ${lowerLang}`) {
                return { lang, snippet, captcha: false };
              }
            }
          }
          return { lang: null, snippet, captcha: false };
        },
        args: [KNOWN_LANGUAGES, baseTextLength]
      });

      const res = results?.[0]?.result;
      if (res?.snippet) dbg(`[BG Poll] Snippet: ${res.snippet}`);

      if (res?.captcha) {
        captchaDetected = true;
        dbg(`[BG Poll] CAPTCHA detected! Making tab visible.`);
        break;
      }
      if (res?.lang) {
        found = res.lang;
        dbg(`[BG Poll] Found language: "${found}"`);
        break;
      }
    } catch (err) {
      dbg(`[BG Poll] executeScript error: ${err?.message}`);
      // Tab may have been closed mid-poll
      silentTabId = null;
      break;
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  if (captchaDetected) {
    chrome.tabs.update(silentTabId, { active: true }).catch(() => {});
    if (callerTabId) {
      chrome.tabs.sendMessage(callerTabId, {
        type: "SHOW_AI_LANGUAGE",
        text: "⚠️ Google CAPTCHA appeared. Please solve it in the tab that just opened, then click Song Language again."
      }).catch(() => {});
    }
    silentTabId = null; // Reset so next call opens a fresh tab
    return;
  }

  const finalResult = found || "Language not found. Try the Incognito Search mode.";
  dbg(`[BG Poll] Final: "${finalResult}"`);

  if (callerTabId) {
    chrome.tabs.sendMessage(callerTabId, {
      type: "SHOW_AI_LANGUAGE",
      text: finalResult
    }).catch(() => {});
  }
}

function openLanguageInTab(aiQuery) {
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(aiQuery)}&udm=50`;

  chrome.tabs.query({ url: "*://*.google.com/search*" }, (tabs) => {
    const tab = tabs.find(t => t.url && t.url.includes("udm=50"));

    if (tab) {
      chrome.windows.update(tab.windowId, { focused: true });
      chrome.tabs.update(tab.id, { active: true });

      chrome.tabs.sendMessage(tab.id, {
        type: "TYPE_FOLLOW_UP_QUESTION",
        query: aiQuery
      }).catch(() => {
        chrome.tabs.update(tab.id, { url: searchUrl });
      });
    } else {
      chrome.tabs.create({ url: searchUrl });
    }
  });
}

async function handleSelectionPreview(rawText, context = {}, resultOffset = 0) {
  const query = normalizeSelection(rawText);
  const artistHint = normalizeSelection(context.artistHint || "");
  const offset = Number.isInteger(resultOffset) && resultOffset > 0 ? resultOffset : 0;

  if (!query) {
    return { ok: false, error: "Select a song name first." };
  }

  const track = await findTrack(query, artistHint, offset);

  if (!track) {
    if (!await hasYouTubeApiKey()) {
      return { ok: false, error: "Apple had no preview. Add a YouTube API key to enable iframe fallback." };
    }

    return { ok: false, error: `No Apple preview or YouTube embed found for "${query}".` };
  }

  if (track.source === "YouTube") {
    return {
      ok: true,
      track,
      fallbackRequired: false
    };
  }

  if (!track.previewUrl) {
    return { ok: false, error: `No playable preview found for "${query}".` };
  }

  const playback = await playPreview(track.previewUrl);

  return {
    ok: playback.ok,
    error: playback.error,
    track,
    fallbackRequired: !playback.ok
  };
}

async function findTrack(query, artistHint = "", resultOffset = 0) {
  const cacheKey = `preview:v${CACHE_VERSION}:${query.toLowerCase()}:${artistHint.toLowerCase()}:${resultOffset}`;
  const cached = await chrome.storage.local.get(cacheKey);
  const cachedItem = cached[cacheKey];

  if (cachedItem && Date.now() - cachedItem.savedAt < CACHE_TTL_MS) {
    return cachedItem.track;
  }

  const searchTerms = getSearchTerms(query, artistHint);
  const itunesResults = [];

  for (const term of searchTerms) {
    itunesResults.push(
      ...(await safeSearchItunes(term, "IN")),
      ...(await safeSearchItunes(term, "US"))
    );
  }

  const appleCandidates = rankAppleMatches(query, dedupeResults(itunesResults), artistHint);
  const best = appleCandidates[resultOffset] || await searchYouTube(query, artistHint, Math.max(0, resultOffset - appleCandidates.length));

  if (!best) {
    return null;
  }

  const track = {
    trackName: best.displayTrackName || best.trackName,
    artistName: best.displayArtistName || best.artistName,
    collectionName: best.collectionName,
    previewUrl: best.previewUrl || null,
    artworkUrl100: best.artworkUrl100,
    trackViewUrl: best.trackViewUrl,
    youtubeVideoId: best.youtubeVideoId || null,
    youtubeEmbedUrl: best.youtubeEmbedUrl || null,
    providerTrackName: best.providerTrackName || best.trackName,
    providerArtistName: best.providerArtistName || best.artistName,
    source: best.source || "Apple Music",
    primaryGenreName: best.primaryGenreName || null
  };

  await chrome.storage.local.set({
    [cacheKey]: {
      savedAt: Date.now(),
      track
    }
  });

  return track;
}

async function safeSearchItunes(query, country) {
  try {
    return await searchItunes(query, country);
  } catch {
    return [];
  }
}

async function searchItunes(query, country) {
  const url = new URL(ITUNES_SEARCH_URL);
  url.searchParams.set("term", query);
  url.searchParams.set("entity", "song");
  url.searchParams.set("limit", "5");
  url.searchParams.set("media", "music");
  url.searchParams.set("country", country);

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error(`iTunes search failed with HTTP ${response.status}.`);
  }

  const data = await response.json();
  const results = Array.isArray(data.results) ? data.results : [];
  return results.map((result) => ({
    ...result,
    source: "Apple Music"
  }));
}

async function searchYouTube(query, artistHint = "", resultOffset = 0) {
  const apiKey = await getYouTubeApiKey();

  if (!apiKey) {
    return null;
  }

  const url = new URL(YOUTUBE_SEARCH_URL);
  url.searchParams.set("part", "snippet");
  url.searchParams.set("q", `${query} ${artistHint} official song`.trim());
  url.searchParams.set("type", "video");
  url.searchParams.set("videoCategoryId", "10");
  url.searchParams.set("videoEmbeddable", "true");
  url.searchParams.set("maxResults", "5");
  url.searchParams.set("key", apiKey);

  const response = await fetch(url.toString());

  if (!response.ok) {
    return null;
  }

  const data = await response.json();
  const results = Array.isArray(data.items) ? data.items : [];
  const youtubeCandidates = rankYouTubeMatches(query, results, artistHint);
  const best = youtubeCandidates[resultOffset] || null;

  if (!best?.id?.videoId) {
    return null;
  }

  const videoId = best.id.videoId;
  const title = best.snippet?.title || query;
  const channel = best.snippet?.channelTitle || "YouTube";
  const thumbnail = best.snippet?.thumbnails?.medium?.url || best.snippet?.thumbnails?.default?.url;

  return {
    trackName: query,
    artistName: artistHint || decodeHtmlEntities(channel),
    collectionName: "YouTube",
    previewUrl: null,
    artworkUrl100: thumbnail,
    trackViewUrl: `https://www.youtube.com/watch?v=${videoId}`,
    youtubeVideoId: videoId,
    youtubeEmbedUrl: `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&start=60&rel=0&modestbranding=1`,
    providerTrackName: decodeHtmlEntities(title),
    providerArtistName: decodeHtmlEntities(channel),
    source: "YouTube",
    primaryGenreName: null
  };
}

async function hasYouTubeApiKey() {
  return Boolean(await getYouTubeApiKey());
}

async function getYouTubeApiKey() {
  const saved = await chrome.storage.local.get(YOUTUBE_SETTINGS_KEY);
  const apiKey = saved[YOUTUBE_SETTINGS_KEY];

  return typeof apiKey === "string" ? apiKey.trim() : "";
}

// ---------------------------------------------------------------------------
// Track ranking helpers
// ---------------------------------------------------------------------------

function dedupeResults(results) {
  const seen = new Set();

  return results.filter((result) => {
    const key = `${result.trackName || ""}:${result.artistName || ""}:${result.previewUrl || ""}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function getSearchTerms(query, artistHint) {
  return artistHint ? [`${query} ${artistHint}`, query] : [query];
}

function rankAppleMatches(query, results, artistHint = "") {
  const candidates = results.filter((result) => result.previewUrl);

  if (!candidates.length) {
    return [];
  }

  const normalizedQuery = normalizeForCompare(query);

  return candidates
    .map((candidate, index) => ({
      candidate,
      score: scoreCandidate(normalizedQuery, candidate, index, artistHint)
    }))
    .sort((a, b) => b.score - a.score)
    .filter((result) => result.score >= 130)
    .map((result) => result.candidate);
}

function scoreCandidate(normalizedQuery, candidate, index, artistHint = "") {
  const title = normalizeForCompare(candidate.trackName || "");
  const artist = normalizeForCompare(candidate.artistName || "");
  const album = normalizeForCompare(candidate.collectionName || "");
  const normalizedArtistHint = normalizeForCompare(artistHint);
  let score = 100 - index;

  if (title === normalizedQuery) score += 100;
  if (title.includes(normalizedQuery)) score += 45;
  if (normalizedQuery.includes(title) && title.length > 2) score += 30;
  if (`${title} ${artist}`.includes(normalizedQuery)) score += 20;
  if (`${title} ${artist} ${album}`.includes(normalizedQuery)) score += 10;
  if (tokenOverlap(normalizedQuery, title) >= 0.6) score += 42;
  if (normalizedArtistHint && artist.includes(normalizedArtistHint)) score += 35;

  return score;
}

function rankYouTubeMatches(query, results, artistHint = "") {
  const normalizedQuery = normalizeForCompare(query);
  const normalizedArtistHint = normalizeForCompare(artistHint);

  return results
    .filter((result) => result.id?.videoId)
    .map((candidate, index) => {
      const title = normalizeForCompare(candidate.snippet?.title || "");
      const channel = normalizeForCompare(candidate.snippet?.channelTitle || "");
      let score = 100 - index;

      if (title.includes(normalizedQuery)) score += 60;
      if (tokenOverlap(normalizedQuery, title) >= 0.6) score += 45;
      if (normalizedArtistHint && title.includes(normalizedArtistHint)) score += 25;
      if (normalizedArtistHint && channel.includes(normalizedArtistHint)) score += 25;
      if (title.includes("official")) score += 25;
      if (title.includes("audio")) score += 15;
      if (title.includes("lyric")) score += 8;
      if (channel.includes("official")) score += 20;
      if (title.includes("cover")) score -= 35;
      if (title.includes("karaoke")) score -= 45;
      if (title.includes("reaction")) score -= 45;

      return { candidate, score };
    })
    .sort((a, b) => b.score - a.score)
    .map((result) => result.candidate);
}

function tokenOverlap(source, target) {
  const sourceTokens = source.split(" ").filter((token) => token.length > 1);
  const targetTokens = new Set(target.split(" ").filter((token) => token.length > 1));

  if (!sourceTokens.length || !targetTokens.size) {
    return 0;
  }

  const matches = sourceTokens.filter((token) => targetTokens.has(token)).length;
  return matches / sourceTokens.length;
}

// ---------------------------------------------------------------------------
// Audio playback helpers
// ---------------------------------------------------------------------------

async function playPreview(previewUrl) {
  await ensureOffscreenDocument();

  try {
    return await chrome.runtime.sendMessage({
      type: "OFFSCREEN_PLAY_PREVIEW",
      previewUrl
    });
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Playback was blocked."
    };
  }
}

async function stopPreview() {
  await ensureOffscreenDocument();

  return chrome.runtime.sendMessage({
    type: "OFFSCREEN_STOP_PREVIEW"
  });
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen) {
    throw new Error("Offscreen API not supported.");
  }

  if (await hasOffscreenDocument()) {
    return;
  }

  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Play direct 30-second song previews when a user highlights a song title."
    });
  }

  await creatingOffscreenDocument;
  creatingOffscreenDocument = null;
}

async function hasOffscreenDocument() {
  if (!chrome.runtime.getContexts) {
    return false;
  }

  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  });

  return contexts.length > 0;
}

// ---------------------------------------------------------------------------
// Text normalization helpers
// ---------------------------------------------------------------------------

function normalizeSelection(text) {
  if (typeof text !== "string") {
    return "";
  }

  return text
    .replace(/\s+/g, " ")
    .replace(/[""]/g, "\"")
    .replace(/['']/g, "'")
    .trim()
    .slice(0, 120);
}

function normalizeForCompare(text) {
  return normalizeSelection(text)
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9\u00c0-\u024f\u0370-\u03ff\u0400-\u04ff\u0900-\u097f\u0d00-\u0d7f]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(text) {
  return String(text)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
