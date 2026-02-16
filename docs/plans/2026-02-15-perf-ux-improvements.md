# Performance Fixes + UX Improvements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix window drag sluggishness, countdown timer stutter, stream health bugs, and add toolbar/cursor auto-hide.

**Architecture:** All changes are in 3 files: Rust backend health calculation (`lib.rs`), frontend logic (`main.js`), and toolbar CSS (`style.css`). No new dependencies. The health system switches from cumulative averages to rolling 10-second windows. The countdown moves from `setInterval` to the existing rAF loop. Toolbar/cursor hiding shares a single idle timer.

**Tech Stack:** Rust/Tauri backend, vanilla JS frontend, CSS

---

### Task 1: Fix Window Drag Performance

**Files:**
- Modify: `src/main.js` — `_sizeCanvas()` (lines 496-519), `setupWindowStatePersistence()` (lines 1447-1476)

**Step 1: Batch ResizeObserver canvas updates into rAF**

In `src/main.js`, replace the `_sizeCanvas` method (lines 496-519) with:

```javascript
_sizeCanvas(canvas, container) {
  const resize = () => {
    const rect = container.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      canvas.width = rect.width;
      canvas.height = rect.height;
    }
  };
  resize();
  if (!this._resizeObserver) {
    let resizeScheduled = false;
    this._resizeObserver = new ResizeObserver((entries) => {
      if (resizeScheduled) return;
      resizeScheduled = true;
      requestAnimationFrame(() => {
        resizeScheduled = false;
        for (const entry of entries) {
          const tile = entry.target;
          const c = tile.querySelector("canvas");
          if (c) {
            c.width = entry.contentRect.width;
            c.height = entry.contentRect.height;
          }
        }
      });
    });
  }
  this._resizeObserver.observe(container);
}
```

**Step 2: Increase debounce and add no-op skip to window state persistence**

In `src/main.js`, replace the `setupWindowStatePersistence` method (lines 1447-1476) with:

```javascript
async setupWindowStatePersistence() {
  const currentWindow = getCurrentWindow();
  let saveTimeout;
  let lastSavedState = null;

  const saveWindowState = async () => {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(async () => {
      try {
        const position = await currentWindow.outerPosition();
        const size = await currentWindow.outerSize();
        const maximized = await currentWindow.isMaximized();
        const newState = { x: position.x, y: position.y, width: size.width, height: size.height, maximized };

        // Skip save if nothing changed
        if (lastSavedState &&
            lastSavedState.x === newState.x && lastSavedState.y === newState.y &&
            lastSavedState.width === newState.width && lastSavedState.height === newState.height &&
            lastSavedState.maximized === newState.maximized) {
          return;
        }

        await this.serializedConfigSave(async (config) => {
          config.window_state = newState;
          return config;
        });
        lastSavedState = newState;
      } catch (err) {
        console.error("Failed to save window state:", err);
      }
    }, 2000);
  };

  await currentWindow.listen("tauri://resize", saveWindowState);
  await currentWindow.listen("tauri://move", saveWindowState);
}
```

**Step 3: Verify**

- Drag the window around rapidly. UI should stay fluid.
- Stop dragging. After ~2 seconds, config.json should update with final position.

**Step 4: Commit**

```bash
git add src/main.js
git commit -m "perf: fix window drag sluggishness

Batch ResizeObserver canvas updates into rAF to avoid per-tile reflows.
Increase window state save debounce from 500ms to 2000ms.
Skip no-op saves when position/size haven't changed."
```

---

### Task 2: Fix Countdown Timer Stutter

**Files:**
- Modify: `src/main.js` — `startShuffleTimer()` (lines 523-541), `updateCountdown()` (lines 543-552), `shuffleCameras()` (lines 554-586), `doPixelRefresh()` (lines 644-686), `_startRenderLoop()` (lines 471-480)

**Step 1: Move countdown into rAF loop**

In `src/main.js`, replace `startShuffleTimer` (lines 523-541) with:

