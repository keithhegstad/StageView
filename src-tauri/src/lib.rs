use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::process::Command;
use tracing::{error, info, debug};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

// ── Data Models ──────────────────────────────────────────────────────────────

// ── Codec Configuration ──────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Quality {
    Low,     // 720p max, 10 fps
    Medium,  // 1080p max, 15 fps
    High,    // Original resolution, uncapped fps
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FpsMode {
    Native,      // No -r flag - use camera's native FPS
    #[serde(rename = "capped")]
    Capped(u32), // Add -r N to cap FPS
}

impl Default for FpsMode {
    fn default() -> Self {
        FpsMode::Native
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct CameraCodecSettings {
    pub quality: Quality,
    pub fps_mode: FpsMode,
}

impl Default for CameraCodecSettings {
    fn default() -> Self {
        Self {
            quality: Quality::Medium,
            fps_mode: FpsMode::Native,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct StreamConfig {
    pub quality: Quality,
}

impl Default for StreamConfig {
    fn default() -> Self {
        Self {
            quality: Quality::Medium,
        }
    }
}

// ── Camera Models ────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Camera {
    pub id: String,
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub codec_override: Option<CameraCodecSettings>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WindowState {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

impl Default for WindowState {
    fn default() -> Self {
        Self { x: 100, y: 100, width: 1280, height: 720, maximized: false }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AppConfig {
    pub cameras: Vec<Camera>,
    pub shuffle_interval_secs: u64,
    #[serde(default = "default_true")]
    pub show_status_dots: bool,
    #[serde(default = "default_true")]
    pub show_camera_names: bool,
    #[serde(default = "default_api_port")]
    pub api_port: u16,
    #[serde(default)]
    pub window_state: WindowState,
    #[serde(default)]
    pub stream_config: StreamConfig,
}

fn default_true() -> bool { true }
fn default_api_port() -> u16 { 8090 }

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            cameras: vec![],
            shuffle_interval_secs: 900,
            show_status_dots: true,
            show_camera_names: true,
            api_port: 8090,
            window_state: WindowState::default(),
            stream_config: StreamConfig::default(),
        }
    }
}

#[derive(Serialize, Clone)]
struct CameraStatusEvent {
    camera_id: String,
    status: String, // "online", "offline", "error"
}

#[derive(Serialize, Clone)]
struct RemoteCommandEvent {
    command: String,  // "solo" or "grid"
    index: Option<usize>,  // 1-based camera index for solo
}

#[derive(Serialize, Clone, Debug)]
pub struct StreamHealth {
    pub camera_id: String,
    pub fps: f32,
    pub bitrate_kbps: f32,
    pub frame_count: u64,
    pub last_frame_at: u64, // Unix timestamp in milliseconds
    pub uptime_secs: u64,
    pub resolution: Option<String>, // e.g. "1920x1080"
    pub quality_setting: String, // "Low", "Medium", "High"
    pub codec: String, // "MJPEG", "H264"
}

#[derive(Serialize, Clone)]
struct StreamHealthEvent {
    camera_id: String,
    health: StreamHealth,
}

#[derive(Serialize, Clone)]
struct StreamErrorEvent {
    camera_id: String,
    error: String,
}

// ── Buffer Pool ──────────────────────────────────────────────────────────────

/// Reusable buffer pool to prevent memory fragmentation
struct BufferPool {
    buffers: Mutex<Vec<Vec<u8>>>,
    max_buffers: usize,
}

impl BufferPool {
    fn new(max_buffers: usize) -> Self {
        Self {
            buffers: Mutex::new(Vec::new()),
            max_buffers,
        }
    }

    fn acquire(&self) -> Vec<u8> {
        let mut pool = match self.buffers.lock() {
            Ok(p) => p,
            Err(poisoned) => {
                error!("BufferPool mutex poisoned, recovering");
                poisoned.into_inner()
            }
        };
        pool.pop().unwrap_or_else(|| Vec::with_capacity(64 * 1024))
    }

    fn release(&self, mut buf: Vec<u8>) {
        buf.clear();

        // If lock fails, simply drop the buffer (acceptable failure mode)
        if let Ok(mut pool) = self.buffers.lock() {
            if pool.len() < self.max_buffers {
                pool.push(buf);
            }
        }
    }
}

// ── App State ────────────────────────────────────────────────────────────────

struct AppState {
    config: Mutex<AppConfig>,
    config_path: String,
    ffmpeg_path: PathBuf,
    stream_tasks: Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>,
    reconnect_attempts: Mutex<HashMap<String, u32>>, // camera_id -> attempt count
    stream_health: Mutex<HashMap<String, StreamHealth>>, // camera_id -> health stats
    buffer_pool: BufferPool, // Reusable buffer pool for frame processing
    frame_broadcasters: Arc<Mutex<HashMap<String, tokio::sync::broadcast::Sender<Arc<Vec<u8>>>>>>, // camera_id -> frame broadcaster (Arc to avoid cloning ~200KB per frame)
}

// ── Tauri Commands ───────────────────────────────────────────────────────────

#[tauri::command]
fn get_config(state: State<AppState>) -> Result<AppConfig, String> {
    let config = state.config.lock()
        .map_err(|_| "Config mutex poisoned - please restart application".to_string())?
        .clone();
    Ok(config)
}

#[tauri::command]
fn save_config(state: State<AppState>, config: AppConfig) -> Result<(), String> {
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&state.config_path, json).map_err(|e| e.to_string())?;
    *state.config.lock()
        .map_err(|_| "Config mutex poisoned - please restart application".to_string())? = config;
    Ok(())
}

#[tauri::command]
fn start_streams(state: State<AppState>, app: AppHandle) {
    // Clone config first, then acquire stream_tasks once to avoid lock ordering issues
    let config = match state.config.lock() {
        Ok(cfg) => cfg.clone(),
        Err(_) => {
            error!("Config mutex poisoned, cannot start streams");
            return;
        }
    };
    let ffmpeg_path = state.ffmpeg_path.clone();

    let mut tasks = match state.stream_tasks.lock() {
        Ok(t) => t,
        Err(_) => {
            error!("stream_tasks mutex poisoned, cannot start streams");
            return;
        }
    };

    // Stop any existing streams first
    for (_, handle) in tasks.drain() {
        handle.abort();
    }

    for camera in &config.cameras {
        let cam_id = camera.id.clone();
        let cam_url = camera.url.clone();
        let ffmpeg = ffmpeg_path.clone();
        let app_handle = app.clone();

        let handle = tauri::async_runtime::spawn(async move {
            stream_camera(app_handle, ffmpeg, cam_id, cam_url).await;
        });

        tasks.insert(camera.id.clone(), handle);
    }
}

#[tauri::command]
fn stop_streams(state: State<AppState>, app: AppHandle) {
    let mut tasks = match state.stream_tasks.lock() {
        Ok(t) => t,
        Err(_) => {
            error!("stream_tasks mutex poisoned in stop_streams");
            return;
        }
    };
    let camera_ids: Vec<String> = tasks.keys().cloned().collect();
    for (_, handle) in tasks.drain() {
        handle.abort();
    }
    // Clear stale health data and emit offline status
    if let Ok(mut health) = state.stream_health.lock() {
        health.clear();
    }
    if let Ok(mut attempts) = state.reconnect_attempts.lock() {
        attempts.clear();
    }
    drop(tasks);
    for id in camera_ids {
        let _ = app.emit("camera-status", CameraStatusEvent {
            camera_id: id,
            status: "offline".to_string(),
        });
    }
}

#[tauri::command]
fn solo_camera(state: State<AppState>, _app: AppHandle, camera_id: String) {
    // Stop all streams except the solo'd one — the solo stream keeps running
    let mut tasks = match state.stream_tasks.lock() {
        Ok(t) => t,
        Err(_) => {
            error!("stream_tasks mutex poisoned in solo_camera");
            return;
        }
    };
    let ids_to_remove: Vec<String> = tasks
        .keys()
        .filter(|id| **id != camera_id)
        .cloned()
        .collect();

    for id in ids_to_remove {
        if let Some(handle) = tasks.remove(&id) {
            handle.abort();
        }
    }
}

#[tauri::command]
fn grid_view(state: State<AppState>, app: AppHandle) {
    // Only start streams for cameras that aren't already running.
    // This avoids killing + restarting the solo'd camera that's still fine.
    let config = match state.config.lock() {
        Ok(cfg) => cfg.clone(),
        Err(_) => {
            error!("Config mutex poisoned in grid_view");
            return;
        }
    };
    let ffmpeg_path = state.ffmpeg_path.clone();
    let mut tasks = match state.stream_tasks.lock() {
        Ok(t) => t,
        Err(_) => {
            error!("stream_tasks mutex poisoned in grid_view");
            return;
        }
    };
    for camera in &config.cameras {
        // Skip cameras that already have a running stream
        if tasks.contains_key(&camera.id) {
            continue;
        }

        let cam_id = camera.id.clone();
        let cam_url = camera.url.clone();
        let ffmpeg = ffmpeg_path.clone();
        let app_handle = app.clone();

        let handle = tauri::async_runtime::spawn(async move {
            stream_camera(app_handle, ffmpeg, cam_id, cam_url).await;
        });

        tasks.insert(camera.id.clone(), handle);
    }
}

#[tauri::command]
fn get_stream_health(state: State<AppState>) -> Result<HashMap<String, StreamHealth>, String> {
    let health = state.stream_health.lock()
        .map_err(|_| "stream_health mutex poisoned".to_string())?
        .clone();
    Ok(health)
}

// ── Camera Streaming ─────────────────────────────────────────────────────────

fn build_mjpeg_args(quality: &Quality) -> Vec<String> {
    let q_val = match quality {
        Quality::Low => 10,
        Quality::Medium => 5,
        Quality::High => 3,
    };

    vec![
        "-c:v".to_string(),
        "mjpeg".to_string(),
        "-q:v".to_string(),
        q_val.to_string(),
        "-f".to_string(),
        "image2pipe".to_string(),
        "-an".to_string(),
    ]
}

fn build_fps_args(fps_mode: &FpsMode) -> Vec<String> {
    match fps_mode {
        FpsMode::Native => {
            // No -r flag - camera streams at native FPS
            Vec::new()
        }
        FpsMode::Capped(fps) => {
            vec!["-r".to_string(), fps.to_string()]
        }
    }
}

/// Build FPS arguments for a camera, considering per-camera overrides and quality defaults
fn build_fps_args_for_camera(
    has_camera_override: bool,
    fps_mode: &FpsMode,
    quality: &Quality,
) -> Vec<String> {
    if has_camera_override {
        build_fps_args(fps_mode)
    } else {
        // No per-camera override: apply quality-based default FPS cap
        match quality {
            Quality::Low => vec!["-r".to_string(), "10".to_string()],
            Quality::Medium => vec!["-r".to_string(), "15".to_string()],
            Quality::High => Vec::new(), // No FPS cap - output frames as received from camera
        }
    }
}

/// Calculate smart backoff duration based on attempt number.
/// Strategy: Fast retries initially (1-16s exponential), then 60s for medium-term issues,
/// then 5min for long outages. Never gives up for 24/7 reliability.
fn calculate_backoff(attempt: u32) -> std::time::Duration {
    match attempt {
        1..=5 => {
            let exp = attempt.saturating_sub(1).min(31); // Cap at 2^31 to prevent overflow
            std::time::Duration::from_secs(2u64.pow(exp))
        },  // 1s, 2s, 4s, 8s, 16s
        6..=10 => std::time::Duration::from_secs(60),                                    // 60s
        _ => std::time::Duration::from_secs(300),                                        // 5 min for long outages
    }
}

/// Wrapper that retries streaming with smart backoff. Never gives up.
async fn stream_camera(
    app: AppHandle,
    ffmpeg_path: PathBuf,
    camera_id: String,
    url: String,
) {
    info!("Starting stream for {} → {}", camera_id, url);

    loop {
        // Get current attempt count
        let attempt = {
            let state = app.state::<AppState>();
            let mut attempts = match state.reconnect_attempts.lock() {
                Ok(a) => a,
                Err(poisoned) => {
                    error!("reconnect_attempts mutex poisoned, recovering");
                    poisoned.into_inner()
                }
            };
            let count = attempts.entry(camera_id.clone()).or_insert(0);
            *count += 1;
            *count
        };

        // Emit status event before attempting connection
        let _ = app.emit("camera-status", CameraStatusEvent {
            camera_id: camera_id.clone(),
            status: "connecting".to_string(),
        });

        // Attempt to stream
        let state = app.state::<AppState>();
        match try_stream_camera(&app, &state, &ffmpeg_path, &camera_id, &url).await {
            Ok(()) => {
                info!("Stream ended normally for {}", camera_id);
                // Reset attempt counter on success
                if let Ok(mut attempts) = state.reconnect_attempts.lock() {
                    attempts.insert(camera_id.clone(), 0);
                }
            }
            Err(e) => {
                error!("Stream failed for {}: {}", camera_id, e);
            }
        }

        // Calculate backoff and emit reconnection status
        let backoff = calculate_backoff(attempt);
        let status_msg = if attempt <= 10 {
            format!("reconnecting (attempt {})", attempt)
        } else {
            format!("reconnecting ({}m wait)", backoff.as_secs() / 60)
        };

        let _ = app.emit("camera-status", CameraStatusEvent {
            camera_id: camera_id.clone(),
            status: status_msg,
        });

        tokio::time::sleep(backoff).await;

        info!("Retrying {} (attempt {})", camera_id, attempt + 1);
    }
}

/// Spawns ffmpeg for a single camera, reads JPEG frames from its stdout,
/// and broadcasts each frame to HTTP MJPEG stream clients.
async fn try_stream_camera(
    app: &AppHandle,
    state: &tauri::State<'_, AppState>,
    ffmpeg_path: &PathBuf,
    camera_id: &str,
    url: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let start_time = std::time::Instant::now();

    // Use atomic counters so they can be shared with the health update task
    let frame_count = Arc::new(AtomicU64::new(0));
    let bytes_received = Arc::new(AtomicU64::new(0));
    let last_frame_buffer = Arc::new(Mutex::new(Vec::new()));

    // Create broadcast channel for HTTP MJPEG streaming (Arc<Vec<u8>> avoids cloning frames)
    {
        let mut broadcasters = state.frame_broadcasters.lock().unwrap();
        broadcasters.entry(camera_id.to_string())
            .or_insert_with(|| tokio::sync::broadcast::channel::<Arc<Vec<u8>>>(30).0);
        info!("Created frame broadcaster for camera: {}", camera_id);
    }

    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
    ];

    // Rewrite the input URL and add protocol-specific flags
    let input_url = if url.starts_with("rtp://") || url.starts_with("udp://") {
        // RTP/UDP multicast: rewrite to udp://@ so ffmpeg joins the group
        let addr = url
            .trim_start_matches("rtp://")
            .trim_start_matches("udp://")
            .trim_start_matches('@');
        args.extend([
            "-analyzeduration".into(), "500000".into(),
            "-probesize".into(),       "512000".into(),
            "-fflags".into(),          "+genpts+nobuffer".into(),
            "-flags".into(),           "low_delay".into(),
            "-buffer_size".into(),     "2000000".into(),
            "-overrun_nonfatal".into(),"1".into(),
        ]);
        format!("udp://@{}", addr)
    } else if url.starts_with("rtsp://") {
        args.extend([
            "-analyzeduration".into(),   "500000".into(),
            "-probesize".into(),         "512000".into(),
            "-fflags".into(),            "nobuffer".into(),
            "-flags".into(),             "low_delay".into(),
            "-rtsp_transport".into(),    "tcp".into(),
            "-allowed_media_types".into(),"video".into(),
        ]);
        url.to_string()
    } else if url.starts_with("srt://") {
        args.extend([
            "-analyzeduration".into(), "500000".into(),
            "-probesize".into(),       "512000".into(),
            "-fflags".into(),          "nobuffer".into(),
            "-flags".into(),           "low_delay".into(),
        ]);
        url.to_string()
    } else {
        // HTTP MJPEG, file, or other
        args.extend([
            "-analyzeduration".into(), "500000".into(),
            "-probesize".into(),       "512000".into(),
            "-fflags".into(),          "nobuffer".into(),
            "-flags".into(),           "low_delay".into(),
        ]);
        url.to_string()
    };

    // Hardware-accelerated decoding (DXVA2/D3D11VA on Windows, VideoToolbox on macOS, VAAPI on Linux).
    // Must come before -i. Falls back to software decoding silently if the GPU does not support it.
    args.extend(["-hwaccel".into(), "auto".into()]);

    // Add input URL
    args.extend(["-i".into(), input_url]);

    // Get camera from config
    let camera = {
        let cfg = state.config.lock()
            .map_err(|_| "Config mutex poisoned")?;
        cfg.cameras.iter().find(|c| c.id == camera_id).cloned()
    };

    let Some(camera) = camera else {
        error!("Camera {} not found in config", camera_id);
        return Err("Camera not found in config".into());
    };

    // Get stream config (global)
    let stream_config = {
        let cfg = state.config.lock()
            .map_err(|_| "Config mutex poisoned")?;
        cfg.stream_config.clone()
    };

    // Determine effective quality and FPS mode
    let quality = camera.codec_override
        .as_ref()
        .map(|c| &c.quality)
        .unwrap_or(&stream_config.quality);

    let fps_mode = camera.codec_override
        .as_ref()
        .map(|c| &c.fps_mode)
        .unwrap_or(&FpsMode::Native);

    // Detect if we should attempt MJPEG passthrough
    let attempt_passthrough = url.contains("mjpeg") || url.contains("mjpg") || url.ends_with(".mjpeg") || url.ends_with(".mjpg");

    let (encoder_name, mut codec_args, is_passthrough) = if attempt_passthrough {
        // Attempt MJPEG passthrough - copy codec, no re-encoding
        info!("Attempting MJPEG passthrough for camera {}", camera_id);
        ("copy", vec![
            "-c:v".to_string(), "copy".to_string(),
            "-f".to_string(), "image2pipe".to_string(),
            "-an".to_string(),
        ], true)
    } else {
        // Standard MJPEG transcode path
        ("mjpeg", build_mjpeg_args(quality), false)
    };

    // Add FPS args only if NOT passthrough (can't change FPS when copying)
    if !is_passthrough {
        codec_args.extend(build_fps_args_for_camera(
            camera.codec_override.is_some(),
            fps_mode,
            quality,
        ));
    }

    debug!("Using encoder: {} for camera {} (quality: {:?}, fps_mode: {:?}, passthrough: {})",
           encoder_name, camera_id, quality, fps_mode, is_passthrough);

    // Add codec-specific args
    for arg in codec_args {
        args.push(arg);
    }

    // Add output
    args.push("pipe:1".to_string());

    debug!("ffmpeg args: {}", args.join(" "));

    let mut cmd = Command::new(ffmpeg_path);
    cmd.args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    // Hide the console window on Windows
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            error!("Failed to spawn FFmpeg for {}: {}", camera_id, e);

            // Emit error event to frontend
            let _ = app.emit("stream-error", StreamErrorEvent {
                camera_id: camera_id.to_string(),
                error: format!("FFmpeg failed: {}", e),
            });

            // If passthrough failed, fall back to MJPEG transcode
            if is_passthrough {
                info!("MJPEG passthrough failed for camera {}, falling back to transcode", camera_id);
                let fallback_args = build_mjpeg_args(quality);
                let input_end = args.iter().position(|a| a == "-c:v").unwrap_or(args.len());
                let mut retry_args: Vec<String> = args[..input_end].to_vec();
                for arg in &fallback_args {
                    retry_args.push(arg.clone());
                }
                retry_args.extend(build_fps_args_for_camera(
                    camera.codec_override.is_some(),
                    fps_mode,
                    quality,
                ));
                retry_args.push("pipe:1".to_string());

                let mut retry_cmd = Command::new(ffmpeg_path);
                retry_cmd.args(&retry_args)
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .kill_on_drop(true);

                #[cfg(windows)]
                {
                    const CREATE_NO_WINDOW: u32 = 0x08000000;
                    retry_cmd.creation_flags(CREATE_NO_WINDOW);
                }

                match retry_cmd.spawn() {
                    Ok(child) => child,
                    Err(e2) => {
                        error!("MJPEG fallback also failed for {}: {}", camera_id, e2);
                        return Err(Box::new(e2));
                    }
                }
            } else {
                return Err(Box::new(e));
            }
        }
    };

    // Initialize health entry
    let quality_str = match quality {
        Quality::Low => "Low",
        Quality::Medium => "Medium",
        Quality::High => "High",
    }.to_string();

    let codec_str = if is_passthrough {
        "MJPEG (passthrough)".to_string()
    } else {
        "MJPEG".to_string()
    };

    {
        if let Ok(mut health_map) = state.stream_health.lock() {
            health_map.insert(camera_id.to_string(), StreamHealth {
                camera_id: camera_id.to_string(),
                fps: 0.0,
                bitrate_kbps: 0.0,
                frame_count: 0,
                last_frame_at: 0,
                uptime_secs: 0,
                resolution: None,
                quality_setting: quality_str.clone(),
                codec: codec_str.clone(),
            });
        }
    }

    // Spawn background task to update health stats every 2 seconds
    let health_camera_id = camera_id.to_string();
    let health_app = app.clone();
    let health_frame_count = frame_count.clone();
    let health_bytes_received = bytes_received.clone();
    let health_frame_buffer = last_frame_buffer.clone();
    let health_quality_str = quality_str.clone();
    let health_codec_str = codec_str.clone();

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

    let mut stdout = child.stdout.take().unwrap();
    // Capture stderr in a background task for diagnostics
    let stderr_camera_id = camera_id.to_string();
    let stderr_task = if let Some(stderr) = child.stderr.take() {
        Some(tokio::spawn(async move {
            use tokio::io::AsyncBufReadExt;
            let reader = tokio::io::BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                error!("FFmpeg stderr [{}]: {}", stderr_camera_id, line);
            }
        }))
    } else {
        None
    };
    let mut buf = vec![0u8; 131_072]; // 128 KB read buffer
    let mut frame = state.buffer_pool.acquire(); // Acquire from buffer pool
    let mut prev_byte: u8 = 0;
    let mut frame_count_local: u64 = 0;
    let mut in_frame = false; // true after SOI seen, before frame emitted

