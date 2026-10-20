# Streaming Fixes Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix RTSP on FFmpeg 8, stop decoder smearing after a slow client lags, lock down the network API, play H.265 cameras, and let the grid use low-res substreams while solo mode uses the main stream.

**Architecture:** All five changes stay inside the existing pipeline: FFmpeg copies the video (no transcode) into fragmented MP4, `lib.rs` relays the fragments over a local HTTP stream, and the webview plays them through MSE. Each fix lands as its own small, testable change: pure helper functions in `lib.rs` with `#[cfg(test)]` unit tests, plus one new browser helper (`src/codec.js`) tested with Node's built-in test runner.

**Tech Stack:** Rust (Tauri 2, tokio), FFmpeg 8.0.1 sidecar, vanilla JS + Media Source Extensions in WebView2, `node --test` (Node 24).

---

## Background for the implementer

- **Backend:** `src-tauri/src/lib.rs` (single file, ~1500 lines). One FFmpeg process per stream (`try_stream_camera`). `process_fmp4_stream` splits FFmpeg's stdout into MP4 boxes and broadcasts `ftyp+moov` (init segment) and `moof+mdat` pairs (fragments) on a `tokio::sync::broadcast` channel per stream id. `run_api_server` is a hand-rolled HTTP/1.1 server on `0.0.0.0:<api_port>` that serves the stream (`/camera/<id>/stream`), the control panel (`/`), and `/api/*` commands.
- **Frontend:** `src/main.js` (classic `<script>`, not a module). `Mp4StreamReader` fetches `http://localhost:<port>/camera/<id>/stream` and appends the bytes to an MSE `SourceBuffer`. `StageView` builds the tiles, solo mode and settings UI.
- **Control panel:** `src-tauri/src/control_panel.html`, compiled in via `include_str!`, opened from other devices on the LAN.
- **There are no tests today.** This plan adds a `#[cfg(test)] mod tests` block at the bottom of `lib.rs` and a `tests/` folder for JS. All Rust test code goes inside that one module, which Task 1 creates.
- **Commands** (run from the repo root unless stated):
  - Rust tests: `cd src-tauri && cargo test --lib`
  - JS tests: `node --test tests/codec.test.cjs`
  - Run the app: `npm run tauri dev`
  - Bundled FFmpeg: `src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe` (8.0.1; CI downloads the same version in `.github/workflows/release.yml`)
- Camera ids are UUIDs (`crypto.randomUUID()`), so the suffix `.grid` cannot collide with a real id.

## File map

| File | Change |
|---|---|
| `src-tauri/src/lib.rs` | Extract `build_input_args` (Task 1), `should_forward` (Task 2), `split_path_query`/`token_ok` + auth checks (Task 3), `codec_label` (Task 4), `grid_url` + `stream_targets` + `spawn_camera_streams` (Task 5), tests module |
| `src-tauri/src/control_panel.html` | Send the token with every API call (Task 3) |
| `src/codec.js` (new) | `detectCodecString(bytes)`: MSE codec string from an init segment (Task 4) |
| `tests/codec.test.cjs` (new) | Node tests for `codec.js` (Task 4) |
| `src/index.html` | Load `codec.js`; API token field (Tasks 3, 4) |
| `src/main.js` | API token setting (Task 3); lazy SourceBuffer creation (Task 4); grid/solo stream switching + grid URL field (Task 5) |
| `README.md` | Document token, H.265, grid substream (Task 6) |

---

## Chunk 1: Backend fixes

### Task 1: Fix RTSP on FFmpeg 8 (`-stimeout` was removed)

FFmpeg 5 removed the RTSP `-stimeout` option; `-timeout` (microseconds) replaces it. With FFmpeg 8.0.1 every RTSP camera currently fails at once with `Unrecognized option 'stimeout'`. To make this testable, pull the per-protocol argument building out of `try_stream_camera` into a pure function.

**Files:**
- Modify: `src-tauri/src/lib.rs:490-564` (inside `try_stream_camera`)
- Test: `src-tauri/src/lib.rs` (new `tests` module at end of file)

- [ ] **Step 1: Create the tests module with a failing test**

Append to the end of `src-tauri/src/lib.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn arg_after<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
        args.iter().position(|a| a == flag).map(|i| args[i + 1].as_str())
    }

    #[test]
    fn rtsp_uses_timeout_not_removed_stimeout() {
        let (args, input) = build_input_args("rtsp://cam.local:554/stream");
        assert_eq!(input, "rtsp://cam.local:554/stream");
        assert!(!args.iter().any(|a| a == "-stimeout"), "FFmpeg 5+ rejects -stimeout");
        assert_eq!(arg_after(&args, "-timeout"), Some("10000000"));
        assert_eq!(arg_after(&args, "-rtsp_transport"), Some("tcp"));
    }

    #[test]
    fn udp_url_is_rewritten_to_join_group() {
        let (_, input) = build_input_args("udp://239.1.1.1:5000");
        assert_eq!(input, "udp://@239.1.1.1:5000?timeout=10000000");
    }
}
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd src-tauri && cargo test --lib`
Expected: compile error `cannot find function 'build_input_args'`.

