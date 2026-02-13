# Bug Fixes & Per-Camera Features - Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix critical bugs in hardware detection and codec selection, add per-camera quality/FPS configuration

**Architecture:** Three-phase approach - Phase 1 fixes detection bugs and adds error handling, Phase 2 adds per-camera codec override architecture with native FPS support, Phase 3 adds new API endpoints for remote control

**Tech Stack:** Tauri 2, Rust (Tokio async), Vanilla JavaScript, FFmpeg

---

## Phase 1: Critical Bug Fixes

### Task 1: Fix Hardware Detection with FFmpeg Testing

**Goal:** Test encoders with actual FFmpeg commands instead of naive string matching

**Files:**
- Modify: `src-tauri/src/lib.rs:970-993` (detect_encoders function)

**Step 1: Add encoder test function**

In `src-tauri/src/lib.rs`, add after `detect_encoders()`:

```rust
async fn test_encoder(ffmpeg_path: &str, encoder: &str) -> bool {
    use tokio::process::Command;

    // Quick test: encode 1 second of test video
    let output = Command::new(ffmpeg_path)
        .args([
            "-f", "lavfi",
            "-i", "testsrc=duration=1:size=320x240:rate=1",
            "-c:v", encoder,
            "-f", "null",
            "-"
        ])
        .output()
        .await;

    match output {
        Ok(result) => result.status.success(),
        Err(_) => false,
    }
}
```

**Step 2: Update detect_encoders to test each encoder**

Replace the `detect_encoders()` function body:

```rust
async fn detect_encoders() -> AvailableEncoders {
    let ffmpeg_path = get_ffmpeg_path();

    let output = match Command::new(&ffmpeg_path)
        .args(["-encoders"])
        .output()
        .await
    {
        Ok(output) if output.status.success() => output,
        Ok(output) => {
            error!("FFmpeg -encoders failed: {}",
                   String::from_utf8_lossy(&output.stderr));
            return AvailableEncoders::default();
        }
        Err(e) => {
            error!("Failed to execute FFmpeg: {}", e);
            return AvailableEncoders::default();
        }
    };

    let encoders_str = String::from_utf8_lossy(&output.stdout);

    // Check if encoders are listed
    let has_nvenc = encoders_str.contains("h264_nvenc");
    let has_qsv = encoders_str.contains("h264_qsv");
    let has_videotoolbox = encoders_str.contains("h264_videotoolbox");

    info!("FFmpeg lists encoders - nvenc: {}, qsv: {}, videotoolbox: {}",
          has_nvenc, has_qsv, has_videotoolbox);

    // Test encoders that are listed
    let nvenc_works = if has_nvenc {
        test_encoder(&ffmpeg_path, "h264_nvenc").await
    } else {
        false
    };

    let qsv_works = if has_qsv {
        test_encoder(&ffmpeg_path, "h264_qsv").await
    } else {
        false
    };

    let videotoolbox_works = if has_videotoolbox {
        test_encoder(&ffmpeg_path, "h264_videotoolbox").await
    } else {
        false
    };

    info!("Encoder tests complete - nvenc: {}, qsv: {}, videotoolbox: {}",
          nvenc_works, qsv_works, videotoolbox_works);

    AvailableEncoders {
        nvenc: nvenc_works,
        qsv: qsv_works,
        videotoolbox: videotoolbox_works,
        x264: true,
    }
}
```

**Step 3: Test manually**

Run: `npm run tauri dev`
Expected: Log shows "Encoder tests complete" with correct detection

**Step 4: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "fix(codec): test encoders with FFmpeg instead of string matching

- Add test_encoder function that runs actual FFmpeg command
- Only mark encoder as available if test succeeds
- Log both listing and testing results for debugging

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 2: Add Codec Error Handling with Fallback

**Goal:** Show error toasts when encoder fails, fallback to working encoder

**Files:**
- Modify: `src-tauri/src/lib.rs` (try_stream_camera function)
- Modify: `src/main.js` (add stream-error event listener)