    loop {
        let n = match stdout.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => {
                error!("Read error for {}: {}", camera_id, e);
                return Err(Box::new(e));
            }
        };

        for &byte in &buf[..n] {
            frame.push(byte);

            if prev_byte == 0xFF {
                if byte == 0xD8 {
                    // SOI marker — start of a new JPEG frame
                    if in_frame && frame.len() > 2 {
                        // We hit a new SOI while already in a frame (no EOI seen).
                        // Discard the incomplete frame data before this SOI.
                        frame.clear();
                        frame.push(0xFF);
                        frame.push(0xD8);
                    }
                    in_frame = true;
                } else if byte == 0xD9 && in_frame {
                    // EOI marker — frame is complete, emit immediately
                    if frame.len() > 100 && frame[0] == 0xFF && frame[1] == 0xD8 {
                        frame_count_local += 1;
                        frame_count.fetch_add(1, Ordering::Relaxed);
                        bytes_received.fetch_add(frame.len() as u64, Ordering::Relaxed);

                        // Store latest frame for resolution detection (every 100 frames)
                        if frame_count_local % 100 == 1 {
                            if let Ok(mut frame_buf) = last_frame_buffer.lock() {
                                frame_buf.clear();
                                frame_buf.extend_from_slice(&frame);
                            }
                        }

                        if frame_count_local == 1 {
                            info!(
                                "First frame for {} ({} bytes)",
                                camera_id,
                                frame.len()
                            );

                            // Reset reconnect counter on first frame only (avoid mutex contention)
                            if let Ok(mut attempts) = state.reconnect_attempts.lock() {
                                attempts.insert(camera_id.to_string(), 0);
                            }

                            let _ = app.emit(
                                "camera-status",
                                CameraStatusEvent {
                                    camera_id: camera_id.to_string(),
                                    status: "online".into(),
                                },
                            );
                        }

                        // Broadcast frame to HTTP stream clients (Arc avoids ~200KB clone per send)
                        if let Ok(broadcasters) = state.frame_broadcasters.lock() {
                            if let Some(sender) = broadcasters.get(camera_id) {
                                if sender.receiver_count() > 0 {
                                    let frame_arc = Arc::new(frame.clone());
                                    match sender.send(frame_arc) {
                                        Ok(receivers) => {
                                            if frame_count.load(Ordering::Relaxed) % 100 == 0 {
                                                debug!("Broadcast frame to {} HTTP clients for {}", receivers, camera_id);
                                            }
                                        }
                                        Err(_) => {}
                                    }
                                }
                            }
                        }
                    }

                    // Release buffer back to pool and acquire fresh buffer for next frame
                    let old_frame = std::mem::replace(&mut frame, state.buffer_pool.acquire());
                    state.buffer_pool.release(old_frame);
                    in_frame = false;
                }
            }

            // Cap frame size to prevent unbounded memory growth
            if frame.len() >= 10 * 1024 * 1024 {
                error!("Frame exceeds 10MB, resetting buffer for {}", camera_id);
                frame.clear();
                in_frame = false;
                prev_byte = 0;
                continue;
            }

            prev_byte = byte;
        }
    }

    // Stop background tasks FIRST to prevent race conditions
    health_task.abort();
    if let Some(task) = stderr_task {
        task.abort();
    }

    // Remove health entry to prevent stale "online" status
    if let Ok(mut health_map) = state.stream_health.lock() {
        health_map.remove(camera_id);
    }

    // Return buffer to pool last
    state.buffer_pool.release(frame);

    info!(
        "Stream ended for {} after {} frames",
        camera_id, frame_count_local
    );

    Ok(())
}

