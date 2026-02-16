// ── StageView ────────────────────────────────────────────────────────────────
// Lightweight multi-camera grid viewer with burn-in protection.
// Streams are rendered natively by the browser via <img src> pointed at
// the backend's MJPEG HTTP endpoint (multipart/x-mixed-replace).

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

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Canvas-based MJPEG Stream Reader ─────────────────────────────────────────
// Reads an MJPEG stream via fetch(), decodes JPEG frames off the main thread
// with createImageBitmap(), and holds the latest bitmap for rAF rendering.
// This replaces <img src="mjpeg-url"> to avoid per-frame repaints that saturate
// the browser rendering pipeline.

class MjpegStreamReader {
  constructor(url, canvas) {
    this.url = url;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.latestBitmap = null;
    this.abortController = null;
    this.running = false;
    this._firstFrame = false;
    this._newFrame = false;
    this.onFirstFrame = null; // callback
  }

  async start() {
    this.abortController = new AbortController();
    this.running = true;
    let retryDelay = 1000; // start at 1s, exponential backoff up to 5s

    while (this.running) {
      try {
        const response = await fetch(this.url, { signal: this.abortController.signal });
        const reader = response.body.getReader();
        let buffer = new Uint8Array(0);
        retryDelay = 1000; // reset on successful connect

        while (this.running) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer = this._concat(buffer, value);
          buffer = await this._extractFrames(buffer);
        }
      } catch (e) {
        if (e.name === 'AbortError' || !this.running) return;
        console.error('MJPEG stream error, reconnecting in', retryDelay + 'ms:', e);
      }

      if (!this.running) return;
      await new Promise(r => setTimeout(r, retryDelay));
      retryDelay = Math.min(retryDelay * 2, 5000);
    }
  }

  stop() {
    this.running = false;
    if (this.abortController) this.abortController.abort();
    if (this.latestBitmap) { this.latestBitmap.close(); this.latestBitmap = null; }
  }

  _concat(a, b) {
    const result = new Uint8Array(a.length + b.length);
    result.set(a, 0);
    result.set(b, a.length);
    return result;
  }

  async _extractFrames(buffer) {
    // Scan for JPEG SOI (0xFFD8) and EOI (0xFFD9) markers
    let searchFrom = 0;
    let lastFrameEnd = -1;
    let lastFrameData = null;

    while (searchFrom < buffer.length - 1) {
      // Find SOI
      let soiIndex = -1;
      for (let i = searchFrom; i < buffer.length - 1; i++) {
        if (buffer[i] === 0xFF && buffer[i + 1] === 0xD8) {
          soiIndex = i;
          break;
        }
      }
      if (soiIndex === -1) break;

      // Find EOI after SOI
      let eoiIndex = -1;
      for (let i = soiIndex + 2; i < buffer.length - 1; i++) {
        if (buffer[i] === 0xFF && buffer[i + 1] === 0xD9) {
          eoiIndex = i;
          break;
        }
      }
      if (eoiIndex === -1) break; // Incomplete frame, wait for more data

      // Complete frame: SOI to EOI+2
      const frameEnd = eoiIndex + 2;
      lastFrameData = buffer.slice(soiIndex, frameEnd);
      lastFrameEnd = frameEnd;
      searchFrom = frameEnd;
    }

    // Decode only the last complete frame found in this chunk
    if (lastFrameData !== null) {
      try {
        const blob = new Blob([lastFrameData], { type: 'image/jpeg' });
        const bitmap = await createImageBitmap(blob);
        if (this.latestBitmap) this.latestBitmap.close();
        this.latestBitmap = bitmap;
        this._newFrame = true;

        if (!this._firstFrame) {
          this._firstFrame = true;
          if (this.onFirstFrame) this.onFirstFrame();
        }
      } catch (e) {
        // Bad JPEG, skip
      }
    }

    // Return remaining buffer after last complete frame
    if (lastFrameEnd > 0) {
      return buffer.slice(lastFrameEnd);
    }

    // If buffer is growing too large without finding frames, trim it
    if (buffer.length > 5 * 1024 * 1024) {
      console.warn('MJPEG buffer exceeded 5MB without complete frame, resetting');
      return new Uint8Array(0);
    }

    return buffer;
  }

  draw() {
    if (this._newFrame && this.latestBitmap) {
      this._newFrame = false;
      this.ctx.drawImage(this.latestBitmap, 0, 0, this.canvas.width, this.canvas.height);
    }
  }
}

