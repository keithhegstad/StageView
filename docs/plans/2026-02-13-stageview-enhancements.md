# StageView Enhancements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add version control, comprehensive documentation, auto-reconnection, stream health monitoring, custom layouts, camera presets, and drag-and-drop reordering to StageView.

**Architecture:** Maintain vanilla JavaScript frontend with Tauri 2 Rust backend. Add stream health tracking in backend with event emission to frontend. Extend AppConfig for layout presets. Implement reconnection logic with exponential backoff. Use CSS Grid for flexible custom layouts.

**Tech Stack:** Vanilla JS, Tauri 2, Rust/Tokio, FFmpeg, CSS Grid, Local Storage for UI state

---

## Phase 1: Foundation (Git & Documentation)

### Task 1: Initialize Git Repository

**Files:**
- Create: `.gitignore`
- Create: `.gitattributes`

**Step 1: Create comprehensive .gitignore**

Create `.gitignore` in project root:

```gitignore
# Rust/Cargo
target/
Cargo.lock
**/*.rs.bk
*.pdb

# Node.js
node_modules/
npm-debug.log*
yarn-debug.log*
yarn-error.log*
package-lock.json

# Tauri
src-tauri/target/
src-tauri/Cargo.lock

# Build outputs
dist/
build/
out/

# IDE
.vscode/
.idea/
*.swp
*.swo
*~
.DS_Store

# OS
Thumbs.db
desktop.ini

# Config (optional - user may want to track)
# src-tauri/tauri.conf.json

# Logs
*.log

# Environment
.env
.env.local
.env.production

# FFmpeg binaries (too large for git)
src-tauri/binaries/*.exe
src-tauri/binaries/ffmpeg*
!src-tauri/binaries/.gitkeep
```

**Step 2: Create .gitattributes for line endings**

Create `.gitattributes`:

```
* text=auto
*.rs text
*.js text
*.json text
*.toml text
*.md text
*.html text
*.css text
*.sh text eol=lf
*.bat text eol=crlf
```

**Step 3: Initialize git repository**

Run:
```bash
git init
git add .gitignore .gitattributes
git commit -m "chore: initialize git repository with .gitignore and .gitattributes"
```

Expected: Repository initialized with initial commit

**Step 4: Create initial commit with existing code**

Run:
```bash
git add .
git commit -m "feat: initial StageView multi-camera viewer implementation

- Multi-camera grid layout with dynamic sizing
- Burn-in protection (shuffle, pixel orbit, noise overlay)
- Solo mode for individual camera focus
- Remote HTTP API for Stream Deck integration
- FFmpeg-based stream decoding with quality presets
- Support for RTP/RTSP/SRT/HTTP protocols"
```

Expected: All existing code committed

---

### Task 2: Create Professional README Documentation

**Files:**
- Create: `README.md`

**Step 1: Write comprehensive README**

Create `README.md`:

```markdown
# StageView

A lightweight, cross-platform multi-camera grid viewer built for professional live streaming and broadcast monitoring. Features intelligent burn-in protection, remote control API, and support for multiple streaming protocols.

![StageView Screenshot](docs/screenshot.png)

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

## Usage

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| **1-9** | Solo camera at that position |
| **0 / ESC** | Return to grid view |
| **F11 / F** | Toggle fullscreen |

### Remote Control API

Base URL: `http://localhost:8090` (or configured port)

#### Endpoints

**Solo Camera**
```http
GET /api/solo/:index
```
- `index`: 1-based camera position
- Response: `{"status": "ok", "command": "solo", "index": 1}`

**Grid View**
```http
GET /api/grid
```
- Response: `{"status": "ok", "command": "grid"}`

**Camera Status**
```http
GET /api/status
```
- Response:
```json
{
  "cameras": [
    {"index": 1, "name": "Camera 1", "id": "abc123"},
    {"index": 2, "name": "Camera 2", "id": "def456"}
  ]
}
```

#### Example: Stream Deck Integration

1. Add **System > Website** button
2. Set URL to `http://localhost:8090/api/solo/1`
3. Repeat for each camera position

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

