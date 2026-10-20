const test = require('node:test');
const assert = require('node:assert');
const { gridStreamId } = require('../src/streams.js');

// Must match stream_targets() in src-tauri/src/lib.rs
test('grid stream when grid_url differs from url', () => {
  assert.strictEqual(gridStreamId({ id: 'abc', url: 'rtsp://x/main', grid_url: 'rtsp://x/sub' }), 'abc.grid');
});

test('no grid stream without grid_url', () => {
  assert.strictEqual(gridStreamId({ id: 'abc', url: 'rtsp://x/main' }), null);
  assert.strictEqual(gridStreamId({ id: 'abc', url: 'rtsp://x/main', grid_url: null }), null);
});

test('blank grid_url is ignored', () => {
  assert.strictEqual(gridStreamId({ id: 'abc', url: 'rtsp://x/main', grid_url: '   ' }), null);
});

test('grid_url equal to url (after trim) is ignored', () => {
  assert.strictEqual(gridStreamId({ id: 'abc', url: 'rtsp://x/main', grid_url: ' rtsp://x/main ' }), null);
});
