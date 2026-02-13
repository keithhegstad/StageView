# StageView UX Polish - Design Document

**Date:** 2026-02-13
**Goal:** Simplify layout editor and modernize stream health UI for better user experience

---

## Problem Statement

Current implementation has three UX issues:
1. **Custom grid layout** - x/y/width/height inputs are too complicated and unintuitive
2. **Picture-in-Picture setup** - manual positioning is complex for a simple concept
3. **Stream health display** - takes too much space, needs better visual design

---

## Solution Overview

**Approach:** Phased refactor in 3 phases
- Phase 1: Redesign Stream Health UI (quick visual win)
- Phase 2: Simplify PIP with corner presets
- Phase 3: Remove custom grid entirely, keep only Auto Grid + PIP

**Principles:**
- Maintain vanilla JavaScript architecture
- Keep it simple and intuitive
- No breaking changes to existing data
- Professional visual appeal

---

## Architecture

### Data Model Changes (Backend - Rust)

**Add to LayoutConfig:**
```rust
pub struct PipConfig {
    pub main_camera_id: String,
    pub overlays: Vec<PipOverlay>,
}

pub struct PipOverlay {
    pub camera_id: String,
    pub corner: String,  // "TL", "TR", "BL", "BR"
    pub size_percent: u8, // 10-40
}

// Add to LayoutConfig:
pub pip_config: Option<PipConfig>,
```

**Remove:**
- `CameraPosition` struct
- `positions` field from LayoutConfig
- "custom" layout type support

**Final layout types:** "grid" (auto), "pip"

### Frontend Changes

**Layout Editor:**
- Simplified to 2 options: Auto Grid or PIP
- Auto Grid: no configuration needed
- PIP: main camera selector + overlay corner/size presets

**Health Stats:**
- Square cards, 2 per row fixed
- Modern minimal design with subtle colors
- Animated value changes

---

## Phase 1: Stream Health UI Redesign

### Visual Design

**Layout:**
- Square cards (aspect-ratio: 1)
- Fixed 2-column grid (`grid-template-columns: repeat(2, 1fr)`)
- Compact spacing, removed excessive padding
- Each card: Camera name + 3 metrics stacked vertically

**Typography:**
- Font: System font stack (-apple-system, "Segoe UI", etc.)
- Camera name: Medium weight
- Metric labels: Small, uppercase, subtle
- Metric values: Large, bold, prominent

**Color System:**
- FPS: Blue (#5eb3ff)
- Bitrate: Purple (#a855f7)
- Uptime: Green (#10b981)
- Each metric has its own color for visual distinction

**Effects (Subtle):**
- Pulse on value update (0.3s glow)
- Subtle gradient backgrounds
- Smooth value transitions (0.4s ease)
- Hover state: slight lift with shadow

**Metrics Display:**
- FPS: "12.5 fps" (1 decimal)
- Bitrate: Auto-convert to Mbps when >1000 kbps ("1.25 Mbps" or "850 kbps")
- Uptime: "2h 15m" (omit seconds for cleaner look)

### Implementation

**CSS Changes:**
- Change grid to `repeat(2, 1fr)`
- Add `aspect-ratio: 1` for square cards
- CSS custom properties for metric colors
- `@keyframes` for pulse/glow effects
- Transitions for smooth updates

**JavaScript Changes:**
- Update `updateHealthDisplay()`:
  - Bitrate Mbps conversion
  - Simplified uptime format (hours + minutes)
  - Add pulse animation on value change

---

## Phase 2: PIP Presets System

### Concept

One main camera fills screen, smaller cameras overlay in corners with preset positions/sizes.

### UI Design

**Layout Editor Controls:**
1. Main Camera dropdown - which camera is full-screen
2. Overlay Configuration (per camera):
   - Corner selector: 4 buttons (TL ↖, TR ↗, BL ↙, BR ↘)
   - Size dropdown: 10%, 15%, 20%, 25%, 30%, 35%, 40%
   - Remove button
3. Visual preview of layout

**Corner Conflict Prevention:**
- Each corner can have max 1 overlay
- If user tries to assign to occupied corner: show warning
- Prevents overlapping overlays

### Rendering Logic

**Position Calculation:**
- TL (top-left): x: 2%, y: 2%
- TR (top-right): x: 98% - size, y: 2%
- BL (bottom-left): x: 2%, y: 98% - size
- BR (bottom-right): x: 98% - size, y: 98% - size
- Width/Height: size_percent of viewport
- Z-index: main = 1, overlays = 10+

**Constraints:**
- PIP is the ONLY mode where overlays are allowed
- Grid mode: strict grid, no overlapping ever
- One camera per corner maximum

---

## Phase 3: Simplify Layout System

### Remove Custom Grid

**Deleted entirely:**
- Custom grid layout type
- Grid builder UI (sliders, cell placement)
- Manual position inputs
- `renderCustomLayout()` method
- `CameraPosition` struct

**Keep only:**
1. Auto Grid - existing automatic square grid
2. PIP - new simplified corner preset system

### New Layout Editor UI

**Simplified interface:**
- Layout Name input
- Layout Type: Radio buttons for "Auto Grid" or "Picture-in-Picture"
- When Auto Grid: no additional options
- When PIP: show main camera + overlay config
- Save/Apply/Close buttons

**Benefits:**
- Dramatically simpler codebase
- Two clear, distinct modes users understand
- No complex configuration
- Removes ~300 lines of unused code

---

## Data Migration

**Backward Compatibility:**
- Existing "grid" layouts continue to work (no changes)
- Existing "custom" layouts will fall back to "grid" mode
- Existing "pip" layouts with manual positions will need re-configuration
- Users will see a notice: "Legacy layouts have been simplified. Please reconfigure PIP layouts."

---

## Testing Strategy

**Phase 1:**
- Visual regression: health cards appear correct
- Metric formatting: Mbps conversion, uptime format
- Animations: pulse effects work smoothly
- Responsive: 2-column grid at all sizes

**Phase 2:**
- PIP rendering: corners position correctly
- Size percentages: accurate scaling
- Corner conflicts: warnings prevent duplicates
- Z-index: overlays appear on top

**Phase 3:**
- Layout editor: only shows Grid/PIP options
- Auto grid: still works as before
- PIP: new system integrates smoothly
- Code cleanup: no broken references

---

## Success Criteria

1. Stream health UI is visually appealing and compact
2. PIP setup takes <30 seconds (vs 2-3 minutes before)
3. No complex positioning inputs remain
4. Layout editor is intuitive for new users
5. Code is simpler and more maintainable

---

## Implementation Plan

Detailed implementation plan will be created in separate document using writing-plans skill.