**Made for live production professionals** 🎥
```

**Step 2: Create docs directory and placeholder for screenshot**

Run:
```bash
mkdir -p docs
touch docs/screenshot.png
```

Expected: Docs directory created (user can add screenshot later)

**Step 3: Commit documentation**

Run:
```bash
git add README.md docs/
git commit -m "docs: add comprehensive README with setup, API, and architecture docs"
```

Expected: README committed

---

## Phase 2: Auto-Reconnection Logic

### Task 3: Add Stream Reconnection State Tracking

**Files:**
- Modify: `src-tauri/src/lib.rs:69-76` (AppState struct)

**Step 1: Extend AppState with reconnection tracking**

In `src-tauri/src/lib.rs`, modify the `AppState` struct:

```rust
struct AppState {
    config: Mutex<AppConfig>,
    config_path: String,
    ffmpeg_path: PathBuf,
    stream_tasks: Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>,
    reconnect_attempts: Mutex<HashMap<String, u32>>, // camera_id -> attempt count
}
```

**Step 2: Update AppState initialization**

Find the `impl` block where AppState is created (in `lib_init` function or `main.rs`), add:

```rust
reconnect_attempts: Mutex::new(HashMap::new()),
```

**Step 3: Commit state tracking**

Run:
```bash
git add src-tauri/src/lib.rs
git commit -m "feat(backend): add reconnection attempt tracking to AppState"
```

Expected: Commit created

---

### Task 4: Implement Exponential Backoff Reconnection

**Files:**
- Modify: `src-tauri/src/lib.rs` (stream_camera function)

**Step 1: Add reconnection logic to stream_camera**

Find the `stream_camera` async function. Wrap the existing FFmpeg spawning logic in a retry loop:

```rust
async fn stream_camera(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    camera: Camera,
    quality: String,
) {
    let max_attempts = 10;
    let base_delay_ms = 1000; // 1 second
    let max_delay_ms = 60000; // 60 seconds

    loop {
        // Get current attempt count
        let attempt = {
            let mut attempts = state.reconnect_attempts.lock().unwrap();
            let count = attempts.entry(camera.id.clone()).or_insert(0);
            *count += 1;
            *count
        };

        // Emit attempting status
        let _ = app.emit(
            "camera-status",
            CameraStatusEvent {
                camera_id: camera.id.clone(),
                status: if attempt == 1 {
                    "connecting".to_string()
                } else {
                    format!("reconnecting (attempt {})", attempt)
                },
            },
        );

        // Try to start the stream
        match try_stream_camera(&app, &state, &camera, &quality).await {
            Ok(_) => {
                // Stream ended normally, reset attempt counter
                state.reconnect_attempts.lock().unwrap().insert(camera.id.clone(), 0);

                // Wait a moment before reconnecting
                tokio::time::sleep(tokio::time::Duration::from_millis(base_delay_ms)).await;
            }
            Err(e) => {
                eprintln!("Camera {} stream error: {}", camera.name, e);

                // Emit error status
                let _ = app.emit(
                    "camera-status",
                    CameraStatusEvent {
                        camera_id: camera.id.clone(),
                        status: "error".to_string(),
                    },
                );

                // Calculate exponential backoff delay
                let delay_ms = std::cmp::min(
                    base_delay_ms * 2_u64.pow(attempt.saturating_sub(1)),
                    max_delay_ms,
                );

                if attempt >= max_attempts {
                    eprintln!(
                        "Camera {} failed after {} attempts, giving up temporarily. Will retry in {} seconds.",
                        camera.name, max_attempts, delay_ms / 1000
                    );
                    // Reset counter but wait longer
                    state.reconnect_attempts.lock().unwrap().insert(camera.id.clone(), 0);
                }

                // Wait before retry
                tokio::time::sleep(tokio::time::Duration::from_millis(delay_ms)).await;
            }
        }
    }
}
```

**Step 2: Extract FFmpeg logic into try_stream_camera**

Create new function with the original FFmpeg spawning code:

```rust
async fn try_stream_camera(
    app: &AppHandle,
    state: &tauri::State<'_, AppState>,
    camera: &Camera,
    quality: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Move the existing FFmpeg Command building and execution here
    // (All the code from the original stream_camera function)
    // Return Ok(()) on normal stream end, Err on failure

    let ffmpeg_path = &state.ffmpeg_path;
    let url = &camera.url;

    // ... existing FFmpeg argument building logic ...

    let mut child = Command::new(ffmpeg_path)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;

    let mut stdout = child.stdout.take().ok_or("Failed to capture stdout")?;

    // ... existing frame reading logic ...

    // Wait for child process
    let status = child.wait().await?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("FFmpeg exited with code {:?}", status.code()).into())
    }
}
```

**Step 3: Update camera-status event handling in frontend**

In `src/main.js`, find the `camera-status` listener and update to handle new statuses:

```javascript
this.unlistenStatus = await listen("camera-status", (event) => {
  const { camera_id, status } = event.payload;
  const tile = document.querySelector(`[data-id="${camera_id}"]`);
  if (!tile) return;
  const spinner = tile.querySelector(".loading-spinner");
  const statusEl = tile.querySelector(".camera-status");

  if (status === "online") {
    spinner.style.display = "none";
    statusEl.classList.remove("offline", "reconnecting");
  } else if (status.startsWith("reconnecting") || status === "connecting") {
    spinner.style.display = "block";
    statusEl.classList.add("reconnecting");
    statusEl.classList.remove("offline");
  } else {
    spinner.style.display = "none";
    statusEl.classList.add("offline");
    statusEl.classList.remove("reconnecting");
  }
});
```

**Step 4: Add reconnecting styles to CSS**

In `src/style.css`, add:

```css
.camera-status.reconnecting {
  background: orange;
  animation: pulse 1.5s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
```

**Step 5: Test reconnection**

Run in dev mode:
```bash
npm run tauri dev
```

Test scenarios:
1. Add a camera with invalid URL → should see reconnection attempts
2. Add valid camera, disconnect network → should auto-reconnect when network returns

Expected: Camera reconnects automatically with exponential backoff

**Step 6: Commit reconnection logic**

Run:
```bash
git add src-tauri/src/lib.rs src/main.js src/style.css
git commit -m "feat(reconnection): add automatic stream reconnection with exponential backoff

- Retry failed streams up to 10 attempts
- Exponential backoff: 1s, 2s, 4s, 8s... up to 60s max
- Visual feedback: orange pulsing status dot during reconnection
- Reset attempt counter on successful connection"
```

Expected: Reconnection feature committed

---

## Phase 3: Stream Health Statistics

### Task 5: Add Health Metrics Tracking in Backend

**Files:**
- Modify: `src-tauri/src/lib.rs` (add StreamHealth struct and tracking)

**Step 1: Define StreamHealth data model**

Add after the existing data models:

```rust
#[derive(Serialize, Clone, Debug)]
pub struct StreamHealth {
    pub camera_id: String,
    pub fps: f32,
    pub bitrate_kbps: f32,
    pub frame_count: u64,
    pub last_frame_at: u64, // Unix timestamp in milliseconds
    pub uptime_secs: u64,
}

#[derive(Serialize, Clone)]
struct StreamHealthEvent {
    camera_id: String,
    health: StreamHealth,
}
```

**Step 2: Add health tracking to AppState**

Modify `AppState`:

```rust
struct AppState {
    config: Mutex<AppConfig>,
    config_path: String,
    ffmpeg_path: PathBuf,
    stream_tasks: Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>,
    reconnect_attempts: Mutex<HashMap<String, u32>>,
    stream_health: Mutex<HashMap<String, StreamHealth>>, // camera_id -> health stats
}
```

Initialize in builder:
```rust
stream_health: Mutex::new(HashMap::new()),
```

**Step 3: Implement health calculation in stream loop**

In `try_stream_camera`, add health tracking:

```rust
async fn try_stream_camera(
    app: &AppHandle,
    state: &tauri::State<'_, AppState>,
    camera: &Camera,
    quality: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // ... existing setup code ...

    let start_time = std::time::Instant::now();
    let mut frame_count: u64 = 0;
    let mut bytes_received: u64 = 0;
    let mut last_health_update = std::time::Instant::now();

    // Initialize health entry
    {
        let mut health_map = state.stream_health.lock().unwrap();
        health_map.insert(camera.id.clone(), StreamHealth {
            camera_id: camera.id.clone(),
            fps: 0.0,
            bitrate_kbps: 0.0,
            frame_count: 0,
            last_frame_at: 0,
            uptime_secs: 0,
        });
    }

    // Existing frame reading loop
    loop {
        // ... existing frame reading code ...

        // After successful frame read:
        frame_count += 1;
        bytes_received += frame_bytes.len() as u64;

        // Update health stats every 2 seconds
        if last_health_update.elapsed().as_secs() >= 2 {
            let uptime = start_time.elapsed().as_secs();
            let elapsed_secs = last_health_update.elapsed().as_secs_f32();

            let fps = frame_count as f32 / uptime as f32;
            let bitrate_kbps = (bytes_received as f32 * 8.0) / (uptime as f32 * 1000.0);

            let health = StreamHealth {
                camera_id: camera.id.clone(),
                fps,
                bitrate_kbps,
                frame_count,
                last_frame_at: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as u64,
                uptime_secs: uptime,
            };

            // Update state
            state.stream_health.lock().unwrap().insert(camera.id.clone(), health.clone());

            // Emit event to frontend
            let _ = app.emit("stream-health", StreamHealthEvent {
                camera_id: camera.id.clone(),
                health,
            });

            last_health_update = std::time::Instant::now();
        }
    }
}
```

**Step 4: Add Tauri command to get health stats**

Add new command:

```rust
#[tauri::command]
fn get_stream_health(state: State<AppState>) -> HashMap<String, StreamHealth> {
    state.stream_health.lock().unwrap().clone()
}
```

Register in `lib_init` or main:
```rust
.invoke_handler(tauri::generate_handler![
    get_config,
    save_config,
    start_streams,
    stop_streams,
    solo_camera,
    grid_view,
    get_stream_health, // Add this
])
```

**Step 5: Commit backend health tracking**

Run:
```bash
git add src-tauri/src/lib.rs
git commit -m "feat(health): add stream health metrics tracking in backend

- Track FPS, bitrate, frame count, uptime per camera
- Emit health events every 2 seconds
- Add get_stream_health Tauri command"
```

Expected: Backend health tracking committed

---

### Task 6: Display Health Stats in Settings Panel

**Files:**
- Modify: `src/main.js` (add health display in settings)
- Modify: `src/style.css` (add health panel styles)

**Step 1: Add health listener in init()**

In `src/main.js`, add after other listeners:

```javascript
// Listen for stream health updates
this.healthStats = new Map(); // camera_id -> health object
this.unlistenHealth = await listen("stream-health", (event) => {
  const { camera_id, health } = event.payload;
  this.healthStats.set(camera_id, health);
  this.updateHealthDisplay();
});
```

**Step 2: Create health display in settings panel**

Find the `openSettings()` function. Before the camera configuration section, add:

```javascript
openSettings() {
  const overlay = document.getElementById("settings-overlay");
  const panel = document.getElementById("settings-panel");

  // Create health section HTML
  let healthHTML = `
    <div class="settings-section">
      <h3>Stream Health</h3>
      <div id="health-stats-container">
        ${this.cameras.map(cam => `
          <div class="health-card" data-camera-id="${cam.id}">
            <div class="health-camera-name">${cam.name}</div>
            <div class="health-metrics">
              <div class="health-metric">
                <span class="health-label">FPS:</span>
                <span class="health-value" data-metric="fps">--</span>
              </div>
              <div class="health-metric">
                <span class="health-label">Bitrate:</span>
                <span class="health-value" data-metric="bitrate">--</span>
              </div>
              <div class="health-metric">
                <span class="health-label">Frames:</span>
                <span class="health-value" data-metric="frames">--</span>
              </div>
              <div class="health-metric">
                <span class="health-label">Uptime:</span>
                <span class="health-value" data-metric="uptime">--</span>
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  // Insert health section at the top of settings panel
  panel.innerHTML = healthHTML + panel.innerHTML;

  // Update health display with current stats
  this.updateHealthDisplay();

  // ... rest of existing settings panel code ...
}
```

**Step 3: Implement updateHealthDisplay method**

Add new method to StageView class:

```javascript
updateHealthDisplay() {
  const container = document.getElementById("health-stats-container");
  if (!container) return; // Settings panel not open

  this.healthStats.forEach((health, cameraId) => {
    const card = container.querySelector(`[data-camera-id="${cameraId}"]`);
    if (!card) return;

    const fpsEl = card.querySelector('[data-metric="fps"]');
    const bitrateEl = card.querySelector('[data-metric="bitrate"]');
    const framesEl = card.querySelector('[data-metric="frames"]');
    const uptimeEl = card.querySelector('[data-metric="uptime"]');

    if (fpsEl) fpsEl.textContent = health.fps.toFixed(1);
    if (bitrateEl) bitrateEl.textContent = `${health.bitrate_kbps.toFixed(0)} kbps`;
    if (framesEl) framesEl.textContent = health.frame_count.toLocaleString();
    if (uptimeEl) {
      const hours = Math.floor(health.uptime_secs / 3600);
      const mins = Math.floor((health.uptime_secs % 3600) / 60);
      const secs = health.uptime_secs % 60;
      uptimeEl.textContent = `${hours}h ${mins}m ${secs}s`;
    }
  });
}
```

**Step 4: Add health panel CSS**

In `src/style.css`, add:

```css
/* Health Stats Section */
.settings-section h3 {
  margin: 0 0 1rem 0;
  font-size: 1.1rem;
  color: #fff;
  border-bottom: 1px solid #444;
  padding-bottom: 0.5rem;
}

#health-stats-container {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
  gap: 1rem;
  margin-bottom: 2rem;
}