```javascript
startShuffleTimer() {
  clearInterval(this.shuffleTimerId);

  if (this.cameras.length < 2) {
    document.getElementById("shuffle-timer").textContent = "";
    return;
  }

  this.nextShuffleAt = Date.now() + this.shuffleIntervalSecs * 1000;

  this.shuffleTimerId = setInterval(() => {
    this.shuffleCameras();
    this.nextShuffleAt = Date.now() + this.shuffleIntervalSecs * 1000;
  }, this.shuffleIntervalSecs * 1000);

  // Countdown is now updated inside _startRenderLoop via updateCountdown()
}
```

Remove the `this.countdownId` field from the constructor (line 167). Remove `clearInterval(this.countdownId)` from the old `startShuffleTimer`.

Replace `_startRenderLoop` (lines 471-480) with:

```javascript
_startRenderLoop() {
  if (this._rafId) return;
  const loop = () => {
    for (const reader of this.streamReaders.values()) {
      reader.draw();
    }
    this.updateCountdown();
    this._rafId = requestAnimationFrame(loop);
  };
  this._rafId = requestAnimationFrame(loop);
}
```

**Step 2: Batch DOM shuffles with DocumentFragment**

Replace `shuffleCameras` (lines 554-586) with:

```javascript
shuffleCameras() {
  if (this.soloIndex !== null) {
    this.doPixelRefresh();
    return;
  }

  if (this.displayOrder.length < 2) return;

  // Sattolo's algorithm on indices
  for (let i = this.displayOrder.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * i);
    [this.displayOrder[i], this.displayOrder[j]] =
      [this.displayOrder[j], this.displayOrder[i]];
  }

  // Batch DOM reorder using DocumentFragment (single reflow)
  const grid = document.getElementById("grid");
  const tileMap = {};
  grid.querySelectorAll(".camera-tile").forEach((tile) => {
    tileMap[tile.dataset.id] = tile;
  });

  const fragment = document.createDocumentFragment();
  for (const index of this.displayOrder) {
    const cam = this.cameras[index];
    const tile = tileMap[cam.id];
    if (tile) fragment.appendChild(tile);
  }
  grid.appendChild(fragment);
}
```

**Step 3: Cache noise texture in doPixelRefresh**

Replace `doPixelRefresh` (lines 644-686) with:

```javascript
doPixelRefresh() {
  const orbits = [
    { x:  1, y:  0 }, { x:  1, y:  1 }, { x:  0, y:  1 }, { x: -1, y:  1 },
    { x: -1, y:  0 }, { x: -1, y: -1 }, { x:  0, y: -1 }, { x:  1, y: -1 },
    { x:  2, y:  0 }, { x:  0, y:  2 }, { x: -2, y:  0 }, { x:  0, y: -2 },
  ];

  this.pixelShiftIndex = (this.pixelShiftIndex + 1) % orbits.length;
  const shift = orbits[this.pixelShiftIndex];
  const grid = document.getElementById("grid");
  grid.style.transition = "transform 1.5s ease-in-out";
  grid.style.transform = `translate(${shift.x}px, ${shift.y}px)`;

  // Generate noise texture once, reuse across calls
  if (!this._noiseDataUrl) {
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext("2d");
    const imgData = ctx.createImageData(128, 128);
    for (let i = 0; i < imgData.data.length; i += 4) {
      const v = Math.random() * 255;
      imgData.data[i]     = v;
      imgData.data[i + 1] = v;
      imgData.data[i + 2] = v;
      imgData.data[i + 3] = 10;
    }
    ctx.putImageData(imgData, 0, 0);
    this._noiseDataUrl = canvas.toDataURL();
  }

  const overlay = document.getElementById("pixel-refresh");
  overlay.style.backgroundImage = `url(${this._noiseDataUrl})`;
  overlay.style.backgroundRepeat = "repeat";

  overlay.classList.add("active");
  setTimeout(() => {
    overlay.classList.remove("active");
    setTimeout(() => { overlay.style.backgroundImage = ""; }, 600);
  }, 3000);
}
```

**Step 4: Verify**

- Watch countdown timer for several minutes. It should tick smoothly every second without jumps.
- Wait for a shuffle to occur. Timer should not stutter.
- Test solo mode pixel refresh. Should work without jank.

**Step 5: Commit**

```bash
git add src/main.js
git commit -m "perf: fix countdown timer stutter

Move countdown updates from setInterval to rAF render loop.
Batch DOM tile shuffles with DocumentFragment (single reflow).
Cache noise texture in doPixelRefresh to avoid expensive toDataURL per call."
```

