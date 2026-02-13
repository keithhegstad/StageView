# StageView UX Polish Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Simplify layout system and modernize stream health UI through phased refactoring

**Architecture:** Maintain vanilla JavaScript frontend with Tauri 2 Rust backend. Phase 1: Redesign health UI with modern styling. Phase 2: Add PIP preset system with corner/size dropdowns. Phase 3: Remove custom grid complexity, keep only Auto Grid + PIP.

**Tech Stack:** Vanilla JS, CSS Grid, Rust/Tauri 2, Serde

---

## Phase 1: Stream Health UI Redesign

### Task 1: Redesign Health Stats CSS

**Files:**
- Modify: `src/style.css:930-969` (health stats section)

**Step 1: Update health container to fixed 2-column grid**

In `src/style.css`, find `#health-stats-container` (line 930) and replace with:

```css
#health-stats-container {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 1.5rem;
  margin-bottom: 2rem;
}
```

**Step 2: Make health cards square with gradient background**

Replace `.health-card` (line 937):

```css
.health-card {
  aspect-ratio: 1;
  background: linear-gradient(135deg, #2a2a2a 0%, #1f1f1f 100%);
  border: 1px solid #444;
  border-radius: 8px;
  padding: 1.5rem;
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}

.health-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}
```

**Step 3: Update health metrics layout to vertical stack**

Replace `.health-metrics` (line 951):

```css
.health-metrics {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  margin-top: 1rem;
}
```

**Step 4: Update health metric styling**

Replace `.health-metric` (line 957):

```css
.health-metric {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
```

**Step 5: Add CSS custom properties for metric colors**

Add at top of health stats section (line 920):

```css
/* ── Health Stats Section ─────────────────────────────────────────────────── */

:root {
  --health-fps-color: #5eb3ff;
  --health-bitrate-color: #a855f7;
  --health-uptime-color: #10b981;
}
```

**Step 6: Update metric label styling**

Replace `.health-label` (line 963):

```css
.health-label {
  color: #999;
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  font-weight: 500;
}
```

**Step 7: Update metric value styling with colors**

Replace `.health-value` (line 970):

```css
.health-value {
  font-size: 1.5rem;
  font-weight: 700;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  transition: all 0.4s ease;
}

.health-metric[data-type="fps"] .health-value {
  color: var(--health-fps-color);
}

.health-metric[data-type="bitrate"] .health-value {
  color: var(--health-bitrate-color);
}

.health-metric[data-type="uptime"] .health-value {
  color: var(--health-uptime-color);
}
```

**Step 8: Add pulse animation**

Add after metric value styling:

```css
@keyframes health-pulse {
  0%, 100% {
    opacity: 1;
    filter: drop-shadow(0 0 0 transparent);
  }
  50% {
    opacity: 0.95;
    filter: drop-shadow(0 0 8px currentColor);
  }
}

.health-value.updated {
  animation: health-pulse 0.3s ease;
}
```

**Step 9: Test CSS changes**

Run:
```bash
npm run tauri dev
```

Open settings panel and verify:
- Health cards are square
- 2 cards per row
- Gradient backgrounds
- Hover effect works

Expected: Modern, compact health cards visible

**Step 10: Commit CSS changes**

```bash
git add src/style.css
git commit -m "style(health): redesign health stats with modern square cards

- Fixed 2-column grid layout
- Square cards with gradient backgrounds
- Color-coded metrics (blue/purple/green)
- Hover lift effect and pulse animations
- System font stack for better readability"
```

---

### Task 2: Update Health Display JavaScript

**Files:**
- Modify: `src/main.js:596-619` (updateHealthDisplay method)

**Step 1: Read current updateHealthDisplay method**

```bash
# Review lines 596-619 in src/main.js
```

**Step 2: Add bitrate Mbps conversion**

Find `updateHealthDisplay()` method and update bitrate display logic:

```javascript
updateHealthDisplay() {
  const container = document.getElementById("health-stats-container");
  if (!container) return;

  this.healthStats.forEach((health, cameraId) => {
    const card = container.querySelector(`[data-camera-id="${cameraId}"]`);
    if (!card) return;

    const fpsEl = card.querySelector('[data-metric="fps"]');
    const bitrateEl = card.querySelector('[data-metric="bitrate"]');
    const uptimeEl = card.querySelector('[data-metric="uptime"]');

    // FPS with 1 decimal
    if (fpsEl) {
      const newFps = health.fps.toFixed(1);
      if (fpsEl.textContent !== newFps) {
        fpsEl.textContent = newFps;
        fpsEl.classList.add('updated');
        setTimeout(() => fpsEl.classList.remove('updated'), 300);
      }
    }

    // Bitrate with auto Mbps conversion
    if (bitrateEl) {
      let bitrateText;
      if (health.bitrate_kbps >= 1000) {
        bitrateText = `${(health.bitrate_kbps / 1000).toFixed(2)} Mbps`;
      } else {
        bitrateText = `${health.bitrate_kbps.toFixed(0)} kbps`;
      }
      if (bitrateEl.textContent !== bitrateText) {
        bitrateEl.textContent = bitrateText;
        bitrateEl.classList.add('updated');
        setTimeout(() => bitrateEl.classList.remove('updated'), 300);
      }
    }

    // Uptime simplified (hours + minutes)
    if (uptimeEl) {
      const hours = Math.floor(health.uptime_secs / 3600);
      const mins = Math.floor((health.uptime_secs % 3600) / 60);
      const uptimeText = `${hours}h ${mins}m`;
      if (uptimeEl.textContent !== uptimeText) {
        uptimeEl.textContent = uptimeText;
        uptimeEl.classList.add('updated');
        setTimeout(() => uptimeEl.classList.remove('updated'), 300);
      }
    }
  });
}
```

**Step 3: Update injectHealthSection to use data attributes**

Find `injectHealthSection()` method and update health metric HTML:

```javascript
injectHealthSection() {
  const panel = document.getElementById("settings");
  if (!panel) return;

  // Remove existing health section
  const existingHealth = panel.querySelector(".health-section");
  if (existingHealth) existingHealth.remove();

  const healthHTML = `
    <div class="settings-section health-section">
      <h3>Stream Health</h3>
      <div id="health-stats-container">
        ${this.cameras.map(cam => `
          <div class="health-card" data-camera-id="${cam.id}">
            <div class="health-camera-name">${cam.name}</div>
            <div class="health-metrics">
              <div class="health-metric" data-type="fps">
                <span class="health-label">FPS</span>
                <span class="health-value" data-metric="fps">--</span>
              </div>
              <div class="health-metric" data-type="bitrate">
                <span class="health-label">Bitrate</span>
                <span class="health-value" data-metric="bitrate">--</span>
              </div>
              <div class="health-metric" data-type="uptime">
                <span class="health-label">Uptime</span>
                <span class="health-value" data-metric="uptime">--</span>
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  // Insert at top of settings panel
  panel.insertAdjacentHTML('afterbegin', healthHTML);
  this.updateHealthDisplay();
}
```

**Step 4: Test health display updates**

Run:
```bash
npm run tauri dev
```

Test:
1. Open settings
2. Verify FPS shows 1 decimal
3. Verify bitrate converts to Mbps when >1000
4. Verify uptime shows "Xh Ym" format
5. Verify pulse animation on value changes

Expected: Metrics display correctly with animations

**Step 5: Commit JavaScript changes**

```bash
git add src/main.js
git commit -m "feat(health): add Mbps conversion and pulse animations

- Auto-convert bitrate to Mbps when ≥1000 kbps
- Simplify uptime to hours + minutes format
- Add pulse animation on value changes
- Use data attributes for metric type styling"
```

---

## Phase 2: PIP Presets System

### Task 3: Add PIP Data Models to Backend

**Files:**
- Modify: `src-tauri/src/lib.rs:18-60` (add after Camera struct)

**Step 1: Add PipOverlay and PipConfig structs**

After `Camera` struct (around line 18), add:

```rust
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PipOverlay {
    pub camera_id: String,
    pub corner: String,      // "TL", "TR", "BL", "BR"
    pub size_percent: u8,    // 10-40
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PipConfig {
    pub main_camera_id: String,
    pub overlays: Vec<PipOverlay>,
}
```

**Step 2: Add pip_config to LayoutConfig**

Find `LayoutConfig` struct and add field:

```rust
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct LayoutConfig {
    pub name: String,
    pub layout_type: String, // "grid", "pip"
    pub positions: Vec<CameraPosition>, // Deprecated, kept for migration
    #[serde(default)]
    pub pip_config: Option<PipConfig>,
}
```

**Step 3: Run cargo check**

```bash
cd src-tauri
cargo check
```

Expected: Compiles successfully

**Step 4: Commit backend data models**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(pip): add PIP preset data models

- Add PipOverlay struct (corner + size_percent)
- Add PipConfig struct (main camera + overlays)
- Extend LayoutConfig with pip_config field"
```

---

### Task 4: Implement PIP Rendering Logic

**Files:**
- Modify: `src/main.js` (add renderPipLayout method)

**Step 1: Add renderPipLayout method**

Add after `renderGridLayout` method:

```javascript
renderPipLayout(grid, layout) {
  grid.style.display = "block";
  grid.style.position = "relative";
  grid.innerHTML = "";

  if (!layout.pip_config) {
    console.error("PIP layout missing pip_config, falling back to grid");
    this.layoutMode = "grid";
    this.renderGridLayout(grid);
    return;
  }

  const { main_camera_id, overlays } = layout.pip_config;

  // Render main camera (full screen)
  const mainCamera = this.cameras.find(c => c.id === main_camera_id);
  if (mainCamera) {
    const mainTile = this.createCameraTile(mainCamera, this.cameras.indexOf(mainCamera));
    mainTile.style.position = "absolute";
    mainTile.style.left = "0";
    mainTile.style.top = "0";
    mainTile.style.width = "100%";
    mainTile.style.height = "100%";
    mainTile.style.zIndex = "1";
    grid.appendChild(mainTile);
  }

  // Render overlays in corners
  overlays.forEach((overlay, idx) => {
    const camera = this.cameras.find(c => c.id === overlay.camera_id);
    if (!camera) return;

    const tile = this.createCameraTile(camera, this.cameras.indexOf(camera));
    tile.style.position = "absolute";
    tile.style.width = `${overlay.size_percent}%`;
    tile.style.height = `${overlay.size_percent}%`;
    tile.style.zIndex = `${10 + idx}`;

    // Calculate position based on corner
    switch (overlay.corner) {
      case "TL": // Top-Left
        tile.style.left = "2%";
        tile.style.top = "2%";
        break;
      case "TR": // Top-Right
        tile.style.right = "2%";
        tile.style.top = "2%";
        break;
      case "BL": // Bottom-Left
        tile.style.left = "2%";
        tile.style.bottom = "2%";
        break;
      case "BR": // Bottom-Right
        tile.style.right = "2%";
        tile.style.bottom = "2%";
        break;
    }

    grid.appendChild(tile);
  });
}
```

**Step 2: Update render() method to call renderPipLayout**

Find `render()` method and update:

```javascript
render() {
  const grid = document.getElementById("camera-grid");
  grid.dataset.layout = this.layoutMode;

  if (this.layoutMode === "grid") {
    this.renderGridLayout(grid);
  } else if (this.layoutMode === "pip") {
    const layout = this.layouts.find(l => l.name === this.activeLayout);
    this.renderPipLayout(grid, layout);
  } else if (this.layoutMode === "custom") {
    // Fallback legacy custom layouts to grid
    console.warn("Legacy custom layout detected, falling back to grid");
    this.layoutMode = "grid";
    this.renderGridLayout(grid);
  }
}
```

**Step 3: Test PIP rendering manually**

Create test PIP layout in browser console:
```javascript
app.layouts.push({
  name: "Test PIP",
  layout_type: "pip",
  pip_config: {
    main_camera_id: app.cameras[0].id,
    overlays: [
      { camera_id: app.cameras[1].id, corner: "TR", size_percent: 25 }
    ]
  }
});
app.activeLayout = "Test PIP";
app.layoutMode = "pip";
app.render();
```

Expected: Main camera fills screen, overlay appears in top-right corner

**Step 4: Commit PIP rendering**

```bash
git add src/main.js
git commit -m "feat(pip): implement PIP layout rendering engine

- Add renderPipLayout method with corner positioning
- Calculate positions based on corner (TL/TR/BL/BR)
- Main camera full screen with overlays on top
- Fallback legacy custom layouts to grid mode"
```

---

### Task 5: Build PIP Editor UI

**Files:**
- Modify: `src/main.js` (update openLayoutEditor)
- Modify: `src/style.css` (add PIP editor styles)

**Step 1: Simplify openLayoutEditor UI**

Replace `openLayoutEditor()` method:

```javascript
openLayoutEditor() {
  const overlay = document.getElementById("layout-editor-overlay");
  const panel = document.getElementById("layout-editor-panel");

  overlay.style.display = "flex";

  const currentLayout = this.layouts.find(l => l.name === this.activeLayout) || {
    name: "New Layout",
    layout_type: "grid",
    positions: [],
    pip_config: null
  };

  panel.innerHTML = `
    <h2>Layout Editor</h2>

    <div class="layout-controls">
      <label>
        Layout Name:
        <input type="text" id="layout-name-input" value="${currentLayout.name}" />
      </label>

      <label>Layout Type:</label>
      <div class="radio-group">
        <label class="radio-option">
          <input type="radio" name="layout-type" value="grid"
            ${currentLayout.layout_type === "grid" ? "checked" : ""} />
          <span>Auto Grid</span>
        </label>
        <label class="radio-option">
          <input type="radio" name="layout-type" value="pip"
            ${currentLayout.layout_type === "pip" ? "checked" : ""} />
          <span>Picture-in-Picture</span>
        </label>
      </div>
    </div>

    <div id="pip-config" style="display: ${currentLayout.layout_type === "pip" ? "block" : "none"};">
      ${this.renderPipConfig(currentLayout)}
    </div>

    <div class="panel-actions">
      <button id="save-layout-btn" class="btn-primary">Save Layout</button>
      <button id="apply-layout-btn" class="btn-primary">Apply Now</button>
      <button id="close-layout-editor-btn" class="btn-secondary">Close</button>
    </div>
  `;

  // Bind events
  panel.querySelectorAll('input[name="layout-type"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      const pipConfig = document.getElementById('pip-config');
      pipConfig.style.display = e.target.value === "pip" ? "block" : "none";
    });
  });

  document.getElementById("close-layout-editor-btn").onclick = () => {
    overlay.style.display = "none";
  };

  document.getElementById("save-layout-btn").onclick = () => this.saveLayout();
  document.getElementById("apply-layout-btn").onclick = () => this.applyLayout();
}
```

**Step 2: Add renderPipConfig method**

```javascript
renderPipConfig(layout) {
  const pipConfig = layout.pip_config || {
    main_camera_id: this.cameras[0]?.id || "",
    overlays: []
  };

  return `
    <h3>Picture-in-Picture Configuration</h3>

    <label>
      Main Camera (Full Screen):
      <select id="pip-main-camera">
        ${this.cameras.map(cam => `
          <option value="${cam.id}" ${cam.id === pipConfig.main_camera_id ? "selected" : ""}>
            ${cam.name}
          </option>
        `).join('')}
      </select>
    </label>

    <h4>Overlays</h4>
    <div id="pip-overlays">
      ${pipConfig.overlays.map((overlay, idx) => this.renderPipOverlay(overlay, idx)).join('')}
    </div>

    <button id="add-pip-overlay-btn" class="btn-secondary">+ Add Overlay</button>
  `;
}
```

**Step 3: Add renderPipOverlay method**

```javascript
renderPipOverlay(overlay, index) {
  const availableCameras = this.cameras.filter(c =>
    c.id === overlay.camera_id ||
    !this.getUsedOverlayCameraIds().includes(c.id)
  );

  return `
    <div class="pip-overlay-config" data-index="${index}">
      <label>
        Camera:
        <select class="pip-overlay-camera" data-index="${index}">
          ${availableCameras.map(cam => `
            <option value="${cam.id}" ${cam.id === overlay.camera_id ? "selected" : ""}>
              ${cam.name}
            </option>
          `).join('')}
        </select>
      </label>

      <label>
        Corner:
        <div class="corner-selector">
          ${["TL", "TR", "BL", "BR"].map(corner => `
            <button type="button" class="corner-btn ${overlay.corner === corner ? "active" : ""}"
              data-corner="${corner}" data-index="${index}">
              ${this.getCornerIcon(corner)}
            </button>
          `).join('')}
        </div>
      </label>

      <label>
        Size:
        <select class="pip-overlay-size" data-index="${index}">
          ${[10, 15, 20, 25, 30, 35, 40].map(size => `
            <option value="${size}" ${overlay.size_percent === size ? "selected" : ""}>
              ${size}%
            </option>
          `).join('')}
        </select>
      </label>

      <button type="button" class="btn-danger btn-small" onclick="app.removeOverlay(${index})">
        Remove
      </button>
    </div>
  `;
}
```

**Step 4: Add helper methods**

```javascript
getCornerIcon(corner) {
  const icons = {
    TL: "↖",
    TR: "↗",
    BL: "↙",
    BR: "↘"
  };
  return icons[corner] || corner;
}