.health-card {
  background: #2a2a2a;
  border: 1px solid #444;
  border-radius: 6px;
  padding: 1rem;
}

.health-camera-name {
  font-weight: 600;
  margin-bottom: 0.75rem;
  color: #4da6ff;
  font-size: 0.95rem;
}

.health-metrics {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.5rem;
}

.health-metric {
  display: flex;
  flex-direction: column;
  font-size: 0.85rem;
}

.health-label {
  color: #999;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.health-value {
  color: #fff;
  font-weight: 600;
  font-family: 'Courier New', monospace;
  margin-top: 0.25rem;
}
```

**Step 5: Test health stats display**

Run:
```bash
npm run tauri dev
```

Expected:
1. Settings panel shows health cards for each camera
2. Metrics update every 2 seconds
3. Values display: FPS, bitrate, frame count, uptime

**Step 6: Commit health UI**

Run:
```bash
git add src/main.js src/style.css
git commit -m "feat(health): add stream health stats display in settings panel

- Real-time FPS, bitrate, frame count, uptime per camera
- Grid layout with cards for each camera
- Auto-updates every 2 seconds via event listener"
```

Expected: Health UI committed

---

## Phase 4: Custom Layouts

### Task 7: Add Layout Configuration Data Model

**Files:**
- Modify: `src-tauri/src/lib.rs` (extend AppConfig)

**Step 1: Define LayoutConfig and CameraPosition**

Add to data models section:

```rust
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CameraPosition {
    pub camera_id: String,
    pub x: f32,      // 0.0 - 1.0 (percentage of viewport width)
    pub y: f32,      // 0.0 - 1.0 (percentage of viewport height)
    pub width: f32,  // 0.0 - 1.0 (percentage of viewport width)
    pub height: f32, // 0.0 - 1.0 (percentage of viewport height)
    pub z_index: i32, // For picture-in-picture layering
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct LayoutConfig {
    pub name: String,
    pub layout_type: String, // "grid", "custom", "pip"
    pub positions: Vec<CameraPosition>,
}

impl Default for LayoutConfig {
    fn default() -> Self {
        Self {
            name: "Default Grid".into(),
            layout_type: "grid".into(),
            positions: vec![],
        }
    }
}
```

**Step 2: Extend AppConfig with layouts**

Modify `AppConfig`:

```rust
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AppConfig {
    pub cameras: Vec<Camera>,
    pub shuffle_interval_secs: u64,
    #[serde(default = "default_true")]
    pub show_status_dots: bool,
    #[serde(default = "default_true")]
    pub show_camera_names: bool,
    #[serde(default = "default_quality")]
    pub quality: String,
    #[serde(default = "default_api_port")]
    pub api_port: u16,
    #[serde(default)]
    pub layouts: Vec<LayoutConfig>,
    #[serde(default)]
    pub active_layout: String, // Name of active layout
}
```

Update `Default` impl:
```rust
impl Default for AppConfig {
    fn default() -> Self {
        Self {
            cameras: vec![],
            shuffle_interval_secs: 900,
            show_status_dots: true,
            show_camera_names: true,
            quality: "medium".into(),
            api_port: 8090,
            layouts: vec![LayoutConfig::default()],
            active_layout: "Default Grid".into(),
        }
    }
}
```

**Step 3: Commit layout data models**

Run:
```bash
git add src-tauri/src/lib.rs
git commit -m "feat(layout): add layout configuration data models

- CameraPosition for custom positioning (x, y, width, height, z-index)
- LayoutConfig for named layout presets
- Extend AppConfig with layouts array and active_layout field"
```

Expected: Layout models committed

---

### Task 8: Implement Custom Layout Rendering

**Files:**
- Modify: `src/main.js` (add layout rendering modes)
- Modify: `src/style.css` (add custom layout styles)

**Step 1: Add layout state to StageView constructor**

```javascript
constructor() {
  // ... existing properties ...
  this.layouts = [];
  this.activeLayout = null;
  this.layoutMode = "grid"; // "grid", "custom", "pip"
  this.init();
}
```

**Step 2: Load layouts in init()**

```javascript
async init() {
  try {
    const config = await invoke("get_config");
    // ... existing config loading ...
    this.layouts = config.layouts || [];
    this.activeLayout = config.active_layout || "Default Grid";

    // Determine layout mode
    const currentLayout = this.layouts.find(l => l.name === this.activeLayout);
    this.layoutMode = currentLayout?.layout_type || "grid";

    // ... rest of init ...
  }
}
```

**Step 3: Refactor render() to support multiple layout modes**

Replace the existing `render()` method:

```javascript
render() {
  const grid = document.getElementById("camera-grid");

  if (this.layoutMode === "grid") {
    this.renderGridLayout(grid);
  } else if (this.layoutMode === "custom" || this.layoutMode === "pip") {
    this.renderCustomLayout(grid);
  }
}

renderGridLayout(grid) {
  const cols = Math.ceil(Math.sqrt(this.cameras.length));
  grid.style.display = "grid";
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  grid.style.gridTemplateRows = `repeat(${cols}, 1fr)`;
  grid.innerHTML = "";

  this.cameras.forEach((cam, idx) => {
    const tile = this.createCameraTile(cam, idx);
    grid.appendChild(tile);
  });
}

renderCustomLayout(grid) {
  grid.style.display = "block";
  grid.style.position = "relative";
  grid.style.width = "100%";
  grid.style.height = "100%";
  grid.innerHTML = "";

  const layout = this.layouts.find(l => l.name === this.activeLayout);
  if (!layout || !layout.positions) {
    // Fallback to grid
    this.layoutMode = "grid";
    this.renderGridLayout(grid);
    return;
  }

  layout.positions.forEach((pos) => {
    const camera = this.cameras.find(c => c.id === pos.camera_id);
    if (!camera) return;

    const idx = this.cameras.indexOf(camera);
    const tile = this.createCameraTile(camera, idx);

    // Apply custom positioning
    tile.style.position = "absolute";
    tile.style.left = `${pos.x * 100}%`;
    tile.style.top = `${pos.y * 100}%`;
    tile.style.width = `${pos.width * 100}%`;
    tile.style.height = `${pos.height * 100}%`;
    tile.style.zIndex = pos.z_index || 1;

    grid.appendChild(tile);
  });
}

createCameraTile(cam, idx) {
  const tile = document.createElement("div");
  tile.className = "camera-tile";
  tile.dataset.id = cam.id;
  tile.dataset.index = idx + 1;

  tile.innerHTML = `
    <img src="" alt="${cam.name}" draggable="false" />
    <div class="loading-spinner"></div>
    ${this.showStatusDots ? '<div class="camera-status"></div>' : ''}
    ${this.showCameraNames ? `<div class="camera-name">${cam.name}</div>` : ''}
  `;

  // Double-click for solo
  tile.addEventListener("dblclick", () => this.soloCamera(idx + 1));

  return tile;
}
```

**Step 4: Add custom layout CSS**

In `src/style.css`, ensure `.camera-tile` supports absolute positioning:

```css
.camera-tile {
  position: relative; /* Default for grid */
  background: #000;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid #333;
}

/* When in custom layout mode, tiles are positioned absolutely */
#camera-grid[data-layout="custom"] .camera-tile,
#camera-grid[data-layout="pip"] .camera-tile {
  border: 2px solid #444;
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.3);
}
```

**Step 5: Add layout mode indicator to grid**

Update `render()` to set data attribute:

```javascript
render() {
  const grid = document.getElementById("camera-grid");
  grid.dataset.layout = this.layoutMode;

  // ... rest of render logic ...
}
```

**Step 6: Test custom layout with mock data**

For testing, add a temporary layout in `init()`:

```javascript
// Temporary test layout (remove after testing)
if (this.layouts.length === 0) {
  this.layouts.push({
    name: "Test PIP",
    layout_type: "pip",
    positions: this.cameras.map((cam, i) => {
      if (i === 0) {
        return { camera_id: cam.id, x: 0, y: 0, width: 1, height: 1, z_index: 1 };
      } else {
        return {
          camera_id: cam.id,
          x: 0.75,
          y: 0.05 + (i - 1) * 0.25,
          width: 0.2,
          height: 0.15,
          z_index: 10 + i
        };
      }
    })
  });
}
```

Run:
```bash
npm run tauri dev
```

Expected: First camera fills screen, others appear as small overlays in top-right

**Step 7: Commit custom layout rendering**

Run:
```bash
git add src/main.js src/style.css
git commit -m "feat(layout): implement custom layout rendering engine

