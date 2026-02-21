use mdns_sd::{ServiceDaemon, ServiceInfo};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::process::Command;
use tracing::{error, info, debug, warn};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

// ── Data Models ──────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Camera {
    pub id: String,
    pub name: String,
    pub url: String,
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
    pub codec: String, // "H264 (copy)"
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

// ── App State ────────────────────────────────────────────────────────────────

struct AppState {
    config: Mutex<AppConfig>,
    config_path: String,
    ffmpeg_path: PathBuf,
    stream_tasks: Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>,
    reconnect_attempts: Mutex<HashMap<String, u32>>, // camera_id -> attempt count
    stream_health: Mutex<HashMap<String, StreamHealth>>, // camera_id -> health stats
    frame_broadcasters: Arc<Mutex<HashMap<String, tokio::sync::broadcast::Sender<Arc<Vec<u8>>>>>>, // camera_id -> frame broadcaster (Arc to avoid cloning ~200KB per frame)
    init_segments: Arc<Mutex<HashMap<String, Arc<Vec<u8>>>>>, // camera_id -> cached ftyp+moov initialization segment
    recent_segments: Arc<Mutex<HashMap<String, VecDeque<Arc<Vec<u8>>>>>>, // camera_id -> cached fragments from last keyframe (for instant client startup)
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
    info!("start_streams called");

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
    // Clear stale health data, reconnect counters, and stream segment caches.
    // Cameras removed from config would otherwise leave stale data indefinitely.
    if let Ok(mut health) = state.stream_health.lock() {
        health.clear();
    }
    if let Ok(mut attempts) = state.reconnect_attempts.lock() {
        attempts.clear();
    }
    if let Ok(mut init_segs) = state.init_segments.lock() {
        init_segs.clear();
    }
    if let Ok(mut recent_segs) = state.recent_segments.lock() {
        recent_segs.clear();
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
fn solo_camera(_state: State<AppState>, _app: AppHandle, camera_id: String) {
    // Keep all streams running in solo mode for instant grid recovery.
    // H.264 copy uses minimal CPU; the frontend simply hides non-solo tiles.
    // The broadcast channel's receiver_count check skips sending when no HTTP
    // clients are connected, so background streams have near-zero overhead.
    info!("Solo mode activated: camera {}", camera_id);
}

#[tauri::command]
fn get_stream_health(state: State<AppState>) -> Result<HashMap<String, StreamHealth>, String> {
    let health = state.stream_health.lock()
        .map_err(|_| "stream_health mutex poisoned".to_string())?
        .clone();
    Ok(health)
}

// ── Camera Streaming ─────────────────────────────────────────────────────────

/// Build codec args for fMP4 output with H.264 copy (no transcode)
fn build_h264_copy_args() -> Vec<String> {
    vec![
        "-c:v".to_string(),
        "copy".to_string(),
        "-f".to_string(),
        "mp4".to_string(),
        "-movflags".to_string(),
        "frag_keyframe+empty_moov+default_base_moof".to_string(),
        "-frag_duration".to_string(),
        "50000".to_string(), // 50ms fragments for ultra-fast startup
        "-min_frag_duration".to_string(),
        "50000".to_string(),
        "-flush_packets".to_string(),
        "1".to_string(), // Force immediate writes to stdout
        "-an".to_string(), // No audio
    ]
}

/// Check if a moof box contains a keyframe (sync sample) by parsing traf→tfhd/trun flags.
/// Used to cache fragments from the last keyframe for instant client startup.
fn is_keyframe_fragment(moof_data: &[u8]) -> bool {
    if moof_data.len() < 16 { return false; }
    let mut offset = 8; // skip moof box header

    while offset + 8 <= moof_data.len() {
        let box_size = u32::from_be_bytes([
            moof_data[offset], moof_data[offset+1], moof_data[offset+2], moof_data[offset+3]
        ]) as usize;
        let box_type = &moof_data[offset+4..offset+8];
        if box_size < 8 || offset + box_size > moof_data.len() { break; }

        if box_type == b"traf" {
            let mut traf_off = offset + 8;
            let mut default_flags: Option<u32> = None;

            while traf_off + 8 <= offset + box_size {
                let child_size = u32::from_be_bytes([
                    moof_data[traf_off], moof_data[traf_off+1], moof_data[traf_off+2], moof_data[traf_off+3]
                ]) as usize;
                let child_type = &moof_data[traf_off+4..traf_off+8];
                if child_size < 8 || traf_off + child_size > offset + box_size { break; }

                if child_type == b"tfhd" && child_size >= 16 {
                    let tfhd_flags = u32::from_be_bytes([0, moof_data[traf_off+9], moof_data[traf_off+10], moof_data[traf_off+11]]);
                    let mut foff = traf_off + 16; // past header(8) + version/flags(4) + track_id(4)
                    if tfhd_flags & 0x000001 != 0 { foff += 8; } // base_data_offset
                    if tfhd_flags & 0x000002 != 0 { foff += 4; } // sample_description_index
                    if tfhd_flags & 0x000008 != 0 { foff += 4; } // default_sample_duration
                    if tfhd_flags & 0x000010 != 0 { foff += 4; } // default_sample_size
                    if tfhd_flags & 0x000020 != 0 && foff + 4 <= traf_off + child_size {
                        default_flags = Some(u32::from_be_bytes([
                            moof_data[foff], moof_data[foff+1], moof_data[foff+2], moof_data[foff+3]
                        ]));
                    }
                }

                if child_type == b"trun" && child_size >= 12 {
                    let trun_flags = u32::from_be_bytes([0, moof_data[traf_off+9], moof_data[traf_off+10], moof_data[traf_off+11]]);
                    let mut toff = traf_off + 16; // past header(8) + version/flags(4) + sample_count(4)
                    if trun_flags & 0x000001 != 0 { toff += 4; } // data_offset
                    if trun_flags & 0x000004 != 0 && toff + 4 <= traf_off + child_size {
                        // first_sample_flags present — authoritative for first sample
                        let flags = u32::from_be_bytes([moof_data[toff], moof_data[toff+1], moof_data[toff+2], moof_data[toff+3]]);
                        return (flags >> 16) & 1 == 0; // sample_is_non_sync_sample == 0 → keyframe
                    }
                    // Fall back to default_sample_flags from tfhd
                    if let Some(df) = default_flags {
                        return (df >> 16) & 1 == 0;
                    }
                    return true; // No explicit flags — assume keyframe (conservative)
                }

                traf_off += child_size;
            }
        }

        offset += box_size;
    }
    false
}

/// Count the total number of video samples (frames) declared in all trun boxes
/// inside a moof box. This gives the exact frame count for the following mdat,
/// which may contain multiple frames when frag_duration > one frame period.
fn count_samples_in_moof(moof_data: &[u8]) -> u64 {
    if moof_data.len() < 8 { return 1; }
    let mut total: u64 = 0;
    let mut offset = 8; // skip moof box header

    while offset + 8 <= moof_data.len() {
        let box_size = u32::from_be_bytes([
            moof_data[offset], moof_data[offset+1], moof_data[offset+2], moof_data[offset+3]
        ]) as usize;
        let box_type = &moof_data[offset+4..offset+8];
        if box_size < 8 || offset + box_size > moof_data.len() { break; }

        if box_type == b"traf" {
            let mut traf_off = offset + 8;
            while traf_off + 8 <= offset + box_size {
                let child_size = u32::from_be_bytes([
                    moof_data[traf_off], moof_data[traf_off+1],
                    moof_data[traf_off+2], moof_data[traf_off+3]
                ]) as usize;
                let child_type = &moof_data[traf_off+4..traf_off+8];
                if child_size < 8 || traf_off + child_size > offset + box_size { break; }

                // trun: version/flags(4) + sample_count(4) starting at offset+8
                if child_type == b"trun" && child_size >= 16 {
                    let sample_count = u32::from_be_bytes([
                        moof_data[traf_off+12], moof_data[traf_off+13],
                        moof_data[traf_off+14], moof_data[traf_off+15]
                    ]);
                    total += sample_count as u64;
                }
                traf_off += child_size;
            }
        }
        offset += box_size;
    }
    total.max(1) // always count at least 1 to avoid stalling on malformed boxes
}

/// RAII guard that calls an abort closure when dropped.
/// Ensures background tasks (health monitoring, stderr capture) are cancelled
/// even when the parent task is externally aborted via JoinHandle::abort(),
/// because dropping a Tokio JoinHandle only detaches — it does NOT cancel the task.
struct AbortOnDrop(Option<Box<dyn FnOnce() + Send + 'static>>);

impl AbortOnDrop {
    fn new<F: FnOnce() + Send + 'static>(f: F) -> Self {
        Self(Some(Box::new(f)))
    }
}

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        if let Some(f) = self.0.take() {
            f();
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

        info!("Starting stream for {} → {} (attempt {})", camera_id, url, attempt);

        // Emit status event before attempting connection
        let _ = app.emit("camera-status", CameraStatusEvent {
            camera_id: camera_id.clone(),
            status: "connecting".to_string(),
        });

        // Attempt to stream
        let state = app.state::<AppState>();
        match try_stream_camera(&app, &state, &ffmpeg_path, &camera_id, &url).await {
            Ok(()) => {
                // Reset attempt counter on success
                if let Ok(mut attempts) = state.reconnect_attempts.lock() {
                    attempts.insert(camera_id.clone(), 0);
                }
            }
            Err(e) => {
                error!("Stream failed for {}: {}", camera_id, e);
                // Only notify the frontend after 3+ failed attempts
                // to avoid toast-flooding during normal RTP startup retries.
                if attempt >= 3 {
                    let _ = app.emit("stream-error", StreamErrorEvent {
                        camera_id: camera_id.clone(),
                        error: format!("Stream failed (attempt {}): {}", attempt, e),
                    });
                }
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
    let last_frame_at = Arc::new(AtomicU64::new(0)); // Unix ms timestamp of last received frame

    info!("Spawning FFmpeg for camera {} ({})", camera_id, url);

    // Create broadcast channel for HTTP streaming (Arc<Vec<u8>> avoids cloning frames)
    {
        let mut broadcasters = state.frame_broadcasters.lock().unwrap();
        broadcasters.entry(camera_id.to_string())
            .or_insert_with(|| {
                info!("Created frame broadcaster for camera: {}", camera_id);
                tokio::sync::broadcast::channel::<Arc<Vec<u8>>>(60).0
            });
    }

    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
    ];

    // Rewrite the input URL and add protocol-specific flags
    let input_url = if url.starts_with("rtp://") {
        // RTP multicast: use FFmpeg's native rtp:// protocol handler.
        // It correctly parses RTP headers and extracts SPS/PPS for H.264.
        // Do NOT rewrite to udp:// — that strips RTP framing and loses codec params.
        // Need generous analyzeduration because we join mid-stream and must wait
        // for a keyframe (IDR) carrying SPS/PPS before FFmpeg can determine dimensions.
        args.extend([
            "-analyzeduration".into(), "10000000".into(), // 10s — enough for any GOP size
            "-probesize".into(),       "10000000".into(), // 10MB probe data
            "-fflags".into(),          "+genpts+discardcorrupt+fastseek".into(),
            "-flags".into(),           "low_delay".into(),
            "-thread_queue_size".into(),"512".into(),
        ]);
        url.to_string()
    } else if url.starts_with("udp://") {
        // Raw UDP multicast: rewrite to udp://@ so ffmpeg joins the group
        let addr = url
            .trim_start_matches("udp://")
            .trim_start_matches('@');
        args.extend([
            "-analyzeduration".into(), "2000000".into(),  // 2s analysis
            "-probesize".into(),       "1000000".into(),  // 1MB probe
            "-fflags".into(),          "+genpts+nobuffer+discardcorrupt+fastseek".into(),
            "-flags".into(),           "low_delay".into(),
            "-avioflags".into(),       "direct".into(),
            "-buffer_size".into(),     "2000000".into(),
            "-overrun_nonfatal".into(),"1".into(),
            "-thread_queue_size".into(),"512".into(),
        ]);
        format!("udp://@{}?timeout=10000000", addr)
    } else if url.starts_with("rtsp://") {
        args.extend([
            "-analyzeduration".into(),   "100000".into(),  // 0.1s for RTSP setup
            "-probesize".into(),         "50000".into(),   // 50KB probe
            "-fflags".into(),            "+nobuffer+discardcorrupt+fastseek".into(),
            "-flags".into(),             "low_delay".into(),
            "-avioflags".into(),         "direct".into(),
            "-rtsp_transport".into(),    "tcp".into(),
            "-allowed_media_types".into(),"video".into(),
            "-thread_queue_size".into(), "512".into(),
            "-stimeout".into(),          "10000000".into(), // 10s RTSP connect timeout
        ]);
        url.to_string()
    } else if url.starts_with("srt://") {
        args.extend([
            "-analyzeduration".into(), "50000".into(),
            "-probesize".into(),       "50000".into(),
            "-fflags".into(),          "+nobuffer+discardcorrupt+fastseek".into(),
            "-flags".into(),           "low_delay".into(),
            "-avioflags".into(),       "direct".into(),
            "-thread_queue_size".into(),"512".into(),
            "-timeout".into(),         "10000000".into(), // 10s input timeout
        ]);
        url.to_string()
    } else {
        // Other sources (HTTP, file, etc.)
        args.extend([
            "-analyzeduration".into(), "100000".into(),
            "-probesize".into(),       "100000".into(),
            "-fflags".into(),          "+nobuffer+discardcorrupt".into(),
            "-flags".into(),           "low_delay".into(),
            "-rw_timeout".into(),      "10000000".into(), // 10s I/O timeout
        ]);
        url.to_string()
    };

    // Add input URL
    args.extend(["-i".into(), input_url]);

    // Always use H.264 copy → fMP4 output (no transcoding)
    let codec_args = build_h264_copy_args();
    for arg in codec_args {
        args.push(arg);
    }
    args.push("pipe:1".to_string());

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
            let _ = app.emit("stream-error", StreamErrorEvent {
                camera_id: camera_id.to_string(),
                error: format!("FFmpeg failed: {}", e),
            });
            return Err(Box::new(e));
        }
    };

    // Initialize health entry
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
                codec: "H264 (copy)".to_string(),
            });
        }
    }

    // Spawn background task to update health stats every 2 seconds
    let health_camera_id = camera_id.to_string();
    let health_app = app.clone();
    let health_frame_count = frame_count.clone();
    let health_bytes_received = bytes_received.clone();
    let health_last_frame_at = last_frame_at.clone();

    // AbortOnDrop ensures this task is cancelled even if try_stream_camera is
    // externally aborted (e.g. stop_streams), since dropping a JoinHandle only detaches.
    let health_handle = tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(2));
        // Skip = don't fire catch-up ticks when delayed; prevents near-zero tick_elapsed → fps=0
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
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

            let health = StreamHealth {
                camera_id: health_camera_id.clone(),
                fps,
                bitrate_kbps,
                frame_count: count,
                // Only reflects time of actual frame receipt; stays 0 until first frame arrives.
                last_frame_at: health_last_frame_at.load(Ordering::Relaxed),
                uptime_secs: uptime,
                resolution: None,
                codec: "H264 (copy)".to_string(),
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
    let _health_guard = AbortOnDrop::new(move || health_handle.abort());

    let stdout = child.stdout.take().unwrap();
    // Capture stderr in a background task for diagnostics.
    // AbortOnDrop ensures the task is cleaned up on any exit path.
    let stderr_camera_id = camera_id.to_string();
    let _stderr_guard = child.stderr.take().map(|stderr| {
        let h = tokio::spawn(async move {
        use tokio::io::AsyncBufReadExt;
        let reader = tokio::io::BufReader::new(stderr);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            // Demote normal H.264 startup noise to debug level.
            // "non-existing PPS/SPS" and "no frame" are expected when
            // joining an RTP stream mid-GOP before the first keyframe.
            if line.contains("non-existing PPS") || line.contains("non-existing SPS")
                || line.contains("no frame") || line.contains("Last message repeated")
            {
                debug!("FFmpeg stderr [{}]: {}", stderr_camera_id, line);
            } else {
                warn!("FFmpeg stderr [{}]: {}", stderr_camera_id, line);
            }
        }
        });
        AbortOnDrop::new(move || h.abort())
    });

    // Clone Arc references before passing to stream processing
    let frame_count_clone = frame_count.clone();
    let bytes_received_clone = bytes_received.clone();
    let last_frame_at_clone = last_frame_at.clone();

    // Process fMP4 stream (H.264 copy, MSE-ready).
    // _health_guard and _stderr_guard are RAII — they abort their tasks
    // automatically when this function returns (normally, via error, or cancellation).
    process_fmp4_stream(
        stdout,
        state,
        camera_id,
        &app,
        frame_count_clone,
        bytes_received_clone,
        last_frame_at_clone,
    ).await?;

    // Remove health entry to prevent stale "online" status
    if let Ok(mut health_map) = state.stream_health.lock() {
        health_map.remove(camera_id);
    }

    let total_frames = frame_count.load(Ordering::Relaxed);

    info!(
        "Stream ended for {} after {} frames",
        camera_id, total_frames
    );

    // If FFmpeg exited without producing any frames, mark as offline.
    // Don't emit stream-error here — the retry wrapper (stream_camera)
    // handles that after enough failed attempts to avoid toast-flooding.
    if total_frames == 0 {
        let _ = app.emit("camera-status", CameraStatusEvent {
            camera_id: camera_id.to_string(),
            status: "offline".to_string(),
        });
    }

    Ok(())
}