**Step 1: Add stream-error event emission**

In `src-tauri/src/lib.rs`, find `try_stream_camera()` function, locate the FFmpeg spawn section (around line 805), and add error handling:

```rust
let mut ffmpeg_process = match Command::new(&ffmpeg_path)
    .args(&args)
    .stdout(Stdio::piped())
    .stderr(Stdio::null())
    .spawn()
{
    Ok(child) => child,
    Err(e) => {
        error!("Failed to spawn FFmpeg with encoder {}: {}", encoder_name, e);

        // Emit error event to frontend
        let _ = app_handle.emit_all("stream-error", json!({
            "camera_id": camera_id,
            "error": format!("Encoder {} failed", encoder_name),
            "encoder": encoder_name
        }));

        // Try fallback to x264
        if encoder_name != "libx264" && encoder_name != "mjpeg" {
            info!("Trying fallback to x264 for camera {}", camera_id);
            // Recursively call with x264 fallback would go here
            // For now, just return error
        }

        return;
    }
};
```

**Step 2: Add frontend stream-error listener**

In `src/main.js`, add in the `init()` method after other event listeners (around line 150):

```javascript
// Listen for stream errors
listen("stream-error", (event) => {
  const { camera_id, error, encoder } = event.payload;
  const camera = this.cameras.find(c => c.id === camera_id);
  const cameraName = camera ? camera.name : camera_id;

  this.showToast(
    `${cameraName}: ${error}. Try selecting a different encoder in settings.`,
    'error'
  );

  console.error(`Stream error for ${cameraName}:`, error, `(encoder: ${encoder})`);
});
```

**Step 3: Test manually**

1. Select an encoder that doesn't work on your system (e.g., nvenc if you have Intel)
2. Start a stream
3. Expected: Toast notification shows "Encoder nvenc failed"

**Step 4: Commit**

```bash
git add src-tauri/src/lib.rs src/main.js
git commit -m "feat(codec): add error handling for failed encoders

- Emit stream-error event when FFmpeg spawn fails
- Show toast notification with encoder failure details
- Log error for debugging
- Prepare for fallback chain implementation

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 3: Investigate and Fix PIP Button

**Goal:** Ensure PIP "Add Overlay" button works correctly

**Files:**
- Check: `src/main.js` (addPipOverlay method, event delegation)

**Step 1: Add defensive logging to addPipOverlay**

In `src/main.js`, update `addPipOverlay()` method (around line 1465):

```javascript
addPipOverlay() {
  console.log('[PIP] addPipOverlay called');

  const currentOverlays = this.getActivePipOverlays();
  console.log('[PIP] Current overlays:', currentOverlays);

  // Find an available corner
  const corners = ['TL', 'TR', 'BL', 'BR'];
  const usedCorners = currentOverlays.map(o => o.corner);
  const availableCorner = corners.find(c => !usedCorners.includes(c));

  if (!availableCorner) {
    console.log('[PIP] All corners occupied');
    alert('All corners are occupied. Remove an overlay before adding a new one.');
    return;
  }

  // Find an available camera
  const mainCameraId = document.getElementById('pip-main-camera')?.value;
  console.log('[PIP] Main camera:', mainCameraId);

  const availableCamera = this.cameras.find(c => c.id !== mainCameraId);
  console.log('[PIP] Available camera:', availableCamera);

  if (!availableCamera) {
    console.log('[PIP] No available cameras');
    alert('No available cameras for overlay.');
    return;
  }

  const newOverlay = {
    camera_id: availableCamera.id,
    corner: availableCorner,
    size_percent: 25
  };

  console.log('[PIP] Adding overlay:', newOverlay);
  currentOverlays.push(newOverlay);

  const layout = this.getCurrentPipLayout();
  console.log('[PIP] Rendering with layout:', layout);
  this.renderPipConfig(layout);
}
```

**Step 2: Verify event delegation setup**

Check that event listener in `bindUIEvents()` (around line 250) includes:

```javascript
if (e.target.id === 'add-pip-overlay') {
  console.log('[PIP] Add overlay button clicked');
  this.addPipOverlay();
}
```

**Step 3: Test manually**

1. Open layout editor
2. Switch to PIP mode
3. Open browser console (F12)
4. Click "Add Overlay" button
5. Check console for `[PIP]` logs
6. If no logs appear: button not triggering (DOM issue)
7. If logs appear but fail: identify which step fails

**Step 4: Commit if changes made**

```bash
git add src/main.js
git commit -m "fix(pip): add defensive logging to addPipOverlay