- Support grid, custom, and picture-in-picture modes
- Absolute positioning with x, y, width, height percentages
- Z-index support for layered layouts
- Refactor render() to support multiple layout types"
```

Expected: Custom layout rendering committed

---

### Task 9: Add Layout Editor UI

**Files:**
- Modify: `src/main.js` (add layout editor functions)
- Modify: `src/index.html` (add layout editor button)
- Modify: `src/style.css` (add editor styles)

**Step 1: Add layout editor button to toolbar**

In `src/index.html`, add button next to settings:

```html
<div class="toolbar">
  <button id="camera-menu-btn" class="toolbar-btn">📹 Cameras</button>
  <button id="layout-editor-btn" class="toolbar-btn">🎨 Layout</button>
  <button id="settings-btn" class="toolbar-btn">⚙️ Settings</button>
</div>
```

**Step 2: Create layout editor overlay**

Add to `src/index.html` before closing `</body>`:

```html
<div id="layout-editor-overlay" class="overlay" style="display: none;">
  <div id="layout-editor-panel" class="panel">
    <h2>Layout Editor</h2>

    <div class="layout-controls">
      <label>
        Layout Name:
        <input type="text" id="layout-name-input" placeholder="My Layout" />
      </label>

      <label>
        Layout Type:
        <select id="layout-type-select">
          <option value="grid">Auto Grid</option>
          <option value="custom">Custom Positions</option>
          <option value="pip">Picture-in-Picture</option>
        </select>
      </label>
    </div>

    <div id="layout-preview" class="layout-preview">
      <!-- Preview will be rendered here -->
    </div>

    <div class="layout-camera-list" id="layout-camera-list">
      <!-- Camera position editors will be added here -->
    </div>

    <div class="panel-actions">
      <button id="save-layout-btn" class="btn-primary">Save Layout</button>
      <button id="apply-layout-btn" class="btn-primary">Apply Now</button>
      <button id="close-layout-editor-btn" class="btn-secondary">Close</button>
    </div>
  </div>