- [ ] **Step 3: Extract `build_input_args`**

In `try_stream_camera`, the block starting at `// Rewrite the input URL and add protocol-specific flags` (`let input_url = if url.starts_with("rtp://") {` … `};`, roughly lines 496-562) becomes a new function placed directly above `try_stream_camera`. Move the body unchanged, with two edits: each branch extends a local `args` vector, and in the RTSP branch replace

```rust
            "-stimeout".into(),          "10000000".into(), // 10s RTSP connect timeout
```

with

```rust
            "-timeout".into(),           "10000000".into(), // 10s socket timeout (µs); -stimeout was removed in FFmpeg 5
```

Shape of the new function:

```rust
/// Protocol-specific FFmpeg input flags plus the (possibly rewritten) input URL.
fn build_input_args(url: &str) -> (Vec<String>, String) {
    let mut args: Vec<String> = Vec::new();
    let input_url = if url.starts_with("rtp://") {
        // ... existing rtp branch, unchanged ...
    } else if url.starts_with("udp://") {
        // ... existing udp branch, unchanged ...
    } else if url.starts_with("rtsp://") {
        // ... existing rtsp branch with -timeout instead of -stimeout ...
    } else if url.starts_with("srt://") {
        // ... existing srt branch, unchanged ...
    } else {
        // ... existing fallback branch, unchanged ...
    };
    (args, input_url)
}
```

In `try_stream_camera`, replace the removed block and the `args.extend(["-i".into(), input_url]);` line with:

```rust
    let (input_args, input_url) = build_input_args(url);
    args.extend(input_args);
    args.extend(["-i".into(), input_url]);
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd src-tauri && cargo test --lib`
Expected: `test result: ok. 2 passed`.

- [ ] **Step 5: Check against the real FFmpeg**

Run (from repo root, bash):

```bash
src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe -hide_banner -loglevel error -rtsp_transport tcp -timeout 2000000 -i rtsp://127.0.0.1:1/x -f null -
```

Expected: a *connection* error (`Connection to tcp://127.0.0.1:1... failed`), **not** `Unrecognized option`. If you have a real RTSP camera, add it in the app (`npm run tauri dev`) and confirm it goes online.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "fix: RTSP failed on FFmpeg 8 (-stimeout removed), extract build_input_args"
```

---

### Task 2: After a lag, skip to the next keyframe

When a stream client falls more than 60 messages behind, `RecvError::Lagged` fires and the loop currently carries on with whatever message comes next, usually a fragment in the middle of a GOP. The decoder then shows smeared video until the next IDR, which the frontend masks with its freeze-frame canvas. Instead, drop fragments until a keyframe fragment arrives. Init segments (`ftyp+moov`) must always pass through, because FFmpeg sends a new one after every reconnect.

`is_keyframe_fragment` (existing, `lib.rs:256`) works on a whole `moof+mdat` fragment: it skips the moof header and returns from the first `trun` it finds.

**Files:**
- Modify: `src-tauri/src/lib.rs` (new fn next to `is_keyframe_fragment`; stream loop around line 1104)
- Test: `src-tauri/src/lib.rs` tests module

- [ ] **Step 1: Add the failing tests**

Add inside `mod tests`:

```rust
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
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd src-tauri && cargo test --lib`
Expected: compile error `cannot find function 'should_forward'`.

- [ ] **Step 3: Implement `should_forward`**

Add directly below `is_keyframe_fragment`:

```rust
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
```

- [ ] **Step 4: Use it in the stream loop**

In `run_api_server`, replace the `loop { match rx.recv().await { ... } }` block (the one under the comment `// Handle RecvError::Lagged gracefully`) with:

```rust
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
```

