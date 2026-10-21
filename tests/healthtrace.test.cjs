const test = require('node:test');
const assert = require('node:assert');
const { traceGeometry, HISTORY_SAMPLES } = require('../src/healthtrace.js');

const steady = (n, fps = 30) => Array.from({ length: n }, () => fps);

test('nominal rate is the median of samples that had frames', () => {
  assert.strictEqual(traceGeometry([30, 30, 29.9, 0, 30.1], 100, 20).nominal, 30);
  assert.strictEqual(traceGeometry([25, 25, 24.8], 100, 20).nominal, 25);
});

test('no frames at all still gives a usable scale', () => {
  const g = traceGeometry([0, 0], 100, 20);
  assert.strictEqual(g.nominal, 30);
  assert.deepStrictEqual(g.segments.map((s) => s.state), ['lost']);
});

test('newest sample sits at the right edge, history fills in from the right', () => {
  const g = traceGeometry(steady(3), 100, 20);
  const xs = g.segments[0].points.map((p) => p[0]);
  assert.strictEqual(xs[xs.length - 1], 100);
  const step = 100 / (HISTORY_SAMPLES - 1);
  assert.ok(Math.abs(xs[0] - (100 - 2 * step)) < 1e-9);
});

test('a steady stream is one ok segment along the reference line', () => {
  const g = traceGeometry(steady(10), 100, 20);
  assert.deepStrictEqual(g.segments.map((s) => s.state), ['ok']);
  assert.ok(g.segments[0].points.every(([, y]) => Math.abs(y - g.referenceY) < 1e-9));
});

test('dips and lost frames get their own segments, joined to their neighbours', () => {
  const g = traceGeometry([30, 30, 20, 20, 30, 0, 30], 120, 20);
  assert.deepStrictEqual(g.segments.map((s) => s.state), ['ok', 'dip', 'ok', 'lost', 'ok']);
  // Each segment starts where the previous one ended, so the line is unbroken
  for (let i = 1; i < g.segments.length; i++) {
    const prev = g.segments[i - 1].points;
    assert.deepStrictEqual(g.segments[i].points[0], prev[prev.length - 1]);
  }
});

test('a dip is anything under 90% of nominal', () => {
  assert.deepStrictEqual(traceGeometry([30, 27.1, 30], 100, 20).segments.map((s) => s.state), ['ok']);
  assert.deepStrictEqual(traceGeometry([30, 26.9, 30], 100, 20).segments.map((s) => s.state), ['ok', 'dip', 'ok']);
});

test('higher fps than nominal is clamped inside the box', () => {
  const g = traceGeometry([30, 30, 30, 90], 100, 20);
  assert.ok(g.segments.flatMap((s) => s.points).every(([, y]) => y >= 0 && y <= 20));
});

test('only the most recent HISTORY_SAMPLES are drawn', () => {
  const g = traceGeometry(steady(HISTORY_SAMPLES + 25), 100, 20);
  assert.strictEqual(g.segments[0].points.length, HISTORY_SAMPLES);
  assert.strictEqual(g.segments[0].points[0][0], 0);
});
