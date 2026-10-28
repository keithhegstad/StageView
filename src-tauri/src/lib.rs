use mdns_sd::{ServiceDaemon, ServiceInfo};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
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
    /// Optional low-res substream shown in the grid; `url` is used in solo mode.
    #[serde(default)]
    pub grid_url: Option<String>,
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
    /// Shared secret for /api/* requests from the network (`?token=`). Empty = no auth.
    #[serde(default)]
    pub api_token: String,
    /// Local adapter IPv4 to join camera multicast groups on. Empty = automatic
    /// (the adapter carrying the default route).
    #[serde(default)]
    pub multicast_interface: String,
    /// When StageView last looked for an update (Unix ms); checks run once a day.
    #[serde(default)]
    pub last_update_check: u64,
    /// The version this PC last ran, so the first launch after an update can show what changed.
    #[serde(default)]
    pub last_seen_version: String,
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
            api_token: String::new(),
            multicast_interface: String::new(),
            last_update_check: 0,
            last_seen_version: String::new(),
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

/// A chunk of fMP4 shared between clients without copying (~200 KB per fragment).
type Segment = Arc<Vec<u8>>;
type FrameSender = tokio::sync::broadcast::Sender<Segment>;

fn frame_channel() -> FrameSender {
    tokio::sync::broadcast::channel(60).0
}

struct AppState {
    config: Mutex<AppConfig>,
    config_path: PathBuf,
    ffmpeg_path: PathBuf,
    stream_tasks: Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>,
    reconnect_attempts: Mutex<HashMap<String, u32>>, // camera_id -> attempt count
    stream_health: Mutex<HashMap<String, StreamHealth>>, // camera_id -> health stats
    frame_broadcasters: Mutex<HashMap<String, FrameSender>>, // camera_id -> frame broadcaster
    init_segments: Mutex<HashMap<String, Segment>>, // camera_id -> cached ftyp+moov initialization segment
    recent_segments: Mutex<HashMap<String, VecDeque<Segment>>>, // camera_id -> cached fragments from last keyframe (for instant client startup)
}

// ── Tauri Commands ───────────────────────────────────────────────────────────

#[tauri::command]
fn get_config(state: State<AppState>) -> Result<AppConfig, String> {
    let config = state.config.lock()
        .map_err(|_| "Config mutex poisoned - please restart application".to_string())?
        .clone();
    Ok(config)
}