/// Process fMP4 stream (fragmented MP4 with moof/mdat boxes for MSE)
async fn process_fmp4_stream(
    mut stdout: tokio::process::ChildStdout,
    state: &tauri::State<'_, AppState>,
    camera_id: &str,
    app: &AppHandle,
    frame_count: Arc<AtomicU64>,
    bytes_received: Arc<AtomicU64>,
    last_frame_at: Arc<AtomicU64>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut buf = vec![0u8; 131_072]; // 128 KB read buffer
    let mut pending = Vec::new();
    let mut init_segment_sent = false;
    let mut init_segment_buffer = Vec::new(); // Accumulate ftyp + moov
    let mut fragment_buffer: Vec<u8> = Vec::new(); // Batch moof+mdat pairs
    let mut moof_start: usize = 0; // Track where moof starts in fragment_buffer for keyframe detection
    let mut pending_sample_count: u64 = 1; // Samples declared in the current moof, applied on mdat

    // Clone broadcast sender once to avoid per-fragment mutex lock acquisition.
    // With 4+ cameras at 20fps each, this eliminates ~80+ mutex locks/sec.
    let broadcast_sender = state.frame_broadcasters.lock()
        .ok()
        .and_then(|b| b.get(camera_id).cloned());

    loop {
        // Timeout each read: if FFmpeg produces no output for 30 seconds
        // (e.g. silent RTP multicast, stalled RTSP, or hung demuxer), treat
        // it as a failed stream so the retry wrapper can reconnect with backoff.
        // Without this, a silent RTP source leaves FFmpeg blocked in read()
        // indefinitely — the stream shows "online" but produces no frames.
        let n = match tokio::time::timeout(
            tokio::time::Duration::from_secs(30),
            stdout.read(&mut buf),
        ).await {
            Ok(Ok(0)) => break,  // FFmpeg exited cleanly
            Ok(Ok(n)) => n,
            Ok(Err(e)) => {
                error!("Read error (fMP4) for {}: {}", camera_id, e);
                return Err(Box::new(e));
            }
            Err(_elapsed) => {
                warn!("No data from FFmpeg for 30s ({}), triggering stream restart", camera_id);
                return Err("Stream read timeout — no data from FFmpeg".into());
            }
        };

        pending.extend_from_slice(&buf[..n]);

        // Parse MP4 boxes from pending buffer
        while pending.len() >= 8 {
            // Read box size and type
            let box_size = u32::from_be_bytes([pending[0], pending[1], pending[2], pending[3]]) as usize;
            let box_type = [pending[4], pending[5], pending[6], pending[7]];
            let box_type_str = std::str::from_utf8(&box_type).unwrap_or("????");

            // Validate box size
            if box_size < 8 || box_size > 50 * 1024 * 1024 {
                error!("Invalid MP4 box size {} for {}, resetting buffer", box_size, camera_id);
                pending.clear();
                fragment_buffer.clear();
                break;
            }

            // Wait for complete box
            if pending.len() < box_size {
                break;
            }

            // Handle initialization segment (ftyp, moov)
            if box_type_str == "ftyp" || box_type_str == "moov" {
                init_segment_buffer.extend_from_slice(&pending[..box_size]);
                pending.drain(..box_size);

                // Once we have moov, send combined init segment
                if box_type_str == "moov" && !init_segment_sent {
                    init_segment_sent = true;
                    let init_segment = Arc::new(init_segment_buffer.clone());
                    
                    // Cache initialization segment for late-connecting clients
                    if let Ok(mut cache) = state.init_segments.lock() {
                        cache.insert(camera_id.to_string(), init_segment.clone());
                    }
                    
                    // Broadcast combined init segment using pre-cloned sender
                    if let Some(ref sender) = broadcast_sender {
                        let _ = sender.send(init_segment);
                    }

                    // Reset reconnect counter
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
            }
            // Handle media segments — batch moof+mdat into a single broadcast
            else if box_type_str == "moof" {
                // Start of a new fragment: remember where moof starts for keyframe detection
                moof_start = fragment_buffer.len();
                bytes_received.fetch_add(box_size as u64, Ordering::Relaxed);
                fragment_buffer.extend_from_slice(&pending[..box_size]);
                // Count actual video frames declared in this moof's trun boxes
                pending_sample_count = count_samples_in_moof(&pending[..box_size]);
                pending.drain(..box_size);
            }
            else if box_type_str == "mdat" {
                // End of fragment: add the real frame count from the paired moof
                frame_count.fetch_add(pending_sample_count, Ordering::Relaxed);
                bytes_received.fetch_add(box_size as u64, Ordering::Relaxed);
                // Record timestamp of the last received video frame for health reporting
                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                last_frame_at.store(now_ms, Ordering::Relaxed);
                fragment_buffer.extend_from_slice(&pending[..box_size]);
                pending.drain(..box_size);

                // Check if this fragment starts with a keyframe
                let is_keyframe = is_keyframe_fragment(&fragment_buffer[moof_start..]);

                // Broadcast complete fragment (moof+mdat) as single unit
                let fragment_arc = Arc::new(std::mem::take(&mut fragment_buffer));

                // Cache fragment for instant client startup (keep from last keyframe)
                if let Ok(mut recent) = state.recent_segments.lock() {
                    let segments = recent.entry(camera_id.to_string())
                        .or_insert_with(VecDeque::new);
                    if is_keyframe {
                        segments.clear(); // Reset: start caching from this keyframe
                    }
                    segments.push_back(fragment_arc.clone());
                    // Safety cap: keep at most 120 fragments (~6s at 50ms)
                    while segments.len() > 120 {
                        segments.pop_front();
                    }
                }

                if let Some(ref sender) = broadcast_sender {
                    if sender.receiver_count() > 0 {
                        let _ = sender.send(fragment_arc);
                    }
                }
            }
            else {
                // Skip unknown box types
                pending.drain(..box_size);
            }
        }

        // Prevent unbounded buffer growth
        if pending.len() > 5 * 1024 * 1024 {
            error!("fMP4 pending buffer exceeds 5MB for {}, resetting", camera_id);
            pending.clear();
            fragment_buffer.clear();
        }
    }

    Ok(())
}

// ── mDNS Advertisement ───────────────────────────────────────────────────────

/// Find the primary outbound IPv4 address by opening a UDP socket toward
/// a public IP (no packets are actually sent). This reliably identifies
/// which local interface the OS would use on the LAN.
fn get_local_ipv4() -> Option<std::net::Ipv4Addr> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    // Connect to a public IP — determines routing, no packet is sent
    socket.connect("8.8.8.8:80").ok()?;
    match socket.local_addr().ok()?.ip() {
        std::net::IpAddr::V4(ip) => Some(ip),
        _ => None,
    }
}