---

### Task 3: Fix Stream Health — Rolling 10s Window (Backend)

**Files:**
- Modify: `src-tauri/src/lib.rs` — health task spawn block (lines 742-803)

**Step 1: Add previous-tick tracking to health calculation**

In `src-tauri/src/lib.rs`, replace the health task spawn block (lines 751-803) with:

```rust
let health_task = tauri::async_runtime::spawn(async move {
    let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(2));
    interval.tick().await; // Skip first immediate tick

    // Track previous tick values for rolling delta calculation
    let mut prev_count: u64 = 0;
    let mut prev_bytes: u64 = 0;
    let mut prev_tick = std::time::Instant::now();

    loop {
        interval.tick().await;

        let now = std::time::Instant::now();
        let tick_elapsed = now.duration_since(prev_tick).as_secs_f32().max(0.1);

        let count = health_frame_count.load(Ordering::Relaxed);
        let bytes = health_bytes_received.load(Ordering::Relaxed);

        // Rolling delta: frames and bytes since last tick
        let delta_frames = count.saturating_sub(prev_count);
        let delta_bytes = bytes.saturating_sub(prev_bytes);

        let fps = delta_frames as f32 / tick_elapsed;
        let bitrate_kbps = (delta_bytes as f32 * 8.0) / (tick_elapsed * 1000.0);

        prev_count = count;
        prev_bytes = bytes;
        prev_tick = now;

        let uptime = start_time.elapsed().as_secs().max(1);

        // Get resolution from last frame
        let resolution = match health_frame_buffer.lock() {
            Ok(frame_buf) => {
                if !frame_buf.is_empty() {
                    parse_jpeg_resolution(&frame_buf)
                } else {
                    None
                }
            }
            Err(_) => None,
        };

        let health = StreamHealth {
            camera_id: health_camera_id.clone(),
            fps,
            bitrate_kbps,
            frame_count: count,
            last_frame_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64,
            uptime_secs: uptime,
            resolution,
            quality_setting: health_quality_str.clone(),
            codec: health_codec_str.clone(),
        };

        // Access state through app handle
        let health_state = health_app.state::<AppState>();
        if let Ok(mut health_map) = health_state.stream_health.lock() {
            health_map.insert(health_camera_id.clone(), health.clone());
        }

        let _ = health_app.emit("stream-health", StreamHealthEvent {
            camera_id: health_camera_id.clone(),
            health,
        });
    }
});
```

**Step 2: Verify Rust compiles**

Run: `cd src-tauri && cargo check`
Expected: compiles with no errors.

**Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "fix: switch health FPS/bitrate to rolling 2s window

Replace cumulative averages (total/uptime) with per-tick deltas.
FPS and bitrate now reflect the last 2-second interval, making
real-time degradation immediately visible."
```

---

### Task 4: Fix Stream Health — Frontend Bugs

**Files:**
- Modify: `src/main.js` — constructor (lines 158-186), `init()` (lines 190-277), stream-health listener (lines 223-233), `refreshHealthStats()` (lines 956-969), `startHealthMonitoring()` (lines 1096-1125), `updateCameraHealthState()` (lines 1127-1144)

**Step 1: Remove debounce from stream-health listener**

In `src/main.js`, replace the stream-health listener (lines 223-233) with:

```javascript
// Listen for stream health updates
this.unlistenHealth = await listen("stream-health", (event) => {
  const { camera_id, health } = event.payload;
  this.healthStats.set(camera_id, health);
  this.updateHealthDisplay();
});
```

**Step 2: Remove `_healthDisplayTimer` from constructor**

In the constructor (line 182), remove:
```javascript
this._healthDisplayTimer = null; // debounce timer for updateHealthDisplay
```

**Step 3: Clear stale entries in refreshHealthStats**

Replace `refreshHealthStats` (lines 956-969) with:

```javascript
async refreshHealthStats() {
  try {
    const healthMap = await invoke("get_stream_health");
    this.healthStats.clear();
    for (const [cameraId, health] of Object.entries(healthMap)) {
      this.healthStats.set(cameraId, health);
    }
    this.updateHealthDisplay();
  } catch (err) {
    console.error("Failed to fetch stream health:", err);
    this.updateHealthDisplay();
  }
}
```

**Step 4: Remove startHealthMonitoring and its invocation**

Delete the entire `startHealthMonitoring()` method (lines 1096-1125).

Delete the entire `updateCameraHealthState()` method (lines 1127-1144).

Remove from constructor (line 177-178):
```javascript
this.cameraHealthStates = new Map(); // Track health per camera
this.healthCheckInterval = null;
```

Remove from `init()` (lines 262-267):
```javascript
// Initialize health states for all cameras
this.cameras.forEach(cam => {
  this.cameraHealthStates.set(cam.id, 'offline');
});

