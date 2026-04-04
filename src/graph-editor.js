/**
 * graph-editor.js
 *
 * ⚠️  DEPRECATED — This file is part of the unused ES modules version.
 *     The active implementation is src/plugin.js. See main.js for details.
 *
 * Canvas-based cubic bezier easing curve editor.
 * The curve is defined by P0=(0,0) and P3=(1,1) (fixed endpoints)
 * with two draggable control points P1 and P2.
 *
 * The Y axis allows values outside [0,1] to enable overshoot / bounce curves.
 * X is clamped to [0,1] for both handles.
 *
 * Public API:
 *   init(canvas, getCurve, onCurveChange)
 *   drawGraph(canvas, curve)
 *   sampleBezierCurve(xFraction, curve) → number
 */

// ─── Bezier math (CSS cubic-bezier algorithm) ──────────────────────────────

function _bx(t, p1x, p2x) {
  const mt = 1 - t;
  return 3 * mt * mt * t * p1x + 3 * mt * t * t * p2x + t * t * t;
}

function _bxd(t, p1x, p2x) {
  // Derivative of _bx with respect to t
  const mt = 1 - t;
  return 3 * mt * mt * p1x + 6 * mt * t * (p2x - p1x) + 3 * t * t * (1 - p2x);
}

function _by(t, p1y, p2y) {
  const mt = 1 - t;
  return 3 * mt * mt * t * p1y + 3 * mt * t * t * p2y + t * t * t;
}

/**
 * Solve for the bezier parameter t given an x value, using Newton-Raphson.
 * Assumes x ∈ [0,1] and that p1x/p2x keep the curve monotonic in x.
 */
function _tForX(x, p1x, p2x) {
  let t = x; // good initial guess for near-linear curves
  for (let i = 0; i < 12; i++) {
    const err = _bx(t, p1x, p2x) - x;
    if (Math.abs(err) < 1e-8) return t;
    const d = _bxd(t, p1x, p2x);
    if (Math.abs(d) < 1e-8) break; // derivative too small — fall through to binary search
    t = Math.max(0, Math.min(1, t - err / d));
  }
  // Binary search fallback for when Newton-Raphson doesn't converge
  let lo = 0, hi = 1;
  for (let j = 0; j < 20; j++) {
    const mid = (lo + hi) / 2;
    if (_bx(mid, p1x, p2x) < x) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Evaluate the bezier curve's Y output for a given time fraction x ∈ [0,1].
 * The returned value may be outside [0,1] when control points overshoot.
 */
export function sampleBezierCurve(x, curve) {
  const { p1x, p1y, p2x, p2y } = curve;
  const cx = Math.max(0, Math.min(1, x));
  if (cx === 0) return 0;
  if (cx === 1) return 1;
  const t = _tForX(cx, p1x, p2x);
  return _by(t, p1y, p2y);
}

// ─── Dash helper (UXP canvas does not support setLineDash) ────────────────

function _drawDashedLine(ctx, x1, y1, x2, y2, dashLen, gapLen) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len === 0) return;
  const ux = dx / len, uy = dy / len;
  let pos = 0, drawing = true;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  while (pos < len) {
    const seg = Math.min(drawing ? dashLen : gapLen, len - pos);
    pos += seg;
    const nx = x1 + ux * pos, ny = y1 + uy * pos;
    if (drawing) ctx.lineTo(nx, ny); else ctx.moveTo(nx, ny);
    drawing = !drawing;
  }
  ctx.stroke();
}

// ─── Canvas layout constants ───────────────────────────────────────────────

const PAD        = 8;    // padding around the graph area (px)
const HANDLE_R   = 7;    // handle circle radius (px)
// Y axis shows this range so overshoot curves are visible
const Y_MIN      = -0.30;
const Y_MAX      =  1.30;
const Y_RANGE    = Y_MAX - Y_MIN; // 1.60

// ─── Coordinate transforms ─────────────────────────────────────────────────