/// Register the app as `stageview.local` via mDNS so browsers on the local
/// network can reach the control panel at http://stageview.local:<port>/
/// without needing to know the IP address.
///
/// Returns the daemon so it stays alive for the process lifetime.
/// If mDNS is unavailable (e.g. firewall blocks multicast) this fails
/// silently — the IP-based URL always works as a fallback.
fn start_mdns(port: u16) -> Option<ServiceDaemon> {
    // Resolve local IP first — mdns-sd requires explicit addresses on Windows
    let local_ip = match get_local_ipv4() {
        Some(ip) => ip,
        None => {
            warn!("mDNS: could not determine local IPv4 address, skipping registration");
            return None;
        }
    };

    let mdns = match ServiceDaemon::new() {
        Ok(d) => d,
        Err(e) => {
            warn!("mDNS: failed to start daemon: {}", e);
            return None;
        }
    };

    let host_name = "stageview.local.";
    let local_ip_str = local_ip.to_string();
    let service_info = match ServiceInfo::new(
        "_http._tcp.local.",
        "StageView",
        host_name,
        local_ip_str.as_str(),
        port,
        None,
    ) {
        Ok(s) => s,
        Err(e) => {
            warn!("mDNS: failed to create service info: {}", e);
            return None;
        }
    };

    match mdns.register(service_info) {
        Ok(_) => {
            info!("mDNS: registered as http://stageview.local:{}/ (IP: {})", port, local_ip);
            Some(mdns)
        }
        Err(e) => {
            warn!("mDNS: failed to register service: {}", e);
            None
        }
    }
}