Also update the comment above the loop: it should now say that after a lag we resume at the next keyframe, so the decoder never sees a broken GOP.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `cd src-tauri && cargo test --lib`
Expected: all tests pass (6 total).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "fix: resume lagged stream clients at the next keyframe instead of mid-GOP"
```

---

### Task 3: Lock down the network API

Today anyone on the LAN can pull any camera's video from `/camera/<id>/stream` and send `/api/*` commands. Changes:

1. `/camera/*/stream` answers only loopback peers (the app's own webview fetches from `localhost`). Other peers get `403`.
2. New optional config `api_token` (default empty = no auth, so existing Stream Deck/Companion setups keep working). When set, every `/api/*` request needs `?token=<value>`. A query parameter (not a header) keeps Stream Deck/Companion URL actions working and avoids CORS preflights from the control panel. The control panel HTML at `/` stays open; it holds no data of its own.
3. The request target is split into path + query before routing. Today `/api/grid?x=1` would 404, and the debug log would record the token.

**Files:**
- Modify: `src-tauri/src/lib.rs` (`AppConfig` ~line 41, its `Default` ~line 58, `run_api_server` ~line 1015-1180)
- Modify: `src/index.html:128-140`, `src/main.js` (~lines 537, 1152, 1528-1546)
- Modify: `src-tauri/src/control_panel.html` (add form ~line 362, `addPc` ~line 420, `fetchTimeout` ~line 652, boot ~line 398)
- Test: `src-tauri/src/lib.rs` tests module

- [ ] **Step 1: Add the failing tests**

Add inside `mod tests`:

```rust
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
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd src-tauri && cargo test --lib`
Expected: compile errors for `split_path_query`, `token_ok`, and `api_token`.

- [ ] **Step 3: Add the config field**

In `AppConfig`, after `api_port`:

```rust
    /// Shared secret for /api/* requests from the network (`?token=`). Empty = no auth.
    #[serde(default)]
    pub api_token: String,
```

In `impl Default for AppConfig`, add `api_token: String::new(),` after `api_port: 8090,`.

- [ ] **Step 4: Add the helpers**

Add above `run_api_server`:

```rust
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
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `cd src-tauri && cargo test --lib`
Expected: all pass (10 total).

- [ ] **Step 6: Wire the checks into `run_api_server`**

a) Replace

```rust
            let path = first_line.split_whitespace().nth(1).unwrap_or("/");
```

with

```rust
            let target = first_line.split_whitespace().nth(1).unwrap_or("/");
            let (path, query) = split_path_query(target);
```

The existing `debug!("API request from {}: {} {}", peer, method, path);` now logs the path without the token. Keep it as is.

b) At the top of the `if path.starts_with("/camera/") && path.ends_with("/stream") {` block, before anything else:

```rust
                // Video is for the local webview only — never serve it to the LAN
                if !peer.ip().is_loopback() {
                    let _ = stream.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                    return;
                }
```

c) Immediately before `let (status, body) = if path == "/api/grid" {`, add:

```rust
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
```

- [ ] **Step 7: Settings UI for the token**

In `src/index.html`, inside the Network Control `<section>` and directly after the closing `</label>` of the API port field, add:

```html
        <label>
          API token
          <div class="interval-input">
            <input type="text" id="api-token" placeholder="Leave empty for no authentication" autocomplete="off" spellcheck="false" />
            <button type="button" id="generate-api-token" class="btn-secondary">Generate</button>
          </div>
        </label>
        <p class="hint">When set, network calls need <code>?token=…</code>, e.g. <code>/api/grid?token=…</code>. Open the control panel once as <code>http://stageview.local:8090/?token=…</code>.</p>
```

(Check `style.css` for the button class the settings panel already uses and use that instead of `btn-secondary` if it differs.)

In `src/main.js`:
- In the constructor, next to `this.apiPort = 8090;`, add `this.apiToken = "";`.
- After `this.apiPort = config.api_port || 8090;` (~line 537), add `this.apiToken = config.api_token || "";`.
- After `document.getElementById("api-port").value = this.apiPort;` (~line 1152), add `document.getElementById("api-token").value = this.apiToken;`.
- In `saveSettings`, after reading `apiPort`, add `const apiToken = document.getElementById("api-token").value.trim();`. After `config.api_port = apiPort;`, add `config.api_token = apiToken;`. After `this.apiPort = apiPort;`, add `this.apiToken = apiToken;`.
- Next to `document.getElementById('save-settings-btn').addEventListener(...)` (~line 641), add:

```js
    document.getElementById("generate-api-token").addEventListener("click", () => {
      document.getElementById("api-token").value = crypto.randomUUID().replace(/-/g, "");
    });
```

`save_config` writes `state.config` straight away, so the new token takes effect on the next request with no restart.

- [ ] **Step 8: Control panel sends the token**

In `src-tauri/src/control_panel.html`:

a) Under `let remotePcs = [];` and its `try` line, add:

```js
// Token for this PC comes from the page URL (?token=…) and is remembered
const urlToken = new URLSearchParams(location.search).get('token');
if (urlToken) localStorage.setItem('sv_local_token', urlToken);
const localToken = localStorage.getItem('sv_local_token') || '';

function tokenFor(host) {
  if (host === LOCAL_HOST) return localToken;
  const pc = remotePcs.find(p => p.host === host);
  return pc?.token || '';
}
```

b) Replace `fetchTimeout` with:

```js
function fetchTimeout(url, ms) {
  const u = new URL(url);
  const token = tokenFor(u.host);
  if (token) u.searchParams.set('token', token);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(u, { signal: ctrl.signal }).finally(() => clearTimeout(t));
}
```

c) In the add form, after the `port-field` div and inside `.fields-row`, add:

```html
        <div class="field">
          <label>API Token (optional)</label>
          <input type="text" id="fToken" placeholder="Leave empty if none" autocomplete="off">
        </div>
```

d) In `addPc()`, read `const token = document.getElementById('fToken').value.trim();`, push `{ id: \`pc_${Date.now()}\`, name: displayName, host, token }`, and clear it with `document.getElementById('fToken').value = '';` next to the other resets.

- [ ] **Step 9: Manual check**

Run `npm run tauri dev`. Then (bash, replace `<ip>` with this PC's LAN IP and `<uuid>` with a camera id from `%APPDATA%\StageView\config.json`):

```bash
curl -s http://<ip>:8090/api/status
```

With the token empty, expect `{"ok":true,...}`. Set a token in Settings and save; the same command returns `{"ok":false,"error":"invalid or missing token"}`, and appending `?token=<value>` returns `ok:true` again.

```bash
curl -s -o /dev/null -w "%{http_code}\n" --max-time 2 http://<ip>:8090/camera/<uuid>/stream
```

Expect `403`. The app's own tiles still play (they fetch over `localhost`). Open `http://<ip>:8090/?token=<value>` in a browser: camera buttons should work.

- [ ] **Step 10: Commit**

```bash
git add src-tauri/src/lib.rs src/index.html src/main.js src-tauri/src/control_panel.html
git commit -m "feat: loopback-only video stream and optional API token"
```

---

## Chunk 2: H.265 support

### Task 4: Detect the codec from the init segment and play H.265

`Mp4StreamReader` creates its SourceBuffer with a hardcoded H.264 string (`avc1.42E01E`, `main.js:97`) before any data arrives, so H.265 cameras fail. FFmpeg already copies HEVC into fMP4 (sample entry `hev1`). The fix: wait for the init segment, read the real codec string from its `avcC`/`hvcC` record, then create the SourceBuffer.

No FFmpeg changes are needed. Chromium MSE accepts both `hev1` and `hvc1` sample entries as long as the codec string matches, and the detector uses whichever entry is present.

**Files:**
- Create: `src/codec.js`, `tests/codec.test.cjs`
- Modify: `src/index.html:199` (script tags), `src/main.js` (`Mp4StreamReader`: `_initMediaSource` ~line 74-136, read loop ~line 359-378, `_restart` ~line 297; `bindTileEvents` ~line 737)
- Modify: `src-tauri/src/lib.rs` (`codec_label` helper; moov branch of `process_fmp4_stream`; health task ~line 663)

- [ ] **Step 1: Write the failing JS test**

Create `tests/codec.test.cjs`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { detectCodecString } = require('../src/codec.js');

const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const bytes = (...parts) => Uint8Array.from(parts.flat());

test('H.264 High@4.0 from avcC', () => {
  const init = bytes(ascii('ftypisom'), ascii('avc1'), [0, 0, 0, 0], ascii('avcC'), [1, 0x64, 0x00, 0x28, 0xff]);
  assert.strictEqual(detectCodecString(init), 'avc1.640028');
});

// hvcC record: version, space/tier/profile, 4 compat bytes, 6 constraint bytes, level
const hvcCMain = [1, 0x01, 0x60, 0, 0, 0, 0xb0, 0, 0, 0, 0, 0, 120];

test('H.265 Main@4.0 with hev1 sample entry', () => {
  const init = bytes(ascii('hev1'), [0, 0, 0, 0], ascii('hvcC'), hvcCMain);
  assert.strictEqual(detectCodecString(init), 'hev1.1.6.L120.B0');
});

test('H.265 with hvc1 sample entry keeps hvc1 prefix', () => {
  const init = bytes(ascii('hvc1'), [0, 0, 0, 0], ascii('hvcC'), hvcCMain);
  assert.strictEqual(detectCodecString(init), 'hvc1.1.6.L120.B0');
});

test('H.265 high tier is marked H', () => {
  const high = [...hvcCMain];
  high[1] = 0x21; // tier flag set, profile 1
  const init = bytes(ascii('hev1'), ascii('hvcC'), high);
  assert.strictEqual(detectCodecString(init), 'hev1.1.6.H120.B0');
});

test('returns null until the codec record is complete', () => {
  assert.strictEqual(detectCodecString(bytes(ascii('ftypisom'))), null);
  assert.strictEqual(detectCodecString(bytes(ascii('avcC'), [1, 0x64])), null);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test tests/codec.test.cjs`
Expected: FAIL with `Cannot find module '../src/codec.js'`.

- [ ] **Step 3: Implement `src/codec.js`**

```js
// ── Codec detection ─────────────────────────────────────────────────────────
// Builds the RFC 6381 codec string MSE needs (e.g. "avc1.640028",
// "hev1.1.6.L120.B0") from the bytes of an fMP4 init segment.
// Returns null until the decoder configuration record has arrived.

function findFourcc(bytes, fourcc) {
  const c = [...fourcc].map((ch) => ch.charCodeAt(0));
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (bytes[i] === c[0] && bytes[i + 1] === c[1] && bytes[i + 2] === c[2] && bytes[i + 3] === c[3]) {
      return i;
    }
  }
  return -1;
}

function hex2(b) {
  return b.toString(16).padStart(2, '0');
}

function detectCodecString(bytes) {
  // AVCDecoderConfigurationRecord: version, profile, compatibility, level
  const avcC = findFourcc(bytes, 'avcC');
  if (avcC >= 0) {
    if (avcC + 8 > bytes.length) return null;
    return `avc1.${hex2(bytes[avcC + 5])}${hex2(bytes[avcC + 6])}${hex2(bytes[avcC + 7])}`;
  }

  // HEVCDecoderConfigurationRecord: version, space/tier/profile, 32 compat
  // flags, 48 constraint bits, level
  const hvcC = findFourcc(bytes, 'hvcC');
  if (hvcC >= 0) {
    if (hvcC + 17 > bytes.length) return null;
    const entry = findFourcc(bytes, 'hvc1') >= 0 ? 'hvc1' : 'hev1';
    const b = bytes[hvcC + 5];
    const space = ['', 'A', 'B', 'C'][b >> 6];
    const tier = b & 0x20 ? 'H' : 'L';
    const profile = b & 0x1f;

    // RFC 6381 writes the compatibility flags bit-reversed
    let compat = ((bytes[hvcC + 6] << 24) | (bytes[hvcC + 7] << 16) | (bytes[hvcC + 8] << 8) | bytes[hvcC + 9]) >>> 0;
    let reversed = 0;
    for (let k = 0; k < 32; k++) {
      reversed = ((reversed << 1) | (compat & 1)) >>> 0;
      compat >>>= 1;
    }

    const constraints = Array.from(bytes.slice(hvcC + 10, hvcC + 16));
    while (constraints.length && constraints[constraints.length - 1] === 0) constraints.pop();
    const constraintStr = constraints.map((x) => '.' + x.toString(16).toUpperCase()).join('');

    const level = bytes[hvcC + 16];
    return `${entry}.${space}${profile}.${reversed.toString(16).toUpperCase()}.${tier}${level}${constraintStr}`;
  }

  return null;
}

if (typeof module !== 'undefined') module.exports = { detectCodecString };
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `node --test tests/codec.test.cjs`
Expected: `ℹ pass 5`, `ℹ fail 0`.

- [ ] **Step 5: Commit the helper**

```bash
git add src/codec.js tests/codec.test.cjs
git commit -m "feat: detect MSE codec string (H.264/H.265) from fMP4 init segment"
```

- [ ] **Step 6: Load it in the page**

In `src/index.html`, change line 199 from `<script src="main.js"></script>` to:

```html
  <script src="codec.js"></script>
  <script src="main.js"></script>
```

- [ ] **Step 7: Create the SourceBuffer lazily in `Mp4StreamReader`**

a) Constructor: add `this._sourceOpen = false;` and `this.onUnsupportedCodec = null;` next to the other fields.

b) In `_initMediaSource`, replace the whole `sourceopen` listener body (from `try {` through its `catch`) with:

```js
    this.mediaSource.addEventListener('sourceopen', () => {
      this._sourceOpen = true;
      this._ensureSourceBuffer();
    });
```

c) Add this method after `_initMediaSource`. It moves the old SourceBuffer setup here, now driven by the detected codec:

```js
  /** Create the SourceBuffer once the init segment reveals the codec. */
  _ensureSourceBuffer() {
    if (this.sourceBuffer || !this._sourceOpen || this.mediaSource?.readyState !== 'open') return;
    if (this.queue.length === 0) return;

    const totalLen = this.queue.reduce((sum, s) => sum + s.byteLength, 0);
    const head = new Uint8Array(totalLen);
    let offset = 0;
    for (const s of this.queue) { head.set(s, offset); offset += s.byteLength; }

    const codec = detectCodecString(head);
    if (!codec) return; // init segment not complete yet — wait for more bytes

    const mime = `video/mp4; codecs="${codec}"`;
    if (!MediaSource.isTypeSupported(mime)) {
      const name = codec.startsWith('avc1') ? 'H.264' : 'H.265';
      console.error(`[Mp4StreamReader] ${name} (${codec}) not supported by this system`);
      if (this.onUnsupportedCodec) this.onUnsupportedCodec(name, codec);
      this.stop();
      return;
    }

    try {
      this.sourceBuffer = this.mediaSource.addSourceBuffer(mime);
      this.sourceBuffer.mode = 'sequence';

      this.sourceBuffer.addEventListener('updateend', () => {
        this.isUpdating = false;
        this._chaseLiveEdge();
        this._processQueue();
      });

      this.sourceBuffer.addEventListener('error', () => {
        console.warn('[Mp4StreamReader] SourceBuffer error, restarting pipeline');
        this._restart();
      });

      // Start periodic buffer trimming (every 5s) and corrupt-frame monitor
      if (this._trimTimer) clearInterval(this._trimTimer);
      this._trimTimer = setInterval(() => {
        this._trimBuffer();
        this._checkCorruptFrames();
      }, 5000);

      this._processQueue();
    } catch (e) {
      if (this.onError) this.onError('Failed to create SourceBuffer');
    }
  }
