# StageView Production Hardening & Codec Enhancement - Design Document

**Date:** 2026-02-13
**Goal:** Enhance StageView for 24/7 production use with hardware-accelerated encoding and improved reliability

---

## Problem Statement

Current StageView implementation has several limitations for 24/7 production deployment:

1. **Limited codec options** - Only MJPEG encoding, no hardware acceleration
2. **Camera order confusion** - Burn-in protection shuffles camera array, affecting settings display
3. **24/7 reliability gaps** - Potential memory leaks, limited reconnection attempts, no monitoring
4. **API documentation** - Already network-accessible but not documented

---

## Solution Overview

**Approach:** Two-phase implementation prioritizing stability first, then features

- **Phase 1: Production Hardening** - Fix camera order, improve memory management, enhance reconnection, add monitoring
- **Phase 2: Codec Enhancement** - Add H.264 hardware encoding with auto-fallback chain

**Principles:**
- Maintain vanilla JavaScript + Tauri 2 architecture
- Graceful degradation (fallback chains)
- No breaking changes to existing features
- Comprehensive testing for 24/7 stability

---

## Architecture

### High-Level Data Flow

```
Camera Array (Insertion Order) ──┬──> Settings Panel (always insertion order)
                                  └──> Display Index ──> Grid (can shuffle for burn-in)

Stream Process ──> Health Monitor ──> Metrics Store ──> Frontend Display
                                  └──> Alert System (when offline)

FFmpeg Codec ──> Hardware Detect ──> nvenc → QSV → x264 → MJPEG fallback
```

### Technology Stack

**Backend (Rust):**
- Tauri 2 framework
- Tokio async runtime
- FFmpeg for stream processing
- File-based config (JSON)

**Frontend (Vanilla JS):**
- No frameworks (keep current approach)
- DOM manipulation
- Tauri IPC events

---

## Phase 1: Production Hardening

### 1.1 Camera Order Fix

**Current Problem:**
```javascript
// shuffleCameras() modifies this.cameras array
[this.cameras[i], this.cameras[j]] = [this.cameras[j], this.cameras[i]];

// Settings renders from this.cameras
list.innerHTML = this.cameras.map((cam, i) => ...)
// Result: Settings shows shuffled order
```

**Solution:**
```javascript
// NEW: Separate concerns
this.cameras = [];           // Insertion order (never shuffled)
this.displayOrder = [];      // Indices for grid display (shuffled)

// Shuffle only affects displayOrder
shuffleCameras() {
  // Shuffle displayOrder array of indices
  for (let i = this.displayOrder.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * i);
    [this.displayOrder[i], this.displayOrder[j]] =
      [this.displayOrder[j], this.displayOrder[i]];
  }

  // Rearrange DOM using displayOrder to index into cameras
  for (const index of this.displayOrder) {
    const cam = this.cameras[index];
    const tile = tileMap[cam.id];
    if (tile) grid.appendChild(tile);
  }
}

// Settings always uses insertion order
renderCameraList() {
  list.innerHTML = this.cameras.map((cam, i) => ...)
}
```

**Benefits:**
- Settings panel always shows cameras in order they were added
- Grid can still shuffle for burn-in protection
- Drag-and-drop updates displayOrder only
- Clearer separation of concerns

### 1.2 Memory Management

**Buffer Pooling:**

**Current Issue:**
```rust
// New String allocation per frame
let base64 = base64::encode(&frame_data);
// Memory fragmentation over time
```

**Solution:**
```rust
// Reusable buffer pool
struct BufferPool {
    buffers: Vec<Vec<u8>>,
    max_buffers: usize,
}

impl BufferPool {
    fn acquire(&mut self) -> Vec<u8> {
        self.buffers.pop().unwrap_or_else(|| Vec::with_capacity(64 * 1024))
    }

    fn release(&mut self, mut buf: Vec<u8>) {
        if self.buffers.len() < self.max_buffers {
            buf.clear();
            self.buffers.push(buf);
        }
    }
}
```

**Connection Pooling:**

**Current Issue:**
```rust
// API server spawns task per request
tokio::spawn(async move {
    // Handle request, connection closed after
});
// Socket exhaustion under high load
```

