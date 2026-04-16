<div align="center">
  <img src="assets/icon_256.png" alt="Sundial Logo" width="120">
  <h1>Sundial</h1>
  <p><strong>Select text. Press hotkey. See the time.</strong></p>
  <p>A lightweight desktop timestamp converter that lives in your system tray.</p>

  ![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-blue?style=flat-square)
  ![Electron](https://img.shields.io/badge/electron-28-47848F?style=flat-square&logo=electron&logoColor=white)
  ![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)
  ![Version](https://img.shields.io/badge/version-1.0.0-brightgreen?style=flat-square)
</div>

---

## The Problem

You're reading server logs, debugging an API response, or checking a database record. You see `1713153600` — is that today? Last week? You open a browser tab, google "unix timestamp converter", paste the number, hit convert...

**Sundial makes this instant.** Select the number, press a hotkey, done.

## ✨ Features

- **⚡ Instant conversion** — Select any timestamp text, press `F9`, see the result in a popup near your cursor
- **🔍 Smart detection** — Auto-detects seconds (10-digit) vs milliseconds (13-digit) timestamps
- **⏱️ Millisecond precision** — Millisecond timestamps display with `.SSS` suffix (e.g. `12:00:00.123`)
- **📋 Click to copy** — Click the converted time to copy it to clipboard
- **🔄 Clipboard restore** — Your original clipboard content is preserved after conversion
- **🌍 18 timezones** — From UTC to Auckland, switch instantly from the tray menu
- **📌 Single & Multi mode** — Convert one-off or collect multiple timestamps for comparison
- **🎯 Cursor-follow popup** — Result appears right where you're looking
- **🖥️ System tray** — Runs quietly in background, right-click for settings
- **⌨️ Customizable hotkey** — Choose from presets (F7/F8/F9/Ctrl+Shift+T) or record any key combo
- **🪟 Cross-platform** — Windows & macOS

## 📦 Download

Download the latest release from the [Releases](../../releases) page:

| File | Description |
|------|-------------|
| `Sundial Setup 1.0.0.exe` | **Windows installer** — guided setup with custom install path |
| `Sundial 1.0.0.exe` | **Windows portable** — no installation needed, run directly |
| `Sundial-1.0.0.dmg` | **macOS installer** *(coming soon)* |

## 🚀 Quick Start

### 1. Install & Launch

Run the installer or portable exe. Sundial starts minimized in your **system tray** (notification area).

### 2. Convert a Timestamp

1. **Select** a timestamp anywhere on screen — terminal, log file, browser, IDE, etc.
2. **Press** `F9` (default hotkey)
3. **See** the converted time in a popup near your cursor
4. **Click** the result to copy it

### 3. That's It

The popup auto-hides after 6 seconds, or when your mouse moves away. Your clipboard is automatically restored.

## 📋 Supported Formats

| Format | Example | Output |
|--------|---------|--------|
| Seconds (10-digit) | `1713153600` | `2024-04-15 12:00:00` |
| Milliseconds (13-digit) | `1713153600123` | `2024-04-15 12:00:00.123` |
| Embedded in text | `log: ts=1713153600 end` | Extracts `1713153600` automatically |

Valid range: `1970-01-01` to `2100-01-01`

## ⚙️ Settings

Right-click the tray icon → **Settings** to configure:

| Option | Description | Default |
|--------|-------------|---------|
| **Hotkey** | Global keyboard shortcut | `F9` |
| **Timezone** | Display timezone for converted time | `Beijing (UTC+8)` |
| **Multi mode** | Collect multiple timestamps in one panel | Off |
| **Max records** | Maximum records in multi mode (2-20) | 5 |

### Supported Timezones

UTC, London, Berlin, Moscow, Dubai, Mumbai, Bangkok, Beijing, Hong Kong, Singapore, Tokyo, Seoul, Sydney, Auckland, Los Angeles, Chicago, New York, São Paulo

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `F9` (configurable) | Convert selected timestamp |
| `Esc` | Close popup / settings / help |
| Click result text | Copy to clipboard |
| `SINGLE` / `MULTI` toggle | Switch popup mode |

## 🏗️ Project Structure

```
sundial/
├── assets/
│   ├── icon.png                # App icon (original)
│   ├── icon_64.png             # 64x64 icon
│   └── icon_256.png            # 256x256 icon
├── src/
│   ├── main.js                 # Electron main process
│   ├── timestamp-parser.js     # Timestamp parsing engine
│   ├── popup.html              # Conversion result popup
│   ├── settings.html           # Settings panel
│   ├── tray-menu.html          # Custom tray right-click menu
│   └── help.html               # Help / usage guide
├── package.json
└── README.md
```

## 🛠️ Development

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- npm

### Setup

```bash
git clone https://github.com/yourname/sundial.git
cd sundial
npm install
```

### Run

```bash
npm start
```

### Build

```bash
# Windows (installer + portable)
npm run build:win

# macOS (dmg + zip)
npm run build:mac

# Both platforms
npm run build:all
```

Build output goes to `dist/`.

## 🧰 Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | [Electron](https://www.electronjs.org/) 28 |
| UI | Vanilla HTML/CSS/JS (no framework) |
| Settings storage | [electron-store](https://github.com/sindresorhus/electron-store) |
| Build | [electron-builder](https://www.electron.build/) |
| Installer | NSIS (Windows) / DMG (macOS) |

## 📄 License

[MIT](LICENSE) © Sundial Contributors

---

<div align="center">
  <sub>Built with ☕ and a dislike for opening browser tabs just to convert timestamps.</sub>
</div>
