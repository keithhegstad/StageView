// ── StageView ────────────────────────────────────────────────────────────────
// Lightweight multi-camera grid viewer with burn-in protection.
// Streams are decoded by ffmpeg in the Rust backend and pushed to the
// frontend as base64 JPEG frames via Tauri events — no HTTP proxy needed.

function waitForTauri(timeout = 5000) {
  return new Promise((resolve, reject) => {
    if (window.__TAURI__) return resolve();
    const start = Date.now();
    const check = setInterval(() => {
      if (window.__TAURI__) { clearInterval(check); resolve(); }
      else if (Date.now() - start > timeout) { clearInterval(check); reject(new Error("Tauri API not available")); }
    }, 50);
  });
}

function invoke(cmd, args) {
  return window.__TAURI__.core.invoke(cmd, args);
}

function listen(event, callback) {
  return window.__TAURI__.event.listen(event, callback);
}

function getCurrentWindow() {
  return window.__TAURI__.window.getCurrentWindow();
}

class StageView {
  constructor() {
    this.cameras = [];
    this.displayOrder = []; // array of indices for grid shuffle (separate from insertion order)
    this.shuffleIntervalSecs = 900;
    this.showStatusDots = true;
    this.showCameraNames = true;
    this.quality = "medium";
    this.apiPort = 8090;
    this.shuffleTimerId = null;
    this.countdownId = null;
    this.nextShuffleAt = 0;
    this.unlistenFrame = null;
    this.unlistenStatus = null;
    this.unlistenCommand = null;
    this.soloIndex = null; // null = grid view, number = 1-based solo index
    this.pixelShiftIndex = 0; // cycles through shift positions for burn-in protection
    this._outsideClickHandler = null; // single handler for camera menu outside clicks
    this.layouts = [];
    this.activeLayout = null;
    this.layoutMode = "grid"; // "grid", "pip"
    this.presets = [];
    this.draggedTile = null;
    this.dragStartIndex = null;
    this.previousHealthValues = new Map(); // stores previous health values for change detection
    this.cameraHealthStates = new Map(); // Track health per camera
    this.healthCheckInterval = null;
    this.init();
  }

  // ── Initialization ──────────────────────────────────────────────────────

  async init() {
    try {
      const config = await invoke("get_config");
      this.cameras = config.cameras;
      this.displayOrder = this.cameras.map((_, i) => i); // initialize display order
      this.shuffleIntervalSecs = config.shuffle_interval_secs;
      this.showStatusDots = config.show_status_dots !== false;
      this.showCameraNames = config.show_camera_names !== false;
      this.quality = config.quality || "medium";
      this.apiPort = config.api_port || 8090;
      this.layouts = config.layouts || [];
      this.activeLayout = config.active_layout || "Default Grid";
      this.presets = config.presets || [];

      // Migrate legacy layouts
      this.migrateLegacyLayouts();

      // Determine layout mode
      const currentLayout = this.layouts.find(l => l.name === this.activeLayout);
      this.layoutMode = currentLayout?.layout_type || "grid";

      // Listen for frame events from the Rust backend
      this.unlistenFrame = await listen("camera-frame", (event) => {
        const { camera_id, data } = event.payload;
        const img = document.querySelector(
          `[data-id="${camera_id}"] img`
        );
        if (img) {
          img.src = `data:image/jpeg;base64,${data}`;
          if (!img.classList.contains("has-frame")) {
            img.classList.add("has-frame");
          }
        }
      });

      // Listen for camera status events (online / offline / error / connecting / reconnecting)
      this.unlistenStatus = await listen("camera-status", (event) => {
        const { camera_id, status } = event.payload;
        const tile = document.querySelector(`[data-id="${camera_id}"]`);
        if (!tile) return;
        const spinner = tile.querySelector(".loading-spinner");
        const statusEl = tile.querySelector(".camera-status");

        if (status === "online") {
          spinner.style.display = "none";
          statusEl.classList.remove("offline", "reconnecting");
        } else if (status === "connecting" || status.startsWith("reconnecting")) {
          spinner.style.display = "";
          statusEl.classList.add("reconnecting");
          statusEl.classList.remove("offline");
        } else {
          // "error" or "offline"
          spinner.style.display = "none";
          statusEl.classList.add("offline");
          statusEl.classList.remove("reconnecting");
        }
      });

      // Listen for remote commands from the API server
      this.unlistenCommand = await listen("remote-command", (event) => {
        const { command, index } = event.payload;
        if (command === "solo" && index >= 1 && index <= this.cameras.length) {
          this.soloCamera(index);
        } else if (command === "grid") {
          this.exitSolo();
        }
      });

      // Listen for stream health updates
      this.healthStats = new Map(); // camera_id -> health object
      this.unlistenHealth = await listen("stream-health", (event) => {
        const { camera_id, health } = event.payload;
        this.healthStats.set(camera_id, health);
        this.updateHealthDisplay();
      });

      this.render();
      this.startShuffleTimer();

      // Tell the backend to start ffmpeg for each camera
      if (this.cameras.length > 0) {
        await invoke("start_streams");
      }

      // Initialize health states for all cameras
      this.cameras.forEach(cam => {
        this.cameraHealthStates.set(cam.id, 'offline');
      });

      // Start health monitoring
      this.startHealthMonitoring();
    } catch (err) {
      console.error("StageView init failed:", err);
      this.render();
    }

    this.bindUIEvents();
    this.bindKeys();
    this.updateToolbar();
    this.setupWindowStatePersistence();
  }

  // ── Legacy Layout Migration ─────────────────────────────────────────────

