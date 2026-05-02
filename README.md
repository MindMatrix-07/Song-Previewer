<div align="center">
  <img src="https://img.shields.io/badge/Google_Chrome-4285F4?style=for-the-badge&logo=google-chrome&logoColor=white" alt="Chrome">
  <img src="https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black" alt="JavaScript">
  <img src="https://img.shields.io/badge/HTML5-E34F26?style=for-the-badge&logo=html5&logoColor=white" alt="HTML5">
  <img src="https://img.shields.io/badge/CSS3-1572B6?style=for-the-badge&logo=css3&logoColor=white" alt="CSS3">
</div>

<br />

<div align="center">
  <h1>🎧 Song Previewer</h1>
  <p><strong>A magical Chrome extension that plays a direct 30-second song preview whenever you highlight a song name on any webpage!</strong></p>
</div>

<hr />

## ✨ Features

- 🎵 **Instant Playback:** Highlight any song title with a normal mouse drag selection to instantly hear a 30-second preview.
- 🍏 **Apple Music Integration:** Searches the iTunes API first for high-quality, direct `previewUrl` audio files.
- 🎥 **YouTube Fallback:** Automatically falls back to the official YouTube iframe embed if no iTunes result is found.
- 🌐 **Gemini Language Detection:** Uses Google's Gemini AI to automatically detect the language of the selected song title.
- 🎛️ **Customizable UI:** Drag the album art to position the floating player anywhere on your screen. Resizable from the bottom-right corner! (Your layout is remembered per-website).
- 🛑 **Quick Controls:** Simply press `Esc` or click the `x` on the floating card to stop playback instantly.

---

## 🚀 Installation (Drag & Drop)

Since this extension is not distributed on the Chrome Web Store, you can easily install it using the `.crx` file provided in the Releases section.

1. Navigate to the **Releases** section on the right side of this GitHub repository.
2. Download the `Song_Previewer.crx` file to your computer.
3. Open Google Chrome and go to `chrome://extensions/`.
4. Turn on the **Developer mode** toggle in the top right corner.
5. **Drag and drop** the downloaded `Song_Previewer.crx` file anywhere onto that page.
6. Click **Add Extension** when prompted. You're done! 🎉

---

## ⚙️ Advanced Setup

### YouTube Fallback Setup (Optional)
The YouTube fallback uses an iframe because YouTube playback must stay inside the official YouTube player.

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project and enable the **YouTube Data API v3**.
3. Create an API key.
4. Click the pinned **Song Previewer** icon `♪` in your Chrome toolbar.
5. Click **Open settings**.
6. Paste your API key and save!

### Gemini Language Detection (Optional)
1. Get a [Gemini API Key](https://aistudio.google.com/).
2. Open the extension settings via the Chrome toolbar.
3. Paste your Gemini API key. The extension will securely send the highlighted text to Gemini to display the language label.

---

## 🛠️ Technical Notes

- 🚫 No Vercel servers or middleware used. The extension communicates directly with Apple and YouTube APIs!
- 🚫 Does NOT rely on heavy Apple Music web embeds.
- 🔊 If Chrome blocks automatic autoplay on a site, a convenient `Play` button will appear next to your selected text.

<div align="center">
  <i>Made with ❤️ for music lovers</i>
</div>
