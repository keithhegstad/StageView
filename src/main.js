// ── StageView ────────────────────────────────────────────────────────────────
// Lightweight multi-camera grid viewer with burn-in protection.
// Streams are rendered via video element (H.264/MSE) with fMP4 codec copy.

function invoke(cmd, args) {
  return window.__TAURI__.core.invoke(cmd, args);
}

function listen(event, callback) {
  return window.__TAURI__.event.listen(event, callback);
}

function getCurrentWindow() {
  return window.__TAURI__.window.getCurrentWindow();
}

function getAppVersion() {
  return window.__TAURI__.app.getVersion();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ── MSE-based fMP4 Stream Reader ────────────────────────────────────────────
// Reads fMP4 stream via fetch() and feeds it to a <video> element using
// Media Source Extensions for hardware-accelerated H.264 decode.
// No transcoding needed - direct playback of H.264 RTP streams.

class Mp4StreamReader {
  constructor(url, video) {
    this.url = url;
    this.video = video;
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.abortController = null;
    this.running = false;
    this._firstFrame = false;
    this.onFirstFrame = null;
    this.onError = null;
    this.queue = []; // Buffer queue for segments
    this.isUpdating = false;
    this._trimTimer = null; // Periodic buffer trimming
    this._restarting = false; // Guard against concurrent restarts
    this._restartCount = 0; // Restart throttle counter
    this._lastRestartAt = 0; // Timestamp of last restart
    this._freezeCanvas = null; // Canvas element used to hold last frame during restarts
    this._lastCorruptedCount = 0; // Track corruptedVideoFrames for glitch detection
    this._lastGoodFrameAt = 0; // Timestamp of last known-good frame capture

    // Bind video event handlers so they can be removed on restart
    this._onVideoError = (e) => {
      const msg = this.video.error?.message || '';
      // MSE parsing errors are recoverable — restart the pipeline
      if (msg.includes('CHUNK_DEMUXER') || msg.includes('PIPELINE_ERROR')
          || msg.includes('stream parsing failed') || msg.includes('Append')) {
        console.warn('[Mp4StreamReader] Recoverable video error, restarting pipeline:', msg);
        this._restart();
      } else {
        if (this.onError) this.onError(msg || 'Video playback error');
      }
    };
    this._onVideoWaiting = () => this._chaseLiveEdge();

    this.video.addEventListener('error', this._onVideoError);
    this.video.addEventListener('waiting', this._onVideoWaiting);

    this._initMediaSource();
  }

  /** Create (or recreate) the MediaSource + SourceBuffer pipeline */
  _initMediaSource() {
    // Check for MSE support
    if (!window.MediaSource) {
      console.error('MediaSource API not supported in this browser');
      if (this.onError) this.onError('MediaSource API not supported');
      return;
    }

    this.mediaSource = new MediaSource();
    this.video.src = URL.createObjectURL(this.mediaSource);

    this.mediaSource.addEventListener('sourceopen', () => {
      try {
        const codec = 'video/mp4; codecs="avc1.42E01E"';
        if (!MediaSource.isTypeSupported(codec)) {
          if (this.onError) this.onError('H.264 codec not supported');
          return;
        }

        this.sourceBuffer = this.mediaSource.addSourceBuffer(codec);
        this.sourceBuffer.mode = 'sequence';
        
        this.sourceBuffer.addEventListener('updateend', () => {
          this.isUpdating = false;
          this._chaseLiveEdge();
          this._processQueue();
        });

        this.sourceBuffer.addEventListener('error', (e) => {
          console.warn('[Mp4StreamReader] SourceBuffer error, restarting pipeline');
          this._restart();
        });

        // Start periodic buffer trimming (every 5s) and corrupt-frame monitor
        if (this._trimTimer) clearInterval(this._trimTimer);
        this._trimTimer = setInterval(() => {
          this._trimBuffer();
          this._checkCorruptFrames();
        }, 5000);
      } catch (e) {
        if (this.onError) this.onError('Failed to create SourceBuffer');
      }
    });

    this.mediaSource.addEventListener('error', (e) => {
      console.warn('[Mp4StreamReader] MediaSource error, restarting pipeline');
      this._restart();
    });
  }

  /**
   * Capture the current video frame onto a canvas overlay so the user
   * sees the last good frame while the MSE pipeline is being rebuilt.
   * The canvas is placed inside the same tile parent as the <video>.
   */
  _captureFrame() {
    if (!this.video || this.video.readyState < 2 || this.video.videoWidth === 0) return;
    try {
      const tile = this.video.parentElement;
      if (!tile) return;

      if (!this._freezeCanvas) {
        this._freezeCanvas = document.createElement('canvas');
        this._freezeCanvas.className = 'freeze-frame';
        tile.appendChild(this._freezeCanvas);
      }

      this._freezeCanvas.width = this.video.videoWidth;
      this._freezeCanvas.height = this.video.videoHeight;
      const ctx = this._freezeCanvas.getContext('2d');
      ctx.drawImage(this.video, 0, 0);
      this._freezeCanvas.style.display = 'block';
    } catch (e) {
      // Canvas draw can fail if video is tainted — ignore silently
    }
  }

  /**
   * Periodically snapshot a known-good frame (every ~10s) so that when
   * corruption is detected, we have a recent clean frame to show.
   * Only captures if no corruption has been detected recently.
   * Cost: one drawImage every 10s per camera — negligible.
   */
  _captureGoodFrame() {
    if (!this.video || this.video.readyState < 2 || this.video.videoWidth === 0) return;
    const now = Date.now();
    if (now - this._lastGoodFrameAt < 10000) return; // Max once per 10s
    try {
      const tile = this.video.parentElement;
      if (!tile) return;

      if (!this._freezeCanvas) {
        this._freezeCanvas = document.createElement('canvas');
        this._freezeCanvas.className = 'freeze-frame';
        tile.appendChild(this._freezeCanvas);
      }

      this._freezeCanvas.width = this.video.videoWidth;
      this._freezeCanvas.height = this.video.videoHeight;
      const ctx = this._freezeCanvas.getContext('2d');
      ctx.drawImage(this.video, 0, 0);
      // Don't display it — just keep it ready
      this._lastGoodFrameAt = now;
    } catch (e) { /* ignore */ }
  }

  /**
   * Check the browser's video decode quality counters. If corruptedVideoFrames
   * increases, briefly show the freeze canvas to mask the glitch.
   * Reads a pre-existing browser counter — costs essentially zero CPU.
   */
  _checkCorruptFrames() {
    if (!this.video || !this._firstFrame) return;
    const quality = this.video.getVideoPlaybackQuality?.();
    if (!quality) return;

    const corrupt = quality.corruptedVideoFrames || 0;
    if (corrupt > this._lastCorruptedCount) {
      console.warn(`[Mp4StreamReader] ${corrupt - this._lastCorruptedCount} corrupt frame(s) detected for ${this.url}`);
      // Show freeze canvas briefly to mask visible artifacts
      if (this._freezeCanvas && this._lastGoodFrameAt > 0) {
        this._freezeCanvas.style.display = 'block';
        // Hide after 300ms — just long enough to cover the glitch frames
        setTimeout(() => {
          if (this._freezeCanvas) this._freezeCanvas.style.display = 'none';
        }, 300);
      }
    }
    this._lastCorruptedCount = corrupt;

    // Periodically capture a known-good frame for future use
    if (corrupt === this._lastCorruptedCount) {
      this._captureGoodFrame();
    }
  }

  /**
   * Schedule freeze-frame removal: waits for the video to actually
   * decode and render a frame (timeupdate event) before hiding the
   * canvas. Falls back to a 5s safety timer to prevent stuck overlays.
   */
  _scheduleFreezeRemoval() {
    if (!this._freezeCanvas || this._freezeCanvas.style.display !== 'block') return;
    // Already scheduled?
    if (this._freezeRemovalBound) return;

    this._freezeRemovalBound = () => {
      this.video.removeEventListener('timeupdate', this._freezeRemovalBound);
      if (this._freezeSafetyTimer) { clearTimeout(this._freezeSafetyTimer); this._freezeSafetyTimer = null; }
      this._freezeRemovalBound = null;
      if (this._freezeCanvas) this._freezeCanvas.style.display = 'none';
    };

    // timeupdate fires once actual decoded frames are being rendered
    this.video.addEventListener('timeupdate', this._freezeRemovalBound);

    // Safety: remove after 5s even if timeupdate never fires
    this._freezeSafetyTimer = setTimeout(() => {
      if (this._freezeRemovalBound) {
        this.video.removeEventListener('timeupdate', this._freezeRemovalBound);
        this._freezeRemovalBound = null;
      }
      this._freezeSafetyTimer = null;
      if (this._freezeCanvas) this._freezeCanvas.style.display = 'none';
    }, 5000);
  }

  /**
   * Auto-recover from fatal MSE errors (CHUNK_DEMUXER_ERROR, etc).
   * Tears down the broken MediaSource pipeline and rebuilds it, then
   * reconnects to the HTTP stream. Throttled to prevent tight loops.
   */
  _restart() {
    if (this._restarting || !this.running) return;
    this._restarting = true;

    // Capture last good frame before tearing down the pipeline
    this._captureFrame();

    // Throttle: max 1 restart per 3 seconds
    const now = Date.now();
    const elapsed = now - this._lastRestartAt;
    const delay = elapsed < 3000 ? 3000 - elapsed : 0;

    setTimeout(() => {
      this._lastRestartAt = Date.now();
      this._restartCount++;
      console.log(`[Mp4StreamReader] Pipeline restart #${this._restartCount} for ${this.url}`);

      // Abort current fetch
      if (this.abortController) {
        this.abortController.abort();
        this.abortController = null;
      }

      // Tear down old MSE state
      this.queue = [];
      this.isUpdating = false;
      this._firstFrame = false;
      if (this._trimTimer) { clearInterval(this._trimTimer); this._trimTimer = null; }

      try {
        if (this.sourceBuffer && this.mediaSource?.readyState === 'open') {
          if (!this.sourceBuffer.updating) {
            this.mediaSource.removeSourceBuffer(this.sourceBuffer);
          }
        }
      } catch (e) { /* ignore cleanup errors */ }
      try {
        if (this.mediaSource?.readyState === 'open') {
          this.mediaSource.endOfStream();
        }
      } catch (e) { /* ignore */ }
      this.sourceBuffer = null;
      this.mediaSource = null;

      // Rebuild the pipeline and reconnect
      this._initMediaSource();
      this._restarting = false;
      this.start();
    }, delay);
  }

  async start() {
    if (!this.mediaSource) return;

    this.abortController = new AbortController();
    this.running = true;
    let retryDelay = 1000;
    let bytesReceived = 0;

    while (this.running) {
      try {
        const response = await fetch(this.url, { signal: this.abortController.signal });
        
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const reader = response.body.getReader();
        retryDelay = 1000;

        // Start a 15s first-data timeout. If no bytes arrive within 15s
        // of a successful HTTP connection, the stream source is likely
        // offline (FFmpeg waiting for multicast data that never comes).
        let firstDataTimer = null;
        if (!this._firstFrame) {
          firstDataTimer = setTimeout(() => {
            if (!this._firstFrame && this.running) {
              if (this.onError) this.onError('No data received — camera may be offline');
            }
          }, 15000);
        }

        while (this.running) {
          const { done, value } = await reader.read();
          if (done) break;

          if (value && value.byteLength > 0) {
            bytesReceived += value.byteLength;
            
            if (this.sourceBuffer) {
              this.queue.push(value);
              this._processQueue();

              // Trigger first-frame callback and eagerly play
              if (!this._firstFrame) {
                this._firstFrame = true;
                if (firstDataTimer) { clearTimeout(firstDataTimer); firstDataTimer = null; }
                this.video.play().catch(() => {});
                // Defer freeze-frame removal until video actually renders
                this._scheduleFreezeRemoval();
                if (this.onFirstFrame) this.onFirstFrame();
              }
            }
          }
        }
      } catch (e) {
        if (e.name === 'AbortError' || !this.running) return;
        if (this.onError && bytesReceived === 0) {
          this.onError('Stream connection failed');
        }
      }

      if (!this.running) return;
      await new Promise(r => setTimeout(r, retryDelay));
      retryDelay = Math.min(retryDelay * 2, 5000);
    }
  }

  _processQueue() {
    if (this.isUpdating || this.queue.length === 0 || !this.sourceBuffer) return;

    try {
      let segment;
      if (this.queue.length === 1) {
        segment = this.queue.shift();
      } else {
        // Merge all queued segments into a single appendBuffer call
        // This reduces MSE overhead when multiple chunks arrive during an update
        const totalLen = this.queue.reduce((sum, s) => sum + s.byteLength, 0);
        const merged = new Uint8Array(totalLen);
        let offset = 0;
        for (const s of this.queue) {
          merged.set(s instanceof Uint8Array ? s : new Uint8Array(s.buffer || s), offset);
          offset += s.byteLength;
        }
        this.queue = [];
        segment = merged;
      }
      this.isUpdating = true;
      this.sourceBuffer.appendBuffer(segment);
    } catch (e) {
      this.isUpdating = false;
      this.queue = [];
      // QuotaExceededError: buffer full — trim aggressively and retry next tick
      if (e.name === 'QuotaExceededError') {
        this._trimBuffer();
      } else if (e.name === 'InvalidStateError') {
        // SourceBuffer removed or MediaSource closed — need full restart
        console.warn('[Mp4StreamReader] InvalidStateError in appendBuffer, restarting');
        this._restart();
      }
    }
  }

  /** Jump to the live edge if playback falls behind */
  _chaseLiveEdge() {
    if (!this.video || this.video.readyState < 2) return;
    const buffered = this.video.buffered;
    if (buffered.length === 0) return;
    
    const end = buffered.end(buffered.length - 1);
    const current = this.video.currentTime;
    
    // If more than 0.5s behind live edge, jump forward
    if (end - current > 0.5) {
      this.video.currentTime = end - 0.05; // 50ms behind live
    }
  }

  /** Trim old buffer data to prevent unbounded memory growth */
  _trimBuffer() {
    if (!this.sourceBuffer || this.sourceBuffer.updating) return;
    if (!this.video || this.video.buffered.length === 0) return;
    
    const buffered = this.video.buffered;
    const end = buffered.end(buffered.length - 1);
    const start = buffered.start(0);
    
    // Keep only the last 4 seconds of data
    if (end - start > 4) {
      try {
        this.sourceBuffer.remove(start, end - 3);
      } catch (e) { /* ignore */ }
    }
  }

  stop() {
    this.running = false;
    if (this.abortController) this.abortController.abort();
    if (this._trimTimer) { clearInterval(this._trimTimer); this._trimTimer = null; }
    this.queue = [];
    this._firstFrame = false;

    // Clean up freeze-frame state
    if (this._freezeRemovalBound) {
      this.video.removeEventListener('timeupdate', this._freezeRemovalBound);
      this._freezeRemovalBound = null;
    }
    if (this._freezeSafetyTimer) { clearTimeout(this._freezeSafetyTimer); this._freezeSafetyTimer = null; }
    if (this._freezeCanvas) {
      this._freezeCanvas.remove();
      this._freezeCanvas = null;
    }

    // Remove video event listeners
    this.video.removeEventListener('error', this._onVideoError);
    this.video.removeEventListener('waiting', this._onVideoWaiting);

    try {
      if (this.sourceBuffer && !this.sourceBuffer.updating) {
        this.mediaSource.removeSourceBuffer(this.sourceBuffer);
      }
      if (this.mediaSource.readyState === 'open') {
        this.mediaSource.endOfStream();
      }
    } catch (e) {
      // Ignore cleanup errors
    }
  }

  draw() {
    // MSE handles rendering automatically, no manual draw needed
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
    this.previousHealthValues = new Map(); // stores previous health values for change detection
    this.healthStats = new Map(); // camera_id -> health object
    this._healthDisplayTimer = null; // debounce timer for updateHealthDisplay
    this._healthStateCounters = new Map(); // hysteresis counters for health state transitions
    this.cameraStatuses = new Map(); // camera_id -> status string (online/offline/connecting/reconnecting)
    this._configSavePromise = null; // serializes config save operations
    this.streamReaders = new Map(); // camera_id -> Mp4StreamReader
    this._countdownTimer = null;
    this._idleTimer = null;
    this._isIdle = false;
    this._pendingUpdate = null; // cached update object from plugin-updater
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
        this._scheduleHealthUpdate();
      });

      // Listen for stream errors (deduplicate per camera to prevent toast flood)
      this._activeErrorToasts = this._activeErrorToasts || new Map();
      this.unlistenStreamError = await listen("stream-error", (event) => {
        const { camera_id, error } = event.payload;
        // Skip if a toast for this camera is already showing
        if (this._activeErrorToasts.has(camera_id)) return;
        const camera = this.cameras.find(c => c.id === camera_id);
        const cameraName = camera ? camera.name : camera_id;
        this._activeErrorToasts.set(camera_id, true);
        this.showToast(`${cameraName}: ${error}`, 'error');
        // Clear duplicate guard after toast duration (10s) + fade (300ms)
        setTimeout(() => this._activeErrorToasts.delete(camera_id), 10300);
      });

      // Listen for reload-config event
      await listen("reload-config", () => {
        location.reload();
      });

      // Start FFmpeg immediately (fire-and-forget) so streams begin probing
      // before the DOM is built. By the time fetch() connects from the UI,
      // FFmpeg may already have the init segment cached for instant playback.
      if (this.cameras.length > 0) {
        invoke("start_streams").catch(err => {
          console.error("Failed to start streams:", err);
        });
      }

      this.render();
      this._startRenderLoop();
      this.startShuffleTimer();

    } catch (err) {
      this.render();
    }

    this.bindUIEvents();
    this.bindKeys();
    this.updateToolbar();
    this.setupWindowStatePersistence();
    this.setupIdleHiding();

    // Set version label & auto-check for updates (silent)
    this.initUpdater();
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
    document.getElementById('check-update-btn').addEventListener('click', () => this.checkForUpdates(true));

    // Update modal buttons
    document.getElementById('update-close-btn').addEventListener('click', () => this.closeUpdateModal());
    document.getElementById('update-overlay').addEventListener('click', () => this.closeUpdateModal());
    document.getElementById('update-later-btn').addEventListener('click', () => this.closeUpdateModal());
    document.getElementById('update-now-btn').addEventListener('click', () => this.installUpdate());
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
        <video autoplay muted playsinline crossorigin="anonymous"></video>
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

    // Create stream reader for each tile
    grid.querySelectorAll(".camera-tile").forEach((tile) => {
      const camId = tile.dataset.id;
      if (!camId) return;

      const url = `http://localhost:${this.apiPort}/camera/${camId}/stream`;
      const video = tile.querySelector("video");
      if (!video) return;
      
      const reader = new Mp4StreamReader(url, video);
      
      reader.onFirstFrame = () => {
        video.classList.add("has-frame");
        const spinner = tile.querySelector(".loading-spinner");
        if (spinner) spinner.style.display = "none";
        const statusEl = tile.querySelector(".camera-status");
        if (statusEl) {
          statusEl.classList.remove("offline", "reconnecting");
        }
      };

      // No onError handler — transient MSE/stream errors are auto-recovered
      // by the pipeline restart logic. Only true failures (3+ backend retries)
      // show a toast via the "stream-error" Tauri event.

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

    });
  }

  // ── Canvas Rendering Helpers ────────────────────────────────────────────

  _startRenderLoop() {
    if (this._countdownTimer) return;
    // Countdown only needs 1 update per second.
    // MSE handles video rendering automatically — no manual draw() needed.
    this._countdownTimer = setInterval(() => {
      this.updateCountdown();
    }, 1000);
  }

  _stopRenderLoop() {
    if (this._countdownTimer) {
      clearInterval(this._countdownTimer);
      this._countdownTimer = null;
    }
  }

  _stopAllReaders() {
    for (const reader of this.streamReaders.values()) {
      reader.stop();
    }
    this.streamReaders.clear();
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

    // Hide non-solo tiles but keep all stream readers running.
    // Hidden video elements consume minimal resources, and FFmpeg stays active
    // in the backend, so switching back to grid view is instant.
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
    grid.style.position = "";

    // Notify backend (streams stay running for instant grid recovery)
    await invoke("solo_camera", { cameraId: cam.id });

    this.updateToolbar();

    // Reset shuffle timer for pixel refresh in solo mode
    this.startShuffleTimer();
  }

  async exitSolo() {
    if (this.soloIndex === null) return;
    this.soloIndex = null;

    const grid = document.getElementById("grid");
    const cols = Math.ceil(Math.sqrt(this.cameras.length));
    const rows = Math.ceil(this.cameras.length / cols);

    // Restore grid layout and show all tiles instantly (no DOM rebuild).
    // All stream readers stayed running, so cameras appear immediately.
    grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;

    grid.querySelectorAll(".camera-tile").forEach((tile) => {
      tile.classList.remove("solo");
      tile.style.display = "";
    });

    // Restore display order from shuffle state
    grid.querySelectorAll(".camera-tile").forEach((tile) => {
      const camId = tile.dataset.id;
      const camIndex = this.cameras.findIndex(c => c.id === camId);
      const orderPos = this.displayOrder.indexOf(camIndex);
      tile.style.order = orderPos >= 0 ? orderPos : 0;
    });

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
        this.previousHealthValues.clear();
        this._healthStateCounters.clear();
        this._scheduleHealthUpdate();
        return;
      }
      // Camera list changed — tear down and rebuild; clear stale cache
      this.previousHealthValues.clear();
      this._healthStateCounters.clear();
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
      this._scheduleHealthUpdate();
    } catch (err) {
      console.error("Failed to fetch stream health:", err);
      this._scheduleHealthUpdate();
    }
  }

  _scheduleHealthUpdate() {
    if (this._healthDisplayTimer !== null) return;
    this._healthDisplayTimer = setTimeout(() => {
      this._healthDisplayTimer = null;
      this.updateHealthDisplay();
    }, 1000);
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
    for (const cameraId of this._healthStateCounters.keys()) {
      if (!currentCameraIds.has(cameraId)) {
        this._healthStateCounters.delete(cameraId);
      }
    }

    this.healthStats.forEach((health, cameraId) => {
      const card = container.querySelector(`[data-camera-id="${cameraId}"]`);
      if (!card) return;

      const fpsEl = card.querySelector('[data-metric="fps"]');
      const bitrateEl = card.querySelector('[data-metric="bitrate"]');
      const uptimeEl = card.querySelector('[data-metric="uptime"]');
      const resolutionEl = card.querySelector('[data-metric="resolution"]');
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
        codec: codecText
      });

      // Determine health state based on FPS
      let desiredState;
      if (health.fps > 0) {
        desiredState = 'online';
      } else if (health.uptime_secs > 0) {
        desiredState = 'warn';
      } else {
        desiredState = 'error';
      }

      // Hysteresis: require 3 consecutive same readings before changing
      const counter = this._healthStateCounters.get(cameraId) || { state: desiredState, count: 0 };
      if (counter.state === desiredState) {
        counter.count++;
      } else {
        counter.state = desiredState;
        counter.count = 1;
      }
      this._healthStateCounters.set(cameraId, counter);

      const prevState = card.getAttribute('data-health-state');
      const threshold = prevState === 'unknown' ? 1 : 3;
      if (counter.count >= threshold && prevState !== desiredState) {
        card.setAttribute('data-health-state', desiredState);
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

  // ── Update Logic ──────────────────────────────────────────────────────────

  async initUpdater() {
    try {
      const ver = await getAppVersion();
      const versionEl = document.getElementById('current-version');
      if (versionEl) versionEl.textContent = 'v' + ver;
    } catch (_) {}

    // Silent auto-check after 3 seconds
    setTimeout(() => this.checkForUpdates(false), 3000);
  }

  async checkForUpdates(manual = false) {
    const btn = document.getElementById('check-update-btn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Checking...';
    }

    try {
      const { check } = window.__TAURI_PLUGIN_UPDATER__ || await import('@tauri-apps/plugin-updater');
      const update = await check();

      if (update?.available) {
        this._pendingUpdate = update;
        this.showUpdateModal(update);
      } else if (manual) {
        this.showToast('You\'re on the latest version', 'success');
      }
    } catch (err) {
      console.error('Update check failed:', err);
      if (manual) {
        this.showToast('Update check failed: ' + err, 'error');
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Check for Updates';
      }
    }
  }

  showUpdateModal(update) {
    const overlay = document.getElementById('update-overlay');
    const modal = document.getElementById('update-modal');
    const curVer = document.getElementById('update-current-ver');
    const newVer = document.getElementById('update-new-ver');
    const changelog = document.getElementById('update-changelog');
    const progress = document.getElementById('update-progress');
    const footer = document.getElementById('update-footer');
    const nowBtn = document.getElementById('update-now-btn');

    curVer.textContent = 'v' + (update.currentVersion || '');
    newVer.textContent = 'v' + (update.version || '');
    changelog.textContent = update.body || '';

    // Reset state
    progress.classList.add('hidden');
    footer.style.display = '';
    nowBtn.disabled = false;
    nowBtn.textContent = 'Update Now';

    overlay.classList.remove('hidden');
    modal.classList.remove('hidden');
    requestAnimationFrame(() => {
      overlay.classList.add('visible');
      modal.classList.add('visible');
    });
  }

  closeUpdateModal() {
    const overlay = document.getElementById('update-overlay');
    const modal = document.getElementById('update-modal');

    overlay.classList.remove('visible');
    modal.classList.remove('visible');

    setTimeout(() => {
      overlay.classList.add('hidden');
      modal.classList.add('hidden');
    }, 250);
  }

  async installUpdate() {
    const update = this._pendingUpdate;
    if (!update) return;

    const nowBtn = document.getElementById('update-now-btn');
    const laterBtn = document.getElementById('update-later-btn');
    const closeBtn = document.getElementById('update-close-btn');
    const progress = document.getElementById('update-progress');
    const progressFill = document.getElementById('update-progress-fill');
    const progressText = document.getElementById('update-progress-text');

    // Disable buttons during download
    nowBtn.disabled = true;
    nowBtn.textContent = 'Downloading...';
    laterBtn.style.display = 'none';
    closeBtn.style.display = 'none';
    progress.classList.remove('hidden');
    progressFill.style.width = '0%';
    progressText.textContent = 'Downloading...';

    try {
      let downloaded = 0;
      let contentLength = 0;

      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            contentLength = event.data.contentLength || 0;
            break;
          case 'Progress':
            downloaded += event.data.chunkLength || 0;
            if (contentLength > 0) {
              const pct = Math.min(100, Math.round((downloaded / contentLength) * 100));
              progressFill.style.width = pct + '%';
              const mb = (downloaded / 1048576).toFixed(1);
              const totalMb = (contentLength / 1048576).toFixed(1);
              progressText.textContent = `${mb} / ${totalMb} MB (${pct}%)`;
            }
            break;
          case 'Finished':
            progressFill.style.width = '100%';
            progressText.textContent = 'Restarting...';
            break;
        }
      });

      // The app will restart automatically via the NSIS passive installer
      // If for some reason it didn't, prompt the user
      setTimeout(() => {
        progressText.textContent = 'Update installed. Please restart the app.';
        nowBtn.textContent = 'Restart';
        nowBtn.disabled = false;
        nowBtn.onclick = async () => {
          try {
            const { relaunch } = window.__TAURI__.process;
            await relaunch();
          } catch (_) {
            progressText.textContent = 'Please close and reopen StageView.';
          }
        };
      }, 3000);

    } catch (err) {
      console.error('Update install failed:', err);
      progressText.textContent = 'Update failed: ' + err;
      nowBtn.textContent = 'Retry';
      nowBtn.disabled = false;
      laterBtn.style.display = '';
      closeBtn.style.display = '';
      nowBtn.onclick = () => this.installUpdate();
    }
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
          return `
      <div class="camera-entry" data-index="${i}">
        <span class="api-index" title="API: /api/solo/${i + 1}">Camera ${i + 1}</span>
        <input type="text" placeholder="Camera name" value="${escapeHtml(cam.name)}" data-field="name" />
        <input type="text" placeholder="rtp://224.1.2.4:4000" value="${escapeHtml(cam.url)}" data-field="url" />
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

    // Build a map of existing cameras by URL for ID preservation
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

    try {
      // Read existing config to preserve window_state and other fields
      const config = await invoke("get_config");
      config.cameras = cameras;
      config.shuffle_interval_secs = shuffleIntervalSecs;
      config.show_status_dots = showStatusDots;
      config.show_camera_names = showCameraNames;
      config.api_port = apiPort;

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
      this.showToast("Failed to save settings: " + err, 'error');
    }
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
          // Silently fail
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
      document.body.classList.remove('cursor-hidden');

      clearTimeout(this._idleTimer);
      this._idleTimer = setTimeout(hideUI, IDLE_TIMEOUT);
    };

    const hideUI = () => {
      this._isIdle = true;
      toolbar.classList.remove('visible');
      document.body.classList.add('cursor-hidden');
    };

    document.addEventListener('mousemove', showUI);
    document.addEventListener('mousedown', showUI);

    // Start visible, then begin idle timer
    showUI();
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

let app;

window.addEventListener("DOMContentLoaded", () => {
  if (window.__TAURI__) {
    app = new StageView();
  }
});
