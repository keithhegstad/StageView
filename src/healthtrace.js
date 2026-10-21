// ── Stream health trace ─────────────────────────────────────────────────────
// Geometry for the frame-rate trace in Settings > Stream health. Pure function,
// so it can be tested without a DOM. Samples arrive every 2 s; 90 of them is the
// last three minutes. A dip is under 90% of the camera's own normal rate.

const HISTORY_SAMPLES = 90;
const DIP_RATIO = 0.9;
const HEADROOM = 1.15; // space above the normal rate, so the reference line isn't at the edge

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function sampleState(fps, nominal) {
  if (!(fps > 0)) return 'lost';
  return fps < nominal * DIP_RATIO ? 'dip' : 'ok';
}

/**
 * @param {number[]} fpsSamples oldest first
 * @returns {{nominal:number, referenceY:number, segments:{state:string, points:number[][]}[]}}
 */
function traceGeometry(fpsSamples, width, height) {
  const samples = fpsSamples.slice(-HISTORY_SAMPLES);
  const withFrames = samples.filter((f) => f > 0);
  const nominal = withFrames.length ? Math.round(median(withFrames)) : 30;
  const top = nominal * HEADROOM;
  const yFor = (fps) => Math.min(height, Math.max(0, height - (Math.max(0, fps) / top) * height));
  const step = width / (HISTORY_SAMPLES - 1);
  const xFor = (i) => width - (samples.length - 1 - i) * step;

  const segments = [];
  let current = null;
  samples.forEach((fps, i) => {
    const point = [xFor(i), yFor(fps)];
    const state = sampleState(fps, nominal);
    if (!current || current.state !== state) {
      // Start the new segment on the previous point so the line stays unbroken
      const prev = current ? current.points[current.points.length - 1] : null;
      current = { state, points: prev ? [prev] : [] };
      segments.push(current);
    }
    current.points.push(point);
  });

  return { nominal, referenceY: yFor(nominal), segments };
}

if (typeof module !== 'undefined') module.exports = { traceGeometry, HISTORY_SAMPLES };