getUsedOverlayCameraIds() {
  // Get camera IDs already used in overlays
  const overlays = Array.from(document.querySelectorAll('.pip-overlay-config'));
  return overlays.map(el => {
    const select = el.querySelector('.pip-overlay-camera');
    return select?.value;
  }).filter(Boolean);
}

removeOverlay(index) {
  const overlayEl = document.querySelector(`.pip-overlay-config[data-index="${index}"]`);
  if (overlayEl) overlayEl.remove();
}
```

**Step 5: Add PIP editor CSS**

Add to `src/style.css`:

```css
/* PIP Editor */
.radio-group {
  display: flex;
  gap: 1rem;
  margin: 0.5rem 0;
}

.radio-option {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
}

#pip-config {
  margin-top: 1.5rem;
  padding: 1rem;
  background: #2a2a2a;
  border-radius: 6px;
}

#pip-config h3 {
  margin-top: 0;
  font-size: 1rem;
  color: #5eb3ff;
}

#pip-config h4 {
  margin: 1rem 0 0.5rem 0;
  font-size: 0.9rem;
  color: #999;
}

.pip-overlay-config {
  background: #1f1f1f;
  padding: 1rem;
  margin-bottom: 1rem;
  border-radius: 4px;
  border: 1px solid #444;
}