**Solution:**
```rust
// Limit concurrent connections
struct ConnectionLimiter {
    semaphore: Arc<Semaphore>,
    active_count: Arc<AtomicUsize>,
}

// Acquire permit before handling request
let _permit = limiter.semaphore.acquire().await;
// Auto-release on drop
```

### 1.3 Enhanced Reconnection

**Current Behavior:**
- Max 10 attempts with exponential backoff (1s → 60s)
- Gives up after 10 attempts
- No DNS retry or network awareness

**New Behavior:**

**Unlimited Attempts with Smart Backoff:**
```rust
fn calculate_backoff(attempt: u32) -> Duration {
    match attempt {
        1..=5 => Duration::from_secs(2u64.pow(attempt - 1)),  // 1s, 2s, 4s, 8s, 16s
        6..=10 => Duration::from_secs(60),                     // 60s
        _ => Duration::from_secs(300),                         // 5 min for long outages
    }
}

// Never give up, but slow down after initial attempts
```

**DNS Retry:**
```rust
// Resolve hostname before spawning FFmpeg
async fn resolve_stream_url(url: &str) -> Result<SocketAddr> {
    // Try DNS resolution with timeout
    // Retry on failure before attempting FFmpeg spawn
    // Log DNS failures separately from stream failures
}
```

**Network Awareness:**
```rust
// Detect network interface status
// Pause reconnection when network is down
// Resume when connectivity restored
// Prevents log spam during network outages
```

### 1.4 Monitoring & Alerts

**Health Warning System:**

**Frontend - Visual Indicators:**
```javascript
// New health states
const HealthState = {
  ONLINE: 'online',        // Green - receiving frames
  RECONNECTING: 'warn',    // Yellow - 1+ min offline
  OFFLINE: 'error'         // Red - 5+ min offline
};

// Update health card styling based on state
updateHealthState(cameraId, state) {
  const card = document.querySelector(`[data-camera-id="${cameraId}"]`);
  card.dataset.healthState = state;

  // Show notification banner for offline cameras
  if (state === 'error') {
    this.showHealthAlert(`Camera "${name}" offline for 5+ minutes`);
  }
}
```

**Log Rotation:**

**Backend - Prevent Disk Fill:**
```rust
// New logging configuration
use tracing_appender::rolling;

fn setup_logging() {
    let file_appender = rolling::daily("logs", "stageview.log");
    let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);

    // Rotate daily, keep 5 files
    // Max size: 100 MB per file
    // Auto-cleanup old files
}
```

**Metrics Tracking:**

**New Metrics:**
```rust
#[derive(Serialize, Deserialize)]
struct CameraMetrics {
    pub uptime_percent: f64,        // % time online in last 24h
    pub reconnect_count: u32,       // Total reconnects today
    pub avg_fps: f64,               // Average FPS
    pub frame_drop_rate: f64,       // % frames dropped
    pub last_online: DateTime<Utc>, // Last successful frame
}

// Persist to config for historical tracking
// Display in settings panel
```

---

## Phase 2: Codec Enhancement

### 2.1 Hardware Detection

**Auto-Detection at Startup:**
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AvailableEncoders {
    pub nvenc: bool,         // NVIDIA GPU
    pub qsv: bool,           // Intel Quick Sync
    pub videotoolbox: bool,  // macOS hardware
    pub x264: bool,          // Software (always true)
}

