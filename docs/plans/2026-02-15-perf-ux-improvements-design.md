# Performance Fixes + UX Improvements Design

## Problem Statement

1. Window dragging feels sluggish/laggy
2. Burn-in countdown timer sometimes sticks for 2 seconds
3. Stream health display shows stale/inaccurate data
4. Toolbar doesn't auto-hide; cursor doesn't hide in fullscreen

## Section 1: Window Drag Performance

**Root cause:** `setupWindowStatePersistence()` fires `serializedConfigSave()` on every `tauri://move` and `tauri://resize` event. Each call chains `invoke("get_config")` + `invoke("save_config")`, where `save_config` does synchronous `std::fs::write()`. The 500ms debounce is too aggressive.

**Fix:**
- Increase debounce from 500ms to 2000ms
- Batch canvas resizes into a single rAF callback (ResizeObserver currently forces per-tile reflow)
- Skip no-op saves by comparing old vs new window state

## Section 2: Countdown Timer Stutter

**Root cause:** `shuffleCameras()` blocks the main thread with repeated `grid.appendChild()` (one reflow per tile). The `setInterval` countdown queues up and skips a tick. In solo mode, `doPixelRefresh()` calls `canvas.toDataURL()` which is extremely expensive.

**Fix:**
- Batch DOM shuffles using DocumentFragment (one reflow instead of N)
- Cache the noise texture in `doPixelRefresh()` — generate once, reuse
- Switch countdown from `setInterval(1000)` to rAF-driven updates inside the existing render loop

## Section 3: Stream Health Bugs

**Root causes:**
- Cumulative FPS/bitrate (total frames / total uptime) hides real-time degradation
- 2s debounce on display updates causes 4s total lag
- `refreshHealthStats()` never clears stale entries for deleted cameras
- Two conflicting health systems (event-driven + 10s polling) use different criteria

**Fix:**
- Rolling 10s FPS/bitrate in Rust — track previous tick's counts, compute delta
- Remove the 2s debounce on `updateHealthDisplay()` (backend already throttles to 2s intervals)
- Clear stale health data in `refreshHealthStats()` and on camera deletion
- Remove `startHealthMonitoring()` entirely — event-driven updates are sufficient

## Section 4: Auto-hide Toolbar + Cursor

**Toolbar auto-hide after 10s idle:**
- Track last mouse-move timestamp; on `mousemove`, show toolbar and reset timer
- After 10s idle, fade toolbar out
- Existing hover-based show/hide remains as immediate override

**Hide cursor in fullscreen after 10s idle:**
- Same idle timer; when idle AND fullscreen, set `cursor: none` on body
- On `mousemove`, restore cursor
- Only applies in fullscreen mode