- Log each step of overlay addition process
- Help identify where PIP button fails
- Add null check for pip-main-camera element

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Phase 2: Per-Camera Features

### Task 4: Add Per-Camera Data Structures

**Goal:** Define CameraCodecSettings and FpsMode for per-camera configuration

**Files:**
- Modify: `src-tauri/src/lib.rs` (add new structs after Quality enum)

**Step 1: Add FpsMode enum**

In `src-tauri/src/lib.rs`, after the `Quality` enum (around line 43), add:

```rust
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FpsMode {
    Native,      // No -r flag - use camera's native FPS
    #[serde(rename = "capped")]
    Capped(u32), // Add -r N to cap FPS
}

impl Default for FpsMode {
    fn default() -> Self {
        FpsMode::Native
    }
}
```

**Step 2: Add CameraCodecSettings struct**

After FpsMode:

```rust
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct CameraCodecSettings {
    pub quality: Quality,
    pub fps_mode: FpsMode,
}

impl Default for CameraCodecSettings {
    fn default() -> Self {
        Self {
            quality: Quality::Medium,
            fps_mode: FpsMode::Native,
        }
    }
}
```

**Step 3: Add codec_override to Camera struct**

Find the `Camera` struct (around line 83) and add the field:

```rust
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Camera {
    pub id: String,
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub codec_override: Option<CameraCodecSettings>,  // NEW
}
```

**Step 4: Test compilation**

Run: `cargo check --manifest-path=src-tauri/Cargo.toml`
Expected: Compiles without errors

**Step 5: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(codec): add per-camera codec settings structures

- Add FpsMode enum (Native or Capped)
- Add CameraCodecSettings struct
- Add codec_override to Camera struct
- Use #[serde(default)] for backward compatibility

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 5: Update FFmpeg Command Builder for Per-Camera Settings

**Goal:** Use per-camera settings when building FFmpeg arguments

**Files:**
- Modify: `src-tauri/src/lib.rs` (build_h264_args function and try_stream_camera)

**Step 1: Extract FPS logic from build_h264_args**

Currently, `build_h264_args()` adds `-r` flag for quality presets. We need to separate this:

Find `build_h264_args()` (around line 490) and remove the FPS (`-r`) logic from quality presets. Keep only scaling:

```rust
// In build_h264_args, update quality match:
match quality {
    Quality::Low => {
        args.extend([
            "-vf".to_string(),
            "scale=-2:720".to_string(),
            // Remove -r flag from here
        ]);
    }
    Quality::Medium => {
        args.extend([
            "-vf".to_string(),
            "scale=-2:1080".to_string(),
            // Remove -r flag from here
        ]);
    }
    Quality::High => {
        // No scaling, no FPS cap by default
    }
}
```

**Step 2: Add FPS handling function**

Add new function after `build_h264_args()`:

```rust
fn build_fps_args(fps_mode: &FpsMode) -> Vec<String> {
    match fps_mode {
        FpsMode::Native => {
            // No -r flag - camera streams at native FPS
            Vec::new()
        }
        FpsMode::Capped(fps) => {
            vec!["-r".to_string(), fps.to_string()]
        }
    }
}
```

**Step 3: Update try_stream_camera to use per-camera settings**

In `try_stream_camera()`, around line 730, update the codec args logic:

```rust
// Get camera from config
let camera = {
    let cfg = state.config.lock().unwrap();
    cfg.cameras.iter().find(|c| c.id == camera_id).cloned()
};

let Some(camera) = camera else {
    error!("Camera {} not found in config", camera_id);
    return;
};

// Get stream config (global)
let stream_config = {
    let cfg = state.config.lock().unwrap();
    cfg.stream_config.clone()
};

// Get available encoders
let available = {
    let enc = state.available_encoders.lock()
        .expect("available_encoders mutex poisoned");
    enc.clone()
};

// Determine effective quality and FPS mode
let quality = camera.codec_override
    .as_ref()
    .map(|c| &c.quality)
    .unwrap_or(&stream_config.quality);

let fps_mode = camera.codec_override
    .as_ref()
    .map(|c| &c.fps_mode)
    .unwrap_or(&FpsMode::Native);

// Select encoder and build args
let (encoder_name, mut codec_args) = select_encoder(&stream_config, &available);

// Add FPS args
codec_args.extend(build_fps_args(fps_mode));

debug!("Using encoder: {} for camera {} (quality: {:?}, fps_mode: {:?})",
       encoder_name, camera_id, quality, fps_mode);
```

**Step 4: Test compilation**

Run: `cargo check --manifest-path=src-tauri/Cargo.toml`
Expected: Compiles without errors

**Step 5: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(codec): implement per-camera quality and FPS settings

- Extract FPS handling from build_h264_args
- Add build_fps_args function
- Use camera.codec_override if present, else global settings
- Native FPS by default (no -r flag)
- Log effective settings for debugging

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 6: Add Per-Camera Configuration UI

**Goal:** Add "Configure" button to each camera with modal dialog for per-camera settings

**Files:**
- Modify: `src/index.html` (add configure button and modal)
- Modify: `src/main.js` (add modal logic)
- Modify: `src/style.css` (style modal)

**Step 1: Add configure button to camera entries**

In `src/main.js`, find `renderCameraList()` (around line 974), update the camera entry template:

```javascript
list.innerHTML = this.cameras
  .map((cam, i) => `
    <div class="camera-entry" data-index="${i}">
      <span class="api-index" title="API Index: Use /api/solo/${i + 1}">${i + 1}</span>
      <input type="text" placeholder="Camera name" value="${cam.name}" data-field="name" />
      <input type="text" placeholder="rtp://224.1.2.4:4000" value="${cam.url}" data-field="url" />
      <button class="btn-config" data-camera-index="${i}" title="Configure camera settings">⚙️</button>
      <button class="remove-btn" data-remove-index="${i}">✕</button>
    </div>
  `)
  .join("");
```

**Step 2: Add modal HTML to index.html**

In `src/index.html`, add before the closing `</body>` tag (around line 300):

```html
<!-- Camera Configuration Modal -->
<div id="camera-config-modal" class="modal hidden">
  <div class="modal-content">
    <div class="modal-header">
      <h3 id="camera-config-title">Configure Camera</h3>
      <button class="modal-close" id="close-camera-config">✕</button>
    </div>
    <div class="modal-body">
      <div class="setting-row">
        <label for="camera-quality">Quality Preset:</label>
        <select id="camera-quality">
          <option value="">Use Global Settings</option>
          <option value="low">Low (720p)</option>
          <option value="medium">Medium (1080p)</option>
          <option value="high">High (Original)</option>
        </select>
      </div>
      <div class="setting-row">
        <label for="camera-fps-mode">FPS Mode:</label>
        <select id="camera-fps-mode">
          <option value="native">Native (Camera's FPS)</option>
          <option value="capped">Custom Cap</option>
        </select>
      </div>
      <div class="setting-row" id="camera-fps-value-row" style="display: none;">
        <label for="camera-fps-value">FPS Cap:</label>
        <input type="number" id="camera-fps-value" min="1" max="60" value="10" />
      </div>
    </div>
    <div class="modal-footer">
      <button id="save-camera-config" class="btn-primary">Save</button>
      <button id="cancel-camera-config" class="btn-secondary">Cancel</button>
    </div>
  </div>
</div>
```

**Step 3: Add modal event listeners**