function normToCanvas(nx, ny, W, H) {
  const gW = W - 2 * PAD;
  const gH = H - 2 * PAD;
  return {
    cx: PAD + nx * gW,
    cy: PAD + ((Y_MAX - ny) / Y_RANGE) * gH,
  };
}

function canvasToNorm(cx, cy, W, H) {
  const gW = W - 2 * PAD;
  const gH = H - 2 * PAD;
  return {
    nx: (cx - PAD) / gW,
    ny: Y_MAX - ((cy - PAD) / gH) * Y_RANGE,
  };
}

// ─── Drawing ───────────────────────────────────────────────────────────────

export function drawGraph(canvas, curve) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const gW = W - 2 * PAD;
  const gH = H - 2 * PAD;

  ctx.clearRect(0, 0, W, H);

  // ── Background ──
  ctx.fillStyle = '#1e1e1e';
  ctx.fillRect(0, 0, W, H);

  // ── Overshoot shading (zones outside 0-1 value range) ──
  const y0c = normToCanvas(0, 0, W, H).cy;   // canvas Y for value=0
  const y1c = normToCanvas(0, 1, W, H).cy;   // canvas Y for value=1

  // Above 100% zone
  ctx.fillStyle = 'rgba(255,255,255,0.025)';
  ctx.fillRect(PAD, PAD, gW, y1c - PAD);

  // Below 0% zone
  ctx.fillStyle = 'rgba(255,255,255,0.025)';
  ctx.fillRect(PAD, y0c, gW, (H - PAD) - y0c);

  // ── Grid lines ──
  ctx.strokeStyle = 'rgba(255,255,255,0.055)';
  ctx.lineWidth = 1;

  // Vertical grid (time axis) — 4 divisions
  for (let i = 1; i <= 3; i++) {
    const x = PAD + (i / 4) * gW;
    ctx.beginPath(); ctx.moveTo(x, PAD); ctx.lineTo(x, H - PAD); ctx.stroke();
  }
  // Horizontal grid (value axis) — at 0%, 25%, 50%, 75%, 100%
  for (let i = 0; i <= 4; i++) {
    const ny  = i / 4;
    const pos = normToCanvas(0, ny, W, H);
    const isEdge = ny === 0 || ny === 1;
    ctx.strokeStyle = isEdge
      ? 'rgba(255,255,255,0.13)'
      : 'rgba(255,255,255,0.055)';
    ctx.lineWidth = isEdge ? 1 : 1;
    ctx.beginPath();
    ctx.moveTo(PAD, pos.cy);
    ctx.lineTo(W - PAD, pos.cy);
    ctx.stroke();
  }

  // ── Diagonal guide (linear reference, dashed manually — UXP has no setLineDash) ──
  const start = normToCanvas(0, 0, W, H);
  const end   = normToCanvas(1, 1, W, H);
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth = 1;
  _drawDashedLine(ctx, start.cx, start.cy, end.cx, end.cy, 3, 4);

  // ── Tangent handle lines ──
  const p0 = normToCanvas(0, 0, W, H);
  const p1 = normToCanvas(curve.p1x, curve.p1y, W, H);
  const p2 = normToCanvas(curve.p2x, curve.p2y, W, H);
  const p3 = normToCanvas(1, 1, W, H);

  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(p0.cx, p0.cy); ctx.lineTo(p1.cx, p1.cy); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(p3.cx, p3.cy); ctx.lineTo(p2.cx, p2.cy); ctx.stroke();

  // ── Bezier curve ──
  // Transform all 4 control points to canvas coords and use native bezierCurveTo
  // (bezier curves are affinely transformable, so this is correct)
  ctx.strokeStyle = '#4a9eff';
  ctx.lineWidth = 2.5;
  ctx.shadowColor = 'rgba(74,158,255,0.35)';
  ctx.shadowBlur = 6;
  ctx.beginPath();
  ctx.moveTo(p0.cx, p0.cy);
  ctx.bezierCurveTo(p1.cx, p1.cy, p2.cx, p2.cy, p3.cx, p3.cy);
  ctx.stroke();
  ctx.shadowBlur = 0;

  // ── Fixed endpoints ──
  _drawDot(ctx, p0.cx, p0.cy, 4, '#4a9eff', '#1e1e1e');
  _drawDot(ctx, p3.cx, p3.cy, 4, '#4a9eff', '#1e1e1e');

  // ── Draggable handles ──
  _drawHandle(ctx, p1.cx, p1.cy, HANDLE_R, '#4a9eff');
  _drawHandle(ctx, p2.cx, p2.cy, HANDLE_R, '#4a9eff');
}