.corner-selector {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0.5rem;
  margin-top: 0.5rem;
}

.corner-btn {
  padding: 0.75rem;
  background: #2a2a2a;
  border: 2px solid #444;
  color: #fff;
  border-radius: 4px;
  cursor: pointer;
  font-size: 1.5rem;
  transition: all 0.2s;
}

.corner-btn:hover {
  border-color: #5eb3ff;
}

.corner-btn.active {
  background: #5eb3ff;
  border-color: #5eb3ff;
  color: #000;
}

#add-pip-overlay-btn {
  width: 100%;
  margin-top: 0.5rem;
}
```

**Step 6: Test PIP editor**

Run:
```bash
npm run tauri dev
```

Test:
1. Click Layout Editor button
2. Select "Picture-in-Picture"
3. Choose main camera
4. Add overlay, select corner and size
5. Click Apply
6. Verify PIP renders correctly

Expected: PIP editor functional, layout applies correctly

**Step 7: Commit PIP editor UI**

```bash
git add src/main.js src/style.css
git commit -m "feat(pip): add visual PIP editor with corner presets

- Simplified layout editor with Grid/PIP radio buttons
- Main camera dropdown for full-screen background
- Overlay configuration with corner selector buttons
- Size percentage dropdown (10-40%)
- Visual corner selector with arrow icons
- Add/remove overlays dynamically"
```

---

### Task 6: Implement Save/Apply Layout Logic

**Files:**
- Modify: `src/main.js` (add saveLayout and applyLayout methods)

**Step 1: Add saveLayout method**

```javascript
async saveLayout() {
  const name = document.getElementById("layout-name-input")?.value.trim();
  if (!name) {
    alert("Please enter a layout name");
    return;
  }

  const layoutType = document.querySelector('input[name="layout-type"]:checked')?.value;

  let newLayout = {
    name,
    layout_type: layoutType,
    positions: [], // Deprecated but kept for migration
    pip_config: null
  };

  if (layoutType === "pip") {
    const mainCameraId = document.getElementById("pip-main-camera")?.value;

    const overlayEls = document.querySelectorAll('.pip-overlay-config');
    const overlays = Array.from(overlayEls).map(el => {
      const index = el.dataset.index;
      const cameraId = el.querySelector('.pip-overlay-camera')?.value;
      const corner = el.querySelector('.corner-btn.active')?.dataset.corner || "TL";
      const sizePercent = parseInt(el.querySelector('.pip-overlay-size')?.value || "25");

      return {
        camera_id: cameraId,
        corner,
        size_percent: sizePercent
      };
    }).filter(o => o.camera_id);

    // Check for corner conflicts
    const corners = overlays.map(o => o.corner);
    const duplicates = corners.filter((c, i) => corners.indexOf(c) !== i);
    if (duplicates.length > 0) {
      alert(`Corner conflict: ${duplicates[0]} is used multiple times. Each corner can only have one overlay.`);
      return;
    }

    newLayout.pip_config = {
      main_camera_id: mainCameraId,
      overlays
    };
  }

  // Update or add layout
  const existingIdx = this.layouts.findIndex(l => l.name === name);
  if (existingIdx >= 0) {
    this.layouts[existingIdx] = newLayout;
  } else {
    this.layouts.push(newLayout);
  }

  // Save to backend
  const config = await invoke("get_config");
  config.layouts = this.layouts;
  await invoke("save_config", { config });

  alert(`Layout "${name}" saved successfully!`);
}
```

**Step 2: Add applyLayout method**

```javascript
async applyLayout() {
  await this.saveLayout();

  const name = document.getElementById("layout-name-input")?.value.trim();
  this.activeLayout = name;

  const layout = this.layouts.find(l => l.name === name);
  this.layoutMode = layout?.layout_type || "grid";

  // Save active layout to config
  const config = await invoke("get_config");
  config.active_layout = this.activeLayout;
  await invoke("save_config", { config });

  // Re-render with new layout
  this.render();

  // Close editor
  document.getElementById("layout-editor-overlay").style.display = "none";
}
```

**Step 3: Add addOverlay method for "Add Overlay" button**

```javascript
addOverlay() {
  const overlaysContainer = document.getElementById("pip-overlays");
  if (!overlaysContainer) return;

  const currentOverlays = overlaysContainer.querySelectorAll('.pip-overlay-config').length;
  const availableCamera = this.cameras.find(c =>
    !this.getUsedOverlayCameraIds().includes(c.id)
  );

  if (!availableCamera) {
    alert("All cameras are already assigned");
    return;
  }

  const newOverlay = {
    camera_id: availableCamera.id,
    corner: "BR",
    size_percent: 25
  };

  const overlayHTML = this.renderPipOverlay(newOverlay, currentOverlays);
  overlaysContainer.insertAdjacentHTML('beforeend', overlayHTML);

  // Bind corner button clicks
  this.bindCornerButtons();
}