In `src/main.js`, add to `bindUIEvents()` (around line 260):

```javascript
// Camera configure button
document.getElementById("camera-list")?.addEventListener("click", (e) => {
  if (e.target.classList.contains("btn-config")) {
    const cameraIndex = parseInt(e.target.dataset.cameraIndex);
    this.openCameraConfigModal(cameraIndex);
  }
});

// Camera config modal
document.getElementById("close-camera-config")?.addEventListener("click", () => {
  this.closeCameraConfigModal();
});

document.getElementById("cancel-camera-config")?.addEventListener("click", () => {
  this.closeCameraConfigModal();
});

document.getElementById("save-camera-config")?.addEventListener("click", () => {
  this.saveCameraConfig();
});

// FPS mode change
document.getElementById("camera-fps-mode")?.addEventListener("change", (e) => {
  const fpsValueRow = document.getElementById("camera-fps-value-row");
  if (e.target.value === "capped") {
    fpsValueRow.style.display = "flex";
  } else {
    fpsValueRow.style.display = "none";
  }
});
```

**Step 4: Add modal methods to StageView class**

In `src/main.js`, add these methods:

```javascript
openCameraConfigModal(cameraIndex) {
  this.editingCameraIndex = cameraIndex;
  const camera = this.cameras[cameraIndex];

  // Set modal title
  document.getElementById("camera-config-title").textContent =
    `Configure: ${camera.name || `Camera ${cameraIndex + 1}`}`;

  // Load current settings
  const override = camera.codec_override;

  if (override) {
    document.getElementById("camera-quality").value = override.quality || "";

    if (override.fps_mode === "native" || !override.fps_mode) {
      document.getElementById("camera-fps-mode").value = "native";
      document.getElementById("camera-fps-value-row").style.display = "none";
    } else {
      document.getElementById("camera-fps-mode").value = "capped";
      document.getElementById("camera-fps-value").value = override.fps_mode.capped || 10;
      document.getElementById("camera-fps-value-row").style.display = "flex";
    }
  } else {
    // No override - use global
    document.getElementById("camera-quality").value = "";
    document.getElementById("camera-fps-mode").value = "native";
    document.getElementById("camera-fps-value-row").style.display = "none";
  }

  // Show modal
  document.getElementById("camera-config-modal").classList.remove("hidden");
}

closeCameraConfigModal() {
  document.getElementById("camera-config-modal").classList.add("hidden");
  this.editingCameraIndex = null;
}

async saveCameraConfig() {
  if (this.editingCameraIndex === null) return;

  const camera = this.cameras[this.editingCameraIndex];
  const quality = document.getElementById("camera-quality").value;
  const fpsMode = document.getElementById("camera-fps-mode").value;

  if (quality === "") {
    // Remove override - use global settings
    delete camera.codec_override;
  } else {
    // Set override
    camera.codec_override = {
      quality: quality,
      fps_mode: fpsMode === "native" ? "native" : {
        capped: parseInt(document.getElementById("camera-fps-value").value)
      }
    };
  }

  this.closeCameraConfigModal();

  // Save config
  const config = await invoke("get_config");
  config.cameras = this.cameras;
  await invoke("save_config", { config });

  this.showToast(`Settings updated for ${camera.name}`, 'success');
}
```

**Step 5: Add CSS for modal**

In `src/style.css`, add:

```css
/* Camera Configuration Modal */
.modal {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
}

.modal.hidden {
  display: none;
}

.modal-content {
  background: #1f2937;
  border-radius: 8px;
  width: 90%;
  max-width: 500px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem 1.5rem;
  border-bottom: 1px solid #374151;
}

.modal-header h3 {
  margin: 0;
  font-size: 1.25rem;
  color: #e5e7eb;
}

.modal-close {
  background: none;
  border: none;
  color: #9ca3af;
  font-size: 1.5rem;
  cursor: pointer;
  padding: 0;
  width: 30px;
  height: 30px;
}

.modal-close:hover {
  color: #e5e7eb;
}

.modal-body {
  padding: 1.5rem;
}

.modal-footer {
  display: flex;
  gap: 0.5rem;
  padding: 1rem 1.5rem;
  border-top: 1px solid #374151;
  justify-content: flex-end;
}

.btn-primary {
  background: #3b82f6;
  color: white;
  padding: 0.5rem 1rem;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

.btn-primary:hover {
  background: #2563eb;
}

.btn-config {
  background: #374151;
  color: #e5e7eb;
  border: none;
  padding: 4px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 1rem;
}

.btn-config:hover {
  background: #4b5563;
}
```