</div>
```

**Step 3: Add layout editor methods to StageView**

```javascript
openLayoutEditor() {
  const overlay = document.getElementById("layout-editor-overlay");
  const panel = document.getElementById("layout-editor-panel");

  // Populate current layout
  const currentLayout = this.layouts.find(l => l.name === this.activeLayout) || LayoutConfig.default();
  document.getElementById("layout-name-input").value = currentLayout.name;
  document.getElementById("layout-type-select").value = currentLayout.layout_type;

  // Render camera position editors
  this.renderCameraPositionEditors(currentLayout);

  overlay.style.display = "flex";

  // Event listeners
  document.getElementById("close-layout-editor-btn").onclick = () => {
    overlay.style.display = "none";
  };

  document.getElementById("save-layout-btn").onclick = () => this.saveCurrentLayout();
  document.getElementById("apply-layout-btn").onclick = () => this.applyCurrentLayout();

  document.getElementById("layout-type-select").onchange = (e) => {
    this.handleLayoutTypeChange(e.target.value);
  };
}

renderCameraPositionEditors(layout) {
  const container = document.getElementById("layout-camera-list");
  container.innerHTML = "<h3>Camera Positions</h3>";

  this.cameras.forEach((cam, idx) => {
    const pos = layout.positions?.find(p => p.camera_id === cam.id) || {
      camera_id: cam.id,
      x: 0,
      y: 0,
      width: 0.25,
      height: 0.25,
      z_index: idx + 1
    };

    const editor = document.createElement("div");
    editor.className = "camera-position-editor";
    editor.innerHTML = `
      <h4>${cam.name}</h4>
      <div class="position-inputs">
        <label>X: <input type="number" step="0.01" min="0" max="1" value="${pos.x}" data-camera="${cam.id}" data-prop="x" /></label>
        <label>Y: <input type="number" step="0.01" min="0" max="1" value="${pos.y}" data-camera="${cam.id}" data-prop="y" /></label>
        <label>Width: <input type="number" step="0.01" min="0.1" max="1" value="${pos.width}" data-camera="${cam.id}" data-prop="width" /></label>
        <label>Height: <input type="number" step="0.01" min="0.1" max="1" value="${pos.height}" data-camera="${cam.id}" data-prop="height" /></label>
        <label>Z-Index: <input type="number" value="${pos.z_index}" data-camera="${cam.id}" data-prop="z_index" /></label>
      </div>
    `;
    container.appendChild(editor);
  });
}

handleLayoutTypeChange(newType) {
  // Auto-generate positions based on layout type
  if (newType === "grid") {
    // No custom positions needed for grid
    document.getElementById("layout-camera-list").innerHTML = "<p>Grid layout automatically arranges cameras.</p>";
  } else if (newType === "pip") {
    // Generate PIP layout: first camera full screen, others as overlays
    this.generatePIPLayout();
  }
}

generatePIPLayout() {
  const layout = {
    name: document.getElementById("layout-name-input").value || "PIP Layout",
    layout_type: "pip",
    positions: this.cameras.map((cam, i) => {
      if (i === 0) {
        return { camera_id: cam.id, x: 0, y: 0, width: 1, height: 1, z_index: 1 };
      } else {
        return {
          camera_id: cam.id,
          x: 0.75,
          y: 0.05 + (i - 1) * 0.2,
          width: 0.2,
          height: 0.15,
          z_index: 10 + i
        };
      }
    })
  };
  this.renderCameraPositionEditors(layout);
}

async saveCurrentLayout() {
  const name = document.getElementById("layout-name-input").value.trim();
  if (!name) {
    alert("Please enter a layout name");
    return;
  }

  const layoutType = document.getElementById("layout-type-select").value;
  const positions = [];

  if (layoutType !== "grid") {
    // Collect positions from inputs
    const inputs = document.querySelectorAll("#layout-camera-list input");
    const posMap = new Map();

    inputs.forEach(input => {
      const cameraId = input.dataset.camera;
      const prop = input.dataset.prop;
      if (!posMap.has(cameraId)) {
        posMap.set(cameraId, { camera_id: cameraId });
      }
      posMap.get(cameraId)[prop] = prop === "z_index" ? parseInt(input.value) : parseFloat(input.value);
    });

    positions.push(...posMap.values());
  }

  const newLayout = {
    name,
    layout_type: layoutType,
    positions
  };

  // Update or add layout
  const existingIdx = this.layouts.findIndex(l => l.name === name);
  if (existingIdx >= 0) {
    this.layouts[existingIdx] = newLayout;
  } else {
    this.layouts.push(newLayout);
  }

  // Save to config
  const config = await invoke("get_config");
  config.layouts = this.layouts;
  await invoke("save_config", { config });

  alert(`Layout "${name}" saved!`);
}

async applyCurrentLayout() {
  await this.saveCurrentLayout();

  const name = document.getElementById("layout-name-input").value.trim();
  this.activeLayout = name;

  const layout = this.layouts.find(l => l.name === name);
  this.layoutMode = layout?.layout_type || "grid";

  // Save active layout to config
  const config = await invoke("get_config");
  config.active_layout = this.activeLayout;
  await invoke("save_config", { config });

  // Re-render with new layout
  this.render();

  document.getElementById("layout-editor-overlay").style.display = "none";
}
```

**Step 4: Bind layout editor button**

In `bindEvents()` or similar:

```javascript
document.getElementById("layout-editor-btn").addEventListener("click", () => {
  this.openLayoutEditor();
});
```

**Step 5: Add layout editor CSS**

In `src/style.css`:

```css
/* Layout Editor */
.layout-preview {
  width: 100%;
  height: 300px;
  background: #1a1a1a;
  border: 1px solid #444;
  margin: 1rem 0;
  position: relative;
}

.camera-position-editor {
  background: #2a2a2a;
  border: 1px solid #444;
  padding: 1rem;
  margin-bottom: 1rem;
  border-radius: 4px;
}

.camera-position-editor h4 {
  margin: 0 0 0.5rem 0;
  color: #4da6ff;
}

.position-inputs {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 0.5rem;
}

.position-inputs label {
  display: flex;
  flex-direction: column;
  font-size: 0.85rem;
  color: #ccc;
}

.position-inputs input {
  margin-top: 0.25rem;
  padding: 0.4rem;
  background: #1a1a1a;
  border: 1px solid #555;
  color: #fff;
  border-radius: 3px;
}
```

**Step 6: Test layout editor**

Run:
```bash
npm run tauri dev
```

Expected:
1. Click "Layout" button → editor opens
2. Change layout type to "PIP" → positions auto-generate
3. Adjust camera positions → save → apply
4. Layout changes reflected in main view

**Step 7: Commit layout editor UI**

Run:
```bash
git add src/main.js src/index.html src/style.css
git commit -m "feat(layout): add visual layout editor UI

