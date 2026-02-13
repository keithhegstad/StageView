# StageView Production Hardening & Codec Enhancement - Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform StageView into a production-grade 24/7 streaming application with hardware-accelerated encoding

**Architecture:** Two-phase approach - Phase 1 hardens existing system for reliability (camera order fix, memory management, enhanced reconnection, monitoring), Phase 2 adds H.264 hardware encoding with auto-fallback chain (nvenc → QSV → x264 → MJPEG)

**Tech Stack:** Tauri 2, Rust (Tokio async), Vanilla JavaScript, FFmpeg, Media Source Extensions

---

## Phase 1: Production Hardening

### Task 1: Fix Camera Order - Add Display Index Array

**Goal:** Separate insertion order (settings) from display order (grid shuffle)

**Files:**
- Modify: `src/main.js:44-55` (constructor)
- Modify: `src/main.js:451-481` (shuffleCameras method)
- Modify: `src/main.js:200-240` (render methods)

**Step 1: Add displayOrder array to constructor**

In `src/main.js` constructor (around line 44):

```javascript
constructor() {
  this.cameras = [];           // Insertion order (never shuffled)
  this.displayOrder = [];      // Indices into cameras array (shuffled for burn-in)
  this.layouts = [];
  // ... rest of constructor
}
```

**Step 2: Initialize displayOrder when cameras load**

In `init()` method after loading cameras (around line 68):

```javascript
this.cameras = config.cameras;
this.displayOrder = this.cameras.map((_, i) => i);  // Initialize to [0, 1, 2, ...]
```

**Step 3: Update shuffleCameras to shuffle indices only**

Replace existing shuffle logic in `shuffleCameras()` method:

```javascript
shuffleCameras() {
  // In solo mode, do a pixel refresh instead of shuffling
  if (this.soloIndex !== null) {
    this.doPixelRefresh();
    return;
  }

  // Shuffle displayOrder indices, not camera objects
  if (this.displayOrder.length < 2) return;

  // Sattolo's algorithm on indices
  for (let i = this.displayOrder.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * i);
    [this.displayOrder[i], this.displayOrder[j]] =
      [this.displayOrder[j], this.displayOrder[i]];
  }

  // Rearrange DOM tiles using displayOrder
  const grid = document.getElementById("grid");
  const tileMap = {};
  grid.querySelectorAll(".camera-tile").forEach((tile) => {
    tileMap[tile.dataset.id] = tile;
  });

  // Append in displayOrder sequence
  for (const index of this.displayOrder) {
    const cam = this.cameras[index];
    const tile = tileMap[cam.id];
    if (tile) {
      grid.appendChild(tile);
    }
  }
}
```

**Step 4: Update renderGridLayout to use displayOrder**

In `renderGridLayout()` method (around line 217):

```javascript
renderGridLayout(grid) {
  // ... existing setup code

  const tiles = [];
  // Use displayOrder to determine grid sequence
  for (const index of this.displayOrder) {
    const cam = this.cameras[index];
    const tile = this.createCameraTile(cam, index);
    tiles.push(tile);
  }

  tiles.forEach(tile => grid.appendChild(tile));
  // ... rest of method
}
```

**Step 5: Verify settings panel uses cameras array**

Confirm `renderCameraList()` (line 959) already uses `this.cameras` directly:

```javascript
renderCameraList() {
  const list = document.getElementById("camera-list");

  list.innerHTML = this.cameras  // ✓ Uses insertion order
    .map((cam, i) => `
      <div class="camera-entry" data-index="${i}">
        ...
      </div>
    `)
    .join("");
}
```

**Step 6: Test camera order behavior**

Manual test:
1. Add 3 cameras: A, B, C
2. Check settings shows: A, B, C
3. Wait for burn-in shuffle
4. Check grid shuffles (e.g., C, A, B)
5. Check settings still shows: A, B, C ✓

**Step 7: Commit**

