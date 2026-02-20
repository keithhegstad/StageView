<div align="center">

# StageView

**Multi-camera grid viewer for live streaming & broadcast monitoring**

[![Version](https://img.shields.io/badge/version-1.1.0-blue?style=flat-square)](https://github.com/yourusername/stageview/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey?style=flat-square)](#installation)
[![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202-orange?style=flat-square)](https://tauri.app)
[![Rust](https://img.shields.io/badge/backend-Rust-brown?style=flat-square)](https://www.rust-lang.org)
[![FFmpeg](https://img.shields.io/badge/media-FFmpeg-darkgreen?style=flat-square)](https://ffmpeg.org)

</div>

---

StageView is a lightweight desktop app that displays multiple camera streams in a grid. Built for professionals running 24/7 broadcast setups, it includes burn-in protection, a remote control API, and support for all major streaming protocols.

---

## Features

| | |
|---|---|
| **Dynamic Grid** | Cameras auto-arrange in an optimal grid — just add streams and go |
| **Solo Mode** | Double-click or press `1–9` to focus any camera full-screen |
| **Picture-in-Picture** | One main camera full-screen with overlay cameras in the corners |
| **Multi-Protocol** | RTP, RTSP, SRT, HTTP/MJPEG |
| **Burn-in Protection** | Periodic shuffling, pixel orbiting, and noise overlay for 24/7 displays |
| **Remote Control** | HTTP API + browser control panel — works with Stream Deck, Companion, and more |
| **Stream Health** | Real-time FPS, bitrate, and uptime per camera |
| **Auto-Reconnect** | Streams reconnect automatically with exponential backoff |
| **Camera Presets** | Save and load camera configurations instantly |
| **Drag-and-Drop** | Reorder cameras in grid view |
| **Multi-Monitor** | Window position and size persist across sessions |

---

## Installation

### Download

Pre-built Windows installers are in `src-tauri/target/release/bundle/`:

| Installer | Size | Best For |
|-----------|------|----------|
| `.msi` (MSI) | ~38 MB | Enterprise / silent install |
| `.exe` (NSIS) | ~28 MB | End users / setup wizard |

**Silent MSI install:**
```bash
msiexec /i StageView_1.1.0_x64_en-US.msi /quiet
```

### Build from Source

**Requirements:** Rust 1.70+, Node.js 18+, FFmpeg

```bash
# 1. Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# 2. Install FFmpeg
#    Windows: download from ffmpeg.org → place ffmpeg.exe in src-tauri/binaries/
#    macOS:   brew install ffmpeg
#    Linux:   sudo apt install ffmpeg

# 3. Clone and build
git clone https://github.com/yourusername/stageview.git
cd stageview
npm install
npm run tauri build
```

**Development mode:**
```bash
npm run tauri dev
```

---

## Configuration

### Adding Cameras

1. Click **⚙️ Settings** (top-right)
2. Add a camera — give it a name and a stream URL
3. Click **Save Settings**

### Supported Stream URLs

```
RTP (Multicast)  →  rtp://239.1.1.1:5000
RTSP             →  rtsp://user:pass@192.168.1.100:554/stream
SRT              →  srt://192.168.1.100:9000
HTTP / MJPEG     →  http://192.168.1.100:8080/video
```

### Settings Reference

| Setting | Description | Default |
|---------|-------------|---------|
| Shuffle Interval | Minutes between camera rearrangements (burn-in protection) | 15 min |
| Show Status Dots | Online/offline indicators | On |
| Show Camera Names | Camera labels in grid | On |
| Quality | Low (5fps/640p) · Medium (10fps) · High (15fps) | Medium |
| API Port | Remote control HTTP port | 8090 |

### Config File Location

| OS | Path |
|----|------|
| Windows | `%APPDATA%\StageView\config.json` |
| macOS | `~/Library/Application Support/StageView/config.json` |
| Linux | `~/.config/StageView/config.json` |

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `1` – `9` | Solo camera at that position |
| `0` / `ESC` | Return to grid view |
| `F11` / `F` | Toggle fullscreen |
| `Ctrl+N` | Open new window (multi-monitor) |

---

## Remote Control API

StageView runs a local HTTP server for integration with Stream Deck, Bitfocus Companion, or any custom automation.

### Control Panel

Open in any browser on the same network:

```
http://stageview.local:8090/
```

The panel shows all cameras with solo/grid/fullscreen controls and supports managing multiple StageView PCs from one page.

> If `stageview.local` doesn't resolve, use the IP address directly: `http://192.168.1.100:8090/`

### API Endpoints

**Base URL:** `http://stageview.local:8090` — all endpoints return JSON

| Endpoint | Description |
|----------|-------------|
| `GET /` | Browser control panel |
| `GET /api/solo/:index` | Solo camera at 1-based index |
| `GET /api/grid` | Return to grid view |
| `GET /api/status` | List all cameras with indices |
| `GET /api/fullscreen` | Toggle fullscreen |
| `GET /api/reload` | Reload config from disk |

**Examples:**
```bash
curl http://stageview.local:8090/api/solo/2    # solo camera 2
curl http://stageview.local:8090/api/grid      # back to grid
curl http://stageview.local:8090/api/status    # list cameras
curl http://stageview.local:8090/api/fullscreen
curl http://stageview.local:8090/api/reload
```

### Stream Deck Setup

1. Add a **Website** button
2. Set URL: `http://192.168.1.100:8090/api/solo/1`
3. Press to switch to camera 1

### Security Note

The API has no authentication — only use it on a trusted local network. Do not expose port 8090 to the internet.

---

## Troubleshooting

**Cameras not showing up**
- Test the stream URL directly in VLC or with `ffmpeg -i "your_url" -f null -`
- Check that your firewall allows multicast/RTSP traffic
- Open browser DevTools → Console for FFmpeg error output

**High CPU usage**
- Lower the quality preset (Settings → Quality → Low)
- Reduce the number of active cameras
- Use solo mode when you only need to watch one camera

**API not reachable from another device**
- Make sure port 8090 is allowed through the firewall
- Both devices must be on the same local network
- If `stageview.local` doesn't work, use the IP address instead
- Verify with `curl http://localhost:8090/api/status` on the StageView PC first

---

## Architecture

```
Camera Stream (RTP/RTSP/SRT/HTTP)
       ↓
FFmpeg (spawned per camera, Rust)
       ↓
JPEG frames → Rust backend
       ↓
Base64 encode → Tauri event ("camera-frame")
       ↓
JavaScript frontend → DOM image update
       ↓
Browser renders frame
```

**Stack:** Vanilla JS + HTML/CSS · Rust + Tauri 2 · FFmpeg · Tokio

```
StageView/
├── src/                  # Frontend (HTML, JS, CSS)
├── src-tauri/
│   ├── src/
│   │   ├── main.rs       # Tauri entry point
│   │   └── lib.rs        # Core logic
│   ├── binaries/         # Bundled FFmpeg
│   └── tauri.conf.json
└── docs/                 # Testing checklist & design docs
```

---

## Contributing

1. Fork the repo
2. Create a branch: `git checkout -b feature/my-feature`
3. Commit: `git commit -m 'feat: add my feature'`
4. Push: `git push origin feature/my-feature`
5. Open a Pull Request

---

## License

[MIT](LICENSE) — Built with [Tauri](https://tauri.app) · Powered by [FFmpeg](https://ffmpeg.org)