**Step 6: Test manually**

1. Open settings
2. Click ⚙️ button on a camera
3. Verify modal opens
4. Change quality to High, FPS to Native
5. Click Save
6. Restart stream for that camera
7. Check console for FFmpeg args

**Step 7: Commit**

```bash
git add src/index.html src/main.js src/style.css
git commit -m "feat(ui): add per-camera configuration modal

- Add configure button (⚙️) to each camera entry
- Add modal dialog for per-camera quality and FPS settings
- Support 'Use Global Settings' option (removes override)
- Show/hide FPS input based on mode selection
- Save settings to camera.codec_override

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Phase 3: API Endpoints

### Task 7: Add Fullscreen API Endpoint

**Goal:** Add `/api/fullscreen` endpoint to toggle fullscreen mode

**Files:**
- Modify: `src-tauri/src/lib.rs` (add command and route)

**Step 1: Add fullscreen command**

In `src-tauri/src/lib.rs`, add after the encoder commands (around line 1010):

```rust
#[tauri::command]
async fn api_fullscreen(app: AppHandle) -> Result<Value, String> {
    let window = app.get_window("main")
        .ok_or("Main window not found")?;

    let is_fullscreen = window.is_fullscreen()
        .map_err(|e| e.to_string())?;

    window.set_fullscreen(!is_fullscreen)
        .map_err(|e| e.to_string())?;

    Ok(json!({
        "ok": true,
        "action": "fullscreen",
        "state": if !is_fullscreen { "entered" } else { "exited" }
    }))
}
```

**Step 2: Add route in start_api_server**

Find `start_api_server()` function (around line 1150), add route:

```rust
"/api/fullscreen" => {
    match api_fullscreen(app.clone()).await {
        Ok(result) => Response::builder()
            .status(200)
            .header("Content-Type", "application/json")
            .body(result.to_string().into())
            .unwrap(),
        Err(e) => Response::builder()
            .status(500)
            .header("Content-Type", "application/json")
            .body(json!({"ok": false, "error": e}).to_string().into())
            .unwrap(),
    }
}
```

**Step 3: Register command**

Find `.invoke_handler` (around line 1240), add:

```rust
api_fullscreen,
```

**Step 4: Test manually**

Run: `curl http://localhost:8090/api/fullscreen`
Expected: App toggles fullscreen, returns JSON response

**Step 5: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(api): add fullscreen endpoint

- Add /api/fullscreen endpoint to toggle fullscreen mode
- Returns current fullscreen state (entered/exited)
- Works with Stream Deck and remote control

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 8: Add Reload API Endpoint

**Goal:** Add `/api/reload` endpoint to reload config and refresh UI

**Files:**
- Modify: `src-tauri/src/lib.rs` (add command and route)
- Modify: `src/main.js` (add reload listener)

**Step 1: Add reload command**

In `src-tauri/src/lib.rs`, add after api_fullscreen:

```rust
#[tauri::command]
async fn api_reload(app: AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    info!("API reload requested");

    // Reload config from disk
    let config = load_config().await
        .map_err(|e| format!("Failed to load config: {}", e))?;

    // Update in-memory config
    {
        let mut cfg = state.config.lock()
            .map_err(|_| "Config mutex poisoned")?;
        *cfg = config;
    }

    info!("Config reloaded from disk");

    // Emit reload event to frontend
    app.emit_all("reload-config", json!({"ok": true}))
        .map_err(|e| e.to_string())?;

    Ok(json!({
        "ok": true,
        "action": "reload"
    }))
}
```