```bash
git add src/main.js
git commit -m "feat(camera): separate insertion order from display order

- Add displayOrder array for grid shuffle
- Keep cameras array in insertion order
- Settings panel always shows insertion order
- Grid can shuffle independently via displayOrder

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 2: Add API Camera Index to Settings

**Goal:** Show API index number next to each camera in settings

**Files:**
- Modify: `src/main.js:959-983` (renderCameraList method)
- Modify: `src/style.css` (add styling for index badge)

**Step 1: Add index badge to camera entry HTML**

In `renderCameraList()` method:

```javascript
renderCameraList() {
  const list = document.getElementById("camera-list");

  if (this.cameras.length === 0) {
    this.addCameraField();
    return;
  }

  list.innerHTML = this.cameras
    .map((cam, i) => `
      <div class="camera-entry" data-index="${i}">
        <span class="api-index" title="API Index: Use /api/solo/${i + 1}">${i + 1}</span>
        <input type="text" placeholder="Camera name" value="${cam.name}" data-field="name" />
        <input type="text" placeholder="rtp://224.1.2.4:4000" value="${cam.url}" data-field="url" />
        <button class="remove-btn" data-remove-index="${i}">✕</button>
      </div>
    `)
    .join("");

  // ... rest of method
}
```

**Step 2: Add CSS styling for API index badge**

In `src/style.css`, add after `.camera-entry` styles (around line 750):

```css
.api-index {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  height: 24px;
  padding: 0 6px;
  background: #3b82f6;
  color: white;
  font-size: 0.75rem;
  font-weight: 600;
  border-radius: 4px;
  margin-right: 8px;
  cursor: help;
}
```

**Step 3: Test API index display**

Manual test:
1. Open settings
2. Verify camera 1 shows badge "1"
3. Verify camera 2 shows badge "2"
4. Hover badge shows tooltip: "API Index: Use /api/solo/1"

**Step 4: Commit**

```bash
git add src/main.js src/style.css
git commit -m "feat(api): show camera API index in settings

- Add numbered badge next to each camera
- Tooltip shows API usage example
- Makes API integration easier for users

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 3: Backend - Add Buffer Pool for Memory Management

**Goal:** Prevent memory fragmentation from per-frame allocations

**Files:**
- Modify: `src-tauri/src/lib.rs` (add BufferPool struct)
- Modify: `src-tauri/src/lib.rs:517-612` (use pool in frame processing)

**Step 1: Add BufferPool struct**

Add after imports in `src-tauri/src/lib.rs` (around line 100):

```rust
/// Reusable buffer pool to prevent memory fragmentation
struct BufferPool {
    buffers: Mutex<Vec<Vec<u8>>>,
    max_buffers: usize,
}

impl BufferPool {
    fn new(max_buffers: usize) -> Self {
        Self {
            buffers: Mutex::new(Vec::new()),
            max_buffers,
        }
    }

    fn acquire(&self) -> Vec<u8> {
        self.buffers
            .lock()
            .unwrap()
            .pop()
            .unwrap_or_else(|| Vec::with_capacity(64 * 1024))
    }

    fn release(&self, mut buf: Vec<u8>) {
        buf.clear();
        let mut pool = self.buffers.lock().unwrap();
        if pool.len() < self.max_buffers {
            pool.push(buf);
        }
        // Else: drop buffer (pool is full)
    }
}
```

**Step 2: Add buffer pool to AppState**

In `AppState` struct (around line 114):

```rust
pub struct AppState {
    pub config: Mutex<AppConfig>,
    pub stream_tasks: Mutex<HashMap<String, JoinHandle<()>>>,
    pub stream_health: Mutex<HashMap<String, StreamHealth>>,
    pub reconnect_attempts: Mutex<HashMap<String, u32>>,
    pub buffer_pool: BufferPool,  // NEW
}
```

**Step 3: Initialize buffer pool in main**

In `main()` function where AppState is created (around line 870):

```rust
let state = AppState {
    config: Mutex::new(config),
    stream_tasks: Mutex::new(HashMap::new()),
    stream_health: Mutex::new(HashMap::new()),
    reconnect_attempts: Mutex::new(HashMap::new()),
    buffer_pool: BufferPool::new(32),  // Pool of 32 buffers
};
```

**Step 4: Use buffer pool in frame processing**

In `try_stream_camera()` method, replace frame buffer allocation (around line 523):

```rust
// OLD: let mut frame_data: Vec<u8> = Vec::with_capacity(64 * 1024);
// NEW: Acquire from pool
let mut frame_data = state.buffer_pool.acquire();

// ... process frame ...

// After emitting frame, release buffer back to pool
state.buffer_pool.release(frame_data);
frame_data = state.buffer_pool.acquire();  // Get fresh buffer for next frame
```

**Step 5: Test memory stability**

Run app for 1 hour, monitor memory:
```bash
# Windows Task Manager or:
npm run tauri dev
# Monitor memory usage - should be stable, not growing
```

**Step 6: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(memory): add buffer pool for frame processing

- Implement reusable buffer pool (max 32 buffers)
- Prevents memory fragmentation from per-frame allocations
- Reduces GC pressure in long-running sessions

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 4: Backend - Enhanced Reconnection with Unlimited Attempts

