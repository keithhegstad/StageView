# Bug Fixes & Per-Camera Features - Design Document

**Date**: 2026-02-13
**Status**: Approved

## Overview

Fix critical bugs in hardware detection and codec selection, and add per-camera quality/FPS configuration to give users fine-grained control over each camera stream.

## Problems to Solve

### Critical Bugs
1. **Hardware detection incorrect**: App shows "NVIDIA GPU detected" when user has Intel graphics. Root cause: naive string matching in FFmpeg output parsing.
2. **Codec/encoder settings not working**: H.264 encoding doesn't apply. Root cause: Selected encoder (nvenc) fails silently because hardware not available, no error feedback.
3. **PIP add overlay button**: May be broken (pending user confirmation of console errors).

### Feature Requests
1. **Per-camera quality settings**: Different cameras need different quality presets (not global).
2. **Native FPS support**: Cameras should stream at their native FPS (remove -r flag cap).
3. **New API endpoints**: `/api/fullscreen` and `/api/reload` for remote control.

## Current Architecture

### Global Codec Settings
```rust
pub struct AppConfig {
    pub stream_config: StreamConfig,  // Applied to ALL cameras
    // ...
}

pub struct StreamConfig {
    pub codec: CodecType,      // H264 or MJPEG
    pub encoder: EncoderType,  // Auto, Nvenc, QSV, etc.
    pub quality: Quality,      // Low, Medium, High
}
```

### Hardware Detection
```rust
async fn detect_encoders() -> AvailableEncoders {
    // Uses contains() - too naive
    AvailableEncoders {
        nvenc: encoders_str.contains("h264_nvenc"),
        qsv: encoders_str.contains("h264_qsv"),
        videotoolbox: encoders_str.contains("h264_videotoolbox"),
        x264: true,
    }
}
```

**Problem**: Lists encoder if string appears anywhere in FFmpeg output, doesn't verify it actually works.

## Design Solutions

### 1. Hardware Detection Fix

**Approach**: Test encoders with actual FFmpeg commands + manual selection.

**Two-phase detection**:
1. **Parse FFmpeg -encoders**: Check if encoder is listed (current behavior)
2. **Test encoder**: Run quick FFmpeg test to verify it actually works
   ```bash
   ffmpeg -f lavfi -i testsrc=duration=1:size=320x240:rate=1 \
          -c:v h264_qsv -f null - 2>&1
   ```
   - Exit code 0 = works
   - Non-zero = doesn't work

**Manual selection**:
- Show dropdown with detected encoders
- Mark tested/working encoders with ✓ indicator
- Let user pick preferred encoder explicitly
- Remove "Auto" detection from UI (user chooses)

**Benefits**:
- Accurate detection (tested, not guessed)
- User control (picks what works on their system)
- Clear feedback (see which encoders are verified)

### 2. Codec Error Handling

**Problem**: If encoder fails at stream start, error is silent or falls back to MJPEG without notification.

**Solution**:
1. Test encoder during detection (covered in Solution 1)
2. Add error handling in `try_stream_camera()`:
   ```rust
   // If FFmpeg spawn fails, emit error event
   app_handle.emit_all("stream-error", json!({
       "camera_id": camera_id,
       "error": "Encoder failed",
       "encoder": encoder_name
   }));
   ```
3. Show toast notification in frontend when stream-error received
4. Fallback chain: If selected encoder fails, try x264 (software), then MJPEG

**Benefits**:
- User sees why stream failed
- Automatic fallback keeps cameras working
- Clear path to fix (change encoder in settings)

### 3. PIP Button Investigation

**Status**: Pending user confirmation of console errors.

**If broken**, likely fixes:
- Ensure `renderPipConfig()` is called before button click
- Add defensive null checks in `addPipOverlay()`
- Add error logging to identify failure point

### 4. Per-Camera Quality Settings

**New Data Structures**:
```rust
pub struct Camera {
    pub id: String,
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub codec_override: Option<CameraCodecSettings>,  // NEW
}

pub struct CameraCodecSettings {
    pub quality: Quality,      // Low, Medium, High
    pub fps_mode: FpsMode,     // Native or Capped
}

pub enum FpsMode {
    Native,      // No -r flag - use camera's FPS
    Capped(u32), // Add -r N to cap FPS
}

impl Default for FpsMode {
    fn default() -> Self {
        FpsMode::Native  // Default to native FPS
    }
}
```

**Configuration Priority**:
1. If camera has `codec_override`, use those settings
2. Otherwise, use global `stream_config`

**FFmpeg Command Building**:
```rust
fn build_camera_args(
    camera: &Camera,
    global_config: &StreamConfig,
    available: &AvailableEncoders,
) -> Vec<String> {
    // Get effective settings (camera override or global)
    let quality = camera.codec_override
        .as_ref()
        .map(|c| &c.quality)
        .unwrap_or(&global_config.quality);

    let fps_mode = camera.codec_override
        .as_ref()
        .map(|c| &c.fps_mode)
        .unwrap_or(&FpsMode::Native);

    // Build args based on quality
    let mut args = build_quality_args(quality);

    // Add FPS if capped
    match fps_mode {
        FpsMode::Native => {
            // Don't add -r flag, use camera's native FPS
        }
        FpsMode::Capped(fps) => {
            args.extend(["-r".to_string(), fps.to_string()]);
        }
    }

    args
}
```

