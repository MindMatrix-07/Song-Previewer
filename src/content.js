const MIN_SELECTION_LENGTH = 3;
const MAX_SELECTION_LENGTH = 120;
const SELECTION_DELAY_MS = 80;
const PREVIEW_PANEL_TTL_MS = 31000;
const POSITION_PADDING = 12;
const MIN_CARD_WIDTH = 260;
const MIN_CARD_HEIGHT = 124;
const MAX_CARD_WIDTH = 560;
const MAX_CARD_HEIGHT = 460;
const DEFAULT_AUDIO_WIDTH = 556;
const DEFAULT_AUDIO_HEIGHT = 164;
const DEFAULT_YOUTUBE_WIDTH = 560;
const DEFAULT_YOUTUBE_HEIGHT = 420;
const DEFAULT_BOTTOM_OFFSET = 54;

let lastSelection = "";
let lastSelectionAt = 0;
let selectionTimer = null;
let fallbackAudio = null;
let fallbackTimer = null;
let panelTimer = null;
let floatingCard = null;
let draggedThisInteraction = false;
let lastPreviewRequest = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "TYPE_FOLLOW_UP_QUESTION") {
    const textareas = document.querySelectorAll("textarea");
    let followUpBox = null;

    for (const box of textareas) {
      const placeholder = box.placeholder?.toLowerCase() || "";
      if (placeholder.includes("follow up") || placeholder.includes("ask anything")) {
        followUpBox = box;
        break;
      }
    }

    if (followUpBox) {
      followUpBox.value = message.query;
      followUpBox.dispatchEvent(new Event("input", { bubbles: true }));
      followUpBox.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
      
      // Also try to find a nearby submit button just in case
      const submitBtn = followUpBox.parentElement?.querySelector('button[aria-label*="send" i], button[aria-label*="submit" i], button svg');
      if (submitBtn) {
        submitBtn.closest("button")?.click();
      }
    }
    sendResponse({ ok: true });
    return true;
  }
});

document.addEventListener("mouseup", (event) => {
  if (isInsideWidget(event)) {
    return;
  }

  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(handleSelection, SELECTION_DELAY_MS);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeWidget();
    return;
  }

  if (event.altKey && event.key.toLowerCase() === "p") {
    event.preventDefault();
    safeStorageGet("settings:extension-enabled").then(saved => {
      if (saved["settings:extension-enabled"] !== false) {
        replayLastPreview();
      }
    });
  }
});

document.addEventListener("selectionchange", () => {
  const selectedText = getSelectedText();

  if (!selectedText) {
    lastSelection = "";
  }
});

async function handleSelection() {
  const saved = await safeStorageGet("settings:extension-enabled");
  if (saved["settings:extension-enabled"] === false) {
    return;
  }

  const text = getSelectedText();

  const now = Date.now();

  if (!isUsableSelection(text) || (text === lastSelection && now - lastSelectionAt < 1200)) {
    return;
  }

  lastSelection = text;
  lastSelectionAt = now;
  showFloatingCard({
    state: "loading",
    message: "Finding preview..."
  });

  try {
    lastPreviewRequest = {
      text,
      context: {},
      resultOffset: 0
    };

    await playPreviewRequest(lastPreviewRequest);
  } catch (error) {
    showFloatingCard({
      state: "error",
      message: error instanceof Error ? error.message : "Preview failed."
    });
  }
}

async function playPreviewRequest(request) {
  await stopPreview();

  const response = await chrome.runtime.sendMessage({
    type: "SONG_PREVIEW_FROM_SELECTION",
    text: request.text,
    context: request.context,
    resultOffset: request.resultOffset
  });

  if (!response?.ok && !response?.track) {
    showFloatingCard({
      state: "error",
      message: response?.error || "No preview found."
    });
    return;
  }

  if (response.fallbackRequired) {
    showFloatingCard({
      state: "fallback",
      track: response.track,
      message: "Click to play"
    });
    return;
  }

  showFloatingCard({
    state: "playing",
    track: response.track,
    message: "Playing preview"
  });
}

async function replayLastPreview() {
  if (!lastPreviewRequest) {
    return;
  }

  showFloatingCard({
    state: "loading",
    message: "Replaying..."
  });

  await playPreviewRequest(lastPreviewRequest);
}

async function playNextMatch() {
  if (!lastPreviewRequest) {
    return;
  }

  lastPreviewRequest = {
    ...lastPreviewRequest,
    resultOffset: lastPreviewRequest.resultOffset + 1
  };

  showFloatingCard({
    state: "loading",
    message: "Trying next match..."
  });

  await playPreviewRequest(lastPreviewRequest);
}