/// Tokens travel in URLs (`?token=`), so keep them to characters that never
/// need percent-encoding — otherwise the control panel's encoded form never matches.
fn valid_api_token(token: &str) -> bool {
    token.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[tauri::command]
fn save_config(state: State<AppState>, config: AppConfig) -> Result<(), String> {
    if !valid_api_token(&config.api_token) {
        return Err("API token may only contain letters, digits, - and _".to_string());
    }
    if !valid_multicast_interface(&config.multicast_interface) {
        return Err("Multicast adapter must be empty (automatic) or this PC's IPv4 address, e.g. 192.168.3.71".to_string());
    }
    write_config(&state.config_path, &config).map_err(|e| e.to_string())?;
    *state.config.lock()
        .map_err(|_| "Config mutex poisoned - please restart application".to_string())? = config;
    Ok(())
}

/// Stream id suffix for a camera's grid substream (camera ids are UUIDs, so no clash).
const GRID_SUFFIX: &str = ".grid";

/// (stream id, url) pairs to run for a camera: always the main stream, plus
/// the grid substream when one is configured.
fn stream_targets(camera: &Camera) -> Vec<(String, String)> {
    let mut targets = vec![(camera.id.clone(), camera.url.clone())];
    if let Some(grid) = camera.grid_url.as_deref().map(str::trim) {
        if !grid.is_empty() && grid != camera.url {
            targets.push((format!("{}{}", camera.id, GRID_SUFFIX), grid.to_string()));
        }
    }
    targets
}

/// Spawn one retrying stream task per stream target, keyed by stream id.
fn spawn_camera_streams(
    app: &AppHandle,
    ffmpeg_path: &Path,
    cameras: &[Camera],
    tasks: &mut HashMap<String, tauri::async_runtime::JoinHandle<()>>,
) {
    for camera in cameras {
        for (stream_id, url) in stream_targets(camera) {
            let app_handle = app.clone();
            let ffmpeg = ffmpeg_path.to_path_buf();
            let id = stream_id.clone();
            let handle = tauri::async_runtime::spawn(async move {
                stream_camera(app_handle, ffmpeg, id, url).await;
            });
            tasks.insert(stream_id, handle);
        }
    }
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

    spawn_camera_streams(&app, &ffmpeg_path, &config.cameras, &mut tasks);
}

#[tauri::command]
fn stop_streams(state: State<AppState>, app: AppHandle) {
    stop_all_streams(&state, &app);
}

/// Abort every stream task and forget everything cached about the streams.
fn stop_all_streams(state: &AppState, app: &AppHandle) {
    let camera_ids: Vec<String> = {
        let mut tasks = state.stream_tasks.lock().unwrap_or_else(|p| p.into_inner());
        tasks.drain().map(|(id, handle)| { handle.abort(); id }).collect()
    };
    // Clear stale health data, reconnect counters, and stream segment caches.
    // Cameras removed from config would otherwise leave stale data indefinitely,
    // and a camera whose URL changed would hand new clients the old stream's start.
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
    for id in camera_ids {
        let _ = app.emit("camera-status", CameraStatusEvent {
            camera_id: id,
            status: "offline".to_string(),
        });
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

/// Output args: copy the video (no transcode) into fragmented MP4 for MSE.
const COPY_TO_FMP4_ARGS: &[&str] = &[
    "-c:v", "copy",
    "-f", "mp4",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    "-frag_duration", "50000", // 50ms fragments for ultra-fast startup
    "-min_frag_duration", "50000",
    "-flush_packets", "1", // Force immediate writes to stdout
    "-an", // No audio
];

/// The boxes laid end to end in `data`, as (type, whole box including its
/// header). Stops at the first box whose size doesn't fit.
fn mp4_boxes(data: &[u8]) -> impl Iterator<Item = (&[u8], &[u8])> + '_ {
    let mut offset = 0;
    std::iter::from_fn(move || {
        let size = be_u32(data, offset)? as usize;
        if size < 8 || offset + size > data.len() { return None; }
        let mp4_box = &data[offset..offset + size];
        offset += size;
        Some((&mp4_box[4..8], mp4_box))
    })
}

fn be_u32(data: &[u8], at: usize) -> Option<u32> {
    data.get(at..at + 4).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
}

/// The children of every traf box inside a moof (`moof` starts with the moof header).
fn traf_children(moof: &[u8]) -> impl Iterator<Item = (&[u8], &[u8])> + '_ {
    mp4_boxes(moof.get(8..).unwrap_or_default())
        .filter(|(kind, _)| *kind == b"traf")
        .flat_map(|(_, traf)| mp4_boxes(&traf[8..]))
}

/// Check if a moof box contains a keyframe (sync sample) by parsing traf→tfhd/trun flags.
/// Used to cache fragments from the last keyframe for instant client startup.
fn is_keyframe_fragment(moof: &[u8]) -> bool {
    // sample_is_non_sync_sample (bit 16) clear → keyframe
    let is_sync = |sample_flags: u32| (sample_flags >> 16) & 1 == 0;
    let mut default_flags = None;
    for (kind, child) in traf_children(moof) {
        let flags = be_u32(child, 8).unwrap_or(0) & 0x00FF_FFFF;
        if kind == b"tfhd" {
            // Optional fields before default_sample_flags, past header(8) + version/flags(4) + track_id(4):
            // base_data_offset, sample_description_index, default_sample_duration, default_sample_size
            let offset = [(0x01, 8), (0x02, 4), (0x08, 4), (0x10, 4)].iter()
                .filter(|(bit, _)| flags & bit != 0)
                .fold(16, |off, (_, len)| off + len);
            if flags & 0x20 != 0 {
                default_flags = be_u32(child, offset);
            }
        } else if kind == b"trun" {
            // first_sample_flags is authoritative for the first sample; it sits past
            // header(8) + version/flags(4) + sample_count(4) [+ data_offset(4)]
            let first = if flags & 0x04 != 0 {
                be_u32(child, if flags & 0x01 != 0 { 20 } else { 16 })
            } else {
                None
            };
            // No explicit flags — assume keyframe (conservative)
            return first.or(default_flags).is_none_or(is_sync);
        }
    }
    false
}

/// Decide whether a broadcast message goes to an HTTP client. After the client
/// lags, mid-GOP fragments would make the decoder smear until the next IDR, so
/// drop fragments until a keyframe arrives. Init segments (ftyp+moov) always
/// pass: FFmpeg emits a fresh one after every reconnect.
fn should_forward(msg: &[u8], waiting_for_keyframe: &mut bool) -> bool {
    if msg.len() >= 8 && &msg[4..8] == b"ftyp" {
        return true;
    }
    if !*waiting_for_keyframe {
        return true;
    }
    if is_keyframe_fragment(msg) {
        *waiting_for_keyframe = false;
        return true;
    }
    false
}

/// Count the total number of video samples (frames) declared in all trun boxes
/// inside a moof box. This gives the exact frame count for the following mdat,
/// which may contain multiple frames when frag_duration > one frame period.
fn count_samples_in_moof(moof: &[u8]) -> u64 {
    let total: u64 = traf_children(moof)
        .filter(|(kind, _)| *kind == b"trun")
        .filter_map(|(_, trun)| be_u32(trun, 12)) // sample_count, past header + version/flags
        .map(u64::from)
        .sum();
    total.max(1) // always count at least 1 to avoid stalling on malformed boxes
}

/// Human-readable codec for the health panel, from the init segment's config box.
fn codec_label(init: &[u8]) -> &'static str {
    let has = |tag: &[u8]| init.windows(4).any(|w| w == tag);
    if has(b"hvcC") { "H.265 (copy)" } else if has(b"avcC") { "H.264 (copy)" } else { "unknown (copy)" }
}

