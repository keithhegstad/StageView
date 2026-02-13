use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::process::Command;

// ── Data Models ──────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Camera {
    pub id: String,
    pub name: String,
    pub url: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CameraPosition {
    pub camera_id: String,
    pub x: f32,      // 0.0 - 1.0 (percentage of viewport width)
    pub y: f32,      // 0.0 - 1.0 (percentage of viewport height)
    pub width: f32,  // 0.0 - 1.0 (percentage of viewport width)
    pub height: f32, // 0.0 - 1.0 (percentage of viewport height)
    pub z_index: i32, // For picture-in-picture layering
}

/// Corner position for picture-in-picture overlay
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "UPPERCASE")]
pub enum Corner {
    TL,
    TR,
    BL,
    BR,
}

/// Custom deserializer for size_percent to enforce 10-40 range
fn deserialize_size_percent<'de, D>(deserializer: D) -> Result<u8, D::Error>
where
    D: Deserializer<'de>,
{
    let value = u8::deserialize(deserializer)?;
    if (10..=40).contains(&value) {
        Ok(value)
    } else {
        Err(serde::de::Error::custom(format!(
            "size_percent must be between 10 and 40, got {}",
            value
        )))
    }
}

/// Picture-in-picture overlay configuration
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PipOverlay {
    pub camera_id: String,
    pub corner: Corner,
    #[serde(deserialize_with = "deserialize_size_percent")]
    pub size_percent: u8, // 10-40
}

/// Picture-in-picture layout configuration
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PipConfig {
    pub main_camera_id: String,
    pub overlays: Vec<PipOverlay>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct LayoutConfig {
    pub name: String,
    pub layout_type: String, // "grid", "custom", "pip"
    pub positions: Vec<CameraPosition>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pip_config: Option<PipConfig>,
}

impl Default for LayoutConfig {
    fn default() -> Self {
        Self {
            name: "Default Grid".into(),
            layout_type: "grid".into(),
            positions: vec![],
            pip_config: None,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CameraPreset {
    pub name: String,
    pub cameras: Vec<Camera>,
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
    #[serde(default = "default_quality")]
    pub quality: String,
    #[serde(default = "default_api_port")]
    pub api_port: u16,
    #[serde(default)]
    pub layouts: Vec<LayoutConfig>,
    #[serde(default = "default_active_layout")]
    pub active_layout: String, // Name of active layout
    #[serde(default)]
    pub presets: Vec<CameraPreset>,
    #[serde(default)]
    pub window_state: WindowState,
}

fn default_true() -> bool { true }
fn default_quality() -> String { "medium".into() }
fn default_api_port() -> u16 { 8090 }
fn default_active_layout() -> String { "Default Grid".into() }

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            cameras: vec![],
            shuffle_interval_secs: 900,
            show_status_dots: true,
            show_camera_names: true,
            quality: "medium".into(),
            api_port: 8090,
            layouts: vec![LayoutConfig::default()],
            active_layout: "Default Grid".into(),
            presets: vec![],
            window_state: WindowState::default(),
        }
    }
}

#[derive(Serialize, Clone)]
struct FrameEvent {
    camera_id: String,
    data: String,
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
}

#[derive(Serialize, Clone)]
struct StreamHealthEvent {
    camera_id: String,
    health: StreamHealth,
}

// ── App State ────────────────────────────────────────────────────────────────

struct AppState {
    config: Mutex<AppConfig>,
    config_path: String,
    ffmpeg_path: PathBuf,
    stream_tasks: Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>,
    reconnect_attempts: Mutex<HashMap<String, u32>>, // camera_id -> attempt count
    stream_health: Mutex<HashMap<String, StreamHealth>>, // camera_id -> health stats
}

// ── Tauri Commands ───────────────────────────────────────────────────────────

#[tauri::command]
fn get_config(state: State<AppState>) -> AppConfig {
    state.config.lock().unwrap().clone()
}

#[tauri::command]
fn save_config(state: State<AppState>, config: AppConfig) -> Result<(), String> {
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&state.config_path, json).map_err(|e| e.to_string())?;
    *state.config.lock().unwrap() = config;
    Ok(())
}