class StageView {
  constructor() {
    this.cameras = [];
    this.displayOrder = []; // array of indices for grid shuffle (separate from insertion order)
    this.shuffleIntervalSecs = 900;
    this.showStatusDots = true;
    this.showCameraNames = true;
    this.apiPort = 8090;
    this.shuffleTimerId = null;
    this._noiseDataUrl = null; // cached noise texture for pixel refresh
    this.nextShuffleAt = 0;
    this.unlistenStatus = null;
    this.unlistenCommand = null;
    this.soloIndex = null; // null = grid view, number = 1-based solo index
    this.pixelShiftIndex = 0; // cycles through shift positions for burn-in protection
    this._outsideClickHandler = null; // single handler for camera menu outside clicks
    this.draggedTile = null;
    this.dragStartIndex = null;
    this.previousHealthValues = new Map(); // stores previous health values for change detection
    this.healthStats = new Map(); // camera_id -> health object
    this.cameraStatuses = new Map(); // camera_id -> status string (online/offline/connecting/reconnecting)
    this._configSavePromise = null; // serializes config save operations
    this.streamReaders = new Map(); // camera_id -> MjpegStreamReader
    this._rafId = null;
    this._idleTimer = null;
    this._isIdle = false;
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
      this.apiPort = config.api_port || 8090;

      // Listen for camera status events (online / offline / error / connecting / reconnecting)
      this.unlistenStatus = await listen("camera-status", (event) => {
        const { camera_id, status } = event.payload;

        // Track status in Map so we can restore it after re-render
        this.cameraStatuses.set(camera_id, status);

        const tile = document.querySelector(`[data-id="${camera_id}"]`);
        if (!tile) return;

        this.applyCameraStatus(tile, status);
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
      this.unlistenHealth = await listen("stream-health", (event) => {
        const { camera_id, health } = event.payload;
        this.healthStats.set(camera_id, health);
        this.updateHealthDisplay();
      });

      // Listen for stream errors
      this.unlistenStreamError = await listen("stream-error", (event) => {
        const { camera_id, error } = event.payload;
        const camera = this.cameras.find(c => c.id === camera_id);
        const cameraName = camera ? camera.name : camera_id;

        this.showToast(`${cameraName}: ${error}`, 'error');

        console.error(`Stream error for ${cameraName}:`, error);
      });

      // Listen for reload-config event
      await listen("reload-config", () => {
        console.log("Config reloaded, refreshing UI...");
        location.reload();
      });

      this.render();
      this._startRenderLoop();
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
    this.setupIdleHiding();
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

    // Inline camera quality/fps dropdown delegation
    const cameraList = document.getElementById('camera-list');
    if (cameraList && !cameraList.dataset.inlineListenerBound) {
      cameraList.addEventListener('change', (e) => {
        const entry = e.target.closest('.camera-entry');
        if (!entry) return;
        const idx = parseInt(entry.dataset.index);
        if (isNaN(idx) || !this.cameras[idx]) return;

        if (e.target.classList.contains('cam-quality')) {
          const val = e.target.value;
          if (val === '') {
            // "Global" selected — remove override
            delete this.cameras[idx].codec_override;
          } else {
            if (!this.cameras[idx].codec_override) {
              this.cameras[idx].codec_override = { quality: val, fps_mode: 'native' };
            } else {
              this.cameras[idx].codec_override.quality = val;
            }
          }
        }

        if (e.target.classList.contains('cam-fps')) {
          const val = e.target.value;
          if (!this.cameras[idx].codec_override) {
            this.cameras[idx].codec_override = { quality: 'medium', fps_mode: 'native' };
          }
          if (val === 'native') {
            this.cameras[idx].codec_override.fps_mode = 'native';
          } else {
            this.cameras[idx].codec_override.fps_mode = { capped: parseInt(val) };
          }
        }
      });
      cameraList.dataset.inlineListenerBound = "true";
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
    this.renderGridLayout(grid);
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

    // Restore camera status for any cameras that already have a known status
    grid.querySelectorAll(".camera-tile").forEach((tile) => {
      const camId = tile.dataset.id;
      const status = this.cameraStatuses.get(camId);
      if (status) {
        this.applyCameraStatus(tile, status);
      }
    });
  }

  createCameraTile(cam, idx) {
    return `
      <div class="camera-tile" data-id="${cam.id}">
        <div class="loading-spinner"></div>
        <canvas></canvas>
        <div class="camera-status" style="${this.showStatusDots ? '' : 'display:none'}"></div>
        <div class="camera-label" style="${this.showCameraNames ? '' : 'display:none'}">${escapeHtml(cam.name)}</div>
      </div>
    `;
  }

  applyCameraStatus(tile, status) {
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
  }

  bindTileEvents(grid) {
    // Stop any existing stream readers before creating new ones
    this._stopAllReaders();

    // Create MjpegStreamReader for each tile's <canvas>
    grid.querySelectorAll(".camera-tile").forEach((tile) => {
      const canvas = tile.querySelector("canvas");
      const camId = tile.dataset.id;
      if (!canvas || !camId) return;

      const url = `http://localhost:${this.apiPort}/camera/${camId}/stream`;
      const reader = new MjpegStreamReader(url, canvas);

      // Size the canvas to match tile dimensions (update on resize)
      this._sizeCanvas(canvas, tile);

      reader.onFirstFrame = () => {
        canvas.classList.add("has-frame");
        const spinner = tile.querySelector(".loading-spinner");
        if (spinner) spinner.style.display = "none";
        const statusEl = tile.querySelector(".camera-status");
        if (statusEl) {
          statusEl.classList.remove("offline", "reconnecting");
        }
      };

      this.streamReaders.set(camId, reader);
      reader.start();
    });

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

      // Add drag-and-drop
      const camId = tile.dataset.id;
      const cameraIndex = this.cameras.findIndex((c) => c.id === camId);

      tile.draggable = true;
      tile.addEventListener("dragstart", (e) => this.handleDragStart(e, cameraIndex));
      tile.addEventListener("dragover", (e) => this.handleDragOver(e));
      tile.addEventListener("dragleave", (e) => e.currentTarget.classList.remove("drag-over"));
      tile.addEventListener("drop", (e) => this.handleDrop(e, cameraIndex));
      tile.addEventListener("dragend", (e) => this.handleDragEnd(e));
    });
  }

  // ── Canvas Rendering Helpers ────────────────────────────────────────────

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

  _stopRenderLoop() {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  _stopAllReaders() {
    for (const reader of this.streamReaders.values()) {
      reader.stop();
    }
    this.streamReaders.clear();
  }

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
            const w = entry.contentRect.width;
            const h = entry.contentRect.height;
            if (c && w > 0 && h > 0) {
              c.width = w;
              c.height = h;
            }
          }
        });
      });
    }
    this._resizeObserver.observe(container);
  }

  // ── Burn-in Shuffle ─────────────────────────────────────────────────────

  startShuffleTimer() {
    clearTimeout(this.shuffleTimerId);

    if (this.cameras.length < 2) {
      document.getElementById("shuffle-timer").textContent = "";
      return;
    }

    this.nextShuffleAt = Date.now() + this.shuffleIntervalSecs * 1000;

    const scheduleNext = () => {
      this.shuffleTimerId = setTimeout(() => {
        this.shuffleCameras();
        this.nextShuffleAt = Date.now() + this.shuffleIntervalSecs * 1000;
        scheduleNext();
      }, this.shuffleIntervalSecs * 1000);
    };
    scheduleNext();
  }

  updateCountdown() {
    const remaining = Math.max(
      0,
      Math.ceil((this.nextShuffleAt - Date.now()) / 1000)
    );
    const hrs = Math.floor(remaining / 3600);
    const min = Math.floor((remaining % 3600) / 60);
    const sec = remaining % 60;
    const timerEl = document.getElementById("shuffle-timer");
    if (hrs > 0) {
      timerEl.textContent =
        `${String(hrs).padStart(2, "0")}:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    } else {
      timerEl.textContent =
        `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    }
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

    // Apply visual reorder via CSS order (preserves DOM tree / canvas context)
    const grid = document.getElementById("grid");
    grid.querySelectorAll(".camera-tile").forEach((tile) => {
      const camId = tile.dataset.id;
      const camIndex = this.cameras.findIndex(c => c.id === camId);
      const orderPos = this.displayOrder.indexOf(camIndex);
      tile.style.order = orderPos >= 0 ? orderPos : 0;
    });
  }

  // ── Solo Camera Mode ────────────────────────────────────────────────────

  async soloCamera(index) {
    if (index < 1 || index > this.cameras.length) return;
    this.soloIndex = index;
    const cam = this.cameras[index - 1];

    const grid = document.getElementById("grid");

    // Hide all tiles except the solo'd one; stop non-solo stream readers
    grid.querySelectorAll(".camera-tile").forEach((tile) => {
      if (tile.dataset.id === cam.id) {
        tile.classList.add("solo");
        tile.style.display = "";
      } else {
        tile.style.display = "none";
        // Stop the reader for non-solo cameras
        const reader = this.streamReaders.get(tile.dataset.id);
        if (reader) {
          reader.stop();
          this.streamReaders.delete(tile.dataset.id);
        }
      }
    });

    // Switch grid to single cell
    grid.style.gridTemplateColumns = "1fr";
    grid.style.gridTemplateRows = "1fr";
    grid.style.position = "";

    // Tell backend to stop non-solo streams (save resources)
    await invoke("solo_camera", { cameraId: cam.id });

    this.updateToolbar();

    // Reset shuffle timer for pixel refresh in solo mode
    this.startShuffleTimer();
  }

  async exitSolo() {
    if (this.soloIndex === null) return;
    this.soloIndex = null;

    // Restart all streams
    await invoke("grid_view");

    // Re-render using the current layout mode (grid or PIP)
    this.render();

    this.updateToolbar();
    this.closeCameraMenu();
    this.startShuffleTimer();
  }

  // ── Pixel Refresh (burn-in protection in solo mode) ─────────────────────

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
          <span class="camera-menu-item-label">${escapeHtml(cam.name)}</span>
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

      // Don't trigger shortcuts when typing in input fields
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        // Still allow Escape to work in inputs
        if (e.key !== "Escape") return;
      }

      // TEST: Toggle GPU scaling (Press 'T') — no longer relevant with canvas rendering
      // Kept for debugging purposes

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

  async openSettings() {
    const overlay = document.getElementById("settings-overlay");
    const panel = document.getElementById("settings");

    overlay.classList.remove("hidden");
    panel.classList.remove("hidden");

    // Double rAF ensures browser has committed layout before triggering transition
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        overlay.classList.add("visible");
        panel.classList.add("visible");
      });
    });

    const totalMins = Math.round(this.shuffleIntervalSecs / 60);
    document.getElementById("shuffle-interval-hours").value = Math.floor(totalMins / 60);
    document.getElementById("shuffle-interval-minutes").value = totalMins % 60;
    document.getElementById("show-status-dots").checked = this.showStatusDots;
    document.getElementById("show-camera-names").checked = this.showCameraNames;
    document.getElementById("api-port").value = this.apiPort;
    this.renderCameraList();
    this.injectHealthSection();

    // Load quality setting
    try {
      const config = await invoke("get_config");
      const qualitySelect = document.getElementById("quality-preset-select");
      if (config.stream_config?.quality && qualitySelect) {
        qualitySelect.value = config.stream_config.quality;
      }
    } catch (err) {
      console.error("Failed to load quality setting:", err);
    }
  }

  injectHealthSection() {
    const panel = document.querySelector("#settings .settings-body");
    if (!panel) return;

    // If health section already exists with matching cameras, just update the display
    const existingHealth = document.getElementById("health-stats-container");
    if (existingHealth) {
      const existingIds = new Set(
        Array.from(existingHealth.querySelectorAll("[data-camera-id]"))
          .map(el => el.dataset.cameraId)
      );
      const currentIds = new Set(this.cameras.map(c => c.id));
      const sameSet = existingIds.size === currentIds.size &&
        [...currentIds].every(id => existingIds.has(id));

      if (sameSet) {
        // Camera list unchanged — just refresh the values in place
        this.updateHealthDisplay();
        return;
      }
      // Camera list changed — tear down and rebuild; clear stale cache
      this.previousHealthValues.clear();
      existingHealth.closest(".settings-section")?.remove();
    }

    // Create health section HTML
    let healthHTML = `
      <div class="settings-section">
        <h3>Stream Health</h3>
        <div id="health-stats-container">
          ${this.cameras.map(cam => `
            <div class="health-card" data-camera-id="${cam.id}" data-health-state="unknown">
              <div class="health-camera-name">${escapeHtml(cam.name)}</div>
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
                  <span class="health-label">Uptime:</span>
                  <span class="health-value" data-metric="uptime">--</span>
                </div>
                <div class="health-metric">
                  <span class="health-label">Resolution:</span>
                  <span class="health-value" data-metric="resolution">--</span>
                </div>
                <div class="health-metric">
                  <span class="health-label">Quality:</span>
                  <span class="health-value" data-metric="quality">--</span>
                </div>
                <div class="health-metric">
                  <span class="health-label">Codec:</span>
                  <span class="health-value" data-metric="codec">--</span>
                </div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;

    // Insert health section at the top of settings panel
    panel.insertAdjacentHTML('afterbegin', healthHTML);

    // Clear cached previous values so all fields repopulate from scratch
    this.previousHealthValues.clear();

    // Fetch current health stats from backend and update display
    this.refreshHealthStats();
  }

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

  updateHealthDisplay() {
    const container = document.getElementById("health-stats-container");
    if (!container) return; // Settings panel not open

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
      const uptimeEl = card.querySelector('[data-metric="uptime"]');
      const resolutionEl = card.querySelector('[data-metric="resolution"]');
      const qualityEl = card.querySelector('[data-metric="quality"]');
      const codecEl = card.querySelector('[data-metric="codec"]');

      // Get previous values for this camera
      const prevValues = this.previousHealthValues.get(cameraId) || {};

      // Update FPS
      const fpsValue = (health.fps ?? 0).toFixed(1);
      if (fpsEl && prevValues.fps !== fpsValue) {
        fpsEl.textContent = fpsValue;
      }

      // Update Bitrate with Mbps conversion and hysteresis
      const bitrateKbps = health.bitrate_kbps ?? 0;
      const prevUsedMbps = prevValues.bitrateUnit === 'Mbps';
      const useMbps = prevUsedMbps
        ? bitrateKbps >= 900   // stay in Mbps until below 900
        : bitrateKbps > 1000;  // switch to Mbps above 1000
      let bitrateText;
      if (useMbps) {
        const bitrateMbps = Math.round(bitrateKbps / 10) / 100;
        bitrateText = `${bitrateMbps.toFixed(2)} Mbps`;
      } else {
        bitrateText = `${bitrateKbps.toFixed(0)} kbps`;
      }
      if (bitrateEl && prevValues.bitrate !== bitrateText) {
        bitrateEl.textContent = bitrateText;
      }

      // Update Uptime with simplified format (hours and minutes only)
      const uptime_secs = health.uptime_secs ?? 0;
      const hours = Math.floor(uptime_secs / 3600);
      const mins = Math.floor((uptime_secs % 3600) / 60);
      let uptimeText;
      if (hours > 0) {
        uptimeText = `${hours}h ${mins}m`;
      } else if (mins > 0) {
        uptimeText = `${mins}m`;
      } else {
        uptimeText = `${uptime_secs}s`;
      }
      if (uptimeEl && prevValues.uptime !== uptimeText) {
        uptimeEl.textContent = uptimeText;
      }

      // Update Resolution
      const resolutionText = health.resolution || "Unknown";
      if (resolutionEl && prevValues.resolution !== resolutionText) {
        resolutionEl.textContent = resolutionText;
      }

      // Update Quality Setting
      const qualityText = health.quality_setting || "--";
      if (qualityEl && prevValues.quality !== qualityText) {
        qualityEl.textContent = qualityText;
      }

      // Update Codec
      const codecText = health.codec || "--";
      if (codecEl && prevValues.codec !== codecText) {
        codecEl.textContent = codecText;
      }

      // Store current values for next comparison
      this.previousHealthValues.set(cameraId, {
        fps: fpsValue,
        bitrate: bitrateText,
        bitrateUnit: useMbps ? 'Mbps' : 'kbps',
        uptime: uptimeText,
        resolution: resolutionText,
        quality: qualityText,
        codec: codecText
      });

      // Determine health state based on FPS
      let newState;
      if (health.fps > 0) {
        newState = 'online';
      } else if (health.uptime_secs > 0) {
        newState = 'warn';
      } else {
        newState = 'error';
      }

      // Only update attribute if state changed
      const prevState = card.getAttribute('data-health-state');
      if (prevState !== newState) {
        card.setAttribute('data-health-state', newState);
      }
    });
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
    // Prevent clicks during close animation
    overlay.style.pointerEvents = "none";
    panel.style.pointerEvents = "none";

    setTimeout(() => {
      overlay.classList.add("hidden");
      panel.classList.add("hidden");
      overlay.style.pointerEvents = "";
      panel.style.pointerEvents = "";
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
        (cam, i) => {
          const q = cam.codec_override?.quality || '';
          const fm = cam.codec_override?.fps_mode;
          let fpsVal = 'native';
          if (fm && typeof fm === 'object' && fm.capped) fpsVal = String(fm.capped);
          else if (fm === 'native') fpsVal = 'native';

          return `
      <div class="camera-entry" data-index="${i}">
        <span class="api-index" title="API: /api/solo/${i + 1}">Camera ${i + 1}</span>
        <input type="text" placeholder="Camera name" value="${escapeHtml(cam.name)}" data-field="name" />
        <input type="text" placeholder="rtp://224.1.2.4:4000" value="${escapeHtml(cam.url)}" data-field="url" />
        <div class="cam-overrides">
          <div class="cam-override-field">
            <span class="cam-override-label">Quality</span>
            <select class="cam-quality" title="Quality override">
              <option value=""${q === '' ? ' selected' : ''}>Global</option>
              <option value="low"${q === 'low' ? ' selected' : ''}>Low</option>
              <option value="medium"${q === 'medium' ? ' selected' : ''}>Med</option>
              <option value="high"${q === 'high' ? ' selected' : ''}>High</option>
            </select>
          </div>
          <div class="cam-override-field">
            <span class="cam-override-label">FPS</span>
            <select class="cam-fps" title="FPS override">
              <option value="native"${fpsVal === 'native' ? ' selected' : ''}>Native</option>
              <option value="5"${fpsVal === '5' ? ' selected' : ''}>5 fps</option>
              <option value="10"${fpsVal === '10' ? ' selected' : ''}>10 fps</option>
              <option value="15"${fpsVal === '15' ? ' selected' : ''}>15 fps</option>
            </select>
          </div>
        </div>
        <button class="remove-btn" data-remove-index="${i}">✕</button>
      </div>
    `;
        }
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
    if (entries[index]) {
      entries[index].remove();
      // Re-index remaining entries to prevent stale closure indices
      list.querySelectorAll('.camera-entry').forEach((entry, i) => {
        entry.dataset.index = i;
        const removeBtn = entry.querySelector('[data-remove-index]');
        if (removeBtn) removeBtn.dataset.removeIndex = i;
      });
      // Re-bind remove handlers with correct indices
      list.querySelectorAll('[data-remove-index]').forEach(btn => {
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);
        newBtn.addEventListener('click', () => this.removeCameraField(parseInt(newBtn.dataset.removeIndex)));
      });
    }
  }

  async saveSettings() {
    const entries = document.querySelectorAll("#camera-list .camera-entry");
    const cameras = [];

    // Build a map of existing cameras by URL for ID and codec_override preservation
    const existingCamerasMap = new Map(this.cameras.map(c => [c.url, c]));

    entries.forEach((entry) => {
      const name = entry.querySelector('[data-field="name"]').value.trim();
      const url = entry.querySelector('[data-field="url"]').value.trim();
      if (url) {
        const existingCamera = existingCamerasMap.get(url);
        const camera = {
          id: existingCamera?.id || crypto.randomUUID(),
          name: name || `Camera ${cameras.length + 1}`,
          url,
        };
        // Read inline quality/fps dropdowns
        const qualitySel = entry.querySelector('.cam-quality');
        const fpsSel = entry.querySelector('.cam-fps');
        if (qualitySel && fpsSel) {
          const qVal = qualitySel.value;
          const fVal = fpsSel.value;
          if (qVal !== '' || fVal !== 'native') {
            camera.codec_override = {
              quality: qVal || 'medium',
              fps_mode: fVal === 'native' ? 'native' : { capped: parseInt(fVal) },
            };
          }
        } else if (existingCamera?.codec_override) {
          camera.codec_override = existingCamera.codec_override;
        }
        cameras.push(camera);
      }
    });

    const intervalHours = parseInt(document.getElementById("shuffle-interval-hours").value, 10) || 0;
    const intervalMins = parseInt(document.getElementById("shuffle-interval-minutes").value, 10) || 0;
    const totalMinutes = Math.max(1, Math.min(1440, intervalHours * 60 + intervalMins || 15));
    const shuffleIntervalSecs = totalMinutes * 60;

    const showStatusDots = document.getElementById("show-status-dots").checked;
    const showCameraNames = document.getElementById("show-camera-names").checked;
    const apiPort = parseInt(document.getElementById("api-port").value, 10) || 8090;

    // Save quality setting
    const streamConfig = {
      quality: document.getElementById("quality-preset-select").value,
    };

    try {
      // Read existing config to preserve window_state and other fields
      const config = await invoke("get_config");
      config.cameras = cameras;
      config.shuffle_interval_secs = shuffleIntervalSecs;
      config.show_status_dots = showStatusDots;
      config.show_camera_names = showCameraNames;
      config.api_port = apiPort;
      config.stream_config = streamConfig;

      await invoke("save_config", { config });

      this.cameras = cameras;
      this.displayOrder = this.cameras.map((_, i) => i); // reinitialize display order
      this.shuffleIntervalSecs = shuffleIntervalSecs;
      this.showStatusDots = showStatusDots;
      this.showCameraNames = showCameraNames;
      this.apiPort = apiPort;

      // Restart streams with new camera list and codec settings
      this._stopAllReaders();
      await invoke("stop_streams");
      this.render();
      this.startShuffleTimer();
      if (this.cameras.length > 0) {
        await invoke("start_streams");
      }
      this.closeSettings();
    } catch (err) {
      console.error("Failed to save settings:", err);
      this.showToast("Failed to save settings: " + err, 'error');
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
      this.saveCameraOrder().catch(err => {
        console.error("Failed to save camera order:", err);
        this.showToast("Failed to save camera order", 'error');
      });
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

  // ── Serialized Config Save ──────────────────────────────────────────────

  /**
   * Serializes config save operations to prevent concurrent get_config/save_config races.
   * @param {Function} mutator - async function that receives config, mutates it, and returns it
   */
  async serializedConfigSave(mutator) {
    // Chain onto any in-flight save to serialize access
    const doSave = async () => {
      const config = await invoke("get_config");
      const updated = await mutator(config);
      if (updated) {
        await invoke("save_config", { config: updated });
      }
    };

    if (this._configSavePromise) {
      this._configSavePromise = this._configSavePromise.then(doSave, doSave);
    } else {
      this._configSavePromise = doSave();
    }

    try {
      await this._configSavePromise;
    } finally {
      // Clear the chain when it settles so we don't keep old promises
      this._configSavePromise = null;
    }
  }

  // ── Window State Persistence ────────────────────────────────────────────

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
