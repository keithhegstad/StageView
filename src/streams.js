// ── Stream ids ──────────────────────────────────────────────────────────────
// A camera's grid substream runs as "<id>.grid". The rule for when it exists
// must match stream_targets() in src-tauri/src/lib.rs, or a tile would wait on
// a stream the backend never starts.

function gridStreamId(cam) {
  const grid = (cam.grid_url || '').trim();
  return grid && grid !== cam.url ? `${cam.id}.grid` : null;
}

if (typeof module !== 'undefined') module.exports = { gridStreamId };