```

d) In `start()`, replace the `if (this.sourceBuffer) { ... }` block inside `if (value && value.byteLength > 0) {` with:

```js
            this.queue.push(value);
            this._ensureSourceBuffer();
            this._processQueue();

            // Trigger first-frame callback and eagerly play
            if (this.sourceBuffer && !this._firstFrame) {
              this._firstFrame = true;
              if (firstDataTimer) { clearTimeout(firstDataTimer); firstDataTimer = null; }
              this.video.play().catch(() => {});
              // Defer freeze-frame removal until video actually renders
              this._scheduleFreezeRemoval();
              if (this.onFirstFrame) this.onFirstFrame();
            }
```

(`_processQueue` already returns early while `sourceBuffer` is null, so bytes wait in `queue` until the codec is known.)

e) In `_restart()`, next to `this.sourceBuffer = null;`, add `this._sourceOpen = false;`.

f) Update the comment block above the class (lines 27-30) to say "hardware-accelerated H.264/H.265 decode".

g) In `bindTileEvents`, after `reader.onFirstFrame = ...`, add:

```js
      reader.onUnsupportedCodec = (name, codec) => {
        const cam = this.cameras.find(c => c.id === camId);
        this.showToast(`${cam ? cam.name : camId}: ${name} (${codec}) is not supported by this PC's video decoder`, 'error');
      };
```

- [ ] **Step 8: Show the real codec in stream health (backend)**

Add a test inside `mod tests`:

```rust
    #[test]
    fn codec_label_from_init_segment() {
        assert_eq!(codec_label(b"....ftypisom....avc1....avcC\x01\x64"), "H.264 (copy)");
        assert_eq!(codec_label(b"....ftypisom....hev1....hvcC\x01\x01"), "H.265 (copy)");
        assert_eq!(codec_label(b"....ftypisom"), "unknown (copy)");
    }
```

Run `cd src-tauri && cargo test --lib`; expect a compile error for `codec_label`. Then add near `count_samples_in_moof`:

```rust
/// Human-readable codec for the health panel, from the init segment's config box.
fn codec_label(init: &[u8]) -> &'static str {
    let has = |tag: &[u8]| init.windows(4).any(|w| w == tag);
    if has(b"hvcC") { "H.265 (copy)" } else if has(b"avcC") { "H.264 (copy)" } else { "unknown (copy)" }
}
```

In `process_fmp4_stream`, in the `if box_type_str == "moov" && !init_segment_sent {` branch, after the line that caches `init_segment`, add:

```rust
                    if let Ok(mut health) = state.stream_health.lock() {
                        if let Some(entry) = health.get_mut(camera_id) {
                            entry.codec = codec_label(&init_segment).to_string();
                        }
                    }
```

In the health task (~line 663), the periodic `StreamHealth { ... codec: "H264 (copy)".to_string() }` would overwrite this. Change it to keep the current value, by reading it just before building the struct:

```rust
            let codec = health_app.state::<AppState>().stream_health.lock().ok()
                .and_then(|h| h.get(&health_camera_id).map(|e| e.codec.clone()))
                .unwrap_or_else(|| "unknown (copy)".to_string());
```

and use `codec,` in the struct. (Check the variable names in the task: it uses `health_app` and `health_camera_id` per lines 615-619.) Also change the initial entry in `try_stream_camera` (`codec: "H264 (copy)".to_string()`) to `"detecting…".to_string()`.

Run `cd src-tauri && cargo test --lib`; expect all to pass.

- [ ] **Step 9: Manual check**

Run `npm run tauri dev`.
- An existing H.264 camera must still play. In DevTools (right-click → Inspect), run `document.querySelector('video').src` and check that the console shows no SourceBuffer errors.
- For H.265: point a camera at its H.265 stream, or make a test source:

```bash
src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe -re -f lavfi -i testsrc2=size=1280x720:rate=25 -c:v libx265 -g 50 -f rtp_mpegts rtp://127.0.0.1:5004
```

(Check that the essentials build includes `libx265` with `-hide_banner -encoders | grep 265`. If it doesn't, use a real H.265 camera.) Then add the camera URL `rtp://127.0.0.1:5004` in Settings.
- Expect H.265 video to play, with the health panel showing `H.265 (copy)`. If the GPU has no HEVC decoder, expect the "not supported" toast instead of a blank spinning tile.

- [ ] **Step 10: Commit**

```bash
git add src/index.html src/main.js src-tauri/src/lib.rs
git commit -m "feat: play H.265 cameras by creating the SourceBuffer from the detected codec"
```

---

## Chunk 3: Grid substreams

### Task 5: Optional low-res grid URL per camera

Each camera gets an optional `grid_url` (its substream). When it's set, the backend runs a second FFmpeg pipeline under stream id `<camera id>.grid`. Grid tiles play the `.grid` stream and switch to the main stream when soloed, then back again on exit. The main pipeline keeps running (copy mode uses next to no CPU, and solo stays instant); the saving is in the webview, which decodes far fewer pixels per tile.

**Files:**
- Modify: `src-tauri/src/lib.rs` (`Camera` ~line 19, `start_streams` ~line 140, `api_reload` ~line 1340)
- Modify: `src/main.js` (`bindTileEvents`, `soloCamera`, `exitSolo`, `camera-status`/`stream-error` listeners, `renderCameraList`, `addCameraField`, `saveSettings`, new `Mp4StreamReader.switchUrl`)
- Test: `src-tauri/src/lib.rs` tests module

- [ ] **Step 1: Add the failing tests**

Add inside `mod tests`:

```rust
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
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd src-tauri && cargo test --lib`
Expected: compile errors for `grid_url` and `stream_targets`.

- [ ] **Step 3: Implement the model and helper**

In `Camera`, after `pub url: String,`:

```rust
    /// Optional low-res substream shown in the grid; `url` is used in solo mode.
    #[serde(default)]
    pub grid_url: Option<String>,
```

Below the `Camera` struct impls (or above `start_streams`):

```rust
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
    ffmpeg_path: &PathBuf,
    cameras: &[Camera],
    tasks: &mut HashMap<String, tauri::async_runtime::JoinHandle<()>>,
) {
    for camera in cameras {
        for (stream_id, url) in stream_targets(camera) {
            let app_handle = app.clone();
            let ffmpeg = ffmpeg_path.clone();
            let id = stream_id.clone();
            let handle = tauri::async_runtime::spawn(async move {
                stream_camera(app_handle, ffmpeg, id, url).await;
            });
            tasks.insert(stream_id, handle);
        }
    }
}
```

In `start_streams`, replace the `for camera in &config.cameras { ... }` loop with:

```rust
    spawn_camera_streams(&app, &ffmpeg_path, &config.cameras, &mut tasks);
```

In `api_reload`, replace the `for camera in &cameras { ... }` loop inside the "Start streams for new config" block with:

```rust
        spawn_camera_streams(&app, &ffmpeg_path, &cameras, &mut tasks);
```

`stream_camera`, `try_stream_camera`, the broadcasters and the segment caches are all keyed by whatever id they receive, so `<id>.grid` works with no further backend changes. `stop_streams` and `api_reload` already iterate over `tasks.keys()`, so they emit `offline` for `.grid` ids as well.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd src-tauri && cargo test --lib`
Expected: all pass.

- [ ] **Step 5: Commit the backend**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat: run an optional grid substream per camera"
```

- [ ] **Step 6: `Mp4StreamReader.switchUrl`**

Add to `Mp4StreamReader`, after `_restart()`:

```js
  /** Point the reader at a different stream (grid substream ↔ main stream). */
  switchUrl(url) {
    if (url === this.url) return;
    this.url = url;
    // A new stream has its own init segment, so rebuild the MSE pipeline.
    // _restart() shows the last frame on the freeze canvas until the new one renders.
    this._restart();
  }
```

- [ ] **Step 7: Pick the stream per view in `StageView`**

a) Add a method to `StageView` (e.g. just above `bindTileEvents`):

