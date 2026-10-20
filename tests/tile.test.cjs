const test = require('node:test');
const assert = require('node:assert');
const { loadMain, fakeTile } = require('./sandbox.cjs');

const { StageView } = loadMain();
const view = Object.create(StageView.prototype); // methods only; no constructor/DOM boot

test('unsupported codec puts a persistent message on the tile and a red dot', () => {
  const { tile, status } = fakeTile();
  view.markUnsupported(tile, 'H.265', 'hev1.1.6.L93.90');

  assert.strictEqual(tile.dataset.unsupported, '1');
  const msg = tile.querySelector('.tile-message');
  assert.ok(msg, 'message element added');
  assert.match(msg.textContent, /H\.265/);
  assert.ok(status.classList.contains('offline'), 'dot is not green');
});

test('a later "online" event does not turn an unsupported tile green', () => {
  const { tile, status, spinner } = fakeTile();
  view.markUnsupported(tile, 'H.265', 'hev1.1.6.L93.90');
  view.applyCameraStatus(tile, 'online');

  assert.ok(status.classList.contains('offline'));
  assert.strictEqual(spinner.style.display, 'none');
  assert.ok(tile.querySelector('.tile-message'), 'message still shown');
});

test('marking twice keeps a single message', () => {
  const { tile } = fakeTile();
  view.markUnsupported(tile, 'H.265', 'hev1.1.6.L93.90');
  view.markUnsupported(tile, 'H.265', 'hev1.1.6.L93.90');
  assert.strictEqual(tile.children.filter((c) => c.className === 'tile-message').length, 1);
});

test('clearing restores normal status handling', () => {
  const { tile, status } = fakeTile();
  view.markUnsupported(tile, 'H.265', 'hev1.1.6.L93.90');
  view.clearUnsupported(tile);
  view.applyCameraStatus(tile, 'online');

  assert.strictEqual(tile.dataset.unsupported, undefined);
  assert.strictEqual(tile.querySelector('.tile-message'), null);
  assert.ok(!status.classList.contains('offline'));
});
