const ITUNES_SEARCH_URL = "https://itunes.apple.com/search";
const YOUTUBE_SEARCH_URL = "https://www.googleapis.com/youtube/v3/search";
const OFFSCREEN_URL = "src/offscreen.html";
const CACHE_TTL_MS = 1000 * 60 * 60 * 24;
const CACHE_VERSION = 10;
const YOUTUBE_SETTINGS_KEY = "settings:youtube-api-key";

let creatingOffscreenDocument;

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
    const aiQuery = `What language is the song ${message.query}?`;
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(aiQuery)}&udm=50`;

    chrome.tabs.query({ url: "*://*.google.com/search*" }, (tabs) => {
      // Find a tab that has udm=50 in its URL (match patterns don't support query parameters)
      const tab = tabs.find(t => t.url && t.url.includes("udm=50"));

      if (tab) {
        // Reuse the found AI Mode tab by sending it a message to type the follow-up
        chrome.windows.update(tab.windowId, { focused: true });
        chrome.tabs.update(tab.id, { active: true });

        chrome.tabs.sendMessage(tab.id, {
          type: "TYPE_FOLLOW_UP_QUESTION",
          query: aiQuery
        }).catch(() => {
          // Fallback if the content script fails or isn't injected yet
          chrome.tabs.update(tab.id, { url: searchUrl });
        });
      } else {
        // Create a new tab if none exists
        chrome.tabs.create({ url: searchUrl });
      }
    });

    sendResponse({ ok: true });
    return true;
  }

  return false;
});

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