  migrateLegacyLayouts() {
    let hasLegacy = false;

    this.layouts = this.layouts.map(layout => {
      // Migrate custom layouts to grid
      if (layout.layout_type === "custom") {
        hasLegacy = true;
        console.warn(`Legacy custom layout "${layout.name}" migrated to grid`);
        return {
          ...layout,
          layout_type: "grid",
          pip_config: null
        };
      }

      // Detect old PIP layouts with positions instead of pip_config
      if (layout.layout_type === "pip" && !layout.pip_config && layout.positions?.length > 0) {
        hasLegacy = true;
        console.warn(`Legacy PIP layout "${layout.name}" needs reconfiguration`);
        return {
          ...layout,
          pip_config: null
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

  // ── UI Event Binding ───────────────────────────────────────────────────

  bindUIEvents() {
    // Empty state
    document.getElementById('empty-add-camera').addEventListener('click', () => this.openSettings());

    // Toolbar buttons
    document.getElementById('camera-menu-btn').addEventListener('click', () => this.toggleCameraMenu());
    document.getElementById('fullscreen-btn').addEventListener('click', () => this.toggleFullscreen());
    document.getElementById('settings-btn').addEventListener('click', () => this.openSettings());

    // Camera menu grid view
    document.getElementById('grid-view-btn').addEventListener('click', () => {
      this.exitSolo();
      this.closeCameraMenu();
    });

    // Settings panel
    document.getElementById('settings-overlay').addEventListener('click', () => this.closeSettings());
    document.getElementById('settings-close-btn').addEventListener('click', () => this.closeSettings());
    document.getElementById('add-camera-btn').addEventListener('click', () => this.addCameraField());
    document.getElementById('save-settings-btn').addEventListener('click', () => this.saveSettings());

    // Layout editor
    document.getElementById('layout-editor-btn').addEventListener('click', () => this.openLayoutEditor());
    document.getElementById('layout-editor-overlay').addEventListener('click', (e) => {
      if (e.target.id === 'layout-editor-overlay') this.closeLayoutEditor();
    });
    document.getElementById('close-layout-editor-btn').addEventListener('click', () => this.closeLayoutEditor());
    document.getElementById('save-layout-btn').addEventListener('click', () => this.saveCurrentLayout());
    document.getElementById('apply-layout-btn').addEventListener('click', () => this.applyCurrentLayout());
    document.getElementById('layout-type-select').addEventListener('change', (e) => this.handleLayoutTypeChange(e.target.value));

    // PIP editor event delegation (single listener for all dynamically added buttons)
    const pipContainer = document.getElementById('layout-camera-list');
    if (pipContainer) {
      pipContainer.addEventListener('click', (e) => {
        if (e.target.id === 'add-pip-overlay') {
          this.addPipOverlay();
        }
        if (e.target.classList.contains('pip-overlay-remove')) {
          const index = parseInt(e.target.closest('.pip-overlay-item').dataset.overlayIndex);
          this.removePipOverlay(index);
        }
        if (e.target.matches('.corner-selector button')) {
          const overlayIndex = parseInt(e.target.closest('.pip-overlay-item').dataset.overlayIndex);
          const corner = e.target.dataset.corner;
          this.selectCorner(overlayIndex, corner);
        }
      });

      // Main camera selection change listener
      pipContainer.addEventListener('change', (e) => {
        if (e.target.id === 'pip-main-camera') {
          this.validateMainCameraSelection();
        }
      });
    }
  }

  // ── Grid Rendering ─────────────────────────────────────────────────────

  render() {
    const grid = document.getElementById("grid");
    const empty = document.getElementById("empty-state");

    if (this.cameras.length === 0) {
      grid.innerHTML = "";
      grid.style.gridTemplateColumns = "";
      empty.classList.remove("hidden");
      return;
    }

    empty.classList.add("hidden");

    // Set layout mode data attribute for CSS
    grid.setAttribute("data-layout", this.layoutMode);

    // Render based on layout mode
    if (this.layoutMode === "grid") {
      this.renderGridLayout(grid);
    } else if (this.layoutMode === "pip") {
      this.renderPipLayout(grid);
    } else {
      // Fallback to grid for legacy custom layouts
      this.renderGridLayout(grid);
    }
  }

  renderGridLayout(grid) {
    const cols = Math.ceil(Math.sqrt(this.cameras.length));
    const rows = Math.ceil(this.cameras.length / cols);
    grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
    grid.style.position = "";

    grid.innerHTML = this.displayOrder
      .map((index) => {
        const cam = this.cameras[index];
        return this.createCameraTile(cam, index);
      })
      .join("");

    this.bindTileEvents(grid);
  }

  renderPipLayout(grid) {
    const currentLayout = this.layouts.find(l => l.name === this.activeLayout);
    if (!currentLayout || !currentLayout.pip_config) {
      // Fallback to grid if no PIP config
      this.renderGridLayout(grid);
      return;
    }

    const pipConfig = currentLayout.pip_config;

    // For PIP layouts, use absolute positioning
    grid.style.gridTemplateColumns = "";
    grid.style.gridTemplateRows = "";
    grid.style.position = "relative";

    // Constants for PIP positioning
    const OVERLAY_MARGIN = '2%';
    const OVERLAY_BASE_Z_INDEX = 10;
    const MAIN_CAMERA_Z_INDEX = 1;
    const MIN_SIZE_PERCENT = 10;
    const MAX_SIZE_PERCENT = 40;

    // Define corner position mappings
    const positions = {
      TL: { left: OVERLAY_MARGIN, top: OVERLAY_MARGIN },
      TR: { right: OVERLAY_MARGIN, top: OVERLAY_MARGIN },
      BL: { left: OVERLAY_MARGIN, bottom: OVERLAY_MARGIN },
      BR: { right: OVERLAY_MARGIN, bottom: OVERLAY_MARGIN }
    };

    let tiles = [];

    // 1. Create main camera tile (100% width/height, z-index: 1)
    const mainCamera = this.cameras.find(c => c.id === pipConfig.main_camera_id);
    if (mainCamera) {
      const mainStyle = 'position: absolute; left: 0; top: 0; width: 100%; height: 100%; z-index: ' + MAIN_CAMERA_Z_INDEX;
      tiles.push(this.createCameraTileHTML(mainCamera, mainStyle));
    }

    // 2. Create overlay tiles for each PIP overlay
    pipConfig.overlays.forEach((overlay, idx) => {
      const overlayCamera = this.cameras.find(c => c.id === overlay.camera_id);
      if (!overlayCamera) return;

      const corner = overlay.corner;
      const cornerPos = positions[corner] || positions.BR; // Default to BR if corner not found

      // Validate and clamp size_percent to backend-enforced range
      const sizePercent = Math.max(MIN_SIZE_PERCENT, Math.min(MAX_SIZE_PERCENT, overlay.size_percent || 25));
      const size = `${sizePercent}%`;

      // Build position style using array-based approach
      const positionStyles = Object.entries(cornerPos)
        .map(([key, value]) => `${key}: ${value}`)
        .join('; ');

      const overlayStyle = `position: absolute; ${positionStyles}; width: ${size}; height: ${size}; z-index: ${OVERLAY_BASE_Z_INDEX + idx}`;
      tiles.push(this.createCameraTileHTML(overlayCamera, overlayStyle));
    });

    grid.innerHTML = tiles.join("");
    this.bindTileEvents(grid);
  }

  createCameraTileHTML(camera, styleString) {
    return `
      <div class="camera-tile" data-id="${camera.id}" style="${styleString}">
        <div class="loading-spinner"></div>
        <img />
        <div class="camera-status" style="${this.showStatusDots ? '' : 'display:none'}"></div>
        <div class="camera-label" style="${this.showCameraNames ? '' : 'display:none'}">${camera.name}</div>
      </div>
    `;
  }

  createCameraTile(cam, idx) {
    return `
      <div class="camera-tile" data-id="${cam.id}">
        <div class="loading-spinner"></div>
        <img />
        <div class="camera-status" style="${this.showStatusDots ? '' : 'display:none'}"></div>
        <div class="camera-label" style="${this.showCameraNames ? '' : 'display:none'}">${cam.name}</div>
      </div>
    `;
  }

  bindTileEvents(grid) {
    // Double-click a tile to solo it
    grid.querySelectorAll(".camera-tile").forEach((tile) => {
      tile.addEventListener("dblclick", () => {
        const camId = tile.dataset.id;
        const idx = this.cameras.findIndex((c) => c.id === camId) + 1;
        if (this.soloIndex === null) {
          this.soloCamera(idx);
        } else {
          this.exitSolo();
        }
      });

      // Add drag-and-drop for grid mode only
      if (this.layoutMode === "grid") {
        const camId = tile.dataset.id;
        const cameraIndex = this.cameras.findIndex((c) => c.id === camId);

        tile.draggable = true;
        tile.addEventListener("dragstart", (e) => this.handleDragStart(e, cameraIndex));
        tile.addEventListener("dragover", (e) => this.handleDragOver(e));
        tile.addEventListener("drop", (e) => this.handleDrop(e, cameraIndex));
        tile.addEventListener("dragend", (e) => this.handleDragEnd(e));
      }
    });
  }

  // ── Burn-in Shuffle ─────────────────────────────────────────────────────

  startShuffleTimer() {
    clearInterval(this.shuffleTimerId);
    clearInterval(this.countdownId);

    if (this.cameras.length < 2) {
      document.getElementById("shuffle-timer").textContent = "";
      return;
    }

    this.nextShuffleAt = Date.now() + this.shuffleIntervalSecs * 1000;

    this.shuffleTimerId = setInterval(() => {
      this.shuffleCameras();
      this.nextShuffleAt = Date.now() + this.shuffleIntervalSecs * 1000;
    }, this.shuffleIntervalSecs * 1000);

    this.countdownId = setInterval(() => this.updateCountdown(), 1000);
    this.updateCountdown();
  }

  updateCountdown() {
    const remaining = Math.max(
      0,
      Math.ceil((this.nextShuffleAt - Date.now()) / 1000)
    );
    const min = Math.floor(remaining / 60);
    const sec = remaining % 60;
    document.getElementById("shuffle-timer").textContent =
      `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }

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

  // ── Solo Camera Mode ────────────────────────────────────────────────────

  async soloCamera(index) {
    if (index < 1 || index > this.cameras.length) return;
    this.soloIndex = index;
    const cam = this.cameras[index - 1];

    const grid = document.getElementById("grid");

    // Hide all tiles except the solo'd one
    grid.querySelectorAll(".camera-tile").forEach((tile) => {
      if (tile.dataset.id === cam.id) {
        tile.classList.add("solo");
        tile.style.display = "";
      } else {
        tile.style.display = "none";
      }
    });

    // Switch grid to single cell
    grid.style.gridTemplateColumns = "1fr";
    grid.style.gridTemplateRows = "1fr";

    // Tell backend to stop non-solo streams (save resources)
    await invoke("solo_camera", { cameraId: cam.id });

    this.updateToolbar();

    // Reset shuffle timer for pixel refresh in solo mode
    this.startShuffleTimer();
  }

  async exitSolo() {
    if (this.soloIndex === null) return;
    this.soloIndex = null;

    const grid = document.getElementById("grid");

    // Show all tiles and remove solo class
    grid.querySelectorAll(".camera-tile").forEach((tile) => {
      tile.classList.remove("solo");
      tile.style.display = "";
    });

    // Restore grid layout
    const cols = Math.ceil(Math.sqrt(this.cameras.length));
    const rows = Math.ceil(this.cameras.length / cols);
    grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;

    // Restart all streams
    await invoke("grid_view");

    this.updateToolbar();
    this.closeCameraMenu();
    this.startShuffleTimer();
  }

  // ── Pixel Refresh (burn-in protection in solo mode) ─────────────────────

  doPixelRefresh() {
    // ── Pixel Orbiting ─────────────────────────────────────────────────
    // Shift the grid content by 1-2px in a different direction each cycle.
    // This is the industry-standard TV burn-in protection technique.
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

    // ── Gentle Noise Overlay ──────────────────────────────────────────
    // Draw a small noise tile (128×128) and tile it across the screen.
    // Very low alpha (~0.04) — barely visible, exercises all subpixels.
    const overlay = document.getElementById("pixel-refresh");
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
      imgData.data[i + 3] = 10; // ~0.04 opacity
    }
    ctx.putImageData(imgData, 0, 0);
    overlay.style.backgroundImage = `url(${canvas.toDataURL()})`;
    overlay.style.backgroundRepeat = "repeat";

    // Fade in, hold, fade out via CSS animation
    overlay.classList.add("active");
    setTimeout(() => {
      overlay.classList.remove("active");
      setTimeout(() => { overlay.style.backgroundImage = ""; }, 600);
    }, 3000);
  }

  // ── Camera Menu ─────────────────────────────────────────────────────────

  toggleCameraMenu() {
    const menu = document.getElementById('camera-menu');
    const btn = document.getElementById('camera-menu-btn');
    if (menu.classList.contains('hidden')) {
      // Populate camera list
      const camerasContainer = document.getElementById('camera-menu-cameras');
      camerasContainer.innerHTML = this.cameras.map((cam, i) => {
        const idx = i + 1;
        const isActive = this.soloIndex === idx;
        return `<button class="camera-menu-item${isActive ? ' active' : ''}" data-solo-index="${idx}">
          <div class="camera-menu-item-icon">${idx}</div>
          <span class="camera-menu-item-label">${cam.name}</span>
          <svg class="camera-menu-check" viewBox="0 0 16 16" fill="none"><path d="M3 8.5L6.5 12L13 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>`;
      }).join('');

      // Attach click handlers to camera items
      camerasContainer.querySelectorAll('[data-solo-index]').forEach(btn => {
        btn.addEventListener('click', () => {
          this.soloCamera(parseInt(btn.dataset.soloIndex));
          this.closeCameraMenu();
        });
      });

      // Highlight grid view when in grid mode
      const gridItem = menu.querySelector('.grid-view-item');
      if (gridItem) {
        gridItem.classList.toggle('active', this.soloIndex === null);
      }

      menu.classList.remove('hidden');
      // Trigger open animation (remove class after animation ends to avoid replays)
      menu.classList.add('menu-animating');
      menu.addEventListener('animationend', () => {
        menu.classList.remove('menu-animating');
      }, { once: true });
      btn.classList.add('menu-open');

      // Remove any existing outside-click handler before adding a new one
      if (this._outsideClickHandler) {
        document.removeEventListener('click', this._outsideClickHandler);
      }
      this._outsideClickHandler = (e) => {
        if (!e.target.closest('#camera-menu') && !e.target.closest('#camera-menu-btn')) {
          this.closeCameraMenu();
        }
      };
      // Defer so the current click event doesn't immediately close the menu
      setTimeout(() => {
        document.addEventListener('click', this._outsideClickHandler);
      }, 0);
    } else {
      this.closeCameraMenu();
    }
  }

  closeCameraMenu() {
    document.getElementById('camera-menu').classList.add('hidden');
    document.getElementById('camera-menu-btn').classList.remove('menu-open');
    if (this._outsideClickHandler) {
      document.removeEventListener('click', this._outsideClickHandler);
      this._outsideClickHandler = null;
    }
  }

  updateToolbar() {
    const btn = document.getElementById('camera-menu-btn');
    const iconGrid = document.getElementById('camera-menu-icon-grid');
    const iconSolo = document.getElementById('camera-menu-icon-solo');
    const label = document.getElementById('camera-menu-label');

    if (this.soloIndex !== null) {
      const cam = this.cameras[this.soloIndex - 1];
      iconGrid.style.display = 'none';
      iconSolo.style.display = '';
      label.textContent = cam ? cam.name : '';
      btn.classList.add('active');
      btn.title = `Solo: ${cam ? cam.name : ''} — click for camera menu`;
    } else {
      iconGrid.style.display = '';
      iconSolo.style.display = 'none';
      label.textContent = '';
      btn.classList.remove('active');
      btn.title = 'Camera selector';
    }
  }

  // ── Fullscreen ──────────────────────────────────────────────────────────

  async toggleFullscreen() {
    const win = getCurrentWindow();
    const isFs = await win.isFullscreen();
    await win.setFullscreen(!isFs);
  }

  // ── Keyboard Shortcuts ──────────────────────────────────────────────────

  bindKeys() {
    document.addEventListener("keydown", (e) => {
      if (this.settingsOpen()) {
        if (e.key === "Escape") this.closeSettings();
        return;
      }

      // Fullscreen toggle
      if (e.key === "F11" || (e.key === "f" && !e.ctrlKey)) {
        e.preventDefault();
        this.toggleFullscreen();
        return;
      }

      // Number keys 1-9: solo camera at that index
      if (e.key >= "1" && e.key <= "9" && !e.ctrlKey && !e.altKey) {
        const idx = parseInt(e.key, 10);
        if (idx <= this.cameras.length) {
          this.soloCamera(idx);
        }
        return;
      }

      // 0 or Escape: return to grid view
      if (e.key === "0" || (e.key === "Escape" && this.soloIndex !== null)) {
        this.exitSolo();
        return;
      }

      // Escape: exit fullscreen if active
      if (e.key === "Escape") {
        this.exitFullscreen();
        return;
      }
    });
  }

  async exitFullscreen() {
    const win = getCurrentWindow();
    if (await win.isFullscreen()) {
      await win.setFullscreen(false);
    }
  }

  // ── Settings Panel ─────────────────────────────────────────────────────

  settingsOpen() {
    return document
      .getElementById("settings")
      .classList.contains("visible");
  }

  openSettings() {
    const overlay = document.getElementById("settings-overlay");
    const panel = document.getElementById("settings");

    overlay.classList.remove("hidden");
    panel.classList.remove("hidden");

    requestAnimationFrame(() => {
      overlay.classList.add("visible");
      panel.classList.add("visible");
    });

    document.getElementById("shuffle-interval").value = Math.round(
      this.shuffleIntervalSecs / 60
    );
    document.getElementById("show-status-dots").checked = this.showStatusDots;
    document.getElementById("show-camera-names").checked = this.showCameraNames;
    document.getElementById("quality-select").value = this.quality;
    document.getElementById("api-port").value = this.apiPort;
    this.renderCameraList();
    this.injectHealthSection();
    this.injectPresetSection();
  }

  injectHealthSection() {
    const panel = document.querySelector("#settings .settings-body");
    if (!panel) return;

    // Remove existing health section if it exists
    const existingHealth = document.getElementById("health-stats-container");
    if (existingHealth) {
      existingHealth.closest(".settings-section")?.remove();
    }

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
    panel.insertAdjacentHTML('afterbegin', healthHTML);

    // Update health display with current stats
    this.updateHealthDisplay();
  }

  injectPresetSection() {
    const panel = document.querySelector("#settings .settings-body");
    if (!panel) return;

    // Remove existing preset section if it exists
    const existingPresets = document.getElementById("preset-list");
    if (existingPresets) {
      existingPresets.closest("section")?.remove();
    }

    // Create preset section HTML
    const presetsHTML = `
      <section>
        <h3>Camera Presets</h3>
        <div class="preset-controls">
          <input type="text" id="preset-name-input" placeholder="Preset name" />
          <button id="save-preset-btn" class="btn-primary">Save Current as Preset</button>
        </div>
        <div id="preset-list" class="preset-list">
          ${this.presets.map(p => `
            <div class="preset-item">
              <span class="preset-name">${p.name}</span>
              <div class="preset-actions">
                <button class="btn-small" onclick="app.loadPreset('${p.name}')">Load</button>
                <button class="btn-small btn-danger" onclick="app.deletePreset('${p.name}')">Delete</button>
              </div>
            </div>
          `).join('')}
        </div>
      </section>
    `;

    // Insert preset section after health section
    const healthSection = panel.querySelector(".settings-section");
    if (healthSection) {
      healthSection.insertAdjacentHTML('afterend', presetsHTML);
    } else {
      panel.insertAdjacentHTML('afterbegin', presetsHTML);
    }

    // Attach save preset handler
    const savePresetBtn = document.getElementById("save-preset-btn");
    if (savePresetBtn) {
      savePresetBtn.addEventListener("click", () => this.savePreset());
    }
  }

  updateHealthDisplay() {
    const container = document.getElementById("health-stats-container");
    if (!container) return; // Settings panel not open

    // Constants for magic numbers
    const MBPS_THRESHOLD_KBPS = 1000;

    // Clean up stale camera data from previousHealthValues
    const currentCameraIds = new Set(this.healthStats.keys());
    for (const cameraId of this.previousHealthValues.keys()) {
      if (!currentCameraIds.has(cameraId)) {
        this.previousHealthValues.delete(cameraId);
      }
    }

    this.healthStats.forEach((health, cameraId) => {
      const card = container.querySelector(`[data-camera-id="${cameraId}"]`);
      if (!card) return;

      const fpsEl = card.querySelector('[data-metric="fps"]');
      const bitrateEl = card.querySelector('[data-metric="bitrate"]');
      const framesEl = card.querySelector('[data-metric="frames"]');
      const uptimeEl = card.querySelector('[data-metric="uptime"]');

      // Get previous values for this camera
      const prevValues = this.previousHealthValues.get(cameraId) || {};
      let hasChanged = false;

      // Update FPS
      const fpsValue = health.fps.toFixed(1);
      if (fpsEl) {
        if (prevValues.fps !== fpsValue) {
          fpsEl.textContent = fpsValue;
          hasChanged = true;
        }
      }

      // Update Bitrate with Mbps conversion
      const bitrateKbps = health.bitrate_kbps;
      let bitrateText;
      if (bitrateKbps > MBPS_THRESHOLD_KBPS) {
        const bitrateMbps = Math.round(bitrateKbps / 10) / 100;
        bitrateText = `${bitrateMbps.toFixed(2)} Mbps`;
      } else {
        bitrateText = `${bitrateKbps.toFixed(0)} kbps`;
      }
      if (bitrateEl) {
        if (prevValues.bitrate !== bitrateText) {
          bitrateEl.textContent = bitrateText;
          hasChanged = true;
        }
      }

      // Update Frames
      const framesValue = health.frame_count.toLocaleString();
      if (framesEl) {
        if (prevValues.frames !== framesValue) {
          framesEl.textContent = framesValue;
          hasChanged = true;
        }
      }

      // Update Uptime with simplified format (hours and minutes only)
      const hours = Math.floor(health.uptime_secs / 3600);
      const mins = Math.floor((health.uptime_secs % 3600) / 60);
      let uptimeText;
      if (hours > 0) {
        uptimeText = `${hours}h ${mins}m`;
      } else {
        uptimeText = `${mins}m`;
      }
      if (uptimeEl) {
        if (prevValues.uptime !== uptimeText) {
          uptimeEl.textContent = uptimeText;
          hasChanged = true;
        }
      }

      // Store current values for next comparison
      this.previousHealthValues.set(cameraId, {
        fps: fpsValue,
        bitrate: bitrateText,
        frames: framesValue,
        uptime: uptimeText
      });
    });
  }

  // ── Health Monitoring ───────────────────────────────────────────────────

  startHealthMonitoring() {
    // Clear any existing interval to prevent stacking
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

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
    // Get or create toast container
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      container.style.cssText = 'position: fixed; bottom: 20px; right: 20px; display: flex; flex-direction: column-reverse; gap: 10px; z-index: 9999; pointer-events: none;';
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    toast.style.pointerEvents = 'auto';
    container.appendChild(toast);

    const duration = type === 'error' ? 10000 : 5000;
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => {
        toast.remove();
        // Remove container if empty
        if (container.children.length === 0) {
          container.remove();
        }
      }, 300);
    }, duration);
  }

  closeSettings() {
    const overlay = document.getElementById("settings-overlay");
    const panel = document.getElementById("settings");

    overlay.classList.remove("visible");
    panel.classList.remove("visible");

    setTimeout(() => {
      overlay.classList.add("hidden");
      panel.classList.add("hidden");
    }, 300);
  }

  renderCameraList() {
    const list = document.getElementById("camera-list");

    if (this.cameras.length === 0) {
      this.addCameraField();
      return;
    }

    list.innerHTML = this.cameras
      .map(
        (cam, i) => `
      <div class="camera-entry" data-index="${i}">
        <span class="api-index" title="API Index: Use /api/solo/${i + 1}">${i + 1}</span>
        <input type="text" placeholder="Camera name" value="${cam.name}" data-field="name" />
        <input type="text" placeholder="rtp://224.1.2.4:4000" value="${cam.url}" data-field="url" />
        <button class="remove-btn" data-remove-index="${i}">✕</button>
      </div>
    `
      )
      .join("");

    // Attach remove handlers
    list.querySelectorAll('[data-remove-index]').forEach(btn => {
      btn.addEventListener('click', () => this.removeCameraField(parseInt(btn.dataset.removeIndex)));
    });
  }

  addCameraField() {
    const list = document.getElementById("camera-list");
    const index = list.children.length;
    const entry = document.createElement("div");
    entry.className = "camera-entry";
    entry.dataset.index = index;
    entry.innerHTML = `
      <input type="text" placeholder="Camera name" value="" data-field="name" />
      <input type="text" placeholder="rtp://224.1.2.4:4000" value="" data-field="url" />
      <button class="remove-btn">✕</button>
    `;
    entry.querySelector('.remove-btn').addEventListener('click', () => this.removeCameraField(index));
    list.appendChild(entry);
  }

  removeCameraField(index) {
    const list = document.getElementById("camera-list");
    const entries = list.querySelectorAll(".camera-entry");
    if (entries[index]) entries[index].remove();
  }

  async saveSettings() {
    const entries = document.querySelectorAll("#camera-list .camera-entry");
    const cameras = [];

    // Build a map of existing cameras by URL for ID preservation
    const existingCamerasMap = new Map(this.cameras.map(c => [c.url, c.id]));

    entries.forEach((entry) => {
      const name = entry.querySelector('[data-field="name"]').value.trim();
      const url = entry.querySelector('[data-field="url"]').value.trim();
      if (url) {
        cameras.push({
          id: existingCamerasMap.get(url) || crypto.randomUUID(),
          name: name || `Camera ${cameras.length + 1}`,
          url,
        });
      }
    });

    const intervalMinutes = parseInt(
      document.getElementById("shuffle-interval").value,
      10
    );
    const shuffleIntervalSecs = Math.max(60, (intervalMinutes || 15) * 60);

    const showStatusDots = document.getElementById("show-status-dots").checked;
    const showCameraNames = document.getElementById("show-camera-names").checked;
    const quality = document.getElementById("quality-select").value;
    const apiPort = parseInt(document.getElementById("api-port").value, 10) || 8090;

    const config = {
      cameras,
      shuffle_interval_secs: shuffleIntervalSecs,
      show_status_dots: showStatusDots,
      show_camera_names: showCameraNames,
      quality,
      api_port: apiPort,
      layouts: this.layouts,
      active_layout: this.activeLayout,
    };

    await invoke("save_config", { config });

    this.cameras = cameras;
    this.displayOrder = this.cameras.map((_, i) => i); // reinitialize display order
    this.shuffleIntervalSecs = shuffleIntervalSecs;
    this.showStatusDots = showStatusDots;
    this.showCameraNames = showCameraNames;
    this.quality = quality;
    this.apiPort = apiPort;

    // Restart streams with new camera list
    await invoke("stop_streams");
    this.render();
    this.startShuffleTimer();
    if (this.cameras.length > 0) {
      await invoke("start_streams");
    }
    this.closeSettings();
  }

  // ── Layout Editor ───────────────────────────────────────────────────────

  openLayoutEditor() {
    const overlay = document.getElementById('layout-editor-overlay');
    const nameInput = document.getElementById('layout-name-input');
    const typeSelect = document.getElementById('layout-type-select');

    // Load current or create new layout
    const currentLayout = this.layouts.find(l => l.name === this.activeLayout) || {
      name: 'New Layout',
      layout_type: 'grid',
      positions: [],
      pip_config: null
    };

    nameInput.value = currentLayout.name;
    typeSelect.value = currentLayout.layout_type;

    this.renderCameraPositionEditors(currentLayout);
    overlay.style.display = 'flex';
  }

  closeLayoutEditor() {
    document.getElementById('layout-editor-overlay').style.display = 'none';
  }

  renderCameraPositionEditors(layout) {
    const container = document.getElementById('layout-camera-list');

    if (layout.layout_type === 'grid') {
      container.innerHTML = '<p class="hint">Grid layout automatically positions cameras. No manual positioning needed.</p>';
      return;
    }

    if (layout.layout_type === 'pip') {
      this.renderPipConfig(layout);
      return;
    }

    // Fallback for any other layout type
    container.innerHTML = '<p class="hint">Grid layout automatically positions cameras. No manual positioning needed.</p>';
  }

  handleLayoutTypeChange(newType) {
    const nameInput = document.getElementById('layout-name-input');
    const currentLayout = this.layouts.find(l => l.name === this.activeLayout);

    const layout = {
      name: nameInput.value || 'New Layout',
      layout_type: newType,
      positions: []
    };

    if (newType === 'pip') {
      // Initialize PIP config if it doesn't exist
      if (currentLayout?.pip_config) {
        layout.pip_config = currentLayout.pip_config;
      } else {
        // Default PIP config: first camera as main, no overlays
        layout.pip_config = {
          main_camera_id: this.cameras[0]?.id || '',
          overlays: []
        };
      }
    }

    this.renderCameraPositionEditors(layout);
  }


  // ── PIP Editor Methods ──────────────────────────────────────────────────

  getCurrentPipLayout() {
    const nameInput = document.getElementById('layout-name-input');
    const typeSelect = document.getElementById('layout-type-select');
    const mainCameraId = document.getElementById('pip-main-camera').value;
    const overlays = this.getActivePipOverlays();

    return {
      name: nameInput.value || 'New Layout',
      layout_type: typeSelect.value,
      pip_config: {
        main_camera_id: mainCameraId,
        overlays: overlays
      }
    };
  }

  renderPipConfig(layout) {
    const container = document.getElementById('layout-camera-list');
    const pipConfig = layout.pip_config || {
      main_camera_id: this.cameras[0]?.id || '',
      overlays: []
    };

    let html = `
      <div class="pip-editor">
        <div class="pip-main-camera">
          <label>Main Camera:</label>
          <select id="pip-main-camera">
            ${this.cameras.map(cam => `
              <option value="${cam.id}" ${cam.id === pipConfig.main_camera_id ? 'selected' : ''}>
                ${cam.name}
              </option>
            `).join('')}
          </select>
        </div>

        <h4 class="pip-section-header">Overlays</h4>
        <div id="pip-overlays-container">
          ${pipConfig.overlays.map((overlay, idx) => this.renderPipOverlay(overlay, idx)).join('')}
        </div>

        <button id="add-pip-overlay" class="btn-secondary pip-add-button">+ Add Overlay</button>
      </div>
    `;

    container.innerHTML = html;

    // Event listeners are attached once in bindUIEvents() to prevent memory leaks
  }

  validateMainCameraSelection() {
    const mainCameraId = document.getElementById('pip-main-camera').value;
    const overlays = this.getActivePipOverlays();

    // Check if main camera is also used in any overlay
    const conflict = overlays.find(overlay => overlay.camera_id === mainCameraId);

    if (conflict) {
      alert('The main camera cannot also be used as an overlay. Please remove it from overlays first.');
      // Optionally, you could auto-remove the conflicting overlay here
    }
  }

  renderPipOverlay(overlay, index) {
    return `
      <div class="pip-overlay-item" data-overlay-index="${index}">
        <div class="pip-overlay-header">
          <span class="pip-overlay-label">Overlay ${index + 1}</span>
          <button class="pip-overlay-remove btn-danger btn-small">Remove</button>
        </div>

        <div class="pip-overlay-controls">
          <label>
            Camera:
            <select class="pip-overlay-camera" data-overlay-index="${index}">
              ${this.cameras.map(cam => `
                <option value="${cam.id}" ${cam.id === overlay.camera_id ? 'selected' : ''}>
                  ${cam.name}
                </option>
              `).join('')}
            </select>
          </label>

          <label>
            Corner:
            <div class="corner-selector">
              <button data-corner="TL" class="${overlay.corner === 'TL' ? 'active' : ''}" title="Top Left">↖</button>
              <button data-corner="TR" class="${overlay.corner === 'TR' ? 'active' : ''}" title="Top Right">↗</button>
              <button data-corner="BL" class="${overlay.corner === 'BL' ? 'active' : ''}" title="Bottom Left">↙</button>
              <button data-corner="BR" class="${overlay.corner === 'BR' ? 'active' : ''}" title="Bottom Right">↘</button>
            </div>
          </label>

          <label>
            Size:
            <select class="pip-overlay-size" data-overlay-index="${index}">
              <option value="10" ${overlay.size_percent === 10 ? 'selected' : ''}>10%</option>
              <option value="15" ${overlay.size_percent === 15 ? 'selected' : ''}>15%</option>
              <option value="20" ${overlay.size_percent === 20 ? 'selected' : ''}>20%</option>
              <option value="25" ${overlay.size_percent === 25 ? 'selected' : ''}>25%</option>
              <option value="30" ${overlay.size_percent === 30 ? 'selected' : ''}>30%</option>
              <option value="35" ${overlay.size_percent === 35 ? 'selected' : ''}>35%</option>
              <option value="40" ${overlay.size_percent === 40 ? 'selected' : ''}>40%</option>
            </select>
          </label>
        </div>
      </div>
    `;
  }

  addPipOverlay() {
    const currentOverlays = this.getActivePipOverlays();

    // Find an available corner
    const corners = ['TL', 'TR', 'BL', 'BR'];
    const usedCorners = currentOverlays.map(o => o.corner);
    const availableCorner = corners.find(c => !usedCorners.includes(c));

    if (!availableCorner) {
      alert('All corners are occupied. Remove an overlay before adding a new one.');
      return;
    }

    // Find a camera that's not already the main camera
    const mainCameraId = document.getElementById('pip-main-camera').value;
    const availableCamera = this.cameras.find(c => c.id !== mainCameraId);

    if (!availableCamera) {
      alert('No available cameras for overlay.');
      return;
    }

    const newOverlay = {
      camera_id: availableCamera.id,
      corner: availableCorner,
      size_percent: 25
    };

    currentOverlays.push(newOverlay);

    // Re-render the overlays using the helper method
    const layout = this.getCurrentPipLayout();
    this.renderPipConfig(layout);
  }

  removePipOverlay(index) {
    const currentOverlays = this.getActivePipOverlays();
    currentOverlays.splice(index, 1);

    // Re-render using the helper method
    const layout = this.getCurrentPipLayout();
    this.renderPipConfig(layout);
  }

  selectCorner(overlayIndex, corner) {
    const currentOverlays = this.getActivePipOverlays();

    // Check for corner conflict
    if (this.validateCornerConflict(corner, overlayIndex)) {
      alert(`Corner ${corner} is already occupied by another overlay.`);
      return;
    }

    // Update the corner for this overlay
    currentOverlays[overlayIndex].corner = corner;

    // Re-render using the helper method
    const layout = this.getCurrentPipLayout();
    this.renderPipConfig(layout);
  }

  validateCornerConflict(corner, excludeIndex = -1) {
    const overlays = this.getActivePipOverlays();
    return overlays.some((overlay, idx) => {
      if (idx === excludeIndex) return false;
      return overlay.corner === corner;
    });
  }

  getActivePipOverlays() {
    const overlayItems = document.querySelectorAll('.pip-overlay-item');
    const overlays = [];

    overlayItems.forEach((item, idx) => {
      const cameraSelect = item.querySelector('.pip-overlay-camera');
      const sizeSelect = item.querySelector('.pip-overlay-size');
      const activeCornerBtn = item.querySelector('.corner-selector button.active');

      if (cameraSelect && sizeSelect && activeCornerBtn) {
        overlays.push({
          camera_id: cameraSelect.value,
          corner: activeCornerBtn.dataset.corner,
          size_percent: parseInt(sizeSelect.value)
        });
      }
    });

    return overlays;
  }

  async saveCurrentLayout() {
    const nameInput = document.getElementById('layout-name-input');
    const typeSelect = document.getElementById('layout-type-select');
    const layoutName = nameInput.value.trim() || 'New Layout';
    const layoutType = typeSelect.value;

    const positions = [];
    let pipConfig = null;

    if (layoutType === 'pip') {
      // Collect PIP config
      const mainCameraId = document.getElementById('pip-main-camera')?.value;
      const overlays = this.getActivePipOverlays();

      pipConfig = {
        main_camera_id: mainCameraId,
        overlays: overlays
      };
    }

    const newLayout = {
      name: layoutName,
      layout_type: layoutType,
      positions: positions
    };

    // Add pip_config if it exists
    if (pipConfig) {
      newLayout.pip_config = pipConfig;
    }

    // Update or add layout
    const existingIndex = this.layouts.findIndex(l => l.name === layoutName);
    if (existingIndex >= 0) {
      this.layouts[existingIndex] = newLayout;
    } else {
      this.layouts.push(newLayout);
    }

    // Save to config
    const config = await invoke("get_config");
    config.layouts = this.layouts;
    await invoke("save_config", { config });

    this.closeLayoutEditor();
  }

  async applyCurrentLayout() {
    await this.saveCurrentLayout();

    const nameInput = document.getElementById('layout-name-input');
    const layoutName = nameInput.value.trim() || 'New Layout';

    this.activeLayout = layoutName;
    const currentLayout = this.layouts.find(l => l.name === this.activeLayout);
    this.layoutMode = currentLayout?.layout_type || 'grid';

    // Save active layout to config
    const config = await invoke("get_config");
    config.active_layout = this.activeLayout;
    await invoke("save_config", { config });

    this.render();
    this.closeLayoutEditor();
  }

  // ── Camera Presets ──────────────────────────────────────────────────────

  async savePreset() {
    const nameInput = document.getElementById("preset-name-input");
    const name = nameInput.value.trim();

    if (!name) {
      alert("Please enter a preset name");
      return;
    }

    try {
      await invoke("save_preset", { name });
      const config = await invoke("get_config");
      this.presets = config.presets || [];
      nameInput.value = "";
      this.injectPresetSection(); // Refresh preset list
    } catch (err) {
      console.error("Failed to save preset:", err);
      alert("Failed to save preset");
    }
  }

  async loadPreset(name) {
    try {
      const cameras = await invoke("load_preset", { name });
      this.cameras = cameras;
      this.displayOrder = this.cameras.map((_, i) => i); // reinitialize display order
      const config = await invoke("get_config");
      config.cameras = cameras;
      await invoke("save_config", { config });
      await invoke("stop_streams");
      this.render();
      await invoke("start_streams");
      this.closeSettings();
    } catch (err) {
      console.error("Failed to load preset:", err);
      alert("Failed to load preset");
    }
  }

  async deletePreset(name) {
    if (!confirm(`Delete preset "${name}"?`)) return;

    try {
      await invoke("delete_preset", { name });
      const config = await invoke("get_config");
      this.presets = config.presets || [];
      this.injectPresetSection(); // Refresh preset list
    } catch (err) {
      console.error("Failed to delete preset:", err);
      alert("Failed to delete preset");
    }
  }

  // ── Drag-and-Drop Reordering ───────────────────────────────────────────

  handleDragStart(e, index) {
    this.draggedTile = e.currentTarget;
    this.dragStartIndex = index;
    e.currentTarget.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
  }

  handleDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const target = e.currentTarget;
    if (target !== this.draggedTile) {
      target.classList.add("drag-over");
    }
  }

  handleDrop(e, targetIndex) {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.classList.remove("drag-over");

    if (this.dragStartIndex !== targetIndex) {
      const temp = this.cameras[this.dragStartIndex];
      this.cameras[this.dragStartIndex] = this.cameras[targetIndex];
      this.cameras[targetIndex] = temp;
      this.displayOrder = this.cameras.map((_, i) => i); // resync display order after manual reorder
      this.render();
      this.saveCameraOrder();
    }
  }

  handleDragEnd(e) {
    e.currentTarget.classList.remove("dragging");
    document.querySelectorAll(".camera-tile").forEach(t => t.classList.remove("drag-over"));
  }

  async saveCameraOrder() {
    const config = await invoke("get_config");
    config.cameras = this.cameras;
    await invoke("save_config", { config });
  }

  // ── Window State Persistence ────────────────────────────────────────────

  async setupWindowStatePersistence() {
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
        } catch (err) {
          console.error("Failed to save window state:", err);
        }
      }, 500);
    };

    await currentWindow.listen("tauri://resize", saveWindowState);
    await currentWindow.listen("tauri://move", saveWindowState);
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

let app;

window.addEventListener("DOMContentLoaded", async () => {
  try {
    await waitForTauri();
  } catch (e) {
    console.error("Tauri API not found:", e);
  }
  app = new StageView();
});
