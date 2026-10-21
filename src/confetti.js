// ── Update confetti ─────────────────────────────────────────────────────────
// Confetti springs from the panel that says what changed: a fan along its top
// edge, going straight up at the middle and thrown further out towards each
// end, so the paper bursts out of the window itself. Paper, gold, silver and
// red pieces tumble edge-on as they fall. Draws on the given canvas, then
// clears it and resolves. Nothing is drawn when the viewer has asked for
// reduced motion.
//
// `origin` is the panel's rect in canvas coordinates. Without one the fan
// spans the width of the canvas floor.

const CONFETTI_COLORS = ['#e9e6df', '#d9a441', '#c8ccd2', '#a3242f', '#d9a441'];

function fireConfetti(canvas, { durationMs = 4200, perVolley = 110, origin = null } = {}) {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return Promise.resolve();

  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const rand = (a, b) => a + Math.random() * (b - a);
  const scale = Math.max(0.7, Math.min(1.6, h / 900)); // bigger screens get a bigger throw
  const pieces = [];

  // The panel's top edge, or the full width of the canvas floor without one
  const mouth = origin
    ? { left: origin.left, width: origin.width, top: origin.top }
    : { left: 0, width: w, top: h };

  const volley = (delay) => {
    for (let i = 0; i < perVolley; i++) {
      // A fan along the top edge: straight up at the middle, thrown further out
      // towards each end, so the paper bursts from the window rather than rising.
      const across = Math.random();
      const fromCentre = (across - 0.5) * 2; // -1 at the left end, 1 at the right
      const angle = -Math.PI / 2 + fromCentre * rand(0.35, 1.0);
      const speed = rand(12, 24) * scale * (0.75 + Math.abs(fromCentre) * 0.5);
      const strip = Math.random() < 0.25;
      pieces.push({
        x: mouth.left + across * mouth.width,
        y: mouth.top + rand(-8, 10),
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        w: strip ? rand(3, 4) : rand(7, 11),
        h: strip ? rand(16, 24) : rand(9, 14),
        color: CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0],
        spin: rand(0, Math.PI * 2),
        spinSpeed: rand(-0.25, 0.25),
        flip: rand(0, Math.PI * 2),
        flipSpeed: rand(0.08, 0.2),
        sway: rand(0.6, 1.4),
        delay,
      });
    }
  };
  volley(0);
  volley(90);
  volley(340);

  return new Promise((resolve) => {
    const start = performance.now();
    let last = start;
    const frame = (now) => {
      const t = now - start;
      const dt = Math.min(2.5, (now - last) / 16.67); // in 60 fps frames; survives a slow frame
      last = now;
      ctx.clearRect(0, 0, w, h);
      const fade = t > durationMs - 700 ? Math.max(0, (durationMs - t) / 700) : 1;

      for (const p of pieces) {
        if (t < p.delay) continue;
        p.vy += 0.32 * scale * dt;           // gravity
        p.vx *= Math.pow(0.985, dt);         // air drag
        p.vy *= Math.pow(0.985, dt);
        p.vy = Math.min(p.vy, 3.2 * scale);  // paper falls slowly once it has slowed down
        p.flip += p.flipSpeed * dt;
        p.spin += p.spinSpeed * dt;
        p.x += (p.vx + Math.sin(p.flip) * p.sway) * dt;
        p.y += p.vy * dt;
        if (p.y > h + 40) continue;

        ctx.save();
        ctx.globalAlpha = fade;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.spin);
        ctx.scale(1, Math.cos(p.flip)); // edge-on tumble
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }

      if (t < durationMs) {
        requestAnimationFrame(frame);
      } else {
        ctx.clearRect(0, 0, w, h);
        resolve();
      }
    };
    requestAnimationFrame(frame);
  });
}
