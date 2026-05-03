/**
 * sidepanel.js — Gemini-powered song language lookup.
 * Reads the pending query from session storage, calls the Gemini API,
 * and renders the answer directly in the side panel (no external navigation).
 */

const QUERY_KEY    = "session:sidepanel-query";
const FOLLOWUP_KEY = "session:sidepanel-followup";
const GEMINI_KEY   = "settings:gemini-api-key";
const TIMEOUT_KEY  = "settings:sidepanel-timeout";
const DEFAULT_TIMEOUT = 10;

const answerEl    = document.getElementById("sp-answer");
const queryEl     = document.getElementById("sp-query");
const subEl       = document.getElementById("sp-sub");
const timerWrap   = document.getElementById("sp-timer-wrap");
const timerBar    = document.getElementById("sp-timer-bar");
const timerLabel  = document.getElementById("sp-timer-label");
const closeBtn    = document.getElementById("sp-close-btn");
const openBtn     = document.getElementById("sp-open-btn");

let currentQuery = "";
let autoCloseTimer = null;
let timerInterval  = null;

// ── Boot ──────────────────────────────────────────────────────────────────

(async () => {
  // Poll for query (race window between open() and storage write)
  const MAX_TRIES = 20;
  let query = null;
  for (let i = 0; i < MAX_TRIES; i++) {
    const r = await chrome.storage.session.get([QUERY_KEY]);
    query = r[QUERY_KEY];
    if (query) break;
    await delay(100);
  }

  if (!query) {
    showError("No query received. Please click 'Song Language' from the preview card.");
    return;
  }

  currentQuery = query;
  await run(query);
})();

// ── Core flow ─────────────────────────────────────────────────────────────

async function run(query) {
  // Show query chip
  queryEl.textContent = query;
  queryEl.style.display = "";

  // Update "Open in new tab" button
  openBtn.onclick = () => {
    chrome.tabs.create({
      url: `https://www.google.com/search?q=${encodeURIComponent(query)}&udm=50`
    });
  };

  // Show loading state
  setLoading(true);
  subEl.textContent = "Asking Gemini…";

  // Get Gemini API key
  const stored = await chrome.storage.local.get([GEMINI_KEY, TIMEOUT_KEY]);
  const apiKey  = stored[GEMINI_KEY];
  const timeout = typeof stored[TIMEOUT_KEY] === "number" ? stored[TIMEOUT_KEY] : DEFAULT_TIMEOUT;

  if (!apiKey) {
    showNoKey();
    return;
  }

  // Call Gemini
  try {
    const answer = await askGemini(apiKey, query);
    showAnswer(answer);
    subEl.textContent = "Gemini AI";
    startAutoClose(timeout);
  } catch (err) {
    showError(`Gemini error: ${err.message}`);
  }
}

// ── Gemini API ────────────────────────────────────────────────────────────

async function askGemini(apiKey, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

  const body = {
    contents: [{
      parts: [{ text: prompt }]
    }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 400
    }
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const errData = await resp.json().catch(() => ({}));
    throw new Error(errData?.error?.message || `HTTP ${resp.status}`);
  }

  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) throw new Error("Empty response from Gemini.");
  return text.trim();
}

// ── UI helpers ────────────────────────────────────────────────────────────

function setLoading(on) {
  answerEl.className = on ? "sp-answer is-loading" : "sp-answer";
  if (on) {
    answerEl.innerHTML = `<div class="sp-spinner"></div><span>Asking Gemini…</span>`;
  }
}

function showAnswer(text) {
  answerEl.className = "sp-answer";
  answerEl.textContent = text;
}

function showError(msg) {
  answerEl.className = "sp-answer is-error";
  answerEl.textContent = "⚠ " + msg;
  subEl.textContent = "Error";
}

function showNoKey() {
  answerEl.className = "sp-answer";
  answerEl.innerHTML = `
    <div class="sp-no-key">
      <div style="font-size:1.8rem;margin-bottom:12px">🔑</div>
      <strong style="color:#c4b8ff;font-size:0.9rem">Gemini API key required</strong>
      <p style="margin-top:10px">Add a free Gemini API key in the extension settings to enable AI language lookup.</p>
      <p style="margin-top:8px">
        Get a free key at
        <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
          aistudio.google.com/apikey
        </a>
      </p>
    </div>
  `;
  subEl.textContent = "API key missing";
}

// ── Auto-close timer ──────────────────────────────────────────────────────

function startAutoClose(seconds) {
  clearTimers();

  timerWrap.style.display = "";
  timerBar.style.width = "100%";

  let remaining = seconds;
  timerLabel.textContent = `Auto-closing in ${remaining}s`;

  // Shrink bar
  requestAnimationFrame(() => {
    timerBar.style.transition = `width ${seconds}s linear`;
    timerBar.style.width = "0%";
  });

  timerInterval = setInterval(() => {
    remaining -= 1;
    timerLabel.textContent = remaining > 0
      ? `Auto-closing in ${remaining}s`
      : "Closing…";
    if (remaining <= 0) clearTimers();
  }, 1000);

  autoCloseTimer = setTimeout(() => {
    chrome.runtime.sendMessage({ type: "SIDEPANEL_CLOSED" }).catch(() => {});
  }, seconds * 1000);
}

function clearTimers() {
  clearTimeout(autoCloseTimer);
  clearInterval(timerInterval);
  autoCloseTimer = null;
  timerInterval  = null;
}

// ── Buttons ───────────────────────────────────────────────────────────────

closeBtn.addEventListener("click", () => {
  clearTimers();
  chrome.runtime.sendMessage({ type: "SIDEPANEL_CLOSED" }).catch(() => {});
});

// ── Follow-up from background ─────────────────────────────────────────────

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "session" || !changes[FOLLOWUP_KEY]) return;
  const val = changes[FOLLOWUP_KEY].newValue;
  if (!val?.query) return;

  clearTimers();
  currentQuery = val.query;
  timerWrap.style.display = "none";
  run(val.query);
});

// ── Utility ───────────────────────────────────────────────────────────────

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