function _drawDot(ctx, cx, cy, r, stroke, fill) {
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 2;
  ctx.stroke();
}

function _drawHandle(ctx, cx, cy, r, color) {
  // Outer glow ring
  ctx.beginPath();
  ctx.arc(cx, cy, r + 2, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(74,158,255,0.12)';
  ctx.fill();

  // Handle circle
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

// ─── Interaction ───────────────────────────────────────────────────────────

/**
 * Wire up mouse drag interaction on the canvas.
 * @param {HTMLCanvasElement} canvas
 * @param {() => {p1x,p1y,p2x,p2y}} getCurve  - returns current curve state
 * @param {(partial) => void} onCurveChange     - called with updated curve fields
 */
export function init(canvas, getCurve, onCurveChange) {
  let dragging = null; // 'p1' | 'p2' | null
  let rafId    = null;
  let pendingX = 0, pendingY = 0;

  function getMouseCanvas(e) {
    const rect   = canvas.getBoundingClientRect();
    const scaleX = canvas.width  / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      cx: (e.clientX - rect.left) * scaleX,
      cy: (e.clientY - rect.top)  * scaleY,
    };
  }

  function hitTest(e) {
    const { cx: clickCx, cy: clickCy } = getMouseCanvas(e);
    const curve = getCurve();
    const W = canvas.width, H = canvas.height;
    const p1c = normToCanvas(curve.p1x, curve.p1y, W, H);
    const p2c = normToCanvas(curve.p2x, curve.p2y, W, H);
    if (Math.hypot(clickCx - p1c.cx, clickCy - p1c.cy) <= HANDLE_R + 4) return 'p1';
    if (Math.hypot(clickCx - p2c.cx, clickCy - p2c.cy) <= HANDLE_R + 4) return 'p2';
    return null;
  }

  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragging = hitTest(e);
    if (dragging) {
      e.preventDefault();
      canvas.style.cursor = 'grabbing';
    }
  });

  canvas.addEventListener('mousemove', (e) => {
    if (!dragging) {
      canvas.style.cursor = hitTest(e) ? 'grab' : 'crosshair';
      return;
    }

    // Store latest position; commit at most once per animation frame
    const { cx, cy } = getMouseCanvas(e);
    const norm = canvasToNorm(cx, cy, canvas.width, canvas.height);
    pendingX = Math.max(0,    Math.min(1,   norm.nx));
    pendingY = Math.max(-1.0, Math.min(2.0, norm.ny));

    if (rafId !== null) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      if (!dragging) return;
      if (dragging === 'p1') onCurveChange({ p1x: pendingX, p1y: pendingY });
      else                   onCurveChange({ p2x: pendingX, p2y: pendingY });
    });
  });

  function _stopDrag() {
    dragging = null;
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    canvas.style.cursor = 'crosshair';
  }

  canvas.addEventListener('mouseup',    _stopDrag);
  canvas.addEventListener('mouseleave', _stopDrag);
}

// ─── Canvas sizing ─────────────────────────────────────────────────────────

/**
 * Resize the canvas to fill its wrapper container.
 * Call this on init and whenever the panel is resized.
 */
export function resizeCanvas(canvas) {
  // Read the actual CSS-rendered size of the canvas element itself.
  // Using offsetWidth/offsetHeight instead of wrapper.clientWidth/clientHeight
  // avoids getting 0 when the wrapper has no intrinsic height yet.
  const w = Math.max(80, canvas.offsetWidth);
  const h = Math.max(80, canvas.offsetHeight);
  canvas.width  = w;
  canvas.height = h;
}