bindCornerButtons() {
  document.querySelectorAll('.corner-btn').forEach(btn => {
    btn.onclick = (e) => {
      e.preventDefault();
      const index = btn.dataset.index;
      const corner = btn.dataset.corner;

      // Remove active from siblings
      const siblings = btn.parentElement.querySelectorAll('.corner-btn');
      siblings.forEach(s => s.classList.remove('active'));

      // Add active to clicked
      btn.classList.add('active');
    };
  });
}
```

**Step 4: Update openLayoutEditor to bind add overlay button**

Add to end of `openLayoutEditor()`:

```javascript
document.getElementById("add-pip-overlay-btn")?.addEventListener('click', () => {
  this.addOverlay();
});

this.bindCornerButtons();
```

**Step 5: Test save and apply**

Run:
```bash
npm run tauri dev
```

Test:
1. Create new PIP layout
2. Configure main camera and overlays
3. Click Save
4. Click Apply
5. Verify layout saves to config and renders correctly
6. Restart app, verify layout persists

Expected: Layouts save and apply correctly

**Step 6: Commit save/apply logic**

```bash
git add src/main.js
git commit -m "feat(pip): implement save and apply layout logic

- Add saveLayout method with corner conflict detection
- Add applyLayout method to activate layouts
- Add addOverlay method for dynamic overlay creation
- Bind corner button clicks for selection
- Validate PIP config before saving
- Persist layouts to backend config"
```

---

## Phase 3: Remove Custom Grid Complexity

### Task 7: Remove Custom Grid Code

**Files:**
- Modify: `src-tauri/src/lib.rs` (remove CameraPosition)
- Modify: `src/main.js` (remove custom layout code)
- Modify: `src/index.html` (remove unused UI)
- Modify: `src/style.css` (remove unused styles)

**Step 1: Remove CameraPosition struct from backend**

In `src-tauri/src/lib.rs`, find and delete `CameraPosition` struct (if it exists as standalone):

```rust
// DELETE THIS:
// #[derive(Serialize, Deserialize, Clone, Debug)]
// pub struct CameraPosition {
//     pub camera_id: String,
//     pub x: f32,
//     pub y: f32,
//     pub width: f32,
//     pub height: f32,
//     pub z_index: i32,
// }
```

Note: Keep `positions: Vec<CameraPosition>` in LayoutConfig for backward compatibility with existing configs, but mark as deprecated in comments.

**Step 2: Remove renderCustomLayout method**

In `src/main.js`, find and delete `renderCustomLayout()` method entirely.

**Step 3: Remove custom grid UI generation code**

Delete these methods from `src/main.js`:
- `renderCameraPositionEditors()` (if exists)
- `handleLayoutTypeChange()` (if exists)
- Any grid builder slider code

**Step 4: Clean up layout editor HTML**

In `src/index.html`, verify layout editor overlay only contains simplified UI (already done in Task 5).

**Step 5: Remove unused CSS**

In `src/style.css`, find and delete:
- `.camera-position-editor` styles
- `.position-inputs` styles
- `.layout-preview` styles (if unused)
- Any grid builder specific styles

**Step 6: Update render() to remove custom handling**

Already done in Task 4 - verify `render()` only handles "grid" and "pip", with custom layouts falling back to grid.

**Step 7: Run cargo check**

```bash
cd src-tauri
cargo check
```

Expected: Compiles successfully

**Step 8: Test that grid and PIP still work**

Run:
```bash
npm run tauri dev
```

Test:
1. Create auto grid layout - works
2. Create PIP layout - works
3. No errors in console
4. Layout editor only shows Grid/PIP options

Expected: Both modes work, no custom layout option visible

**Step 9: Commit cleanup**

```bash
git add src-tauri/src/lib.rs src/main.js src/index.html src/style.css
git commit -m "refactor(layout): remove custom grid complexity