**Step 2: Add route in start_api_server**

```rust
"/api/reload" => {
    match api_reload(app.clone(), state.clone()).await {
        Ok(result) => Response::builder()
            .status(200)
            .header("Content-Type", "application/json")
            .body(result.to_string().into())
            .unwrap(),
        Err(e) => Response::builder()
            .status(500)
            .header("Content-Type", "application/json")
            .body(json!({"ok": false, "error": e}).to_string().into())
            .unwrap(),
    }
}
```

**Step 3: Register command**

Add to `.invoke_handler`:

```rust
api_reload,
```

**Step 4: Add frontend reload listener**

In `src/main.js`, add to `init()` method:

```javascript
// Listen for reload-config event
listen("reload-config", () => {
  console.log("Config reloaded, refreshing UI...");
  location.reload();
});
```

**Step 5: Test manually**

Run: `curl http://localhost:8090/api/reload`
Expected: App reloads config and refreshes UI

**Step 6: Commit**

```bash
git add src-tauri/src/lib.rs src/main.js
git commit -m "feat(api): add reload endpoint

- Add /api/reload endpoint to reload config from disk
- Emit reload-config event to frontend
- Frontend reloads webview on reload-config
- Useful for hot-reload during development

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 9: Update API Documentation

**Goal:** Document new fullscreen and reload endpoints in README

**Files:**
- Modify: `README.md` (add new endpoints to API section)

**Step 1: Add fullscreen endpoint documentation**

In `README.md`, find the API endpoints section (around line 230), add after the status endpoint:

```markdown
#### 4. Toggle Fullscreen
```
GET /api/fullscreen
```
Toggles the application fullscreen mode.

**Example:** `http://192.168.1.100:8090/api/fullscreen`

**Response:**
```json
{"ok": true, "action": "fullscreen", "state": "entered"}
```

**State values:**
- `"entered"` - Fullscreen is now active
- `"exited"` - Fullscreen is now inactive

#### 5. Reload Configuration
```
GET /api/reload
```
Reloads the configuration from disk and refreshes the UI.

**Example:** `http://192.168.1.100:8090/api/reload`

**Response:**
```json
{"ok": true, "action": "reload"}
```

**Note:** This endpoint is useful for hot-reloading configuration changes during development or when managing config files externally.
```

**Step 2: Add to integration examples**

Add to the Custom Script section:

```markdown
# Toggle fullscreen
curl http://192.168.1.100:8090/api/fullscreen

# Reload configuration
curl http://192.168.1.100:8090/api/reload
```

**Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add fullscreen and reload API endpoints

- Document /api/fullscreen endpoint with state values
- Document /api/reload endpoint for hot-reload
- Add curl examples for new endpoints

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Summary

**Total Tasks:** 9 tasks across 3 phases

**Phase 1 (Tasks 1-3): Critical Bug Fixes**
1. Hardware detection with FFmpeg testing
2. Codec error handling and fallback
3. PIP button investigation

**Phase 2 (Tasks 4-6): Per-Camera Features**
4. Per-camera data structures
5. FFmpeg command builder updates
6. Per-camera configuration UI

**Phase 3 (Tasks 7-9): API Endpoints**
7. Fullscreen endpoint
8. Reload endpoint
9. API documentation

**Testing Checkpoints:**
- After Task 1: Verify encoder detection shows correct GPU
- After Task 2: Verify error toast shows when encoder fails
- After Task 5: Verify per-camera FPS/quality works
- After Task 6: Verify modal UI saves settings correctly
- After Task 8: Verify reload endpoint refreshes config

**Success Criteria:**
- ✓ Hardware detection accurate (tested encoders)
- ✓ Codec errors visible (toast notifications)
- ✓ Per-camera quality works
- ✓ Native FPS default (no -r flag)
- ✓ API endpoints functional
- ✓ Backward compatible
- ✓ PIP button works (if bug found)

---

**Ready for execution with subagent-driven development or executing-plans skill.**
