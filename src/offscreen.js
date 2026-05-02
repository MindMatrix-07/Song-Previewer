let currentAudio = null;
let stopTimer = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "OFFSCREEN_PLAY_PREVIEW") {
    playPreview(message.previewUrl)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Playback failed."
        });
      });

    return true;
  }

  if (message?.type === "OFFSCREEN_STOP_PREVIEW") {
    stopPreview();
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

async function playPreview(previewUrl) {
  if (!previewUrl) {
    return { ok: false, error: "Missing preview URL." };
  }

  stopPreview();

  currentAudio = new Audio(previewUrl);
  currentAudio.volume = 0.75;
  currentAudio.crossOrigin = "anonymous";

  await currentAudio.play();

  stopTimer = setTimeout(stopPreview, 30000);

  return { ok: true };
}

function stopPreview() {
  clearTimeout(stopTimer);
  stopTimer = null;

  if (currentAudio) {
    currentAudio.pause();
    currentAudio.currentTime = 0;
    currentAudio = null;
  }
}