- Remove renderCustomLayout method
- Remove custom grid editor UI code
- Clean up unused CSS styles
- Keep CameraPosition for backward compatibility
- Simplify to Grid + PIP only"
```

---

### Task 8: Add Layout Migration Warning

**Files:**
- Modify: `src/main.js` (add init migration check)

**Step 1: Add legacy layout detection in init()**

In `init()` method, after loading layouts:

```javascript
async init() {
  try {
    const config = await invoke("get_config");
    this.cameras = config.cameras;
    this.shuffleIntervalSecs = config.shuffle_interval_secs;
    this.showStatusDots = config.show_status_dots !== false;
    this.showCameraNames = config.show_camera_names !== false;
    this.quality = config.quality || "medium";
    this.apiPort = config.api_port || 8090;

    this.layouts = config.layouts || [];
    this.activeLayout = config.active_layout || "Default Grid";

    // Migrate legacy layouts
    this.migrateLegacyLayouts();

    // ... rest of init
  }
}
```

**Step 2: Add migrateLegacyLayouts method**

```javascript
migrateLegacyLayouts() {
  let hasLegacy = false;

  this.layouts = this.layouts.map(layout => {
    if (layout.layout_type === "custom") {
      hasLegacy = true;
      console.warn(`Legacy custom layout "${layout.name}" migrated to grid`);
      return {
        ...layout,
        layout_type: "grid",
        pip_config: null
      };
    }

    // Migrate old PIP layouts with positions to new format
    if (layout.layout_type === "pip" && !layout.pip_config && layout.positions?.length > 0) {
      hasLegacy = true;
      console.warn(`Legacy PIP layout "${layout.name}" needs reconfiguration`);
      return {
        ...layout,
        pip_config: null // User will need to reconfigure
      };
    }

    return layout;
  });

  if (hasLegacy && this.layouts.length > 0) {
    // Show one-time notification
    if (!localStorage.getItem('stageview_migration_notified')) {
      setTimeout(() => {
        alert("StageView has been simplified! Legacy custom layouts have been converted to Auto Grid. PIP layouts may need reconfiguration.");
        localStorage.setItem('stageview_migration_notified', 'true');
      }, 1000);
    }

    // Save migrated layouts
    this.saveMigratedLayouts();
  }
}

async saveMigratedLayouts() {
  try {
    const config = await invoke("get_config");
    config.layouts = this.layouts;
    await invoke("save_config", { config });
  } catch (e) {
    console.error("Failed to save migrated layouts:", e);
  }
}
```

**Step 3: Test migration**

Create a test custom layout in browser console:
```javascript
app.layouts.push({
  name: "Old Custom",
  layout_type: "custom",
  positions: [{camera_id: app.cameras[0].id, x: 0, y: 0, width: 1, height: 1, z_index: 1}]
});
```

Reload page and verify:
- Layout converted to "grid"
- Alert shown about migration
- No errors

**Step 4: Commit migration code**

```bash
git add src/main.js
git commit -m "feat(migration): add legacy layout migration