```js
  /** Stream id for a camera: its grid substream in grid view when configured, else the main stream. */
  streamIdFor(cam, solo) {
    return !solo && cam.grid_url ? `${cam.id}.grid` : cam.id;
  }

  streamUrl(streamId) {
    return `http://localhost:${this.apiPort}/camera/${streamId}/stream`;
  }

  /** Switch a tile's reader to the right stream and show that stream's last known status. */
  _useStream(cam, solo) {
    const streamId = this.streamIdFor(cam, solo);
    const tile = document.querySelector(`.camera-tile[data-id="${cam.id}"]`);
    if (tile) {
      tile.dataset.stream = streamId;
      const status = this.cameraStatuses.get(streamId);
      if (status) this.applyCameraStatus(tile, status);
    }
    this.streamReaders.get(cam.id)?.switchUrl(this.streamUrl(streamId));
  }
```

b) In `bindTileEvents`, replace

```js
      const url = `http://localhost:${this.apiPort}/camera/${camId}/stream`;
```

with

```js
      const cam = this.cameras.find(c => c.id === camId);
      if (!cam) return;
      const isSolo = this.soloIndex !== null && this.cameras[this.soloIndex - 1]?.id === camId;
      const streamId = this.streamIdFor(cam, isSolo);
      tile.dataset.stream = streamId;
      const url = this.streamUrl(streamId);