/// Windows job object that kills every process assigned to it when its last
/// handle closes. The OS closes our handles when StageView exits — cleanly,
/// killed or crashed — so FFmpeg can never outlive the app. (Orphaned FFmpeg
/// for an offline camera never notices the broken pipe, and kept the API port
/// bound through an inherited socket, so the next launch had no video.)
/// Only FFmpeg joins the job: the updater's installer must survive our exit.
#[cfg(windows)]
struct KillJob(usize); // HANDLE as usize so the job can live in a static

#[cfg(windows)]
impl KillJob {
    fn new() -> std::io::Result<Self> {
        use windows_sys::Win32::System::JobObjects::{
            CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            let job = KillJob(handle as usize);
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                job.0 as _,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of_val(&info) as u32,
            );
            if ok == 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(job)
        }
    }

    fn assign(&self, process: std::os::windows::io::RawHandle) -> std::io::Result<()> {
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
        if unsafe { AssignProcessToJobObject(self.0 as _, process as _) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
}

#[cfg(windows)]
impl Drop for KillJob {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0 as _); }
    }
}

/// The app-wide job every FFmpeg process joins (created on first use).
#[cfg(windows)]
fn ffmpeg_kill_job() -> Option<&'static KillJob> {
    static JOB: std::sync::OnceLock<Option<KillJob>> = std::sync::OnceLock::new();
    JOB.get_or_init(|| {
        KillJob::new()
            .map_err(|e| error!("Could not create FFmpeg job object: {}", e))
            .ok()
    })
    .as_ref()
}