function getSelectedText() {
  return window
    .getSelection()
    ?.toString()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SELECTION_LENGTH) || "";
}

function isUsableSelection(text) {
  if (!text || text.length < MIN_SELECTION_LENGTH) {
    return false;
  }

  if (/^https?:\/\//i.test(text)) {
    return false;
  }

  return /[\p{L}\p{N}]/u.test(text);
}

function getSelectionContext(selectedText) {
  const selection = window.getSelection();
  const node = selection?.anchorNode;
  const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;

  if (!(element instanceof Element)) {
    return {};
  }

  const selected = normalizeLine(selectedText);
  let bestText = "";
  let current = element;

  for (let depth = 0; current && depth < 6; depth += 1) {
    const text = current.innerText || current.textContent || "";
    const normalized = text.replace(/\s+\n/g, "\n").trim();

    if (
      normalized.includes(selectedText) &&
      normalized.length > selectedText.length &&
      normalized.length < 360
    ) {
      bestText = normalized;
      break;
    }

    current = current.parentElement;
  }

  if (!bestText) {
    return {};
  }

  const lines = bestText
    .split(/\n+/)
    .map(normalizeLine)
    .filter(Boolean);
  const selectedIndex = lines.findIndex((line) => line === selected || line.includes(selected));
  const artistHint = selectedIndex >= 0 ? cleanupArtistLine(lines[selectedIndex + 1] || "") : "";

  return {
    rowText: bestText,
    artistHint
  };
}