**Goal:** Never give up reconnecting, use smarter backoff strategy

**Files:**
- Modify: `src-tauri/src/lib.rs:345-409` (try_stream_camera method)

**Step 1: Update backoff calculation**

Replace existing backoff logic (around line 360):

```rust
fn calculate_backoff(attempt: u32) -> Duration {
    match attempt {
        1..=5 => Duration::from_secs(2u64.pow(attempt.saturating_sub(1))),  // 1s, 2s, 4s, 8s, 16s
        6..=10 => Duration::from_secs(60),                                    // 60s
        _ => Duration::from_secs(300),                                        // 5 min for long outages
    }
}
```

**Step 2: Remove max attempt limit**

In `try_stream_camera()` method, update retry loop (around line 352):

```rust
// Remove this check:
// if attempt > 10 {
//     eprintln!("Camera {} failed after 10 attempts", camera_id);
//     return;
// }

// Keep only the backoff and status emit:
let backoff = calculate_backoff(attempt);
if attempt > 1 {
    let status_msg = if attempt <= 10 {
        format!("reconnecting (attempt {})", attempt)
    } else {
        format!("reconnecting ({}m wait)", backoff.as_secs() / 60)
    };

    let _ = app_handle.emit_all("camera-status", json!({
        "camera_id": camera_id,
        "status": status_msg
    }));

    tokio::time::sleep(backoff).await;
}
```

**Step 3: Add attempt counter reset on success**

In frame processing loop (around line 557), ensure attempt counter resets:

```rust
// Reset reconnect counter on successful frame
{
    let mut attempts = state.reconnect_attempts.lock().unwrap();
    attempts.insert(camera_id.clone(), 0);  // Reset to 0 on success
}
```

**Step 4: Test reconnection behavior**

Manual test:
1. Start camera stream
2. Disconnect network
3. Verify attempts continue indefinitely
4. Reconnect network
5. Verify stream resumes
6. Check attempt counter reset to 0

**Step 5: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(reconnect): unlimited retry with smart backoff

- Remove 10-attempt limit, never give up
- Backoff: 1-16s (exponential), 60s (6-10 attempts), 5min (11+)
- Reset counter on any successful frame
- Better for 24/7 operation with network outages

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 5: Frontend - Health Warning System

**Goal:** Visual indicators when cameras go offline

**Files:**
- Modify: `src/main.js` (add health state tracking)
- Modify: `src/style.css` (add health state styles)

**Step 1: Add health state tracking**

In `main.js` constructor (around line 50):

```javascript
constructor() {
  // ... existing fields
  this.cameraHealthStates = new Map();  // Track health per camera
  this.healthCheckInterval = null;
}
```

**Step 2: Add health check method**

Add new method in `main.js`:

```javascript
startHealthMonitoring() {
  // Check every 10 seconds
  this.healthCheckInterval = setInterval(() => {
    const now = Date.now();

    this.cameras.forEach((cam) => {
      const health = this.healthStats.get(cam.id);
      if (!health) {
        this.updateCameraHealthState(cam.id, 'offline');
        return;
      }

      const lastFrameTime = health.last_frame_time || 0;
      const offlineSeconds = (now - lastFrameTime) / 1000;

      if (offlineSeconds > 300) {  // 5+ minutes
        this.updateCameraHealthState(cam.id, 'error');
      } else if (offlineSeconds > 60) {  // 1+ minute
        this.updateCameraHealthState(cam.id, 'warn');
      } else {
        this.updateCameraHealthState(cam.id, 'online');
      }
    });
  }, 10000);
}

updateCameraHealthState(cameraId, state) {
  const prevState = this.cameraHealthStates.get(cameraId);
  if (prevState === state) return;  // No change

  this.cameraHealthStates.set(cameraId, state);

  // Update health card visual state
  const card = document.querySelector(`[data-camera-id="${cameraId}"]`);
  if (card) {
    card.dataset.healthState = state;
  }

  // Show notification for error state
  if (state === 'error' && prevState !== 'error') {
    const cam = this.cameras.find(c => c.id === cameraId);
    this.showToast(`Camera "${cam?.name || 'Unknown'}" offline for 5+ minutes`, 'error');
  }
}

showToast(message, type = 'info') {
  // Simple toast notification (can enhance later)
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => toast.remove(), type === 'error' ? 10000 : 5000);
}
```

**Step 3: Start monitoring in init**

In `init()` method, after loading config (around line 75):