// Start health monitoring (delay to avoid false "offline" toasts on startup)
setTimeout(() => this.startHealthMonitoring(), 30000);
```

**Step 5: Verify**

- Open Settings. Health stats should update every 2s without lag.
- FPS should show current real-time values (not cumulative averages).
- Delete a camera and re-open Settings. No stale health cards should appear.

**Step 6: Commit**

```bash
git add src/main.js
git commit -m "fix: stream health display bugs

Remove 2s debounce on health updates (backend already throttles to 2s).
Clear stale health entries in refreshHealthStats.
Remove redundant startHealthMonitoring polling loop."
```

---

### Task 5: Auto-hide Toolbar + Cursor in Fullscreen

**Files:**
- Modify: `src/main.js` — constructor, `init()`, new method `setupIdleHiding()`
- Modify: `src/style.css` — toolbar rules (lines 199-221)

**Step 1: Update CSS — replace hover-based toolbar show with class-based**

In `src/style.css`, replace the toolbar visibility rules (lines 212-221):

```css
/* Old rules to remove: */
/* opacity: 0; */
/* body:hover #toolbar, #toolbar:hover { opacity: 1; } */
```

Replace with:

```css
#toolbar {
  /* ... existing properties ... */
  opacity: 0;
  pointer-events: none;
  transition: opacity 300ms ease;
  /* ... */
}

#toolbar.visible {
  opacity: 1;
  pointer-events: auto;
}
```

Specifically in the existing `#toolbar` rule (line 212), change `opacity: 0;` to remain, and add `pointer-events: none;` after it. Then replace lines 218-221 (`body:hover #toolbar, #toolbar:hover { opacity: 1; }`) with:

```css
#toolbar.visible {
  opacity: 1;
  pointer-events: auto;
}
```

**Step 2: Add idle hiding to constructor and init**

Add to constructor after line 184 (`this._rafId = null;`):

```javascript
this._idleTimer = null;
this._isIdle = false;
```

Add to `init()` after `this.setupWindowStatePersistence();` (line 276):

```javascript
this.setupIdleHiding();
```

**Step 3: Implement setupIdleHiding method**

Add this new method after `setupWindowStatePersistence()`:

```javascript
setupIdleHiding() {
  const IDLE_TIMEOUT = 10000; // 10 seconds
  const toolbar = document.getElementById('toolbar');

  const showUI = () => {
    this._isIdle = false;
    toolbar.classList.add('visible');
    document.body.style.cursor = '';

    clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(hideUI, IDLE_TIMEOUT);
  };

  const hideUI = async () => {
    this._isIdle = true;
    toolbar.classList.remove('visible');

    // Hide cursor only in fullscreen
    try {
      const win = getCurrentWindow();
      if (await win.isFullscreen()) {
        document.body.style.cursor = 'none';
      }
    } catch (_) {}
  };

  document.addEventListener('mousemove', showUI);
  document.addEventListener('mousedown', showUI);

  // Start visible, then begin idle timer
  showUI();
}
```

**Step 4: Verify**

- Move mouse: toolbar appears immediately.
- Stop moving mouse for 10 seconds: toolbar fades out.
- Enter fullscreen, stop moving mouse: toolbar fades AND cursor hides.
- Move mouse again: cursor and toolbar both reappear instantly.
- All existing toolbar buttons still work during the visible window.

**Step 5: Commit**

```bash
git add src/main.js src/style.css
git commit -m "feat: auto-hide toolbar after 10s idle, hide cursor in fullscreen

Replace CSS hover-based toolbar with JS idle timer.
Toolbar shows on any mouse movement, hides after 10s idle.
Mouse cursor hides in fullscreen mode after 10s idle."
```
