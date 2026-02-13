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
    this.layoutMode = "grid"; // "grid", "custom", "pip"
    this.presets = [];
    this.draggedTile = null;
    this.dragStartIndex = null;
    this.previousHealthValues = new Map(); // stores previous health values for change detection
    this.init();
  }

  // ── Initialization ──────────────────────────────────────────────────────

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
      this.presets = config.presets || [];

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
    } catch (err) {
      console.error("StageView init failed:", err);
      this.render();
    }

    this.bindUIEvents();
    this.bindKeys();
    this.updateToolbar();
    this.setupWindowStatePersistence();
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
      this.renderCustomLayout(grid);
    }
  }

  renderGridLayout(grid) {
    const cols = Math.ceil(Math.sqrt(this.cameras.length));
    const rows = Math.ceil(this.cameras.length / cols);
    grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
    grid.style.position = "";

    grid.innerHTML = this.cameras
      .map((cam, idx) => this.createCameraTile(cam, idx))
      .join("");

    this.bindTileEvents(grid);
  }

  renderCustomLayout(grid) {
    const currentLayout = this.layouts.find(l => l.name === this.activeLayout);
    if (!currentLayout || currentLayout.positions.length === 0) {
      // Fallback to grid if no custom positions
      this.renderGridLayout(grid);
      return;
    }

    // For custom layouts, use absolute positioning
    grid.style.gridTemplateColumns = "";
    grid.style.gridTemplateRows = "";
    grid.style.position = "relative";

    grid.innerHTML = currentLayout.positions
      .map((pos) => {
        const cam = this.cameras.find(c => c.id === pos.camera_id);
        if (!cam) return "";

        const idx = this.cameras.findIndex(c => c.id === cam.id);
        return `
          <div class="camera-tile" data-id="${cam.id}" style="
            position: absolute;
            left: ${pos.x * 100}%;
            top: ${pos.y * 100}%;
            width: ${pos.width * 100}%;
            height: ${pos.height * 100}%;
            z-index: ${pos.z_index};
          ">
            <div class="loading-spinner"></div>
            <img />
            <div class="camera-status" style="${this.showStatusDots ? '' : 'display:none'}"></div>
            <div class="camera-label" style="${this.showCameraNames ? '' : 'display:none'}">${cam.name}</div>
          </div>
        `;
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

    // Define corner position mappings (2% margin from edges)
    const positions = {
      TL: { left: '2%', top: '2%' },
      TR: { right: '2%', top: '2%' },
      BL: { left: '2%', bottom: '2%' },
      BR: { right: '2%', bottom: '2%' }
    };

    let tiles = [];

    // 1. Create main camera tile (100% width/height, z-index: 1)
    const mainCamera = this.cameras.find(c => c.id === pipConfig.main_camera_id);
    if (mainCamera) {
      tiles.push(`
        <div class="camera-tile" data-id="${mainCamera.id}" style="
          position: absolute;
          left: 0;
          top: 0;
          width: 100%;
          height: 100%;
          z-index: 1;
        ">
          <div class="loading-spinner"></div>
          <img />
          <div class="camera-status" style="${this.showStatusDots ? '' : 'display:none'}"></div>
          <div class="camera-label" style="${this.showCameraNames ? '' : 'display:none'}">${mainCamera.name}</div>
        </div>
      `);
    }

    // 2. Create overlay tiles for each PIP overlay
    pipConfig.overlays.forEach((overlay, idx) => {
      const overlayCamera = this.cameras.find(c => c.id === overlay.camera_id);
      if (!overlayCamera) return;

      const corner = overlay.corner;
      const cornerPos = positions[corner] || positions.BR; // Default to BR if corner not found
      const size = `${overlay.size_percent}%`;

      // Build position style string
      let positionStyle = '';
      if (cornerPos.left !== undefined) {
        positionStyle += `left: ${cornerPos.left}; `;
      }
      if (cornerPos.right !== undefined) {
        positionStyle += `right: ${cornerPos.right}; `;
      }
      if (cornerPos.top !== undefined) {
        positionStyle += `top: ${cornerPos.top}; `;
      }
      if (cornerPos.bottom !== undefined) {
        positionStyle += `bottom: ${cornerPos.bottom}; `;
      }

      tiles.push(`
        <div class="camera-tile" data-id="${overlayCamera.id}" style="
          position: absolute;
          ${positionStyle}
          width: ${size};
          height: ${size};
          z-index: ${10 + idx};
        ">
          <div class="loading-spinner"></div>
          <img />
          <div class="camera-status" style="${this.showStatusDots ? '' : 'display:none'}"></div>
          <div class="camera-label" style="${this.showCameraNames ? '' : 'display:none'}">${overlayCamera.name}</div>
        </div>
      `);
    });

    grid.innerHTML = tiles.join("");
    this.bindTileEvents(grid);
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
    grid.querySelectorAll(".camera-tile").forEach((tile, idx) => {
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
        tile.draggable = true;
        tile.addEventListener("dragstart", (e) => this.handleDragStart(e, idx));
        tile.addEventListener("dragover", (e) => this.handleDragOver(e));
        tile.addEventListener("drop", (e) => this.handleDrop(e, idx));
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

    // Derangement: guarantee every camera moves to a different position.
    // Sattolo's algorithm produces a single cyclic permutation — no element
    // can remain in its original slot, giving a full visual refresh.
    if (this.cameras.length < 2) return;

    for (let i = this.cameras.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * i); // note: excludes i itself
      [this.cameras[i], this.cameras[j]] = [this.cameras[j], this.cameras[i]];
    }

    // Rearrange existing DOM tiles instead of rebuilding (avoids spinner flash)
    const grid = document.getElementById("grid");
    const tileMap = {};
    grid.querySelectorAll(".camera-tile").forEach((tile) => {
      tileMap[tile.dataset.id] = tile;
    });

    for (const cam of this.cameras) {
      const tile = tileMap[cam.id];
      if (tile) {
        grid.appendChild(tile); // moves existing node to new position
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

    entries.forEach((entry) => {
      const name = entry.querySelector('[data-field="name"]').value.trim();
      const url = entry.querySelector('[data-field="url"]').value.trim();
      if (url) {
        cameras.push({
          id: crypto.randomUUID(),
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
      positions: []
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

    container.innerHTML = this.cameras.map((cam, idx) => {
      const pos = layout.positions.find(p => p.camera_id === cam.id) || {
        camera_id: cam.id,
        x: 0,
        y: 0,
        width: 0.5,
        height: 0.5,
        z_index: idx
      };

      return `
        <div class="camera-position-editor" data-camera-id="${cam.id}">
          <h4>${cam.name}</h4>
          <div class="position-inputs">
            <label>
              X (0-1):
              <input type="number" step="0.01" min="0" max="1" value="${pos.x}" data-field="x" />
            </label>
            <label>
              Y (0-1):
              <input type="number" step="0.01" min="0" max="1" value="${pos.y}" data-field="y" />
            </label>
            <label>
              Width (0-1):
              <input type="number" step="0.01" min="0" max="1" value="${pos.width}" data-field="width" />
            </label>
            <label>
              Height (0-1):
              <input type="number" step="0.01" min="0" max="1" value="${pos.height}" data-field="height" />
            </label>
            <label>
              Z-Index:
              <input type="number" step="1" value="${pos.z_index}" data-field="z_index" />
            </label>
          </div>
        </div>
      `;
    }).join('');
  }

  handleLayoutTypeChange(newType) {
    const nameInput = document.getElementById('layout-name-input');
    const layout = {
      name: nameInput.value || 'New Layout',
      layout_type: newType,
      positions: []
    };

    if (newType === 'pip') {
      // Auto-generate PIP layout
      layout.positions = this.generatePIPLayout();
    }

    this.renderCameraPositionEditors(layout);
  }

  generatePIPLayout() {
    if (this.cameras.length === 0) return [];

    const positions = [];

    // First camera is main view (full screen)
    positions.push({
      camera_id: this.cameras[0].id,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      z_index: 0
    });

    // Rest are picture-in-picture in bottom-right corner
    const pipWidth = 0.25;
    const pipHeight = 0.25;
    const margin = 0.02;

    for (let i = 1; i < this.cameras.length; i++) {
      const row = Math.floor((i - 1) / 3);
      const col = (i - 1) % 3;

      positions.push({
        camera_id: this.cameras[i].id,
        x: 1 - (pipWidth + margin) * (col + 1),
        y: 1 - (pipHeight + margin) * (row + 1),
        width: pipWidth,
        height: pipHeight,
        z_index: i
      });
    }

    return positions;
  }

  async saveCurrentLayout() {
    const nameInput = document.getElementById('layout-name-input');
    const typeSelect = document.getElementById('layout-type-select');
    const layoutName = nameInput.value.trim() || 'New Layout';
    const layoutType = typeSelect.value;

    const positions = [];

    if (layoutType !== 'grid') {
      // Collect positions from editor inputs
      document.querySelectorAll('.camera-position-editor').forEach(editor => {
        const cameraId = editor.dataset.cameraId;
        const inputs = editor.querySelectorAll('input');

        const pos = {
          camera_id: cameraId,
          x: parseFloat(inputs[0].value) || 0,
          y: parseFloat(inputs[1].value) || 0,
          width: parseFloat(inputs[2].value) || 0.5,
          height: parseFloat(inputs[3].value) || 0.5,
          z_index: parseInt(inputs[4].value) || 0
        };

        positions.push(pos);
      });
    }

    const newLayout = {
      name: layoutName,
      layout_type: layoutType,
      positions: positions
    };

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