#[tauri::command]
fn start_streams(state: State<AppState>, app: AppHandle) {
    // Stop any existing streams first
    {
        let mut tasks = state.stream_tasks.lock().unwrap();
        for (_, handle) in tasks.drain() {
            handle.abort();
        }
    }

    let config = state.config.lock().unwrap().clone();
    let ffmpeg_path = state.ffmpeg_path.clone();
    let mut tasks = state.stream_tasks.lock().unwrap();

    let quality = config.quality.clone();
    for camera in &config.cameras {
        let cam_id = camera.id.clone();
        let cam_url = camera.url.clone();
        let ffmpeg = ffmpeg_path.clone();
        let app_handle = app.clone();
        let q = quality.clone();

        let handle = tauri::async_runtime::spawn(async move {
            stream_camera(app_handle, ffmpeg, cam_id, cam_url, q).await;
        });

        tasks.insert(camera.id.clone(), handle);
    }
}

#[tauri::command]
fn stop_streams(state: State<AppState>) {
    let mut tasks = state.stream_tasks.lock().unwrap();
    for (_, handle) in tasks.drain() {
        handle.abort();
    }
}

#[tauri::command]
fn solo_camera(state: State<AppState>, _app: AppHandle, camera_id: String) {
    // Stop all streams except the solo'd one — the solo stream keeps running
    let mut tasks = state.stream_tasks.lock().unwrap();
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
    let config = state.config.lock().unwrap().clone();
    let ffmpeg_path = state.ffmpeg_path.clone();
    let mut tasks = state.stream_tasks.lock().unwrap();
    let quality = config.quality.clone();

    for camera in &config.cameras {
        // Skip cameras that already have a running stream
        if tasks.contains_key(&camera.id) {
            continue;
        }

        let cam_id = camera.id.clone();
        let cam_url = camera.url.clone();
        let ffmpeg = ffmpeg_path.clone();
        let app_handle = app.clone();
        let q = quality.clone();

        let handle = tauri::async_runtime::spawn(async move {
            stream_camera(app_handle, ffmpeg, cam_id, cam_url, q).await;
        });

        tasks.insert(camera.id.clone(), handle);
    }
}

#[tauri::command]
fn get_stream_health(state: State<AppState>) -> HashMap<String, StreamHealth> {
    state.stream_health.lock().unwrap().clone()
}