function normalizeLine(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

function cleanupArtistLine(text) {
  return normalizeLine(text)
    .replace(/\b\d{1,2}:\d{2}\b.*$/g, "")
    .replace(/\bMalayalam(?:-romaji)?\b.*$/i, "")
    .trim();
}

function showFloatingCard({ state, track, message }) {
  removeFloatingCard();

  floatingCard = document.createElement("div");
  floatingCard.className = `song-previewer-card song-previewer-card--${state}`;
  floatingCard.dataset.provider = getProviderLayoutName(track);

  if (track?.source === "YouTube" && track.youtubeEmbedUrl) {
    floatingCard.classList.add("song-previewer-card--youtube");
  } else {
    floatingCard.classList.add("song-previewer-card--audio");
  }

  const artworkWrap = document.createElement("div");
  artworkWrap.className = "song-previewer-artwork";

  if (track?.artworkUrl100) {
    const artwork = document.createElement("img");
    artwork.alt = "";
    artwork.decoding = "async";
    artwork.referrerPolicy = "no-referrer";
    artwork.src = getLargeArtworkUrl(track.artworkUrl100);
    artworkWrap.appendChild(artwork);
  } else {
    artworkWrap.textContent = "♪";
  }

  const info = document.createElement("div");
  info.className = "song-previewer-info";

  const providerBadge = createProviderBadge(track?.source);

  const title = document.createElement("div");
  title.className = "song-previewer-title";
  title.textContent = track?.trackName || message;

  const subtitle = document.createElement("div");
  subtitle.className = "song-previewer-subtitle";
  subtitle.textContent = getSubtitle(track, message);

  const badgeRow = document.createElement("div");
  badgeRow.className = "song-previewer-badge-row";
  badgeRow.append(providerBadge);

  info.append(badgeRow, title, subtitle);

  installDragToPosition(floatingCard, artworkWrap, info);

  const stopButton = document.createElement("button");
  stopButton.className = "song-previewer-icon-button";
  stopButton.type = "button";
  stopButton.title = "Stop preview";
  stopButton.setAttribute("aria-label", "Stop preview");
  stopButton.textContent = "×";
  stopButton.addEventListener("pointerdown", stopWidgetEvent);
  stopButton.addEventListener("mouseup", stopWidgetEvent);
  stopButton.addEventListener("click", (event) => {
    stopWidgetEvent(event);
    closeWidget();
  });

  const wrongButton = document.createElement("button");
  wrongButton.className = "song-previewer-wrong-button";
  wrongButton.type = "button";
  wrongButton.textContent = "Wrong match?";
  wrongButton.title = "Try the next result";
  wrongButton.addEventListener("pointerdown", stopWidgetEvent);
  wrongButton.addEventListener("mouseup", stopWidgetEvent);
  wrongButton.addEventListener("click", (event) => {
    stopWidgetEvent(event);
    playNextMatch();
  });

  const languageButton = document.createElement("button");
  languageButton.className = "song-previewer-language-button";
  languageButton.type = "button";
  languageButton.textContent = "Song Language";
  languageButton.title = "Search for song language";
  languageButton.addEventListener("pointerdown", stopWidgetEvent);
  languageButton.addEventListener("mouseup", stopWidgetEvent);
  languageButton.addEventListener("click", (event) => {
    stopWidgetEvent(event);
    chrome.runtime.sendMessage({
      type: "SEARCH_SONG_LANGUAGE",
      query: track?.providerTrackName || track?.trackName || message
    });
  });

  const actionsWrap = document.createElement("div");
  actionsWrap.className = "song-previewer-actions";
  actionsWrap.append(wrongButton, languageButton);

  if (track?.source === "YouTube" && track.youtubeEmbedUrl) {
    const iframe = document.createElement("iframe");
    iframe.className = "song-previewer-youtube-frame";
    iframe.src = track.youtubeEmbedUrl;
    iframe.title = track.trackName || "YouTube video player";
    iframe.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
    iframe.allowFullscreen = true;
    iframe.referrerPolicy = "strict-origin-when-cross-origin";

    const header = document.createElement("div");
    header.className = "song-previewer-youtube-header";
    header.append(info, actionsWrap, stopButton);

    floatingCard.append(iframe, header);
  } else {
    floatingCard.append(artworkWrap, info, actionsWrap, stopButton);
  }

  const resizeHandle = document.createElement("div");
  resizeHandle.className = "song-previewer-resize-handle";
  resizeHandle.title = "Resize widget";
  floatingCard.appendChild(resizeHandle);
  installResizeToSize(floatingCard, resizeHandle);

  if (state === "fallback" && track?.previewUrl) {
    const playButton = document.createElement("button");
    playButton.className = "song-previewer-play-button";
    playButton.type = "button";
    playButton.textContent = "Play";
    playButton.addEventListener("pointerdown", stopWidgetEvent);
    playButton.addEventListener("mouseup", stopWidgetEvent);
    playButton.addEventListener("click", (event) => {
      stopWidgetEvent(event);
      playFallbackPreview(track);
    });
    actionsWrap.append(playButton);
  }

  document.documentElement.appendChild(floatingCard);
  applySavedLayout(floatingCard).catch(ignoreExtensionInvalidated);

  clearTimeout(panelTimer);

  if (state === "playing" && track?.source !== "YouTube") {
    panelTimer = setTimeout(() => {
      if (floatingCard?.classList.contains(`song-previewer-card--${state}`)) {
        removeFloatingCard();
      }
    }, PREVIEW_PANEL_TTL_MS);
  }

  if (state === "error") {
    panelTimer = setTimeout(() => {
      if (floatingCard?.classList.contains("song-previewer-card--error")) {
        removeFloatingCard();
      }
    }, 5000);
  }
}

function createProviderBadge(source) {
  const normalizedSource = source === "YouTube" ? "youtube" : "apple";
  const badge = document.createElement("div");
  badge.className = `song-previewer-provider song-previewer-provider--${normalizedSource}`;

  const icon = document.createElement("span");
  icon.className = "song-previewer-provider-icon";

  if (normalizedSource === "youtube") {
    icon.innerHTML = `
      <svg viewBox="0 0 28 20" aria-hidden="true" focusable="false">
        <path fill="#ff0000" d="M27.4 3.1a3.5 3.5 0 0 0-2.5-2.5C22.8 0 14 0 14 0S5.2 0 3.1.6A3.5 3.5 0 0 0 .6 3.1C0 5.2 0 10 0 10s0 4.8.6 6.9a3.5 3.5 0 0 0 2.5 2.5c2.1.6 10.9.6 10.9.6s8.8 0 10.9-.6a3.5 3.5 0 0 0 2.5-2.5c.6-2.1.6-6.9.6-6.9s0-4.8-.6-6.9Z"/>
        <path fill="#fff" d="M11.2 14.3V5.7l7.3 4.3-7.3 4.3Z"/>
      </svg>
    `;
    badge.append(icon, document.createTextNode("YouTube"));
  } else {
    icon.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id="song-previewer-apple-music-gradient" x1="4" x2="20" y1="3" y2="21">
            <stop offset="0" stop-color="#fb5c74"/>
            <stop offset="1" stop-color="#a855f7"/>
          </linearGradient>
        </defs>
        <rect width="24" height="24" rx="5.5" fill="url(#song-previewer-apple-music-gradient)"/>
        <path fill="#fff" d="M17.3 4.8v10.5a2.7 2.7 0 1 1-1.2-2.2V8.5l-7.4 1.4v7a2.7 2.7 0 1 1-1.2-2.2V7l9.8-2.2Z"/>
      </svg>
    `;
    badge.append(icon, document.createTextNode("Apple Music"));
  }

  return badge;
}

function installDragToPosition(card, ...handles) {
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;
  let pointerId = null;

  handles.forEach((handle) => {
    handle.classList.add("song-previewer-drag-handle");
    handle.title = "Drag to choose widget position";

    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) {
        return;
      }

      pointerId = event.pointerId;
      draggedThisInteraction = false;
      const rect = card.getBoundingClientRect();

      startX = event.clientX;
      startY = event.clientY;
      startLeft = rect.left;
      startTop = rect.top;

      card.classList.add("song-previewer-card--dragging");
      handle.setPointerCapture(pointerId);
      event.preventDefault();
    });

    handle.addEventListener("pointermove", (event) => {
      if (event.pointerId !== pointerId) {
        return;
      }

      const nextLeft = startLeft + event.clientX - startX;
      const nextTop = startTop + event.clientY - startY;
      const bounded = boundPosition(card, nextLeft, nextTop);

      draggedThisInteraction = true;
      setCardPosition(card, bounded.left, bounded.top);
    });

    handle.addEventListener("pointerup", (event) => {
      if (event.pointerId !== pointerId) {
        return;
      }

      pointerId = null;
      card.classList.remove("song-previewer-card--dragging");

      if (draggedThisInteraction) {
        saveCardPosition(card).catch(ignoreExtensionInvalidated);
      }
    });

    handle.addEventListener("pointercancel", () => {
      pointerId = null;
      card.classList.remove("song-previewer-card--dragging");
    });
  });
}

function installResizeToSize(card, handle) {
  let startX = 0;
  let startY = 0;
  let startWidth = 0;
  let startHeight = 0;
  let pointerId = null;

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }

    pointerId = event.pointerId;
    const rect = card.getBoundingClientRect();

    startX = event.clientX;
    startY = event.clientY;
    startWidth = rect.width;
    startHeight = rect.height;

    card.classList.add("song-previewer-card--resizing");
    handle.setPointerCapture(pointerId);
    event.preventDefault();
  });

  handle.addEventListener("pointermove", (event) => {
    if (event.pointerId !== pointerId) {
      return;
    }

    const nextWidth = startWidth + event.clientX - startX;
    const nextHeight = startHeight + event.clientY - startY;
    setCardSize(card, nextWidth, nextHeight);
  });

  handle.addEventListener("pointerup", (event) => {
    if (event.pointerId !== pointerId) {
      return;
    }

    pointerId = null;
    card.classList.remove("song-previewer-card--resizing");
    saveCardLayout(card).catch(ignoreExtensionInvalidated);
  });

  handle.addEventListener("pointercancel", () => {
    pointerId = null;
    card.classList.remove("song-previewer-card--resizing");
  });
}

async function applySavedLayout(card) {
  const key = getLayoutStorageKey();
  const saved = await safeStorageGet(key);
  const layout = saved[key];

  if (!layout) {
    applyDefaultLayout(card);
    return;
  }

  if (typeof layout.width === "number" || typeof layout.height === "number") {
    setCardSize(card, layout.width, layout.height);
  }

  if (typeof layout.left === "number" && typeof layout.top === "number") {
    const bounded = boundPosition(card, layout.left, layout.top);
    setCardPosition(card, bounded.left, bounded.top);
  }
}

function applyDefaultLayout(card) {
  const isYouTube = card.classList.contains("song-previewer-card--youtube");
  const width = isYouTube ? DEFAULT_YOUTUBE_WIDTH : DEFAULT_AUDIO_WIDTH;
  const height = isYouTube ? DEFAULT_YOUTUBE_HEIGHT : DEFAULT_AUDIO_HEIGHT;

  setCardSize(card, width, height);

  const rect = card.getBoundingClientRect();
  const left = (window.innerWidth - rect.width) / 2;
  const top = window.innerHeight - rect.height - DEFAULT_BOTTOM_OFFSET;
  const bounded = boundPosition(card, left, top);

  setCardPosition(card, bounded.left, bounded.top);
}

async function saveCardPosition(card) {
  await saveCardLayout(card);
}

async function saveCardLayout(card) {
  if (!isExtensionContextAvailable()) {
    return;
  }

  const rect = card.getBoundingClientRect();
  const bounded = boundPosition(card, rect.left, rect.top);

  await safeStorageSet({
    [getLayoutStorageKey()]: {
      ...bounded,
      width: rect.width,
      height: rect.height
    }
  });
}

function setCardPosition(card, left, top) {
  card.style.left = `${left}px`;
  card.style.right = "auto";
  card.style.top = `${top}px`;
}

function setCardSize(card, width, height) {
  const maxWidth = Math.min(MAX_CARD_WIDTH, window.innerWidth - POSITION_PADDING * 2);
  const maxHeight = Math.min(MAX_CARD_HEIGHT, window.innerHeight - POSITION_PADDING * 2);
  const minWidth = card.classList.contains("song-previewer-card--youtube") ? 300 : MIN_CARD_WIDTH;
  const minHeight = card.classList.contains("song-previewer-card--youtube") ? 240 : MIN_CARD_HEIGHT;
  const nextWidth = Math.min(Math.max(width || minWidth, minWidth), maxWidth);
  const nextHeight = Math.min(Math.max(height || minHeight, minHeight), maxHeight);

  card.style.width = `${nextWidth}px`;
  card.style.height = `${nextHeight}px`;

  const rect = card.getBoundingClientRect();
  const bounded = boundPosition(card, rect.left, rect.top);
  setCardPosition(card, bounded.left, bounded.top);
}

function boundPosition(card, left, top) {
  const rect = card.getBoundingClientRect();
  const width = rect.width || 266;
  const height = rect.height || 124;

  return {
    left: Math.min(Math.max(left, POSITION_PADDING), window.innerWidth - width - POSITION_PADDING),
    top: Math.min(Math.max(top, POSITION_PADDING), window.innerHeight - height - POSITION_PADDING)
  };
}

function getLayoutStorageKey(card = floatingCard) {
  const provider = card?.dataset?.provider || "apple";
  return `widget-layout:${window.location.hostname || "default"}:${provider}`;
}

function getProviderLayoutName(track) {
  return track?.source === "YouTube" ? "youtube" : "apple";
}

function getSubtitle(track, message) {
  if (!track?.artistName) {
    return message;
  }

  const source = track.source ? ` • ${track.source}` : "";
  const provider = track.source === "YouTube" && track.providerArtistName
    ? ` • ${track.providerArtistName}`
    : "";

  return `${track.artistName}${source}${provider} • ${message}`;
}

function getLargeArtworkUrl(url) {
  return url.replace(/100x100bb\.(jpg|png|webp)$/i, "300x300bb.$1");
}

async function playFallbackPreview(track) {
  try {
    if (fallbackAudio) {
      fallbackAudio.pause();
    }

    clearTimeout(fallbackTimer);

    fallbackAudio = new Audio(track.previewUrl);
    fallbackAudio.volume = 0.75;
    await fallbackAudio.play();

    fallbackTimer = setTimeout(() => {
      fallbackAudio.pause();
    }, 30000);

    showFloatingCard({
      state: "playing",
      track,
      message: "Playing preview"
    });
  } catch (error) {
    showFloatingCard({
      state: "error",
      track,
      message: "Playback blocked"
    });
  }
}

async function stopPreview() {
  if (fallbackAudio) {
    fallbackAudio.pause();
    fallbackAudio.currentTime = 0;
    fallbackAudio = null;
  }

  clearTimeout(fallbackTimer);
  fallbackTimer = null;

  try {
    if (!isExtensionContextAvailable()) {
      return;
    }

    await chrome.runtime.sendMessage({
      type: "STOP_SONG_PREVIEW"
    });
  } catch {
    // The background worker may be asleep; local audio has already been stopped.
  }
}

function removeFloatingCard() {
  clearTimeout(panelTimer);
  floatingCard?.remove();
  floatingCard = null;
}

async function closeWidget() {
  lastSelection = "";
  lastSelectionAt = Date.now();
  await stopPreview();
  removeFloatingCard();
}

function isInsideWidget(event) {
  return Boolean(floatingCard && event?.target instanceof Node && floatingCard.contains(event.target));
}

function stopWidgetEvent(event) {
  event.preventDefault();
  event.stopPropagation();
}

function isExtensionContextAvailable() {
  return typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);
}

async function safeStorageGet(key) {
  if (!isExtensionContextAvailable()) {
    return {};
  }

  try {
    return await chrome.storage.local.get(key);
  } catch (error) {
    ignoreExtensionInvalidated(error);
    return {};
  }
}

async function safeStorageSet(value) {
  if (!isExtensionContextAvailable()) {
    return;
  }

  try {
    await chrome.storage.local.set(value);
  } catch (error) {
    ignoreExtensionInvalidated(error);
  }
}

function ignoreExtensionInvalidated(error) {
  const message = error instanceof Error ? error.message : String(error || "");

  if (!message.includes("Extension context invalidated")) {
    throw error;
  }
}