/// Stop child processes from inheriting a socket (so they can't keep it bound).
#[cfg(windows)]
fn make_non_inheritable(socket: std::os::windows::io::RawSocket) -> std::io::Result<()> {
    use windows_sys::Win32::Foundation::{SetHandleInformation, HANDLE_FLAG_INHERIT};
    if unsafe { SetHandleInformation(socket as _, HANDLE_FLAG_INHERIT, 0) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
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

        // Attempt to stream. The attempt counter is reset only when video
        // actually arrives (in process_fmp4_stream), so a camera that keeps
        // failing backs off instead of retrying every second.
        let state = app.state::<AppState>();
        if let Err(e) = try_stream_camera(&app, &state, &ffmpeg_path, &camera_id, &url).await {
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

/// Add `localaddr=<ip>` so FFmpeg joins the multicast group on that adapter.
/// Without it Windows joins on the adapter with the best metric, which can be a
/// virtual one (Hyper-V/WSL/Docker "vEthernet") that never sees the cameras.
fn with_localaddr(url: String, multicast_iface: Option<&str>) -> String {
    match multicast_iface {
        Some(ip) => {
            let sep = if url.contains('?') { '&' } else { '?' };
            format!("{}{}localaddr={}", url, sep, ip)
        }
        None => url,
    }
}

/// Protocol-specific FFmpeg input flags plus the (possibly rewritten) input URL.
/// `multicast_iface` is the local adapter address to join rtp:// and udp:// groups on.
fn build_input_args(url: &str, multicast_iface: Option<&str>) -> (Vec<String>, String) {
    let mut args: Vec<String> = Vec::new();
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
        with_localaddr(url.to_string(), multicast_iface)
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
            // No "-avioflags direct" here or for SRT: it reads each datagram into a
            // buffer smaller than the packet, and FFmpeg never gets a whole one.
            "-buffer_size".into(),     "2000000".into(),
            "-overrun_nonfatal".into(),"1".into(),
            "-thread_queue_size".into(),"512".into(),
        ]);
        with_localaddr(format!("udp://@{}?timeout=10000000", addr), multicast_iface)
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
            "-timeout".into(),           "10000000".into(), // 10s socket timeout (µs); -stimeout was removed in FFmpeg 5
        ]);
        url.to_string()
    } else if url.starts_with("srt://") {
        args.extend([
            "-analyzeduration".into(), "50000".into(),
            "-probesize".into(),       "50000".into(),
            "-fflags".into(),          "+nobuffer+discardcorrupt+fastseek".into(),
            "-flags".into(),           "low_delay".into(),
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
    (args, input_url)
}

/// Spawns FFmpeg for one stream, reads fMP4 from its stdout and broadcasts
/// it to the local HTTP stream clients.
async fn try_stream_camera(
    app: &AppHandle,
    state: &tauri::State<'_, AppState>,
    ffmpeg_path: &Path,
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
            .or_insert_with(frame_channel);
    }

    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
    ];

    let multicast_iface = multicast_interface(state);
    if url.starts_with("rtp://") || url.starts_with("udp://") {
        info!("Joining multicast for {} on adapter {}", camera_id, multicast_iface.as_deref().unwrap_or("(Windows default)"));
    }
    let (input_args, input_url) = build_input_args(url, multicast_iface.as_deref());
    args.extend(input_args);
    args.extend(["-i".into(), input_url]);

    args.extend(COPY_TO_FMP4_ARGS.iter().map(|a| a.to_string()));
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

    #[cfg(windows)]
    if let (Some(job), Some(handle)) = (ffmpeg_kill_job(), child.raw_handle()) {
        if let Err(e) = job.assign(handle) {
            warn!("Could not tie FFmpeg for {} to the app's lifetime: {}", camera_id, e);
        }
    }

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
                codec: "detecting…".to_string(),
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

            let codec = health_app.state::<AppState>().stream_health.lock().ok()
                .and_then(|h| h.get(&health_camera_id).map(|e| e.codec.clone()))
                .unwrap_or_else(|| "unknown (copy)".to_string());

            let health = StreamHealth {
                camera_id: health_camera_id.clone(),
                fps,
                bitrate_kbps,
                frame_count: count,
                // Only reflects time of actual frame receipt; stays 0 until first frame arrives.
                last_frame_at: health_last_frame_at.load(Ordering::Relaxed),
                uptime_secs: uptime,
                codec,
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

    // Process fMP4 stream (H.264 copy, MSE-ready).
    // _health_guard and _stderr_guard are RAII — they abort their tasks
    // automatically when this function returns (normally, via error, or cancellation).
    let result = process_fmp4_stream(
        stdout,
        state,
        camera_id,
        app,
        &frame_count,
        &bytes_received,
        &last_frame_at,
    ).await;

    // Remove health entry on every exit path, so the panel never shows a dead stream's numbers
    if let Ok(mut health_map) = state.stream_health.lock() {
        health_map.remove(camera_id);
    }
    result?;

    let total_frames = frame_count.load(Ordering::Relaxed);

    info!(
        "Stream ended for {} after {} frames",
        camera_id, total_frames
    );

    // FFmpeg exiting without any video (connection refused, bad URL) is a
    // failure: the retry wrapper backs off and, after a few, tells the user.
    if total_frames == 0 {
        let _ = app.emit("camera-status", CameraStatusEvent {
            camera_id: camera_id.to_string(),
            status: "offline".to_string(),
        });
        return Err("FFmpeg exited before sending any video".into());
    }

    Ok(())
}

/// Process fMP4 stream (fragmented MP4 with moof/mdat boxes for MSE)
async fn process_fmp4_stream(
    mut stdout: tokio::process::ChildStdout,
    state: &tauri::State<'_, AppState>,
    camera_id: &str,
    app: &AppHandle,
    frame_count: &AtomicU64,
    bytes_received: &AtomicU64,
    last_frame_at: &AtomicU64,
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
            if !(8..=50 * 1024 * 1024).contains(&box_size) {
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

                    if let Ok(mut health) = state.stream_health.lock() {
                        if let Some(entry) = health.get_mut(camera_id) {
                            entry.codec = codec_label(&init_segment).to_string();
                        }
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

/// Adapter to join multicast on: the configured one, else the default-route adapter.
fn multicast_interface(state: &AppState) -> Option<String> {
    let configured = state.config.lock().ok().map(|c| c.multicast_interface.trim().to_string()).unwrap_or_default();
    if !configured.is_empty() {
        return Some(configured);
    }
    get_local_ipv4().map(|ip| ip.to_string())
}

/// Empty (automatic) or a plain unicast IPv4 address.
fn valid_multicast_interface(value: &str) -> bool {
    let value = value.trim();
    value.is_empty()
        || value.parse::<std::net::Ipv4Addr>().is_ok_and(|ip| {
            !ip.is_multicast() && !ip.is_unspecified() && !ip.is_broadcast()
        })
}

/// True for development builds (`tauri dev`). They share the installed app's
/// config, so the frontend keeps them from recording which version this PC ran.
#[tauri::command]
fn is_dev_build() -> bool {
    cfg!(debug_assertions)
}

/// The adapter address automatic mode would use, shown as a hint in Settings.
#[tauri::command]
fn default_multicast_interface() -> Option<String> {
    get_local_ipv4().map(|ip| ip.to_string())
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

/// Split an HTTP request target into path and optional query string.
fn split_path_query(target: &str) -> (&str, Option<&str>) {
    match target.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (target, None),
    }
}

/// True when `expected` is empty (auth disabled) or the query carries `token=<expected>`.
fn token_ok(query: Option<&str>, expected: &str) -> bool {
    if expected.is_empty() {
        return true;
    }
    let given = query
        .unwrap_or("")
        .split('&')
        .find_map(|pair| pair.strip_prefix("token="))
        .unwrap_or("");
    // Constant-time compare so response timing doesn't leak the token
    given.len() == expected.len()
        && given.bytes().zip(expected.bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

/// Lightweight HTTP API server for remote control (Stream Deck / Companion).
/// Listens on the configured port and forwards commands to the frontend via events.
async fn run_api_server(app: AppHandle, port: u16) {
    let addr = format!("0.0.0.0:{}", port);
    let listener = match TcpListener::bind(&addr).await {
        Ok(l) => {
            #[cfg(windows)]
            {
                use std::os::windows::io::AsRawSocket;
                if let Err(e) = make_non_inheritable(l.as_raw_socket()) {
                    warn!("Could not make API socket non-inheritable: {}", e);
                }
            }
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
            let target = first_line.split_whitespace().nth(1).unwrap_or("/");
            let (path, query) = split_path_query(target);

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
                // Video is for the local webview only — never serve it to the LAN
                if !peer.ip().is_loopback() {
                    let _ = stream.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                    return;
                }
                // Extract camera ID from path like "/camera/cam1/stream"
                let parts: Vec<&str> = path.split('/').collect();
                if parts.len() >= 3 {
                    let camera_id = parts[2].to_string();
                    let state_ref = app_handle.state::<AppState>();

                    // Get or create broadcast sender for this camera
                    let mut rx = {
                        let mut broadcasters = state_ref.frame_broadcasters.lock().unwrap();
                        let sender = broadcasters.entry(camera_id.clone())
                            .or_insert_with(frame_channel);
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
                        let cached_fragments: Vec<Segment> = state_ref.recent_segments.lock()
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
                    // Handle RecvError::Lagged gracefully: keep the connection and
                    // resume at the next keyframe, so the decoder never sees a
                    // broken GOP (smearing until the next IDR). Dropping the
                    // connection instead would force the frontend to rebuild its
                    // MSE pipeline, which degrades over 24+ h uptime.
                    let mut waiting_for_keyframe = false;
                    loop {
                        match rx.recv().await {
                            Ok(box_data) => {
                                if !should_forward(&box_data, &mut waiting_for_keyframe) {
                                    continue;
                                }
                                if stream.write_all(&box_data).await.is_err() {
                                    break;
                                }
                            }
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                                warn!("HTTP stream client lagged by {} fragments, skipping to next keyframe", n);
                                waiting_for_keyframe = true;
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

            let expected_token = app_handle.state::<AppState>().config.lock()
                .map(|c| c.api_token.clone())
                .unwrap_or_default();
            if path.starts_with("/api/") && !token_ok(query, &expected_token) {
                let body = r#"{"ok":false,"error":"invalid or missing token"}"#;
                let response = format!(
                    "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(), body
                );
                let _ = stream.write_all(response.as_bytes()).await;
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
                match api_fullscreen(&app_handle) {
                    Ok(result) => ("200 OK", result.to_string()),
                    Err(e) => ("500 Internal Server Error", serde_json::json!({"ok": false, "error": e}).to_string()),
                }
            } else if path == "/api/reload" {
                match api_reload(&app_handle) {
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

fn load_config() -> (AppConfig, PathBuf) {
    let dir = config_dir();
    std::fs::create_dir_all(&dir).ok();
    let path = dir.join("config.json");
    (read_config(&path), path)
}

/// The config at `path`, or the default when there is none. A file that exists
/// but won't parse is copied aside first, so the next save can't erase the
/// cameras it holds.
fn read_config(path: &Path) -> AppConfig {
    let Ok(text) = std::fs::read_to_string(path) else {
        return AppConfig::default();
    };
    match serde_json::from_str(&text) {
        Ok(config) => config,
        Err(e) => {
            let backup = path.with_extension("json.unreadable");
            error!("Config at {} is unreadable ({}); kept a copy at {}", path.display(), e, backup.display());
            let _ = std::fs::copy(path, &backup);
            AppConfig::default()
        }
    }
}

/// Write the config so a crash or power cut mid-save leaves the old file intact:
/// write a temporary file, flush it to disk, then rename it over the original.
fn write_config(path: &Path, config: &AppConfig) -> std::io::Result<()> {
    use std::io::Write;
    let json = serde_json::to_string_pretty(config)?;
    let tmp = path.with_extension("json.tmp");
    let mut file = std::fs::File::create(&tmp)?;
    file.write_all(json.as_bytes())?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&tmp, path)
}

/// The FFmpeg to run: the bundled sidecar next to the exe (where Tauri puts
/// it), the dev copy in src-tauri/binaries, or whatever is on PATH.
fn get_ffmpeg_path() -> PathBuf {
    let sidecar = std::env::current_exe().ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" })));

    let dev_binary_name = if cfg!(windows) {
        "ffmpeg-x86_64-pc-windows-msvc.exe".to_string()
    } else {
        let os_target = if cfg!(target_os = "macos") { "apple-darwin" } else { "unknown-linux-gnu" };
        format!("ffmpeg-{}-{}", std::env::consts::ARCH, os_target)
    };
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries").join(dev_binary_name);

    match [sidecar, Some(dev)].into_iter().flatten().find(|p| p.exists()) {
        Some(path) => path,
        None => {
            warn!("FFmpeg not found next to the exe or in src-tauri/binaries, falling back to PATH");
            PathBuf::from("ffmpeg")
        }
    }
}

fn api_fullscreen(app: &AppHandle) -> Result<serde_json::Value, String> {
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

/// Stop the streams and reload the config from disk. The frontend reloads on
/// "reload-config" and starts the streams for the new camera list itself.
fn api_reload(app: &AppHandle) -> Result<serde_json::Value, String> {
    info!("API reload requested");
    let state = app.state::<AppState>();
    stop_all_streams(&state, app);
    let (config, _) = load_config();
    *state.config.lock().map_err(|_| "Config mutex poisoned")? = config;
    info!("Config reloaded from disk");
    let _ = app.emit("reload-config", ());
    Ok(serde_json::json!({"ok": true, "action": "reload"}))
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
    let log_dir = config_dir().join("logs");

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
            let ffmpeg_path = get_ffmpeg_path();
            info!("Using ffmpeg at: {}", ffmpeg_path.display());

            app.manage(AppState {
                config: Mutex::new(config),
                config_path,
                ffmpeg_path,
                stream_tasks: Mutex::new(HashMap::new()),
                reconnect_attempts: Mutex::new(HashMap::new()),
                stream_health: Mutex::new(HashMap::new()),
                frame_broadcasters: Mutex::new(HashMap::new()),
                init_segments: Mutex::new(HashMap::new()),
                recent_segments: Mutex::new(HashMap::new()),
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
            default_multicast_interface,
            is_dev_build,
            get_stream_health,
        ])
        .run(tauri::generate_context!())
        .expect("Failed to launch StageView");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn arg_after<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
        args.iter().position(|a| a == flag).map(|i| args[i + 1].as_str())
    }

    #[test]
    fn rtsp_uses_timeout_not_removed_stimeout() {
        let (args, input) = build_input_args("rtsp://cam.local:554/stream", None);
        assert_eq!(input, "rtsp://cam.local:554/stream");
        assert!(!args.iter().any(|a| a == "-stimeout"), "FFmpeg 5+ rejects -stimeout");
        assert_eq!(arg_after(&args, "-timeout"), Some("10000000"));
        assert_eq!(arg_after(&args, "-rtsp_transport"), Some("tcp"));
    }

    #[test]
    fn packet_protocols_do_not_use_direct_io() {
        // "-avioflags direct" makes FFmpeg drop UDP datagrams and SRT packets: no video at all
        for url in ["udp://239.1.1.1:5000", "srt://10.0.0.1:9000"] {
            let (args, _) = build_input_args(url, None);
            assert_eq!(arg_after(&args, "-avioflags"), None, "{url}");
        }
    }

    #[test]
    fn udp_url_is_rewritten_to_join_group() {
        let (_, input) = build_input_args("udp://239.1.1.1:5000", None);
        assert_eq!(input, "udp://@239.1.1.1:5000?timeout=10000000");
    }

    fn test_box(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut b = ((payload.len() + 8) as u32).to_be_bytes().to_vec();
        b.extend_from_slice(kind);
        b.extend_from_slice(payload);
        b
    }

    /// A moof+mdat fragment whose trun carries first_sample_flags.
    fn test_fragment(keyframe: bool) -> Vec<u8> {
        // sample_is_non_sync_sample is bit 16 of the sample flags
        let first_sample_flags: u32 = if keyframe { 0x0200_0000 } else { 0x0101_0000 };
        let mut trun = vec![0, 0, 0, 0x05]; // version 0, flags = data_offset | first_sample_flags
        trun.extend_from_slice(&1u32.to_be_bytes()); // sample_count
        trun.extend_from_slice(&0u32.to_be_bytes()); // data_offset
        trun.extend_from_slice(&first_sample_flags.to_be_bytes());
        let mut moof = test_box(b"mfhd", &[0; 8]);
        moof.extend(test_box(b"traf", &test_box(b"trun", &trun)));
        let mut frag = test_box(b"moof", &moof);
        frag.extend(test_box(b"mdat", &[0xAA; 16]));
        frag
    }

    #[test]
    fn test_fragment_helper_matches_keyframe_parser() {
        assert!(is_keyframe_fragment(&test_fragment(true)));
        assert!(!is_keyframe_fragment(&test_fragment(false)));
    }

    /// A moof whose trun has no first_sample_flags, so tfhd's default_sample_flags decide.
    fn moof_with_default_flags(sample_flags: u32, sample_count: u32) -> Vec<u8> {
        let mut tfhd = vec![0, 0, 0, 0x20]; // flags = default_sample_flags present
        tfhd.extend_from_slice(&1u32.to_be_bytes()); // track_id
        tfhd.extend_from_slice(&sample_flags.to_be_bytes());
        let mut trun = vec![0, 0, 0, 0];
        trun.extend_from_slice(&sample_count.to_be_bytes());
        let mut traf = test_box(b"tfhd", &tfhd);
        traf.extend(test_box(b"trun", &trun));
        test_box(b"moof", &test_box(b"traf", &traf))
    }

    #[test]
    fn keyframe_falls_back_to_tfhd_default_flags() {
        assert!(is_keyframe_fragment(&moof_with_default_flags(0x0200_0000, 1)));
        assert!(!is_keyframe_fragment(&moof_with_default_flags(0x0101_0000, 1)));
    }

    #[test]
    fn counts_samples_across_trafs() {
        assert_eq!(count_samples_in_moof(&moof_with_default_flags(0, 3)), 3);
        let mut two = moof_with_default_flags(0, 3)[8..].to_vec(); // traf only
        two.extend_from_slice(&moof_with_default_flags(0, 2)[8..]);
        assert_eq!(count_samples_in_moof(&test_box(b"moof", &two)), 5);
        assert_eq!(count_samples_in_moof(b"garbage"), 1, "malformed input still counts one");
    }

    #[test]
    fn forwards_everything_when_not_lagged() {
        let mut waiting = false;
        assert!(should_forward(&test_fragment(false), &mut waiting));
        assert!(should_forward(&test_fragment(true), &mut waiting));
    }

    #[test]
    fn after_lag_drops_until_keyframe() {
        let mut waiting = true;
        assert!(!should_forward(&test_fragment(false), &mut waiting));
        assert!(waiting);
        assert!(should_forward(&test_fragment(true), &mut waiting));
        assert!(!waiting);
        assert!(should_forward(&test_fragment(false), &mut waiting));
    }

    #[test]
    fn init_segment_always_forwarded() {
        let init = test_box(b"ftyp", b"isom\0\0\x02\0");
        let mut waiting = true;
        assert!(should_forward(&init, &mut waiting));
        assert!(waiting, "init segment must not end the wait for a keyframe");
    }

    #[test]
    fn splits_path_and_query() {
        assert_eq!(split_path_query("/api/grid"), ("/api/grid", None));
        assert_eq!(split_path_query("/api/solo/2?token=abc"), ("/api/solo/2", Some("token=abc")));
    }

    #[test]
    fn empty_token_means_auth_disabled() {
        assert!(token_ok(None, ""));
        assert!(token_ok(Some("token=whatever"), ""));
    }

    #[test]
    fn token_must_match_when_set() {
        assert!(token_ok(Some("token=s3cret"), "s3cret"));
        assert!(token_ok(Some("a=1&token=s3cret"), "s3cret"));
        assert!(!token_ok(None, "s3cret"));
        assert!(!token_ok(Some("token=wrong"), "s3cret"));
        assert!(!token_ok(Some("token=s3cre"), "s3cret"));
        assert!(!token_ok(Some("tokenx=s3cret"), "s3cret"));
    }

    #[test]
    fn config_without_api_token_still_loads() {
        let cfg: AppConfig = serde_json::from_str(r#"{"cameras":[],"shuffle_interval_secs":900}"#).unwrap();
        assert_eq!(cfg.api_token, "");
    }

    #[test]
    fn codec_label_from_init_segment() {
        assert_eq!(codec_label(b"....ftypisom....avc1....avcC\x01\x64"), "H.264 (copy)");
        assert_eq!(codec_label(b"....ftypisom....hev1....hvcC\x01\x01"), "H.265 (copy)");
        assert_eq!(codec_label(b"....ftypisom"), "unknown (copy)");
    }

    fn cam(url: &str, grid: Option<&str>) -> Camera {
        Camera { id: "abc".into(), name: "A".into(), url: url.into(), grid_url: grid.map(Into::into) }
    }

    #[test]
    fn main_stream_only_without_grid_url() {
        assert_eq!(stream_targets(&cam("rtsp://x/main", None)),
                   vec![("abc".to_string(), "rtsp://x/main".to_string())]);
    }

    #[test]
    fn grid_stream_added_when_grid_url_set() {
        assert_eq!(stream_targets(&cam("rtsp://x/main", Some("rtsp://x/sub"))), vec![
            ("abc".to_string(), "rtsp://x/main".to_string()),
            ("abc.grid".to_string(), "rtsp://x/sub".to_string()),
        ]);
    }

    #[test]
    fn blank_or_duplicate_grid_url_ignored() {
        assert_eq!(stream_targets(&cam("rtsp://x/main", Some("  "))).len(), 1);
        assert_eq!(stream_targets(&cam("rtsp://x/main", Some("rtsp://x/main"))).len(), 1);
    }

    #[test]
    fn camera_without_grid_url_still_loads() {
        let c: Camera = serde_json::from_str(r#"{"id":"a","name":"A","url":"rtp://1.2.3.4:5"}"#).unwrap();
        assert_eq!(c.grid_url, None);
    }

    #[test]
    fn api_token_charset() {
        assert!(valid_api_token(""));
        assert!(valid_api_token("a1B2-c3_d4"));
        assert!(!valid_api_token("stage view"));
        assert!(!valid_api_token("a+b"));
        assert!(!valid_api_token("a&b"));
        assert!(!valid_api_token("50%"));
        assert!(!valid_api_token("x#y"));
    }

    #[cfg(windows)]
    #[test]
    fn api_listener_socket_is_not_inherited_by_children() {
        use std::os::windows::io::AsRawSocket;
        use windows_sys::Win32::Foundation::{GetHandleInformation, HANDLE_FLAG_INHERIT};
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let listener = rt.block_on(TcpListener::bind("127.0.0.1:0")).unwrap();
        let socket = listener.as_raw_socket();
        let flags_of = |s: u64| {
            let mut flags = 0u32;
            assert_ne!(unsafe { GetHandleInformation(s as _, &mut flags) }, 0);
            flags
        };
        eprintln!("inherit flag before fix: {}", flags_of(socket) & HANDLE_FLAG_INHERIT);
        make_non_inheritable(socket).unwrap();
        assert_eq!(flags_of(socket) & HANDLE_FLAG_INHERIT, 0);
    }

    #[cfg(windows)]
    #[test]
    fn closing_kill_job_ends_assigned_children() {
        use std::os::windows::io::AsRawHandle;
        let mut child = std::process::Command::new("ping")
            .args(["-n", "30", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let job = KillJob::new().unwrap();
        job.assign(child.as_raw_handle()).unwrap();
        assert!(child.try_wait().unwrap().is_none(), "child should run while the job is open");

        drop(job);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while child.try_wait().unwrap().is_none() {
            assert!(std::time::Instant::now() < deadline, "child survived closing the job");
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }

    #[test]
    fn rtp_multicast_joins_on_chosen_adapter() {
        let (_, input) = build_input_args("rtp://224.1.2.3:4000", Some("192.168.3.71"));
        assert_eq!(input, "rtp://224.1.2.3:4000?localaddr=192.168.3.71");
    }

    #[test]
    fn rtp_url_with_existing_options_keeps_them() {
        let (_, input) = build_input_args("rtp://224.1.2.3:4000?sources=192.168.3.34", Some("192.168.3.71"));
        assert_eq!(input, "rtp://224.1.2.3:4000?sources=192.168.3.34&localaddr=192.168.3.71");
    }

    #[test]
    fn udp_multicast_joins_on_chosen_adapter() {
        let (_, input) = build_input_args("udp://239.1.1.1:5000", Some("192.168.3.71"));
        assert_eq!(input, "udp://@239.1.1.1:5000?timeout=10000000&localaddr=192.168.3.71");
    }

    #[test]
    fn unicast_protocols_ignore_the_adapter() {
        for url in ["rtsp://192.168.3.34:554/live/av0", "rtmp://192.168.3.34:1935/live/av1", "srt://10.0.0.1:9000", "http://cam/video"] {
            let (_, input) = build_input_args(url, Some("192.168.3.71"));
            assert_eq!(input, url);
        }
    }

    #[test]
    fn multicast_adapter_setting_validation() {
        assert!(valid_multicast_interface(""));
        assert!(valid_multicast_interface("192.168.3.71"));
        assert!(!valid_multicast_interface("Ethernet"));
        assert!(!valid_multicast_interface("192.168.3"));
        assert!(!valid_multicast_interface("224.1.2.3"), "a multicast group is not an adapter address");
    }

    #[test]
    fn config_without_multicast_adapter_still_loads() {
        let cfg: AppConfig = serde_json::from_str(r#"{"cameras":[],"shuffle_interval_secs":900}"#).unwrap();
        assert_eq!(cfg.multicast_interface, "");
    }

    #[test]
    fn config_without_update_fields_still_loads() {
        let cfg: AppConfig = serde_json::from_str(r#"{"cameras":[],"shuffle_interval_secs":900}"#).unwrap();
        assert_eq!(cfg.last_update_check, 0);
        assert_eq!(cfg.last_seen_version, "");
    }

    /// A fresh, empty directory for one test's files.
    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("stageview-test-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn config_round_trips_and_leaves_no_temp_file() {
        let dir = temp_dir("roundtrip");
        let path = dir.join("config.json");
        let mut cfg = AppConfig::default();
        cfg.cameras.push(cam("rtsp://x/main", None));
        write_config(&path, &cfg).unwrap();
        cfg.api_port = 9000;
        write_config(&path, &cfg).unwrap(); // replaces an existing file

        let back = read_config(&path);
        assert_eq!(back.cameras.len(), 1);
        assert_eq!(back.api_port, 9000);
        assert!(!path.with_extension("json.tmp").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_config_gives_defaults() {
        let dir = temp_dir("missing");
        assert_eq!(read_config(&dir.join("config.json")).cameras.len(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unreadable_config_is_kept_aside_not_lost() {
        let dir = temp_dir("corrupt");
        let path = dir.join("config.json");
        std::fs::write(&path, r#"{"cameras":[{"id":"a","name":"Foyer""#).unwrap();

        let cfg = read_config(&path);
        assert_eq!(cfg.cameras.len(), 0);
        let kept = std::fs::read_to_string(path.with_extension("json.unreadable")).unwrap();
        assert!(kept.contains("Foyer"), "the broken file's contents survive for recovery");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