// ── Network Command API ──────────────────────────────────────────────────────

/// Lightweight HTTP API server for remote control (Stream Deck / Companion).
/// Listens on the configured port and forwards commands to the frontend via events.
async fn run_api_server(app: AppHandle, port: u16) {
    let addr = format!("0.0.0.0:{}", port);
    let listener = match TcpListener::bind(&addr).await {
        Ok(l) => {
            info!("API server listening on http://{}", addr);
            l
        }
        Err(e) => {
            error!("Failed to start API server on {}: {}", addr, e);
            return;
        }
    };

    loop {
        let (mut stream, peer) = match listener.accept().await {
            Ok(v) => v,
            Err(_) => continue,
        };

        let app_handle = app.clone();
        tokio::spawn(async move {
            let mut buf = vec![0u8; 4096];
            let n = match tokio::time::timeout(
                std::time::Duration::from_secs(5),
                stream.read(&mut buf),
            ).await {
                Ok(Ok(n)) if n > 0 => n,
                _ => return, // timeout, error, or zero bytes — drop connection
            };

            let request = String::from_utf8_lossy(&buf[..n]);
            let first_line = request.lines().next().unwrap_or("");
            let method = first_line.split_whitespace().next().unwrap_or("");
            let path = first_line.split_whitespace().nth(1).unwrap_or("/");

            debug!("API request from {}: {} {}", peer, method, path);

            // Debug: Log all requests
            info!("HTTP Request: {} {}", method, path);

            // Handle CORS preflight
            if method == "OPTIONS" {
                let response = "HTTP/1.1 204 No Content\r\n\
                    Access-Control-Allow-Origin: *\r\n\
                    Access-Control-Allow-Methods: GET, OPTIONS\r\n\
                    Access-Control-Allow-Headers: Content-Type\r\n\
                    Access-Control-Max-Age: 86400\r\n\
                    Content-Length: 0\r\n\
                    Connection: close\r\n\r\n";
                let _ = stream.write_all(response.as_bytes()).await;
                return;
            }

            // Handle MJPEG streaming endpoint
            if path.starts_with("/camera/") && path.ends_with("/stream") {
                // Extract camera ID from path like "/camera/cam1/stream"
                let parts: Vec<&str> = path.split('/').collect();
                if parts.len() >= 3 {
                    let camera_id = parts[2].to_string();
                    info!("=== MJPEG stream requested for camera: {} ===", camera_id);

                    // Debug: Show available broadcasters
                    if let Ok(broadcasters) = app_handle.state::<AppState>().frame_broadcasters.lock() {
                        let available: Vec<_> = broadcasters.keys().cloned().collect();
                        info!("Available camera broadcasters: {:?}", available);
                    }

                    // Get or create broadcast sender for this camera
                    let state_ref = app_handle.state::<AppState>();
                    let mut rx = {
                        let mut broadcasters = state_ref.frame_broadcasters.lock().unwrap();
                        let sender = broadcasters.entry(camera_id.clone())
                            .or_insert_with(|| tokio::sync::broadcast::channel::<Arc<Vec<u8>>>(30).0);
                        sender.subscribe()
                    };

                    // Send MJPEG HTTP headers
                    let headers = "HTTP/1.1 200 OK\r\n\
                        Content-Type: multipart/x-mixed-replace; boundary=frame\r\n\
                        Access-Control-Allow-Origin: *\r\n\
                        Cache-Control: no-cache, no-store, must-revalidate\r\n\
                        Pragma: no-cache\r\n\
                        Connection: close\r\n\r\n";

                    if stream.write_all(headers.as_bytes()).await.is_err() {
                        return;
                    }

                    // Stream frames as they arrive — batched into a single write_all
                    while let Ok(jpeg_data) = rx.recv().await {
                        use std::io::Write as IoWrite;
                        let mut buf = Vec::with_capacity(jpeg_data.len() + 128);
                        let _ = write!(buf, "--frame\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\n\r\n", jpeg_data.len());
                        buf.extend_from_slice(&jpeg_data);
                        buf.extend_from_slice(b"\r\n");

                        if stream.write_all(&buf).await.is_err() {
                            break;
                        }
                    }

                    info!("HTTP stream client disconnected for {}", camera_id);
                    return;
                }
            }

            let (status, body) = if path == "/api/grid" {
                let _ = app_handle.emit("remote-command", RemoteCommandEvent {
                    command: "grid".into(),
                    index: None,
                });
                ("200 OK", r#"{"ok":true,"action":"grid"}"#.to_string())
            } else if path.starts_with("/api/solo/") {
                if let Ok(idx) = path.trim_start_matches("/api/solo/").parse::<usize>() {
                    if idx >= 1 {
                        let _ = app_handle.emit("remote-command", RemoteCommandEvent {
                            command: "solo".into(),
                            index: Some(idx),
                        });
                        ("200 OK", format!(r#"{{"ok":true,"action":"solo","index":{}}}"#, idx))
                    } else {
                        ("400 Bad Request", r#"{"ok":false,"error":"index must be >= 1"}"#.to_string())
                    }
                } else {
                    ("400 Bad Request", r#"{"ok":false,"error":"invalid index"}"#.to_string())
                }
            } else if path == "/api/status" {
                match app_handle.state::<AppState>().config.lock() {
                    Ok(config) => {
                        let cameras_json: Vec<serde_json::Value> = config.cameras.iter().enumerate().map(|(i, c)| {
                            serde_json::json!({"index": i + 1, "id": c.id, "name": c.name})
                        }).collect();
                        ("200 OK", serde_json::json!({"ok": true, "cameras": cameras_json}).to_string())
                    }
                    Err(_) => {
                        ("500 Internal Server Error", r#"{"ok":false,"error":"Config mutex poisoned"}"#.to_string())
                    }
                }
            } else if path == "/api/fullscreen" {
                match api_fullscreen(app_handle.clone()).await {
                    Ok(result) => ("200 OK", result.to_string()),
                    Err(e) => ("500 Internal Server Error", serde_json::json!({"ok": false, "error": e}).to_string()),
                }
            } else if path == "/api/reload" {
                let state = app_handle.state::<AppState>();
                match api_reload(app_handle.clone(), state).await {
                    Ok(result) => ("200 OK", result.to_string()),
                    Err(e) => ("500 Internal Server Error", serde_json::json!({"ok": false, "error": e}).to_string()),
                }
            } else {
                ("404 Not Found", r#"{"ok":false,"error":"unknown endpoint","endpoints":["/api/solo/:index","/api/grid","/api/status","/api/fullscreen","/api/reload"]}"#.to_string())
            };

            let response = format!(
                "HTTP/1.1 {}\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                status,
                body.len(),
                body
            );
            let _ = stream.write_all(response.as_bytes()).await;
        });
    }
}

// ── Config Persistence ───────────────────────────────────────────────────────

fn config_dir() -> std::path::PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("StageView")
}

fn load_config() -> (AppConfig, String) {
    let dir = config_dir();
    std::fs::create_dir_all(&dir).ok();
    let path = dir.join("config.json");
    let path_str = path.to_string_lossy().to_string();

    let config = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    (config, path_str)
}

// ── JPEG Resolution Parser ──────────────────────────────────────────────────

/// Extract resolution from JPEG data by parsing SOF (Start of Frame) marker
fn parse_jpeg_resolution(data: &[u8]) -> Option<String> {
    if data.len() < 10 || data[0] != 0xFF || data[1] != 0xD8 {
        return None; // Not a valid JPEG (missing SOI)
    }

    let mut i = 2;
    while i + 9 < data.len() {
        if data[i] != 0xFF {
            i += 1;
            continue;
        }

        let marker = data[i + 1];

        // SOF markers (Start of Frame): 0xC0-0xCF (except 0xC4, 0xC8, 0xCC which are not SOF)
        if (0xC0..=0xCF).contains(&marker) && marker != 0xC4 && marker != 0xC8 && marker != 0xCC {
            // SOF structure: FF Cn [length:2] [precision:1] [height:2] [width:2] ...
            let height = u16::from_be_bytes([data[i + 5], data[i + 6]]);
            let width = u16::from_be_bytes([data[i + 7], data[i + 8]]);
            return Some(format!("{}x{}", width, height));
        }

        // Skip to next marker
        if i + 3 < data.len() {
            let length = u16::from_be_bytes([data[i + 2], data[i + 3]]) as usize;
            i += 2 + length;
        } else {
            break;
        }
    }

    None
}

// ── Tests ────────────────────────────────────────────────────────────────────


/// Returns the path to the FFmpeg binary (bundled or system).
fn get_ffmpeg_path() -> PathBuf {
    let exe_dir = std::env::current_exe()
        .unwrap_or_default()
        .parent()
        .unwrap_or(std::path::Path::new("."))
        .to_path_buf();

    // Dev: in src-tauri/binaries/ (next to Cargo.toml)
    // Build platform-specific sidecar name dynamically
    let dev_binary_name = if cfg!(windows) {
        "ffmpeg-x86_64-pc-windows-msvc.exe".to_string()
    } else {
        let arch = std::env::consts::ARCH; // "x86_64", "aarch64", etc.
        let os_target = if cfg!(target_os = "macos") {
            "apple-darwin"
        } else {
            "unknown-linux-gnu"
        };
        format!("ffmpeg-{}-{}", arch, os_target)
    };
    let dev_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(dev_binary_name);

    // Production: Tauri places sidecar binaries directly next to the exe
    let prod_sidecar = exe_dir.join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" });

    if dev_path.exists() {
        dev_path
    } else if prod_sidecar.exists() {
        prod_sidecar
    } else {
        // Fallback: try PATH
        PathBuf::from("ffmpeg")
    }
}

#[tauri::command]
async fn api_fullscreen(app: AppHandle) -> Result<serde_json::Value, String> {
    let window = app.get_webview_window("main")
        .ok_or("Main window not found")?;

    let is_fullscreen = window.is_fullscreen()
        .map_err(|e| e.to_string())?;

    window.set_fullscreen(!is_fullscreen)
        .map_err(|e| e.to_string())?;

    Ok(serde_json::json!({
        "ok": true,
        "action": "fullscreen",
        "state": if !is_fullscreen { "entered" } else { "exited" }
    }))
}

#[tauri::command]
async fn api_reload(app: AppHandle, state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    info!("API reload requested");

    // Stop existing streams
    {
        let mut tasks = state.stream_tasks.lock().map_err(|_| "stream_tasks mutex poisoned")?;
        let camera_ids: Vec<String> = tasks.keys().cloned().collect();
        for (_, handle) in tasks.drain() {
            handle.abort();
        }
        let mut health = state.stream_health.lock().map_err(|_| "stream_health mutex poisoned")?;
        health.clear();
        let mut attempts = state.reconnect_attempts.lock().map_err(|_| "reconnect_attempts mutex poisoned")?;
        attempts.clear();
        drop(health);
        drop(attempts);
        drop(tasks);
        for id in camera_ids {
            let _ = app.emit("camera-status", CameraStatusEvent {
                camera_id: id,
                status: "offline".to_string(),
            });
        }
    }

    // Reload config from disk
    let (config, _) = load_config();

    // Update in-memory config
    let cameras = config.cameras.clone();
    let ffmpeg_path = state.ffmpeg_path.clone();
    {
        let mut cfg = state.config.lock()
            .map_err(|_| "Config mutex poisoned")?;
        *cfg = config;
    }

    info!("Config reloaded from disk");

    // Start streams for new config
    {
        let mut tasks = state.stream_tasks.lock().map_err(|_| "stream_tasks mutex poisoned")?;
        for camera in &cameras {
            let cam_id = camera.id.clone();
            let cam_url = camera.url.clone();
            let ffmpeg = ffmpeg_path.clone();
            let app_handle = app.clone();

            let handle = tauri::async_runtime::spawn(async move {
                stream_camera(app_handle, ffmpeg, cam_id, cam_url).await;
            });

            tasks.insert(camera.id.clone(), handle);
        }
    }

    // Emit reload event to frontend
    let _ = app.emit("reload-config", serde_json::json!({"ok": true}));

    Ok(serde_json::json!({
        "ok": true,
        "action": "reload"
    }))
}

// ── App Entry ────────────────────────────────────────────────────────────────

/// Deletes log files older than `max_age_days` from the given directory.
fn cleanup_old_logs(log_dir: &std::path::Path, max_age_days: u64) {
    let cutoff = std::time::SystemTime::now()
        - std::time::Duration::from_secs(max_age_days * 24 * 60 * 60);

    let entries = match std::fs::read_dir(log_dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        // Only clean up files matching the log pattern (stageview.log.*)
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if !name.starts_with("stageview.log") {
                continue;
            }
        }
        if let Ok(metadata) = entry.metadata() {
            if let Ok(modified) = metadata.modified() {
                if modified < cutoff {
                    eprintln!("Removing old log file: {}", path.display());
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
    }
}

/// Setup logging with daily rotation. The guard must be kept alive for the lifetime
/// of the application, otherwise logging will stop when it's dropped.
fn setup_logging() -> tracing_appender::non_blocking::WorkerGuard {
    // Create logs directory
    let log_dir = dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("StageView")
        .join("logs");

    if let Err(e) = std::fs::create_dir_all(&log_dir) {
        eprintln!("Warning: Failed to create logs directory at {}: {}. Logging may not work.",
                  log_dir.display(), e);
    }

    // Clean up log files older than 30 days
    cleanup_old_logs(&log_dir, 30);

    // Daily rotation
    let file_appender = tracing_appender::rolling::daily(log_dir.clone(), "stageview.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);

    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .with(tracing_subscriber::fmt::layer().with_writer(non_blocking))
        .init();

    info!("StageView logging initialized");
    info!("Logs directory: {}", log_dir.display());

    guard
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Setup logging and keep guard alive for application lifetime
    let _log_guard = setup_logging();
    let (config, config_path) = load_config();

    // Resolve bundled ffmpeg binary path
    let ffmpeg_path = get_ffmpeg_path();
    info!("Using ffmpeg at: {}", ffmpeg_path.display());

    tauri::Builder::default()
        .setup(move |app| {
            let api_port = config.api_port;
            let window_state = config.window_state.clone();

            app.manage(AppState {
                config: Mutex::new(config),
                config_path,
                ffmpeg_path,
                stream_tasks: Mutex::new(HashMap::new()),
                reconnect_attempts: Mutex::new(HashMap::new()),
                stream_health: Mutex::new(HashMap::new()),
                // Pool of 32 buffers: allows 2 buffers per camera for up to 16 simultaneous streams
                // (one being filled, one being encoded) with room for temporary spikes
                buffer_pool: BufferPool::new(32),
                frame_broadcasters: Arc::new(Mutex::new(HashMap::new())),
            });

            // Restore window position and size with off-screen validation
            if let Some(window) = app.get_webview_window("main") {
                use tauri::Position;
                use tauri::Size;

                // Validate position isn't off-screen (e.g. external monitor disconnected)
                let default_ws = WindowState::default();
                let (x, y) = if window_state.x < -500 || window_state.x > 10000
                    || window_state.y < -500 || window_state.y > 10000 {
                    info!("Saved window position ({}, {}) appears off-screen, resetting to default",
                          window_state.x, window_state.y);
                    (default_ws.x, default_ws.y)
                } else {
                    (window_state.x, window_state.y)
                };

                // Validate size is reasonable
                let (width, height) = if window_state.width < 200 || window_state.height < 150
                    || window_state.width > 10000 || window_state.height > 10000 {
                    (default_ws.width, default_ws.height)
                } else {
                    (window_state.width, window_state.height)
                };

                let _ = window.set_position(Position::Physical(tauri::PhysicalPosition { x, y }));
                let _ = window.set_size(Size::Physical(tauri::PhysicalSize { width, height }));

                if window_state.maximized {
                    let _ = window.maximize();
                }
            }

            // Start the HTTP API server for remote control
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                run_api_server(app_handle, api_port).await;
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            start_streams,
            stop_streams,
            solo_camera,
            grid_view,
            get_stream_health,
            api_fullscreen,
            api_reload,
        ])
        .run(tauri::generate_context!())
        .expect("Failed to launch StageView");
}
