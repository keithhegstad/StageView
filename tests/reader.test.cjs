const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Load main.js into a sandbox with just enough fake DOM/MSE to construct a reader.
function loadReaderClass() {
  const fetched = [];
  class FakeMediaSource {
    constructor() { this.readyState = 'closed'; }
    addEventListener() {}
    static isTypeSupported() { return true; }
  }
  const ctx = {
    window: { addEventListener() {} },
    MediaSource: FakeMediaSource,
    URL: { createObjectURL: () => 'blob:fake', revokeObjectURL() {} },
    AbortController,
    fetch: (url) => { fetched.push(url); return new Promise(() => {}); },
    setTimeout, clearTimeout, setInterval, clearInterval, console,
  };
  ctx.window.MediaSource = FakeMediaSource;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8'), ctx);
  return { Reader: vm.runInContext('Mp4StreamReader', ctx), fetched };
}

function fakeVideo() {
  const listeners = {};
  return {
    src: '', parentElement: null,
    addEventListener: (ev, fn) => { listeners[ev] = fn; },
    removeEventListener: (ev, fn) => { if (listeners[ev] === fn) delete listeners[ev]; },
    play: () => Promise.resolve(),
    listeners,
  };
}

test('switchUrl revives a reader that was stopped (e.g. unsupported codec)', () => {
  const { Reader, fetched } = loadReaderClass();
  const video = fakeVideo();
  const reader = new Reader('http://localhost:8090/camera/a/stream', video);
  reader.start();
  reader.stop();
  assert.strictEqual(reader.running, false);

  reader.switchUrl('http://localhost:8090/camera/a.grid/stream');

  assert.strictEqual(reader.running, true);
  assert.strictEqual(fetched.at(-1), 'http://localhost:8090/camera/a.grid/stream');
  assert.ok(video.listeners.error && video.listeners.waiting, 'video listeners re-attached');
});