// ── Network Command API ──────────────────────────────────────────────────────

/// Lightweight HTTP API server for remote control (Stream Deck / Companion).
/// Listens on the configured port and forwards commands to the frontend via events.
async fn run_api_server(app: AppHandle, port: u16) {
    let addr = format!("0.0.0.0:{}", port);
    let listener = match TcpListener::bind(&addr).await {
        Ok(l) => {
            info!("API server listening on http://0.0.0.0:{}", port);
            if let Some(ip) = get_local_ipv4() {
                info!("Control panel: http://{}:{}/ or http://stageview.local:{}/", ip, port, port);
            }
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

            // Handle streaming endpoint (fMP4 for MSE)
            if path.starts_with("/camera/") && path.ends_with("/stream") {
                // Extract camera ID from path like "/camera/cam1/stream"
                let parts: Vec<&str> = path.split('/').collect();
                if parts.len() >= 3 {
                    let camera_id = parts[2].to_string();
                    let state_ref = app_handle.state::<AppState>();

                    // Get or create broadcast sender for this camera
                    let mut rx = {
                        let mut broadcasters = state_ref.frame_broadcasters.lock().unwrap();
                        let sender = broadcasters.entry(camera_id.clone())
                            .or_insert_with(|| tokio::sync::broadcast::channel::<Arc<Vec<u8>>>(60).0);
                        sender.subscribe()
                    };

                    // fMP4 streaming for MSE (H.264 copy, no transcode)
                    let headers = "HTTP/1.1 200 OK\r\n\
                        Content-Type: video/mp4\r\n\
                        Access-Control-Allow-Origin: *\r\n\
                        Cache-Control: no-cache, no-store, must-revalidate\r\n\
                        Pragma: no-cache\r\n\
                        Connection: close\r\n\r\n";

                    if stream.write_all(headers.as_bytes()).await.is_err() {
                        return;
                    }

                    // Send cached initialization segment immediately (ftyp+moov)
                    let init_segment_opt = state_ref.init_segments.lock()
                        .ok()
                        .and_then(|cache| cache.get(&camera_id).cloned());
                    
                    if let Some(init_segment) = init_segment_opt {
                        if stream.write_all(&init_segment).await.is_err() {
                            return;
                        }
                    }

                    // Send cached recent fragments (from last keyframe) for instant startup.
                    // This gives the browser a decodable keyframe immediately instead of
                    // waiting up to GOP-length (1-3 seconds) for the next live keyframe.
                    {
                        let cached_fragments: Vec<Arc<Vec<u8>>> = state_ref.recent_segments.lock()
                            .ok()
                            .and_then(|cache| cache.get(&camera_id).map(|q| q.iter().cloned().collect()))
                            .unwrap_or_default();
                        for fragment in &cached_fragments {
                            if stream.write_all(fragment).await.is_err() {
                                return;
                            }
                        }
                    }

                    // Stream MP4 boxes as they arrive.
                    // Handle RecvError::Lagged gracefully: skip the dropped frames
                    // and resume from the oldest available message rather than
                    // dropping the connection. Dropping the connection forces the
                    // frontend to reconnect and rebuild its MSE pipeline, which
                    // leaks a blob URL each time and degrades over 24+ h uptime.
                    loop {
                        match rx.recv().await {
                            Ok(box_data) => {
                                if stream.write_all(&box_data).await.is_err() {
                                    break;
                                }
                            }
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                                warn!("HTTP stream client lagged by {} MP4 boxes, resuming from oldest", n);
                                // next recv() returns the oldest still-buffered message
                                continue;
                            }
                            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                        }
                    }

                    return;
                }
            }

            // ── Control Panel UI ─────────────────────────────────────────────
            if (path == "/" || path == "/control") && method == "GET" {
                let html = include_str!("control_panel.html");
                let headers = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    html.len()
                );
                let _ = stream.write_all(headers.as_bytes()).await;
                let _ = stream.write_all(html.as_bytes()).await;
                return;
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
                ("404 Not Found", r#"{"ok":false,"error":"unknown endpoint","endpoints":["/","/api/solo/:index","/api/grid","/api/status","/api/fullscreen","/api/reload"]}"#.to_string())
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

// ── Tests ────────────────────────────────────────────────────────────────────


/// Returns the path to the FFmpeg binary (bundled or system).
fn get_ffmpeg_path(app: Option<&AppHandle>) -> PathBuf {
    // If we have app handle, use Tauri's proper resource resolution
    if let Some(app_handle) = app {
        // Try to resolve as a bundled resource
        // In production, Tauri places sidecar binaries in the resource directory
        let binary_name = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
        
        if let Ok(resource_path) = app_handle.path().resolve(binary_name, tauri::path::BaseDirectory::Resource) {
            if resource_path.exists() {
                info!("Found FFmpeg via Tauri resource resolver: {}", resource_path.display());
                return resource_path;
            }
        }
        
        // Also check next to the executable (alternative location)
        if let Ok(current_exe) = std::env::current_exe() {
            if let Some(exe_dir) = current_exe.parent() {
                let sidecar_path = exe_dir.join(binary_name);
                if sidecar_path.exists() {
                    info!("Found FFmpeg next to exe: {}", sidecar_path.display());
                    return sidecar_path;
                }
            }
        }
    }
    
    let exe_dir = std::env::current_exe()
        .unwrap_or_default()
        .parent()
        .unwrap_or(std::path::Path::new("."))
        .to_path_buf();

    // Dev: in src-tauri/binaries/ (next to Cargo.toml)
    let dev_binary_name = if cfg!(windows) {
        "ffmpeg-x86_64-pc-windows-msvc.exe".to_string()
    } else {
        let arch = std::env::consts::ARCH;
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
        info!("Found FFmpeg in dev binaries: {}", dev_path.display());
        dev_path
    } else if prod_sidecar.exists() {
        info!("Found FFmpeg next to exe: {}", prod_sidecar.display());
        prod_sidecar
    } else {
        warn!("FFmpeg not found in expected locations, falling back to PATH");
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

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(move |app| {
            let api_port = config.api_port;
            let window_state = config.window_state.clone();

            // Resolve bundled ffmpeg binary path using Tauri's API
            let ffmpeg_path = get_ffmpeg_path(Some(&app.handle()));
            info!("Using ffmpeg at: {}", ffmpeg_path.display());

            app.manage(AppState {
                config: Mutex::new(config),
                config_path,
                ffmpeg_path,
                stream_tasks: Mutex::new(HashMap::new()),
                reconnect_attempts: Mutex::new(HashMap::new()),
                stream_health: Mutex::new(HashMap::new()),
                frame_broadcasters: Arc::new(Mutex::new(HashMap::new())),
                init_segments: Arc::new(Mutex::new(HashMap::new())),
                recent_segments: Arc::new(Mutex::new(HashMap::new())),
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

            // Advertise as stageview.local on the network via mDNS.
            // Keep the daemon alive for the process lifetime by leaking it.
            if let Some(mdns) = start_mdns(api_port) {
                std::mem::forget(mdns);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            start_streams,
            stop_streams,
            solo_camera,
            get_stream_health,
            api_fullscreen,
            api_reload,
        ])
        .run(tauri::generate_context!())
        .expect("Failed to launch StageView");
}