- Create/edit custom layouts with position controls
- Auto-generate PIP layout template
- Save and apply layouts in real-time
- X/Y/Width/Height/Z-index controls per camera"
```

Expected: Layout editor committed

---

## Phase 5: Camera Presets

### Task 10: Add Preset Management

**Files:**
- Modify: `src-tauri/src/lib.rs` (add preset commands)
- Modify: `src/main.js` (add preset UI)

**Step 1: Add preset data model**

In `src-tauri/src/lib.rs`:

```rust
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CameraPreset {
    pub name: String,
    pub cameras: Vec<Camera>,
}
```

Extend `AppConfig`:
```rust
pub struct AppConfig {
    // ... existing fields ...
    #[serde(default)]
    pub presets: Vec<CameraPreset>,
}
```

**Step 2: Add preset Tauri commands**

```rust
#[tauri::command]
fn save_preset(state: State<AppState>, name: String) -> Result<(), String> {
    let mut config = state.config.lock().unwrap();
    let preset = CameraPreset {
        name: name.clone(),
        cameras: config.cameras.clone(),
    };

    // Replace if exists, otherwise add
    if let Some(idx) = config.presets.iter().position(|p| p.name == name) {
        config.presets[idx] = preset;
    } else {
        config.presets.push(preset);
    }

    let json = serde_json::to_string_pretty(&*config).map_err(|e| e.to_string())?;
    std::fs::write(&state.config_path, json).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn load_preset(state: State<AppState>, name: String) -> Result<Vec<Camera>, String> {
    let config = state.config.lock().unwrap();
    let preset = config.presets.iter()
        .find(|p| p.name == name)
        .ok_or("Preset not found")?;
    Ok(preset.cameras.clone())
}

#[tauri::command]
fn delete_preset(state: State<AppState>, name: String) -> Result<(), String> {
    let mut config = state.config.lock().unwrap();
    config.presets.retain(|p| p.name != name);

    let json = serde_json::to_string_pretty(&*config).map_err(|e| e.to_string())?;
    std::fs::write(&state.config_path, json).map_err(|e| e.to_string())?;

    Ok(())
}
```

Register commands:
```rust
.invoke_handler(tauri::generate_handler![
    // ... existing commands ...
    save_preset,
    load_preset,
    delete_preset,
])
```

**Step 3: Add preset UI to settings panel**

In `src/main.js`, extend `openSettings()`:

```javascript
openSettings() {
  // ... existing settings panel code ...

  // Add presets section
  const presetsHTML = `
    <div class="settings-section">
      <h3>Camera Presets</h3>
      <div class="preset-controls">
        <input type="text" id="preset-name-input" placeholder="Preset name" />
        <button id="save-preset-btn" class="btn-primary">Save Current as Preset</button>
      </div>
      <div id="preset-list" class="preset-list">
        ${config.presets.map(p => `
          <div class="preset-item">
            <span class="preset-name">${p.name}</span>
            <div class="preset-actions">
              <button class="btn-small" onclick="app.loadPreset('${p.name}')">Load</button>
              <button class="btn-small btn-danger" onclick="app.deletePreset('${p.name}')">Delete</button>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  // Insert before camera configuration
  // ... append presetsHTML to panel ...

  // Bind save preset button
  document.getElementById("save-preset-btn").onclick = async () => {
    const name = document.getElementById("preset-name-input").value.trim();
    if (!name) {
      alert("Enter a preset name");
      return;
    }

    try {
      await invoke("save_preset", { name });
      alert(`Preset "${name}" saved!`);
      this.openSettings(); // Refresh
    } catch (e) {
      alert(`Error: ${e}`);
    }
  };
}
```

**Step 4: Add preset load/delete methods**

```javascript
async loadPreset(name) {
  try {
    const cameras = await invoke("load_preset", { name });
    this.cameras = cameras;

    // Save as current config
    const config = await invoke("get_config");
    config.cameras = cameras;
    await invoke("save_config", { config });

    // Restart streams
    await invoke("stop_streams");
    this.render();
    await invoke("start_streams");

    alert(`Preset "${name}" loaded!`);
  } catch (e) {
    alert(`Error loading preset: ${e}`);
  }
}

async deletePreset(name) {
  if (!confirm(`Delete preset "${name}"?`)) return;

  try {
    await invoke("delete_preset", { name });
    alert(`Preset "${name}" deleted!`);
    this.openSettings(); // Refresh
  } catch (e) {
    alert(`Error: ${e}`);
  }
}
```

**Step 5: Add preset CSS**

```css
.preset-controls {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1rem;
}

.preset-controls input {
  flex: 1;
}

.preset-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.preset-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem;
  background: #2a2a2a;
  border: 1px solid #444;
  border-radius: 4px;
}

.preset-name {
  font-weight: 600;
  color: #4da6ff;
}

.preset-actions {
  display: flex;
  gap: 0.5rem;
}

.btn-small {
  padding: 0.3rem 0.6rem;
  font-size: 0.8rem;
}

.btn-danger {
  background: #d9534f;
}

.btn-danger:hover {
  background: #c9302c;
}
```

**Step 6: Test presets**

Run:
```bash
npm run tauri dev
```

Test:
1. Configure 3 cameras → Save as "Test Setup"
2. Change cameras → Save as "Alternative"
3. Load "Test Setup" → should restore original cameras

**Step 7: Commit preset feature**

Run:
```bash
git add src-tauri/src/lib.rs src/main.js src/style.css
git commit -m "feat(presets): add camera preset save/load/delete functionality

- Save current camera configuration as named preset
- Load preset to quickly switch camera setups
- Delete unwanted presets
- UI in settings panel with preset list"
```

Expected: Presets committed

---

## Phase 6: Drag-and-Drop Reordering

### Task 11: Implement Drag-and-Drop for Grid Layout

**Files:**
- Modify: `src/main.js` (add drag handlers)
- Modify: `src/style.css` (add drag styles)

**Step 1: Add drag state to StageView**

```javascript
constructor() {
  // ... existing properties ...
  this.draggedTile = null;
  this.dragStartIndex = null;
  this.init();
}
```

**Step 2: Make camera tiles draggable**

In `createCameraTile()`, add drag attributes and listeners:

```javascript
createCameraTile(cam, idx) {
  const tile = document.createElement("div");
  tile.className = "camera-tile";
  tile.dataset.id = cam.id;
  tile.dataset.index = idx + 1;
  tile.draggable = true; // Make draggable

  tile.innerHTML = `
    <img src="" alt="${cam.name}" draggable="false" />
    <div class="loading-spinner"></div>
    ${this.showStatusDots ? '<div class="camera-status"></div>' : ''}
    ${this.showCameraNames ? `<div class="camera-name">${cam.name}</div>` : ''}
  `;

  // Double-click for solo
  tile.addEventListener("dblclick", () => this.soloCamera(idx + 1));

  // Drag handlers
  tile.addEventListener("dragstart", (e) => this.handleDragStart(e, idx));
  tile.addEventListener("dragover", (e) => this.handleDragOver(e));
  tile.addEventListener("drop", (e) => this.handleDrop(e, idx));
  tile.addEventListener("dragend", (e) => this.handleDragEnd(e));

  return tile;
}
```

**Step 3: Implement drag handlers**

```javascript
handleDragStart(e, index) {
  this.draggedTile = e.currentTarget;
  this.dragStartIndex = index;
  e.currentTarget.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/html", e.currentTarget.innerHTML);
}