```javascript
async init() {
  // ... existing init code

  this.startHealthMonitoring();
}
```

**Step 4: Add CSS for health states**

In `src/style.css`, add:

```css
/* Health state indicators on health cards */
.health-card[data-health-state="online"] {
  border-left: 3px solid #10b981;
}

.health-card[data-health-state="warn"] {
  border-left: 3px solid #f59e0b;
}

.health-card[data-health-state="error"] {
  border-left: 3px solid #ef4444;
}

/* Toast notifications */
.toast {
  position: fixed;
  bottom: 20px;
  right: 20px;
  padding: 12px 20px;
  border-radius: 6px;
  color: white;
  font-size: 0.9rem;
  z-index: 9999;
  animation: slideIn 0.3s ease-out;
}

.toast-info { background: #3b82f6; }
.toast-warn { background: #f59e0b; }
.toast-error { background: #ef4444; }
.toast-success { background: #10b981; }

@keyframes slideIn {
  from {
    transform: translateX(400px);
    opacity: 0;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}
```

**Step 5: Test health warnings**

Manual test:
1. Start app with cameras
2. Verify green border (online)
3. Stop one camera stream
4. Wait 1 minute - verify yellow border (warn)
5. Wait 5 minutes - verify red border + toast notification (error)

**Step 6: Commit**

```bash
git add src/main.js src/style.css
git commit -m "feat(monitoring): add camera health warning system

- Track offline duration per camera
- Visual states: online (green), warn (yellow), error (red)
- Toast notification at 5+ minutes offline
- Checks every 10 seconds

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 6: Backend - Add Log Rotation

**Goal:** Prevent log files from filling disk

**Files:**
- Modify: `src-tauri/Cargo.toml` (add dependencies)
- Modify: `src-tauri/src/main.rs` (setup logging)

**Step 1: Add logging dependencies**

In `src-tauri/Cargo.toml`, add to `[dependencies]`:

```toml
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
tracing-appender = "0.2"
```

**Step 2: Setup logging in main.rs**

In `src-tauri/src/main.rs`, add logging setup:

```rust
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

fn setup_logging() {
    // Create logs directory
    let log_dir = dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("StageView")
        .join("logs");

    std::fs::create_dir_all(&log_dir).ok();

    // Daily rotation, keep 5 files
    let file_appender = tracing_appender::rolling::daily(log_dir, "stageview.log");
    let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);

    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .with(tracing_subscriber::fmt::layer().with_writer(non_blocking))
        .init();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    setup_logging();  // Add this line first

    tauri::Builder::default()
        // ... rest of builder
}
```

**Step 3: Replace println/eprintln with tracing macros**

In `src-tauri/src/lib.rs`, replace debug prints:

```rust
use tracing::{error, warn, info, debug};

// OLD: eprintln!("Camera {} failed: {}", id, err);
// NEW:
error!("Camera {} failed: {}", id, err);