- Auto-convert custom layouts to grid
- Detect old PIP layouts without pip_config
- Show one-time notification to users
- Save migrated layouts automatically"
```

---

### Task 9: Update Documentation

**Files:**
- Modify: `README.md` (update features section)
- Modify: `docs/TESTING.md` (update test cases)

**Step 1: Update README features**

In `README.md`, find "Custom Layouts" section and replace with:

```markdown
### Advanced Features
- **Auto-Reconnection** - Streams automatically reconnect with exponential backoff
- **Stream Health Monitoring** - Real-time FPS, bitrate, uptime with modern UI
- **Auto Grid Layout** - Automatically arranges cameras in optimal square grid
- **Picture-in-Picture** - Main camera with corner overlays (TL/TR/BL/BR) at custom sizes
- **Camera Presets** - Save and load camera configurations instantly
- **Drag-and-Drop** - Reorder cameras in grid mode
- **Multi-Monitor** - Window position/size persists across sessions
```

**Step 2: Update layout section**

Add new "Layout Modes" section:

```markdown
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
```

**Step 3: Update TESTING.md**

In `docs/TESTING.md`, update Custom Layouts section:

```markdown
### Layout Modes
- [ ] Auto Grid arranges cameras in square grid automatically
- [ ] PIP shows main camera full-screen
- [ ] PIP overlays position correctly in corners (TL/TR/BL/BR)
- [ ] PIP overlay sizes scale correctly (10-40%)
- [ ] Corner conflict detection prevents duplicates
- [ ] Legacy custom layouts migrate to grid automatically
- [ ] Migration notification shown once
```

**Step 4: Commit documentation**

```bash
git add README.md docs/TESTING.md
git commit -m "docs: update documentation for simplified layouts

- Update README with Auto Grid and PIP descriptions
- Add PIP setup instructions
- Update testing checklist for new layout system
- Remove references to custom grid complexity"
```

---

### Task 10: Final Testing and Refinement

**Files:**
- All modified files

**Step 1: Run full test suite**

```bash
npm run tauri dev
```

Test checklist:
1. **Stream Health:**
   - [ ] Square cards, 2 per row
   - [ ] Metrics color-coded (blue/purple/green)
   - [ ] Bitrate converts to Mbps when ≥1000
   - [ ] Uptime shows "Xh Ym" format
   - [ ] Pulse animation on value changes
   - [ ] Hover effect on cards

2. **PIP Layout:**
   - [ ] Main camera fills screen
   - [ ] Overlays position in correct corners
   - [ ] Size percentages accurate
   - [ ] Corner conflict detection works
   - [ ] Add/remove overlays functional
   - [ ] Save and apply works

3. **Auto Grid:**
   - [ ] Still works as before
   - [ ] No regression

4. **Migration:**
   - [ ] Legacy layouts convert to grid
   - [ ] Notification shown once
   - [ ] No errors or warnings

**Step 2: Fix any issues found**

If bugs found, create fix commits immediately.

**Step 3: Create final polish commit**

If any minor refinements needed:

```bash
git add <files>
git commit -m "polish(ux): final refinements and bug fixes"
```

**Step 4: Tag release**

```bash
git tag -a v1.1.0 -m "StageView v1.1.0 - UX Polish Release

Features:
- Modern stream health UI with color-coded metrics
- Simplified PIP with corner presets
- Removed custom grid complexity
- Auto-migration of legacy layouts
- Improved visual design throughout"
```

**Step 5: Verify release**

```bash
git log --oneline -10
git tag
```

Expected: All commits present, v1.1.0 tag created

---

## Summary

**Total Tasks: 10**
**Estimated Commits: ~15**

### Task Breakdown:
1. **Task 1:** Redesign health CSS
2. **Task 2:** Update health JavaScript
3. **Task 3:** Add PIP backend models
4. **Task 4:** Implement PIP rendering
5. **Task 5:** Build PIP editor UI
6. **Task 6:** Implement save/apply logic
7. **Task 7:** Remove custom grid code
8. **Task 8:** Add migration warning
9. **Task 9:** Update documentation
10. **Task 10:** Final testing and release

### Key Improvements:
- Stream health UI: Modern, compact, visually exciting
- PIP system: Simple corner + size presets (<30 sec setup)
- Code cleanup: ~300 lines removed
- User experience: Intuitive, professional, simplified

**Ready for execution with subagent-driven development.**