handleDragOver(e) {
  if (e.preventDefault) e.preventDefault();
  e.dataTransfer.dropEffect = "move";

  const target = e.currentTarget;
  if (target.classList.contains("camera-tile") && target !== this.draggedTile) {
    target.classList.add("drag-over");
  }

  return false;
}

handleDrop(e, targetIndex) {
  if (e.stopPropagation) e.stopPropagation();
  e.preventDefault();

  const target = e.currentTarget;
  target.classList.remove("drag-over");

  if (this.draggedTile !== target && this.dragStartIndex !== targetIndex) {
    // Swap cameras in array
    const temp = this.cameras[this.dragStartIndex];
    this.cameras[this.dragStartIndex] = this.cameras[targetIndex];
    this.cameras[targetIndex] = temp;

    // Re-render to reflect new order
    this.render();

    // Save new order to config
    this.saveCameraOrder();
  }

  return false;
}

handleDragEnd(e) {
  e.currentTarget.classList.remove("dragging");

  // Remove all drag-over classes
  document.querySelectorAll(".camera-tile").forEach(tile => {
    tile.classList.remove("drag-over");
  });

  this.draggedTile = null;
  this.dragStartIndex = null;
}

async saveCameraOrder() {
  try {
    const config = await invoke("get_config");
    config.cameras = this.cameras;
    await invoke("save_config", { config });
  } catch (e) {
    console.error("Failed to save camera order:", e);
  }
}
```

**Step 4: Add drag CSS**

In `src/style.css`:

```css
/* Drag and Drop */
.camera-tile {
  cursor: grab;
  transition: opacity 0.2s, transform 0.2s;
}

.camera-tile:active {
  cursor: grabbing;
}

.camera-tile.dragging {
  opacity: 0.5;
  transform: scale(0.95);
}

.camera-tile.drag-over {
  border: 2px solid #4da6ff;
  transform: scale(1.05);
}
```

**Step 5: Disable drag in solo mode**

In `soloCamera()` and `exitSolo()`:

```javascript
soloCamera(index) {
  // ... existing solo logic ...

  // Disable dragging in solo mode
  document.querySelectorAll(".camera-tile").forEach(tile => {
    tile.draggable = false;
  });
}

exitSolo() {
  // ... existing exit solo logic ...

  // Re-enable dragging
  document.querySelectorAll(".camera-tile").forEach(tile => {
    tile.draggable = true;
  });
}
```

**Step 6: Test drag-and-drop**

Run:
```bash
npm run tauri dev
```

Test:
1. Drag camera 1 onto camera 3 → should swap positions
2. Release → order should persist after app restart
3. Enter solo mode → dragging should be disabled

**Step 7: Commit drag-and-drop**

Run:
```bash
git add src/main.js src/style.css
git commit -m "feat(ux): add drag-and-drop camera reordering in grid mode

- Drag camera tiles to swap positions
- Auto-save new order to config
- Visual feedback: opacity, scale, border highlight
- Disabled in solo mode"
```

Expected: Drag-and-drop committed

---

## Phase 7: Multi-Monitor Support

### Task 12: Add Window Management for Multi-Monitor

**Files:**
- Modify: `src/main.js` (add window position saving)
- Modify: `src-tauri/src/lib.rs` (add window state to config)

**Step 1: Extend AppConfig with window state**

In `src-tauri/src/lib.rs`:

```rust
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WindowState {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

impl Default for WindowState {
    fn default() -> Self {
        Self {
            x: 100,
            y: 100,
            width: 1280,
            height: 720,
            maximized: false,
        }
    }
}
```

Add to `AppConfig`:
```rust
pub struct AppConfig {
    // ... existing fields ...
    #[serde(default)]
    pub window_state: WindowState,
}
```

**Step 2: Save window state on move/resize**

In `src/main.js`, add window listeners in `init()`:

```javascript
async init() {
  // ... existing init code ...

  // Save window state on move/resize
  const currentWindow = getCurrentWindow();

  let saveTimeout;
  const saveWindowState = async () => {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(async () => {
      try {
        const position = await currentWindow.outerPosition();
        const size = await currentWindow.outerSize();
        const maximized = await currentWindow.isMaximized();

        const config = await invoke("get_config");
        config.window_state = {
          x: position.x,
          y: position.y,
          width: size.width,
          height: size.height,
          maximized
        };
        await invoke("save_config", { config });
      } catch (e) {
        console.error("Failed to save window state:", e);
      }
    }, 500); // Debounce 500ms
  };

  // Listen for window events
  await currentWindow.listen("tauri://resize", saveWindowState);
  await currentWindow.listen("tauri://move", saveWindowState);
}
```

**Step 3: Restore window state on launch**

In `src-tauri/src/main.rs`, modify window builder:

```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Load config to get window state
            let config_dir = dirs::config_dir()
                .ok_or("Could not determine config directory")?
                .join("StageView");
            let config_path = config_dir.join("config.json");

            let window_state = if config_path.exists() {
                let json = std::fs::read_to_string(&config_path).ok();
                json.and_then(|s| serde_json::from_str::<AppConfig>(&s).ok())
                    .map(|c| c.window_state)
                    .unwrap_or_default()
            } else {
                WindowState::default()
            };

            // Apply window state
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
                    x: window_state.x,
                    y: window_state.y,
                }));
                let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize {
                    width: window_state.width,
                    height: window_state.height,
                }));
                if window_state.maximized {
                    let _ = window.maximize();
                }
            }

            Ok(())
        })
        // ... rest of builder ...
}
```

**Step 4: Add multi-window support (optional)**

Add keyboard shortcut to open new window:

In `src/main.js`:

```javascript
async openNewWindow() {
  const { Window } = window.__TAURI__.window;
  const webview = new Window(`stageview-${Date.now()}`, {
    url: '/',
    title: 'StageView',
    width: 1280,
    height: 720,
  });
  await webview.show();
}

// Bind to keyboard shortcut
bindKeys() {
  // ... existing bindings ...

  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key === "n") {
      e.preventDefault();
      this.openNewWindow();
    }
  });
}
```

**Step 5: Test multi-monitor**

Run:
```bash
npm run tauri build
```

Test:
1. Move window to second monitor
2. Resize window
3. Close and relaunch → window should reappear in same position
4. Press Ctrl+N → new window opens (optional)

**Step 6: Commit multi-monitor support**

Run:
```bash
git add src/main.js src-tauri/src/main.rs src-tauri/src/lib.rs
git commit -m "feat(multimonitor): add window position/size persistence

- Save window state (position, size, maximized) to config
- Restore window state on app launch
- Debounced save (500ms) to avoid excessive writes
- Support for multi-monitor setups"
```

Expected: Multi-monitor support committed

---

## Phase 8: Final Integration & Testing

### Task 13: Integration Testing

**Files:**
- Create: `docs/TESTING.md`

**Step 1: Create testing checklist**

Create `docs/TESTING.md`:

```markdown
# StageView Testing Checklist

## Foundation Features

### Git & Documentation
- [ ] `.gitignore` properly excludes build artifacts and binaries
- [ ] README renders correctly on GitHub
- [ ] All installation instructions work on target platforms
- [ ] API documentation matches actual endpoints