#[tauri::command]
fn save_preset(state: State<AppState>, name: String) -> Result<(), String> {
    let mut config = state.config.lock().unwrap();
    let preset = CameraPreset {
        name: name.clone(),
        cameras: config.cameras.clone(),
    };
    if let Some(idx) = config.presets.iter().position(|p| p.name == name) {
        config.presets[idx] = preset;
    } else {
        config.presets.push(preset);
    }
    let json = serde_json::to_string_pretty(&*config).map_err(|e| e.to_string())?;
    std::fs::write(&state.config_path, json).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn load_preset(state: State<AppState>, name: String) -> Result<Vec<Camera>, String> {
    let config = state.config.lock().unwrap();
    config.presets.iter().find(|p| p.name == name)
        .map(|p| p.cameras.clone())
        .ok_or("Preset not found".into())
}

#[tauri::command]
fn delete_preset(state: State<AppState>, name: String) -> Result<(), String> {
    let mut config = state.config.lock().unwrap();
    config.presets.retain(|p| p.name != name);
    let json = serde_json::to_string_pretty(&*config).map_err(|e| e.to_string())?;
    std::fs::write(&state.config_path, json).map_err(|e| e.to_string())?;
    Ok(())
}

// ── Camera Streaming ─────────────────────────────────────────────────────────

/// Wrapper that retries streaming with exponential backoff on failure.
async fn stream_camera(
    app: AppHandle,
    ffmpeg_path: PathBuf,
    camera_id: String,
    url: String,
    quality: String,
) {
    eprintln!("[StageView] Starting stream for {} → {}", camera_id, url);

    const BASE_DELAY_MS: u64 = 1000;
    const MAX_DELAY_MS: u64 = 60000;
    const MAX_ATTEMPTS: u32 = 10;

    loop {
        // Get current attempt count
        let attempt = {
            let state = app.state::<AppState>();
            let mut attempts = state.reconnect_attempts.lock().unwrap();
            let count = attempts.entry(camera_id.clone()).or_insert(0);
            *count += 1;
            *count
        };

        // Emit status event
        let status = if attempt == 1 {
            "connecting".to_string()
        } else {
            format!("reconnecting (attempt {})", attempt)
        };
        let _ = app.emit("camera-status", CameraStatusEvent {
            camera_id: camera_id.clone(),
            status,
        });

        // Attempt to stream
        let state = app.state::<AppState>();
        match try_stream_camera(&app, &state, &ffmpeg_path, &camera_id, &url, &quality).await {
            Ok(()) => {
                eprintln!("[StageView] Stream ended normally for {}", camera_id);
                // Reset attempt counter on success
                state.reconnect_attempts.lock().unwrap().insert(camera_id.clone(), 0);
            }
            Err(e) => {
                eprintln!("[StageView] Stream failed for {}: {}", camera_id, e);
            }
        }

        // Check if we should retry
        if attempt >= MAX_ATTEMPTS {
            eprintln!("[StageView] Max retry attempts ({}) reached for {}", MAX_ATTEMPTS, camera_id);
            let _ = app.emit("camera-status", CameraStatusEvent {
                camera_id: camera_id.clone(),
                status: "error".into(),
            });
            break;
        }

        // Calculate backoff delay: min(BASE * 2^(attempt-1), MAX)
        let delay_ms = (BASE_DELAY_MS * 2u64.pow(attempt - 1)).min(MAX_DELAY_MS);
        eprintln!("[StageView] Retrying {} in {}ms (attempt {})", camera_id, delay_ms, attempt);

        tokio::time::sleep(tokio::time::Duration::from_millis(delay_ms)).await;
    }
}

/// Spawns ffmpeg for a single camera, reads JPEG frames from its stdout,
/// and pushes each frame to the frontend as a base64-encoded Tauri event.
async fn try_stream_camera(
    app: &AppHandle,
    state: &tauri::State<'_, AppState>,
    ffmpeg_path: &PathBuf,
    camera_id: &str,
    url: &str,
    quality: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let start_time = std::time::Instant::now();
    let mut frame_count: u64 = 0;
    let mut bytes_received: u64 = 0;
    let mut last_health_update = std::time::Instant::now();

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
            "-analyzeduration".into(), "10000000".into(),
            "-probesize".into(),       "10000000".into(),
            "-buffer_size".into(),     "2000000".into(),
            "-overrun_nonfatal".into(),"1".into(),
        ]);
        format!("udp://@{}", addr)
    } else if url.starts_with("rtsp://") {
        args.extend([
            "-rtsp_transport".into(),    "tcp".into(),
            "-allowed_media_types".into(),"video".into(),
        ]);
        url.to_string()
    } else if url.starts_with("srt://") {
        args.extend([
            "-analyzeduration".into(), "10000000".into(),
            "-probesize".into(),       "10000000".into(),
        ]);
        url.to_string()
    } else {
        // HTTP MJPEG, file, or other – pass through as-is
        url.to_string()
    };

    // Quality presets: fps, jpeg quality (lower = better), scale
    let (fps, q_v, scale) = match quality {
        "low"  => ("5",  "10", Some("scale='min(640,iw)':-2")),
        "high" => ("15", "3",  None),
        _      => ("10", "5",  None), // medium (default)
    };

    let mut vf_parts: Vec<String> = Vec::new();
    if let Some(s) = scale {
        vf_parts.push(s.to_string());
    }
    vf_parts.push(format!("fps={}", fps));
    let vf = vf_parts.join(",");

    args.extend([
        "-i".into(),   input_url,
        "-vf".into(),  vf,
        "-f".into(),   "image2pipe".into(),
        "-c:v".into(), "mjpeg".into(),
        "-q:v".into(), q_v.into(),
        "-an".into(),
        "pipe:1".into(),
    ]);

    eprintln!("[StageView] ffmpeg args: {}", args.join(" "));

    let mut cmd = Command::new(ffmpeg_path);
    cmd.args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);

    // Hide the console window on Windows
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn()
        .map_err(|e| {
            eprintln!("[StageView] Failed to spawn ffmpeg for {}: {}", camera_id, e);
            e
        })?;

    // Initialize health entry
    {
        let mut health_map = state.stream_health.lock().unwrap();
        health_map.insert(camera_id.to_string(), StreamHealth {
            camera_id: camera_id.to_string(),
            fps: 0.0,
            bitrate_kbps: 0.0,
            frame_count: 0,
            last_frame_at: 0,
            uptime_secs: 0,
        });
    }

    let mut stdout = child.stdout.take().unwrap();
    let mut buf = vec![0u8; 131_072]; // 128 KB read buffer
    let mut frame = Vec::with_capacity(65_536);
    let mut prev_byte: u8 = 0;
    let mut frame_count_local: u64 = 0;

    loop {
        let n = match stdout.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => {
                eprintln!("[StageView] Read error for {}: {}", camera_id, e);
                return Err(Box::new(e));
            }
        };

        for &byte in &buf[..n] {
            // Detect JPEG SOI marker (0xFF 0xD8) = start of a new frame.
            // When we see a *second* SOI, everything before it is a complete frame.
            if prev_byte == 0xFF && byte == 0xD8 && frame.len() > 2 {
                // Pop the 0xFF that belongs to the new SOI
                frame.pop();

                if frame.len() > 100 && frame[0] == 0xFF && frame[1] == 0xD8 {
                    frame_count_local += 1;
                    frame_count += 1;
                    bytes_received += frame.len() as u64;

                    if frame_count_local == 1 {
                        eprintln!(
                            "[StageView] First frame for {} ({} bytes)",
                            camera_id,
                            frame.len()
                        );

                        // Reset attempt counter on first successful frame
                        state.reconnect_attempts.lock().unwrap().insert(camera_id.to_string(), 0);

                        let _ = app.emit(
                            "camera-status",
                            CameraStatusEvent {
                                camera_id: camera_id.to_string(),
                                status: "online".into(),
                            },
                        );
                    }
                    let b64 = BASE64.encode(&frame);
                    let _ = app.emit(
                        "camera-frame",
                        FrameEvent {
                            camera_id: camera_id.to_string(),
                            data: b64,
                        },
                    );

                    // Update health stats every 2 seconds
                    if last_health_update.elapsed().as_secs() >= 2 {
                        let uptime = start_time.elapsed().as_secs();
                        let fps = frame_count as f32 / uptime as f32;
                        let bitrate_kbps = (bytes_received as f32 * 8.0) / (uptime as f32 * 1000.0);

                        let health = StreamHealth {
                            camera_id: camera_id.to_string(),
                            fps,
                            bitrate_kbps,
                            frame_count,
                            last_frame_at: std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap()
                                .as_millis() as u64,
                            uptime_secs: uptime,
                        };

                        state.stream_health.lock().unwrap().insert(camera_id.to_string(), health.clone());

                        let _ = app.emit("stream-health", StreamHealthEvent {
                            camera_id: camera_id.to_string(),
                            health,
                        });

                        last_health_update = std::time::Instant::now();
                    }
                }

                frame.clear();
                frame.push(0xFF);
                frame.push(0xD8);
            } else {
                frame.push(byte);
            }
            prev_byte = byte;
        }
    }

    eprintln!(
        "[StageView] Stream ended for {} after {} frames",
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
            eprintln!("[StageView] API server listening on http://{}", addr);
            l
        }
        Err(e) => {
            eprintln!("[StageView] Failed to start API server on {}: {}", addr, e);
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
            let n = match stream.read(&mut buf).await {
                Ok(n) if n > 0 => n,
                _ => return,
            };

            let request = String::from_utf8_lossy(&buf[..n]);
            let first_line = request.lines().next().unwrap_or("");
            let path = first_line.split_whitespace().nth(1).unwrap_or("/");

            eprintln!("[StageView] API request from {}: {}", peer, path);

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
                let config = app_handle.state::<AppState>().config.lock().unwrap().clone();
                let cameras_json: Vec<String> = config.cameras.iter().enumerate().map(|(i, c)| {
                    format!(r#"{{"index":{},"id":"{}","name":"{}"}}"#, i + 1, c.id, c.name)
                }).collect();
                ("200 OK", format!(r#"{{"ok":true,"cameras":[{}]}}"#, cameras_json.join(",")))
            } else {
                ("404 Not Found", r#"{"ok":false,"error":"unknown endpoint","endpoints":["/api/solo/:index","/api/grid","/api/status"]}"#.to_string())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_corner_serialization() {
        let corner = Corner::TL;
        let json = serde_json::to_string(&corner).unwrap();
        assert_eq!(json, r#""TL""#);

        let corner = Corner::BR;
        let json = serde_json::to_string(&corner).unwrap();
        assert_eq!(json, r#""BR""#);
    }

    #[test]
    fn test_corner_deserialization() {
        let corner: Corner = serde_json::from_str(r#""TL""#).unwrap();
        assert!(matches!(corner, Corner::TL));

        let corner: Corner = serde_json::from_str(r#""BR""#).unwrap();
        assert!(matches!(corner, Corner::BR));
    }

    #[test]
    fn test_corner_deserialization_invalid() {
        let result: Result<Corner, _> = serde_json::from_str(r#""INVALID""#);
        assert!(result.is_err());
    }

    #[test]
    fn test_pip_overlay_valid_size() {
        let json = r#"{
            "camera_id": "cam1",
            "corner": "TL",
            "size_percent": 25
        }"#;
        let overlay: PipOverlay = serde_json::from_str(json).unwrap();
        assert_eq!(overlay.camera_id, "cam1");
        assert!(matches!(overlay.corner, Corner::TL));
        assert_eq!(overlay.size_percent, 25);
    }

    #[test]
    fn test_pip_overlay_size_too_small() {
        let json = r#"{
            "camera_id": "cam1",
            "corner": "TL",
            "size_percent": 5
        }"#;
        let result: Result<PipOverlay, _> = serde_json::from_str(json);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("must be between 10 and 40"));
    }

    #[test]
    fn test_pip_overlay_size_too_large() {
        let json = r#"{
            "camera_id": "cam1",
            "corner": "TL",
            "size_percent": 50
        }"#;
        let result: Result<PipOverlay, _> = serde_json::from_str(json);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("must be between 10 and 40"));
    }

    #[test]
    fn test_pip_config_serialization() {
        let config = PipConfig {
            main_camera_id: "main".to_string(),
            overlays: vec![
                PipOverlay {
                    camera_id: "cam1".to_string(),
                    corner: Corner::TL,
                    size_percent: 20,
                },
                PipOverlay {
                    camera_id: "cam2".to_string(),
                    corner: Corner::BR,
                    size_percent: 30,
                },
            ],
        };

        let json = serde_json::to_string_pretty(&config).unwrap();
        let parsed: PipConfig = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.main_camera_id, "main");
        assert_eq!(parsed.overlays.len(), 2);
        assert_eq!(parsed.overlays[0].camera_id, "cam1");
        assert_eq!(parsed.overlays[1].size_percent, 30);
    }
}

// ── App Entry ────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let (config, config_path) = load_config();

    // Resolve bundled ffmpeg binary path
    let ffmpeg_path = {
        let exe_dir = std::env::current_exe()
            .unwrap_or_default()
            .parent()
            .unwrap_or(std::path::Path::new("."))
            .to_path_buf();

        // Dev: in src-tauri/binaries/ (next to Cargo.toml)
        let dev_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(if cfg!(windows) { "ffmpeg-x86_64-pc-windows-msvc.exe" } else { "ffmpeg-aarch64-unknown-linux-gnu" });

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
    };
    eprintln!("[StageView] Using ffmpeg at: {}", ffmpeg_path.display());

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
            });

            // Restore window position and size
            if let Some(window) = app.get_webview_window("main") {
                use tauri::Position;
                use tauri::Size;

                let _ = window.set_position(Position::Physical(tauri::PhysicalPosition {
                    x: window_state.x,
                    y: window_state.y,
                }));

                let _ = window.set_size(Size::Physical(tauri::PhysicalSize {
                    width: window_state.width,
                    height: window_state.height,
                }));

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
            save_preset,
            load_preset,
            delete_preset,
        ])
        .run(tauri::generate_context!())
        .expect("Failed to launch StageView");
}
