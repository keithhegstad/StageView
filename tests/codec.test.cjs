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
