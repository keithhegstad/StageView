const test = require('node:test');
const assert = require('node:assert');
const { loadMain } = require('./sandbox.cjs');

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
  const { Reader, fetched } = loadMain();
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
