# StageView

A lightweight, cross-platform multi-camera grid viewer built for professional live streaming and broadcast monitoring. Features intelligent burn-in protection, remote control API, and support for multiple streaming protocols.

<!-- Screenshot will be added in future release -->
<!-- ![StageView Screenshot](docs/screenshot.png) -->

## Features

### Core Functionality
- **Dynamic Grid Layout** - Automatically arranges cameras in optimal square grid
- **Solo Mode** - Double-click any camera or use number keys (1-9) to focus
- **Multi-Protocol Support** - RTP, RTSP, SRT, HTTP/MJPEG
- **Performance Tuning** - Low/Medium/High quality presets for various hardware

### Burn-in Protection
Critical for professional displays running 24/7:
- **Periodic Shuffling** - Cameras rearrange every N minutes using Sattolo's algorithm
- **Pixel Orbiting** - Content shifts 1-2px in rotating patterns
- **Noise Overlay** - Subtle static to exercise all subpixels

### Remote Control
HTTP API for hardware integration (Stream Deck, Elgato, Companion):
- Solo specific camera by index
- Return to grid view
- Query camera status

### Advanced Features
- **Auto-Reconnection** - Streams automatically reconnect with exponential backoff
- **Stream Health Monitoring** - Real-time FPS, bitrate, uptime with modern UI
- **Auto Grid Layout** - Automatically arranges cameras in optimal square grid
- **Picture-in-Picture** - Main camera with corner overlays (TL/TR/BL/BR) at custom sizes
- **Camera Presets** - Save and load camera configurations instantly
- **Drag-and-Drop** - Reorder cameras in grid mode
- **Multi-Monitor** - Window position/size persists across sessions

## Installation

### Prerequisites
- **Windows**: Windows 10/11 (64-bit)
- **macOS**: macOS 10.15+ (Catalina or later)
- **Linux**: Ubuntu 20.04+, Fedora 35+, or equivalent