### Auto-Reconnection
- [ ] Camera reconnects after network drop
- [ ] Exponential backoff increases delay correctly (1s, 2s, 4s, 8s...)
- [ ] Status dot shows orange pulsing during reconnection
- [ ] After 10 attempts, retry resets with longer delay
- [ ] Successful reconnection shows green status dot

## Feature Enhancements

### Stream Health Stats
- [ ] FPS displays correctly for each camera
- [ ] Bitrate updates every 2 seconds
- [ ] Frame count increments
- [ ] Uptime shows hours:minutes:seconds format
- [ ] Stats persist when settings panel is closed and reopened

### Custom Layouts
- [ ] Grid layout arranges cameras in square grid
- [ ] Custom layout positions cameras at specified x/y coordinates
- [ ] PIP layout shows main camera full screen with overlays
- [ ] Z-index controls layering correctly
- [ ] Layout persists after app restart

### Layout Editor
- [ ] Layout editor opens via toolbar button
- [ ] Changing layout type updates position editors
- [ ] PIP auto-generation creates correct positions
- [ ] Manual position adjustments (x, y, width, height) work
- [ ] Save Layout persists to config
- [ ] Apply Layout switches view immediately

### Camera Presets
- [ ] Save Preset stores current camera list
- [ ] Load Preset restores cameras and restarts streams
- [ ] Delete Preset removes from list
- [ ] Preset names display in settings panel
- [ ] Presets persist across app restarts

### Drag-and-Drop Reordering
- [ ] Dragging camera tile shows visual feedback (opacity, scale)
- [ ] Dropping on another tile swaps positions
- [ ] Camera order persists after app restart
- [ ] Drag disabled in solo mode
- [ ] Drag cursor changes (grab/grabbing)

### Multi-Monitor Support
- [ ] Window position saves when moved
- [ ] Window size saves when resized
- [ ] Window restores to correct monitor on launch
- [ ] Maximized state persists
- [ ] Works correctly on multi-monitor setups

## Regression Testing

### Core Functionality (ensure not broken)
- [ ] Multi-camera grid displays correctly
- [ ] Solo mode works (double-click, number keys)
- [ ] Burn-in protection shuffle still works
- [ ] Pixel orbiting still works
- [ ] Noise overlay still works
- [ ] Remote API endpoints still respond
- [ ] Settings panel saves configuration
- [ ] Quality presets (low/medium/high) work
- [ ] Keyboard shortcuts (F11, 1-9, 0, ESC) work

## Cross-Platform Testing

### Windows
- [ ] FFmpeg binary bundled correctly
- [ ] Config saves to `%APPDATA%\StageView\`
- [ ] Installer works (.msi)
- [ ] All features functional

### macOS
- [ ] FFmpeg bundled or uses system FFmpeg
- [ ] Config saves to `~/Library/Application Support/StageView/`
- [ ] DMG installer works
- [ ] All features functional

### Linux
- [ ] FFmpeg installed or bundled
- [ ] Config saves to `~/.config/StageView/`
- [ ] AppImage works
- [ ] All features functional

## Performance Testing

- [ ] 4 cameras: smooth at high quality
- [ ] 9 cameras: smooth at medium quality
- [ ] 16 cameras: smooth at low quality
- [ ] CPU usage reasonable (<30% for 9 cameras)
- [ ] Memory usage stable (no leaks)
- [ ] Reconnection doesn't cause memory spike

## Edge Cases

- [ ] Empty camera list doesn't crash
- [ ] Invalid camera URL shows error status
- [ ] Duplicate camera names handled
- [ ] Very long camera names truncate gracefully
- [ ] Rapid layout switching doesn't crash
- [ ] Deleting active layout falls back to grid
- [ ] Loading preset with non-existent cameras handled
```

**Step 2: Run integration tests**

Test each feature manually:
```bash
npm run tauri dev
```

Go through testing checklist and mark items as completed.

**Step 3: Fix any discovered bugs**

If bugs found, create fix commits:
```bash
git add <files>
git commit -m "fix(component): description of fix"
```

**Step 4: Commit testing documentation**

Run:
```bash
git add docs/TESTING.md
git commit -m "docs: add comprehensive testing checklist"
```

Expected: Testing docs committed

---

### Task 14: Final Polish and Cleanup

**Files:**
- Modify: `README.md` (update with new features)

**Step 1: Update README with new features**

Add to features section:

```markdown
### Advanced Features
- **Auto-Reconnection** - Streams automatically reconnect with exponential backoff
- **Stream Health Monitoring** - Real-time FPS, bitrate, uptime per camera
- **Custom Layouts** - Picture-in-picture, custom positioning, grid
- **Camera Presets** - Save and load camera configurations instantly
- **Drag-and-Drop** - Reorder cameras in grid mode
- **Multi-Monitor** - Window position/size persists across sessions
```

**Step 2: Update keyboard shortcuts table**

```markdown
| Key | Action |
|-----|--------|
| **1-9** | Solo camera at that position |
| **0 / ESC** | Return to grid view |
| **F11 / F** | Toggle fullscreen |
| **Ctrl+N** | Open new window (multi-monitor) |
```

**Step 3: Commit README updates**

Run:
```bash
git add README.md
git commit -m "docs: update README with new features (reconnection, health, layouts, presets, DnD)"
```

Expected: Updated README committed

**Step 4: Create release tag**

Run:
```bash
git tag -a v1.0.0 -m "StageView v1.0.0 - Full feature release

Features:
- Auto-reconnection with exponential backoff
- Stream health monitoring
- Custom layouts (grid, PIP, custom)
- Camera presets
- Drag-and-drop reordering
- Multi-monitor support
- Comprehensive documentation"

git log --oneline --graph --all
```

Expected: Version tag created

---

## Summary

**Total Tasks: 14**
**Estimated Commits: ~20**

### Task Breakdown by Phase:
1. **Foundation (Tasks 1-2)**: Git init, README
2. **Auto-Reconnection (Tasks 3-4)**: Backend retry logic, frontend UI
3. **Stream Health (Tasks 5-6)**: Backend tracking, frontend display
4. **Custom Layouts (Tasks 7-9)**: Data models, rendering engine, editor UI
5. **Presets (Task 10)**: Save/load camera configs
6. **Drag-and-Drop (Task 11)**: Interactive reordering
7. **Multi-Monitor (Task 12)**: Window state persistence
8. **Integration (Tasks 13-14)**: Testing, documentation, release

### Key Design Decisions:
- **Vanilla JS**: Maintains lightweight frontend, no build complexity
- **Rust/Tauri**: High-performance backend, native desktop experience
- **Event-driven architecture**: Tauri events for real-time updates
- **Percentage-based positioning**: Layout flexibility across screen sizes
- **Exponential backoff**: Industry-standard reconnection pattern
- **Local config persistence**: User preferences survive restarts

### Testing Strategy:
- Manual feature testing via `npm run tauri dev`
- Cross-platform testing (Windows/macOS/Linux)
- Performance testing with varying camera counts
- Edge case handling (empty lists, invalid URLs, rapid switching)

**Ready for execution with subagent-driven development.**