async fn detect_encoders() -> AvailableEncoders {
    // Run FFmpeg to list encoders
    let output = Command::new("ffmpeg")
        .args(["-encoders"])
        .output()
        .await?;

    let encoders_str = String::from_utf8_lossy(&output.stdout);

    AvailableEncoders {
        nvenc: encoders_str.contains("h264_nvenc"),
        qsv: encoders_str.contains("h264_qsv"),
        videotoolbox: encoders_str.contains("h264_videotoolbox"),
        x264: true, // Always available as software fallback
    }
}
```

**Cache & Refresh:**
- Detect once at startup
- Cache results in AppState
- "Refresh Hardware" button re-runs detection
- Show detected encoders in settings UI

### 2.2 Codec Configuration

**New Config Structure:**
```rust
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct StreamConfig {
    pub codec: CodecType,
    pub encoder: EncoderType,
    pub quality_preset: Quality,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub enum CodecType {
    H264,    // Better compression, lower bandwidth
    MJPEG,   // Current system, high compatibility
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub enum EncoderType {
    Auto,         // Try hardware, fallback to software
    Nvenc,        // Force NVIDIA (fail if unavailable)
    QSV,          // Force Intel
    VideoToolbox, // Force macOS
    X264,         // Force software H.264
    MJPEG,        // Force MJPEG (current behavior)
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub enum Quality {
    Low,     // 720p max, CRF 28, 5 fps
    Medium,  // 1080p max, CRF 23, 10 fps
    High,    // Original, CRF 18, 15 fps
}
```

**Default Config:**
```rust
impl Default for StreamConfig {
    fn default() -> Self {
        Self {
            codec: CodecType::MJPEG,      // Backward compatible
            encoder: EncoderType::MJPEG,  // Current behavior
            quality_preset: Quality::Medium,
        }
    }
}
```

### 2.3 FFmpeg Command Construction

**Encoder Fallback Chain (Auto Mode):**

**Priority:**
1. **h264_nvenc** (NVIDIA GPU - fastest)
2. **h264_qsv** (Intel iGPU - good performance)
3. **h264_videotoolbox** (macOS hardware)
4. **libx264** (Software - slower but works everywhere)
5. **mjpeg** (Final fallback - current system)

**Implementation:**
```rust
async fn build_encoder_args(
    config: &StreamConfig,
    available: &AvailableEncoders,
) -> Vec<String> {
    let mut args = vec!["-hide_banner", "-loglevel", "error"];

    match config.codec {
        CodecType::H264 => {
            let encoder = match config.encoder {
                EncoderType::Auto => select_best_h264_encoder(available),
                EncoderType::Nvenc => "h264_nvenc",
                EncoderType::QSV => "h264_qsv",
                EncoderType::VideoToolbox => "h264_videotoolbox",
                EncoderType::X264 => "libx264",
                EncoderType::MJPEG => return build_mjpeg_args(config),
            };

            args.extend(build_h264_args(encoder, config.quality_preset));
        }
        CodecType::MJPEG => {
            args.extend(build_mjpeg_args(config));
        }
    }

    args
}

fn select_best_h264_encoder(available: &AvailableEncoders) -> &str {
    if available.nvenc { "h264_nvenc" }
    else if available.qsv { "h264_qsv" }
    else if available.videotoolbox { "h264_videotoolbox" }
    else { "libx264" }
}
```

**Encoder-Specific Arguments:**

**NVIDIA nvenc:**
```rust
// -c:v h264_nvenc -preset p4 -tune ll -rc vbr
// p4 = Performance preset 4 (balanced)
// ll = Low latency tuning
// vbr = Variable bitrate
```

**Intel QSV:**
```rust
// -c:v h264_qsv -preset medium -global_quality 25
// global_quality 25 = Good balance (lower = better)
```

**Software x264:**
```rust
// -c:v libx264 -preset ultrafast -tune zerolatency -crf 23
// ultrafast = Fastest encoding (for CPU)
// zerolatency = No buffering
// crf 23 = Constant quality (lower = better, 18-28 range)
```

**MJPEG (current):**
```rust
// -c:v mjpeg -q:v 5 -f image2pipe
// q:v 5 = JPEG quality (2-31, lower = better)
// image2pipe = Output JPEG frames to stdout
```

**Quality Preset Mappings:**

**Low Quality:**
```rust
args.extend([
    "-vf", "scale=-2:720",  // Max 720p height
    "-r", "5",              // 5 fps
    "-crf", "28",           // Lower quality (H.264)
    "-q:v", "10",           // Lower quality (MJPEG)
]);
```

**Medium Quality (Default):**
```rust
args.extend([
    "-vf", "scale=-2:1080", // Max 1080p height
    "-r", "10",             // 10 fps
    "-crf", "23",           // Balanced quality (H.264)
    "-q:v", "5",            // Balanced quality (MJPEG)
]);
```

**High Quality:**
```rust
args.extend([
    // No scaling filter
    "-r", "15",     // 15 fps
    "-crf", "18",   // High quality (H.264)
    "-q:v", "3",    // High quality (MJPEG)
]);
```

### 2.4 Output Format & Frontend Decoding

**H.264 Output:**
```rust
// Output H.264 Annex B stream to pipe
args.extend([
    "-f", "h264",       // Raw H.264 format
    "-bsf:v", "h264_mp4toannexb",  // Convert to Annex B
    "pipe:1"            // Output to stdout
]);
```

**Frontend Decoding Options:**

**Option A: Media Source Extensions (MSE)** (Recommended)
```javascript
// Use browser's native H.264 decoder
const mediaSource = new MediaSource();
video.src = URL.createObjectURL(mediaSource);

mediaSource.addEventListener('sourceopen', () => {
  const sourceBuffer = mediaSource.addSourceBuffer('video/mp4; codecs="avc1.42E01E"');

  // Append H.264 chunks from Tauri events
  window.__TAURI__.event.listen('camera-frame', (event) => {
    const h264Data = base64ToUint8Array(event.payload.data);
    sourceBuffer.appendBuffer(h264Data);
  });
});
```

**Option B: FFmpeg WASM** (Fallback)
```javascript
// Decode H.264 in browser using FFmpeg compiled to WebAssembly
// Slower but works if MSE unavailable
```

**MJPEG (Current System):**
```javascript
// No changes - continue using JPEG frame pipeline
img.src = `data:image/jpeg;base64,${event.payload.data}`;
```

### 2.5 Settings UI

**New Settings Panel Section:**

```html
<div class="codec-settings">
  <h3>Stream Encoding</h3>

  <div class="setting-row">
    <label>Codec:</label>
    <select id="codec-select">
      <option value="h264">H.264 (Recommended)</option>
      <option value="mjpeg" selected>MJPEG (Current)</option>
    </select>
  </div>

  <div class="setting-row">
    <label>Encoder:</label>
    <select id="encoder-select">
      <option value="auto">Auto (Hardware if available)</option>
      <option value="nvenc">NVIDIA (nvenc)</option>
      <option value="qsv">Intel (QSV)</option>
      <option value="x264">Software (x264)</option>
      <option value="mjpeg">MJPEG</option>
    </select>
  </div>

  <div class="setting-row">
    <label>Quality:</label>
    <select id="quality-select">
      <option value="low">Low (720p, 5 fps)</option>
      <option value="medium" selected>Medium (1080p, 10 fps)</option>
      <option value="high">High (Original, 15 fps)</option>
    </select>
  </div>

  <div class="setting-row">
    <button id="test-encoder">Test Encoder</button>
    <button id="refresh-hardware">Refresh Hardware</button>
  </div>

  <div class="encoder-status">
    Status: <span id="encoder-status">✓ Using h264_nvenc</span>
  </div>
</div>
```

**Dynamic UI Updates:**
```javascript
// Populate encoder dropdown based on detected hardware
async function updateEncoderOptions() {
  const available = await invoke('get_available_encoders');
  const select = document.getElementById('encoder-select');

  // Enable/disable options based on availability
  select.querySelector('[value="nvenc"]').disabled = !available.nvenc;
  select.querySelector('[value="qsv"]').disabled = !available.qsv;

  // Show detected hardware
  const status = document.getElementById('encoder-status');
  if (available.nvenc) {
    status.textContent = '✓ NVIDIA GPU detected';
  } else if (available.qsv) {
    status.textContent = '✓ Intel GPU detected';
  } else {
    status.textContent = 'ℹ Using software encoding';
  }
}
```

**Test Encoder Button:**
```javascript
// Verify encoder works before saving
async function testEncoder() {
  const codec = document.getElementById('codec-select').value;
  const encoder = document.getElementById('encoder-select').value;

  const result = await invoke('test_encoder', { codec, encoder });

  if (result.success) {
    alert(`✓ Encoder test successful\nUsing: ${result.encoder}`);
  } else {
    alert(`✗ Encoder test failed\n${result.error}\nTry a different encoder.`);
  }
}
```

### 2.6 Backward Compatibility

**Migration Strategy:**

**Existing Configs:**
```rust
// Old config (no stream_config field)
{
  "cameras": [...],
  "quality": "medium"
}

// Auto-migrate to new format on load
impl AppConfig {
    fn migrate_legacy(&mut self) {
        if self.stream_config.is_none() {
            self.stream_config = Some(StreamConfig {
                codec: CodecType::MJPEG,      // Keep current behavior
                encoder: EncoderType::MJPEG,
                quality_preset: self.quality.clone(),
            });
        }
    }
}
```

**No Breaking Changes:**
- Existing installations default to MJPEG (current behavior)
- Users opt-in to H.264 via settings
- Old quality setting maps to new quality_preset
- All existing features continue to work

**Fallback on Failure:**
```rust
// If H.264 encoder fails to start
async fn handle_encoder_failure(camera_id: &str, error: EncoderError) {
    eprintln!("H.264 encoder failed for {}: {}", camera_id, error);

    // Auto-fallback to MJPEG
    let fallback_config = StreamConfig {
        codec: CodecType::MJPEG,
        encoder: EncoderType::MJPEG,
        ..config
    };

    // Show notification
    app_handle.emit_all("encoder-fallback", json!({
        "camera_id": camera_id,
        "message": "Hardware encoding unavailable, using MJPEG"
    }));

    // Retry with MJPEG
    try_stream_camera(camera_id, fallback_config).await
}
```

---

## Error Handling Strategy

### Graceful Degradation Chain

**General Pattern:**
```
User Action → Try Operation → Fails? → Fallback → Still Fails? → Safe Default
```

**Examples:**

**Codec Selection:**
```
H.264 nvenc → Fails (no GPU) → Try QSV → Fails → Try x264 → Fails → MJPEG
```

**Network Connectivity:**
```
Stream fails → Try reconnect → Network down? → Pause → Wait for network → Resume
```

**Memory Pressure:**
```
Buffer pool full → Reduce pool size → Still high? → Lower quality preset → Still high? → Alert user
```

**API Overload:**
```
Request arrives → Check connection limit → At limit? → Queue request → Queue full? → Reject with 503
```

### User Notifications

**Non-Intrusive Approach:**

**Toast Notifications (No alert() spam):**
```javascript
class NotificationManager {
  showInfo(message) {
    // Blue toast, auto-dismiss after 5s
    // Example: "Using software H.264 encoding (GPU unavailable)"
  }

  showWarning(message) {
    // Yellow toast, auto-dismiss after 10s
    // Example: "Camera X reconnecting (5 attempts)"
  }

  showError(message) {
    // Red toast, stays until dismissed
    // Example: "Camera X offline for 10 minutes"
  }

  showSuccess(message) {
    // Green toast, auto-dismiss after 3s
    // Example: "All cameras online"
  }
}
```

**Persistent Status Indicators:**

**Settings Panel Health Dots:**
```javascript
// Visual health state per camera
.health-indicator {
  width: 12px;
  height: 12px;
  border-radius: 50%;
}

.health-online { background: #10b981; }    /* Green */
.health-warn { background: #f59e0b; }      /* Yellow */
.health-error { background: #ef4444; }     /* Red */
```

**Codec Badge:**
```javascript
// Show active encoder for each camera
<span class="codec-badge">nvenc</span>
<span class="codec-badge">MJPEG</span>
<span class="codec-badge">x264</span>
```

### Logging Strategy

**Log Levels:**
```rust
use tracing::{error, warn, info, debug};

// ERROR: Unrecoverable failures
error!("Failed to start camera {}: {}", id, err);

// WARN: Recoverable issues
warn!("Camera {} reconnecting (attempt {})", id, attempt);

// INFO: Important state changes
info!("Camera {} encoder: {} → {}", id, old, new);

// DEBUG: Detailed diagnostics
debug!("Frame {} size: {} bytes", frame_num, size);
```

**Log Rotation:**
```rust
// Daily rotation, keep 5 files, max 100 MB each
use tracing_appender::rolling;

let file_appender = rolling::daily("logs", "stageview.log");
// Produces: stageview.log, stageview.log.2026-02-12, etc.
```

---

## Testing Strategy

### Phase 1 Testing (Production Hardening)

**Camera Order Tests:**
```
✓ Settings shows insertion order after burn-in shuffle
✓ Grid visually shuffles correctly
✓ Drag-and-drop updates display order only
✓ Save/load preserves insertion order
✓ Adding new camera appends to end (insertion order)
✓ Removing camera maintains order of remaining cameras
```

**Memory Management Tests:**
```
✓ No memory growth after 24 hours continuous operation
✓ Buffer pools reuse buffers correctly
✓ Connection pool enforces max connections
✓ Proper cleanup when camera removed
✓ No leaked FFmpeg processes
✓ No leaked Tokio tasks
```

**Reconnection Tests:**
```
✓ Recovers from network disconnect
✓ Handles DNS resolution failures
✓ Exponential backoff timing correct
✓ Unlimited retry attempts work
✓ Success resets attempt counter
✓ Network up/down detection works
```

**Monitoring Tests:**
```
✓ Health warnings show at correct times (1 min, 5 min)
✓ Toast notifications appear correctly
✓ Logs rotate at 100 MB
✓ Old logs auto-delete (keep only 5)
✓ Metrics track accurately
✓ No disk space exhaustion
```

### Phase 2 Testing (Codec Enhancement)

**Hardware Detection Tests:**
```
✓ Detects NVIDIA GPU (nvenc)
✓ Detects Intel iGPU (QSV)
✓ Detects macOS hardware (videotoolbox)
✓ Falls back to software correctly
✓ Refresh button re-detects hardware
✓ Shows correct status in UI
```

**Encoding Tests:**
```
✓ H.264 nvenc encodes successfully (NVIDIA)
✓ H.264 QSV encodes successfully (Intel)
✓ H.264 x264 works (software fallback)
✓ MJPEG still works (current behavior)
✓ Quality presets apply correctly (low/med/high)
✓ Output format correct (H.264 Annex B or JPEG)
```

**Frontend Decoding Tests:**
```
✓ MSE decodes H.264 stream
✓ MJPEG displays as before
✓ Fallback to FFmpeg WASM if MSE unavailable
✓ No visual artifacts or stuttering
✓ Latency acceptable (<500ms)
```

**Settings UI Tests:**
```
✓ Encoder dropdown shows detected options
✓ Grayed out options when hardware unavailable
✓ Test button validates encoder
✓ Status badge shows active encoder
✓ Config persists across restarts
✓ Migration from old config works
```

**Fallback Chain Tests:**
```
✓ nvenc fails → tries QSV → tries x264 → MJPEG
✓ Notification shown on fallback
✓ User can force specific encoder
✓ Forced encoder fails → shows error, no auto-fallback
```

### Long-Running Stability Tests

**24-Hour Burn-In:**
```
✓ Run for 24 hours with 4 cameras
✓ Monitor memory usage (should be stable)
✓ Monitor CPU usage (should be reasonable)
✓ Check for FFmpeg zombie processes
✓ Verify log rotation occurs
✓ Ensure no crashes or freezes
```

**Network Stress:**
```
✓ Disconnect network for 1 hour → reconnect
✓ Rapid network on/off cycles
✓ DNS server failure simulation
✓ Bandwidth throttling
✓ Packet loss simulation
```

**Hardware Stress:**
```
✓ Switch encoders while streaming
✓ Remove GPU while using nvenc (fallback test)
✓ High CPU load (other processes)
✓ Low memory condition
```

### Rollback Plan

**If Issues Arise:**

**Phase 1 Rollback:**
```bash
# Revert to v1.1.0 (UX Polish release)
git checkout v1.1.0
npm run tauri build
```

**Phase 2 Rollback:**
```json
// Disable H.264 in config
{
  "stream_config": {
    "codec": "MJPEG",
    "encoder": "MJPEG"
  }
}
```

**Per-Camera Rollback:**
```javascript
// Force MJPEG for specific cameras
config.cameras[0].force_mjpeg = true;
```

---

## API Network Accessibility

### Current Status

**Already Network-Accessible:**
- API server binds to `0.0.0.0:8090` (all interfaces)
- CORS enabled: `Access-Control-Allow-Origin: *`
- No authentication (suitable for local network only)
- Works with Stream Deck, Companion, custom scripts

### Documentation to Add

**README.md - New "Remote API" Section:**

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
Lists all cameras with their indices.

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

# Get camera list
curl http://192.168.1.100:8090/api/status
```

**Node.js:**
```javascript
const axios = require('axios');

async function switchCamera(index) {
  const response = await axios.get(`http://192.168.1.100:8090/api/solo/${index}`);
  console.log(response.data);
}

switchCamera(2);
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

**Windows Firewall Steps:**
1. Open Windows Defender Firewall
2. Click "Allow an app or feature through Windows Defender Firewall"
3. Click "Change settings" → "Allow another app"
4. Browse to StageView.exe
5. Check "Private" (local network)
6. Click "Add"

### Security Notes

**Local Network Only:**
- API has no authentication
- Only use on trusted local networks
- Do NOT expose to internet (no port forwarding)

**Router Settings:**
- Do NOT add port forwarding rule for 8090
- Keep API accessible only on LAN
```

---

## Implementation Timeline

### Phase 1: Production Hardening (Week 1)

**Day 1-2: Camera Order Fix**
- Implement displayOrder array
- Update shuffle logic
- Update render logic
- Test in all modes (grid, solo, PIP)

**Day 3-4: Memory Management**
- Implement buffer pooling
- Add connection limiting
- Add periodic cleanup
- Memory leak testing

**Day 5-6: Enhanced Reconnection**
- Unlimited retry with smart backoff
- DNS retry logic
- Network awareness
- Long-running stability test

**Day 7: Monitoring & Alerts**
- Health warning system
- Log rotation setup
- Metrics tracking
- Toast notification UI

### Phase 2: Codec Enhancement (Week 2)

**Day 1-2: Hardware Detection**
- Encoder detection at startup
- Cache results in AppState
- Settings UI for encoder selection
- Test/refresh buttons

**Day 3-4: FFmpeg Integration**
- Build encoder argument chains
- Implement fallback logic
- Quality preset mappings
- Test each encoder type

**Day 5-6: Frontend Decoding**
- MSE integration for H.264
- Keep MJPEG pipeline
- Fallback handling
- Latency optimization

**Day 7: Polish & Testing**
- Settings UI refinement
- Error messages
- Backward compatibility testing
- Documentation completion

---

## Success Criteria

### Phase 1 Success Metrics

**Camera Order:**
✓ Settings always shows insertion order
✓ Grid shuffles independently
✓ Zero user confusion

**Memory Management:**
✓ No memory growth over 24 hours
✓ Stable resource usage
✓ No process leaks

**Reconnection:**
✓ Recovers from any network failure
✓ Never gives up retrying
✓ Minimal log spam during outages

**Monitoring:**
✓ Clear visual health indicators
✓ Useful toast notifications
✓ Logs don't fill disk

### Phase 2 Success Metrics

**Hardware Encoding:**
✓ Auto-detects NVIDIA/Intel GPUs
✓ Successfully encodes with nvenc/QSV
✓ Fallback chain works reliably

**Quality:**
✓ H.264 quality matches or exceeds MJPEG
✓ Bandwidth reduced by 50%+ with H.264
✓ Latency remains <500ms

**User Experience:**
✓ Easy to configure in settings
✓ Clear status indicators
✓ No crashes or freezes

**Compatibility:**
✓ Existing configs migrate seamlessly
✓ MJPEG still works as fallback
✓ No breaking changes

---

## Future Considerations

**Out of Scope for This Release:**

- Authentication/authorization for API
- mDNS/Bonjour service announcement
- WebRTC streaming
- Cloud recording
- Mobile app
- Multi-user support

**Potential Future Enhancements:**

- H.265/HEVC support (better compression)
- AV1 codec (future-proof)
- Adaptive bitrate based on network
- GPU-accelerated decoding in frontend
- WebRTC for ultra-low latency
- Remote access via relay server

---

## Appendix

### Technology References

**FFmpeg Hardware Encoding:**
- NVENC: https://trac.ffmpeg.org/wiki/HWAccelIntro#NVENC
- QSV: https://trac.ffmpeg.org/wiki/Hardware/QuickSync
- VideoToolbox: https://trac.ffmpeg.org/wiki/HWAccelIntro#VideoToolbox

**Rust Libraries:**
- Tokio: https://tokio.rs/
- Tracing: https://tracing.rs/
- Serde: https://serde.rs/

**Browser APIs:**
- Media Source Extensions: https://developer.mozilla.org/en-US/docs/Web/API/Media_Source_Extensions_API

### File Locations

**Configuration:**
- Windows: `%APPDATA%\StageView\config.json`
- Linux: `~/.config/StageView/config.json`
- macOS: `~/Library/Application Support/StageView/config.json`

**Logs:**
- `logs/stageview.log` (current)
- `logs/stageview.log.YYYY-MM-DD` (rotated)

**FFmpeg Binary:**
- Bundled with Tauri app
- `src-tauri/binaries/ffmpeg-{platform}.exe`