### Download Pre-built Binaries
1. Visit [Releases](https://github.com/yourusername/stageview/releases)
2. Download the appropriate installer for your platform:
   - Windows: `StageView_x.x.x_x64_en-US.msi`
   - macOS: `StageView_x.x.x_x64.dmg`
   - Linux: `StageView_x.x.x_amd64.AppImage`
3. Run the installer

### Build from Source

#### 1. Install Dependencies

**Rust** (1.70+):
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

**Node.js** (16+):
```bash
# Use nvm, fnm, or download from nodejs.org
```

**FFmpeg** (required for stream decoding):
- **Windows**: Download from [ffmpeg.org](https://ffmpeg.org/download.html) and place `ffmpeg.exe` in `src-tauri/binaries/`
- **macOS**: `brew install ffmpeg`
- **Linux**: `sudo apt install ffmpeg` (Ubuntu/Debian) or `sudo dnf install ffmpeg` (Fedora)

#### 2. Clone and Build

```bash
git clone https://github.com/yourusername/stageview.git
cd stageview
npm install
npm run tauri build
```

Built binaries will be in `src-tauri/target/release/bundle/`

#### 3. Development Mode

```bash
npm run tauri dev
```

## Configuration

### Camera Setup

1. Click the **⚙️ Settings** button (top-right)
2. Add camera streams:
   - **Name**: Display label for the camera
   - **URL**: Stream URL (see formats below)
3. Click **Save Settings**

### Supported Stream Formats

```
RTP (Multicast):  rtp://239.1.1.1:5000
RTSP:             rtsp://username:password@192.168.1.100:554/stream
SRT:              srt://192.168.1.100:9000
HTTP (MJPEG):     http://192.168.1.100:8080/video
```

### Settings Panel Options

| Setting | Description | Default |
|---------|-------------|---------|
| **Shuffle Interval** | Minutes between camera rearrangements (burn-in protection) | 15 min |
| **Show Status Dots** | Display online/offline indicators | On |
| **Show Camera Names** | Display camera labels | On |
| **Quality** | Low (5fps, 640p) / Medium (10fps, full) / High (15fps, full) | Medium |
| **API Port** | HTTP remote control port | 8090 |

### Configuration File

StageView stores settings in:
- **Windows**: `%APPDATA%\StageView\config.json`
- **macOS**: `~/Library/Application Support/StageView/config.json`
- **Linux**: `~/.config/StageView/config.json`

Example `config.json`:
```json
{
  "cameras": [
    {
      "id": "abc123",
      "name": "Camera 1",
      "url": "rtsp://192.168.1.100:554/stream"
    }
  ],
  "shuffle_interval_secs": 900,
  "show_status_dots": true,
  "show_camera_names": true,
  "quality": "medium",
  "api_port": 8090
}
```

## Layout Modes

StageView offers two layout modes:

### Auto Grid
Automatically arranges cameras in an optimal square grid. No configuration needed - just add cameras and they'll be arranged automatically.

### Picture-in-Picture (PIP)
Display one main camera full-screen with smaller camera overlays in the corners.

**Setup:**
1. Click Layout Editor (🎨 button)
2. Select "Picture-in-Picture"
3. Choose main camera for full-screen background
4. Add overlays:
   - Select camera
   - Choose corner (TL/TR/BL/BR)
   - Select size (10-40%)
5. Click "Apply Now"

**Limitations:**
- Each corner can have maximum 1 overlay
- Main camera fills entire screen
- Overlays positioned at 2% margin from edges

## Usage

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| **1-9** | Solo camera at that position |
| **0 / ESC** | Return to grid view |
| **F11 / F** | Toggle fullscreen |
| **Ctrl+N** | Open new window (multi-monitor) |

## Remote API Access

StageView's API is accessible on your local network for integration with Stream Deck, Companion, or custom automation.

### Finding Your IP Address

**Windows:**
```bash
ipconfig
# Look for "IPv4 Address" under your active network adapter
# Example: 192.168.1.100
```

**Linux/macOS:**
```bash
ifconfig
# or
ip addr show
```

### API Endpoints

All endpoints respond with JSON and use GET requests.

**Base URL:** `http://YOUR_IP:8090/api/`

#### 1. Solo Camera
```
GET /api/solo/:index
```
Switches to solo view for camera at 1-based index.

**Example:** `http://192.168.1.100:8090/api/solo/2`

**Response:**
```json
{"ok": true, "action": "solo", "index": 2}
```

#### 2. Return to Grid
```
GET /api/grid
```
Returns to grid view (exits solo mode).

**Example:** `http://192.168.1.100:8090/api/grid`

**Response:**
```json
{"ok": true, "action": "grid"}
```

#### 3. Camera Status
```
GET /api/status
```
Lists all cameras with their indices and API numbers.

**Example:** `http://192.168.1.100:8090/api/status`

**Response:**
```json
{
  "ok": true,
  "cameras": [
    {"index": 1, "id": "uuid-1", "name": "Front Door"},
    {"index": 2, "id": "uuid-2", "name": "Back Yard"}
  ]
}
```

**Note:** The index numbers in the API response match the blue numbered badges shown in the settings panel next to each camera name.

### Integration Examples

**Stream Deck:**
1. Add "Website" button
2. Set URL: `http://192.168.1.100:8090/api/solo/1`
3. Button switches to camera 1 when pressed

**Companion (Bitfocus):**
1. Use HTTP Request module
2. Configure GET request to API endpoint
3. Add to button in Companion

**Custom Script:**
```bash
# Switch to camera 3
curl http://192.168.1.100:8090/api/solo/3

# Return to grid
curl http://192.168.1.100:8090/api/grid

# Get camera list with API indices
curl http://192.168.1.100:8090/api/status
```

### Troubleshooting

**Can't reach API from other device:**

1. **Check firewall** - Port 8090 must be allowed
   - Windows: Windows Defender Firewall → Allow an app
   - Linux: `sudo ufw allow 8090`
   - macOS: System Preferences → Security & Privacy → Firewall

2. **Verify same network** - Both devices must be on same LAN

3. **Test connectivity**
   ```bash
   # From other device, ping the StageView PC
   ping 192.168.1.100

   # If ping works, try API
   curl http://192.168.1.100:8090/api/status
   ```

4. **Try localhost first** - On the StageView PC:
   ```bash
   curl http://localhost:8090/api/status
   # Should work if API server is running
   ```

### Security Notes

**Local Network Only:**
- API has no authentication
- Only use on trusted local networks
- Do NOT expose to internet (no port forwarding)

## Architecture

### Data Flow

```
Camera Stream (RTP/RTSP/SRT/HTTP)
    ↓
FFmpeg (spawned per camera, Rust backend)
    ↓
JPEG frames → stdout (binary detection via SOI markers)
    ↓
Base64 encoding (Rust)
    ↓
Tauri Events ("camera-frame")
    ↓
JavaScript Frontend (event listener)
    ↓
DOM Image Update (data URI)
    ↓
Browser Rendering
```

### Tech Stack

- **Frontend**: Vanilla JavaScript + HTML/CSS (lightweight, no frameworks)
- **Backend**: Rust + Tauri 2 (cross-platform desktop framework)
- **Media**: FFmpeg (binary bundled, handles all stream protocols)
- **Async**: Tokio (concurrent stream processing)
- **IPC**: Tauri events (backend → frontend frame delivery)

### Project Structure

```
StageView/
├── src/                    # Frontend (vanilla web)
│   ├── main.js            # App logic (658 lines)
│   ├── index.html         # UI structure
│   └── style.css          # Styling
├── src-tauri/             # Backend (Rust)
│   ├── src/
│   │   ├── main.rs        # Tauri entry point
│   │   └── lib.rs         # Core app logic (513 lines)
│   ├── binaries/
│   │   └── ffmpeg.exe     # Bundled FFmpeg
│   ├── icons/             # Platform-specific icons
│   ├── Cargo.toml         # Rust dependencies
│   └── tauri.conf.json    # Tauri configuration
├── docs/                  # Documentation
└── README.md
```

## Troubleshooting

### Cameras Not Appearing

1. **Check stream URL**: Test with VLC or FFmpeg directly
   ```bash
   ffmpeg -i "rtsp://192.168.1.100:554/stream" -f null -
   ```
2. **Verify network access**: Ensure firewall allows multicast/RTSP
3. **Check FFmpeg logs**: Open browser DevTools → Console for errors

### High CPU Usage

1. Lower quality preset (Settings → Quality → Low)
2. Reduce camera count
3. Use solo mode when monitoring specific camera

### API Not Responding

1. Verify API port in Settings (default: 8090)
2. Check if port is blocked by firewall
3. Test with browser: `http://localhost:8090/api/status`

## Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'feat: add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

[MIT License](LICENSE)

## Acknowledgments

- Built with [Tauri](https://tauri.app/)
- Powered by [FFmpeg](https://ffmpeg.org/)
- Burn-in protection inspired by broadcast industry standards

---

**Made for live production professionals**
