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

test('a reader stopped while a restart is pending stays stopped', async () => {
  const { Reader, fetched } = loadMain();
  const reader = new Reader('http://localhost:8090/camera/a/stream', fakeVideo());
  reader.start();
  const before = fetched.length;

  reader._restart(); // first restart runs on the next tick
  reader.stop();     // e.g. Settings saved and the grid rebuilt
  await new Promise((r) => setTimeout(r, 10));

  assert.strictEqual(reader.running, false);
  assert.strictEqual(fetched.length, before, 'no new fetch from a stopped reader');
});

test('a corrupt-frame tick does not save that frame as the "good" one', () => {
  const { Reader } = loadMain();
  const video = fakeVideo();
  let corrupted = 0;
  video.getVideoPlaybackQuality = () => ({ corruptedVideoFrames: corrupted });
  const reader = new Reader('http://localhost:8090/camera/a/stream', video);
  reader._firstFrame = true;
  let captures = 0;
  reader._captureGoodFrame = () => { captures++; };

  reader._checkCorruptFrames();
  assert.strictEqual(captures, 1, 'clean tick captures');
  corrupted = 2;
  reader._checkCorruptFrames();
  assert.strictEqual(captures, 1, 'glitched tick does not capture');
  reader._checkCorruptFrames();
  assert.strictEqual(captures, 2, 'next clean tick captures again');
});