**Benefits**:
- Flexible: Can mix global defaults with per-camera overrides
- Backward compatible: Existing configs work (no override = use global)
- Native FPS default: Better quality out of the box

### 5. Per-Camera Settings UI

**Add to camera entry in settings panel**:
```html
<div class="camera-entry">
  <span class="api-index">1</span>
  <input type="text" placeholder="Camera name" value="Front Door" />
  <input type="text" placeholder="rtp://..." value="..." />
  <button class="btn-config" data-camera-id="...">⚙️ Configure</button>
  <button class="remove-btn">✕</button>
</div>
```

**Configuration Modal**:
When user clicks "Configure" button:
1. Open modal dialog
2. Show camera-specific settings:
   - Quality preset dropdown (Low/Medium/High/Use Global)
   - FPS mode dropdown (Native/Custom)
   - If Custom: FPS input field
3. Save button updates camera's `codec_override` field

**Visual Design**:
- Modal overlay with centered dialog
- Clear "Use Global Settings" option (removes override)
- Preview of effective settings shown

### 6. New API Endpoints

**Fullscreen Endpoint**: `/api/fullscreen`
```rust
#[tauri::command]
async fn api_fullscreen(app: AppHandle) -> Result<Value, String> {
    let window = app.get_window("main").ok_or("Window not found")?;
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

**Reload Endpoint**: `/api/reload`
```rust
#[tauri::command]
async fn api_reload(app: AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    // 1. Reload config from disk
    let config = load_config().await?;
    {
        let mut cfg = state.config.lock().unwrap();
        *cfg = config;
    }

    // 2. Emit reload event to frontend
    app.emit_all("reload-config", json!({"ok": true}))
        .map_err(|e| e.to_string())?;

    // 3. Restart streams with new config
    // (frontend will handle webview reload on reload-config event)

    Ok(json!({
        "ok": true,
        "action": "reload"
    }))
}
```

**API Server Updates**:
Add routes in `start_api_server()`:
```rust
"/api/fullscreen" => api_fullscreen(app.clone()).await,
"/api/reload" => api_reload(app.clone(), state.clone()).await,
```

**Frontend Reload Handler**:
```javascript
listen("reload-config", () => {
    location.reload();  // Refresh webview
});
```

## Testing Strategy

### Hardware Detection Testing
1. Test on system with NVIDIA GPU (should detect nvenc)
2. Test on system with Intel graphics (should detect qsv)
3. Test on macOS (should detect videotoolbox)
4. Test on system with no hardware encoding (should only show x264)
5. Verify manual selection overrides detection

### Per-Camera Settings Testing
1. Set global quality to Low, one camera to High - verify different FFmpeg args
2. Set one camera to Native FPS, another to Capped(5) - verify -r flag presence
3. Remove camera override - verify falls back to global settings
4. Save config, restart app - verify per-camera settings persist

### API Endpoint Testing
```bash
# Test fullscreen
curl http://localhost:8090/api/fullscreen
# Should toggle fullscreen

# Test reload
curl http://localhost:8090/api/reload
# Should reload config and refresh UI
```

### Codec Error Handling Testing
1. Select nvenc on system without NVIDIA GPU
2. Verify error toast appears: "Encoder nvenc failed"
3. Verify fallback to x264 or MJPEG
4. Check stream continues working despite encoder failure

## Migration Strategy

### Backward Compatibility

**Existing configs** (no `codec_override` field):
```json
{
  "cameras": [
    {"id": "...", "name": "Camera 1", "url": "..."}
  ]
}
```

**New configs** (with per-camera overrides):
```json
{
  "cameras": [
    {
      "id": "...",
      "name": "Camera 1",
      "url": "...",
      "codec_override": {
        "quality": "high",
        "fps_mode": "native"
      }
    }
  ]
}
```

**Deserialization**: Use `#[serde(default)]` on `codec_override` field - missing field deserializes to `None`, meaning "use global settings".

### User Migration

**On first launch after update**:
1. All cameras use global settings (no override)
2. User can optionally configure per-camera settings
3. Global settings remain the default

**No breaking changes** - existing configs work unchanged.

## Success Criteria

✅ **Hardware detection accurate**: Shows correct GPU, tested encoders marked
✅ **Codec errors visible**: Toast notification if encoder fails
✅ **Per-camera quality works**: Different cameras can have different settings
✅ **Native FPS works**: Cameras stream at native FPS when set
✅ **API endpoints work**: Fullscreen and reload respond correctly
✅ **Backward compatible**: Existing configs load without errors
✅ **PIP button fixed**: Add overlay button works (if bug confirmed)

## Implementation Notes

### Phase 1: Bug Fixes (Priority)
1. Fix hardware detection with FFmpeg testing
2. Add codec error handling and fallback
3. Fix PIP button (if broken)

### Phase 2: Per-Camera Features
1. Add data structures (CameraCodecSettings, FpsMode)
2. Update FFmpeg command builder
3. Add per-camera UI
4. Test and validate

### Phase 3: API Endpoints
1. Add fullscreen endpoint
2. Add reload endpoint
3. Update API documentation

**Estimated effort**: 2-3 days for complete implementation and testing.