```

(If Task 4's `onUnsupportedCodec` handler looks up `cam` again, reuse this `cam` instead.)

c) In `soloCamera`, remember which camera was soloed before (soloing camera 2 while camera 1 is soloed must put camera 1 back on its grid stream). Replace

```js
    if (index < 1 || index > this.cameras.length) return;
    this.soloIndex = index;
```

with

```js
    if (index < 1 || index > this.cameras.length) return;
    const prevSolo = this.soloIndex !== null ? this.cameras[this.soloIndex - 1] : null;
    this.soloIndex = index;
```

Then, after the `forEach` that hides the non-solo tiles, add:

```js
    if (prevSolo && prevSolo.id !== cam.id) this._useStream(prevSolo, false);
    this._useStream(cam, true);
```

d) In `exitSolo`, capture the camera before clearing the index. Replace

```js
    if (this.soloIndex === null) return;
    this.soloIndex = null;
```

with

```js
    if (this.soloIndex === null) return;
    const soloCam = this.cameras[this.soloIndex - 1];
    this.soloIndex = null;
```

and after the `forEach` that shows all tiles, add:

```js
    if (soloCam) this._useStream(soloCam, false);
```

e) In the `camera-status` listener, replace

```js
        const tile = document.querySelector(`[data-id="${camera_id}"]`);
        if (tile) this.applyCameraStatus(tile, status);
