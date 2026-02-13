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

      // Listen for camera status events (online / offline / error)
      this.unlistenStatus = await listen("camera-status", (event) => {
        const { camera_id, status } = event.payload;
        const tile = document.querySelector(`[data-id="${camera_id}"]`);
        if (!tile) return;
        const spinner = tile.querySelector(".loading-spinner");
        const statusEl = tile.querySelector(".camera-status");
        if (status === "online") {
          spinner.style.display = "none";
          statusEl.classList.remove("offline");
        } else {
          spinner.style.display = "none";
          statusEl.classList.add("offline");
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

    const cols = Math.ceil(Math.sqrt(this.cameras.length));
    const rows = Math.ceil(this.cameras.length / cols);
    grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;

    grid.innerHTML = this.cameras
      .map(
        (cam) => `
      <div class="camera-tile" data-id="${cam.id}">
        <div class="loading-spinner"></div>
        <img />
        <div class="camera-status" style="${this.showStatusDots ? '' : 'display:none'}"></div>
        <div class="camera-label" style="${this.showCameraNames ? '' : 'display:none'}">${cam.name}</div>
      </div>
    `
      )
      .join("");

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