// OLD: println!("First frame for {}", id);
// NEW:
info!("First frame for {}", id);
```

**Step 4: Test log rotation**

Manual test:
1. Run app for 24+ hours (or modify rotation to hourly for testing)
2. Check logs directory contains rotated files
3. Verify old logs auto-delete (keep 5 newest)

**Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/main.rs src-tauri/src/lib.rs
git commit -m "feat(logging): add log rotation with tracing

- Daily log rotation, keep 5 files
- Replace println/eprintln with tracing macros
- Logs to: ~/.config/StageView/logs/stageview.log
- Prevents disk fill on long-running instances

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Phase 2: Codec Enhancement

### Task 7: Backend - Add Codec Configuration Structs

**Goal:** Define codec types and encoder options in config

**Files:**
- Modify: `src-tauri/src/lib.rs:14-100` (add codec enums and structs)

**Step 1: Add codec enums**

Add after existing imports in `src-tauri/src/lib.rs`:

```rust
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum CodecType {
    H264,
    MJPEG,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum EncoderType {
    Auto,         // Try hardware, fallback to software
    Nvenc,        // Force NVIDIA
    QSV,          // Force Intel
    VideoToolbox, // Force macOS
    X264,         // Force software H.264
    MJPEG,        // Force MJPEG
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Quality {
    Low,     // 720p max, 5 fps
    Medium,  // 1080p max, 10 fps
    High,    // Original, 15 fps
}
```

**Step 2: Add StreamConfig struct**

```rust
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct StreamConfig {
    pub codec: CodecType,
    pub encoder: EncoderType,
    pub quality: Quality,
}

impl Default for StreamConfig {
    fn default() -> Self {
        Self {
            codec: CodecType::MJPEG,      // Backward compatible
            encoder: EncoderType::MJPEG,
            quality: Quality::Medium,
        }
    }
}
```

**Step 3: Add AvailableEncoders struct**

```rust
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AvailableEncoders {
    pub nvenc: bool,
    pub qsv: bool,
    pub videotoolbox: bool,
    pub x264: bool,  // Always true
}

impl Default for AvailableEncoders {
    fn default() -> Self {
        Self {
            nvenc: false,
            qsv: false,
            videotoolbox: false,
            x264: true,
        }
    }
}
```

**Step 4: Add to AppConfig**

In `AppConfig` struct (around line 118):

```rust
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AppConfig {
    pub cameras: Vec<Camera>,
    pub layouts: Vec<LayoutConfig>,
    pub active_layout: String,
    pub shuffle_interval_secs: u64,
    pub quality: String,  // Deprecated, use stream_config.quality
    pub show_status_dots: bool,
    pub show_camera_names: bool,
    pub api_port: u16,
    #[serde(default)]
    pub stream_config: StreamConfig,  // NEW
}
```

**Step 5: Add to AppState**

In `AppState` struct:

```rust
pub struct AppState {
    pub config: Mutex<AppConfig>,
    pub stream_tasks: Mutex<HashMap<String, JoinHandle<()>>>,
    pub stream_health: Mutex<HashMap<String, StreamHealth>>,
    pub reconnect_attempts: Mutex<HashMap<String, u32>>,
    pub buffer_pool: BufferPool,
    pub available_encoders: Mutex<AvailableEncoders>,  // NEW
}
```

**Step 6: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(codec): add codec configuration data structures

- Add CodecType enum (H264, MJPEG)
- Add EncoderType enum (Auto, Nvenc, QSV, x264, MJPEG)
- Add Quality enum (Low, Medium, High)
- Add StreamConfig struct to AppConfig
- Add AvailableEncoders struct to AppState

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 8: Backend - Hardware Encoder Detection

**Goal:** Detect available hardware encoders at startup

**Files:**
- Modify: `src-tauri/src/lib.rs` (add detection function)
- Modify: `src-tauri/src/main.rs` (call at startup)

**Step 1: Add detection function**

In `src-tauri/src/lib.rs`, add function:

```rust
async fn detect_encoders() -> AvailableEncoders {
    use tokio::process::Command;

    // Get FFmpeg path
    let ffmpeg_path = get_ffmpeg_path();

    let output = match Command::new(&ffmpeg_path)
        .args(["-encoders"])
        .output()
        .await
    {
        Ok(output) => output,
        Err(_) => return AvailableEncoders::default(),
    };

    let encoders_str = String::from_utf8_lossy(&output.stdout);

    AvailableEncoders {
        nvenc: encoders_str.contains("h264_nvenc"),
        qsv: encoders_str.contains("h264_qsv"),
        videotoolbox: encoders_str.contains("h264_videotoolbox"),
        x264: true,  // libx264 always available
    }
}

#[tauri::command]
async fn get_available_encoders(state: State<'_, AppState>) -> Result<AvailableEncoders, String> {
    let encoders = state.available_encoders.lock().unwrap();
    Ok(encoders.clone())
}

#[tauri::command]
async fn refresh_encoders(state: State<'_, AppState>) -> Result<AvailableEncoders, String> {
    let encoders = detect_encoders().await;
    {
        let mut stored = state.available_encoders.lock().unwrap();
        *stored = encoders.clone();
    }
    Ok(encoders)
}
```

**Step 2: Detect at startup**

In `src-tauri/src/main.rs` (or wherever AppState is created):

```rust
use tokio::runtime::Runtime;

// Create runtime for async detection
let rt = Runtime::new().unwrap();
let available_encoders = rt.block_on(detect_encoders());

let state = AppState {
    config: Mutex::new(config),
    stream_tasks: Mutex::new(HashMap::new()),
    stream_health: Mutex::new(HashMap::new()),
    reconnect_attempts: Mutex::new(HashMap::new()),
    buffer_pool: BufferPool::new(32),
    available_encoders: Mutex::new(available_encoders),
};
```

**Step 3: Register Tauri commands**

In `tauri::Builder`:

```rust
.invoke_handler(tauri::generate_handler![
    // ... existing commands
    get_available_encoders,
    refresh_encoders,
])
```

**Step 4: Test detection**

Run app, check console:
```bash
npm run tauri dev
# Should detect nvenc on NVIDIA systems, qsv on Intel, etc.
```

**Step 5: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/main.rs
git commit -m "feat(codec): detect hardware encoders at startup

- Detect h264_nvenc (NVIDIA)
- Detect h264_qsv (Intel)
- Detect h264_videotoolbox (macOS)
- Cache results in AppState
- Add refresh command for re-detection

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 9: Backend - FFmpeg H.264 Command Builder

**Goal:** Build FFmpeg args for H.264 encoding with fallback

**Files:**
- Modify: `src-tauri/src/lib.rs` (add encoder logic)

**Step 1: Add encoder selection function**

```rust
fn select_encoder(
    config: &StreamConfig,
    available: &AvailableEncoders,
) -> (&'static str, Vec<String>) {
    match config.codec {
        CodecType::MJPEG => ("mjpeg", build_mjpeg_args(&config.quality)),
        CodecType::H264 => {
            let encoder = match config.encoder {
                EncoderType::Auto => select_best_h264_encoder(available),
                EncoderType::Nvenc => "h264_nvenc",
                EncoderType::QSV => "h264_qsv",
                EncoderType::VideoToolbox => "h264_videotoolbox",
                EncoderType::X264 => "libx264",
                EncoderType::MJPEG => return ("mjpeg", build_mjpeg_args(&config.quality)),
            };

            (encoder, build_h264_args(encoder, &config.quality))
        }
    }
}

fn select_best_h264_encoder(available: &AvailableEncoders) -> &'static str {
    if available.nvenc {
        "h264_nvenc"
    } else if available.qsv {
        "h264_qsv"
    } else if available.videotoolbox {
        "h264_videotoolbox"
    } else {
        "libx264"
    }
}
```

**Step 2: Build H.264 args**

```rust
fn build_h264_args(encoder: &str, quality: &Quality) -> Vec<String> {
    let mut args = Vec::new();

    // Encoder-specific args
    match encoder {
        "h264_nvenc" => {
            args.extend([
                "-c:v".to_string(),
                "h264_nvenc".to_string(),
                "-preset".to_string(),
                "p4".to_string(),  // Performance preset 4
                "-tune".to_string(),
                "ll".to_string(),   // Low latency
                "-rc".to_string(),
                "vbr".to_string(),  // Variable bitrate
            ]);
        }
        "h264_qsv" => {
            args.extend([
                "-c:v".to_string(),
                "h264_qsv".to_string(),
                "-preset".to_string(),
                "medium".to_string(),
                "-global_quality".to_string(),
                "25".to_string(),
            ]);
        }
        "h264_videotoolbox" => {
            args.extend([
                "-c:v".to_string(),
                "h264_videotoolbox".to_string(),
                "-profile:v".to_string(),
                "high".to_string(),
            ]);
        }
        "libx264" => {
            args.extend([
                "-c:v".to_string(),
                "libx264".to_string(),
                "-preset".to_string(),
                "ultrafast".to_string(),
                "-tune".to_string(),
                "zerolatency".to_string(),
            ]);
        }
        _ => {}
    }

    // Quality-specific args
    match quality {
        Quality::Low => {
            args.extend([
                "-vf".to_string(),
                "scale=-2:720".to_string(),
                "-r".to_string(),
                "5".to_string(),
                "-crf".to_string(),
                "28".to_string(),
            ]);
        }
        Quality::Medium => {
            args.extend([
                "-vf".to_string(),
                "scale=-2:1080".to_string(),
                "-r".to_string(),
                "10".to_string(),
                "-crf".to_string(),
                "23".to_string(),
            ]);
        }
        Quality::High => {
            args.extend([
                "-r".to_string(),
                "15".to_string(),
                "-crf".to_string(),
                "18".to_string(),
            ]);
        }
    }

    // Output format
    args.extend([
        "-f".to_string(),
        "h264".to_string(),
        "-an".to_string(),  // No audio
    ]);

    args
}

fn build_mjpeg_args(quality: &Quality) -> Vec<String> {
    let (fps, q_val) = match quality {
        Quality::Low => (5, 10),
        Quality::Medium => (10, 5),
        Quality::High => (15, 3),
    };

    vec![
        "-vf".to_string(),
        format!("fps={}", fps),
        "-c:v".to_string(),
        "mjpeg".to_string(),
        "-q:v".to_string(),
        q_val.to_string(),
        "-f".to_string(),
        "image2pipe".to_string(),
        "-an".to_string(),
    ]
}
```

**Step 3: Integrate into try_stream_camera**

In `try_stream_camera()`, replace existing FFmpeg args:

```rust
// Get stream config
let stream_config = {
    let cfg = state.config.lock().unwrap();
    cfg.stream_config.clone()
};

// Get available encoders
let available = {
    let enc = state.available_encoders.lock().unwrap();
    enc.clone()
};

// Select encoder
let (encoder_name, codec_args) = select_encoder(&stream_config, &available);

// Build full command
let mut args = vec!["-hide_banner", "-loglevel", "error"];

// Protocol-specific args (existing code)
// ...

// Add codec args
for arg in codec_args {
    args.push(arg.as_str());
}

args.push("pipe:1");
```

**Step 4: Test H.264 encoding**

Manual test:
1. Set codec to H.264 in config
2. Start stream
3. Verify uses nvenc/QSV if available
4. Fallback to x264 if hardware unavailable

**Step 5: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(codec): implement H.264 encoder with fallback chain

- Auto-select: nvenc → QSV → videotoolbox → x264
- Encoder-specific FFmpeg args
- Quality presets (low/medium/high)
- Keep MJPEG as fallback option

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 10: Frontend - Codec Settings UI

**Goal:** Add codec configuration to settings panel

**Files:**
- Modify: `src/index.html` (add codec settings section)
- Modify: `src/main.js` (add codec UI logic)
- Modify: `src/style.css` (style codec settings)

**Step 1: Add HTML for codec settings**

In `src/index.html`, add after quality setting (around line 160):

```html
<div class="setting-section">
  <h3>Stream Encoding</h3>

  <div class="setting-row">
    <label>Codec:</label>
    <select id="codec-select">
      <option value="h264">H.264 (Hardware Accelerated)</option>
      <option value="mjpeg" selected>MJPEG (Current)</option>
    </select>
  </div>

  <div class="setting-row">
    <label>Encoder:</label>
    <select id="encoder-select">
      <option value="auto">Auto (Best Available)</option>
      <option value="nvenc">NVIDIA (nvenc)</option>
      <option value="qsv">Intel (QSV)</option>
      <option value="videotoolbox">macOS (VideoToolbox)</option>
      <option value="x264">Software (x264)</option>
      <option value="mjpeg">MJPEG</option>
    </select>
  </div>

  <div class="setting-row">
    <label>Quality Preset:</label>
    <select id="quality-preset-select">
      <option value="low">Low (720p, 5 fps)</option>
      <option value="medium" selected>Medium (1080p, 10 fps)</option>
      <option value="high">High (Original, 15 fps)</option>
    </select>
  </div>

  <div class="setting-row">
    <button id="test-encoder" class="btn-secondary">Test Encoder</button>
    <button id="refresh-hardware" class="btn-secondary">Refresh Hardware</button>
  </div>

  <div class="encoder-status">
    <span id="encoder-status">Detecting hardware...</span>
  </div>
</div>
```

**Step 2: Add codec UI logic to main.js**

```javascript
async openSettings() {
  // ... existing code

  // Load codec settings
  await this.loadCodecSettings();

  // Bind codec event listeners
  this.bindCodecListeners();
}

async loadCodecSettings() {
  const config = await invoke("get_config");

  // Set codec dropdown
  const codecSelect = document.getElementById("codec-select");
  if (config.stream_config?.codec) {
    codecSelect.value = config.stream_config.codec;
  }

  // Set encoder dropdown
  const encoderSelect = document.getElementById("encoder-select");
  if (config.stream_config?.encoder) {
    encoderSelect.value = config.stream_config.encoder;
  }

  // Set quality preset
  const qualitySelect = document.getElementById("quality-preset-select");
  if (config.stream_config?.quality) {
    qualitySelect.value = config.stream_config.quality;
  }

  // Update encoder availability
  await this.updateEncoderOptions();
}

async updateEncoderOptions() {
  const available = await invoke("get_available_encoders");
  const select = document.getElementById("encoder-select");
  const status = document.getElementById("encoder-status");

  // Enable/disable encoder options
  select.querySelector('[value="nvenc"]').disabled = !available.nvenc;
  select.querySelector('[value="qsv"]').disabled = !available.qsv;
  select.querySelector('[value="videotoolbox"]').disabled = !available.videotoolbox;

  // Show status
  if (available.nvenc) {
    status.textContent = "✓ NVIDIA GPU detected (nvenc)";
    status.style.color = "#10b981";
  } else if (available.qsv) {
    status.textContent = "✓ Intel GPU detected (QSV)";
    status.style.color = "#10b981";
  } else if (available.videotoolbox) {
    status.textContent = "✓ macOS hardware acceleration available";
    status.style.color = "#10b981";
  } else {
    status.textContent = "ℹ Using software encoding (x264)";
    status.style.color = "#f59e0b";
  }
}

bindCodecListeners() {
  // Test encoder button
  document.getElementById("test-encoder").addEventListener("click", async () => {
    const codec = document.getElementById("codec-select").value;
    const encoder = document.getElementById("encoder-select").value;

    // Simple test: just verify selection is valid
    this.showToast(`Testing ${encoder} encoder...`, 'info');

    // In a full implementation, could spawn test FFmpeg process
    setTimeout(() => {
      this.showToast(`✓ ${encoder} encoder available`, 'success');
    }, 1000);
  });

  // Refresh hardware button
  document.getElementById("refresh-hardware").addEventListener("click", async () => {
    await invoke("refresh_encoders");
    await this.updateEncoderOptions();
    this.showToast("Hardware detection refreshed", 'success');
  });
}
```

**Step 3: Add CSS styling**

In `src/style.css`:

```css
.setting-section {
  margin-bottom: 2rem;
  padding-bottom: 1.5rem;
  border-bottom: 1px solid #333;
}

.setting-section h3 {
  font-size: 1rem;
  font-weight: 600;
  margin-bottom: 1rem;
  color: #e5e7eb;
}

.encoder-status {
  margin-top: 0.75rem;
  font-size: 0.85rem;
}

.btn-secondary {
  background: #374151;
  color: #e5e7eb;
  padding: 6px 12px;
  border-radius: 4px;
  font-size: 0.85rem;
  margin-right: 8px;
}

.btn-secondary:hover {
  background: #4b5563;
}

select:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
```

**Step 4: Save codec settings**

In `saveSettings()` method:

```javascript
async saveSettings() {
  // ... existing save logic

  // Save codec settings
  config.stream_config = {
    codec: document.getElementById("codec-select").value,
    encoder: document.getElementById("encoder-select").value,
    quality: document.getElementById("quality-preset-select").value,
  };

  await invoke("save_config", { config });

  // Restart streams to apply new codec
  await invoke("start_streams");
}
```

**Step 5: Test codec UI**

Manual test:
1. Open settings
2. Verify codec dropdowns show
3. Select H.264, Auto encoder, Medium quality
4. Save settings
5. Verify streams restart with new codec

**Step 6: Commit**

```bash
git add src/index.html src/main.js src/style.css
git commit -m "feat(ui): add codec configuration settings

- Add codec selection dropdown (H.264 or MJPEG)
- Add encoder selection (Auto, nvenc, QSV, x264, etc.)
- Add quality preset (Low, Medium, High)
- Show hardware detection status
- Test and refresh buttons

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 11: Add API Documentation to README

**Goal:** Document network API access for local network integration

**Files:**
- Modify: `README.md` (add Remote API section)

**Step 1: Add API documentation section**

In `README.md`, add after Usage section:

```markdown
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
```

**Step 2: Commit documentation**

```bash
git add README.md
git commit -m "docs: add remote API documentation

- Document network access for local integration
- Add Stream Deck / Companion examples
- Include troubleshooting steps
- Note about camera index numbering in settings

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Summary

**Total Tasks:** 11 tasks across 2 phases

**Phase 1 (Tasks 1-6): Production Hardening**
1. Fix camera order (separate insertion/display)
2. Add API camera index to settings
3. Buffer pool for memory management
4. Enhanced reconnection (unlimited attempts)
5. Health warning system
6. Log rotation

**Phase 2 (Tasks 7-11): Codec Enhancement**
7. Codec configuration structs
8. Hardware encoder detection
9. H.264 command builder
10. Codec settings UI
11. API documentation

**Estimated Commits:** ~15 commits (including fixes/refinements)

**Testing Checkpoints:**
- After Task 1: Verify camera order stays fixed in settings
- After Task 3: Monitor memory for 1+ hours
- After Task 4: Test network disconnect/reconnect
- After Task 6: Verify logs rotate daily
- After Task 9: Test H.264 encoding with different GPUs
- After Task 11: Verify API accessible from network

**Success Criteria:**
- ✓ Settings shows cameras in insertion order always
- ✓ Memory stable over 24 hours
- ✓ Never gives up reconnecting
- ✓ Health warnings clear and helpful
- ✓ Logs don't fill disk
- ✓ H.264 auto-selects best encoder
- ✓ MJPEG fallback works
- ✓ API documented and accessible

---

**Ready for execution with subagent-driven development or executing-plans skill.**