```

with

```js
        // Status may be for a grid substream (<id>.grid); only show it on the
        // tile if that's the stream the tile is currently playing.
        const camId = camera_id.replace(/\.grid$/, '');
        const tile = document.querySelector(`.camera-tile[data-id="${camId}"]`);
        if (tile && (tile.dataset.stream || camId) === camera_id) this.applyCameraStatus(tile, status);
```

f) In the `stream-error` listener, change the camera lookup to strip the suffix and label the substream:

```js
        const camId = camera_id.replace(/\.grid$/, '');
        const camera = this.cameras.find(c => c.id === camId);
        const cameraName = (camera ? camera.name : camId) + (camId !== camera_id ? ' (grid stream)' : '');
```

- [ ] **Step 8: Settings field**

In `renderCameraList`, after the `data-field="url"` input, add:

```html
        <input type="text" placeholder="Grid substream URL (optional, lower resolution)" value="${escapeHtml(cam.grid_url || '')}" data-field="grid_url" />
```

In `addCameraField`, after its `data-field="url"` input, add:

```html
      <input type="text" placeholder="Grid substream URL (optional, lower resolution)" value="" data-field="grid_url" />
```

In `saveSettings`, inside `entries.forEach`, read `const gridUrl = entry.querySelector('[data-field="grid_url"]').value.trim();` and add `grid_url: gridUrl || null,` to the camera object.

`.camera-entry` is a vertical flex column, so the extra input fits with no CSS change.

- [ ] **Step 9: Manual check**

Run `npm run tauri dev`. On a camera that has a substream (e.g. Hikvision `.../Streaming/Channels/101` for main and `102` for sub; Dahua `subtype=0`/`subtype=1`), enter both URLs and save.

- In grid view, DevTools → Network should show `/camera/<uuid>.grid/stream`, and `document.querySelector('.camera-tile video').videoWidth` reports the substream width.
- Double-click the tile. It shows the frozen last frame briefly, then plays `/camera/<uuid>/stream` at full resolution.
- Press `0`. It goes back to `.grid`.
- Use `/api/solo/1` and `/api/grid` from the control panel and confirm the same switching happens.
- Cameras with no grid URL behave exactly as before.
- In Task Manager → GPU, "Video Decode" for the webview should drop noticeably in grid view with several HD/4K cameras.

- [ ] **Step 10: Commit**

```bash
git add src/main.js
git commit -m "feat: grid tiles use substream, solo switches to main stream"
```

---

## Chunk 4: Docs and final verification

### Task 6: README and final check

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update README**
  - Features table: change **Multi-Protocol** to mention H.264 and H.265, and add a row: `| **Grid Substreams** | Optional low-res URL per camera for the grid; solo switches to the full-res stream |`.
  - Settings Reference: remove the obsolete `Quality` row (streams are copied as-is) and add `| API Token | Required as ?token= on /api/* calls when set | empty (off) |`.
  - Remote Control API: note that when a token is set, every endpoint needs `?token=<value>` (e.g. `http://stageview.local:8090/api/solo/1?token=…` in Stream Deck/Companion), and that `/camera/*/stream` is served to the local app only.
  - Add a short note: H.265 needs a GPU with HEVC hardware decode (most GPUs from 2016 on); unsupported systems show an error toast.

- [ ] **Step 2: Run all tests**

```bash
cd src-tauri && cargo test --lib
```

Expected: all Rust tests pass.

```bash
node --test tests/codec.test.cjs
```

Expected: all JS tests pass.

- [ ] **Step 3: Full manual smoke test**

`npm run tauri dev` with your real cameras. Check:
- RTSP, RTP and any SRT/HTTP cameras come online.
- Solo and grid switch correctly via keys 1-9/0, double-click, and the control panel.
- The control panel works with and without a token.
- Leave it running for at least an hour and check that `%APPDATA%\StageView` logs show no repeated `lagged` warnings followed by restarts.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document API token, H.265 and grid substreams"
```
