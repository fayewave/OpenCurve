/**
 * OpenCurve — shared UI code for both UXP and CEP versions.
 *
 * This file contains all pure DOM/JS logic: state management, bezier math,
 * SVG graph editor, preset system, settings modal, and UI rendering.
 *
 * Platform-specific code (Premiere API, plugin lifecycle) is injected via
 * the OpenCurve.bridge object which must be set before calling OpenCurve.initPanel().
 */

var OpenCurve = (function() {

// ─── State ────────────────────────────────────────────────────────────────
var state = {
  status:           'idle',
  clipName:         '',     // name of the clip the rows belong to, shown in the status strip
  availableParams:  [],
  selectedParamKeys: [],
  validParamKeys:   [],
  paramContexts:    {},
  bakedParamKeys:   [],
  errorMessage:     '',
  hint:             '',
  isBaking:         false,
  curve: { p1x: 0.65, p1y: 0, p2x: 0.35, p2y: 1 },
};
var stateListeners = [];

function getState() {
  return Object.assign({}, state, { curve: _cloneCurve(state.curve) });
}
function setState(updates) {
  Object.assign(state, updates);
  if (updates.curve) state.curve = _cloneCurve(updates.curve);
  var snap = getState();
  stateListeners.forEach(function(fn) { try { fn(snap); } catch(_) {} });
}

// ─── Curve animation ─────────────────────────────────────────────────────
var _curveAnimRaf = null;
// Stop a running tween. Anything that edits the curve must call this first: the
// next frame would otherwise overwrite the edit, and a multi-point blend carries
// _matchCurves padding anchors that a press landing mid-tween could commit.
function _cancelCurveAnim() {
  if (_curveAnimRaf) { cancelAnimationFrame(_curveAnimRaf); _curveAnimRaf = null; }
  _animVis = null;
}
function _animateToCurve(target, onUpdate) {
  _cancelCurveAnim();
  // Multi-point curves tween too: _matchCurves pads both sides with shape-neutral
  // splits until they share the same anchors, so every coordinate can be lerped.
  var real = getState().curve;
  var pair = _matchCurves(real, target);
  var from = pair[0], to = pair[1];
  // A split shortens the handles beside it, so the padded curves' handles are
  // not where the user sees them. The path is drawn from the padded blend and
  // the handles from a second blend that starts and ends at the real ones
  // (_animVis, read by updateDynamicSVG), so nothing jumps at either end.
  var vFrom = _visOf(from, real), vTo = _visOf(to, target);
  var duration = 150;
  var start = null;
  // The state carries the target for the whole tween and the frames only draw, so
  // a bake, copy or preset save landing mid-flight sees the curve the user asked
  // for rather than an intermediate (which would also carry the padding anchors).
  // It saves the ~9 renderUI passes a per-frame setState used to fan out.
  setState({ curve: _cloneCurve(target) });
  _autoZoomFor(target); // zoom out for a curve past the range box, back for one that fits
  if (!_graphVisible) { _graphDirty = true; return; } // nothing to see: skip the frames, the state is already the target
  function easeInOut(t) { return t < 0.5 ? 4*t*t*t : 1-Math.pow(-2*t+2,3)/2; }
  function step(ts) {
    if (!start) start = ts;
    var p = Math.min((ts - start) / duration, 1);
    if (p < 1) {
      var e = easeInOut(p);
      _animVis = _lerpCurve(vFrom, vTo, e);
      try { onUpdate(_lerpCurve(from, to, e)); } finally { _animVis = null; }
      _curveAnimRaf = requestAnimationFrame(step);
    } else {
      _curveAnimRaf = null;
      onUpdate(getState().curve); // the real target, without the padding
    }
  }
  _curveAnimRaf = requestAnimationFrame(step);
}
// Handle-drawing override while a tween runs (see _animateToCurve)
var _animVis = null;

// ─── Bezier math (CSS cubic-bezier) ──────────────────────────────────────
function _bx(t, p1x, p2x) {
  var mt = 1 - t;
  return 3*mt*mt*t*p1x + 3*mt*t*t*p2x + t*t*t;
}
function _bxd(t, p1x, p2x) {
  var mt = 1 - t;
  return 3*mt*mt*p1x + 6*mt*t*(p2x - p1x) + 3*t*t*(1 - p2x);
}
function _by(t, p1y, p2y) {
  var mt = 1 - t;
  return 3*mt*mt*t*p1y + 3*mt*t*t*p2y + t*t*t;
}
function _tForX(x, p1x, p2x) {
  var t = x;
  for (var i = 0; i < 12; i++) {
    var err = _bx(t, p1x, p2x) - x;
    if (Math.abs(err) < 1e-8) return t;
    var d = _bxd(t, p1x, p2x);
    if (Math.abs(d) < 1e-8) break;
    t = Math.max(0, Math.min(1, t - err / d));
  }
  var lo = 0, hi = 1;
  for (var j = 0; j < 20; j++) {
    var mid = (lo + hi) / 2;
    if (_bx(mid, p1x, p2x) < x) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
// segs is optional: a loop that samples the same curve many times computes
// _segsOf once and passes it in, instead of rebuilding it for every sample.
function sampleBezier(x, curve, segs) {
  var cx = Math.max(0, Math.min(1, x));
  if (cx === 0) return 0;
  if (cx === 1) return 1;
  if (_hasPts(curve)) return _sampleMulti(cx, curve, segs);
  var t = _tForX(cx, curve.p1x, curve.p2x);
  return _by(t, curve.p1y, curve.p2y);
}
// Lowest and highest y the curve reaches, at least 0..1. Thumbnails stretch to
// this so a Back or Bounce curve isn't clipped at the box edge.
function _curveYBounds(c) {
  var lo = 0, hi = 1, N = 32;
  var segs = _hasPts(c) ? _segsOf(c) : null;
  for (var i = 1; i < N; i++) {
    var y = sampleBezier(i / N, c, segs);
    if (y < lo) lo = y;
    if (y > hi) hi = y;
  }
  return { lo: lo, hi: hi };
}

// ─── Multi-point curves ───────────────────────────────────────────────────
// The Add Point tool (#add-point) turns the single cubic into a chain of them.
// curve.pts holds the interior anchors, sorted by x:
//   { x, y, ix, iy, ox, oy, smooth }   ix/iy = incoming handle, ox/oy = outgoing (absolute coords)
// p1 stays the outgoing handle of (0,0) and p2 the incoming handle of (1,1), so a
// curve without pts is exactly the old format and old presets still load.
// Every handle's x is kept inside its own segment so the curve stays a function of time.
var PT_MIN_GAP = 0.01;
var _graphHitTest = null; // set by initGraphEditor so the right-click menu can find a point

function _hasPts(c) { return !!(c && c.pts && c.pts.length); }

function _cloneCurve(c) {
  var out = { p1x: c.p1x, p1y: c.p1y, p2x: c.p2x, p2y: c.p2y };
  if (_hasPts(c)) {
    out.pts = [];
    for (var i = 0; i < c.pts.length; i++) {
      var p = c.pts[i];
      out.pts.push({ x: p.x, y: p.y, ix: p.ix, iy: p.iy, ox: p.ox, oy: p.oy, smooth: p.smooth !== false });
    }
  }
  if (c.bounce) { var bn = _bnClean(c.bounce); if (bn) out.bounce = bn; } // Bounce mode's settings (see _bnBuild)
  return out;
}

// Cubic segments of a curve: [{x0,y0, c1x,c1y, c2x,c2y, x3,y3}]
function _segsOf(c) {
  var pts = c.pts || [];
  var segs = [], px = 0, py = 0, cx = c.p1x, cy = c.p1y;
  for (var i = 0; i < pts.length; i++) {
    var p = pts[i];
    segs.push({ x0: px, y0: py, c1x: cx, c1y: cy, c2x: p.ix, c2y: p.iy, x3: p.x, y3: p.y });
    px = p.x; py = p.y; cx = p.ox; cy = p.oy;
  }
  segs.push({ x0: px, y0: py, c1x: cx, c1y: cy, c2x: c.p2x, c2y: c.p2y, x3: 1, y3: 1 });
  return segs;
}

// General cubic (any endpoints) and its derivative
function _cub(t, a, b, c, d) {
  var mt = 1 - t;
  return mt*mt*mt*a + 3*mt*mt*t*b + 3*mt*t*t*c + t*t*t*d;
}
function _cubd(t, a, b, c, d) {
  var mt = 1 - t;
  return 3*mt*mt*(b - a) + 6*mt*t*(c - b) + 3*t*t*(d - c);
}

// t for a given x inside one segment (Newton, then bisection as a safety net)
function _segTForX(x, s) {
  var span = s.x3 - s.x0;
  if (span <= 1e-9) return 0;
  var t = (x - s.x0) / span;
  for (var i = 0; i < 12; i++) {
    var err = _cub(t, s.x0, s.c1x, s.c2x, s.x3) - x;
    if (Math.abs(err) < 1e-8) return t;
    var d = _cubd(t, s.x0, s.c1x, s.c2x, s.x3);
    if (Math.abs(d) < 1e-8) break;
    t = Math.max(0, Math.min(1, t - err / d));
  }
  var lo = 0, hi = 1;
  for (var j = 0; j < 24; j++) {
    var mid = (lo + hi) / 2;
    if (_cub(mid, s.x0, s.c1x, s.c2x, s.x3) < x) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

function _segAt(x, segs) {
  for (var i = segs.length - 1; i >= 0; i--) if (x >= segs[i].x0) return segs[i];
  return segs[0];
}

function _sampleMulti(x, c, segs) {
  var s = _segAt(x, segs || _segsOf(c));
  var t = _segTForX(x, s);
  return _cub(t, s.y0, s.c1y, s.c2y, s.y3);
}

// Sort anchors, keep them apart, and pull every handle's x back inside its segment.
// The head handles are clamped to the ranges a drag is allowed to produce, so a
// pasted or imported curve can never carry values the graph editor would refuse.
function _normalizeCurve(c) {
  c.p1x = Math.max(0, Math.min(1, c.p1x));
  c.p2x = Math.max(0, Math.min(1, c.p2x));
  c.p1y = Math.max(Y_CLAMP_MIN, Math.min(Y_CLAMP_MAX, c.p1y));
  c.p2y = Math.max(Y_CLAMP_MIN, Math.min(Y_CLAMP_MAX, c.p2y));
  if (!_hasPts(c)) { delete c.pts; return c; }
  c.pts.sort(function(a, b) { return a.x - b.x; });
  var n = c.pts.length;
  for (var i = 0; i < n; i++) {
    var p = c.pts[i];
    var lo = (i === 0 ? 0 : c.pts[i-1].x) + PT_MIN_GAP;
    var hi = 1 - PT_MIN_GAP * (n - i);
    p.x = Math.max(lo, Math.min(hi, p.x));
  }
  for (var k = 0; k < n; k++) {
    var q = c.pts[k];
    var prevX = k === 0 ? 0 : c.pts[k-1].x;
    var nextX = k === n - 1 ? 1 : c.pts[k+1].x;
    q.ix = Math.max(prevX, Math.min(q.x, q.ix));
    q.ox = Math.max(q.x, Math.min(nextX, q.ox));
    q.y  = Math.max(Y_CLAMP_MIN, Math.min(Y_CLAMP_MAX, q.y));
    q.iy = Math.max(Y_CLAMP_MIN, Math.min(Y_CLAMP_MAX, q.iy));
    q.oy = Math.max(Y_CLAMP_MIN, Math.min(Y_CLAMP_MAX, q.oy));
  }
  c.p1x = Math.max(0, Math.min(c.pts[0].x, c.p1x));
  c.p2x = Math.max(c.pts[n-1].x, Math.min(1, c.p2x));
  return c;
}

// Curve outline as an SVG path; tx/ty map normalised coords to pixels
function _curvePathTx(c, tx, ty) {
  var segs = _segsOf(c), d = 'M' + tx(0) + ',' + ty(0);
  for (var i = 0; i < segs.length; i++) {
    var s = segs[i];
    d += ' C' + tx(s.c1x) + ',' + ty(s.c1y) + ' ' + tx(s.c2x) + ',' + ty(s.c2y) + ' ' + tx(s.x3) + ',' + ty(s.y3);
  }
  return d;
}
function _curvePathD(c, W, H) {
  return _curvePathTx(c,
    function(x) { return normToSVG(x, 0, W, H).cx; },
    function(y) { return normToSVG(0, y, W, H).cy; });
}

// Handle descriptors used by the graph editor: {k:'p1'} {k:'p2'} {k:'a',i} {k:'in',i} {k:'out',i}
function _handlePos(c, d) {
  if (d.k === 'p1') return { x: c.p1x, y: c.p1y };
  if (d.k === 'p2') return { x: c.p2x, y: c.p2y };
  var p = c.pts[d.i];
  if (d.k === 'a')  return { x: p.x,  y: p.y  };
  if (d.k === 'in') return { x: p.ix, y: p.iy };
  return { x: p.ox, y: p.oy };
}

// Move a handle or anchor to (x, y) with the segment constraints applied. On a
// smooth anchor both handles move together as exact mirrors; alt keeps them in
// line but lets each keep its own length; ctrl moves only the dragged handle and
// breaks the pair, so the point becomes a corner.
function _setHandle(c, d, x, y, alt, ctrl) {
  var pts = c.pts || [], n = pts.length;
  y = Math.max(Y_CLAMP_MIN, Math.min(Y_CLAMP_MAX, y));
  if (d.k === 'p1') { c.p1x = Math.max(0, Math.min(n ? pts[0].x : 1, x)); c.p1y = y; return; }
  if (d.k === 'p2') { c.p2x = Math.max(n ? pts[n-1].x : 0, Math.min(1, x)); c.p2y = y; return; }
  var p = pts[d.i];
  var prevX = d.i === 0 ? 0 : pts[d.i-1].x;
  var nextX = d.i === n - 1 ? 1 : pts[d.i+1].x;
  if (d.k === 'a') {
    var nx = Math.max(prevX + PT_MIN_GAP, Math.min(nextX - PT_MIN_GAP, x));
    var dx = nx - p.x, dy = y - p.y;
    p.x = nx; p.y = y;
    p.ix += dx; p.iy += dy; p.ox += dx; p.oy += dy;
    _normalizeCurve(c);
    return;
  }
  if (ctrl) p.smooth = false;
  var link = ctrl ? false : (p.smooth || alt); // alt also re-links a broken point for this drag
  if (d.k === 'in') {
    p.ix = Math.max(prevX, Math.min(p.x, x)); p.iy = y;
    if (link) _mirrorHandle(p, 'in', p.x, nextX, !alt);
  } else {
    p.ox = Math.max(p.x, Math.min(nextX, x)); p.oy = y;
    if (link) _mirrorHandle(p, 'out', prevX, p.x, !alt);
  }
}

// Point the other handle straight away from the one just moved, keeping its length
// (or matching the moved handle's length when sameLen is set)
function _mirrorHandle(p, moved, loX, hiX, sameLen) {
  var fx = moved === 'in' ? p.ix : p.ox, fy = moved === 'in' ? p.iy : p.oy;
  var vx = p.x - fx, vy = p.y - fy;
  var len = Math.hypot(vx, vy);
  if (len < 1e-6) return;
  var ox = moved === 'in' ? p.ox : p.ix, oy = moved === 'in' ? p.oy : p.iy;
  var olen = sameLen ? len : Math.hypot(ox - p.x, oy - p.y);
  var nx = p.x + vx / len * olen, ny = p.y + vy / len * olen;
  nx = Math.max(loX, Math.min(hiX, nx));
  ny = Math.max(Y_CLAMP_MIN, Math.min(Y_CLAMP_MAX, ny));
  if (moved === 'in') { p.ox = nx; p.oy = ny; } else { p.ix = nx; p.iy = ny; }
}

function _commitCurve(c) {
  delete c.bounce; // a hand edit: no longer the curve Bounce mode built (the mode ends, see _bnOnState)
  _cancelCurveAnim(); // a running tween would overwrite this edit on its next frame
  _normalizeCurve(c);
  setState({ curve: c });
  if (_svgW > 0 && _svgH > 0) updateDynamicSVG(getState().curve, _svgW, _svgH);
}

// Add Point: split the widest segment at its middle (de Casteljau), so the shape
// is unchanged until the new point is dragged
function _addPoint() {
  var c = getState().curve;
  var segs = _segsOf(c), si = 0;
  for (var i = 1; i < segs.length; i++) if (segs[i].x3 - segs[i].x0 > segs[si].x3 - segs[si].x0) si = i;
  var s = segs[si];
  if (s.x3 - s.x0 < PT_MIN_GAP * 3) return;
  _commitCurve(_splitCurveAt(c, (s.x0 + s.x3) / 2));
}

// Split the segment containing x at x (de Casteljau): a new smooth anchor whose
// handles leave the shape exactly as it was. Returns a changed clone.
function _splitCurveAt(c, x) {
  c = _cloneCurve(c);
  var segs = _segsOf(c), si = 0;
  for (var i = 1; i < segs.length; i++) if (x >= segs[i].x0) si = i;
  var s = segs[si];
  var t = _segTForX(x, s);
  function lerp(a, b) { return a + (b - a) * t; }
  var q0x = lerp(s.x0, s.c1x),  q0y = lerp(s.y0, s.c1y);
  var q1x = lerp(s.c1x, s.c2x), q1y = lerp(s.c1y, s.c2y);
  var q2x = lerp(s.c2x, s.x3),  q2y = lerp(s.c2y, s.y3);
  var r0x = lerp(q0x, q1x), r0y = lerp(q0y, q1y);
  var r1x = lerp(q1x, q2x), r1y = lerp(q1y, q2y);
  var mx  = lerp(r0x, r1x), my  = lerp(r0y, r1y);
  var pts = c.pts || [];
  if (si === 0) { c.p1x = q0x; c.p1y = q0y; } else { pts[si-1].ox = q0x; pts[si-1].oy = q0y; }
  if (si === segs.length - 1) { c.p2x = q2x; c.p2y = q2y; } else { pts[si].ix = q2x; pts[si].iy = q2y; }
  pts.splice(si, 0, { x: mx, y: my, ix: r0x, iy: r0y, ox: r1x, oy: r1y, smooth: true });
  c.pts = pts;
  return c;
}

// Give two curves the same anchors so _animateToCurve can tween between them:
// every anchor x one side has and the other lacks is added there as a
// shape-neutral split, so anchor i sits at the same x on both and only y and
// the handles move. Plain curves come back unchanged. (Should the counts still
// differ, the shorter side is padded at its widest segments.)
function _matchCurves(a, b) {
  a = _cloneCurve(a); b = _cloneCurve(b);
  if (!_hasPts(a) && !_hasPts(b)) return [a, b];
  function xs(c) { return (c.pts || []).map(function(p) { return p.x; }); }
  function near(list, x) { for (var i = 0; i < list.length; i++) if (Math.abs(list[i] - x) < PT_MIN_GAP) return true; return false; }
  var xa = xs(a), xb = xs(b);
  for (var i = 0; i < xb.length; i++) if (!near(xs(a), xb[i])) a = _splitCurveAt(a, xb[i]);
  for (var j = 0; j < xa.length; j++) if (!near(xs(b), xa[j])) b = _splitCurveAt(b, xa[j]);
  function widest(c) {
    var segs = _segsOf(c), si = 0;
    for (var k = 1; k < segs.length; k++) if (segs[k].x3 - segs[k].x0 > segs[si].x3 - segs[si].x0) si = k;
    return (segs[si].x0 + segs[si].x3) / 2;
  }
  var guard = 0;
  while ((a.pts || []).length < (b.pts || []).length && guard++ < 64) a = _splitCurveAt(a, widest(a));
  while ((b.pts || []).length < (a.pts || []).length && guard++ < 64) b = _splitCurveAt(b, widest(b));
  return [a, b];
}

// Coordinate-wise blend of two matched curves (e = 0 gives a, 1 gives b). Both
// are sorted by x with handles inside their segments, so the blend is too. A
// point draws as a corner once past halfway if it ends as one.
function _lerpCurve(a, b, e) {
  function L(u, v) { return u + (v - u) * e; }
  var c = { p1x: L(a.p1x, b.p1x), p1y: L(a.p1y, b.p1y), p2x: L(a.p2x, b.p2x), p2y: L(a.p2y, b.p2y) };
  var pa = a.pts || [], pb = b.pts || [], n = Math.min(pa.length, pb.length);
  if (n) {
    c.pts = [];
    for (var i = 0; i < n; i++) {
      var p = pa[i], q = pb[i];
      c.pts.push({ x: L(p.x, q.x), y: L(p.y, q.y), ix: L(p.ix, q.ix), iy: L(p.iy, q.iy),
                   ox: L(p.ox, q.ox), oy: L(p.oy, q.oy), smooth: (e < 0.5 ? p : q).smooth !== false });
    }
  }
  return c;
}

// The visual twin of a padded curve: the same anchors, but every handle the
// real curve has is put back (a split only touches the handles beside it and
// never moves an existing anchor, so anchors match by x). Its handles are where
// the user sees them; only the padded ones drive the path.
function _visOf(padded, real) {
  var v = _cloneCurve(padded);
  v.p1x = real.p1x; v.p1y = real.p1y; v.p2x = real.p2x; v.p2y = real.p2y;
  var rp = real.pts || [], vp = v.pts || [];
  for (var i = 0; i < vp.length; i++) {
    for (var j = 0; j < rp.length; j++) {
      if (Math.abs(vp[i].x - rp[j].x) < PT_MIN_GAP) {
        var r = rp[j];
        vp[i] = { x: r.x, y: r.y, ix: r.ix, iy: r.iy, ox: r.ox, oy: r.oy, smooth: r.smooth !== false };
        break;
      }
    }
  }
  return v;
}

function _removePoint(i) {
  var c = _cloneCurve(getState().curve);
  if (!_hasPts(c) || i < 0 || i >= c.pts.length) return;
  c.pts.splice(i, 1);
  _commitCurve(c);
}

function _setPointSmooth(i, on) {
  var c = _cloneCurve(getState().curve);
  if (!_hasPts(c) || !c.pts[i]) return;
  var p = c.pts[i];
  p.smooth = !!on;
  if (on) {
    // swing the outgoing handle in line with the incoming one
    var nextX = i === c.pts.length - 1 ? 1 : c.pts[i+1].x;
    _mirrorHandle(p, 'in', p.x, nextX, true);
  }
  _commitCurve(c);
}

// Text form for copy/paste: cubic-bezier() for a plain curve, opencurve() once it has
// points:  opencurve(p1x, p1y, p2x, p2y, x y ix iy ox oy smooth, ...)
function _curveToText(c) {
  if (!_hasPts(c)) return 'cubic-bezier(' + c.p1x + ', ' + c.p1y + ', ' + c.p2x + ', ' + c.p2y + ')';
  var r = function(v) { return Math.round(v * 1000) / 1000; };
  var parts = [r(c.p1x), r(c.p1y), r(c.p2x), r(c.p2y)];
  for (var i = 0; i < c.pts.length; i++) {
    var p = c.pts[i];
    parts.push([r(p.x), r(p.y), r(p.ix), r(p.iy), r(p.ox), r(p.oy), p.smooth !== false ? 1 : 0].join(' '));
  }
  return 'opencurve(' + parts.join(', ') + ')';
}
function _curveFromText(text) {
  var m = text && text.match(/opencurve\(([^)]*)\)/i);
  if (!m) {
    // The other half of what _curveToText writes: a curve without points is cubic-bezier()
    var b = text && text.match(/cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/i);
    if (!b) return null;
    var h = [parseFloat(b[1]), parseFloat(b[2]), parseFloat(b[3]), parseFloat(b[4])];
    if (h.some(isNaN)) return null;
    return _normalizeCurve({ p1x: h[0], p1y: h[1], p2x: h[2], p2y: h[3] });
  }
  var parts = m[1].split(',');
  if (parts.length < 5) return null;
  var head = parts.slice(0, 4).map(function(s) { return parseFloat(s); });
  if (head.some(isNaN)) return null;
  var c = { p1x: head[0], p1y: head[1], p2x: head[2], p2y: head[3], pts: [] };
  for (var i = 4; i < parts.length; i++) {
    var v = parts[i].trim().split(/\s+/).map(function(s) { return parseFloat(s); });
    if (v.length < 6 || v.slice(0, 6).some(isNaN)) return null;
    c.pts.push({ x: v[0], y: v[1], ix: v[2], iy: v[3], ox: v[4], oy: v[5], smooth: v[6] !== 0 });
  }
  return _normalizeCurve(c);
}

// ─── Flip / Invert (toolbar #flip-curve, #invert-curve) ───────────────────
// Flip rotates the curve 180 degrees about the centre, so an ease-in becomes
// the matching ease-out (a symmetric ease-in-out is unchanged). Invert
// reflects it across the diagonal, which is the inverse easing: an in-out
// becomes an out-in. Both undo themselves when pressed twice.
function _flipCurve(c) {
  var o = { p1x: 1 - c.p2x, p1y: 1 - c.p2y, p2x: 1 - c.p1x, p2y: 1 - c.p1y };
  if (_hasPts(c)) {
    o.pts = [];
    for (var i = c.pts.length - 1; i >= 0; i--) {
      var p = c.pts[i]; // the incoming and outgoing handles swap roles
      o.pts.push({ x: 1 - p.x, y: 1 - p.y, ix: 1 - p.ox, iy: 1 - p.oy, ox: 1 - p.ix, oy: 1 - p.iy, smooth: p.smooth !== false });
    }
  }
  return _normalizeCurve(o);
}
function _invertCurve(c) {
  // x and y swap. y may sit outside 0..1 (overshoot) but x can't, so clamp it.
  function cx(v) { return Math.max(0, Math.min(1, v)); }
  var o = { p1x: cx(c.p1y), p1y: c.p1x, p2x: cx(c.p2y), p2y: c.p2x };
  if (_hasPts(c)) {
    o.pts = [];
    for (var i = 0; i < c.pts.length; i++) {
      var p = c.pts[i];
      o.pts.push({ x: cx(p.y), y: p.x, ix: cx(p.iy), iy: p.ix, ox: cx(p.oy), oy: p.ox, smooth: p.smooth !== false });
    }
  }
  return _normalizeCurve(o);
}
// Replace the current curve with fn(curve), animated like a preset click
function _applyCurveOp(fn) {
  if (_bounceMode && fn === _flipCurve) { _bnSet({ dir: _bnOpts.dir === 'in' ? 'out' : 'in' }, false); return; } // Bounce mode: Flip switches Out / In
  var c = fn(_cloneCurve(getState().curve));
  _animateToCurve(c, function(cur) { if (_svgW > 0 && _svgH > 0) updateDynamicSVG(cur, _svgW, _svgH); });
}

// SVG for the interior points: a tangent line, a handle and an anchor per side.
// Elements are created once per point (createElementNS: UXP has no SVG innerHTML)
// and re-positioned on every redraw; the set is rebuilt only when the count changes.
var _ptEls = [];
function _mkCircle(r, fill, stroke, sw) {
  var el = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  el.setAttribute('r', r); el.setAttribute('fill', fill);
  if (stroke) { el.setAttribute('stroke', stroke); el.setAttribute('stroke-width', sw); }
  return el;
}
function _mkPtEls() {
  var NS = 'http://www.w3.org/2000/svg';
  function line() {
    var l = document.createElementNS(NS, 'line');
    l.setAttribute('stroke', 'rgba(255,255,255,0.18)'); l.setAttribute('stroke-width', '4');
    return l;
  }
  function handle() {
    var g = document.createElementNS(NS, 'g');
    g.appendChild(_mkCircle(7, 'rgba(74,158,255,0.12)'));
    g.appendChild(_mkCircle(5, '#fff', '#fff', 1.5));
    return g;
  }
  // Anchor: same empty circle as the two end points (#sg-ep0 / #sg-ep3) while
  // the point is smooth; a square of the same size once its handles are broken.
  // Both live in the group and _updatePtsSVG shows one (opacity + visibility
  // attributes, as UXP ignores display/class changes on SVG).
  var a = document.createElementNS(NS, 'g');
  var inner = _mkCircle(4, '#1e1e1e', _curveColor || '#ffffff', 2);
  var sq = document.createElementNS(NS, 'rect');
  sq.setAttribute('x', -4); sq.setAttribute('y', -4); sq.setAttribute('width', 8); sq.setAttribute('height', 8);
  sq.setAttribute('rx', 1); sq.setAttribute('fill', '#1e1e1e');
  sq.setAttribute('stroke', _curveColor || '#ffffff'); sq.setAttribute('stroke-width', 2);
  sq.setAttribute('opacity', '0'); sq.setAttribute('visibility', 'hidden');
  a.appendChild(inner); a.appendChild(sq);
  return { li: line(), lo: line(), hi: handle(), ho: handle(), a: a, inner: inner, sq: sq };
}
function _updatePtsSVG(curve, W, H) {
  var lines = document.getElementById('sg-pts-lines'), g = document.getElementById('sg-pts');
  if (!lines || !g) return;
  var pts = curve.pts || [];
  while (_ptEls.length > pts.length) {
    var old = _ptEls.pop();
    lines.removeChild(old.li); lines.removeChild(old.lo);
    g.removeChild(old.hi); g.removeChild(old.ho); g.removeChild(old.a);
  }
  while (_ptEls.length < pts.length) {
    var mk = _mkPtEls();
    lines.appendChild(mk.li); lines.appendChild(mk.lo);
    g.appendChild(mk.hi); g.appendChild(mk.ho); g.appendChild(mk.a);
    _ptEls.push(mk);
  }
  for (var i = 0; i < pts.length; i++) {
    var p = pts[i], e = _ptEls[i];
    var a = normToSVG(p.x, p.y, W, H), hi = normToSVG(p.ix, p.iy, W, H), ho = normToSVG(p.ox, p.oy, W, H);
    e.li.setAttribute('x1', a.cx); e.li.setAttribute('y1', a.cy); e.li.setAttribute('x2', hi.cx); e.li.setAttribute('y2', hi.cy);
    e.lo.setAttribute('x1', a.cx); e.lo.setAttribute('y1', a.cy); e.lo.setAttribute('x2', ho.cx); e.lo.setAttribute('y2', ho.cy);
    e.hi.setAttribute('transform', 'translate(' + hi.cx + ',' + hi.cy + ')');
    e.ho.setAttribute('transform', 'translate(' + ho.cx + ',' + ho.cy + ')');
    e.a.setAttribute('transform', 'translate(' + a.cx + ',' + a.cy + ')');
    // Circle for a smooth point, square once its handles are broken
    var broken = p.smooth === false;
    e.inner.setAttribute('opacity', broken ? '0' : '1'); e.inner.setAttribute('visibility', broken ? 'hidden' : 'visible');
    e.sq.setAttribute('opacity',    broken ? '1' : '0'); e.sq.setAttribute('visibility',    broken ? 'visible' : 'hidden');
  }
}

// ─── Peak (A-curve) mode ──────────────────────────────────────────────────
// Toolbar toggle (#peak-mode). While on, the graph draws the easing's velocity
// (dy/dx) instead of the bezier: an "A"/bell whose peak is where the motion is
// fastest. The bell is normalised so its peak always touches the top of the
// range box; one drag shapes it: left/right biases where the fastest point
// sits, up narrows the bell (sharper ease), down widens it (flatter, linear is
// a flat line along the top). The result is still a plain cubic-bezier of the
// form (a, 0, b, 1), so presets, copy and bake are unchanged.
var _PEAK_KEY   = 'opencurve-peak-mode';
var _peakMode   = localStorage.getItem(_PEAK_KEY) === 'on';
// Drag ghost toggle (graph toolbar); on unless turned off
var _DRAG_GHOST_KEY = 'opencurve-drag-ghost';
var _dragGhost      = localStorage.getItem(_DRAG_GHOST_KEY) !== 'off';
var _PEAK_K_FRAC = 0.98; // top of the box = this fraction of the sharpest ease possible at that x (1 would be a step)
var _PEAK_EPS   = 1e-4; // keep t off the exact endpoints so 0/0 never happens
var _peakThumbRefresh = null; // set by initPanel: redraws preset thumbnails when the mode flips
var _presetMatchRef   = null; // set by initPanel: id of the preset with a given curve (Load Baked Curve)
var _resetPresetsRef  = null; // set by initPanel; Reset All Settings rebuilds the preset list with it

// Velocity dy/dx of the easing at bezier parameter t
function _velAt(t, c) {
  var dx = _bxd(t, c.p1x, c.p2x);
  var dy = _bxd(t, c.p1y, c.p2y);
  if (dx < 1e-9) return dy > 0 ? 1e6 : (dy < 0 ? -1e6 : 1);
  return dy / dx;
}

// N velocity samples along the curve as [{x, v}]. Plain curves sample by t (dense
// where the curve is steep); multi-point curves take a numeric slope at even x.
function _velSamples(c, N) {
  var out = [], step = (1 - 2 * _PEAK_EPS) / (N - 1);
  if (_hasPts(c)) {
    var h = 5e-4;
    var segs = _segsOf(c); // one list for all 2N samples below
    for (var j = 0; j < N; j++) {
      var x = _PEAK_EPS + j * step;
      var xa = Math.max(0, x - h), xb = Math.min(1, x + h);
      out.push({ x: x, v: (sampleBezier(xb, c, segs) - sampleBezier(xa, c, segs)) / (xb - xa) });
    }
    return out;
  }
  for (var i = 0; i < N; i++) {
    var t = _PEAK_EPS + i * step;
    out.push({ x: _bx(t, c.p1x, c.p2x), v: _velAt(t, c) });
  }
  return out;
}

// Highest velocity of a curve: coarse scan over t, then a ternary refinement
// (multi-point curves: the best of a dense numeric scan)
function _peakOf(c, N) {
  N = N || 96;
  if (_hasPts(c)) {
    var sm = _velSamples(c, Math.max(N, 192)), best = sm[0];
    for (var q = 1; q < sm.length; q++) if (sm[q].v > best.v) best = sm[q];
    return { t: best.x, x: best.x, v: best.v };
  }
  var step = (1 - 2 * _PEAK_EPS) / (N - 1);
  var bestT = _PEAK_EPS, bestV = -Infinity;
  for (var i = 0; i < N; i++) {
    var t = _PEAK_EPS + i * step;
    var v = _velAt(t, c);
    if (v > bestV) { bestV = v; bestT = t; }
  }
  var lo = Math.max(_PEAK_EPS, bestT - step), hi = Math.min(1 - _PEAK_EPS, bestT + step);
  for (var j = 0; j < 14; j++) {
    var m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    if (_velAt(m1, c) < _velAt(m2, c)) lo = m1; else hi = m2;
  }
  var tt = (lo + hi) / 2;
  var vv = _velAt(tt, c);
  if (vv < bestV) { tt = bestT; vv = bestV; }
  return { t: tt, x: _bx(tt, c.p1x, c.p2x), v: vv };
}

// The family peak mode edits: p1 = (a, 0), p2 = (b, 1). px biases where the peak
// sits (0 = ease-out, 1 = ease-in); k is the ease strength (0 = linear, 2 = step).
function _peakCurve(px, k) {
  return {
    p1x: Math.max(0, Math.min(1, px * k)),
    p1y: 0,
    p2x: Math.max(0, Math.min(1, 1 - (1 - px) * k)),
    p2y: 1,
  };
}

// Curve for a pointer position: x is where the peak should sit, ny (0 = bottom of
// the box, 1 = top) is the bell's narrowness. The family stops changing once a or b
// saturates, which happens at k = 1 / max(x, 1 - x), so ny is scaled to that range:
// the bottom is always linear and the top always the sharpest ease possible at that x.
// The bias is then nudged a few times so the real velocity peak lands at x.
function _solvePeak(targetX, ny) {
  var tx = Math.max(0, Math.min(1, targetX));
  var k  = Math.max(0, Math.min(1, ny)) * _PEAK_K_FRAC / Math.max(tx, 1 - tx);
  if (k < 0.02) return { p1x: 0, p1y: 0, p2x: 1, p2y: 1 };
  var px = tx, curve = _peakCurve(px, k);
  for (var it = 0; it < 4; it++) {
    var pk = _peakOf(curve, 96);
    px = Math.max(0, Math.min(1, px + (tx - pk.x)));
    curve = _peakCurve(px, k);
  }
  return {
    p1x: Math.round(curve.p1x * 1000) / 1000, p1y: 0,
    p2x: Math.round(curve.p2x * 1000) / 1000, p2y: 1,
  };
}

// The normalised bell (peak at the top) as an SVG path; tx/ty map 0..1 to pixels.
// Shared by the graph and the preset thumbnails.
function _peakBellPath(curve, N, tx, ty, sm) {
  sm = sm || _velSamples(curve, N);
  var vmax = 0;
  for (var i = 0; i < N; i++) if (sm[i].v > vmax) vmax = sm[i].v;
  if (!(vmax > 1e-9)) vmax = 1;
  var d = '';
  for (var j = 0; j < N; j++) {
    var x  = (j === 0) ? 0 : (j === N - 1) ? 1 : sm[j].x;
    var ny = Math.max(0, Math.min(1, sm[j].v / vmax));
    d += (j === 0 ? 'M' : ' L') + tx(x).toFixed(2) + ',' + ty(ny).toFixed(2);
  }
  return d;
}

// Draw the velocity "A" for a curve, peak pinned to the top of the range box
// (replaces updateDynamicSVG while peak mode is on)
function _updatePeakSVG(curve, W, H) {
  var pk = _peakOf(curve, 96);
  var sm = _velSamples(curve, 96), vmax = 0;
  for (var vi = 0; vi < sm.length; vi++) if (sm[vi].v > vmax) vmax = sm[vi].v;
  if (!(vmax > 1e-9)) vmax = 1;
  var d = _peakBellPath(curve, 96,
    function(x) { return normToSVG(x, 0, W, H).cx; },
    function(y) { return normToSVG(0, y, W, H).cy; }, sm);
  var first = normToSVG(0, Math.max(0, Math.min(1, sm[0].v / vmax)), W, H);
  var last  = normToSVG(1, Math.max(0, Math.min(1, sm[sm.length - 1].v / vmax)), W, H);
  var cp = _ocEl('sg-curve');
  if (cp) cp.setAttribute('d', d);
  // The bezier itself stays visible behind the bell, greyed, so both views read at once
  var ghost = _ocEl('sg-ghost');
  if (ghost) ghost.setAttribute('d', _curvePathD(curve, W, H));
  var ep0 = _ocEl('sg-ep0');
  if (ep0) { ep0.setAttribute('cx', first.cx); ep0.setAttribute('cy', first.cy); }
  var ep3 = _ocEl('sg-ep3');
  if (ep3) { ep3.setAttribute('cx', last.cx); ep3.setAttribute('cy', last.cy); }
  var px = (pk.v <= 1.02) ? 0.5 : pk.x; // a flat (linear) curve has no peak: centre the marker
  var pp = normToSVG(px, 1, W, H);
  var marker = document.getElementById('sg-peak');
  if (marker) marker.setAttribute('transform', 'translate(' + pp.cx + ',' + pp.cy + ')');
}

function _svgShow(id, on) {
  var el = document.getElementById(id);
  if (!el) return;
  el.setAttribute('opacity',    on ? '1' : '0');
  el.setAttribute('visibility', on ? 'visible' : 'hidden');
}

// Handles, tangents and the diagonal in bezier mode; the peak marker and bezier ghost in peak mode
function _applyPeakVisibility() {
  var hd = !_peakMode && !_bounceMode; // Bounce mode hides the handles too: its two dots stand in
  _svgShow('sg-tan1', hd);
  _svgShow('sg-tan2', hd);
  _svgShow('sg-h1',   hd);
  _svgShow('sg-h2',   hd);
  _svgShow('sg-diag', hd);
  _svgShow('sg-peak',  _peakMode);
  _svgShow('sg-ghost', _peakMode);
  _svgShow('sg-pts',       hd);
  _svgShow('sg-pts-lines', hd);
  _svgShow('sg-bn',       _bounceMode);
  _svgShow('sg-bn-floor', _bounceMode);
}

// Hover and press for a toolbar button whose tint is written inline (A-curve,
// Zoom): an inline background beats the stylesheet's :hover and :active, so the
// button tracks both itself (_ocHov, _ocDown) and repaint() redraws it.
function _toolStates(btn, repaint) {
  if (!btn || btn._ocStates) return;
  btn._ocStates = true;
  btn.addEventListener('mouseenter', function() { btn._ocHov = true; repaint(); });
  btn.addEventListener('mouseleave', function() { btn._ocHov = false; btn._ocDown = false; repaint(); });
  btn.addEventListener('pointerdown', function() { btn._ocDown = true; repaint(); });
  btn.addEventListener('pointerup', function() { if (btn._ocDown) { btn._ocDown = false; repaint(); } });
  btn.addEventListener('pointercancel', function() { if (btn._ocDown) { btn._ocDown = false; repaint(); } });
}
// Fill and icon colour by state. rgb: the tint ('61,220,132') with its resting
// alpha, or null for an untinted button, which gets the stylesheet's own hover
// and press values (and '' at rest, so the stylesheet shows through).
function _toolPaint(btn, rgb, rest, col) {
  var bg, c;
  if (rgb) {
    bg = 'rgba(' + rgb + ',' + (btn._ocDown ? rest + 0.32 : btn._ocHov ? rest + 0.14 : rest) + ')';
    c = btn._ocDown ? '#ffffff' : col;
  } else {
    bg = btn._ocDown ? 'rgba(255,255,255,0.26)' : btn._ocHov ? 'rgba(255,255,255,0.16)' : '';
    c = (btn._ocDown || btn._ocHov) ? '#ffffff' : '';
  }
  // Change-only (UXP relayouts on every write), compared with the last write
  if (btn._ocTpBg !== bg) { btn._ocTpBg = bg; btn.style.backgroundColor = bg; }
  if (btn._ocTpCol !== c) { btn._ocTpCol = c; btn.style.color = c; }
}

function _stylePeakBtn() {
  var btn = document.getElementById('peak-mode');
  if (!btn) return;
  _toolStates(btn, _stylePeakBtn);
  // backgroundColor, not background: the shorthand would drop the stylesheet's sheen gradient
  _toolPaint(btn, _peakMode ? '61,220,132' : null, 0.18, '#3ddc84');
  btn.style.opacity    = _peakMode ? '1' : '';
  // While the bar is collapsed the menu button carries the same tint, so the
  // mode stays visible while the A-curve button itself is hidden
  var mb = document.getElementById('graph-tools-menu');
  if (mb) {
    var tint = (_peakMode || _bounceMode) && btn.style.display === 'none'; // Bounce mode's button collapses with it
    mb.style.backgroundColor = tint ? 'rgba(61,220,132,0.18)' : '';
    mb.style.color      = tint ? '#3ddc84' : '';
  }
}

function _setPeakMode(on) {
  if (on && _bounceMode) _setBounceMode(false); // one mode at a time
  _peakMode = !!on;
  localStorage.setItem(_PEAK_KEY, _peakMode ? 'on' : 'off');
  _applyPeakVisibility();
  _stylePeakBtn();
  if (_peakThumbRefresh) _peakThumbRefresh();
  if (_svgW > 0 && _svgH > 0) {
    updateStaticSVG(_svgW, _svgH); // puts the endpoints back in the corners when leaving peak mode
    updateDynamicSVG(getState().curve, _svgW, _svgH);
  }
}

// ─── Bounce mode (graph toolbar #bounce-mode, B key) ──────────────────────
// A toolbar toggle like A-curve. While on, the graph's handles hide, two dots
// sit on the curve (the first hit and the top of the first bounce) and a panel
// of settings opens under the graph (#bounce-panel). Every change builds an
// ordinary multi-point curve (_bnBuild), so baking, presets, copy, Replace and
// undo need nothing new, and neither does the CEP host:
//  - Bounce: hits a hard floor at the end value. The fall and every arc are
//    parabolas, which a cubic segment draws exactly (handles at a third of the
//    way to the quadratic's control point), with corners at each hit. Heights
//    shrink by (1 - Friction) per bounce and each arc lasts sqrt(height), as
//    under gravity, scaled to fill the time after Hit time.
//  - Elastic: springs past the end value and settles. Anchors at the crossing
//    (Hit time) and at every peak and dip, flat handles at the extremes: a
//    flat-to-flat cubic with handles at 0.3645 of the span is within 0.0003 of
//    a half cosine, the quarter sine after the crossing (0.326 / 0.362) within
//    0.0001 (fitted numerically).
//  - In flips the result (bounces at the start instead of the end).
// The settings ride on the curve as curve.bounce (_cloneCurve keeps them), so a
// preset saved in Bounce mode opens again with its sliders. Any other change to
// the curve (a plain preset, a drag outside the mode, paste, numeric entry,
// Invert) leaves no tag, and the state listener turns the mode off; Flip in
// Bounce mode switches Out / In instead. The mode itself is session only (the
// panel opens on the default curve); the settings persist (opencurve-bounce).
// UXP: the sliders are SVG (attribute writes are cheap) and their number labels
// are HTML text, written change-only and at most every
// _BN_TEXT_MS while a drag runs (a text write relayouts the whole panel).
var _BN_KEY    = 'opencurve-bounce';
var _BN_DEF    = { style: 'bounce', dir: 'out', n: 3, bounce: 0.45, over: 0.3, fric: 0.35, hit: 0.4 };
var _BN_RANGE  = { n: [0, 20], bounce: [0, 0.9], over: [0, 0.7], fric: [0, 0.9], hit: [0.05, 0.85] };
var _BN_MIN_W  = 0.015;  // narrowest bounce or half swing kept (anchors must stay PT_MIN_GAP apart)
var _BN_MIN_H  = 0.003;  // lower bounces than this are dropped
var _BN_COS_F  = 0.3645; // flat-to-flat half cosine
var _BN_SIN_B  = 0.326;  // quarter sine: handle along the start slope
var _BN_SIN_C  = 0.362;  //               flat handle at the peak
var _BN_TEXT_MS = 100;
var _bounceMode = false;
var _bnOpts = (function() { try { return _bnClean(JSON.parse(localStorage.getItem(_BN_KEY))); } catch(_) { return null; } })() || _bnClean(_BN_DEF);
var _bnCur  = null;   // the last _bnBuild result (what the dots show)
var _bnDrag = false;  // a slider or graph dot is being dragged (text writes throttle)

function _bnClean(o) {
  if (!o || typeof o !== 'object') return null;
  var r = { style: o.style === 'elastic' ? 'elastic' : 'bounce', dir: o.dir === 'in' ? 'in' : 'out' };
  ['n', 'bounce', 'over', 'fric', 'hit'].forEach(function(k) {
    var v = parseFloat(o[k]);
    if (!isFinite(v)) v = _BN_DEF[k];
    v = Math.max(_BN_RANGE[k][0], Math.min(_BN_RANGE[k][1], v));
    r[k] = k === 'n' ? Math.round(v) : Math.round(v * 1000) / 1000;
  });
  return r;
}
function _bnSig(o) { return o ? [o.style, o.dir, o.n, o.bounce, o.over, o.fric, o.hit].join('|') : ''; }
function _bnHKey(o) { return o.style === 'elastic' ? 'over' : 'bounce'; } // the slider the height dot drives

// Settings -> { curve, hitPt, topPt, minW, used }. hitPt / topPt are the two
// graph dots in curve coordinates (null when there is nothing to drag), minW the
// shortest bounce (or swing) as a fraction of the move, used how many fit.
function _bnBuild(o) {
  var hit = o.hit, r = 1 - o.fric, el = o.style === 'elastic';
  var amp = [], a = el ? o.over : o.bounce, w = [];
  for (var k = 0; k < o.n && a >= _BN_MIN_H; k++) { amp.push(a); a *= r; }
  if (!el) {
    // Arc widths go as sqrt(height); trailing arcs too narrow to keep are dropped
    while (amp.length) {
      var sum = 0;
      for (var s = 0; s < amp.length; s++) sum += Math.sqrt(amp[s]);
      w = amp.map(function(h) { return (1 - hit) * Math.sqrt(h) / sum; });
      if (w[w.length - 1] >= _BN_MIN_W) break;
      amp.pop();
    }
  } else {
    while (amp.length && (1 - hit) / amp.length / 2 < _BN_MIN_W) amp.pop();
  }
  var out = { curve: null, hitPt: null, topPt: null, minW: 0, used: amp.length };
  var c;
  if (!amp.length) {
    c = { p1x: 1 / 3, p1y: 0, p2x: 2 / 3, p2y: 1 / 3 }; // nothing to bounce: the fall alone
  } else if (!el) {
    var pts = [], x = hit, inX = 2 * hit / 3, inY = 1 / 3;
    c = { p1x: hit / 3, p1y: 0, p2x: 0, p2y: 0, pts: pts };
    for (var i = 0; i < amp.length; i++) {
      var hy = 1 - 4 * amp[i] / 3, wi = w[i];
      pts.push({ x: x, y: 1, ix: inX, iy: inY, ox: x + wi / 3, oy: hy, smooth: false });
      inX = x + 2 * wi / 3; inY = hy;
      x += wi;
    }
    c.p2x = inX; c.p2y = inY;
    out.hitPt = { x: hit, y: 1 };
    out.topPt = { x: hit + w[0] / 2, y: 1 - amp[0] };
    out.minW  = w[w.length - 1];
  } else {
    var n = amp.length, T = (1 - hit) / n, q = T / 2;
    var slope = amp[0] * Math.PI / T, d1 = Math.min(hit / 3, 0.8 / slope);
    var ep = [{ x: hit, y: 1, ix: hit - d1, iy: 1 - slope * d1,
                ox: hit + q * _BN_SIN_B, oy: 1 + amp[0] * _BN_SIN_B * Math.PI / 2, smooth: true }];
    for (var j = 0; j < n; j++) {
      var ex = hit + q + j * T, ey = 1 + (j % 2 ? -1 : 1) * amp[j];
      var inL  = j === 0 ? q * _BN_SIN_C : T * _BN_COS_F;
      var outL = j === n - 1 ? q * _BN_COS_F : T * _BN_COS_F;
      ep.push({ x: ex, y: ey, ix: ex - inL, iy: ey, ox: ex + outL, oy: ey, smooth: true });
    }
    c = { p1x: hit / 3, p1y: 0, p2x: 1 - q * _BN_COS_F, p2y: 1, pts: ep };
    out.hitPt = { x: hit, y: 1 };
    out.topPt = { x: hit + q, y: 1 + amp[0] };
    out.minW  = T;
  }
  c = _normalizeCurve(c);
  if (o.dir === 'in') {
    c = _flipCurve(c);
    if (out.hitPt) out.hitPt = { x: 1 - out.hitPt.x, y: 1 - out.hitPt.y };
    if (out.topPt) out.topPt = { x: 1 - out.topPt.x, y: 1 - out.topPt.y };
  }
  c.bounce = _bnClean(o);
  out.curve = c;
  return out;
}

function _bnRedraw(curve) {
  if (_svgW > 0 && _svgH > 0) updateDynamicSVG(curve || getState().curve, _svgW, _svgH);
}
// Build from _bnOpts and show it. live: a drag is running, draw only (the
// state is set once, on release, like a handle drag). animate: tween to it.
function _bnApply(live, animate) {
  _bnCur = _bnBuild(_bnOpts);
  if (live) { _bnRedraw(_bnCur.curve); _bnSyncUI(); return; }
  try { localStorage.setItem(_BN_KEY, JSON.stringify(_bnOpts)); } catch(_) {}
  if (animate) {
    _animateToCurve(_bnCur.curve, function(cur) { _bnRedraw(cur); });
  } else {
    _cancelCurveAnim();
    setState({ curve: _bnCur.curve });
    _autoZoomFor(_bnCur.curve);
    _bnRedraw();
  }
  _bnSyncUI();
}
function _bnSet(changes, live) {
  var o = {};
  for (var k in _bnOpts) o[k] = _bnOpts[k];
  for (var c in changes) o[c] = changes[c];
  o = _bnClean(o);
  if (!live && _bnSig(o) === _bnSig(_bnOpts) && _bnSig(getState().curve.bounce) === _bnSig(o)) { _bnSyncUI(); return; }
  _bnOpts = o;
  _bnApply(live, false);
}

function _styleBounceBtn() {
  var btn = document.getElementById('bounce-mode');
  if (!btn) return;
  _toolStates(btn, _styleBounceBtn);
  _toolPaint(btn, _bounceMode ? '61,220,132' : null, 0.18, '#3ddc84');
  btn.style.opacity = _bounceMode ? '1' : '';
  _stylePeakBtn(); // tints the menu button for either mode while the bar is collapsed
}

function _setBounceMode(on) {
  on = !!on;
  if (on === _bounceMode) return;
  if (on && _peakMode) _setPeakMode(false);
  _bounceMode = on;
  var panel = document.getElementById('bounce-panel');
  var disp = on ? 'flex' : 'none';
  if (panel && panel.style.display !== disp) panel.style.display = disp; // inline: UXP ignores class-driven display
  _applyPeakVisibility();
  _styleBounceBtn();
  if (on) {
    _bnLayout();
    var tag = getState().curve.bounce;
    if (tag) { _bnOpts = _bnClean(tag); _bnCur = _bnBuild(_bnOpts); _bnRedraw(); _bnSyncUI(); }
    else _bnApply(false, true);
  } else {
    _bnRedraw();
  }
}

// State listener: a curve that lost its tag was changed by something else, so
// the mode ends; a tagged curve from elsewhere (a Bounce preset) is adopted.
function _bnOnState(s) {
  if (!_bounceMode) return;
  var tag = s.curve && s.curve.bounce;
  if (!tag) { _setBounceMode(false); return; }
  if (_bnSig(tag) !== _bnSig(_bnOpts)) {
    _bnOpts = _bnClean(tag);
    _bnCur = _bnBuild(_bnOpts);
    _bnRedraw();
  }
  _bnSyncUI();
}

// ── Graph dots ──
function _bnInitSVG() {
  var content = document.getElementById('sg-content'), curve = document.getElementById('sg-curve');
  if (!content || document.getElementById('sg-bn')) return;
  var NS = 'http://www.w3.org/2000/svg';
  var floor = document.createElementNS(NS, 'line');
  floor.setAttribute('id', 'sg-bn-floor');
  floor.setAttribute('stroke', '#ffffff'); floor.setAttribute('stroke-opacity', '0.16');
  floor.setAttribute('stroke-width', '1'); floor.setAttribute('stroke-dasharray', '4,4');
  floor.setAttribute('opacity', '0'); floor.setAttribute('visibility', 'hidden');
  content.insertBefore(floor, curve || null);
  var g = document.createElementNS(NS, 'g');
  g.setAttribute('id', 'sg-bn');
  g.setAttribute('opacity', '0'); g.setAttribute('visibility', 'hidden');
  function dot(id, col) {
    var d = document.createElementNS(NS, 'g');
    d.setAttribute('id', id);
    d.appendChild(_mkCircle(9, 'rgba(' + col + ',0.16)'));
    d.appendChild(_mkCircle(5.5, 'rgb(' + col + ')', '#ffffff', 1.5));
    g.appendChild(d);
    return d;
  }
  dot('sg-bn-hit', '74,158,255');
  dot('sg-bn-top', '240,170,60');
  content.appendChild(g);
}
var _BN_FLOOR_X0 = 36; // the tool column's right edge (5px + 26px) + 5px
function _bnPlaceDots(W, H) {
  var b = _bnCur;
  if (!b) return;
  var f = document.getElementById('sg-bn-floor');
  if (f) {
    var fy = normToSVG(0, _bnOpts.dir === 'in' ? 0 : 1, W, H).cy, b0 = _rangeBox(W, H);
    // It starts right of the tool column down the graph's left side, so it reads
    // as running underneath the buttons rather than showing through their
    // translucent fills: _BN_FLOOR_X0 on screen, mapped back through the zoom
    // (the line lives in the zoomed #sg-content; _updateContentTransform re-places it)
    var x1 = b0.x - b0.s, sideBtn = document.getElementById('bounce-mode');
    if (sideBtn && sideBtn.style.display !== 'none') {
      var o = _zoomOrigin();
      x1 = Math.max(x1, o.x + (_BN_FLOOR_X0 - o.x) / _zoom);
    }
    f.setAttribute('x1', x1); f.setAttribute('x2', b0.x + 2 * b0.s);
    f.setAttribute('y1', fy); f.setAttribute('y2', fy);
  }
  [['sg-bn-hit', b.hitPt], ['sg-bn-top', b.topPt]].forEach(function(pr) {
    var el = document.getElementById(pr[0]);
    if (!el) return;
    if (!pr[1]) { _svgShow(pr[0], false); return; }
    _svgShow(pr[0], true);
    var p = normToSVG(pr[1].x, pr[1].y, W, H);
    el.setAttribute('transform', 'translate(' + p.cx + ',' + p.cy + ')');
  });
}
// The dot nearest a graph point (raw SVG coords at zoom 1); within px, or any visible one when px is null
function _bnDotAt(raw, px) {
  var b = _bnCur, best = null, bd = Infinity;
  if (!b) return null;
  [['hit', b.hitPt], ['top', b.topPt]].forEach(function(pr) {
    if (!pr[1]) return;
    var p = normToSVG(pr[1].x, pr[1].y, _svgW, _svgH), d = Math.hypot(raw.cx - p.cx, raw.cy - p.cy);
    if (d < bd) { bd = d; best = pr[0]; }
  });
  return (px == null || bd <= px) ? best : null;
}
// Drag a dot to normalised (nx, ny): the hit dot sets Hit time, the top dot the
// height (Bounce or Overshoot). In mirrors both, as the curve is flipped.
function _bnDragTo(which, nx, ny, snap) {
  if (_bnOpts.dir === 'in') { nx = 1 - nx; ny = 1 - ny; }
  if (snap) { nx = Math.round(nx * _gridSize) / _gridSize; ny = Math.round(ny * _gridSize) / _gridSize; }
  var ch = {}, r2 = function(v) { return Math.round(v * 100) / 100; }; // whole percents, like the sliders
  if (which === 'hit') ch.hit = r2(nx);
  else if (_bnOpts.style === 'elastic') ch.over = r2(ny - 1);
  else ch.bounce = r2(1 - ny);
  _bnSet(ch, true);
}
// Arrow keys in Bounce mode: left/right move the hit, up/down the height
function _bnNudge(dx, dy) {
  var ch = {}, hk = _bnHKey(_bnOpts), inv = _bnOpts.dir === 'in' ? -1 : 1;
  if (dx) ch.hit = _bnOpts.hit + dx * inv;
  if (dy) ch[hk] = _bnOpts[hk] + dy;
  _bnSet(ch, false);
}

// ── The settings panel ──
var _bnEls = null;
var _BN_SLIDERS = [
  { key: 'n',    label: 'Bounces',  tip: 'How many times it bounces (or swings), up to 20. Bounces too short to draw are left off' },
  { key: 'h',    label: 'Bounce',   tip: 'How high the first bounce goes, as a share of the move. Drag the amber dot on the graph too' },
  { key: 'fric', label: 'Friction', tip: 'How much each bounce loses: higher dies out faster' },
  { key: 'hit',  label: 'Hit time', tip: 'When it first reaches the end value. Drag the blue dot on the graph too' },
];
function _bnInit() {
  var panel = document.getElementById('bounce-panel');
  _bnInitSVG();
  if (!panel || _bnEls) return;
  _bnEls = { seg: {}, sl: {} };
  panel.style.cssText = 'display:none;flex-direction:column;flex-shrink:0;padding:6px 10px 9px 10px;background:#1a1a1a;'; // its own fill, apart from the graph's #111 surround
  var top = document.createElement('div');
  top.style.cssText = 'display:flex;align-items:center;justify-content:space-between;height:28px;margin-bottom:4px;';
  function seg(key, items) {
    var box = document.createElement('div');
    box.style.cssText = 'display:flex;align-items:center;height:24px;padding:2px;border-radius:5px;background-color:#252525;';
    _bnEls.seg[key] = [];
    items.forEach(function(it) {
      var b = document.createElement('div');
      b.textContent = it[1];
      b.style.cssText = 'display:flex;align-items:center;justify-content:center;height:20px;padding:0 10px;border-radius:4px;font-size:12px;cursor:pointer;color:#9a9a9a;';
      b._ocVal = it[0];
      b.addEventListener('mouseenter', function() { b._ocHov = true; _bnPaintSeg(key); });
      b.addEventListener('mouseleave', function() { b._ocHov = false; _bnPaintSeg(key); });
      b.addEventListener('click', function() { var ch = {}; ch[key] = it[0]; _bnSet(ch, false); });
      if (it[2]) _attachTooltip(b, it[2]);
      box.appendChild(b);
      _bnEls.seg[key].push(b);
    });
    return box;
  }
  top.appendChild(seg('style', [['bounce', 'Bounce', 'Hits a hard floor at the end value and bounces back'],
                                ['elastic', 'Elastic', 'Springs past the end value and settles']]));
  top.appendChild(seg('dir', [['out', 'Out', 'Bounce at the end of the move'],
                              ['in', 'In', 'Bounce at the start of the move (F switches too)']]));
  panel.appendChild(top);
  var wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-wrap:wrap;';
  _BN_SLIDERS.forEach(function(def) {
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;height:26px;width:100%;';
    var lb = document.createElement('div');
    lb.textContent = def.label;
    lb.style.cssText = 'flex-shrink:0;width:66px;font-size:12px;color:#9a9a9a;white-space:nowrap;overflow:hidden;';
    _attachTooltip(lb, function() { return def.key === 'h' && _bnOpts.style === 'elastic' ? 'How far the first swing goes past the end value, as a share of the move. Drag the amber dot on the graph too' : def.tip; });
    var sv = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    sv.style.cssText = 'display:block;flex-shrink:0;width:100px;height:22px;cursor:pointer;touch-action:none;'; // width: _bnLayout
    var NS = 'http://www.w3.org/2000/svg';
    var track = document.createElementNS(NS, 'rect'), fill = document.createElementNS(NS, 'rect');
    [track, fill].forEach(function(r) { r.setAttribute('y', '9.5'); r.setAttribute('height', '3'); r.setAttribute('rx', '1.5'); sv.appendChild(r); });
    track.setAttribute('fill', '#313131');
    fill.setAttribute('fill', '#6f6f6f');
    var thumb = _mkCircle(6, '#d8d8d8');
    thumb.setAttribute('cy', '11');
    sv.appendChild(thumb);
    var val = document.createElement('div');
    val.style.cssText = 'flex-shrink:0;width:38px;text-align:right;font-size:12px;color:#d4d4d4;white-space:nowrap;cursor:text;';
    // Click the number to type one (_bnTypeValue); hover brightens it
    val.addEventListener('mouseenter', function() { val.style.color = '#ffffff'; });
    val.addEventListener('mouseleave', function() { val.style.color = '#d4d4d4'; });
    val.addEventListener('click', function() { _bnTypeValue(def); });
    _attachTooltip(val, 'Click to type a value');
    row.appendChild(lb); row.appendChild(sv); row.appendChild(val);
    wrap.appendChild(row);
    var el = { row: row, lb: lb, sv: sv, track: track, fill: fill, thumb: thumb, val: val, w: 0, def: def };
    _bnEls.sl[def.key] = el;
    _bnWireSlider(el);
  });
  panel.appendChild(wrap);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(function() { _bnLayout(); }).observe(panel);
}
function _bnKeyOf(def) { return def.key === 'h' ? _bnHKey(_bnOpts) : def.key; }
// Number entry for one slider, in the rename dialog (a modal, so the key sink
// and the panel shortcuts stay out of the way). Percent sliders take a percent
// ("45", "45%", "12.5"); out-of-range values are clamped by _bnClean.
function _bnTypeValue(def) {
  var k = _bnKeyOf(def), r = _BN_RANGE[k], pct = k !== 'n';
  var title = def.key === 'h' ? (_bnOpts.style === 'elastic' ? 'Overshoot' : 'Bounce') : def.label;
  var cur = pct ? String(Math.round(_bnOpts[k] * 1000) / 10) : String(_bnOpts[k]);
  var hint = pct ? 'Percent, ' + Math.round(r[0] * 100) + ' to ' + Math.round(r[1] * 100)
                 : 'Whole number, ' + r[0] + ' to ' + r[1];
  _renamePresetDialog(cur, function(v) {
    var num = parseFloat(String(v).replace('%', '').replace(',', '.'));
    if (!isFinite(num)) { _showCopyToast('Enter a number'); return; }
    var ch = {};
    ch[k] = pct ? num / 100 : num;
    _bnSet(ch, false);
  }, { title: title, ok: 'Set', hint: hint });
}
// Slider value as shown: a count, or a percent with one decimal when it has one
function _bnFmt(k, v) { return k === 'n' ? String(v) : (Math.round(v * 1000) / 10) + '%'; }
function _bnWireSlider(el) {
  var dragging = false, rect = null;
  function valAt(e) {
    var r = _BN_RANGE[_bnKeyOf(el.def)], pad = 7, w = Math.max(1, rect.width - 2 * pad); // rect: measured once, at the press
    var f = Math.max(0, Math.min(1, (e.clientX - rect.left - pad) / w));
    var v = r[0] + f * (r[1] - r[0]);
    return _bnKeyOf(el.def) === 'n' ? v : Math.round(v * 100) / 100; // drags land on whole percents; typed values may carry a decimal
  }
  function set(e, live) { var ch = {}; ch[_bnKeyOf(el.def)] = valAt(e); _bnSet(ch, live); }
  el.sv.addEventListener('pointerdown', function(e) {
    if (e.button !== 0) return;
    dragging = true; _bnDrag = true;
    rect = el.sv.getBoundingClientRect();
    try { el.sv.setPointerCapture(e.pointerId); } catch(_) {}
    e.preventDefault();
    set(e, true);
  });
  el.sv.addEventListener('pointermove', function(e) { if (dragging) set(e, true); });
  function end(e) {
    if (!dragging) return;
    dragging = false; _bnDrag = false;
    try { el.sv.releasePointerCapture(e.pointerId); } catch(_) {}
    _bnSet({}, false); // commit what the drag left
  }
  el.sv.addEventListener('pointerup', end);
  el.sv.addEventListener('pointercancel', end);
  el.sv.addEventListener('mouseenter', function() { el.thumb.setAttribute('fill', '#ffffff'); });
  el.sv.addEventListener('mouseleave', function() { el.thumb.setAttribute('fill', '#d8d8d8'); });
}
// One column below 400px, two from there (Bounces | Bounce, Friction | Hit time).
// Pixel widths, written only when the panel's width changes (no calc() or flex
// order, which UXP may not honour); the sliders' SVG widths are set here too,
// so a drag never has to measure anything.
var _bnLayW = -1;
function _bnLayout() {
  var panel = document.getElementById('bounce-panel');
  if (!panel || !_bnEls || !_bounceMode) return;
  var w = panel.clientWidth;
  if (!(w > 0)) return;
  if (w !== _bnLayW) {
    _bnLayW = w;
    var inner = w - 20, cols = inner >= 380 ? 2 : 1; // 10px padding each side
    var rw = cols === 2 ? Math.floor((inner - 16) / 2) : inner, sw = Math.max(40, rw - 66 - 38);
    _BN_SLIDERS.forEach(function(def, i) {
      var el = _bnEls.sl[def.key];
      el.row.style.width = rw + 'px';
      el.row.style.marginRight = cols === 2 && i % 2 === 0 ? '16px' : '0px';
      el.sv.style.width = sw + 'px';
      el.w = sw;
      el.sv.setAttribute('viewBox', '0 0 ' + sw + ' 22');
      el.track.setAttribute('x', '7'); el.track.setAttribute('width', String(Math.max(0, sw - 14)));
      el.fill.setAttribute('x', '7');
      el._ocX = null;
    });
  }
  _bnSyncUI(true);
}
function _bnPaintSeg(key) {
  (_bnEls && _bnEls.seg[key] || []).forEach(function(b) {
    var on = _bnOpts[key] === b._ocVal;
    var bg = on ? '#3d3d3d' : b._ocHov ? '#2f2f2f' : 'transparent', col = on ? '#ffffff' : b._ocHov ? '#d4d4d4' : '#9a9a9a';
    if (b._ocBg !== bg) { b._ocBg = bg; b.style.backgroundColor = bg; }
    if (b._ocCol !== col) { b._ocCol = col; b.style.color = col; }
  });
}
// Text writes (the number labels): change-only, and at most every _BN_TEXT_MS while dragging
var _bnTextQ = {}, _bnTextAt = 0, _bnTextTimer = null;
function _bnText(id, el, txt, col) {
  _bnTextQ[id] = { el: el, txt: txt, col: col };
  var now = Date.now();
  if (!_bnDrag || now - _bnTextAt >= _BN_TEXT_MS) { _bnTextFlush(); return; }
  if (!_bnTextTimer) _bnTextTimer = setTimeout(_bnTextFlush, _BN_TEXT_MS - (now - _bnTextAt));
}
function _bnTextFlush() {
  if (_bnTextTimer) { clearTimeout(_bnTextTimer); _bnTextTimer = null; }
  _bnTextAt = Date.now();
  for (var id in _bnTextQ) {
    var q = _bnTextQ[id];
    if (q.el._ocTxt !== q.txt) { q.el._ocTxt = q.txt; q.el.textContent = q.txt; }
    if (q.col && q.el._ocCol !== q.col) { q.el._ocCol = q.col; q.el.style.color = q.col; }
  }
  _bnTextQ = {};
}
function _bnSyncUI(force) {
  if (!_bnEls || !_bounceMode) return;
  if (!_bnCur) _bnCur = _bnBuild(_bnOpts);
  ['style', 'dir'].forEach(_bnPaintSeg);
  _BN_SLIDERS.forEach(function(def) {
    var el = _bnEls.sl[def.key], k = _bnKeyOf(def), r = _BN_RANGE[k], v = _bnOpts[k];
    if (el.w > 0) {
      var x = 7 + (v - r[0]) / (r[1] - r[0]) * Math.max(0, el.w - 14);
      if (el._ocX !== x) { el._ocX = x; el.thumb.setAttribute('cx', String(x)); el.fill.setAttribute('width', String(Math.max(0, x - 7))); }
    }
    _bnText('v' + def.key, el.val, _bnFmt(k, v));
    if (def.key === 'h') _bnText('lh', el.lb, _bnOpts.style === 'elastic' ? 'Overshoot' : 'Bounce');
  });
}

// ─── Constants ────────────────────────────────────────────────────────────

var DONE_DISPLAY_MS     = 1000;
var ERROR_DISPLAY_MS    = 3000;
var HIT_TOLERANCE       = 6;
var Y_CLAMP_MIN         = -1.0;
var Y_CLAMP_MAX         =  2.0;

// ─── SVG graph editor ─────────────────────────────────────────────────────
var PAD = 16, HANDLE_R = 5;
var _zoom = 1.0;
// Height the content scales about, in curve units: 0.5 is the range box's
// centre (= the SVG's), 0 its bottom edge, 1 its top. Auto zoom moves it so a
// curve past the top grows the graph upward only (the box's bottom stays put),
// and the reverse; resize-proof because it is relative to the box.
var _zoomOY = 0.5;
function _zoomOrigin() {
  var b = _rangeBox(_svgW, _svgH);
  return { x: _svgW / 2, y: b.y + (1 - _zoomOY) * b.s };
}
var _zoomPopHide = null; // set by initPanel: closes the zoom slider, true if it was open (Esc)
var _closeMenus  = null; // set by initPanel: closes the tile / mini context menus, true if one was open

// The 0..1 range box is always square (1:1), the largest that fits inside the
// pad, centred in the SVG; the rest of the SVG is the outer area (overshoot
// handles, zoomed-out content). It used to stretch to the SVG's own aspect,
// which squashed every curve in a wide or tall panel.
// _RANGE_GUTTER: the box keeps clear of the tool column and zoom button down
// the graph area's left side (5px + 26px buttons + 17px air = 48px = PAD + 32).
// Centred while the SVG is wide enough; otherwise it shrinks by the gutter and
// sits against it, so the buttons never cover the curve's start or a handle there.
var _RANGE_GUTTER = 32;
function _rangeBox(W, H) {
  var s = Math.max(1, Math.min(W - _RANGE_GUTTER, H) - 2 * PAD);
  return { x: Math.max(PAD + _RANGE_GUTTER, (W - s) / 2), y: (H - s) / 2, s: s };
}
function normToSVG(nx, ny, W, H) {
  var b = _rangeBox(W, H);
  return {
    cx: b.x + nx * b.s,
    cy: b.y + (1 - ny) * b.s,
  };
}
function svgToNorm(cx, cy, W, H) {
  var b = _rangeBox(W, H);
  return {
    nx: (cx - b.x) / b.s,
    ny: 1 - (cy - b.y) / b.s,
  };
}

function _unscale(cx, cy) {
  var o = _zoomOrigin();
  return {
    cx: o.x + (cx - o.x) / _zoom,
    cy: o.y + (cy - o.y) / _zoom,
  };
}

function _updateContentTransform() {
  var g = document.getElementById('sg-content');
  if (!g || !_svgW || !_svgH) return;
  var o = _zoomOrigin(), cx = o.x, cy = o.y;
  g.setAttribute('transform',
    'translate(' + cx + ',' + cy + ') scale(' + _zoom + ') translate(' + (-cx) + ',' + (-cy) + ')');
  if (_bounceMode) _bnPlaceDots(_svgW, _svgH); // the floor line's left end follows the zoom
}

// ─── Auto zoom (2.1.0) ────────────────────────────────────────────────────
// A curve put on the graph through _animateToCurve (a preset click, Flip,
// Invert, a row's Load Baked Curve) that goes past the range box makes the
// graph zoom out just enough to show the whole curve (the curve, not its
// handles), easing alongside the curve tween. A later curve that fits zooms
// back to the level the user had. A manual zoom takes over: auto zoom never
// goes past the user's own level and forgets what it was restoring.
// It zooms about the edge the curve stays inside (_zoomOY): a curve past the
// top keeps the range box's bottom edge where it was and opens up above, one
// past the bottom the reverse; only a curve past both fits itself between the
// margins. (It zoomed about the centre until 2.1.0's Bounce mode, which moved
// the whole box for an Elastic overshoot.)
// Settings > Auto Zoom (opencurve-auto-zoom, on by default) turns it off.
var _AUTO_ZOOM_KEY    = 'opencurve-auto-zoom';
var _autoZoomOn       = (function() { try { return localStorage.getItem(_AUTO_ZOOM_KEY) !== 'off'; } catch(_) { return true; } })();
var _autoZoomFrom     = null;  // the user's own zoom while auto zoom has moved it, else null
var _autoZoomFromOY   = 0.5;   // and the origin it had (_zoomOY)
var _zoomAnimRaf      = null;
var _AUTO_ZOOM_MIN    = 0.25;  // same floor as the zoom slider
var _AUTO_ZOOM_MARGIN = 8;     // px kept clear between the curve and the graph's edge
var _AUTO_ZOOM_MS     = 200;
// The zoom, and the origin to zoom about, that just fit the curve's lowest and
// highest point inside the SVG: { z, oy }, z 1 when it already fits
function _zoomToFit(c) {
  var none = { z: 1, oy: 0.5 };
  if (!c || !_svgW || !_svgH || _peakMode) return none; // the A-curve bell always fits
  var lo = 0, hi = 1, N = 128, segs = _hasPts(c) ? _segsOf(c) : null;
  for (var i = 1; i < N; i++) {
    var y = sampleBezier(i / N, c, segs);
    if (y < lo) lo = y;
    if (y > hi) hi = y;
  }
  var box = _rangeBox(_svgW, _svgH), m = _AUTO_ZOOM_MARGIN, H = _svgH;
  var yT = box.y, yB = box.y + box.s; // the range box's top and bottom edges
  var yTop = box.y + (1 - hi) * box.s, yBot = box.y + (1 - lo) * box.s;
  var over = yTop < m, under = yBot > H - m, z, oy;
  if (!over && !under) return none;
  if (over && !under)      { z = (yB - m) / (yB - yTop);     oy = 0; } // past the top: the bottom edge stays
  else if (under && !over) { z = (H - m - yT) / (yBot - yT); oy = 1; } // past the bottom: the top edge stays
  else {
    // Past both: fit between the margins (origin o where z*yTop + o*(1-z) = m)
    z = (H - 2 * m) / (yBot - yTop);
    var o = z < 1 ? (m - z * yTop) / (1 - z) : H / 2;
    oy = 1 - (o - box.y) / box.s;
  }
  z = Math.max(_AUTO_ZOOM_MIN, Math.min(1, z));
  return { z: z, oy: oy };
}
function _cancelZoomAnim() {
  if (_zoomAnimRaf) { cancelAnimationFrame(_zoomAnimRaf); _zoomAnimRaf = null; }
}
// Ease the zoom to z about origin oy (default: the current one; straight there
// while the graph is hidden). At zoom 1 the origin changes nothing, so leaving 1
// starts at the target's origin and returning to 1 keeps the current one for
// the ease: the edge being held stays still the whole way.
function _zoomAnimTo(z, oy) {
  _cancelZoomAnim();
  if (oy == null) oy = _zoomOY;
  var from = _zoom, fromO = Math.abs(1 - from) < 1e-4 ? oy : _zoomOY;
  var toO = Math.abs(1 - z) < 1e-4 ? fromO : oy;
  if (!_graphVisible || (Math.abs(z - from) < 1e-4 && Math.abs(toO - fromO) < 1e-4)) {
    _zoom = z; _zoomOY = oy; _updateContentTransform(); return;
  }
  var start = null;
  function ease(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function step(ts) {
    if (start === null) start = ts;
    var p = Math.min((ts - start) / _AUTO_ZOOM_MS, 1), e = ease(p);
    _zoom   = from + (z - from) * e;
    _zoomOY = p < 1 ? fromO + (toO - fromO) * e : oy;
    _updateContentTransform();
    _zoomAnimRaf = p < 1 ? requestAnimationFrame(step) : null;
  }
  _zoomAnimRaf = requestAnimationFrame(step);
}
function _autoZoomFor(c) {
  if (!_autoZoomOn) return;
  var base = _autoZoomFrom !== null ? _autoZoomFrom : _zoom; // the user's own level
  var baseO = _autoZoomFrom !== null ? _autoZoomFromOY : _zoomOY;
  var fit = _zoomToFit(c), want, wantO;
  if (fit.z < base - 1e-4) {
    if (_autoZoomFrom === null) { _autoZoomFrom = _zoom; _autoZoomFromOY = _zoomOY; }
    want = fit.z; wantO = fit.oy;
  } else {
    _autoZoomFrom = null;
    want = base; wantO = baseO;
  }
  if (Math.abs(want - _zoom) > 1e-4 || Math.abs(wantO - _zoomOY) > 1e-4) _zoomAnimTo(want, wantO);
}

// The graph's SVG children are built once and then only repositioned, but the
// drag hot path looked each one up by id on every frame. A cached node that has
// left the document (the grid is rebuilt when its size changes) is re-fetched,
// so the cache needs no explicit invalidation.
var _ocEls = {};
function _ocEl(id) {
  var el = _ocEls[id];
  if (el && el.parentNode) return el;
  el = document.getElementById(id);
  _ocEls[id] = el;
  return el;
}

function _setLine(id, x1, y1, x2, y2) {
  var el = _ocEl(id);
  if (!el) return;
  el.setAttribute('x1', x1); el.setAttribute('y1', y1);
  el.setAttribute('x2', x2); el.setAttribute('y2', y2);
}

var _svgW = 0, _svgH = 0;

function _makeLine(id, stroke) {
  var el = document.getElementById(id);
  if (!el) {
    el = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    el.setAttribute('id', id);
    var g = document.getElementById('sg-grid');
    if (g) g.appendChild(el);
  }
  if (stroke) el.setAttribute('stroke', stroke);
  return el;
}

function updateStaticSVG(W, H) {
  if (!_graphVisible) { _graphDirty = true; return; }
  var bg = document.getElementById('sg-bg');
  if (bg) { bg.setAttribute('width', W); bg.setAttribute('height', H); }

  var ds = normToSVG(0, 0, W, H), de = normToSVG(1, 1, W, H);
  var rx = ds.cx, ry = de.cy, rw = de.cx - ds.cx, rh = ds.cy - de.cy;
  var rangeBg = document.getElementById('sg-range-bg');
  if (rangeBg) {
    rangeBg.setAttribute('x', rx); rangeBg.setAttribute('y', ry);
    rangeBg.setAttribute('width', rw); rangeBg.setAttribute('height', rh);
  }
  var rangeOutline = document.getElementById('sg-range-outline');
  if (rangeOutline) {
    rangeOutline.setAttribute('x', rx); rangeOutline.setAttribute('y', ry);
    rangeOutline.setAttribute('width', rw); rangeOutline.setAttribute('height', rh);
  }

  var gridGroup = document.getElementById('sg-grid');
  if (gridGroup) while (gridGroup.firstChild) gridGroup.removeChild(gridGroup.firstChild);
  for (var j = 1; j < _gridSize; j++) {
    var yc = normToSVG(0, j/_gridSize, W, H).cy;
    var lh = _makeLine('sg-gh'+j);
    lh.setAttribute('stroke', '#ffffff');
    lh.setAttribute('stroke-opacity', '0.055');
    _setLine('sg-gh'+j, rx, yc, rx + rw, yc);
  }
  for (var i = 1; i < _gridSize; i++) {
    var xc = normToSVG(i/_gridSize, 0, W, H).cx;
    var lv = _makeLine('sg-gv'+i);
    lv.setAttribute('stroke', '#ffffff');
    lv.setAttribute('stroke-opacity', '0.055');
    _setLine('sg-gv'+i, xc, ry, xc, ry + rh);
  }

  _setLine('sg-diag', ds.cx, ds.cy, de.cx, de.cy);
  // Peak mode owns the endpoints (they sit on the bell's feet); a static redraw
  // such as a grid-size change must not drop them back into the corners.
  if (!_peakMode) {
    var ep0 = document.getElementById('sg-ep0');
    if (ep0) { ep0.setAttribute('cx', ds.cx); ep0.setAttribute('cy', ds.cy); }
    var ep3 = document.getElementById('sg-ep3');
    if (ep3) { ep3.setAttribute('cx', de.cx); ep3.setAttribute('cy', de.cy); }
  }
}

// Drag ghost: while a handle, anchor or peak drag is in progress, the curve as it
// was at press time stays behind in a faded theme colour so the change is visible.
// Draws the bell in A-curve mode and the bezier otherwise, matching what is on screen.
function _showDragGhost(curve, W, H) {
  var g = document.getElementById('sg-drag-ghost');
  if (!g || !_dragGhost) return;
  var d = _peakMode
    ? _peakBellPath(curve, 96,
        function(x) { return normToSVG(x, 0, W, H).cx; },
        function(y) { return normToSVG(0, y, W, H).cy; })
    : _curvePathD(curve, W, H);
  g.setAttribute('d', d);
  g.setAttribute('stroke', _curveColor || '#ffffff');
  _svgShow('sg-drag-ghost', true);
}
function _hideDragGhost() { _svgShow('sg-drag-ghost', false); }

function _styleGhostBtn() {
  var btn = document.getElementById('drag-ghost');
  if (!btn) return;
  btn.style.backgroundColor = _dragGhost ? 'rgba(61,220,132,0.18)' : '';
  btn.style.color      = _dragGhost ? '#3ddc84' : '';
  btn.style.opacity    = _dragGhost ? '1' : '';
}
// Preset toolbar List/Grid button: shows the view a press switches to
function _styleLayoutBtn() {
  var btn = document.getElementById('preset-layout');
  if (!btn) return;
  var g = btn.querySelector('.ic-grid'), l = btn.querySelector('.ic-list');
  if (g) g.style.display = _presetLayout === 'list' ? '' : 'none';
  if (l) l.style.display = _presetLayout === 'list' ? 'none' : '';
}
function _setDragGhost(on) {
  _dragGhost = !!on;
  localStorage.setItem(_DRAG_GHOST_KEY, _dragGhost ? 'on' : 'off');
  if (!_dragGhost) _hideDragGhost();
  _styleGhostBtn();
}
// Preset toolbar Graph / Timeline toggles: the same switches as Settings, tinted
// green while the region is shown, like the A-curve and Ghost buttons
function _styleViewBtns() {
  [['toggle-graph', _graphVisible], ['toggle-timeline', _tlVisible]].forEach(function(pair) {
    var btn = document.getElementById(pair[0]);
    if (!btn) return;
    // Hover and press: the inline tint below beats the stylesheet's :hover, so
    // the button tracks them itself and they deepen the tint (white while held)
    if (!btn._ocViewWired) {
      btn._ocViewWired = true;
      btn.addEventListener('mouseenter', function() { btn._ocHov = true; _styleViewBtns(); });
      btn.addEventListener('mouseleave', function() { btn._ocHov = false; btn._ocDown = false; _styleViewBtns(); });
      btn.addEventListener('pointerdown', function() { btn._ocDown = true; _styleViewBtns(); });
      btn.addEventListener('pointerup', function() { if (btn._ocDown) { btn._ocDown = false; _styleViewBtns(); } });
      btn.addEventListener('pointercancel', function() { if (btn._ocDown) { btn._ocDown = false; _styleViewBtns(); } });
    }
    // Green while the region is shown, red while it is hidden (the Settings rows use the same pair)
    var a = btn._ocDown ? 0.5 : btn._ocHov ? 0.32 : 0.18;
    var bg = pair[1] ? 'rgba(61,220,132,' + a + ')' : 'rgba(255,144,144,' + a + ')';
    var col = btn._ocDown ? '#ffffff' : pair[1] ? '#3ddc84' : '#ff9090', op = '1';
    // write only on change: UXP relayouts on every style write. Compared with the last
    // write, not a read-back (a host may hand the colour back reformatted)
    if (btn._ocBg !== bg) { btn._ocBg = bg; btn.style.backgroundColor = bg; }
    if (btn.style.color !== col) btn.style.color = col;
    if (btn.style.opacity !== op) btn.style.opacity = op;
  });
}
function _setGraphVisible(on) {
  _graphVisible = !!on;
  localStorage.setItem(_GRAPH_KEY, _graphVisible ? 'on' : 'off');
  _applyGraphVisibility();
  _styleViewBtns();
}
function _setTimelineVisible(on) {
  _tlVisible = !!on;
  localStorage.setItem(_TL_KEY, _tlVisible ? 'on' : 'off');
  _applyTimelineVisibility();
  _styleViewBtns();
}

function updateDynamicSVG(curve, W, H) {
  if (!_graphVisible) { _graphDirty = true; return; }
  if (_peakMode) { _updatePeakSVG(curve, W, H); return; }
  var hc = _animVis || curve; // handles and points; the path always follows curve
  var p0 = normToSVG(0, 0, W, H);
  var p1 = normToSVG(hc.p1x, hc.p1y, W, H);
  var p2 = normToSVG(hc.p2x, hc.p2y, W, H);
  var p3 = normToSVG(1, 1, W, H);
  _setLine('sg-tan1', p0.cx, p0.cy, p1.cx, p1.cy);
  _setLine('sg-tan2', p3.cx, p3.cy, p2.cx, p2.cy);
  var cp = _ocEl('sg-curve');
  if (cp) cp.setAttribute('d', _curvePathD(curve, W, H));
  var h1 = _ocEl('sg-h1');
  if (h1) h1.setAttribute('transform', 'translate('+p1.cx+','+p1.cy+')');
  var h2 = _ocEl('sg-h2');
  if (h2) h2.setAttribute('transform', 'translate('+p2.cx+','+p2.cy+')');
  _updatePtsSVG(hc, W, H);
  if (_bounceMode) _bnPlaceDots(W, H);
}

function initGraphEditor(svg) {
  var dragging  = null;
  var liveCurve = null;
  var dragRect  = null;
  var dragMoved = false; // a pointermove actually changed the curve this drag

  // Every inline style write relayouts the panel in UXP, and a hover fires many
  // pointermoves a second, so the cursor is written only when it changes.
  var _curCursor = '';
  function setCursor(v) { if (_curCursor !== v) { _curCursor = v; svg.style.cursor = v; } }

  // rect and curve are optional: the hover path measures and clones once per
  // move and passes them in, instead of each helper doing its own.
  function hitTest(e, rect, curve) {
    if (_peakMode || _bounceMode) return null;
    rect = rect || dragRect || svg.getBoundingClientRect();
    var raw  = _unscale(e.clientX - rect.left, e.clientY - rect.top);
    var c    = curve || liveCurve || getState().curve;
    var R    = HANDLE_R + HIT_TOLERANCE;
    function near(d, r) {
      var hp = _handlePos(c, d), sp = normToSVG(hp.x, hp.y, _svgW, _svgH);
      return Math.hypot(raw.cx - sp.cx, raw.cy - sp.cy) <= r;
    }
    if (near({ k: 'p1' }, R)) return { k: 'p1' };
    if (near({ k: 'p2' }, R)) return { k: 'p2' };
    var pts = c.pts || [];
    for (var i = 0; i < pts.length; i++) {
      if (near({ k: 'in',  i: i }, R)) return { k: 'in',  i: i };
      if (near({ k: 'out', i: i }, R)) return { k: 'out', i: i };
    }
    for (var j = 0; j < pts.length; j++) if (near({ k: 'a', i: j }, R + 3)) return { k: 'a', i: j };
    return null;
  }
  _graphHitTest = hitTest;

  svg.addEventListener('pointerdown', function(e) {
    if (e.button !== 0) return;
    _cancelCurveAnim(); // settle on the target first: never drag a tween intermediate
    _showDragGhost(getState().curve, _svgW, _svgH); // before any snap moves the curve
    if (_bounceMode) {
      // Bounce mode: drag the dot under the pointer; a press elsewhere brings the nearest one there
      var bRect = svg.getBoundingClientRect();
      var bRaw  = _unscale(e.clientX - bRect.left, e.clientY - bRect.top);
      var which = _bnDotAt(bRaw, null);
      if (!which) { _hideDragGhost(); return; }
      svg.setPointerCapture(e.pointerId);
      dragging    = 'bn-' + which;
      dragMoved   = false;
      dragRect    = bRect;
      _isDragging = true;
      _bnDrag     = true;
      e.preventDefault();
      setCursor('grabbing');
      if (!_bnDotAt(bRaw, HANDLE_R + HIT_TOLERANCE + 4)) _applyBnPointer(e);
      return;
    }
    if (_peakMode) {
      // The peak solver only produces a single-segment cubic, so a curve with
      // added points can't be shaped here; refuse rather than flatten it
      if ((getState().curve.pts || []).length) {
        _hideDragGhost();
        return;
      }
      // Peak mode: the pointer is the peak, wherever you press
      svg.setPointerCapture(e.pointerId);
      dragging    = 'peak';
      dragMoved   = true; // the press itself reshapes the curve in peak mode
      liveCurve   = _cloneCurve(getState().curve);
      dragRect    = svg.getBoundingClientRect();
      _isDragging = true;
      e.preventDefault();
      setCursor('grabbing');
      _applyPeakPointer(e);
      return;
    }
    var hit = hitTest(e);
    if (!hit) {
      // Snap the closest handle (never an anchor) to the click position
      var rect = svg.getBoundingClientRect();
      var raw  = _unscale(e.clientX - rect.left, e.clientY - rect.top);
      var c    = _cloneCurve(getState().curve);
      delete c.bounce; // hand-edited
      var cands = [{ k: 'p1' }, { k: 'p2' }];
      for (var pi = 0; pi < (c.pts || []).length; pi++) { cands.push({ k: 'in', i: pi }); cands.push({ k: 'out', i: pi }); }
      var best = null, bestD = Infinity;
      for (var ci = 0; ci < cands.length; ci++) {
        var hp = _handlePos(c, cands[ci]), sp = normToSVG(hp.x, hp.y, _svgW, _svgH);
        var dd = Math.hypot(raw.cx - sp.cx, raw.cy - sp.cy);
        if (dd < bestD) { bestD = dd; best = cands[ci]; }
      }
      hit = best;
      var n  = svgToNorm(raw.cx, raw.cy, _svgW, _svgH);
      _setHandle(c, hit, Math.max(0, Math.min(1, n.nx)), n.ny, e.altKey, e.ctrlKey || e.metaKey);
      setState({ curve: c });
      updateDynamicSVG(getState().curve, _svgW, _svgH);
    }
    svg.setPointerCapture(e.pointerId);
    dragging    = hit;
    _lastHandle = hit; // arrow keys nudge this one
    liveCurve   = _cloneCurve(getState().curve);
    dragRect    = svg.getBoundingClientRect();
    _isDragging = true;
    e.preventDefault();
    setCursor('grabbing');
  });

  // The hover / drag readout (#graph-coords) was taken out of cep/index.html in
  // 2.1.0 to match the UXP edition, so this is null and every write below is skipped
  var _coordsEl = document.getElementById('graph-coords');

  svg.addEventListener('pointerleave', function() {
    if (_coordsEl && !dragging) _coordsEl.textContent = '';
  });

  function _showCoords(nx, ny) {
    if (_coordsEl) _coordsEl.textContent = nx.toFixed(3) + ',  ' + ny.toFixed(3);
  }

  svg.addEventListener('pointermove', function(e) {
    if (dragging === 'peak') { _applyPeakPointer(e); return; }
    if (dragging === 'bn-hit' || dragging === 'bn-top') { _applyBnPointer(e); return; }
    if (dragging) {
      // coords updated in hot path below
    } else {
      // One rect read and one state clone for the whole move: this ran
      // getBoundingClientRect twice and cloned the curve twice per pointermove.
      var rectH = svg.getBoundingClientRect();
      if (_peakMode) {
        setCursor('crosshair');
        var rp = _unscale(e.clientX - rectH.left, e.clientY - rectH.top);
        var np = svgToNorm(rp.cx, rp.cy, _svgW, _svgH);
        var hx = Math.max(0, Math.min(1, np.nx)), hy = Math.max(0, Math.min(1, np.ny));
        var hp = _peakOf(_solvePeak(hx, hy), 48);
        _showPeakCoords(hp.v <= 1.02 ? hx : hp.x, hp.v);
        return;
      }
      if (_bounceMode) {
        var hw = _bnDotAt(_unscale(e.clientX - rectH.left, e.clientY - rectH.top), HANDLE_R + HIT_TOLERANCE + 4);
        setCursor(hw === 'hit' ? 'ew-resize' : hw === 'top' ? 'ns-resize' : 'pointer');
        return;
      }
      var curveH = liveCurve || getState().curve;
      var hit = hitTest(e, rectH, curveH);
      setCursor(hit ? 'grab' : 'crosshair');
      if (hit) {
        var hp0 = _handlePos(curveH, hit);
        _showCoords(hp0.x, hp0.y);
      } else {
        var rc = _unscale(e.clientX - rectH.left, e.clientY - rectH.top);
        var nc = svgToNorm(rc.cx, rc.cy, _svgW, _svgH);
        _showCoords(nc.nx, nc.ny);
      }
      return;
    }
    dragMoved = true;
    var raw = _unscale(e.clientX - dragRect.left, e.clientY - dragRect.top);
    var n   = svgToNorm(raw.cx, raw.cy, _svgW, _svgH);
    var x   = Math.max(0,    Math.min(1,   n.nx));
    var y   = Math.max(Y_CLAMP_MIN, Math.min(Y_CLAMP_MAX, n.ny));
    if (e.shiftKey) { x = Math.round(x * _gridSize) / _gridSize; y = Math.round(y * _gridSize) / _gridSize; }
    _setHandle(liveCurve, dragging, x, y, e.altKey, e.ctrlKey || e.metaKey);
    var lp = _handlePos(liveCurve, dragging);
    _setSnapBg(e.shiftKey);
    _showCoords(lp.x, lp.y);
    updateDynamicSVG(liveCurve, _svgW, _svgH);
  });

  // Peak mode readout: peak position and how many times faster than linear it is
  function _showPeakCoords(nx, v) {
    if (_coordsEl) _coordsEl.textContent = nx.toFixed(3) + ',  ' + v.toFixed(2) + '\u00d7';
  }

  // Bounce mode drag: the hit dot sets Hit time, the top dot the height (see _bnDragTo)
  function _applyBnPointer(e) {
    dragMoved = true;
    var rect = dragRect || svg.getBoundingClientRect();
    var raw  = _unscale(e.clientX - rect.left, e.clientY - rect.top);
    var n    = svgToNorm(raw.cx, raw.cy, _svgW, _svgH);
    _bnDragTo(dragging === 'bn-hit' ? 'hit' : 'top', n.nx, n.ny, e.shiftKey);
    _setSnapBg(e.shiftKey);
  }

  // Peak mode drag: pointer x = where the peak sits, pointer height = how narrow the bell is.
  // Shift snaps the peak to the grid, same as the handles.
  function _applyPeakPointer(e) {
    var rect = dragRect || svg.getBoundingClientRect();
    var raw  = _unscale(e.clientX - rect.left, e.clientY - rect.top);
    var n    = svgToNorm(raw.cx, raw.cy, _svgW, _svgH);
    var x    = Math.max(0, Math.min(1, n.nx));
    var ny   = Math.max(0, Math.min(1, n.ny));
    if (e.shiftKey) {
      x  = Math.round(x * _gridSize) / _gridSize;
      ny = Math.round(ny * _gridSize) / _gridSize;
    }
    liveCurve = _solvePeak(x, ny);
    _setSnapBg(e.shiftKey);
    var pk = _peakOf(liveCurve, 96);
    _showPeakCoords(pk.v <= 1.02 ? x : pk.x, pk.v);
    updateDynamicSVG(liveCurve, _svgW, _svgH);
  }

  // Only touch the DOM when the snap state actually changes: this runs on
  // every drag pointermove and rewrites every grid line, which UXP repaints
  var _snapBgOn = false;
  function _setSnapBg(snap) {
    snap = !!snap;
    if (snap === _snapBgOn) return;
    _snapBgOn = snap;
    var bg = document.getElementById('sg-range-bg');
    if (bg) {
      bg.setAttribute('fill', snap ? '#4a9eff' : '#1c1c1c'); // same as #sg-range-bg in index.html
      bg.setAttribute('fill-opacity', snap ? '0.07' : '1');
    }
    for (var gi = 1; gi < _gridSize; gi++) {
      var gh = document.getElementById('sg-gh' + gi);
      var gv = document.getElementById('sg-gv' + gi);
      if (gh) { gh.setAttribute('stroke', snap ? '#a8d4ff' : '#ffffff'); gh.setAttribute('stroke-opacity', snap ? '0.12' : '0.055'); }
      if (gv) { gv.setAttribute('stroke', snap ? '#a8d4ff' : '#ffffff'); gv.setAttribute('stroke-opacity', snap ? '0.12' : '0.055'); }
    }
  }

  function endDrag() {
    if (!dragging) return;
    _isDragging = false;
    _setSnapBg(false);
    _hideDragGhost();
    // Only commit when the drag actually changed something. Pressing a handle
    // and releasing without moving used to clear the active preset, so the tile
    // un-highlighted although the curve was identical. (A press on empty graph
    // space snaps the nearest handle and commits in pointerdown, so that path
    // is already committed by the time we get here.)
    if (dragging === 'bn-hit' || dragging === 'bn-top') {
      _bnDrag = false;
      if (dragMoved) _bnSet({}, false); // commit what the drag left, as a slider release does
    } else if (dragMoved) {
      if (liveCurve) delete liveCurve.bounce; // hand-edited: no longer the curve Bounce mode built
      setState({ curve: liveCurve });
    }
    dragMoved = false;
    dragging  = null;
    liveCurve = null;
    dragRect  = null;
    setCursor('crosshair');
  }

  svg.addEventListener('pointerup',     endDrag);
  svg.addEventListener('pointercancel', endDrag);

  window.addEventListener('keydown', function(e) {
    if (e.key === 'Shift' && dragging) _setSnapBg(true);
  });
  window.addEventListener('keyup', function(e) {
    if (e.key === 'Shift') _setSnapBg(false);
  });

  function onResize() {
    var el = svg.parentNode || svg;
    var rect = el.getBoundingClientRect();
    var w = Math.floor(rect.width);
    var h = Math.floor(rect.height);
    if (w < 40 || h < 40) return;
    if (_svgW === w && _svgH === h) return;
    _svgW = w; _svgH = h;
    _graphDirty = false;
    updateStaticSVG(w, h);
    updateDynamicSVG(liveCurve || getState().curve, w, h);
    _updateContentTransform();
  }

  if (typeof ResizeObserver !== 'undefined') {
    // Observe the parent container — more reliable in CEP's Chromium for abs-positioned SVG
    var wrapEl = svg.parentNode || svg;
    new ResizeObserver(onResize).observe(wrapEl);
  }
  // Delay initial sizing to let flex layout settle
  setTimeout(onResize, 50);
  setTimeout(onResize, 200);
}

// ─── UI ───────────────────────────────────────────────────────────────────
var PRESETS = {
  'cubic-in':     { p1x: 0.32, p1y: 0, p2x: 0.67, p2y: 0 },
  'cubic-out':    { p1x: 0.33, p1y: 1, p2x: 0.68, p2y: 1 },
  'cubic-in-out': { p1x: 0.65, p1y: 0, p2x: 0.35, p2y: 1 },
  // The rest of the defaults (November 2026, 2.1.0): six clearly different
  // shapes, not variations on the cubics. Same curves as
  // presets/OpenCurve-Preset-Pack.json, which existing users can import.
  'linear':       { p1x: 0.25, p1y: 0.25, p2x: 0.75, p2y: 0.75 },
  'snap':         { p1x: 0.87, p1y: 0,    p2x: 0.13, p2y: 1 },
  'slow-middle':  { p1x: 0.1,  p1y: 0.7,  p2x: 0.9,  p2y: 0.3 },
  'overshoot':    { p1x: 0.34, p1y: 1.56, p2x: 0.64, p2y: 1 },
  'anticipate':   { p1x: 0.36, p1y: 0,    p2x: 0.66, p2y: -0.56 },
  'bounce': {
    p1x: 0.1212, p1y: 0, p2x: 0.9697, p2y: 0.9792,
    pts: [
      { x: 0.3636, y: 1, ix: 0.2424, iy: 0.3333, ox: 0.4848, oy: 0.6667, smooth: false },
      { x: 0.7273, y: 1, ix: 0.6061, iy: 0.6667, ox: 0.7879, oy: 0.9167, smooth: false },
      { x: 0.9091, y: 1, ix: 0.8485, iy: 0.9167, ox: 0.9394, oy: 0.9792, smooth: false },
    ],
  },
};

var BUILT_IN_PRESETS = [
  { id: 'cubic-in-out', name: 'Cubic In-Out', curve: PRESETS['cubic-in-out'], builtIn: true },
  { id: 'cubic-in',     name: 'Cubic In',     curve: PRESETS['cubic-in'],     builtIn: true },
  { id: 'cubic-out',    name: 'Cubic Out',    curve: PRESETS['cubic-out'],    builtIn: true },
  { id: 'linear',       name: 'Linear',       curve: PRESETS['linear'],       builtIn: true },
  { id: 'snap',         name: 'Snap',         curve: PRESETS['snap'],         builtIn: true },
  { id: 'slow-middle',  name: 'Slow Middle',  curve: PRESETS['slow-middle'],  builtIn: true },
  { id: 'overshoot',    name: 'Overshoot',    curve: PRESETS['overshoot'],    builtIn: true },
  { id: 'anticipate',   name: 'Anticipate',   curve: PRESETS['anticipate'],   builtIn: true },
  { id: 'bounce',       name: 'Bounce',       curve: PRESETS['bounce'],       builtIn: true },
];

// Frame count of the selected keyframe pairs for the status strip: "24 frames",
// or "18–24 frames" when the selected properties span different pairs.
function _frameSpan(s, keys) {
  var lo = Infinity, hi = -Infinity;
  (keys || []).forEach(function(k) {
    var ctx = s.paramContexts && s.paramContexts[k];
    if (!ctx || typeof ctx.frameCount !== 'number') return;
    if (ctx.frameCount < lo) lo = ctx.frameCount;
    if (ctx.frameCount > hi) hi = ctx.frameCount;
  });
  if (lo === Infinity) return '';
  return (lo === hi ? lo : lo + '\u2013' + hi) + ' frames';
}

var STATUS_CONFIG = {
  'idle':         { cls:'status-idle',  text: function(s){ return s.hint || 'Open a project and select a clip'; } },
  'no-project':   { cls:'status-idle',  text: 'No project open' },
  'no-sequence':  { cls:'status-idle',  text: 'No active sequence' },
  'no-clip':      { cls:'status-idle',  text: function(s){ return s.hint || 'No clip found at playhead'; } },
  'no-keyframes': { cls:'status-warn',  text: function(s){ return s.hint || 'No property with exactly 2 keyframes'; } },
  'outside':      { cls:'status-warn',  text: function(s){ return s.hint || 'Move playhead between the two keyframes'; } },
  // The property rows already list every name, so these two show what the rows
  // can't: the clip (own span, see renderUI), how many are ready/selected, and
  // the span being eased.
  'no-selection': { cls:'status-detected', clip: true, text: function(s){
    var n = (s.validParamKeys || []).length;
    if (n === 0) return 'Properties detected';
    return n === 1 ? '1 property ready' : n + ' properties ready';
  }},
  'valid':        { cls:'status-valid', clip: true, text: function(s){
    var valid = s.validParamKeys || [];
    var sel   = (s.selectedParamKeys || []).filter(function(k){ return valid.indexOf(k) >= 0; });
    var parts = [];
    if (valid.length > 1) parts.push(sel.length + ' of ' + valid.length + ' selected');
    var fr = _frameSpan(s, sel);
    if (fr) parts.push(fr);
    return parts.join(' · ') || 'Ready';
  }},
  'error':        { cls:'status-error', text: function(s){ return 'Error: '+(s.hint||s.errorMessage||'unknown'); } },
  'baking':       { cls:'status-idle',  text: 'Applying…' },
  'done':         { cls:'status-done',  text: 'Done! Keyframes baked.' },
};

// ─── Edited preset (2.1.0) ────────────────────────────────────────────────
// The preset the graph's curve came from (_srcPresetId) is remembered until a
// curve from somewhere else replaces it. While the curve still matches it
// (_sameCurve) its tile is lit as before ('active'); once the curve differs the
// tile turns 'edited' (a softer fill and a dot in the theme colour) and the
// graph bar's chip, which names the source preset whenever there is one,
// adds "edited", Save (overwrites the preset, built-ins too) and Revert
// (eases back to it). Edits never touch the source:
// every curve change goes through setState, and the state listener below
// compares the curve with the preset's, so dragging back to the same shape
// lights the tile normally again. clearPresetActive() forgets the source (a
// curve from elsewhere: Load Baked Curve with no matching preset, Reset).
// _presetEditSync runs on every setState (10Hz polls) and writes nothing
// unless its signature changed.
var _srcPresetId = null;
var _presetByIdRef = null;      // set in initPanel (_presetList lives there): id -> preset, or null
var _presetOverwriteRef = null; // set in initPanel: (preset, curve) -> overwrite, save, redraw its thumbnail
var _peSig = null;
var _peDot = null;              // the one dot, moved into the edited tile
var _peChipRoom = true;         // set by the graph bar's layout (_tbLayout): room for the chip
var _peRoom = Infinity;         // ... and the room it has (px), for the name test below
// Room the name and "Edited" need beside the buttons: the name may be cut to
// about 8 characters (12px text, ~6.6px each) before it goes altogether
// Save and Revert carry their labels when the whole chip fits labelled
// (_PE_CHIP_FULL), and also once the name has gone, when the two labelled
// buttons alone fit (_PE_BTNS_LABELLED); otherwise they are 26px icon squares
var _PE_CHIP_FULL = 230;     // name + Edited + the labelled Save and Revert buttons
var _PE_BTNS_LABELLED = 142; // the labelled Save and Revert buttons alone (semibold)
var _peLabels = null;
function _peSetLabels(on) {
  if (on === _peLabels) return;
  _peLabels = on;
  ['pe-save', 'pe-revert'].forEach(function(id) {
    var b = document.getElementById(id);
    if (!b) return;
    var sp = b.querySelector('span'), sv = b.querySelector('svg');
    if (sp) sp.style.display = on ? '' : 'none';
    b.style.padding = on ? '' : '0 5px'; // (26 - 16) / 2: the icon centred in a square
    if (sv) sv.style.marginRight = on ? '5px' : '0';
  });
}
function _peNameFits(name, ed) {
  return _peRoom >= 9 + Math.min(name.length, 8) * 6.6 + (ed ? 5 + 40 + 3 + 2 * 31 : 9);
}
function _presetEditInfo() {
  if (_srcPresetId === null || !_presetByIdRef) return null;
  var p = _presetByIdRef(_srcPresetId);
  if (!p) return null;
  return { preset: p, edited: !_sameCurve(p.curve, state.curve) };
}
function _presetEdited() { var inf = _presetEditInfo(); return inf && inf.edited ? inf.preset : null; }
function _presetChipShown() {
  var c = document.getElementById('preset-edit-chip');
  return !!(c && c.style.display !== 'none');
}
function _presetEditSync(force) {
  var inf = _presetEditInfo();
  var id = inf ? String(inf.preset.id) : null, ed = !!(inf && inf.edited);
  var name = inf ? inf.preset.name : '';
  var _peNameRoom = _peNameFits(name, ed) || _peRoom >= _PE_CHIP_FULL;
  var labels = _peRoom >= _PE_CHIP_FULL || (!_peNameRoom && _peRoom >= _PE_BTNS_LABELLED);
  _peSetLabels(labels);
  var sig = id + '|' + ed + '|' + name + '|' + _curveColor + '|' + _peChipRoom + '|' + _peNameRoom + '|' + labels;
  if (!force && sig === _peSig) return;
  _peSig = sig;
  // Tiles: state classes on the tile itself (UXP restyles reliably that way)
  var edTile = null;
  document.querySelectorAll('.preset-btn').forEach(function(b) {
    var mine = id !== null && b.dataset.id === id;
    var a = mine && !ed, e = mine && ed;
    if (a) { if (!b.classList.contains('active')) b.classList.add('active'); if (b.dataset.active !== 'true') b.dataset.active = 'true'; }
    else { if (b.classList.contains('active')) b.classList.remove('active'); if (b.hasAttribute('data-active')) b.removeAttribute('data-active'); }
    if (e) { if (!b.classList.contains('edited')) b.classList.add('edited'); edTile = b; }
    else if (b.classList.contains('edited')) b.classList.remove('edited');
  });
  if (edTile) {
    if (!_peDot) {
      _peDot = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      _peDot.setAttribute('class', 'preset-edit-dot');
      _peDot.setAttribute('width', '8'); _peDot.setAttribute('height', '8'); _peDot.setAttribute('viewBox', '0 0 8 8');
      _peDot.style.cssText = 'position:absolute;top:5px;right:5px;pointer-events:none;';
      var dc = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dc.setAttribute('cx', '4'); dc.setAttribute('cy', '4'); dc.setAttribute('r', '3');
      _peDot.appendChild(dc);
    }
    _peDot.firstChild.setAttribute('fill', _curveColor);
    if (_peDot.parentNode !== edTile) edTile.appendChild(_peDot);
  } else if (_peDot && _peDot.parentNode) _peDot.parentNode.removeChild(_peDot);
  // Graph bar chip
  var chip = document.getElementById('preset-edit-chip');
  // The chip names the preset whenever there is one; "edited", Save and Revert
  // join it only while the curve differs (the name gets right padding alone).
  // In a narrow bar the name and "Edited" go and Save and Revert stay, alone
  // (an unedited preset then shows nothing: there is nothing left to show)
  if (chip) {
    var show = id !== null && _peChipRoom && (ed || _peNameRoom);
    if (show) {
      var nm = document.getElementById('pe-name');
      if (nm && nm.textContent !== name) nm.textContent = name;
      var setD = function(el, d) { if (el && el.style.display !== d) el.style.display = d; };
      setD(nm, _peNameRoom ? '' : 'none');
      setD(chip.querySelector('.pe-tag'), (ed && _peNameRoom) ? '' : 'none');
      var sub = ed ? '' : 'none';
      var sv = document.getElementById('pe-save');
      setD(sv, sub);
      setD(document.getElementById('pe-revert'), sub);
      var pr = ed ? '' : '9px';
      if (chip.style.paddingRight !== pr) chip.style.paddingRight = pr;
      var pl = _peNameRoom ? '' : '0'; // the buttons alone sit flush in the chip
      if (chip.style.paddingLeft !== pl) chip.style.paddingLeft = pl;
      if (sv && sv.style.marginLeft !== pl) sv.style.marginLeft = pl;
    }
    var disp = show ? 'flex' : 'none';
    if (chip.style.display !== disp) chip.style.display = disp;
  }
}
stateListeners.push(function() { _presetEditSync(); });
// Save: write the graph's curve into the preset it came from (built-ins too)
function _presetEditSave() {
  var p = _presetEdited();
  if (!p || !_presetOverwriteRef) return;
  _presetOverwriteRef(p, state.curve);
  _showCopyToast('Saved to "' + p.name + '"', '#3ddc84');
}
// Revert: ease back to the preset's curve, like clicking its tile
function _presetEditRevert() {
  var p = _presetEdited();
  if (!p) return;
  _animateToCurve(p.curve, function(cur) { if (_svgW > 0 && _svgH > 0) updateDynamicSVG(cur, _svgW, _svgH); });
}
function clearPresetActive() {
  _srcPresetId = null;
  _presetEditSync(true);
}
function setPresetActive(id) {
  _srcPresetId = (id === null || id === undefined) ? null : String(id);
  _presetEditSync(true);
}

// Pin button: ask the CEP bridge to move the playhead (ExtendScript does the work)
// Row undo button: the host keeps the bake records (ids arrive on each
// availableParams entry as `bakeIds`); the bridge asks it to remove them.
// Busy look for the row Undo / Replace buttons and the Undo next to Go: while
// the action runs the icon is swapped for Go's spinner, pinned at the centre
// (the buttons centre their content with flex, so it simply takes the icon's place)
function _rowBtn(key, which) {
  var row = document.querySelector('.prop-btn[data-key="' + key + '"]');
  return row && row._oc ? row._oc[which] : null;
}
function _btnBusy(el, on) {
  if (!el) return;
  var svg = el.querySelector('svg');
  if (on) {
    if (el._ocSpin) return;
    var sp = document.createElement('span');
    sp.className = 'spinner';
    sp.style.cssText = 'width:12px;height:12px;box-sizing:border-box;pointer-events:none;';
    el._ocSpinDisp = svg ? svg.style.display : '';
    if (svg) svg.style.display = 'none';
    el.appendChild(sp);
    el._ocSpin = sp;
  } else {
    if (!el._ocSpin) return;
    if (el._ocSpin.parentNode) el._ocSpin.parentNode.removeChild(el._ocSpin);
    el._ocSpin = null;
    if (svg) svg.style.display = el._ocSpinDisp || '';
  }
}
function _undoBakeForKey(key) {
  var live = (getState().availableParams || []).filter(function(x){ return x.key === key; })[0];
  if (!live || !live.bakeIds || !live.bakeIds.length) return;
  var b = _rowBtn(key, 'undo');
  if (b && b._ocSpin) return; // already running
  if (!(_bridge && _bridge.onUndoParam)) return;
  _btnBusy(b, true);
  _bridge.onUndoParam(live.bakeIds, live.label || live.displayName, function() { _btnBusy(b, false); });
}

// Row Replace button: the host swaps those bake records for the graph's
// current curve on the same keyframe pairs (an undo brings the old curve back).
function _replaceBakeForKey(key) {
  var s = getState();
  if (s.isBaking) return;
  var live = (s.availableParams || []).filter(function(x){ return x.key === key; })[0];
  if (!live || !live.bakeIds || !live.bakeIds.length) return;
  var b = _rowBtn(key, 'replace');
  if (b && b._ocSpin) return;
  if (!_replaceOk(live, s.curve)) return; // same curve as the bake: nothing to replace
  _pvStop();
  if (!(_bridge && _bridge.onReplaceParam)) return;
  _btnBusy(b, true);
  _bridge.onReplaceParam(live.bakeIds, _cloneCurve(s.curve), live.label || live.displayName, function() { _btnBusy(b, false); });
}

// The Replace button's icon: two arrows going round
var _icReplace = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none">'
  + '<path d="M11.3 5.2A4.6 4.6 0 0 0 3 4.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>'
  + '<path d="M2.7 8.8A4.6 4.6 0 0 0 11 9.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>'
  + '<path d="M11.6 2.5v2.8H8.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'
  + '<path d="M2.4 11.5V8.7h2.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'
  + '</svg>';

// Replace starts dimmed: it only becomes available once the graph holds a
// different curve from the one the bake under the playhead used (the host's
// `bakeCurve` on the availableParams entry; a record with no curve leaves it
// available). Shape only: a point's smooth flag is ignored.
function _sameCurve(a, b) {
  if (!a || !b) return false;
  var d = function(x, y) { return Math.abs((x || 0) - (y || 0)) <= 1e-4; };
  if (!d(a.p1x, b.p1x) || !d(a.p1y, b.p1y) || !d(a.p2x, b.p2x) || !d(a.p2y, b.p2y)) return false;
  var ap = _hasPts(a) ? a.pts : [], bp = _hasPts(b) ? b.pts : [];
  if (ap.length !== bp.length) return false;
  for (var i = 0; i < ap.length; i++) {
    var p = ap[i], q = bp[i];
    if (!d(p.x, q.x) || !d(p.y, q.y) || !d(p.ix, q.ix) || !d(p.iy, q.iy) || !d(p.ox, q.ox) || !d(p.oy, q.oy)) return false;
  }
  return true;
}
function _replaceOk(row, curve) {
  return !!(row && row.bakeIds && row.bakeIds.length) && !(row.bakeCurve && _sameCurve(row.bakeCurve, curve));
}
// Dimmed look: the same grey as the dimmed Undo next to Go (inline, like UXP)
function _styleReplaceBtn(el, ready) {
  el.classList.toggle('btn-dim', !ready);
  el.style.backgroundColor = ready ? '' : '#2b2b2b';
  el.style.backgroundImage = ready ? '' : 'none';
  el.style.color           = ready ? '' : '#6f6f6f';
  el.style.cursor          = ready ? '' : 'default';
}

// Row curve button: the host attaches the curve its bake record used to the
// availableParams entry as `bakeCurve`; put it back on the graph.
function _loadBakedCurve(key) {
  var live = (getState().availableParams || []).filter(function(x){ return x.key === key; })[0];
  if (!live || !live.bakeCurve) { _showCopyToast('No curve was recorded for this bake', '#f0a030'); return; }
  // The preset it came from, if it is still in the list, lights up as if clicked
  var pid = _presetMatchRef ? _presetMatchRef(live.bakeCurve) : null;
  if (pid !== null) {
    setPresetActive(pid);
    var tile = document.querySelector('.preset-btn[data-id="' + pid + '"]');
    if (tile && tile.scrollIntoView) tile.scrollIntoView({ block: 'nearest' }); // in view
  } else clearPresetActive();
  _animateToCurve(_cloneCurve(live.bakeCurve), function(cur) { if (_svgW > 0 && _svgH > 0) updateDynamicSVG(cur, _svgW, _svgH); });
  _showCopyToast('Loaded the curve baked on ' + (live.label || live.displayName || 'this property'));
}

// Status strip click while the playhead is outside every keyframe pair: the
// scan tags each property with the start of its nearest 2+ frame pair
// (nearSec, sequence seconds) and how far the playhead is from it (nearDist).
function _nearestJumpParam(s) {
  var best = null;
  (s.availableParams || []).forEach(function(p) {
    if (typeof p.nearSec !== 'number') return;
    if (!best || p.nearDist < best.nearDist) best = p;
  });
  return best;
}

// ─── Host hooks for the preview engine and the value readout (CEP) ────────
// The bridge runs these through ExtendScript; QE plays for real (ocTransport),
// so the engine is only used for the pair preview.
function _hostSeqInfo() { return _bridge && _bridge.seqInfo ? _bridge.seqInfo() : Promise.resolve(null); }
function _hostSetPlayhead(sec) { return _bridge && _bridge.setPlayhead ? _bridge.setPlayhead(sec) : Promise.reject(new Error('No bridge')); }
function _hostTransport(cmd) { return _bridge && _bridge.transport ? _bridge.transport(cmd) : Promise.resolve(false); }
function _tlValueAt(p, mediaSec) { return _bridge && _bridge.valueAt ? _bridge.valueAt(p.key, mediaSec) : Promise.resolve(null); }

function _jumpToParam(p) {
  if (!p || typeof p.jumpSec !== 'number') return;
  _pvStop();
  if (_bridge && _bridge.onJump) _bridge.onJump(p.jumpSec);
}

// ─── Panel shortcuts ─────────────────────────────────────────────────────
// Keys reach the panel through #oc-key-sink (see initPanel). Space play/stop ·
// J K L shuttle · P preview the pair · 1-9 the first presets · arrows nudge
// the last-touched handle (Shift: a grid step; Bounce mode: hit and height) · F flip · I invert · A A-curve · B bounce
// · G ghost · N numeric entry · U undo the last bake · Esc stops a preview or
// leaves full screen. Enter (Go) is handled by the caller.
var _lastHandle = { k: 'p1' }; // last handle pressed on the graph, for the arrow keys
var _ocPressInField = false; // the current press started in a text field (see the key sink listeners)
var _NATIVE_TRANSPORT = false; // CEP: Premiere does not receive Space/J/K/L while the panel has focus either (tested), so QE plays
function _panelShortcut(e) {
  var k = e.key || '', code = e.code || '';
  var lk = k.length === 1 ? k.toLowerCase() : k;
  if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown') {
    if (_bounceMode) { // Bounce mode: left/right move the hit, up/down the height
      var bs = e.shiftKey ? 1 / _gridSize : 0.01;
      _bnNudge(k === 'ArrowLeft' ? -bs : k === 'ArrowRight' ? bs : 0, k === 'ArrowUp' ? bs : k === 'ArrowDown' ? -bs : 0);
      return true;
    }
    var st = e.shiftKey ? 1 / _gridSize : 0.01;
    _nudgeHandle(k === 'ArrowLeft' ? -st : k === 'ArrowRight' ? st : 0,
                 k === 'ArrowUp'   ?  st : k === 'ArrowDown'  ? -st : 0);
    return true; // the one shortcut meant to repeat while the key is held
  }
  // Everything below acts once per press. On auto-repeat a held Space toggled
  // the preview ~30 times a second (three host calls each), a held L doubled
  // the shuttle rate per repeat, and a held digit restarted the preset tween.
  if (e.repeat) return false;
  var isTransport = k === ' ' || code === 'Space' || lk === 'j' || lk === 'k' || lk === 'l';
  if (isTransport) {
    if (_NATIVE_TRANSPORT) return false; // CEP: Premiere receives the key itself, doing it here doubled the toggle
    if (k === ' ' || code === 'Space') _transport('toggle');
    else _transport(lk === 'j' ? 'rev' : lk === 'k' ? 'stop' : 'fwd');
    return true;
  }
  if (lk === 'p') { if (_pv && _pv.back) _pvStop(); else _previewPair(); return true; }
  if (k.length === 1 && k >= '1' && k <= '9') { _pressPreset(parseInt(k, 10) - 1); return true; }
  if (lk === 'f') { _applyCurveOp(_flipCurve);   return true; }
  if (lk === 'i') { _applyCurveOp(_invertCurve); return true; }
  if (lk === 'a') { _setPeakMode(!_peakMode);    return true; }
  if (lk === 'b') { _setBounceMode(!_bounceMode); return true; }
  if (lk === 'g') { _setDragGhost(!_dragGhost);  return true; }
  if (lk === 'n') { _showNumericPanel();         return true; }
  if (lk === 'u') {
    var ub = document.getElementById('undo-btn');
    if (ub && !ub.classList.contains('btn-dim')) ub.click(); else _showCopyToast('Nothing to undo');
    return true;
  }
  if (k === 'Escape') {
    if (_zoomPopHide && _zoomPopHide()) return true;
    if (_closeMenus && _closeMenus()) return true; // tile and mini context menus
    if (_pv) { _pvStop(); return true; }
    if (_graphFull) { _setGraphFull(false); return true; }
  }
  return false;
}
function _pressPreset(i) {
  var list = document.getElementById('all-presets-list');
  if (!list) return;
  var tiles = Array.prototype.filter.call(list.querySelectorAll('.preset-btn'), function(b) {
    return b.id !== '_update-notif';
  });
  if (tiles[i]) tiles[i].click();
}
function _nudgeHandle(dx, dy) {
  var c = _cloneCurve(getState().curve), d = _lastHandle;
  if (d.k !== 'p1' && d.k !== 'p2' && !(c.pts && c.pts[d.i])) d = _lastHandle = { k: 'p1' };
  var hp = _handlePos(c, d);
  _setHandle(c, d, Math.max(0, Math.min(1, hp.x + dx)), hp.y + dy, false, false);
  _commitCurve(c);
}

// ─── Preview engine ──────────────────────────────────────────────────────
// Steps the playhead at the sequence's frame rate through the host's
// set-position call. Premiere's UXP API has no play command, so in the CCX
// build Space / J / K / L run through here (no audio); the CEP build plays for
// real through QE (_hostTransport) and only uses this for the pair preview.
// Wall-clock paced: a slow host call drops frames rather than slowing the
// preview. _hostSeqInfo / _hostSetPlayhead / _hostTransport are per edition.
var _pv = null; // { rate, back, fps, from, to, t0, last, busy, timer, info }
function _pvStart(rate, opts) {
  opts = opts || {};
  _pvStop();
  var st = { rate: rate, back: !!opts.back, busy: true, last: null, timer: null, t0: 0 };
  _pv = st;
  _hostSeqInfo().then(function(info) {
    if (_pv !== st) return;
    if (!info) { _pv = null; console.log('[OC] preview: no active sequence'); _showCopyToast('Preview needs an open sequence'); return; }
    st.info = info;
    st.fps  = info.fps > 0 ? info.fps : 25;
    st.from = typeof opts.from === 'number' ? opts.from : info.pos;
    st.to   = typeof opts.to   === 'number' ? opts.to   : (rate > 0 ? info.end : 0);
    st.t0   = Date.now();
    st.busy = false;
    st.steps = 0;
    console.log('[OC] preview: start ' + st.from.toFixed(3) + 's -> ' + st.to.toFixed(3) + 's at x' + st.rate + ', ' + st.fps + ' fps');
    st.timer = setInterval(function() { _pvTick(st); }, Math.max(15, Math.round(500 / st.fps)));
    _pvTick(st);
  }, function(e) {
    console.log('[OC] preview: sequence info failed:', e && e.message ? e.message : e);
    _showCopyToast('Preview failed: ' + (e && e.message ? e.message : 'no sequence info'), '#ff9090');
    if (_pv === st) _pv = null;
  });
}
function _pvTick(st) {
  if (_pv !== st || st.busy) return;
  var sec  = st.from + (Date.now() - st.t0) / 1000 * st.rate;
  var done = st.rate > 0 ? sec >= st.to : sec <= st.to;
  if (done) sec = st.to;
  var frame = Math.round(sec * st.fps);
  if (frame === st.last && !done) return;
  st.last = frame;
  st.busy = true;
  // _pvStop acts on whatever _pv currently is, so a late callback from a run the
  // user has already replaced (press L as a pair preview lands its last step)
  // would kill the new run and send the playhead back to the old one's start.
  _hostSetPlayhead(frame / st.fps, st.info).then(function() {
    st.busy = false;
    st.steps++;
    if (done && _pv === st) { console.log('[OC] preview: done after ' + st.steps + ' steps'); _pvStop(true); }
  }, function(e) {
    console.log('[OC] preview: set playhead failed at frame ' + frame + ':', e && e.message ? e.message : e);
    st.busy = false;
    if (_pv !== st) return;
    _showCopyToast('Preview failed: ' + (e && e.message ? e.message : 'could not move the playhead'), '#ff9090');
    _pvStop();
  });
}
function _pvStop(finished) {
  var st = _pv;
  if (!st) return;
  _pv = null;
  if (st.timer) clearInterval(st.timer);
  if (finished && st.back && st.info) _hostSetPlayhead(st.from, st.info).then(null, function() {}); // pair preview: back to its start
}
// Transport keys. The host plays for real when it can; otherwise the engine does it.
function _transport(cmd) {
  if (_pv && _pv.back) { _pvStop(); if (cmd === 'toggle' || cmd === 'stop') return; }
  _hostTransport(cmd).then(function(handled) {
    if (handled) return;
    var run  = _pv && !_pv.back ? _pv : null;
    var rate = run ? run.rate : 0;
    var next = cmd === 'toggle' ? (run ? 0 : 1)
             : cmd === 'stop'   ? 0
             : cmd === 'fwd'    ? (rate > 0 ? Math.min(8, rate * 2) : 1)
             : cmd === 'rev'    ? (rate < 0 ? Math.max(-8, rate * 2) : -1) : 0;
    if (next === 0) { _pvStop(); return; }
    var o = {};
    if (run && run.info) o.from = run.from + (Date.now() - run.t0) / 1000 * run.rate; // keep the position, change the speed
    _pvStart(next, o);
  }, function(e) { console.log('[OC] transport failed', e); });
}
// Preview the pair: run the playhead once through the keyframe pair of the
// given rows (else the selected rows, else any row with a pair) and return to
// its start. The P key.
function _previewPair(keys) {
  var s = getState(), avail = s.availableParams || [];
  var use = (keys && keys.length) ? keys : (s.selectedParamKeys || []);
  function hasPair(p) { return !p.tlOut && typeof p.tlKf0 === 'number' && typeof p.tlKf1 === 'number'; }
  var rows = avail.filter(function(p) { return use.indexOf(p.key) >= 0 && hasPair(p); });
  if (!rows.length) rows = avail.filter(hasPair);
  if (!rows.length) { _showCopyToast('Move the playhead between keyframes to preview'); return; }
  var from = Infinity, to = -Infinity;
  rows.forEach(function(p) { if (p.tlKf0 < from) from = p.tlKf0; if (p.tlKf1 > to) to = p.tlKf1; });
  if (!(to > from)) return;
  _pvStart(1, { from: from, to: to, back: true });
}

// ─── Mini timeline ────────────────────────────────────────────────────────
// Read-only strip along the bottom of the panel: one lane per property row,
// showing that property's keyframes on the clip the rows belong to, its bakes
// (green bars), the pair the playhead is in and the playhead itself. Pressing
// a lane moves the playhead there (a keyframe within a few pixels snaps to it).
// Everything comes from the scan: `s.tl` carries the clip's extent in sequence
// seconds (clipStart/clipEnd), its in-point, fps and the playhead, and each
// availableParams entry carries tlKf (keyframe times, sequence seconds),
// tlKf0/tlKf1/tlOut (the playhead's bracket) and tlSpans (live bake records).
// Drawn with createElementNS like the graph; dynamic styling is inline or an
// attribute because UXP doesn't relayout on class changes. Same code in both
// editions (src/plugin.js and cep/js/plugin-ui.js).
var _TL_KEY       = 'opencurve-timeline';
var _tlVisible    = localStorage.getItem(_TL_KEY) !== 'off';
var _TL_ZOOM_KEY  = 'opencurve-timeline-zoom';
var _tlZoomKeys   = localStorage.getItem(_TL_ZOOM_KEY) === 'keys'; // zoom to the keyframes instead of the whole clip
var _TL_H_KEY     = 'opencurve-timeline-height';
var _tlUserH      = parseInt(localStorage.getItem(_TL_H_KEY), 10) || null; // dragged height of the lanes + rows area (px); null = _TL_DEF_H, growing with the rows
var _TL_MAIN_MIN  = 100;  // the graph / preset area keeps at least this much height while dragging
var _TL_NS        = 'http://www.w3.org/2000/svg';
var _TL_PAD_X     = 6;
var _TL_ROW_H     = 32;   // lane height = .prop-btn height, so lane i sits beside row i
var _TL_MIN_H     = 32;   // the empty strip (no rows) keeps one row's height
var _TL_PROPS_KEY = 'opencurve-props-width';
var _TL_PROPS_MIN = 100, _TL_PROPS_MAX = 320, _TL_PROPS_DEF = 180; // property column width (px), dragged at #tl-prop-handle
var _TL_PROPS_FRAC = 0.4;          // nothing dragged: the rows take this much of the row, the lanes the rest (60/40)
var _TL_DEF_H     = _TL_ROW_H * 4; // undragged height of the lanes + rows area: four rows, taller once there are more
// Drag limits scale with the panel, like the timeline height: a resizable column
// may take everything but _OC_OTHER_MIN px of its row, so the other side (the
// graph column, or the lanes) never vanishes. _TL_PROPS_MAX / 320 are only the
// fallbacks while the row can't be measured (hidden or not laid out yet).
var _OC_OTHER_MIN = 100;
function _ocMaxColW(sel, minW, fallback) {
  var el = document.querySelector(sel);
  var w  = el ? el.clientWidth : 0;
  return w > 0 ? Math.max(minW, w - _OC_OTHER_MIN) : fallback;
}
function _tlMaxPropsW()  { return _ocMaxColW('#oc-timeline', _TL_PROPS_MIN, _TL_PROPS_MAX); }
function _sidebarMaxW()  { return _ocMaxColW('.main-row', 120, 320); }
// Preset-column width: the saved one clamped to the panel, else half the row
// so the graph and the presets open 50/50. 0 = the row can't be measured yet
// (the CSS width stands in until the column ResizeObserver re-applies this).
function _sidebarDefaultW() {
  var row = document.querySelector('.main-row');
  var w   = row ? row.clientWidth : 0;
  if (w <= 0) return 0;
  return Math.max(120, Math.min(Math.round(w / 2), _sidebarMaxW()));
}
function _sidebarSavedW() {
  var w = parseInt(localStorage.getItem('opencurve-sidebar-width'), 10);
  return w >= 120 ? Math.min(w, _sidebarMaxW()) : _sidebarDefaultW();
}
var _TL_SNAP_PX   = 5;    // a press this close to a keyframe lands exactly on it
var _TL_DBL_MS    = 400;  // two presses on a lane this close together toggle the property
var _tlEls   = null;  // { root, scroll, inner, wrap, svg, empty, fade, fadeTop }
var _tlW     = 0;     // canvas width from the ResizeObserver
var _tlSig   = '';    // what the lanes were last built from
var _tlGeo   = null;  // { W, H, laneH, y0, n, a, b } of the last build
var _tlLanes = [];    // per lane: { key, name, bg, kf: [{ x, t }] }
var _tlPh    = null;  // playhead { line, tri }
var _tlGhost = null;  // ghost playhead { line, tri }: where a press would move it, follows the pointer
var _tlGhostSec = null; // its time in sequence seconds while the pointer is over a lane, else null
var _tlHoverKey = null; // row lit up because its lane is hovered
var _tlHoverText = '';  // shown in the status strip while the pointer is over a lane
var _tlPropsW    = 0;   // current property column width (saved value, or live while its handle is dragged)
// Lane colours follow the property row's state (same values as the row and pin
// CSS), not the graph theme colour. bg/hover: lane tint, matching the row's own
// background and hover for a plain row; bar: the playhead's pair; dot: keyframes;
// pairDot: the pair's two keyframes.
var _TL_COLORS = { // sec: the lane's second lines (_tlSecondXs), tinted like the lane
  none:    { bg: 'rgba(255,255,255,0.05)', hover: 'rgba(255,255,255,0.10)', bar: 'rgba(74,158,255,0.15)', dot: '#8c8c8c', pairDot: '#7dc4ff', sec: 'rgba(255,255,255,0.04)' },
  ready:   { bg: 'rgba(255,255,255,0.05)', hover: 'rgba(255,255,255,0.10)', bar: 'rgba(74,158,255,0.15)', dot: '#8c8c8c', pairDot: '#7dc4ff', sec: 'rgba(255,255,255,0.04)' },
  active:  { bg: 'rgba(74,158,255,0.12)',  hover: 'rgba(74,158,255,0.19)',  bar: 'rgba(74,158,255,0.34)', dot: '#8c8c8c', pairDot: '#7dc4ff', sec: 'rgba(74,158,255,0.073)' },
  pending: { bg: 'rgba(240,160,48,0.10)',  hover: 'rgba(240,160,48,0.17)',  bar: 'rgba(240,160,48,0.28)', dot: '#f7b95a', pairDot: '#f7b95a', sec: 'rgba(240,160,48,0.06)' },
  baked:   { bg: 'rgba(61,220,132,0.10)',  hover: 'rgba(61,220,132,0.17)',  bar: 'rgba(61,220,132,0.30)', dot: '#8c8c8c', pairDot: '#4ce890', sec: 'rgba(61,220,132,0.067)' },
};

// Which _TL_COLORS entry a lane uses, the same logic as its row: green beats
// selection, selected is blue when the playhead is over the pair and amber
// until it is, unselected-but-ready gets a blue pair on a plain lane
function _tlLaneState(key, sel, valid, baked) {
  var isSel = sel.indexOf(key) >= 0, isValid = valid.indexOf(key) >= 0;
  if (baked.indexOf(key) >= 0 && !isSel) return 'baked';
  return isSel ? (isValid ? 'active' : 'pending') : isValid ? 'ready' : 'none';
}

function _tlMk(tag, attrs) {
  var e = document.createElementNS(_TL_NS, tag);
  for (var k in attrs) if (attrs.hasOwnProperty(k)) e.setAttribute(k, attrs[k]);
  return e;
}
function _tlClear(el) { while (el && el.firstChild) el.removeChild(el.firstChild); }

// Visible time range in sequence seconds: the clip, or the keyframes with a margin
function _tlRange(s) {
  var tl = s.tl;
  if (!tl || typeof tl.clipStart !== 'number' || typeof tl.clipEnd !== 'number') return null;
  var a = tl.clipStart, b = tl.clipEnd;
  if (_tlZoomKeys) {
    var mn = Infinity, mx = -Infinity;
    (s.availableParams || []).forEach(function(p) {
      (p.tlKf || []).forEach(function(t) { if (t < mn) mn = t; if (t > mx) mx = t; });
    });
    if (isFinite(mn) && mx > mn) {
      var pad = Math.max((mx - mn) * 0.05, 1 / (tl.fps || 25));
      a = mn - pad; b = mx + pad;
    }
  }
  return b > a ? { a: a, b: b } : null;
}
function _tlX(t, g)   { return _TL_PAD_X + (t - g.a) / (g.b - g.a) * (g.W - 2 * _TL_PAD_X); }
function _tlSec(x, g) { return g.a + (x - _TL_PAD_X) / (g.W - 2 * _TL_PAD_X) * (g.b - g.a); }

// Tick lines, clip-relative (the time base the hover readout shows): the finest
// step that keeps them _TL_SEC_GAP px apart, from single frames through groups
// of frames (_tlFrameSteps) to whole seconds and then every 2, 5, 10, 15, 30 s
// and so on. Until 2026-09-17 the finest step was one second, so a short clip
// got a line or two far apart. Each line's time is exact (clip start + k steps)
// and goes through _tlX like everything else, then rounds to the pixel column
// the playhead takes at that time, so the lines stay on their frames and seconds
// at any zoom. Returns those x columns.
var _TL_SEC_GAP     = 10;
var _TL_SEC_STEPS   = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
var _TL_FRAME_STEPS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 60];
// Frame counts under one second for this rate: the ones that divide it, so every
// second keeps its line (24 fps: 1 2 3 4 6 8 12), plus in-between counts where
// that ladder jumps more than 2.5x (25 fps: 1 2 5 10), so the chosen step never
// leaves the lines much further apart than the gap
function _tlFrameSteps(fps) {
  var R = Math.round(fps);
  if (!(R > 1)) return [];
  var divs = _TL_FRAME_STEPS.filter(function(d) { return d < R && R % d === 0; }).concat([R]);
  function fill(a, b) { // counts between a and b, none more than 2.5x the one before
    if (b / a <= 2.5) return [];
    for (var i = 0; i < _TL_FRAME_STEPS.length; i++) {
      var v = _TL_FRAME_STEPS[i];
      if (v > a && v < b && v >= b / 2.5) return fill(a, v).concat([v]);
    }
    return [];
  }
  var out = [];
  for (var i = 0; i < divs.length - 1; i++) out = out.concat([divs[i]], fill(divs[i], divs[i + 1]));
  return out;
}
function _tlSecondXs(g, origin, fps) {
  var span = g.b - g.a, inner = g.W - 2 * _TL_PAD_X;
  if (!(span > 0) || !(inner > 0) || typeof origin !== 'number') return [];
  var pps = inner / span, step = 0;
  var steps = (fps > 0 ? _tlFrameSteps(fps).map(function(n) { return n / fps; }) : []).concat(_TL_SEC_STEPS);
  for (var i = 0; i < steps.length; i++) {
    if (steps[i] * pps >= _TL_SEC_GAP) { step = steps[i]; break; }
  }
  if (!step) return [];
  var xs = [];
  // Tolerance in steps: a frame step (n / fps) isn't exact in floating point
  var k0 = Math.ceil((g.a - origin) / step - 1e-6), k1 = Math.floor((g.b - origin) / step + 1e-6);
  for (var k = k0; k <= k1; k++) {
    var x = Math.round(_tlX(origin + k * step, g));
    if (x >= 0 && x < g.W) xs.push(x);
  }
  return xs;
}

// Calls draw(y, height, colour, state, xs) once per lane: the lane's top, its
// height less its 1px divider row, its _TL_COLORS sec tint and state key. Every
// lane draws its own segments because each one fades out towards the bottom of
// its lane (full tint at the top edge, transparent at the bottom).
function _tlSecondRows(params, sel, valid, baked, laneH, y0, draw, xs) {
  if (!xs.length) return;
  params.forEach(function(p, i) {
    var st = _tlLaneState(p.key, sel, valid, baked);
    draw(y0 + i * laneH, laneH - 1, _TL_COLORS[st].sec, st, xs);
  });
}
// The same rgba colour at zero alpha, so a fade keeps its hue all the way down
function _tlTransparent(col) { return col.replace(/,\s*[0-9.]+\)$/, ',0)'); }

// Every lane is one property row tall, so the lanes line up with the rows beside them
function _tlLaneH(n) { return _TL_ROW_H; }

function _tlEmptyText(s) {
  var st = s.status;
  if (st === 'idle' || st === 'no-project' || st === 'no-sequence' || st === 'baking' || st === 'done') return '';
  return 'No keyframes at playhead';
}

// Runs of 3+ keyframes a frame or less apart that no bake record explains
// (a bake from before records existed, a copied clip): drawn as one grey bar
function _tlRuns(kf, fps, spans) {
  var out = [], start = -1;
  function covered(t) { return spans.some(function(sp){ return t >= sp.a - 1e-4 && t <= sp.b + 1e-4; }); }
  function flush(endIdx) {
    if (start >= 0 && endIdx - start >= 2) out.push({ a: kf[start], b: kf[endIdx], kind: 'run' });
    start = -1;
  }
  for (var i = 0; i < kf.length; i++) {
    var tight = i > 0 && (kf[i] - kf[i - 1]) * fps <= 1.5 && !covered(kf[i]) && !covered(kf[i - 1]);
    if (tight) { if (start < 0) start = i - 1; }
    else flush(i - 1);
  }
  flush(kf.length - 1);
  return out;
}

// Called from renderUI on every state change. Lanes are rebuilt only when
// something they show changes; the playhead is moved on every call.
function _tlRender(s, force) {
  if (!_tlEls || !_tlVisible) return;
  s = s || getState();
  var params = s.availableParams || [];
  var range  = _tlRange(s);
  var n      = range ? params.length : 0;
  var laneH  = _tlLaneH(n);
  // One lane per row; the SVG also fills the box, so the playhead line runs the
  // whole visible height when there are few rows. Without a dragged height the
  // box is _TL_DEF_H, which is known without measuring (reading a box that sizes
  // to its own content back into the SVG height would make it sticky).
  var boxH   = _tlUserH ? (_tlEls.scroll ? _tlEls.scroll.clientHeight : 0) : _TL_DEF_H;
  var H      = Math.max(_TL_MIN_H, params.length * laneH, boxH);
  var W      = _tlW;
  var sel    = s.selectedParamKeys || [], valid = s.validParamKeys || [], baked = s.bakedParamKeys || [];
  // clipStart is the origin of the second lines and fps drives the run bars, and
  // neither follows from the range: trimming a clip's head in keyframe-zoom mode
  // moves both while every keyframe keeps its sequence time, so the lanes used
  // to keep drawing the old second lines.
  var sig = [W, H, n, _tlZoomKeys ? 'k' : 'c', range ? range.a.toFixed(4) + '-' + range.b.toFixed(4) : '',
             s.tl ? Math.round((s.tl.clipStart || 0) * 1000) + '/' + (s.tl.fps || 0) : '',
             n === 0 ? s.status : ''].join('|');
  if (range) params.forEach(function(p) {
    sig += '|' + p.key + ':' + p.displayName + ':' + (p.label || '') + ':' + (p.tlKf || []).map(function(t){ return Math.round(t * 1000); }).join(',')
         + ':' + (p.tlOut ? 'o' : Math.round(p.tlKf0 * 1000) + '/' + Math.round(p.tlKf1 * 1000))
         + ':' + (p.tlSpans || []).map(function(sp){ return Math.round(sp[0] * 1000) + '~' + Math.round(sp[1] * 1000); }).join(',')
         + ':' + (sel.indexOf(p.key) >= 0 ? 's' : '') + (valid.indexOf(p.key) >= 0 ? 'v' : '') + (baked.indexOf(p.key) >= 0 ? 'b' : '');
  });
  if (force || sig !== _tlSig) {
    _tlSig = sig;
    _tlBuild(s, params, range, n, laneH, H, W);
    // Six forced layout reads between them. They only matter when the lanes were
    // rebuilt (row count, height or width changed); scrolling has its own
    // handler in _wireTlScroll and the drag handles call them directly. Running
    // them unconditionally cost those reads on every 10Hz playback tick.
    _tlSetGoWidth(); // the scrollbar may have appeared or gone with this render
    _tlUpdateFade();
  }
  _tlPlacePlayhead(s);
}

// Edge fades: the bottom one while the lanes + rows can scroll further down,
// the top one while there is content scrolled up out of view; both gone when
// nothing scrolls. Sizes come from bounding rects, which UXP reports reliably;
// they stop short of the scrollbar so that stays crisp.
function _tlUpdateFade() {
  var els = _tlEls;
  if (!els || !els.fade || !els.scroll || !els.inner) return;
  var showBottom = false, showTop = false, rightInset = 0;
  try {
    var sr = els.scroll.getBoundingClientRect(), ir = els.inner.getBoundingClientRect();
    showBottom = (ir.bottom - sr.bottom) > 1; // content still hidden under the bottom edge
    showTop    = (sr.top - ir.top) > 1;       // content scrolled up past the top edge
    var props = document.getElementById('prop-btns');
    var pr = (props && _tlVisible) ? props.getBoundingClientRect() : null;
    var rr = els.root.getBoundingClientRect();
    if (pr && pr.width > 0) rightInset = Math.max(0, Math.round(rr.right - pr.right));
  } catch(_) {}
  els.fade.style.right   = rightInset + 'px';
  els.fade.style.opacity = showBottom ? '1' : '0';
  if (els.fadeTop) {
    els.fadeTop.style.right   = rightInset + 'px';
    els.fadeTop.style.opacity = showTop ? '1' : '0';
  }
}

function _tlBuild(s, params, range, n, laneH, H, W) {
  var els = _tlEls;
  els.svg.setAttribute('width', W);
  els.svg.setAttribute('height', H);
  _tlClear(els.svg);
  _tlLanes = [];
  _tlLitKey = null; // the lit lane's rect is about to be replaced
  _tlPh = null;
  _tlGhost = null;
  var g = { W: W, H: H, laneH: laneH, n: n, a: range ? range.a : 0, b: range ? range.b : 1, y0: 0 };
  _tlGeo = g;
  var hasLanes = n > 0 && W > 2 * _TL_PAD_X + 10;
  els.empty.textContent   = hasLanes ? '' : _tlEmptyText(s);
  els.empty.style.display = hasLanes ? 'none' : 'flex';
  els.svg.style.cursor    = hasLanes ? 'pointer' : 'default';
  if (!hasLanes) { _tlHighlightLane(null); _tlRowHover(null); _tlShowReadout(null); return; }
  var tl = s.tl, fps = tl.fps || 25;
  var d    = Math.max(3, Math.min(9, laneH - 3)); // diamond size
  var barH = Math.max(2, Math.min(12, laneH - 4)); // bake, run and selected-pair bars
  var sel  = s.selectedParamKeys || [], valid = s.validParamKeys || [], baked = s.bakedParamKeys || [];
  // Sheen like the property rows': brighter at the left of each lane, fading right into
  // its tint (the UXP edition uses an HTML div for this, having no SVG gradients)
  var sheen = _tlMk('linearGradient', { id: 'tl-sheen', x1: 0, y1: 0, x2: 1, y2: 0 });
  sheen.appendChild(_tlMk('stop', { offset: 0, 'stop-color': '#ffffff', 'stop-opacity': 0.045 }));
  sheen.appendChild(_tlMk('stop', { offset: 1, 'stop-color': '#ffffff', 'stop-opacity': 0 }));
  var defs = _tlMk('defs', {});
  defs.appendChild(sheen);
  els.svg.appendChild(defs);
  // Second lines (_tlSecondXs), drawn before the lanes so the dividers paint over them.
  // Tinted per lane (_TL_COLORS sec) and faded top to bottom within each lane: one
  // vertical SVG gradient per lane state (objectBoundingBox, so it maps onto each
  // segment), full tint at the lane's top edge, transparent at its bottom.
  var secFill = {};
  _tlSecondRows(params, sel, valid, baked, laneH, g.y0, function(y, h, col, st, xs) {
    if (!secFill[st]) {
      var m = col.match(/rgba\((\d+),(\d+),(\d+),([0-9.]+)\)/), rgb = 'rgb(' + m[1] + ',' + m[2] + ',' + m[3] + ')';
      var lg = _tlMk('linearGradient', { id: 'tl-sec-' + st, x1: 0, y1: 0, x2: 0, y2: 1 });
      lg.appendChild(_tlMk('stop', { offset: 0, 'stop-color': rgb, 'stop-opacity': m[4] }));
      lg.appendChild(_tlMk('stop', { offset: 1, 'stop-color': rgb, 'stop-opacity': 0 }));
      defs.appendChild(lg);
      secFill[st] = 'url(#tl-sec-' + st + ')';
    }
    xs.forEach(function(x) {
      els.svg.appendChild(_tlMk('rect', { x: x, y: y, width: 1, height: h, fill: secFill[st] }));
    });
  }, _tlSecondXs(g, tl.clipStart, fps));
  params.forEach(function(p, i) {
    var top = g.y0 + i * laneH, cy = top + laneH / 2;
    // Same state logic as the row: green beats selection, selected is blue when the
    // playhead is over the pair and amber until it is, unselected-but-ready gets a blue pair
    var isSel = sel.indexOf(p.key) >= 0, isValid = valid.indexOf(p.key) >= 0;
    var c = _TL_COLORS[_tlLaneState(p.key, sel, valid, baked)];
    var bg = _tlMk('rect', { x: 0, y: top, width: W, height: laneH, fill: c.bg });
    els.svg.appendChild(bg);
    els.svg.appendChild(_tlMk('rect', { x: 0, y: top, width: W, height: laneH - 1, fill: 'url(#tl-sheen)' }));
    // Divider like the property rows': theirs reads as a dark 1px line under each
    // row's tint, so this is a dark strip too (a filled rect, not a stroked line,
    // so it can't depend on how the host handles strokes). A light line here
    // looked like a white rule between the lanes. 0.41 black is what turns a plain
    // lane's tint into the same grey as the row's own border, so the line carries
    // across the divider without a step.
    els.svg.appendChild(_tlMk('rect', { x: 0, y: top + laneH - 1, width: W, height: 1, fill: 'rgba(0,0,0,0.41)' }));
    var kf = (p.tlKf || []).slice().sort(function(x, y){ return x - y; });
    // Bars: bakes (green), other per-frame runs (grey), then the pair the playhead is in
    var spans = (p.tlSpans || []).map(function(sp){ return { a: sp[0], b: sp[1], kind: 'bake' }; });
    _tlRuns(kf, fps, spans).forEach(function(r){ spans.push(r); });
    var pair = null;
    if (!p.tlOut && typeof p.tlKf0 === 'number' && typeof p.tlKf1 === 'number') pair = { a: p.tlKf0, b: p.tlKf1 };
    if (pair && spans.some(function(sp){ return pair.a >= sp.a - 1e-4 && pair.b <= sp.b + 1e-4; })) pair = null; // the bar already shows it
    spans.forEach(function(sp) {
      var x0 = _tlX(sp.a, g), x1 = _tlX(sp.b, g);
      if (x1 < 0 || x0 > W) return;
      els.svg.appendChild(_tlMk('rect', { x: x0, y: cy - barH / 2, width: Math.max(1, x1 - x0), height: barH, rx: 1,
        fill: sp.kind === 'bake' ? 'rgba(76,232,144,0.30)' : 'rgba(255,255,255,0.14)' }));
    });
    if (pair && isValid) {
      // The pair bar is the full barH (12px) on a selected row and 8px on an unselected one
      var pairH = isSel ? barH : Math.min(barH, 8);
      var px0 = _tlX(pair.a, g), px1 = _tlX(pair.b, g);
      els.svg.appendChild(_tlMk('rect', { x: px0, y: cy - pairH / 2, width: Math.max(1, px1 - px0), height: pairH, rx: 1,
        fill: c.bar }));
    }
    // Diamonds: every keyframe except the ones inside a bar (its two ends are kept)
    var lane = { key: p.key, name: p.displayName, label: p.label || p.displayName, bg: bg, fill: c.bg, hover: c.hover, kf: [] };
    var lastX = -Infinity;
    kf.forEach(function(t) {
      var x = _tlX(t, g);
      lane.kf.push({ x: x, t: t });
      if (x < -d || x > W + d) return;
      var inside = null, edge = null;
      spans.forEach(function(sp) {
        if (Math.abs(t - sp.a) < 1e-4 || Math.abs(t - sp.b) < 1e-4) edge = edge || sp;
        else if (t > sp.a && t < sp.b) inside = sp;
      });
      if (inside && !edge) return;
      if (!edge && x - lastX < 1.5) return; // too dense to tell apart at this zoom
      lastX = x;
      var col = c.dot;
      if (edge && edge.kind === 'bake') col = '#4ce890';
      else if (pair && isValid && (Math.abs(t - pair.a) < 1e-4 || Math.abs(t - pair.b) < 1e-4)) col = c.pairDot;
      var h = d / 2;
      els.svg.appendChild(_tlMk('polygon', { points: x + ',' + (cy - h) + ' ' + (x + h) + ',' + cy + ' ' + x + ',' + (cy + h) + ' ' + (x - h) + ',' + cy, fill: col }));
    });
    _tlLanes.push(lane);
  });
  // Ghost playhead: a faint copy that follows the pointer at the frame a press would
  // jump to (placed by _tlPlaceGhost); under the real playhead so that paints over it
  _tlGhost = {
    line: _tlMk('line', { x1: 0, y1: 0, x2: 0, y2: H, stroke: '#ffffff', 'stroke-opacity': '0.35', 'stroke-width': 1, visibility: 'hidden', 'pointer-events': 'none' }),
    tri:  _tlMk('polygon', { points: '0,0', fill: '#e6e6e6', 'fill-opacity': '0.45', visibility: 'hidden', 'pointer-events': 'none' }),
  };
  els.svg.appendChild(_tlGhost.line);
  els.svg.appendChild(_tlGhost.tri);
  // Playhead: a line with a small cap at the top, placed by _tlPlacePlayhead
  _tlPh = {
    line: _tlMk('line', { x1: 0, y1: 0, x2: 0, y2: H, stroke: '#ffffff', 'stroke-opacity': '0.9', 'stroke-width': 1 }), // see the divider note
    tri:  _tlMk('polygon', { points: '0,0', fill: '#e6e6e6' }),
  };
  els.svg.appendChild(_tlPh.line);
  els.svg.appendChild(_tlPh.tri);
  if (_tlHoverKey) _tlHighlightLane(_tlHoverKey);
  _tlPlaceGhost(_tlGhostSec); // a rebuild under a still pointer keeps the ghost where it was
}

// Move a playhead marker to x, writing only what changed. Both markers are
// re-placed on every render and on every pointer move over the lanes, and the
// snapped position lands on the same pixel column for many of those, so the
// five attribute writes were mostly redundant.
function _tlPlaceMarker(m, x, on) {
  if (m._ocOn !== on) {
    m._ocOn = on;
    m.line.setAttribute('visibility', on ? 'visible' : 'hidden');
    m.tri.setAttribute('visibility',  on ? 'visible' : 'hidden');
  }
  if (!on) return;
  x = Math.round(x) + 0.5;
  if (m._ocX === x) return;
  m._ocX = x;
  m.line.setAttribute('x1', x);
  m.line.setAttribute('x2', x);
  m.tri.setAttribute('points', (x - 3.5) + ',0 ' + (x + 3.5) + ',0 ' + x + ',4');
}

function _tlPlacePlayhead(s) {
  if (!_tlPh || !_tlGeo || !s.tl || typeof s.tl.ph !== 'number') return;
  var g = _tlGeo, x = _tlX(s.tl.ph, g);
  _tlPlaceMarker(_tlPh, x, x >= 0 && x <= g.W);
}

// Ghost playhead at sec (sequence seconds), hidden with null. Snaps to the same
// frame or keyframe the press would land on, so it shows exactly where the
// playhead will go.
function _tlPlaceGhost(sec) {
  _tlGhostSec = (typeof sec === 'number') ? sec : null;
  if (!_tlGhost || !_tlGeo) return;
  var g = _tlGeo, x = _tlGhostSec === null ? -1 : _tlX(_tlGhostSec, g);
  _tlPlaceMarker(_tlGhost, x, x >= 0 && x <= g.W);
}

// Select or deselect a property for baking: the row click, and a double press
// on the property's lane in the mini timeline.
function _togglePropKey(key) {
  var s2 = getState();
  // A baked (green) row stays green: toggling does nothing unless the
  // playhead is over another, unbaked pair of this property, in which
  // case it selects normally (blue) so that pair can be baked too.
  var isBakedRow = (s2.bakedParamKeys || []).indexOf(key) >= 0;
  var isValidRow = (s2.validParamKeys || []).indexOf(key) >= 0;
  if (isBakedRow && !isValidRow) return;
  var keys = (s2.selectedParamKeys || []).slice();
  var idx  = keys.indexOf(key);
  if (idx >= 0) keys.splice(idx, 1);
  else          keys.push(key);
  // Flip the status here too (like the strip click does): the CEP host
  // answers "unchanged" while the timeline is still, and that answer
  // leaves the state alone, so Go would otherwise stay grey until the
  // heartbeat scan (~2s, longer when the idle panel's timer is throttled)
  var valid  = s2.validParamKeys || [];
  var active = keys.filter(function(k){ return valid.indexOf(k) >= 0; }).length;
  var upd = { selectedParamKeys: keys };
  if (s2.status === 'valid' || s2.status === 'no-selection') upd.status = active > 0 ? 'valid' : 'no-selection';
  setState(upd);
}

// Lane highlight: a hovered row lights its lane, a hovered lane lights its row
// Light one lane, from the lanes' own pointermove and from a row's mouseenter.
// Only the two lanes involved change, and an unchanged key does nothing: this
// used to rewrite every lane's fill on every pointer move.
var _tlLitKey = null; // lane currently lit (reset by _tlBuild with _tlLanes)
function _tlHighlightLane(key) {
  key = key || null;
  if (_tlLitKey === key) return;
  for (var i = 0; i < _tlLanes.length; i++) {
    var l = _tlLanes[i];
    if (l.key === _tlLitKey) l.bg.setAttribute('fill', l.fill);
    if (l.key === key)       l.bg.setAttribute('fill', l.hover);
  }
  _tlLitKey = key;
}
function _tlRowHover(key) {
  if (_tlHoverKey === key) return;
  if (_tlHoverKey) { var old = document.querySelector('.prop-btn[data-key="' + _tlHoverKey + '"]'); if (old) old.classList.remove('tl-hover'); }
  _tlHoverKey = key || null;
  if (key) { var row = document.querySelector('.prop-btn[data-key="' + key + '"]'); if (row) row.classList.add('tl-hover'); }
}

// Property name and clip-relative time under the pointer, shown in the status
// strip in place of its message (renderUI swaps it in while _tlHoverText is set)
var _tlHoverInfo = null; // { t, lane } under the pointer, for the value readout
var _tlValText   = '';   // the property's value at the hovered time, once the host has answered
var _tlValReq    = 0;    // request counter: an answer for an older position is dropped
var _tlValBusy   = false, _tlValNext = null;
function _tlShowReadout(t, lane) {
  var info = (t && lane) ? { t: t, lane: lane } : null;
  var moved = !_tlHoverInfo || !info || _tlHoverInfo.lane.key !== info.lane.key || _tlHoverInfo.t.sec !== info.t.sec;
  _tlHoverInfo = info;
  if (!info) { _tlValText = ''; _tlValNext = null; _tlValReq++; }
  else if (moved) _tlRequestValue(info);
  _tlComposeReadout();
}
function _tlComposeReadout() {
  var text = '', h = _tlHoverInfo;
  if (h) {
    var s = getState(), fps = (s.tl && s.tl.fps) || 25;
    var rel = h.t.sec - (s.tl ? s.tl.clipStart : 0);
    text = (h.lane.label || h.lane.name) + (h.t.kf ? ' · keyframe' : '') + ' · ' + rel.toFixed(2) + 's · frame ' + Math.round(rel * fps)
         + (_tlValText ? ' · ' + _tlValText : '');
  }
  if (text === _tlHoverText) return;
  _tlHoverText = text;
  // Only the strip's text changes, so write that rather than run a full
  // renderUI on every pointer move over the lanes
  var txt = document.getElementById('status-text'), clipEl = document.getElementById('status-clip');
  if (!txt) return;
  var s = getState();
  txt.textContent = _statusMsg(s, !!clipEl && clipEl.style.display !== 'none' && !!s.clipName);
}
// The property's value under the pointer (what Premiere interpolates there, so
// it reflects the baked keyframes). One host read in flight at a time; the
// latest position waits its turn. _tlValueAt is per edition.
function _tlRequestValue(info) {
  if (_tlValBusy) { _tlValNext = info; return; }
  var s = getState();
  var p = (s.availableParams || []).filter(function(a) { return a.key === info.lane.key; })[0];
  if (!p) return;
  // Keyframes are in media time; on a clip with a speed change one sequence
  // second is `speed` media seconds (clipIn is the media in-point)
  var mediaSec = s.tl ? (s.tl.clipIn || 0) + (info.t.sec - (s.tl.clipStart || 0)) * (s.tl.speed || 1) : info.t.sec;
  var id = ++_tlValReq;
  _tlValBusy = true;
  function done(v) {
    _tlValBusy = false;
    if (id === _tlValReq && _tlHoverInfo) {
      var txt = _fmtParamValue(v, info.lane.name);
      if (txt !== _tlValText) { _tlValText = txt; _tlComposeReadout(); }
    }
    if (_tlValNext) { var n = _tlValNext; _tlValNext = null; if (_tlHoverInfo) _tlRequestValue(n); }
  }
  try {
    _tlValueAt(p, mediaSec).then(done, function() { done(null); });
  } catch(e) { done(null); }
}
function _fmtParamValue(v, name) {
  function num(n) {
    var s = Math.abs(n) >= 100 ? n.toFixed(1) : n.toFixed(2);
    if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/[.]$/, '');
    return s === '-0' ? '0' : s;
  }
  if (typeof v === 'number' && isFinite(v)) {
    // Audio Level (the Volume effect's second parameter) is stored as a gain,
    // 0.178 = 0 dB: show it in dB as Effect Controls does
    if (/^Internal Volume\b.* 1$/.test(name || '')) return v > 0 ? num(20 * Math.log(v) / Math.LN10 + 15) + ' dB' : '-\u221e dB';
    var unit = /opacity|scale/i.test(name || '') ? '%' : /rotation|skew/i.test(name || '') ? '\u00b0' : '';
    return num(v) + unit;
  }
  if (Array.isArray(v) && v.length >= 2 && typeof v[0] === 'number' && typeof v[1] === 'number') return num(v[0]) + ', ' + num(v[1]);
  return '';
}

// Right after a bake: give each baked row's lane its green bar now instead of
// waiting for the next poll (polling pauses while "Done" shows, so the bar
// otherwise trailed the green row by a second or more). The bracket that was
// baked is the span; the scan replaces these with the real records afterwards.
// ids (the host's new record id per key) and curve go on the rows too, so their
// Undo, Load Curve and Replace buttons work at once: until 2.1.0 a row Undo
// pressed before the next scan found no bakeIds and did nothing.
function _tlSpansAfterBake(s, keys, ids, curve) {
  return (s.availableParams || []).map(function(p) {
    if (keys.indexOf(p.key) < 0) return p;
    var q = Object.assign({}, p);
    if (typeof p.tlKf0 === 'number' && typeof p.tlKf1 === 'number') q.tlSpans = (p.tlSpans || []).concat([[p.tlKf0, p.tlKf1]]);
    if (ids && ids[p.key]) {
      q.bakeIds = (p.bakeIds || []).concat([ids[p.key]]);
      if (curve) q.bakeCurve = _cloneCurve(curve);
    }
    return q;
  });
}

// Whole clip <-> just the keyframes. Toggled from the timeline's right-click menu.
function _tlSetZoom(keys) {
  _tlZoomKeys = !!keys;
  localStorage.setItem(_TL_ZOOM_KEY, _tlZoomKeys ? 'keys' : 'clip');
  _tlRender(getState(), true);
}
// Settings > Timeline. With the strip off only the property rows remain in the
// row and take its full width. Inline display: UXP doesn't relayout on class changes
function _applyTimelineVisibility() {
  var root = document.getElementById('oc-timeline');
  if (!root) return;
  ['.tl-canvas-wrap', '#tl-prop-handle'].forEach(function(sel) {
    var el = root.querySelector(sel);
    if (el) el.style.display = _tlVisible ? '' : 'none';
  });
  // Without the lanes there is nothing for the strip to run under, so the bottom
  // row stacks: status strip on top, Go (full width) beneath it. The divider
  // between them only continues the lanes/rows handle, so it goes too.
  var bottom = document.getElementById('oc-bottom-row');
  if (bottom) bottom.style.flexDirection = _tlVisible ? '' : 'column';
  var div = bottom ? bottom.querySelector('.bottom-divider') : null;
  if (div) div.style.display = _tlVisible ? '' : 'none';
  _tlApplyPropsWidth();
  _tlApplyHeightStyle(); // the undragged floor belongs to the lanes, not the bare rows
  if (_tlVisible) { _tlSig = ''; _tlRender(getState(), true); }
}
// Height of the lanes + rows area: the dragged height, else the rows' own but
// never under _TL_DEF_H, so a fresh panel opens with a usable strip instead of
// one row. The floor is only there while the lanes show; with the timeline off
// the rows size themselves. With a fixed height the inner flex row is kept at
// least the box tall so the column handle spans it, and the lanes + rows scroll
// together beyond it.
function _tlApplyHeightStyle() {
  var els = _tlEls;
  if (!els) return;
  var floorH = (!_tlUserH && _tlVisible) ? _TL_DEF_H + 'px' : '';
  els.root.style.height    = _tlUserH ? _tlUserH + 'px' : '';
  els.root.style.minHeight = floorH;
  if (els.inner) els.inner.style.minHeight = _tlUserH ? (els.scroll ? els.scroll.clientHeight + 'px' : '') : floorH;
}
// `live` = mid-drag: only the box height changes, so just stretch the SVG and
// the playhead line. A full lane rebuild plus a localStorage write per pointer
// move made the drag crawl in UXP; those happen once on release.
function _tlApplyHeight(live) {
  var els = _tlEls;
  if (!els) return;
  _tlApplyHeightStyle();
  if (live) {
    if (_tlGeo) {
      var H = Math.max(_TL_MIN_H, _tlGeo.n * _TL_ROW_H, els.scroll ? els.scroll.clientHeight : 0);
      _tlGeo.H = H;
      els.svg.setAttribute('height', H);
      if (_tlPh) _tlPh.line.setAttribute('y2', H);
      if (_tlGhost) _tlGhost.line.setAttribute('y2', H);
    }
    return;
  }
  if (_tlUserH) localStorage.setItem(_TL_H_KEY, _tlUserH); else localStorage.removeItem(_TL_H_KEY);
  _tlRender(getState(), true);
}
// Property column width: the saved value beside the strip, the whole row without it.
// Saved on its own key so it is independent of the preset column's width. The Go
// button in the bottom row is kept the same width, so it sits under the rows and
// the status strip runs under the lanes; the same divider sizes both.
// Nothing saved: _TL_PROPS_FRAC of the row, so the lanes and the rows open 60/40.
function _tlDefaultPropsWidth() {
  var row = document.getElementById('oc-timeline');
  var w   = row ? row.clientWidth : 0;
  if (w <= 0) return _TL_PROPS_DEF;
  return Math.max(_TL_PROPS_MIN, Math.round(w * _TL_PROPS_FRAC));
}
function _tlSavedPropsWidth() {
  var w = parseInt(localStorage.getItem(_TL_PROPS_KEY), 10);
  return Math.min(w >= _TL_PROPS_MIN ? w : _tlDefaultPropsWidth(), _tlMaxPropsW());
}
// Go is as wide as the property column plus whatever a vertical scrollbar in
// #tl-scroll takes: the scrollbar narrows the rows' column, so without this Go's
// left edge (and the divider beside it) drifted out of line with the handle above.
// Measured from the rows' actual left edge to the bottom row's right edge with
// bounding rects (offsetWidth - clientWidth reports 0 for the scrollbar in UXP).
// Called after every render, since the scrollbar comes and goes with the row count.
function _tlSetGoWidth() {
  var go = document.querySelector('.go-row');
  if (!go) return;
  if (!_tlVisible) {
    // Timeline off: the strip is stacked above Go, which spans the whole row
    if (go.style.width !== 'auto') { go.style.width = 'auto'; go.style.flex = '0 0 auto'; }
    return;
  }
  // _tlVisible is true here: the branch above returns otherwise
  var w = _tlPropsW;
  try {
    var props = document.getElementById('prop-btns');
    var pr = props ? props.getBoundingClientRect() : null;
    var rr = go.parentNode ? go.parentNode.getBoundingClientRect() : null;
    if (pr && rr && pr.width > 0 && rr.right > pr.left) w = Math.round(rr.right - pr.left);
  } catch(_) {}
  if (go.style.width === w + 'px') return;
  go.style.width = w + 'px';
  go.style.flex  = '0 0 ' + w + 'px';
}
function _tlApplyPropsWidth() {
  var props = document.getElementById('prop-btns');
  if (!props) return;
  var w = _tlSavedPropsWidth();
  _tlPropsW = w;
  // Change-only writes, matching the UXP edition: this runs from the .main-row
  // ResizeObserver and UXP relayouts the panel on every style write
  var want = _tlVisible ? { width: w + 'px', flex: '0 0 ' + w + 'px', maxWidth: '' }
                        : { width: '',       flex: '1 1 auto',        maxWidth: 'none' };
  Object.keys(want).forEach(function(k) { if (props.style[k] !== want[k]) props.style[k] = want[k]; });
  _tlSetGoWidth(); // Go keeps the column's width even with the timeline off
}

function _tlInit() {
  var root = document.getElementById('oc-timeline');
  if (!root) return;
  _tlEls = { root: root, scroll: document.getElementById('tl-scroll'), inner: root.querySelector('.tl-scroll-inner'),
             wrap: root.querySelector('.tl-canvas-wrap'), svg: document.getElementById('tl-svg'),
             empty: document.getElementById('tl-empty'),
             fade: document.getElementById('tl-fade'), fadeTop: document.getElementById('tl-fade-top') };
  if (_tlEls.scroll) _tlEls.scroll.addEventListener('scroll', _tlUpdateFade);
  var svg = _tlEls.svg;
  function measure() {
    var rect = _tlEls.wrap.getBoundingClientRect();
    var w = Math.floor(rect.width);
    if (w < 20 || w === _tlW) return;
    _tlW = w;
    _tlRender(getState(), true);
  }
  // One measure per frame: dragging the width handle fires the observer on every move
  var _measurePending = false;
  function measureSoon() {
    if (_measurePending) return;
    _measurePending = true;
    requestAnimationFrame(function() { _measurePending = false; measure(); });
  }
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(measureSoon).observe(_tlEls.wrap);
  function pos(e) { var r = svg.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  function laneAt(y) {
    var g = _tlGeo;
    if (!g || !g.n) return -1;
    var i = Math.floor((y - g.y0) / g.laneH);
    return (i < 0 || i >= g.n) ? -1 : i;
  }
  // Where a press at x lands: a keyframe within a few px snaps, else the nearest frame inside the clip
  function target(x, laneIdx) {
    var s = getState(), g = _tlGeo;
    if (!g || !g.n || !s.tl) return null;
    var lane = laneIdx >= 0 ? _tlLanes[laneIdx] : null, snap = null;
    if (lane) lane.kf.forEach(function(k) {
      if (Math.abs(k.x - x) <= _TL_SNAP_PX && (!snap || Math.abs(k.x - x) < Math.abs(snap.x - x))) snap = k;
    });
    var fps = s.tl.fps || 25;
    var sec = snap ? snap.t : Math.round(_tlSec(x, g) * fps) / fps;
    sec = Math.max(s.tl.clipStart, Math.min(s.tl.clipEnd - 1 / fps, sec));
    return { sec: sec, kf: !!snap };
  }
  // Press and release without moving = jump (no scrubbing, one jump per press).
  // A second press on the same lane within _TL_DBL_MS toggles that property for
  // baking, like clicking its row (the first press already moved the playhead
  // there, so the row is usually blue by the time it is selected). The double
  // press is recognised on the second press-down, not its release: the first
  // press moves the playhead, the next poll rebuilds the strip's SVG ~100ms
  // later, and that rebuild can drop a pointerleave right under the second
  // press, which used to cancel it. A native dblclick is honoured too where the
  // host sends one, with a guard so the two paths can't toggle twice.
  var down = null, lastUp = null, lastToggle = 0;
  function toggleLane(li) {
    if (li < 0 || !_tlLanes[li]) return;
    if (Date.now() - lastToggle < 300) return;
    lastToggle = Date.now();
    lastUp = null; down = null;
    _togglePropKey(_tlLanes[li].key);
  }
  svg.addEventListener('pointerdown', function(e) {
    if (e.button !== 0) return;
    var p = pos(e), li = laneAt(p.y), now = Date.now();
    if (lastUp && li >= 0 && lastUp.lane === li && now - lastUp.t < _TL_DBL_MS && Math.abs(p.x - lastUp.x) < 12) {
      toggleLane(li);
      return;
    }
    down = p;
    try { svg.setPointerCapture(e.pointerId); } catch(_) {} // the release reaches us even if the SVG is rebuilt under the pointer
  });
  svg.addEventListener('pointerup', function(e) {
    // Let go of the capture: UXP doesn't seem to on its own, and a held capture
    // keeps sending every later move here instead of a pointerleave
    try { svg.releasePointerCapture(e.pointerId); } catch(_) {}
    if (!down) return;
    var p = pos(e), moved = Math.abs(p.x - down.x) > 4 || Math.abs(p.y - down.y) > 4;
    down = null;
    if (moved) { lastUp = null; return; }
    var li = laneAt(p.y);
    lastUp = { t: Date.now(), x: p.x, lane: li };
    var t = target(p.x, li);
    if (t) _jumpToParam({ jumpSec: t.sec });
  });
  svg.addEventListener('dblclick', function(e) { toggleLane(laneAt(pos(e).y)); });
  // Over the visible lanes: across the SVG, and down the scroll box only (the SVG
  // runs on beneath it while the rows are scrolled)
  function overLanes(e) {
    var r = svg.getBoundingClientRect(), b = _tlEls.scroll ? _tlEls.scroll.getBoundingClientRect() : r;
    return e.clientX >= r.left && e.clientX < r.right && e.clientY >= b.top && e.clientY < b.bottom;
  }
  svg.addEventListener('pointermove', function(e) {
    if (!overLanes(e)) { leave(); return; } // a held capture sends moves from outside the lanes
    var p = pos(e), li = laneAt(p.y), t = target(p.x, li);
    var lane = li >= 0 ? _tlLanes[li] : null;
    _tlHighlightLane(lane ? lane.key : null);
    _tlRowHover(lane ? lane.key : null);
    _tlShowReadout(t, lane);
    _tlPlaceGhost(t ? t.sec : null);
  });
  function leave() { _tlHighlightLane(null); _tlRowHover(null); _tlShowReadout(null); _tlPlaceGhost(null); } // a press in flight is kept: a rebuild can fire this mid-press
  svg.addEventListener('pointerleave', leave);
  svg.addEventListener('mouseleave',   leave);
  // The CCX left the ghost playhead (and the readout) up after the pointer left
  // the lanes, so the lanes can't rely on pointerleave: while their hover state
  // is up, a move anywhere else in the panel clears it too. This runs before a
  // row's own handlers, so a row the pointer went straight onto gets its lane
  // lit again.
  document.addEventListener('pointermove', function(e) {
    if (_tlGhostSec === null && !_tlHoverInfo && !_tlHoverKey) return;
    if (overLanes(e)) return;
    leave();
    var row = e.target && e.target.closest ? e.target.closest('.prop-btn') : null;
    if (row && row.dataset && row.dataset.key) _tlHighlightLane(row.dataset.key);
  }, true);
  // Handle between the lanes and the property rows drags the rows' width (same
  // pattern as the sidebar handle; the lanes re-measure through the ResizeObserver)
  var handle = document.getElementById('tl-prop-handle');
  var props  = document.getElementById('prop-btns');
  if (handle && props) {
    var _rx = 0, _rw = 0, _resizing = false;
    handle.addEventListener('pointerdown', function(e) {
      _resizing = true;
      _rx = e.clientX;
      _rw = props.offsetWidth;
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    handle.addEventListener('pointermove', function(e) {
      if (!_resizing) return;
      var w = Math.max(_TL_PROPS_MIN, Math.min(_tlMaxPropsW(), _rw + (_rx - e.clientX)));
      props.style.width = w + 'px';
      props.style.flex  = '0 0 ' + w + 'px';
      _tlPropsW = w;
      _tlSetGoWidth();
    });
    function _endResize() {
      if (_resizing) localStorage.setItem(_TL_PROPS_KEY, props.offsetWidth);
      _resizing = false;
    }
    handle.addEventListener('pointerup',     _endResize);
    handle.addEventListener('pointercancel', _endResize);
  }
  // Handle above the area drags its height (up = taller; the graph / preset
  // area keeps _TL_MAIN_MIN). A double press goes back to the default height.
  var vhandle = document.getElementById('tl-resize');
  if (vhandle) {
    var _vy = 0, _vh = 0, _vresizing = false, _vLastUp = 0;
    vhandle.addEventListener('pointerdown', function(e) {
      _vresizing = true;
      _vy = e.clientY;
      _vh = root.offsetHeight;
      vhandle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    // Moves are coalesced to one layout per frame (UXP relayouts the graph
    // above on every height change, which is the slow part)
    var _vTargetY = 0, _vPending = false;
    vhandle.addEventListener('pointermove', function(e) {
      if (!_vresizing) return;
      _vTargetY = e.clientY;
      if (_vPending) return;
      _vPending = true;
      requestAnimationFrame(function() {
        _vPending = false;
        if (!_vresizing) return;
        var app = document.getElementById('app'), bottom = document.getElementById('oc-bottom-row');
        var maxH = Math.max(_TL_MIN_H, (app ? app.clientHeight : 600) - _TL_MAIN_MIN - (bottom ? bottom.offsetHeight : 0) - vhandle.offsetHeight);
        _tlUserH = Math.max(_TL_MIN_H, Math.min(maxH, _vh + (_vy - _vTargetY)));
        _tlApplyHeight(true);
      });
    });
    function _vEnd(e) {
      if (!_vresizing) return;
      _vresizing = false;
      var now = Date.now();
      if (now - _vLastUp < _TL_DBL_MS) { _vLastUp = 0; _tlUserH = null; _tlApplyHeight(); return; } // double press: back to the default height
      _vLastUp = now;
      _tlApplyHeight();
    }
    vhandle.addEventListener('pointerup',     _vEnd);
    vhandle.addEventListener('pointercancel', _vEnd);
  }
  _tlApplyHeight();
  _applyTimelineVisibility();
  measure();
}

// ─── Tooltips ─────────────────────────────────────────────────────────────
// Custom tooltips (native `title` is unreliable in UXP and can spill outside
// the panel). Shows after a short hover delay, clamped inside the panel, below
// the element or above it when there's no room. `text` may be a function so
// the label can depend on current state; return '' to show nothing.
var _tipEl = null, _tipTimer = null;
function _hideTooltip() {
  if (_tipTimer) { clearTimeout(_tipTimer); _tipTimer = null; }
  if (_tipEl && _tipEl.parentNode) _tipEl.parentNode.removeChild(_tipEl);
  _tipEl = null;
}
// side 'right': beside the element, vertically centred on it (the tool column
// down the graph's left side, where a tip below would cover the next button).
// The height is the stylesheet's (13px x 1.3 + 10px padding + 2px border).
var _TIP_H = 29;
function _showTooltip(el, text, side) {
  _hideTooltip();
  if (!text) return;
  var tip = document.createElement('div');
  tip.className = 'oc-tooltip';
  tip.textContent = text;
  var r  = el.getBoundingClientRect();
  var ww = document.documentElement.clientWidth  || document.body.clientWidth;
  var wh = document.documentElement.clientHeight || document.body.clientHeight;
  var gap = 6, pad = 4;
  // UXP can't be relied on to report offsetWidth/Height synchronously, so never
  // position from measurements. Anchor to whichever edge is nearer instead:
  // the tooltip then grows away from that edge and can't cross it, and
  // max-width + wrapping stops it crossing the far edge.
  var cx = r.left + r.width / 2;
  var estW = Math.min(ww - pad * 2, text.length * 7 + 18); // rough width for centring only
  tip.style.maxWidth = (ww - pad * 2) + 'px';
  if (cx < ww / 2) {
    tip.style.left  = Math.max(pad, Math.round(cx - estW / 2)) + 'px';
    tip.style.right = 'auto';
  } else {
    tip.style.right = Math.max(pad, Math.round(ww - cx - estW / 2)) + 'px';
    tip.style.left  = 'auto';
  }
  var estH = 24;
  if (r.bottom + gap + estH <= wh - pad) {
    tip.style.top    = Math.round(r.bottom + gap) + 'px';   // below the element
    tip.style.bottom = 'auto';
  } else {
    tip.style.bottom = Math.round(wh - r.top + gap) + 'px'; // above, anchored to its top edge
    tip.style.top    = 'auto';
  }
  if (side === 'right') {
    tip.style.left     = Math.round(r.right + gap) + 'px';
    tip.style.right    = 'auto';
    tip.style.maxWidth = Math.max(60, Math.round(ww - r.right - gap - pad)) + 'px';
    tip.style.top      = Math.max(pad, Math.min(wh - pad - _TIP_H, Math.round(r.top + r.height / 2 - _TIP_H / 2))) + 'px';
    tip.style.bottom   = 'auto';
  }
  document.body.appendChild(tip);
  _tipEl = tip;
}
// Pressed look for the small row buttons (pin / undo): CSS :active is not
// reliable in UXP, so a .pressed class follows the pointer instead
function _addPressState(el) {
  if (!el) return;
  function up() { el.classList.remove('pressed'); }
  el.addEventListener('pointerdown', function(e) { if (e.button === 0) el.classList.add('pressed'); });
  el.addEventListener('pointerup', up);
  el.addEventListener('pointerleave', function() { up(); el.classList.remove('hover'); });
  el.addEventListener('pointercancel', up);
  // Hover mirrored as a class: UXP applies compound :hover rules unreliably
  el.addEventListener('pointerenter', function() { el.classList.add('hover'); });
}

// Row / status-strip marker: a hollow diamond, a filled diamond or a tick.
// Both shapes live in the SVG and are toggled with opacity + visibility
// attributes (UXP can't rebuild SVG via innerHTML and ignores class swaps).
function _setMarker(host, mode) {
  if (!host) return;
  // Called for every row and the strip on every render (10Hz during playback).
  // The mode rarely changes, so skip the two querySelectors and six attribute
  // writes when it hasn't.
  if (host._ocMark === mode) return;
  host._ocMark = mode;
  var d = host.querySelector('.mk-diamond'), t = host.querySelector('.mk-tick');
  var tick = mode === 'tick';
  if (d) {
    d.setAttribute('fill', mode === 'filled' ? 'currentColor' : 'none');
    d.setAttribute('opacity',    tick ? '0' : '1');
    d.setAttribute('visibility', tick ? 'hidden' : 'visible');
  }
  if (t) {
    t.setAttribute('opacity',    tick ? '1' : '0');
    t.setAttribute('visibility', tick ? 'visible' : 'hidden');
  }
}

function _attachTooltip(el, text, side) {
  if (!el) return;
  var DELAY = 500;
  el.addEventListener('mouseenter', function() {
    if (_tipTimer) clearTimeout(_tipTimer);
    _tipTimer = setTimeout(function() {
      _tipTimer = null;
      var t = typeof text === 'function' ? text() : text;
      _showTooltip(el, t, typeof side === 'function' ? side() : side); // side may depend on where el is
    }, DELAY);
  });
  el.addEventListener('mouseleave',  _hideTooltip);
  el.addEventListener('pointerdown', _hideTooltip);
}

// Properties are ready under the playhead but none of them is selected (the
// status strip offers "Click to select all properties"): Go keeps its grey
// look then, but its first press selects them all, the same as the strip, so a second press
// (or Enter twice) bakes them.
function _goSelectsAll(s) {
  return !!s && s.status === 'no-selection' && !s.isBaking && (s.validParamKeys || []).length > 0;
}
// The playhead is outside every keyframe pair ("Move playhead between
// keyframes"): Go stays grey, but a press jumps to the nearest pair, the same
// as a click on the status strip
function _goJumps(s) {
  return !!s && s.status === 'outside' && !s.isBaking && !!_nearestJumpParam(s);
}
// Select every property that is ready to bake (the status strip's click, and
// Go's first press while nothing is selected)
function _selectAllValid(s) {
  var valid = s.validParamKeys || [];
  if (!valid.length) return;
  var up = { selectedParamKeys: valid.slice() };
  if (s.status === 'no-selection') up.status = 'valid';
  setState(up);
}

function renderUI(s) {
  var propBtns = document.getElementById('prop-btns');
  if (propBtns) {
    var params  = s.availableParams || [];
    var curKeys = propBtns.dataset.keys || '';
    // The display name is part of the signature: keys are compIdx_propIdx, so
    // swapping one effect for another can land a different property on the same
    // key and the row would keep the old label (the lanes already follow the name).
    // A key can never contain '~', so the two halves stay unambiguous.
    var newKeys = params.map(function(p){ return p.key + '~' + (p.label || p.displayName || ''); }).join(',');
    if (curKeys !== newKeys) {
      _hideTooltip(); // rows are being replaced; don't leave a tooltip for a removed pin
      propBtns.innerHTML = '';
      propBtns.dataset.keys = newKeys;
      params.forEach(function(p) {
        var btn = document.createElement('div');
        btn.className = 'prop-btn';
        // Diamond marker (matches the status strip) + truncating label
        var propDiamond = document.createElement('span');
        propDiamond.className = 'prop-diamond';
        propDiamond.innerHTML = '<svg width="10" height="10" viewBox="-1 -1 10 10" fill="none"><polygon class="mk-diamond" points="4,0.9 7.1,4 4,7.1 0.9,4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path class="mk-tick" d="M0.7 4.4 L3.1 6.8 L7.4 1.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" opacity="0" visibility="hidden"/></svg>';
        var propLabel = document.createElement('span');
        propLabel.className = 'prop-label';
        propLabel.textContent = p.label || p.displayName;
        btn.appendChild(propDiamond);
        btn.appendChild(propLabel);
        // Undo: remove the keyframes a bake added to this property. Hidden unless
        // the row has a bake record (display is toggled inline in the sync pass).
        var propUndo = document.createElement('span');
        propUndo.className = 'prop-undo';
        _addPressState(propUndo);
        propUndo.style.display = 'none';
        _attachTooltip(propUndo, 'Undo the bake on this property');
        propUndo.innerHTML = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M2.4 5H8.3a3.3 3.3 0 010 6.6H5.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 2.4L2.4 5l2.6 2.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        propUndo.addEventListener('click', function(ev) {
          ev.stopPropagation();
          _undoBakeForKey(p.key);
        });
        // Curve: put the curve that was baked here back on the graph. Shown
        // next to the undo button whenever the row's bake record has one.
        var propCurve = document.createElement('span');
        propCurve.className = 'prop-curve';
        _addPressState(propCurve);
        propCurve.style.display = 'none';
        _attachTooltip(propCurve, 'Load the curve that was baked on this property');
        propCurve.innerHTML = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M2.5 11.5C6 11.5 8 2.5 11.5 2.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="2.5" cy="11.5" r="1.6" fill="currentColor"/><circle cx="11.5" cy="2.5" r="1.6" fill="currentColor"/></svg>';
        propCurve.addEventListener('click', function(ev) {
          ev.stopPropagation();
          _loadBakedCurve(p.key);
        });
        // Replace: write the graph's current curve in place of this bake.
        // Shown with the undo button, on every baked row; dimmed while the graph
        // still holds the curve that bake used (_styleReplaceBtn, sync pass).
        var propReplace = document.createElement('span');
        propReplace.className = 'prop-replace';
        _addPressState(propReplace);
        propReplace.style.display = 'none';
        _attachTooltip(propReplace, function() {
          return propReplace.classList.contains('btn-dim')
            ? 'Choose a different curve to replace this bake'
            : 'Replace this bake with the current curve';
        });
        propReplace.innerHTML = _icReplace;
        propReplace.addEventListener('click', function(ev) {
          ev.stopPropagation();
          _replaceBakeForKey(p.key);
        });
        // Pin: jump the playhead to this property's keyframes (doesn't toggle selection)
        var propPin = document.createElement('span');
        propPin.className = 'prop-pin';
        _addPressState(propPin);
        _attachTooltip(propPin, 'Jump playhead to keyframes');
        propPin.innerHTML = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><line x1="1.5" y1="7" x2="9" y2="7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M6 3.8L9.2 7 6 10.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><line x1="12" y1="3.2" x2="12" y2="10.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
        propPin.addEventListener('click', function(ev) {
          ev.stopPropagation();
          // Rows persist across polls, so look up the latest jump time by key
          // rather than using the `p` captured when this row was built.
          var live = (getState().availableParams || []).filter(function(x){ return x.key === p.key; })[0];
          _jumpToParam(live || p);
        });
        btn.appendChild(propCurve);
        btn.appendChild(propReplace);
        btn.appendChild(propUndo);
        btn.appendChild(propPin);
        btn.dataset.key = p.key;
        // The sync pass below reads these instead of querying for them each tick
        btn._oc = { mark: propDiamond, pin: propPin, undo: propUndo, curve: propCurve, replace: propReplace };
        // Hovering a row lights its lane in the mini timeline (a hovered lane lights the row)
        btn.addEventListener('mouseenter', function() { _tlHighlightLane(p.key); });
        btn.addEventListener('mouseleave', function() { _tlHighlightLane(null); });
        btn.addEventListener('click', function() { _togglePropKey(p.key); });
        propBtns.appendChild(btn);
      });
    }
    // Sync active state. This runs on every render, which is every poll while
    // the playhead moves, so each row first checks whether anything it draws
    // actually changed: without that it cost four querySelectors, eight
    // classList writes and two inline display writes per row per tick.
    var selKeys   = s.selectedParamKeys || [];
    var bakedKeys = s.bakedParamKeys   || [];
    var validKeys = s.validParamKeys   || [];
    propBtns.querySelectorAll('.prop-btn').forEach(function(btn) {
      var k = btn.dataset.key;
      var isSel      = selKeys.indexOf(k) >= 0;
      var isBakedRow = bakedKeys.indexOf(k) >= 0;
      var isValid    = validKeys.indexOf(k) >= 0;
      var brow       = isBakedRow ? (s.availableParams || []).filter(function(x){ return x.key === k; })[0] : null;
      var hasCurve   = !!(brow && brow.bakeCurve);
      var replOk     = _replaceOk(brow, s.curve);
      var stateKey   = (isSel ? 's' : '') + (isBakedRow ? 'b' : '') + (isValid ? 'v' : '') + (hasCurve ? 'c' : '') + (replOk ? 'r' : '');
      if (btn._ocState === stateKey) return;
      btn._ocState = stateKey;
      // Children are cached on the row when it is built (_oc); the lookups are
      // a fallback for a row from an older render.
      var els = btn._oc || {};
      btn.classList.toggle('active', isSel);
      // Marker: a tick while selected or baked (green row); otherwise a filled
      // diamond when the playhead is already over this property's pair (the pin
      // is blue), hollow if not
      _setMarker(els.mark || btn.querySelector('.prop-diamond'), (isSel || isBakedRow) ? 'tick' : (isValid ? 'filled' : 'hollow'));
      // Selected but the playhead isn't between its keyframes yet: orange until it is
      btn.classList.toggle('pending', isSel && !isValid);
      // Playhead is already between this property's keyframes: pin shows blue even when unselected
      btn.classList.toggle('ready', isValid);
      btn.classList.toggle('baked', isBakedRow && !isSel);
      // The pin carries its own state classes: UXP doesn't restyle a child when
      // only the row's class changes, so ".prop-btn.baked .prop-pin" went stale
      var pinEl = els.pin || btn.querySelector('.prop-pin');
      if (pinEl) {
        pinEl.classList.toggle('pin-ready',   isValid);
        pinEl.classList.toggle('pin-active',  isSel);
        pinEl.classList.toggle('pin-pending', isSel && !isValid);
        pinEl.classList.toggle('pin-baked',   isBakedRow && !isSel);
      }
      // Undo button only on rows with a bake to undo (inline style: UXP ignores class-driven display changes)
      var undoEl = els.undo || btn.querySelector('.prop-undo');
      if (undoEl) { var ud = isBakedRow ? 'flex' : 'none'; if (undoEl.style.display !== ud) undoEl.style.display = ud; }
      var replEl = els.replace || btn.querySelector('.prop-replace');
      if (replEl) { var rd = isBakedRow ? 'flex' : 'none'; if (replEl.style.display !== rd) replEl.style.display = rd; _styleReplaceBtn(replEl, replOk); }
      var curveEl = els.curve || btn.querySelector('.prop-curve');
      if (curveEl) { var cd = hasCurve ? 'flex' : 'none'; if (curveEl.style.display !== cd) curveEl.style.display = cd; }
    });
  }

  var strip = document.getElementById('status-strip');
  var txt   = document.getElementById('status-text');
  if (strip && txt) {
    var cfg  = STATUS_CONFIG[s.status] || STATUS_CONFIG['idle'];
    var cls  = 'status-strip ' + cfg.cls;
    // Marker: hollow diamond while the playhead is outside every pair ("Move
    // playhead..."), a tick once properties are selected (blue), solid otherwise
    // (including "N properties ready")
    _setMarker(strip.querySelector('.status-dot'),
      s.status === 'outside' ? 'hollow' : s.status === 'valid' ? 'tick' : 'filled');
    // Clip name lives in its own span so a long name truncates on its own
    // instead of pushing the count off the end of the strip
    var clipEl   = document.getElementById('status-clip');
    var showClip = !!clipEl && !!cfg.clip && !!s.clipName;
    if (clipEl) {
      // Change-only, like the strip's class and text below: this whole block
      // runs on every render, and UXP relayouts the panel on any write
      var clipTxt = showClip ? s.clipName : '';
      var clipDsp = showClip ? 'block' : 'none'; // inline: UXP ignores class-driven display
      if (clipEl.textContent !== clipTxt) clipEl.textContent = clipTxt;
      if (clipEl.style.display !== clipDsp) clipEl.style.display = clipDsp;
    }
    // Colours inline: UXP doesn't restyle the dot/text/clip spans when only
    // the strip's class changes, so the ".status-valid .status-text" rules
    // left them stale. Same values as the CSS state variants.
    var _sc = {
      'status-idle':     { dot: '#555',    text: '#888'    },
      'status-warn':     { dot: '#555',    text: '#888'    },
      'status-detected': { dot: '#555',    text: '#888'    },
      'status-valid':    { dot: '#555',    text: '#888'    }, // grey like detected; the rows carry the blue
      'status-error':    { dot: '#ff9090', text: '#ff9090' },
      'status-done':     { dot: '#555',    text: '#888'    }, // grey; the green rows carry the result
    }[cfg.cls] || { dot: '#555', text: '#888' };
    var dotEl = strip.querySelector('.status-dot');
    if (dotEl && dotEl.style.color !== _sc.dot)  dotEl.style.color  = _sc.dot;
    if (txt.style.color !== _sc.text) txt.style.color = _sc.text;
    if (clipEl && clipEl.style.color !== _sc.text) clipEl.style.color = _sc.text;
    var msg  = _statusMsg(s, showClip);
    // Clickable whenever there are valid params: click selects all, click again clears
    var _vk = s.validParamKeys || [];
    if (_vk.length > 0 && s.status !== 'done' && !s.isBaking) cls += ' status-clickable';
    if (strip.className !== cls) strip.className = cls; // a class write restyles the strip's subtree
    if (txt.textContent !== msg) txt.textContent = msg;
  }

  var goBtn     = document.getElementById('go-btn');
  var goArrow   = document.getElementById('go-arrow');
  var goSpinner = document.getElementById('go-spinner');
  if (goBtn) {
    var activeContexts = (s.selectedParamKeys || []).filter(function(k){
      return (s.validParamKeys || []).indexOf(k) >= 0 && s.paramContexts && s.paramContexts[k];
    });
    var enabled = s.status === 'valid' && activeContexts.length > 0 && !s.isBaking;
    goBtn.classList.toggle('btn-disabled', !enabled);
    // Nothing selected yet: Go stays grey but its press selects everything
    // ready (see _goSelectsAll); go-select only swaps the not-allowed cursor
    // for a pointer
    goBtn.classList.toggle('go-select', _goSelectsAll(s) || _goJumps(s));
    var goLabel = document.getElementById('go-label');
    // Change-only: isBaking is false on all but a handful of renders
    var onD = s.isBaking ? 'none' : 'inline', spD = s.isBaking ? 'inline-block' : 'none';
    if (goArrow   && goArrow.style.display   !== onD) goArrow.style.display   = onD;
    if (goLabel   && goLabel.style.display   !== onD) goLabel.style.display   = onD;
    if (goSpinner && goSpinner.style.display !== spD) goSpinner.style.display = spD;
  }

  _tlRender(s);
}

// The status strip's message: the mini timeline's hover readout while the
// pointer is over a lane, else the state's text; a middle dot before it when
// the clip name is shown ahead of it.
function _statusMsg(s, showClip) {
  var cfg = STATUS_CONFIG[s.status] || STATUS_CONFIG['idle'];
  var msg = typeof cfg.text === 'function' ? cfg.text(s) : cfg.text;
  if (_tlHoverText) msg = _tlHoverText; // pointer over the mini timeline: what's under it
  return showClip ? '\u00b7 ' + msg : msg;
}

// ─── Panel init ───────────────────────────────────────────────────────────
function initPanel() {
  console.log('[OC] initPanel called');

  var svg = document.getElementById('bezier-svg');
  if (svg) {
    initGraphEditor(svg);
  }

  // A-curve (peak) mode toggle
  _tlInit(); // mini timeline strip along the bottom

  var peakBtn = document.getElementById('peak-mode');
  if (peakBtn) {
    _attachTooltip(peakBtn, 'A-curve mode', 'right');
    peakBtn.addEventListener('click', function() { _setPeakMode(!_peakMode); });
  }
  _stylePeakBtn();
  _applyPeakVisibility();

  // Bounce mode toggle (see _setBounceMode); its panel is #bounce-panel under the graph
  var bounceBtn = document.getElementById('bounce-mode');
  _bnInit();
  if (bounceBtn) {
    _attachTooltip(bounceBtn, 'Bounce mode', 'right');
    bounceBtn.addEventListener('click', function() { _setBounceMode(!_bounceMode); });
  }
  _styleBounceBtn();
  stateListeners.push(_bnOnState);

  // Add Point: splits the curve's widest segment; unavailable in A-curve mode
  var addPtBtn = document.getElementById('add-point');
  if (addPtBtn) {
    _attachTooltip(addPtBtn, 'Add a point to the curve', 'right');
    // In A-curve mode the point would have no handles to grab, so adding one switches back
    addPtBtn.addEventListener('click', function() { if (_peakMode) _setPeakMode(false); _addPoint(); });
  }

  // Flip / Invert: one-press curve transforms (see _flipCurve / _invertCurve)
  var flipBtn = document.getElementById('flip-curve');
  if (flipBtn) {
    _attachTooltip(flipBtn, 'Flip');
    flipBtn.addEventListener('click', function() { _applyCurveOp(_flipCurve); });
  }
  var invertBtn = document.getElementById('invert-curve');
  if (invertBtn) {
    _attachTooltip(invertBtn, 'Invert');
    invertBtn.addEventListener('click', function() { _applyCurveOp(_invertCurve); });
  }

  // Drag ghost: leave the starting shape behind while dragging (see _showDragGhost)
  var ghostBtn = document.getElementById('drag-ghost');
  if (ghostBtn) {
    _attachTooltip(ghostBtn, function() {
      return _dragGhost
        ? 'Ghost is on: the curve\'s starting shape stays behind while you drag. Click to turn off'
        : 'Ghost: show the curve\'s starting shape behind it while you drag';
    });
    ghostBtn.addEventListener('click', function() { _setDragGhost(!_dragGhost); });
  }
  _styleGhostBtn();

  // Numeric entry: type the handle coordinates (see _showNumericPanel)
  var numBtn = document.getElementById('numeric-entry');
  if (numBtn) {
    _attachTooltip(numBtn, 'Numeric Entry: type the handle coordinates');
    numBtn.addEventListener('click', function() { _showNumericPanel(); });
  }

  // Preset toolbar (top of the preset column): List/Grid toggle, the same
  // action as Settings; the file/paste actions live in the bar's menu button
  var layoutBtn = document.getElementById('preset-layout');
  if (layoutBtn) {
    _attachTooltip(layoutBtn, function() {
      return _presetLayout === 'list' ? 'Grid View: show presets as tiles' : 'List View: show presets as rows';
    });
    layoutBtn.addEventListener('click', function() {
      _presetLayout = _presetLayout === 'list' ? 'grid' : 'list';
      localStorage.setItem(_LAYOUT_KEY, _presetLayout);
      _applyPresetLayout(true);
    });
  }
  _styleLayoutBtn();
  // Graph / Timeline toggles: the same switches as Settings (see _setGraphVisible)
  var graphTog = document.getElementById('toggle-graph');
  if (graphTog) {
    _attachTooltip(graphTog, function() { return _graphVisible ? 'Graph is shown. Click to hide it' : 'Graph is hidden. Click to show it'; });
    graphTog.addEventListener('click', function() { _setGraphVisible(!_graphVisible); });
  }
  var tlTog = document.getElementById('toggle-timeline');
  if (tlTog) {
    _attachTooltip(tlTog, function() { return _tlVisible ? 'Timeline is shown. Click to hide it' : 'Timeline is hidden. Click to show it'; });
    tlTog.addEventListener('click', function() { _setTimelineVisible(!_tlVisible); });
  }
  _styleViewBtns();

  // Enter presses Go. UXP only delivers keydown to inputs and buttons, and
  // Premiere keeps Enter for itself unless a text field in the panel has
  // focus. So #oc-key-sink (a concealed read-only input in index.html) takes
  // focus on any press inside the panel that isn't on a real field, and the
  // key is read from it. CEP runs the same code; there the document listener
  // alone would do, but sharing keeps the two editions identical.
  var keySink = document.getElementById('oc-key-sink');
  function _isField(t) {
    var tag = t && t.tagName ? String(t.tagName).toLowerCase() : '';
    return t !== keySink && (tag === 'input' || tag === 'textarea' || tag === 'select' || !!(t && t.isContentEditable));
  }
  function _focusSink(why) {
    if (!keySink) return;
    try { keySink.focus(); } catch(_) {}
    var ok = document.activeElement === keySink;
    if (!ok) console.log('[OC] key sink focus (' + why + ') failed; active=' + (document.activeElement && document.activeElement.tagName));
  }
  // Focus on the press and again on release/click: UXP moves focus around
  // between the two, and a field the user is clicking keeps its own focus
  // A press that starts in a real field (selecting its text) must not hand
  // focus to the sink when it is released elsewhere, or the selection is lost
  document.addEventListener('pointerdown', function(e) {
    _ocPressInField = _isField(e.target);
    if (!_ocPressInField) setTimeout(function() { _focusSink('pointerdown'); }, 0);
  }, true);
  document.addEventListener('click', function(e) {
    if (_ocPressInField) return;
    if (!_isField(e.target)) setTimeout(function() { _focusSink('click'); }, 0);
  }, true);
  if (keySink) {
    // Nothing should ever be typed into it
    keySink.addEventListener('input', function() { keySink.value = ''; });
  }
  // Enter presses Go; everything else goes through _panelShortcut. Real fields
  // keep their keys, nothing fires while a modal is open, and chords with
  // Ctrl/Cmd/Alt are left to Premiere.
  function _onPanelKey(e) {
    if (e._ocSeen) return;
    e._ocSeen = true; // the sink's own listener and the document one both see it
    if (_isField(e.target)) return;
    var modal = !!(document.getElementById('settings-modal') || document.getElementById('oc-confirm')
                || document.getElementById('oc-numeric') || document.getElementById('_paste-box')
                || document.getElementById('oc-rename') || document.getElementById('oc-welcome'));
    var isEnter = e.key === 'Enter' || e.keyCode === 13 || e.which === 13 || e.code === 'Enter' || e.code === 'NumpadEnter';
    if (isEnter) {
      if (e.repeat || modal) return;
      var go = document.getElementById('go-btn');
      if (!go || (go.classList.contains('btn-disabled') && !_goSelectsAll(getState()) && !_goJumps(getState()))) { console.log('[OC] Enter: Go is disabled'); return; }
      e.preventDefault();
      console.log('[OC] Enter: pressing Go');
      go.click();
      return;
    }
    if (modal || e.ctrlKey || e.metaKey || e.altKey) return;
    if (_panelShortcut(e)) e.preventDefault();
  }
  if (keySink) {
    keySink.addEventListener('keydown', _onPanelKey);
  }
  document.addEventListener('keydown', _onPanelKey, true);

  // Full screen: the graph column takes the whole panel until pressed again
  var fullBtn = document.getElementById('graph-full');
  if (fullBtn) {
    _attachTooltip(fullBtn, function() { return _graphFull ? 'Exit full screen' : 'Full-screen graph'; });
    fullBtn.addEventListener('click', function() { _setGraphFull(!_graphFull); });
  }

  // Settings: same modal as the flyout menu and the context menus
  var settingsBtn = document.getElementById('graph-settings');
  if (settingsBtn) {
    _attachTooltip(settingsBtn, 'OpenCurve settings');
    settingsBtn.addEventListener('click', function() { _showSettingsModal(); });
  }

  // Zoom: one button (#zoom-btn, in the graph area's bottom-right corner since
  // 2.1.0; it was in the toolbar) opens a vertical slider above it. Drag
  // up to zoom in (100% at the top), down to zoom out (25% at the bottom); the
  // scale is logarithmic, so 50% sits in the middle and every stretch of the
  // track is the same step by eye. A press anywhere outside the slider, the
  // button again, or Esc closes it. Sizes are fixed and the popup is placed
  // from the anchor's rect only: UXP can't be trusted to measure a fresh element.
  var zoomBtn = document.getElementById('zoom-btn');
  _toolStates(zoomBtn, _paintZoomBtn); // hover and press (see _paintZoomBtn)
  var _ZOOM_MIN = 0.25, _ZOOM_MAX = 1.0;
  function _zoomLabel() {
    return _zoom < 0.995 ? 'Zoom (' + Math.round(_zoom * 100) + '%)' : 'Zoom';
  }
  function setZoom(z) {
    // A manual zoom: auto zoom stops easing and forgets the level it would restore
    _cancelZoomAnim();
    _autoZoomFrom = null;
    z = Math.max(_ZOOM_MIN, Math.min(_ZOOM_MAX, z));
    if (Math.abs(z - _zoom) < 1e-6) return;
    _zoom = z;
    _updateContentTransform();
  }
  var _zsDismiss = null, _zsLit = null;
  // The zoom button: lit white while its slider is open, with hover and press
  // states either way (_toolPaint; the inline tint hides the stylesheet's)
  function _paintZoomBtn() {
    if (!zoomBtn) return;
    _toolPaint(zoomBtn, _zsLit === zoomBtn ? '255,255,255' : null, 0.22, '#ffffff');
  }
  // Closes the slider; true if it was open (Esc uses that through _zoomPopHide)
  function _hideZoomSlider() {
    var pop = document.getElementById('_zoom-pop');
    if (_zsDismiss) { document.removeEventListener('pointerdown', _zsDismiss, true); _zsDismiss = null; }
    if (_zsLit) { _zsLit = null; _paintZoomBtn(); }
    if (!pop) return false;
    if (pop.parentNode) pop.parentNode.removeChild(pop);
    return true;
  }
  _zoomPopHide = _hideZoomSlider;
  function _showZoomSlider(anchor) {
    _hideZoomSlider();
    _hideTooltip();
    if (!anchor) return;
    var PAD_T = 10, PAD_B = 8, GAP = 6, LABEL_H = 14, POP_W = 34, INNER_W = POP_W - 2; // 1px border each side
    var r  = anchor.getBoundingClientRect();
    var ww = document.documentElement.clientWidth  || document.body.clientWidth;
    var wh = document.documentElement.clientHeight || document.body.clientHeight;
    // The graph's own button (bottom-right of the graph) opens upward, into the
    // graph; any other anchor opens below unless there is more room above
    var chrome = PAD_T + GAP + LABEL_H + PAD_B + 2;
    var below  = wh - Math.round(r.bottom + 4) - 4, above = Math.round(r.top - 4) - 4;
    var up     = anchor === zoomBtn ? (above >= 48 + chrome || above > below) : (below < 116 + chrome && above > below);
    var trackH = Math.max(48, Math.min(116, (up ? above : below) - chrome));
    var popH   = trackH + chrome;
    var top    = up ? Math.round(r.top - 4) - popH : Math.round(r.bottom + 4);
    var left   = Math.max(2, Math.min(ww - POP_W - 2, Math.round(r.left + r.width / 2 - POP_W / 2)));
    var cx     = INNER_W / 2; // the track's centre line

    var pop = document.createElement('div');
    pop.id = '_zoom-pop';
    pop.style.cssText = 'position:fixed;z-index:9999;left:' + left + 'px;top:' + top + 'px;width:' + POP_W + 'px;height:' + popH + 'px;' +
      'box-sizing:border-box;background-color:#1c1c1c;border:1px solid rgba(255,255,255,0.18);border-radius:3px;';
    // The press area: the track's height across the popup's whole width
    var hit = document.createElement('div');
    hit.style.cssText = 'position:absolute;left:0;top:' + PAD_T + 'px;width:' + INNER_W + 'px;height:' + trackH + 'px;cursor:pointer;';
    var track = document.createElement('div');
    track.style.cssText = 'position:absolute;left:' + (cx - 2) + 'px;top:0;width:4px;height:' + trackH + 'px;border-radius:2px;background-color:rgba(255,255,255,0.14);';
    var fill = document.createElement('div');
    fill.style.cssText = 'position:absolute;left:' + (cx - 2) + 'px;top:0;width:4px;height:0;border-radius:2px;background-color:#4a9eff;';
    var thumb = document.createElement('div');
    thumb.style.cssText = 'position:absolute;left:' + (cx - 6) + 'px;top:0;width:12px;height:12px;border-radius:6px;background-color:#ffffff;';
    var label = document.createElement('div');
    label.style.cssText = 'position:absolute;left:0;top:' + (PAD_T + trackH + GAP) + 'px;width:' + INNER_W + 'px;height:' + LABEL_H + 'px;' +
      'line-height:' + LABEL_H + 'px;text-align:center;font-size:11px;color:#aaaaaa;font-family:system-ui,sans-serif;';
    hit.appendChild(track);
    hit.appendChild(fill);
    hit.appendChild(thumb);
    pop.appendChild(hit);
    pop.appendChild(label);

    var LOG = Math.log(_ZOOM_MAX / _ZOOM_MIN);
    function yOf(z) { return (1 - Math.log(z / _ZOOM_MIN) / LOG) * trackH; }
    var lastY = null, lastPct = null;
    function place() { // change-only writes, as everywhere in the panel
      var y = Math.round(yOf(_zoom));
      if (y !== lastY) {
        lastY = y;
        thumb.style.top   = (y - 6) + 'px';
        fill.style.top    = y + 'px';
        fill.style.height = (trackH - y) + 'px';
      }
      var pct = Math.round(_zoom * 100) + '%';
      if (pct !== lastPct) { lastPct = pct; label.textContent = pct; }
    }
    var trackTop = top + 1 + PAD_T; // viewport y of the track's top
    var dragging = false, grab = 0;
    function zoomAt(clientY) {
      var y = Math.max(0, Math.min(trackH, clientY - trackTop - grab));
      setZoom(_ZOOM_MIN * Math.exp((1 - y / trackH) * LOG));
      place();
    }
    hit.addEventListener('pointerdown', function(e) {
      if (e.button) return;
      e.preventDefault();
      var dy = (e.clientY - trackTop) - yOf(_zoom);
      grab = Math.abs(dy) <= 8 ? dy : 0; // a press on the thumb keeps its offset; one on the track jumps there
      dragging = true;
      try { hit.setPointerCapture(e.pointerId); } catch (_) {}
      zoomAt(e.clientY);
    });
    hit.addEventListener('pointermove', function(e) { if (dragging) zoomAt(e.clientY); });
    function endDrag() { dragging = false; }
    hit.addEventListener('pointerup',     endDrag);
    hit.addEventListener('pointercancel', endDrag);

    document.body.appendChild(pop);
    place();
    if (anchor === zoomBtn) { // the menu button keeps its own tint (A-curve)
      _zsLit = zoomBtn;
      _paintZoomBtn();
    }
    _zsDismiss = function(ev) {
      if (pop.contains(ev.target)) return;
      if (zoomBtn && zoomBtn.contains(ev.target)) return; // its click closes it
      _hideZoomSlider();
    };
    // Capture phase, so a handler that stops the press can't keep it open;
    // deferred so the press that opened it doesn't close it
    var d = _zsDismiss;
    setTimeout(function() { if (_zsDismiss === d) document.addEventListener('pointerdown', d, true); }, 0);
  }
  if (zoomBtn) {
    _attachTooltip(zoomBtn, function() { return document.getElementById('_zoom-pop') ? '' : _zoomLabel(); }, 'right');
    zoomBtn.addEventListener('click', function() {
      if (!_hideZoomSlider()) _showZoomSlider(zoomBtn);
    });
  }

  // The mode tools (A-curve, Bounce, Add Point) sit in a column down the graph
  // area's left side (#graph-side-tools), above the zoom button in its
  // bottom-left corner. When the area is too short for both (_SIDE_NEED), the
  // column's buttons hide with inline display and the graph menu lists them.
  // The bar itself only holds the menu button and New Preset at the left and
  // Full Screen at the right, with the preset chip between (_tbChipLayout).
  // Widths are the CSS ones (26px buttons, 5px margins, 5px padding each side),
  // plus a little air.
  var toolbar  = document.getElementById('graph-toolbar');
  var menuBtn  = document.getElementById('graph-tools-menu');
  var canvasWrap = document.querySelector('.graph-canvas-wrap');
  // The menu button is always shown: Flip, Invert and Numeric Entry live only in
  // its dropdown (their toolbar buttons stay in the HTML, hidden, as icon sources).
  // Ghost is a Settings row now; its hidden button is kept for _setDragGhost and
  // the drag ghost's icon. The column's tools join the dropdown once it hides.
  var _tbTools = [peakBtn, bounceBtn, addPtBtn]; // zoom never hides
  // New Preset heads the column while the graph is shown (_newPresetPlace)
  function _newInSide() { var b = document.getElementById('preset-new'); return !!(b && b.parentNode && b.parentNode.id === 'graph-side-tools'); }
  // Bar: the menu button on the left, Full Screen on the right
  var _TB_NEED = 26 + 26 + 10 + 8;
  // Column: four buttons (New Preset and the three modes) and their 5px gaps
  // from the top + 8px air + zoom + 5px
  var _SIDE_NEED = (4 * 26 + 3 * 5) + 8 + 26 + 5;
  var _tbCollapsed = null;
  var _tbDismiss   = null;
  function _hideToolsMenu() {
    var m = document.getElementById('_tools-menu');
    if (m && m.parentNode) m.parentNode.removeChild(m);
    if (_tbDismiss) { window.removeEventListener('pointerdown', _tbDismiss); _tbDismiss = null; }
  }
  // Edited preset chip (#preset-edit-chip, between the two groups): it gets the
  // room the tools leave, capped by an inline max-width so it can never push the
  // right group over it. Below _PE_CHIP_FULL, Save and Revert drop their labels
  // and become 26px icon buttons; once the name would be cut short
  // (_peNameFits) it and "Edited" go and the two buttons stay; below
  // _PE_CHIP_BARE the chip hides (the dropdown then
  // lists Save and Revert). Written only when the value changes.
  var _PE_CHIP_BARE = 60;  // the two icon-only buttons alone
  var _peChipMaxW = null;
  function _tbChipLayout(w) {
    var chip = document.getElementById('preset-edit-chip');
    if (!chip) return;
    var room = w - 2 * 36; // #pe-center's width: the bar between the menu button and Full Screen
    var fits = room >= _PE_CHIP_BARE;
    var mw = fits ? Math.floor(room) + 'px' : '';
    if (mw !== _peChipMaxW) { _peChipMaxW = mw; chip.style.maxWidth = mw; }
    _peRoom = room;
    _peChipRoom = fits;
    _presetEditSync(); // compares its signature first: the name test depends on the room
  }
  function _tbLayout() {
    if (!toolbar || !menuBtn) return;
    var w = toolbar.clientWidth;
    if (w > 0) _tbChipLayout(w);
    var h = canvasWrap ? canvasWrap.clientHeight : 0;
    if (!(h > 0)) return; // the graph is hidden
    var collapse = h < _SIDE_NEED;
    if (collapse === _tbCollapsed) return;
    _tbCollapsed = collapse;
    // inline display: UXP ignores class-driven display changes
    _tbTools.forEach(function(b) { if (b) b.style.display = collapse ? 'none' : ''; });
    if (_newInSide()) document.getElementById('preset-new').style.display = collapse ? 'none' : '';
    _hideToolsMenu();
    _hideZoomSlider(); // its anchor may just have been hidden
    _stylePeakBtn(); // the menu button only carries the A-curve tint while collapsed
    if (_bounceMode && _svgW > 0) _bnPlaceDots(_svgW, _svgH); // the floor line starts after the column only while it shows
  }
  function _showToolsMenu() {
    _hideToolsMenu();
    var menu = document.createElement('div');
    menu.className = 'ctx-menu';
    menu.id = '_tools-menu';
    menu.style.display = 'block';
    function item(label, srcBtn, onClick, opts) {
      opts = opts || {};
      var it = document.createElement('div');
      it.className = 'ctx-menu-item';
      it.style.display = 'flex';
      it.style.alignItems = 'center';
      var ic = document.createElement('span');
      ic.style.cssText = 'display:flex;align-items:center;justify-content:center;flex-shrink:0;opacity:0.7;margin-right:10px;width:16px;';
      var svg = srcBtn && srcBtn.querySelector('svg');
      if (svg) {
        var cl = svg.cloneNode(true); // the tool's own icon
        cl.removeAttribute('style');  // drop _centerIcons' absolute placement, it would pin the clone to the menu's corner
        cl._ocCentered = true;
        ic.appendChild(cl);
      }
      it.appendChild(ic);
      var lb = document.createElement('span');
      lb.textContent = label;
      it.appendChild(lb);
      if (opts.active)   { it.style.color = '#3ddc84'; ic.style.opacity = '1'; }
      if (opts.disabled) { it.style.color = 'rgba(212,212,212,0.35)'; it.style.cursor = 'default'; }
      it.addEventListener('click', function(ev) {
        ev.stopPropagation();
        if (opts.disabled) return;
        if (!opts.keepOpen) _hideToolsMenu();
        onClick();
      });
      menu.appendChild(it);
    }
    var edP = _presetEdited();
    if (edP && !_presetChipShown()) { // no room for the chip: its two actions come first here
      item('Save to "' + edP.name + '"', document.getElementById('pe-save'), _presetEditSave);
      item('Revert to "' + edP.name + '"', document.getElementById('pe-revert'), _presetEditRevert);
    }
    if (_tbCollapsed) {
      var newBtnS = document.getElementById('preset-new');
      if (_newInSide()) item('New Preset', newBtnS, function() { newBtnS.click(); });
      item(_peakMode ? 'A-curve Mode: On' : 'A-curve Mode', peakBtn, function() { _setPeakMode(!_peakMode); }, { active: _peakMode });
      item(_bounceMode ? 'Bounce Mode: On' : 'Bounce Mode', bounceBtn, function() { _setBounceMode(!_bounceMode); }, { active: _bounceMode });
      item('Add Point', addPtBtn, function() { if (_peakMode) _setPeakMode(false); _addPoint(); });
    }
    item('Flip',      flipBtn,   function() { _applyCurveOp(_flipCurve); });
    item('Invert',    invertBtn, function() { _applyCurveOp(_invertCurve); });
    item('Numeric Entry', numBtn, function() { _showNumericPanel(); });
    menu.style.left = '0px';
    menu.style.top  = '0px';
    document.body.appendChild(menu);
    void menu.offsetHeight;
    // Below the button, left-aligned with it; above when there is no room below
    var r  = menuBtn.getBoundingClientRect();
    var mw = menu.offsetWidth  || 170;
    var mh = menu.offsetHeight || 100;
    var ww = document.documentElement.clientWidth  || document.body.clientWidth;
    var wh = document.documentElement.clientHeight || document.body.clientHeight;
    var x  = Math.max(0, Math.min(r.left, ww - mw));
    var y  = (r.bottom + 2 + mh > wh) ? Math.max(0, r.top - 2 - mh) : r.bottom + 2;
    menu.style.left = x + 'px';
    menu.style.top  = y + 'px';
    _tbDismiss = function(ev) {
      if (menu.contains(ev.target) || menuBtn.contains(ev.target)) return;
      _hideToolsMenu();
    };
    // Deferred so the press that opened it doesn't dismiss it
    var d = _tbDismiss;
    setTimeout(function() { if (_tbDismiss === d) window.addEventListener('pointerdown', d); }, 0);
  }
  var peSave = document.getElementById('pe-save'), peRevert = document.getElementById('pe-revert');
  if (peSave) {
    _attachTooltip(peSave, function() { var p = _presetEdited(); return p ? 'Save to "' + p.name + '"' : ''; });
    peSave.addEventListener('click', _presetEditSave);
  }
  if (peRevert) {
    _attachTooltip(peRevert, function() { var p = _presetEdited(); return p ? 'Revert to "' + p.name + '"' : ''; });
    peRevert.addEventListener('click', _presetEditRevert);
  }
  if (menuBtn) {
    _attachTooltip(menuBtn, 'Graph tools');
    menuBtn.addEventListener('click', function() {
      if (document.getElementById('_tools-menu')) _hideToolsMenu(); else _showToolsMenu();
    });
  }
  if (typeof ResizeObserver !== 'undefined') {
    var _tbRO = new ResizeObserver(_tbLayout);
    if (toolbar) _tbRO.observe(toolbar);
    if (canvasWrap) _tbRO.observe(canvasWrap); // the column hides by the graph area's height
  }
  _tbLayout();

  // Icons for the preset bar's menu
  var _icPaste = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><rect x="3" y="2" width="8" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><path fill="none" d="M5.5 2V1.5a1 1 0 011-1h1a1 1 0 011 1V2" stroke="currentColor" stroke-width="1.3"/><line x1="5.5" y1="6" x2="8.5" y2="6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="5.5" y1="8.5" x2="8.5" y2="8.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
  var _icExport = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M2 9.5v2.5h10V9.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M7 9V1.5M4.2 4.3L7 1.5l2.8 2.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var _icImport = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M2 9.5v2.5h10V9.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M7 1.5V9M4.2 6.2L7 9l2.8-2.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // Preset toolbar menu (#preset-tools-menu, the hamburger at the left): always
  // shown, its dropdown lists Paste Preset and Export / Import Presets. Once
  // the bar is too narrow for the Menu/New/List group and the
  // Graph/Timeline/Settings group to sit apart, every other tool but Settings
  // hides and the dropdown lists them too, like the graph bar's menu.
  // Elements are looked up by id at use time.
  var ptb      = document.getElementById('preset-toolbar');
  var pMenuBtn = document.getElementById('preset-tools-menu');
  var _PTB_IDS = ['preset-new', 'preset-layout', 'toggle-graph', 'toggle-timeline'];
  // New Preset lives in the graph bar while the graph is shown (_newPresetPlace),
  // so it only counts, and only collapses here, while it is in this bar
  function _newInPtb() { var b = document.getElementById('preset-new'); return !!(b && ptb && b.parentNode === ptb); }
  // Left: the menu button (and New Preset while it is here); right: List/Grid, Graph, Timeline, Settings
  function _ptbNeed() { var left = _newInPtb() ? 2 : 1; return (left * 26 + (left - 1) * 5) + (4 * 26 + 3 * 5) + 10 + 8; }
  var _ptbCollapsed = null;
  var _ptbDismiss   = null;
  function _hidePresetMenu() {
    var m = document.getElementById('_preset-tools-menu');
    if (m && m.parentNode) m.parentNode.removeChild(m);
    if (_ptbDismiss) { window.removeEventListener('pointerdown', _ptbDismiss); _ptbDismiss = null; }
  }
  function _ptbLayout() {
    if (!ptb || !pMenuBtn) return;
    var w = ptb.clientWidth;
    if (!(w > 0)) return;
    var collapse = w < _ptbNeed();
    if (collapse === _ptbCollapsed) return;
    _ptbCollapsed = collapse;
    // inline display: UXP ignores class-driven display changes
    _PTB_IDS.forEach(function(id) {
      var b = document.getElementById(id);
      if (!b || (id === 'preset-new' && !_newInPtb())) return;
      b.style.display = collapse ? 'none' : '';
    });
    // #preset-layout carries the margin that pushes the right group away; while it
    // is hidden the menu button takes that job (inline, UXP ignores class changes)
    pMenuBtn.style.marginRight = collapse ? 'auto' : '';
    _hidePresetMenu();
  }
  function _showPresetMenu() {
    _hidePresetMenu();
    var menu = document.createElement('div');
    menu.className = 'ctx-menu';
    menu.id = '_preset-tools-menu';
    menu.style.display = 'block';
    function item(label, svg, onClick, opts) {
      opts = opts || {};
      var it = document.createElement('div');
      it.className = 'ctx-menu-item';
      it.style.display = 'flex';
      it.style.alignItems = 'center';
      var ic = document.createElement('span');
      ic.style.cssText = 'display:flex;align-items:center;justify-content:center;flex-shrink:0;opacity:0.7;margin-right:10px;width:16px;';
      if (typeof svg === 'string') {
        ic.innerHTML = svg;           // an icon of its own (the file/paste items)
      } else if (svg) {
        var cl = svg.cloneNode(true); // the tool's own icon
        cl.removeAttribute('style');  // drop _centerIcons' absolute placement, it would pin the clone to the menu's corner
        cl._ocCentered = true;
        ic.appendChild(cl);
      }
      it.appendChild(ic);
      var lb = document.createElement('span');
      lb.textContent = label;
      it.appendChild(lb);
      if (opts.active === true)  { it.style.color = '#3ddc84'; ic.style.opacity = '1'; }
      if (opts.active === false) { it.style.color = '#ff9090'; ic.style.opacity = '1'; }
      it.addEventListener('click', function(ev) {
        ev.stopPropagation();
        _hidePresetMenu();
        onClick();
      });
      menu.appendChild(it);
    }
    function svgOf(id, sel) { var b = document.getElementById(id); return b ? b.querySelector(sel || 'svg') : null; }
    item('Paste Preset', _icPaste, function() { _pasteCoordinates(); });
    item('Export Presets\u2026', _icExport, function() { _exportPresetsToFile(); });
    item('Import Presets\u2026', _icImport, function() { _importPresetsFromFile(); });
    if (_ptbCollapsed) {
      // The hidden tools, after a divider
      var sep = document.createElement('div');
      sep.style.cssText = 'border-top:1px solid rgba(255,255,255,0.07);margin:3px 0;';
      menu.appendChild(sep);
      var newBtn = document.getElementById('preset-new');
      if (_newInPtb()) item('New Preset', svgOf('preset-new'), function() { if (newBtn) newBtn.click(); }); // in the graph bar it stays on show
      item(_presetLayout === 'list' ? 'Grid View' : 'List View',
           svgOf('preset-layout', _presetLayout === 'list' ? '.ic-grid' : '.ic-list'),
           function() { _presetLayout = _presetLayout === 'list' ? 'grid' : 'list'; localStorage.setItem(_LAYOUT_KEY, _presetLayout); _applyPresetLayout(true); });
      item(_graphVisible ? 'Graph: On' : 'Graph: Off', svgOf('toggle-graph'), function() { _setGraphVisible(!_graphVisible); }, { active: _graphVisible });
      item(_tlVisible ? 'Timeline: On' : 'Timeline: Off', svgOf('toggle-timeline'), function() { _setTimelineVisible(!_tlVisible); }, { active: _tlVisible });
    }
    menu.style.left = '0px';
    menu.style.top  = '0px';
    document.body.appendChild(menu);
    void menu.offsetHeight;
    // Below the button, left-aligned with it; above when there is no room below
    var r  = pMenuBtn.getBoundingClientRect();
    var mw = menu.offsetWidth  || 170;
    var mh = menu.offsetHeight || 100;
    var ww = document.documentElement.clientWidth  || document.body.clientWidth;
    var wh = document.documentElement.clientHeight || document.body.clientHeight;
    var x  = Math.max(0, Math.min(r.left, ww - mw));
    var y  = (r.bottom + 2 + mh > wh) ? Math.max(0, r.top - 2 - mh) : r.bottom + 2;
    menu.style.left = x + 'px';
    menu.style.top  = y + 'px';
    _ptbDismiss = function(ev) {
      if (menu.contains(ev.target) || pMenuBtn.contains(ev.target)) return;
      _hidePresetMenu();
    };
    // Deferred so the press that opened it doesn't dismiss it
    var pd = _ptbDismiss;
    setTimeout(function() { if (_ptbDismiss === pd) window.addEventListener('pointerdown', pd); }, 0);
  }
  if (pMenuBtn) {
    _attachTooltip(pMenuBtn, 'Preset menu: paste, export and import');
    pMenuBtn.addEventListener('click', function() {
      if (document.getElementById('_preset-tools-menu')) _hidePresetMenu(); else _showPresetMenu();
    });
  }
  if (ptb && typeof ResizeObserver !== 'undefined') new ResizeObserver(_ptbLayout).observe(ptb);
  // New Preset heads the tool column down the graph's left side while the graph
  // is shown and goes back next to the preset bar's menu button while it is off
  // (the column hides with the graph). _applyGraphVisibility calls this on every change.
  _newPresetPlace = function() {
    var b = document.getElementById('preset-new'), side = document.getElementById('graph-side-tools');
    if (!b || !side || !ptb || !pMenuBtn) return;
    var host = _graphVisible ? side : ptb;
    if (b.parentNode !== host) {
      if (_graphVisible) side.insertBefore(b, side.firstChild);
      else ptb.insertBefore(b, pMenuBtn.nextSibling);
      var d = (_graphVisible && _tbCollapsed) ? 'none' : ''; // a short graph area folds the column into the menu
      if (b.style.display !== d) b.style.display = d;
      _ptbCollapsed = null; _ptbLayout();        // the preset bar's room changed
    }
  };
  _newPresetPlace();
  _ptbLayout();

  // ── Unified preset system ─────────────────────────────────────
  var _STORAGE_KEY  = 'opencurve-presets-v10';

  // Anything stored here reaches _buildPresetBtn -> _thumbPathD during initPanel,
  // so a bad shape used to throw before Go, the status strip and renderUI were
  // wired: the panel came up with no presets and a dead Go button and said
  // nothing about why. Only well-formed entries are kept; the rest are dropped.
  function _validPreset(p) {
    if (!p || typeof p !== 'object') return false;
    if (typeof p.name !== 'string') return false;
    var c = p.curve;
    if (!c || typeof c !== 'object') return false;
    var k = ['p1x', 'p1y', 'p2x', 'p2y'];
    for (var i = 0; i < k.length; i++) if (typeof c[k[i]] !== 'number' || !isFinite(c[k[i]])) return false;
    if (c.pts !== undefined && !Array.isArray(c.pts)) return false;
    return true;
  }
  function _loadPresetList() {
    var raw;
    try { raw = JSON.parse(localStorage.getItem(_STORAGE_KEY)); } catch(e) { return null; }
    if (!Array.isArray(raw)) return null;
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      if (!_validPreset(raw[i])) continue;
      var p = raw[i];
      out.push({ id: String(p.id || ('p' + i)), name: p.name, curve: _normalizeCurve(_cloneCurve(p.curve)), builtIn: !!p.builtIn });
    }
    if (out.length !== raw.length) console.log('[OC] dropped ' + (raw.length - out.length) + ' malformed preset(s) from storage');
    // An empty list is a real state (every preset can be deleted, built-ins too),
    // so it is kept. Falling back to the defaults is only for a stored list that
    // had entries and lost all of them to validation.
    if (raw.length && !out.length) return null;
    return out;
  }
  function _savePresetList(list) {
    try { localStorage.setItem(_STORAGE_KEY, JSON.stringify(list)); }
    catch(e) {
      console.log('[OC] could not save presets:', e);
      _showCopyToast('Could not save presets: ' + (e && e.message ? e.message : 'storage full'), '#ff9090');
    }
  }

  var _stored = _loadPresetList();
  var _presetList = _stored || BUILT_IN_PRESETS.map(function(p) {
    return { id: p.id, name: p.name, curve: _cloneCurve(p.curve), builtIn: true };
  }); // fresh install: the built-ins only
  if (!_stored) _savePresetList(_presetList);

  // ── Context menu ──────────────────────────────────────────────
  var _ctxMenu = document.createElement('div');
  _ctxMenu.className = 'ctx-menu';
  _ctxMenu.style.display = 'none';
  document.body.appendChild(_ctxMenu);

  var _ctxTarget = null;

  function _ctxItem(label, danger, onClick, icon) {
    var item = document.createElement('div');
    item.className = 'ctx-menu-item' + (danger ? ' ctx-menu-item-danger' : '');
    item.style.display = 'flex';
    item.style.alignItems = 'center';
    if (icon) {
      var iconSpan = document.createElement('span');
      iconSpan.style.cssText = 'display:flex;align-items:center;flex-shrink:0;opacity:0.7;margin-right:10px;';
      iconSpan.innerHTML = icon;
      item.appendChild(iconSpan);
    }
    var labelSpan = document.createElement('span');
    labelSpan.textContent = label;
    item.appendChild(labelSpan);
    item.addEventListener('click', function(e) {
      e.stopPropagation();
      var t = _ctxTarget;
      _hideCtxMenu();
      onClick(t);
    });
    _ctxMenu.appendChild(item);
    return item;
  }

  var _icRename = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path fill="none" d="M8.5 2.5l3 3M2 9l6.5-6.5 3 3L5 12H2V9z" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var _icCopy = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><rect x="4.5" y="4.5" width="7" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><path fill="none" d="M9.5 4.5V3a1 1 0 00-1-1H3a1 1 0 00-1 1v5.5a1 1 0 001 1h1.5" stroke="currentColor" stroke-width="1.3"/></svg>';
  var _icOverwrite = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path fill="none" d="M7 2v7M4.5 6.5L7 9l2.5-2.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path fill="none" d="M2 11h10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
  var _icDelete = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path fill="none" d="M3 4h8M5.5 4V3a1 1 0 011-1h1a1 1 0 011 1v1M4.5 4l.5 7.5a1 1 0 001 .5h2a1 1 0 001-.5L9.5 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  _ctxItem('Rename Preset', false, function(t) {
    if (t) t.startRename();
  }, _icRename);
  _ctxItem('Copy Preset', false, function(t) {
    if (!t) return;
    var c = t.preset.curve;
    var text = _curveToText(c);
    console.log('[OC] Coordinates:', text);
    var copied = false;
    try {
      if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function() {
          console.log('[OC] Copied to clipboard:', text);
          _showCopyToast('Copied!');
        }).catch(function(e) {
          console.log('[OC] clipboard writeText failed:', e);
          _showCopyToast(text);
        });
        copied = true;
      }
    } catch(e) {}
    if (!copied) { _showCopyToast(text); }
  }, _icCopy);
  _ctxItem('Overwrite with current', false, function(t) {
    if (!t) return;
    _presetOverwriteRef(t.preset, getState().curve);
    setPresetActive(t.preset.id); // it now holds the graph's curve: it is the one the curve came from
    _showCopyToast('Preset updated');
  }, _icOverwrite);
  _ctxItem('Delete Preset', true, function(t) {
    if (!t) return;
    _confirmDialog('Delete Preset', 'Delete "' + t.preset.name + '"? This cannot be undone.', 'Delete', function() {
      _presetList = _presetList.filter(function(p) { return p.id !== t.preset.id; });
      _savePresetList(_presetList);
      if (t.btn && t.btn.parentNode) t.btn.parentNode.removeChild(t.btn);
      if (_srcPresetId === String(t.preset.id)) clearPresetActive(); // the curve stays, the link goes
      _presetUpdateFade();
    });
  }, _icDelete);
  function _showCtxMenu(preset, btn, startRename, e) {
    var existingMini = document.getElementById('_mini-ctx');
    if (existingMini && existingMini.parentNode) existingMini.parentNode.removeChild(existingMini);
    _ctxTarget = { preset: preset, btn: btn, startRename: startRename };
    _ctxMenu.style.left = '0px';
    _ctxMenu.style.top = '0px';
    _ctxMenu.style.display = 'block';
    var mw = _ctxMenu.offsetWidth;
    var mh = _ctxMenu.offsetHeight;
    var ww = document.documentElement.clientWidth  || document.body.clientWidth;
    var wh = document.documentElement.clientHeight || document.body.clientHeight;
    var x = Math.min(e.clientX, ww - mw);
    var y = e.clientY + mh > wh ? e.clientY - mh : e.clientY;
    _ctxMenu.style.left = Math.max(0, x) + 'px';
    _ctxMenu.style.top  = Math.max(0, y) + 'px';
  }
  function _hideCtxMenu() {
    _ctxMenu.style.display = 'none';
    _ctxTarget = null;
  }
  // Both floating menus are placed at fixed coordinates, so they used to hang
  // over unrelated content after a panel resize (or a _refreshScroller swap) and
  // only closed on an outside press. Esc and the resize observer close them now.
  _closeMenus = function() {
    var open = false;
    if (_ctxMenu && _ctxMenu.style.display !== 'none') { _hideCtxMenu(); open = true; }
    var mini = document.getElementById('_mini-ctx');
    if (mini && mini.parentNode) { mini.parentNode.removeChild(mini); open = true; }
    return open;
  };
  window.addEventListener('pointerdown', function(e) {
    if (!_ctxMenu.contains(e.target)) _hideCtxMenu();
  });

  // ── Thumbnails ────────────────────────────────────────────────
  // Thumbnail mapping: the 0..1 box, stretched to the curve's y extent when it
  // overshoots (Back / Bounce style curves), so the shape isn't clipped
  function _thumbMap(c) {
    var W = 28, H = 28, pad = 3, gW = W - 2*pad, gH = H - 2*pad;
    var b = _peakMode ? { lo: 0, hi: 1 } : _curveYBounds(c), span = b.hi - b.lo;
    return {
      tx: function(n) { return pad + n * gW; },
      ty: function(n) { return pad + (1 - (n - b.lo) / span) * gH; },
    };
  }
  function _thumbPathD(c) {
    var m = _thumbMap(c);
    if (_peakMode) return _peakBellPath(c, 40, m.tx, m.ty); // A-curve mode: thumbnails show the bell too
    return _curvePathTx(c, m.tx, m.ty);
  }

  // Ease preview: while a tile is hovered a dot runs along its thumbnail with x
  // as time and y as the eased value (the bell's height in A-curve mode), so
  // the pace of the ease can be read without applying it. One tile at a time;
  // follows the Hover Preview setting (_animationsOn, key opencurve-animations).
  var _tileAnim = null; // { raf, dot, thumb }
  function _tileAnimStop() {
    if (!_tileAnim) return;
    cancelAnimationFrame(_tileAnim.raf);
    _tileAnim.dot.setAttribute('opacity', '0'); _tileAnim.dot.setAttribute('visibility', 'hidden');
    _tileAnim = null;
  }
  function _tileAnimHook(btn, thumb, getCurve) {
    // The dot exists from the start and is only shown while hovered: UXP is
    // happier toggling opacity/visibility on an existing SVG child than
    // rendering one appended mid-hover (the graph's handles work the same way)
    var dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('class', 'thumb-dot');
    dot.setAttribute('r', '2.6');
    dot.setAttribute('cx', '3'); dot.setAttribute('cy', '25');
    dot.setAttribute('fill', _curveColor);
    dot.setAttribute('stroke', '#111111');
    dot.setAttribute('stroke-width', '1');
    dot.setAttribute('opacity', '0'); dot.setAttribute('visibility', 'hidden');
    thumb.appendChild(dot);
    function start() {
      if (!_animationsOn) return;
      if (_tileAnim && _tileAnim.thumb === thumb) return;
      _tileAnimStop();
      var c = getCurve();
      var m = _thumbMap(c);
      var pk = _peakMode ? _peakOf(c, 48) : null;
      dot.setAttribute('fill', _curveColor);
      dot.setAttribute('opacity', '1'); dot.setAttribute('visibility', 'visible');
      var st = { raf: 0, dot: dot, thumb: thumb }, t0 = null;
      var run = 1300, hold = 400; // one pass, then a pause at the end
      _tileAnim = st;
      function yAt(x) {
        if (!pk) return sampleBezier(x, c);
        var h = 5e-4, xa = Math.max(0, x - h), xb = Math.min(1, x + h);
        var v = (sampleBezier(xb, c) - sampleBezier(xa, c)) / (xb - xa);
        return Math.max(0, Math.min(1, v / (pk.v > 1e-9 ? pk.v : 1)));
      }
      function frame(ts) {
        if (_tileAnim !== st) return;
        if (t0 === null) t0 = ts;
        var x = Math.min(1, ((ts - t0) % (run + hold)) / run);
        dot.setAttribute('cx', m.tx(x).toFixed(2));
        dot.setAttribute('cy', m.ty(yAt(x)).toFixed(2));
        st.raf = requestAnimationFrame(frame);
      }
      st.raf = requestAnimationFrame(frame);
    }
    function stop() { if (_tileAnim && _tileAnim.thumb === thumb) _tileAnimStop(); }
    btn.addEventListener('mouseenter',   start);
    btn.addEventListener('pointerenter', start);
    btn.addEventListener('mouseleave',   stop);
    btn.addEventListener('pointerleave', stop);
  }

  function _buildPresetBtn(preset) {
    var btn = document.createElement('div');
    btn.className = 'preset-btn';
    btn.dataset.id = preset.id;

    var thumb = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    thumb.setAttribute('class', 'preset-thumb');
    thumb.setAttribute('width', '28'); thumb.setAttribute('height', '28'); thumb.setAttribute('viewBox', '0 0 28 28');
    var tp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    tp.setAttribute('fill', 'none'); tp.setAttribute('stroke', _curveColor);
    tp.setAttribute('stroke-width', '2'); tp.setAttribute('stroke-linecap', 'round');
    tp.setAttribute('d', _thumbPathD(preset.curve));
    thumb.appendChild(tp); btn.appendChild(thumb);
    _tileAnimHook(btn, thumb, function() { return preset.curve; });

    var nameSpan = document.createElement('span');
    nameSpan.className = 'preset-name';
    nameSpan.textContent = preset.name;
    btn.appendChild(nameSpan);

    btn.addEventListener('click', function(e) {
      setPresetActive(preset.id);
      _animateToCurve(preset.curve, function(cur) {
        updateDynamicSVG(cur, _svgW, _svgH);
      });
    });

    // Rename: right-click > Rename Preset opens a modal (an inline field lost
    // focus to the key sink's deferred grab and committed unchanged; no dblclick)
    // opts: the dialog's title and button for a fresh preset (New Preset, Paste)
    function startRename(opts) {
      _renamePresetDialog(preset.name, function(v) {
        preset.name = v; nameSpan.textContent = v;
        _savePresetList(_presetList);
        _presetEditSync(); // the chip shows the name
      }, opts && opts.title ? opts : null);
    }
    btn._ocRename = startRename; // New Preset / Paste open it for the fresh tile
    btn.addEventListener('contextmenu', function(e) { e.preventDefault(); _showCtxMenu(preset, btn, startRename, e); });

    return btn;
  }

  // Drag-to-reorder
  function _initDragSort(container) {
    // Once per element: _renderPresets wires the list it fills, and Reset All
    // Settings renders again into the same element. A second wiring stacked a
    // full set of handlers (two drop lines, two ghosts, double saves). A
    // _refreshScroller replacement is a fresh node with no flag, so it re-wires.
    if (container._ocDragSort) return;
    container._ocDragSort = true;
    var dragEl = null, dropLine = null, startY = 0, startX = 0, moved = false;
    var _dragGhost = null, _ghostW = 80, _ghostH = 60;
    var _dropHighlight = null;
    var _pendingPointerId = null;

    container.addEventListener('pointerdown', function(e) {
      // Left button only: a right-press used to arm a drag and take pointer
      // capture, so a small movement before release both reordered the list and
      // opened the tile's context menu.
      if (e.button !== 0) return;
      var btn = e.target;
      while (btn && btn !== container) {
        if (btn.classList && btn.classList.contains('preset-btn')) break;
        btn = btn.parentNode;
      }
      if (!btn || btn === container) return;
      if (btn.id === '_update-notif') return;

      dragEl = btn; startX = e.clientX; startY = e.clientY; moved = false;
      // Capture is taken on the first real move, not here: Chromium retargets
      // the following click to the capturing element.
      _pendingPointerId = e.pointerId;
    });

    container.addEventListener('pointermove', function(e) {
      if (!dragEl) return;
      // Capture is only taken once a drag starts, so a press released outside
      // the list never reaches endDragSort and dragEl stayed armed: the next
      // buttonless hover with 5px of travel began a drag. No button held, no drag.
      if (!moved && typeof e.buttons === 'number' && (e.buttons & 1) === 0) {
        dragEl = null; _pendingPointerId = null; return;
      }
      if (!moved && Math.abs(e.clientY - startY) < 5) return;
      if (!moved) {
        if (_pendingPointerId != null) {
          container.setPointerCapture(_pendingPointerId);
          _pendingPointerId = null;
        }
        moved = true;
        dropLine = document.createElement('div');
        dropLine.className = 'preset-drop-line';
        dragEl.classList.add('preset-dragging');
        if (_presetCols > 1) {
          // Floating ghost. Its size never changes, so it is measured once here
          // instead of reading offsetWidth/offsetHeight on every move (a read
          // straight after a style write forces a layout).
          var rect = dragEl.getBoundingClientRect();
          _ghostW = rect.width || 80;
          _ghostH = rect.height || 60;
          _dragGhost = dragEl.cloneNode(true);
          _dragGhost.style.cssText = 'position:fixed;z-index:9999;pointer-events:none;opacity:0.6;transform:scale(0.85);width:' + rect.width + 'px;';
          _dragGhost.style.left = (e.clientX - _ghostW / 2) + 'px';
          _dragGhost.style.top = (e.clientY - _ghostH / 2) + 'px';
          document.body.appendChild(_dragGhost);
          dragEl.style.display = 'none';
        }
      }
      // Measure before writing anything this move, so the rect reads below don't
      // force a layout on the ghost's new position.
      var isGrid = _presetCols > 1; // grid, or the two-column list
      var items = Array.from(container.children).filter(function(c) {
        return c !== dragEl && c !== dropLine;
      });
      var after = null;
      if (isGrid) {
        // Insert before the tile the cursor is over (the dragged item takes its place)
        for (var i = 0; i < items.length; i++) {
          var r = items[i].getBoundingClientRect();
          if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
            after = items[i];
            break;
          }
        }
      } else {
        for (var j = 0; j < items.length; j++) {
          var r2 = items[j].getBoundingClientRect();
          if (e.clientY < r2.top + r2.height / 2) { after = items[j]; break; }
        }
      }
      // Writes from here down
      var wantHi = (isGrid && after && after !== dragEl) ? after : null;
      if (_dropHighlight !== wantHi) {
        if (_dropHighlight) _dropHighlight.style.outline = '';
        if (wantHi) wantHi.style.outline = '2px solid var(--accent)';
        _dropHighlight = wantHi;
      }
      // Moving the drop line is what invalidates every rect above, so leave it
      // alone while the target is unchanged: most moves then touch no DOM at all.
      var curNext = (dropLine.parentNode === container) ? dropLine.nextSibling : undefined;
      if (curNext !== after) {
        if (after) container.insertBefore(dropLine, after);
        else container.appendChild(dropLine);
      }
      if (_dragGhost) {
        _dragGhost.style.left = (e.clientX - _ghostW / 2) + 'px';
        _dragGhost.style.top = (e.clientY - _ghostH / 2) + 'px';
      }
    });

    function endDragSort() {
      if (!dragEl) return;
      _pendingPointerId = null;
      if (moved && dropLine) {
        container.insertBefore(dragEl, dropLine);
        container.removeChild(dropLine);
        _presetList = Array.from(container.querySelectorAll('.preset-btn')).map(function(b) {
          return _presetList.find(function(p) { return p.id === b.dataset.id; });
        }).filter(Boolean);
        _savePresetList(_presetList);
      }
      if (_dropHighlight) { _dropHighlight.style.outline = ''; _dropHighlight = null; }
      if (_dragGhost && _dragGhost.parentNode) { _dragGhost.parentNode.removeChild(_dragGhost); _dragGhost = null; }
      dragEl.style.display = '';
      dragEl.classList.remove('preset-dragging');
      var didMove = moved;
      dragEl = null; dropLine = null; moved = false;
      // Only after a real reorder: a plain click in grid view used to rewrite
      // every tile's inline styles, and each write relayouts the panel in UXP.
      if (didMove && _presetCols > 1) _applyPresetLayout(true);
    }

    container.addEventListener('pointerup',     endDragSort);
    container.addEventListener('pointercancel', endDragSort);
  }

  function _renderPresets() {
    var list = document.getElementById('all-presets-list');
    if (!list) return;
    list.innerHTML = '';
    _presetList.forEach(function(p) { list.appendChild(_buildPresetBtn(p)); });
    _initDragSort(list);
  }

  // A-curve mode swaps every thumbnail between the bezier and its bell
  _peakThumbRefresh = function() {
    var list = document.getElementById('all-presets-list');
    if (!list) return;
    var kids = list.children;
    for (var i = 0; i < kids.length; i++) {
      var id = kids[i].dataset ? kids[i].dataset.id : null;
      if (!id) continue;
      var preset = null;
      for (var j = 0; j < _presetList.length; j++) { if (String(_presetList[j].id) === String(id)) { preset = _presetList[j]; break; } }
      if (!preset || !preset.curve) continue;
      var path = kids[i].querySelector('.preset-thumb path');
      if (path) path.setAttribute('d', _thumbPathD(preset.curve));
    }
  };

  // Reset All Settings rebuilds the list from here: _presetList lives in this
  // closure, so clearing storage alone left the old list in memory and the next
  // preset edit wrote it straight back.
  // Load Baked Curve lights the preset the bake used: the first preset whose
  // curve has the same shape (_sameCurve), or null
  // Edited preset (see _presetEditSync): look a preset up by id, and overwrite one
  _presetByIdRef = function(id) {
    for (var i = 0; i < _presetList.length; i++) if (String(_presetList[i].id) === id) return _presetList[i];
    return null;
  };
  _presetOverwriteRef = function(preset, curve) {
    preset.curve = _cloneCurve(curve);
    preset.builtIn = false; // no longer the shipped curve: export it like any custom preset
    _savePresetList(_presetList);
    var tile = document.querySelector('.preset-btn[data-id="' + preset.id + '"]');
    var thumb = tile && tile.querySelector('.preset-thumb path');
    if (thumb) thumb.setAttribute('d', _thumbPathD(preset.curve));
    _presetEditSync();
  };
  _presetMatchRef = function(curve) {
    for (var i = 0; i < _presetList.length; i++) if (_sameCurve(_presetList[i].curve, curve)) return _presetList[i].id;
    return null;
  };
  _resetPresetsRef = function() {
    _presetList = BUILT_IN_PRESETS.map(function(p) {
      return { id: p.id, name: p.name, curve: _cloneCurve(p.curve), builtIn: true };
    });
    _savePresetList(_presetList);
    clearPresetActive();
    // Same order as init: render, then the update tile, then the inline layout
    // pass over the fresh tiles (UXP needs it inline; running it before the
    // rebuild, as the reset first did, left the new tiles unstyled)
    _renderPresets();
    _refreshUpdateNotification();
    _applyPresetLayout(true);
  };
  _renderPresets();
  _refreshUpdateNotification();

  _applyPresetLayout(true);
  var _presetListEl = document.getElementById('all-presets-list');
  if (_presetListEl && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(_updateGridCols).observe(_presetListEl);
  }
  if (_presetListEl) _presetListEl.addEventListener('scroll', _presetUpdateFade); // top/bottom edge fades

  // Parse a curve string → curve object or null. _curveFromText takes both forms
  // (cubic-bezier() and opencurve()) and clamps what it returns.
  function _parseCubicBezier(text) {
    return _curveFromText(text);
  }

  // New Preset / Paste Preset: the name is asked for first and the preset is
  // only added on Save; Cancel, Esc or a click outside leave the list alone
  // (it used to be added at once, so Cancel kept it under its default name).
  // makeActive: the graph holds this curve, so its tile becomes the lit one.
  function _promptNewPreset(curve, defName, title, makeActive) {
    curve = _cloneCurve(curve);
    _renamePresetDialog(defName, function(name) {
      var preset = { id: 'c' + Date.now(), name: name, curve: curve };
      _presetList.push(preset);
      _savePresetList(_presetList);
      var btn = _buildPresetBtn(preset);
      var list = document.getElementById('all-presets-list');
      if (list) list.appendChild(btn);
      _applyPresetLayout(true);
      if (btn.scrollIntoView) btn.scrollIntoView({ block: 'nearest' }); // in view
      if (makeActive) setPresetActive(preset.id); // an edited preset it came from is left as it was
    }, { title: title, ok: 'Save' });
  }
  function _customCount() { return _presetList.filter(function(p){ return !p.builtIn; }).length + 1; }
  // Paste Preset: a parsed curve becomes a preset once it is named
  function _createPresetFromCurve(curve) {
    _promptNewPreset(curve, 'Pasted ' + _customCount(), 'Name Pasted Preset', false);
  }

  // Add presets in bulk (file import): tiles go in before the New tile
  function _addPresetEntries(entries) {
    var list = document.getElementById('all-presets-list');
    if (!list || !entries.length) return;
    entries.forEach(function(p) {
      _presetList.push(p);
      var btn = _buildPresetBtn(p);
      list.appendChild(btn);
    });
    _savePresetList(_presetList);
    _applyPresetLayout(true);
  }
  function _presetSig(p) { return p.name + '|' + _curveToText(p.curve); }
  // Export / Import Presets: a JSON file { opencurve: 1, presets: [{ name, curve }] }.
  // Built-ins stay out of the file; imports skip entries already in the list.
  function _exportPresetsToFile() {
    var mine = _presetList.filter(function(p) { return !p.builtIn; });
    if (!mine.length) { _showCopyToast('No presets to export'); return; }
    var data = { opencurve: 1, version: CURRENT_VERSION, presets: mine.map(function(p) { return { name: p.name, curve: _cloneCurve(p.curve) }; }) };
    _saveTextFile('opencurve-presets.json', JSON.stringify(data, null, 2)).then(function(ok) {
      if (ok) _showCopyToast('Exported ' + mine.length + ' preset' + (mine.length === 1 ? '' : 's'), '#3ddc84');
    }, function(e) { console.log('[OC] export failed:', e); _showCopyToast('Export failed', '#ff9090'); });
  }
  function _importPresetsFromFile() {
    _openTextFile().then(function(text) {
      if (text === null || text === undefined) return;
      var parsed = null;
      // A BOM-prefixed file (some editors add one on save) makes JSON.parse throw,
      // which read as "Not an OpenCurve preset file" on a perfectly good export
      var raw = String(text);
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // strip a BOM
      try { parsed = JSON.parse(raw); } catch(_) {}
      var arr = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.presets) ? parsed.presets : null);
      if (!arr) { _showCopyToast('Not an OpenCurve preset file', '#ff9090'); return; }
      var have = {};
      _presetList.forEach(function(p) { have[_presetSig(p)] = true; });
      var seq = Date.now(), add = [], skipped = 0;
      arr.forEach(function(p, i) {
        var raw = p && p.curve;
        var c = typeof raw === 'string' ? _curveFromText(raw) : (raw ? _curveFromText(_curveToText(raw)) : null); // round trip validates the shape
        if (!c) { skipped++; return; }
        var entry = { id: 'i' + seq + '_' + i, name: String(p.name || ('Imported ' + (i + 1))).slice(0, 60), curve: c };
        if (have[_presetSig(entry)]) { skipped++; return; }
        have[_presetSig(entry)] = true;
        add.push(entry);
      });
      _addPresetEntries(add);
      if (add.length) _showCopyToast('Imported ' + add.length + ' preset' + (add.length === 1 ? '' : 's') + (skipped ? ' (' + skipped + ' skipped)' : ''), '#3ddc84');
      else _showCopyToast('Nothing new to import');
    }, function(e) { console.log('[OC] import failed:', e); _showCopyToast('Import failed', '#ff9090'); });
  }

  function _showPastePanel() {
    console.log('[OC] _showPastePanel called');
    var existingOv = document.getElementById('_paste-overlay');
    if (existingOv) existingOv.parentNode.removeChild(existingOv);
    var existingBox = document.getElementById('_paste-box');
    if (existingBox) existingBox.parentNode.removeChild(existingBox);

    var overlay = document.createElement('div');
    overlay.id = '_paste-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.55);z-index:9997;';
    document.body.appendChild(overlay);

    var boxW = 272;
    var vw = document.documentElement.clientWidth  || document.body.clientWidth;
    var vh = document.documentElement.clientHeight || document.body.clientHeight;
    var boxL = Math.round((vw - boxW) / 2);

    var box = document.createElement('div');
    box.id = '_paste-box';
    box.style.cssText = 'position:fixed;top:-9999px;left:'+boxL+'px;width:'+boxW+'px;visibility:hidden;background:#1c1c1c;border:1px solid rgba(255,255,255,0.18);z-index:9998;padding:20px;font-family:system-ui,sans-serif;';
    document.body.appendChild(box);

    function close() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (box.parentNode) box.parentNode.removeChild(box);
    }
    // Close on a click on the dark area, but only a press that also started
    // there: releasing a text-selection drag over it must not close the panel
    var ovDown = false;
    overlay.addEventListener('pointerdown', function() { ovDown = true; });
    overlay.addEventListener('click', function() { if (ovDown) close(); ovDown = false; });

    var title = document.createElement('div');
    title.textContent = 'Paste Preset';
    title.style.cssText = 'color:#e4e4e4;font-size:14px;font-weight:600;margin-bottom:8px;';
    box.appendChild(title);

    var desc = document.createElement('div');
    desc.textContent = 'Paste a cubic-bezier() or opencurve() value:';
    desc.style.cssText = 'color:#888;font-size:13px;margin-bottom:10px;';
    box.appendChild(desc);

    var pasteTf = _mkTextField(13, false, 'paste'), input = pasteTf.input;
    input.placeholder = 'cubic-bezier(0.42, 0, 0.58, 1)';
    pasteTf.wrap.style.marginBottom = '0'; // the error line under it makes up the popups' 16px above the buttons
    box.appendChild(pasteTf.wrap);

    var err = document.createElement('div');
    err.style.cssText = 'color:#ff9090;font-size:12px;line-height:14px;min-height:12px;margin-bottom:4px;'; // empty: the popups' 16px above the buttons
    box.appendChild(err);

    var btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;justify-content:flex-end;'; // every popup: Cancel, then the main button, at the right

    var addBtn = _modalBtn('Add Preset', null, 'primary');
    addBtn.style.marginLeft = '8px';
    addBtn.addEventListener('click', function() {
      var curve = _parseCubicBezier(input.value.trim());
      if (!curve) { err.textContent = 'Invalid format — expected cubic-bezier(x1, y1, x2, y2) or an opencurve(...) value'; return; }
      close();
      _createPresetFromCurve(curve);
    });

    var cancelBtn = _modalBtn('Cancel', null, 'plain');
    cancelBtn.addEventListener('click', close);

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(addBtn);
    box.appendChild(btnRow);

    setTimeout(function() {
      var bh = box.offsetHeight || 160;
      var t = Math.max(0, Math.round((vh - bh) / 5));
      box.style.top = t + 'px';
      box.style.visibility = 'visible';
      input.focus();
    }, 0);

    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') addBtn.click();
      if (e.key === 'Escape') close();
    });
  }

  function _pasteCoordinates() {
    console.log('[OC] _pasteCoordinates called');
    _showPastePanel();
  }

  // Mini context menu: Open Settings (preset list empty space), grid sizes (graph),
  // a point's handle/delete items (graph point) or the zoom toggle (timeline)
  function _showMiniCtxMenu(e, showSettings, showGrid, pointIdx, showTlZoom, rowKey) {
    console.log('[OC] _showMiniCtxMenu called');
    e.preventDefault();
    e.stopPropagation();
    _hideCtxMenu();
    var existing = document.getElementById('_mini-ctx');
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

    var mini = document.createElement('div');
    mini.className = 'ctx-menu';
    mini.id = '_mini-ctx';
    mini.style.display = 'block';

    var _icSettings = '<svg width="16" height="16" viewBox="0 0 12 12" fill="none"><path d="M10.18 5 L11.53 5.12 L11.53 6.88 L10.18 7 A4.3 4.3 0 0 1 9.67 8.25 L9.67 8.25 L10.53 9.29 L9.29 10.53 L8.25 9.67 A4.3 4.3 0 0 1 7 10.18 L7 10.18 L6.88 11.53 L5.12 11.53 L5 10.18 A4.3 4.3 0 0 1 3.75 9.67 L3.75 9.67 L2.71 10.53 L1.47 9.29 L2.33 8.25 A4.3 4.3 0 0 1 1.82 7 L1.82 7 L0.47 6.88 L0.47 5.12 L1.82 5 A4.3 4.3 0 0 1 2.33 3.75 L2.33 3.75 L1.47 2.71 L2.71 1.47 L3.75 2.33 A4.3 4.3 0 0 1 5 1.82 L5 1.82 L5.12 0.47 L6.88 0.47 L7 1.82 A4.3 4.3 0 0 1 8.25 2.33 L8.25 2.33 L9.29 1.47 L10.53 2.71 L9.67 3.75 A4.3 4.3 0 0 1 10.18 5 Z M8.3 6 A2.3 2.3 0 0 0 3.7 6 A2.3 2.3 0 0 0 8.3 6 Z" fill="currentColor" fill-rule="evenodd"/></svg>';
    var _icTlKeys = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M1.6 4.2V1.6h2.6M9.8 1.6h2.6v2.6M12.4 9.8v2.6H9.8M4.2 12.4H1.6V9.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M4.7 5.4L6.3 7L4.7 8.6L3.1 7Z" fill="currentColor"/><path d="M9.3 5.4L10.9 7L9.3 8.6L7.7 7Z" fill="currentColor"/></svg>';
    var _icTlClip = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><rect x="1.3" y="3.6" width="11.4" height="6.8" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M4.9 5.6L6.3 7L4.9 8.4L3.5 7Z" fill="currentColor"/><path d="M9.1 5.6L10.5 7L9.1 8.4L7.7 7Z" fill="currentColor"/></svg>';


    function _miniItem(label, icon, onClick) {
      var item = document.createElement('div');
      item.className = 'ctx-menu-item';
      item.style.display = 'flex';
      item.style.alignItems = 'center';
      var iconSpan = document.createElement('span');
      iconSpan.style.cssText = 'display:flex;align-items:center;flex-shrink:0;opacity:0.7;margin-right:10px;';
      iconSpan.innerHTML = icon;
      item.appendChild(iconSpan);
      var labelSpan = document.createElement('span');
      labelSpan.textContent = label;
      item.appendChild(labelSpan);
      item.addEventListener('click', function(ev) {
        ev.stopPropagation();
        if (mini.parentNode) mini.parentNode.removeChild(mini);
        onClick();
      });
      mini.appendChild(item);
    }

    var _icPtDelete = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path fill="none" d="M3 4h8M5.5 4V3a1 1 0 011-1h1a1 1 0 011 1v1M4.5 4l.5 7.5a1 1 0 001 .5h2a1 1 0 001-.5L9.5 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    var _icPtSmooth = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M1.5 11C5 11 9 3 12.5 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="7" cy="7" r="1.6" fill="currentColor"/></svg>';
    var _icPtBreak  = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M1.5 11L7 7L12.5 11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="7" cy="7" r="1.6" fill="currentColor"/></svg>';

    if (typeof pointIdx === 'number') {
      // Right-click on a curve point
      var pc = getState().curve, pp = (pc.pts || [])[pointIdx];
      var isSmooth = !pp || pp.smooth !== false;
      _miniItem(isSmooth ? 'Break Handles' : 'Smooth Handles', isSmooth ? _icPtBreak : _icPtSmooth, function() { _setPointSmooth(pointIdx, !isSmooth); });
      _miniItem('Delete Point', _icPtDelete, function() { _removePoint(pointIdx); });
    } else {
    // Timeline menu: what the lanes span. Open Settings only appears in the preset
    // list's empty-space menu, where it is the only item.
    // Timeline menu for one property (the row or lane under the pointer): the
    // row's own buttons as menu items, then the zoom toggle below a rule
    if (showTlZoom && rowKey) {
      var rs = getState();
      var rrow = (rs.availableParams || []).filter(function(p) { return p.key === rowKey; })[0];
      if (rrow) {
        var rbtn = document.querySelector('.prop-btn[data-key="' + rowKey + '"]');
        var rels = (rbtn && rbtn._oc) || {};
        // Copied without any inline style (in UXP the row icons carry an absolute
        // position from _centerIcons; kept the same here)
        var rIc = function(el) { return el ? el.innerHTML.replace(/\sstyle="[^"]*"/g, '') : ''; };
        var rSel   = (rs.selectedParamKeys || []).indexOf(rowKey) >= 0;
        var rValid = (rs.validParamKeys    || []).indexOf(rowKey) >= 0;
        var rBaked = (rs.bakedParamKeys    || []).indexOf(rowKey) >= 0;
        var _icSel   = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M2.6 7.4L5.6 10.4L11.4 3.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        var _icUnsel = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M3.5 3.5L10.5 10.5M10.5 3.5L3.5 10.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
        if (rSel) _miniItem('Deselect', _icUnsel, function() { _togglePropKey(rowKey); });
        else if (rValid) _miniItem('Select for Go', _icSel, function() { _togglePropKey(rowKey); });
        _miniItem('Jump to Keyframes', rIc(rels.pin), function() {
          var live = (getState().availableParams || []).filter(function(x) { return x.key === rowKey; })[0];
          _jumpToParam(live || rrow);
        });
        if (rBaked) {
          if (rrow.bakeCurve) _miniItem('Load Baked Curve', rIc(rels.curve), function() { _loadBakedCurve(rowKey); });
          if (_replaceOk(rrow, rs.curve)) _miniItem('Replace with Current Curve', rIc(rels.replace), function() { _replaceBakeForKey(rowKey); });
          _miniItem('Undo Bake', rIc(rels.undo), function() { _undoBakeForKey(rowKey); });
        }
        var rRule = document.createElement('div');
        rRule.style.cssText = 'height:1px;margin:4px 0;background-color:rgba(255,255,255,0.08);';
        mini.appendChild(rRule);
      }
    }
    if (showTlZoom) {
      _miniItem(_tlZoomKeys ? 'Show Whole Clip' : 'Zoom to Keyframes',
                _tlZoomKeys ? _icTlClip : _icTlKeys,
                function() { _tlSetZoom(!_tlZoomKeys); });
    }
    if (showSettings) _miniItem('Open Settings', _icSettings, function() { _showSettingsModal(); });

    if (showGrid) {
      var gridFirst = !mini.firstChild; // the graph menu is the grid row alone: no rule above it, no top padding
      var gridRow = document.createElement('div');
      gridRow.style.cssText = 'display:flex;' + (gridFirst ? '' : 'border-top:1px solid rgba(255,255,255,0.07);');
      if (gridFirst) mini.style.paddingTop = '0';
      var gridSizes = [4, 8, 16];
      gridSizes.forEach(function(size) {
        var gb = document.createElement('div');
        gb.textContent = size + 'x' + size;
        var isActive = _gridSize === size;
        gb.style.cssText = 'flex:1;font-size:14px;padding:7px 0;cursor:pointer;display:flex;align-items:center;justify-content:center;'
          + 'color:' + (isActive ? '#3ddc84' : '#888') + ';'
          + 'background:' + (isActive ? 'rgba(61,220,132,0.08)' : 'transparent') + ';';
        gb.addEventListener('mouseenter', function() {
          gb.style.background = _gridSize === size ? 'rgba(61,220,132,0.15)' : 'rgba(255,255,255,0.05)';
          gb.style.color = _gridSize === size ? '#3ddc84' : '#e4e4e4';
        });
        gb.addEventListener('mouseleave', function() {
          gb.style.background = _gridSize === size ? 'rgba(61,220,132,0.08)' : 'transparent';
          gb.style.color = _gridSize === size ? '#3ddc84' : '#888';
        });
        gb.addEventListener('click', function(ev) {
          ev.stopPropagation();
          _gridSize = size;
          localStorage.setItem(_GRID_KEY, size);
          if (_svgW > 0 && _svgH > 0) updateStaticSVG(_svgW, _svgH);
          gridRow.querySelectorAll('div').forEach(function(el, idx) {
            var a = gridSizes[idx] === size;
            el.style.color = a ? '#3ddc84' : '#888';
            el.style.background = a ? 'rgba(61,220,132,0.08)' : 'transparent';
          });
        });
        gridRow.appendChild(gb);
      });
      mini.appendChild(gridRow);
      mini.style.paddingBottom = '0';
    }
    } // end of the non-point menu

    mini.style.left = '0px';
    mini.style.top = '0px';
    document.body.appendChild(mini);
    void mini.offsetHeight;
    var mw = mini.offsetWidth || 170;
    var mh = mini.offsetHeight || 100;
    var ww = document.documentElement.clientWidth  || document.body.clientWidth;
    var wh = document.documentElement.clientHeight || document.body.clientHeight;
    var x = Math.min(e.clientX, ww - mw);
    var y = e.clientY + mh > wh ? e.clientY - mh : e.clientY;
    mini.style.left = Math.max(0, x) + 'px';
    mini.style.top  = Math.max(0, y) + 'px';

    function removeMini(ev) {
      if (!mini.contains(ev.target)) {
        if (mini.parentNode) mini.parentNode.removeChild(mini);
        window.removeEventListener('pointerdown', removeMini);
      }
    }
    window.addEventListener('pointerdown', removeMini);
  }

  // Right-click on empty space in preset list
  (function() {
    var list = document.getElementById('all-presets-list');
    if (!list) return;
    list.addEventListener('contextmenu', function(e) {
      var onPreset = e.target.closest && e.target.closest('.preset-btn');
      // Presets have their own menu; empty space gets Open Settings alone
      if (onPreset) return;
      _showMiniCtxMenu(e, true);
    });
  })();

  // Right-click on the mini timeline's lanes or the property rows: the zoom toggle.
  // Bound to the SVG and its wrapper both; _showMiniCtxMenu stops propagation,
  // so the wrapper only ever handles the strip of area outside the SVG.
  (function() {
    // The property rows (#prop-btns, in the same row) open it too
    // The property under the pointer: its row, or the lane at that height
    function _tlKeyAtEvent(e) {
      var row = e.target && e.target.closest ? e.target.closest('.prop-btn') : null;
      if (row) return row.dataset.key || null;
      var svg = document.getElementById('tl-svg'), g = _tlGeo;
      if (!svg || !g || !g.n) return null;
      var i = Math.floor((e.clientY - svg.getBoundingClientRect().top - g.y0) / g.laneH);
      return (i >= 0 && i < g.n && _tlLanes[i]) ? _tlLanes[i].key : null;
    }
    var targets = [document.getElementById('tl-svg'), document.querySelector('.tl-canvas-wrap'), document.getElementById('prop-btns')];
    targets.forEach(function(el) {
      if (!el) return;
      el.addEventListener('contextmenu', function(e) { _showMiniCtxMenu(e, false, false, null, true, _tlKeyAtEvent(e)); });
    });
  })();

  // Right-click on graph editor
  (function() {
    var graph = document.getElementById('bezier-svg');
    if (!graph) return;
    graph.addEventListener('contextmenu', function(e) {
      var hit = _graphHitTest ? _graphHitTest(e) : null;
      if (hit && hit.k === 'a') { _showMiniCtxMenu(e, false, false, hit.i); return; }
      _showMiniCtxMenu(e, false, true);
    });
  })();

  // New Preset button
  // New Preset button (the list is looked up at click time, as in the UXP
  // edition, whose scroller refresh replaces the element)
  (function() {
    if (!document.getElementById('all-presets-list')) return;

    // New Preset: the toolbar button at the left of the preset bar (#preset-new)
    // saves the current curve as a preset and opens its name for editing
    var newTool = document.getElementById('preset-new');
    if (newTool) {
      // Beside the button while it is in the graph's side column, below it in the preset bar
      _attachTooltip(newTool, 'New Preset: save the current curve as a preset', function() {
        return newTool.parentNode && newTool.parentNode.id === 'graph-side-tools' ? 'right' : null;
      });
      newTool.addEventListener('click', function() {
        _promptNewPreset(getState().curve, 'Custom ' + _customCount(), 'New Preset', true);
      });
    }
  }());

  // Resize handle
  var resizeHandle = document.getElementById('resize-handle');
  var rightCol     = document.getElementById('right-col');
  if (resizeHandle && rightCol) {
    var _RESIZE_KEY = 'opencurve-sidebar-width';
    var _savedW = _sidebarSavedW();
    if (_savedW) rightCol.style.width = _savedW + 'px';

    var _rx = 0, _rw = 0, _resizing = false;
    resizeHandle.addEventListener('pointerdown', function(e) {
      _resizing = true;
      _rx = e.clientX;
      _rw = rightCol.offsetWidth;
      resizeHandle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    resizeHandle.addEventListener('pointermove', function(e) {
      if (!_resizing) return;
      var newW = Math.max(120, Math.min(_sidebarMaxW(), _rw + (_rx - e.clientX)));
      rightCol.style.width = newW + 'px';
    });
    function _endResize() {
      if (_resizing) localStorage.setItem(_RESIZE_KEY, rightCol.offsetWidth);
      _resizing = false;
    }
    resizeHandle.addEventListener('pointerup',     _endResize);
    resizeHandle.addEventListener('pointercancel', _endResize);
    // The limits follow the panel, so re-clamp both columns from their saved
    // widths whenever the panel is resized (the rows only change size with it,
    // never during a drag, so this can't fight the handles)
    if (typeof ResizeObserver !== 'undefined') {
      var _mainRow = document.querySelector('.main-row');
      var _tlRow   = document.getElementById('oc-timeline');
      var _colRO = new ResizeObserver(function() {
        if (!_resizing && _graphVisible) {
          var sw = _sidebarSavedW();
          var want = sw ? sw + 'px' : '';
          if (rightCol.style.width !== want) rightCol.style.width = want;
        }
        _tlApplyPropsWidth();
        _tlSetGoWidth();
        // A floating menu is placed at fixed coordinates, so a resize would
        // leave it hanging over whatever is now underneath it
        if (_closeMenus) _closeMenus();
      });
      if (_mainRow) _colRO.observe(_mainRow);
      if (_tlRow)   _colRO.observe(_tlRow);
    }
  }

  // Apply saved graph visibility (hides the whole left column when disabled)
  _applyGraphVisibility();

  // Status strip — click to select all valid params
  var statusStrip = document.getElementById('status-strip');
  if (statusStrip) {
    _attachTooltip(statusStrip, function() {
      var st = getState();
      if (st.status === 'outside') return _nearestJumpParam(st) ? 'Click to jump to the nearest keyframe pair' : '';
      var valid = st.validParamKeys || [];
      if (valid.length === 0 || st.status === 'done' || st.isBaking) return '';
      var selN = (st.selectedParamKeys || []).filter(function(k){ return valid.indexOf(k) >= 0; }).length;
      return selN < valid.length ? 'Click to select all properties' : 'Click to clear selection';
    });
    statusStrip.addEventListener('click', function() {
      var s = getState();
      if (s.status === 'outside') {
        // "Move playhead between keyframes": take the user there
        var np = _nearestJumpParam(s);
        if (np) _jumpToParam({ jumpSec: np.nearSec });
        return;
      }
      var valid = s.validParamKeys || [];
      if (valid.length === 0) return;
      var selNow = (s.selectedParamKeys || []).filter(function(k){ return valid.indexOf(k) >= 0; });
      if (selNow.length < valid.length) {
        _selectAllValid(s); // select every valid property
      } else {
        // Everything already selected: second click clears the selection
        var down = { selectedParamKeys: [] };
        if (s.status === 'valid') down.status = 'no-selection';
        setState(down);
      }
    });
  }

  // Hover and press while the strip does something on a click, written inline:
  // renderUI rewrites the strip's class on every state change, so a .pressed
  // class wouldn't survive, and UXP applies the compound :hover rules unreliably
  var _stripHov = false, _stripDown = false, _stripClickable = false;
  function _paintStrip() {
    if (!statusStrip) return;
    var bg = !_stripClickable ? '' : _stripDown ? 'rgba(255,255,255,0.2)' : _stripHov ? 'rgba(255,255,255,0.12)' : '';
    if (statusStrip._ocBg !== bg) { statusStrip._ocBg = bg; statusStrip.style.backgroundColor = bg; }
  }
  if (statusStrip) {
    statusStrip.addEventListener('mouseenter', function() { _stripHov = true; _paintStrip(); });
    statusStrip.addEventListener('mouseleave', function() { _stripHov = false; _stripDown = false; _paintStrip(); });
    statusStrip.addEventListener('pointerdown', function() { _stripDown = true; _paintStrip(); });
    statusStrip.addEventListener('pointerup', function() { if (_stripDown) { _stripDown = false; _paintStrip(); } });
    statusStrip.addEventListener('pointercancel', function() { if (_stripDown) { _stripDown = false; _paintStrip(); } });
  }
  function _updateStripCursor(s) {
    if (!statusStrip) return;
    var valid = s.validParamKeys || [];
    var clickable = (valid.length > 0 && s.status !== 'done' && !s.isBaking)
                 || (s.status === 'outside' && !!_nearestJumpParam(s));
    // Change-only: this runs on every setState, and UXP relayouts on every write
    var cur = clickable ? 'pointer' : 'default';
    if (statusStrip.style.cursor !== cur) statusStrip.style.cursor = cur;
    _stripClickable = clickable;
    _paintStrip();
  }
  stateListeners.push(_updateStripCursor);

  // Go button — calls bridge.onGo()
  var goBtn = document.getElementById('go-btn');
  if (goBtn) {
    _addPressState(goBtn); // mirrors hover as a class (the select-all highlight, see go-select)
    _attachTooltip(goBtn, function() {
      if (_goSelectsAll(getState())) return 'Select all ready properties (press Go again to apply)';
      if (_goJumps(getState())) return 'Jump to the nearest keyframe pair';
      return goBtn.classList.contains('btn-disabled')
        ? 'Select a property that the playhead is over'
        : 'Apply the curve to the selected properties';
    });
    goBtn.addEventListener('click', function() {
      var s = getState();
      if (_goSelectsAll(s)) { _selectAllValid(s); return; }
      if (_goJumps(s)) { _jumpToParam({ jumpSec: _nearestJumpParam(s).nearSec }); return; }
      var bakedKeys = (s.selectedParamKeys || [])
        .filter(function(k){ return (s.validParamKeys || []).indexOf(k) >= 0 && s.paramContexts && s.paramContexts[k]; });
      if (s.status !== 'valid' || s.isBaking || bakedKeys.length === 0) return;
      _pvStop();

      // Delegate to platform bridge
      if (_bridge && _bridge.onGo) {
        _bridge.onGo(s, bakedKeys);
      }
    });
  }

  // State → UI
  stateListeners.push(renderUI);
  renderUI(getState());
  // The panel opens on Cubic In-Out. Saved over (the graph bar's Save), it opens
  // on the saved curve, or the tile would read "edited" on every launch
  var _startP = _presetByIdRef ? _presetByIdRef('cubic-in-out') : null;
  if (_startP && !_sameCurve(_startP.curve, state.curve)) {
    setState({ curve: _startP.curve });
    if (_svgW > 0 && _svgH > 0) updateDynamicSVG(getState().curve, _svgW, _svgH);
  }
  setPresetActive('cubic-in-out');
}

// ─── Settings / shared variables ─────────────────────────────────────────
var CURRENT_VERSION     = '2.1.0';
var _CURVE_COLOR_KEY    = 'opencurve-line-color';
var _curveColor         = localStorage.getItem(_CURVE_COLOR_KEY) || '#ffffff';
var _updateAvailable    = false;
var _latestVersion      = null;
var _updateDismissed    = false;
var _lastUpdateCheckAt  = 0;       // throttles the silent check (see _checkForUpdates)
var _UPDATE_CHECK_MS    = 3600000; // an hour between silent checks
var _UPDATE_NOTIF_KEY   = 'opencurve-update-notif';
var _updateNotifsOn     = localStorage.getItem(_UPDATE_NOTIF_KEY) !== 'off';
var _ANIM_KEY           = 'opencurve-animations';
var _animationsOn       = localStorage.getItem(_ANIM_KEY) !== 'off';
// 2.0.0: "Scan During Playback" is always on (the toggle only made the panel
// worse). Drop the old key so a user who had turned it off comes back on.
try { localStorage.removeItem('opencurve-scan-during-playback'); } catch(e) {}
var _GRID_KEY           = 'opencurve-grid-size';
var _gridSize           = parseInt(localStorage.getItem(_GRID_KEY), 10) || 8;
if ([4, 8, 16].indexOf(_gridSize) < 0) _gridSize = 8; // only the three the menu offers
var _LAYOUT_KEY         = 'opencurve-preset-layout';
var _presetLayout       = localStorage.getItem(_LAYOUT_KEY) || 'list';
var _GRAPH_KEY          = 'opencurve-graph-visible';
// Defaults to On — only hidden when the user has explicitly disabled the graph.
var _graphVisible       = localStorage.getItem(_GRAPH_KEY) !== 'off';
// Set when a graph redraw was skipped because the column is hidden (the SVG
// keeps its last visible size, so every redraw path would otherwise still
// write the whole SVG into the display:none column). _applyGraphVisibility
// redraws once when the graph comes back; the resize observer clears it too.
var _graphDirty         = false;
var _DENSITY_KEY        = 'opencurve-bake-density';
try { localStorage.removeItem('opencurve-preview-after-go'); } catch(_) {} // a setting that existed briefly during 2.0 development
// Keyframe spacing when baking, in frames: 1 (every frame, exact), 2 or 4.
// Premiere draws straight lines between the baked keyframes, so wider spacing
// trades a little accuracy for a lighter keyframe track (the host reads it
// from the bake args, see bakeKeyframes in host.jsx).
var _bakeDensity        = parseInt(localStorage.getItem(_DENSITY_KEY), 10) || 1;
if ([1, 2, 4].indexOf(_bakeDensity) < 0) _bakeDensity = 1;
var _isDragging         = false;

// Bridge object — set by platform-specific code before calling initPanel()
var _bridge = null;

// Show or hide the whole graph column. When hidden, the preset list takes the
// full panel width. The status strip and the mini timeline sit at the bottom of
// the panel in both layouts, so they need no moving. Everything is done with
// inline styles because UXP does not relayout on class changes.
var _newPresetPlace = null; // set by initPanel: puts #preset-new in the graph bar or the preset bar
function _applyGraphVisibility() {
  if (_newPresetPlace) _newPresetPlace();
  var leftCol  = document.querySelector('.left-col');
  var handle   = document.getElementById('resize-handle');
  var rightCol = document.getElementById('right-col');
  if (!leftCol || !rightCol) return;
  // Turning the graph off while it is full screen: leave full screen first,
  // otherwise every region of the panel would be hidden at once
  if (_graphFull && !_graphVisible) { _graphFull = false; _applyGraphFull(); return; }
  if (_graphVisible) {
    leftCol.style.display = '';
    if (handle) handle.style.display = '';
    if (_graphDirty && _svgW > 0 && _svgH > 0) { // redraws skipped while hidden (the observer covers a size change)
      _graphDirty = false;
      updateStaticSVG(_svgW, _svgH);
      updateDynamicSVG(getState().curve, _svgW, _svgH);
      _updateContentTransform();
    }
    var savedW = _sidebarSavedW();
    rightCol.style.width    = savedW ? savedW + 'px' : '';
    rightCol.style.maxWidth = '';
    rightCol.style.flex     = '';
  } else {
    leftCol.style.display = 'none';
    if (handle) handle.style.display = 'none';
    rightCol.style.width    = '100%';
    rightCol.style.maxWidth = 'none';
    rightCol.style.flex     = '1 1 auto';
  }
  _fitGoForUndo();
  _applyPresetLayout(true);
  if (_graphFull) _applyGraphFull(); // keeps the preset column and handle hidden
}

// Full-screen graph (toolbar #graph-full): the graph column takes the whole
// panel. The preset column and its handle, the timeline row and the bottom row
// are hidden with inline display (UXP ignores class-driven display changes)
// until the button is pressed again; every toolbar tool still works meanwhile.
// Session only, never saved. The graph SVG, the toolbar and the lanes all
// re-measure through their ResizeObservers, so nothing else needs a nudge.
var _graphFull = false;
function _applyGraphFull() {
  ['right-col', 'resize-handle', 'tl-resize', 'oc-timeline', 'oc-bottom-row'].forEach(function(id) {
    var el = document.getElementById(id);
    if (!el) return;
    if (_graphFull) el.style.display = 'none';
    else if (el.style.display === 'none') el.style.display = '';
  });
  if (!_graphFull) {
    _applyGraphVisibility(); // restores the preset column's width and handle
    _tlSig = '';
    _tlRender(getState(), true);
  }
  var btn = document.getElementById('graph-full');
  if (btn) {
    var ex = btn.querySelector('.ic-expand'), co = btn.querySelector('.ic-collapse');
    if (ex) ex.style.display = _graphFull ? 'none' : '';
    if (co) co.style.display = _graphFull ? '' : 'none';
    btn.style.backgroundColor = _graphFull ? 'rgba(74,158,255,0.18)' : '';
    btn.style.color      = _graphFull ? '#6cb8ff' : '';
  }
}
function _setGraphFull(on) {
  if (on && !_graphVisible) return; // no graph to expand
  _graphFull = !!on;
  _applyGraphFull();
}

// The Undo button floats over the right end of Go, which is a narrow button
// (the property column's width) at the end of the bottom row, so nudge the
// label left while Undo is showing.
// Inline style because UXP doesn't relayout on class changes.
function _fitGoForUndo() {
  var goBtn = document.getElementById('go-btn');
  var undo  = document.getElementById('undo-btn');
  if (!goBtn) return;
  var shown = !!undo && undo.style.display !== 'none';
  goBtn.style.paddingRight = shown ? '28px' : '';
}

function _applyPresetLayout(force) {
  _styleLayoutBtn();
  var list = document.getElementById('all-presets-list');
  if (!list) return;
  var isGrid = _presetLayout === 'grid';
  var w = list.offsetWidth || 180;
  // Grid: 3 columns from 220px, else 2. List: two columns side by side once
  // the column is wide enough for two readable rows (_LIST_2COL_W).
  var cols = isGrid ? (w >= 220 ? 3 : 2) : (w >= _LIST_2COL_W ? 2 : 1);
  _presetCols = cols;
  var multi = cols > 1;
  var btnCount = list.querySelectorAll('.preset-btn').length;
  var cacheKey = (isGrid ? 'g' : 'l') + cols + '_' + btnCount;
  if (!force && _applyPresetLayout._lastKey === cacheKey) return;
  _applyPresetLayout._lastKey = cacheKey;
  var itemW = multi ? (100/cols).toFixed(3) + '%' : '100%';
  var thumbSz = isGrid ? (cols >= 3 ? 40 : 42) : 28;

  if (multi) {
    list.style.display = 'flex';
    list.style.flexWrap = 'wrap';
    list.style.alignContent = 'flex-start';
    list.style.padding = '0';
    list.style.gap = '0';
  } else {
    list.style.display = '';
    list.style.flexWrap = '';
    list.style.alignContent = '';
    list.style.padding = '';
    list.style.gap = '';
  }

  list.querySelectorAll('.preset-btn').forEach(function(btn) {
    if (isGrid) {
      btn.style.width = itemW;
      btn.style.flexDirection = 'column';
      btn.style.padding = '8px 4px 2px';
      btn.style.border = 'none';
      btn.style.borderBottom = 'none';
      btn.style.marginRight = '0';
      btn.style.marginBottom = '0';
      btn.style.textAlign = 'center';
      btn.style.gap = '0';
      btn.style.alignItems = 'center';
      btn.style.alignSelf = 'flex-start';
      btn.style.overflow = 'visible';
      btn.style.whiteSpace = 'normal';
      btn.style.minHeight = (thumbSz + 34) + 'px'; // 8px padding + thumbnail + 4px gap + a line of name + 2px padding
    } else if (multi) {
      // Two-column list: ordinary rows, half width each, so the whole
      // button set (width, wrap) is inline like the grid (UXP relayout rule).
      btn.style.width = itemW;
      btn.style.flexDirection = '';
      btn.style.padding = '';
      btn.style.border = '';
      btn.style.borderBottom = '';
      btn.style.marginRight = '0';
      btn.style.marginBottom = '0';
      btn.style.textAlign = '';
      btn.style.gap = '';
      btn.style.alignItems = '';
      btn.style.alignSelf = 'flex-start';
      btn.style.overflow = '';
      btn.style.whiteSpace = '';
      btn.style.minHeight = '';
    } else {
      btn.style.width = '';
      btn.style.flexDirection = '';
      btn.style.padding = '';
      btn.style.borderBottom = '';
      btn.style.border = '';
      btn.style.textAlign = '';
      btn.style.gap = '';
      btn.style.alignItems = '';
      btn.style.alignSelf = '';
      btn.style.overflow = '';
      btn.style.whiteSpace = '';
      btn.style.minHeight = '';
      btn.style.marginRight = '';
      btn.style.marginBottom = '';
    }
  });

  list.querySelectorAll('.preset-name').forEach(function(n) {
    if (isGrid) {
      // One line, cut with an ellipsis. The name spans the tile's whole content
      // box, so the cut lands exactly where the text used to wrap onto a second
      // line (the update tile's <br> still breaks it on purpose)
      n.style.whiteSpace = 'nowrap';
      n.style.overflow = 'hidden';
      n.style.textOverflow = 'ellipsis';
      n.style.width = '100%';
      n.style.maxWidth = '100%';
      n.style.marginTop = '4px';
    } else {
      n.style.whiteSpace = '';
      n.style.overflow = '';
      n.style.textOverflow = '';
      n.style.width = '';
      n.style.maxWidth = '';
      n.style.marginTop = '';
    }
  });

  // The thumbnail SVG scales its 28-unit viewBox, so the curve's stroke is set in
  // those units: about 2.25px wide at the grid sizes instead of thickening with them
  list.querySelectorAll('.preset-thumb').forEach(function(t) {
    var tp = t.querySelector ? t.querySelector('path') : null; // the update tile's icon is a div
    if (isGrid) {
      t.setAttribute('width', String(thumbSz));
      t.setAttribute('height', String(thumbSz));
      t.style.marginRight = '0';
      if (tp) tp.setAttribute('stroke-width', (2.25 * 28 / thumbSz).toFixed(2));
    } else {
      t.setAttribute('width', '28');
      t.setAttribute('height', '28');
      t.style.marginRight = '';
      if (tp) tp.setAttribute('stroke-width', '2');
    }
  });

  var notifEl = document.getElementById('_update-notif');
  if (notifEl) {
    var notifIcon = notifEl.querySelector('.preset-thumb');
    var notifName = notifEl.querySelector('.preset-name');
    var notifBr = notifEl.querySelector('.notif-br');
    if (isGrid) {
      // The SVG icon 8px under the thumbnail size (32/34px): with the name on two
      // lines it takes the same height as a thumbnail and one line of name
      var nis = (thumbSz - 8) + 'px';
      if (notifIcon) { notifIcon.style.width = nis; notifIcon.style.height = nis; notifIcon.style.fontSize = ''; notifIcon.style.marginTop = '-2px'; }
      if (notifName) { notifName.style.fontSize = '12px'; notifName.style.marginTop = '2px'; notifName.style.lineHeight = '1.2'; }
      if (notifBr) notifBr.style.display = '';
    } else {
      if (notifIcon) { notifIcon.style.width = '28px'; notifIcon.style.height = '28px'; notifIcon.style.fontSize = ''; notifIcon.style.marginTop = ''; }
      if (notifName) { notifName.style.fontSize = ''; notifName.style.marginTop = ''; notifName.style.lineHeight = ''; }
      if (notifBr) notifBr.style.display = 'none';
    }
  }
  var notifDel = list.querySelector('#_update-notif .preset-delete');
  if (notifDel) {
    if (isGrid) {
      notifDel.style.position = 'absolute';
      notifDel.style.top = '4px';
      notifDel.style.right = '4px';
      notifDel.style.marginLeft = '0';
    } else {
      notifDel.style.position = '';
      notifDel.style.top = '';
      notifDel.style.right = '';
      notifDel.style.marginLeft = '';
    }
  }

  if (multi) {
    void list.offsetHeight;
    if (!_applyPresetLayout._pending) {
      _applyPresetLayout._pending = true;
      setTimeout(function() {
        _applyPresetLayout._pending = false;
        var btns = list.querySelectorAll('.preset-btn');
        btns.forEach(function(b) { b.style.alignSelf = 'flex-start'; });
        list.style.alignContent = 'flex-start';
        void list.offsetHeight;
        _presetUpdateFade();
      }, 200);
    }
  }
  _presetUpdateFade(); // tiles added, removed or resized
}
var _gridColsTimer = null;
var _LIST_2COL_W = 340; // list view splits into two columns from this width
var _presetCols = 1;    // columns the last _applyPresetLayout laid out
function _updateGridCols() {
  if (_gridColsTimer) clearTimeout(_gridColsTimer);
  _gridColsTimer = setTimeout(function() { _applyPresetLayout(); _presetUpdateFade(); }, 60); // a height change moves where the list ends
}

// Edge fades on the preset list, the same bands as the timeline's (#tl-fade):
// the bottom one while the list can scroll further down, the top one while
// tiles are scrolled up out of view. Same code as the UXP edition, where the
// position has to come from scrollTop and only sizes from bounding rects (a
// child's rect doesn't follow a scroll in the CCX). The list has no inner box,
// so the content height runs from the first tile's top to the lowest of the
// last three bottoms (the last grid row); the scrollbar's width is the list's
// right edge less the tiles'. Called on scroll, after every layout pass, on a
// list resize and when a tile goes. keep === 'keep' reuses the last measured
// sizes (UXP calls it that way right after its scroller swap; CEP never does).
var _presetFadeSize = null; // { over, right } from the last measured call
function _presetUpdateFade(keep) {
  var list = document.getElementById('all-presets-list'), fade = document.getElementById('preset-fade');
  if (!list || !fade) return;
  var size = _presetFadeSize, top = 0;
  try { top = list.scrollTop; } catch(_) {}
  if (keep !== 'keep' || !size) {
    size = { over: 0, right: 0 };
    try {
      var kids = list.children, n = kids.length;
      if (n) {
        var lr = list.getBoundingClientRect(), fr = kids[0].getBoundingClientRect();
        var bottom = fr.bottom, right = fr.right;
        for (var i = Math.max(1, n - 3); i < n; i++) {
          var r = kids[i].getBoundingClientRect();
          if (r.bottom > bottom) bottom = r.bottom;
          if (r.right  > right)  right  = r.right;
        }
        size.over = Math.max(0, Math.round(bottom - fr.top - lr.height)); // how far the list can scroll
        if (size.over > 0) size.right = Math.max(0, Math.round(lr.right - right));
      }
    } catch(_) {}
    _presetFadeSize = size;
  }
  // Change-only writes: this runs on every scroll event of the list
  var right = size.right + 'px', ob = (size.over - top) > 1 ? '1' : '0', ot = top > 1 ? '1' : '0';
  var fs = fade.style;
  if (fs.right   !== right) fs.right   = right;
  if (fs.opacity !== ob)    fs.opacity = ob;
  var fadeTop = document.getElementById('preset-fade-top');
  if (fadeTop) {
    var ts = fadeTop.style;
    if (ts.right   !== right) ts.right   = right;
    if (ts.opacity !== ot)    ts.opacity = ot;
  }
}

function _hexToRgba(hex, alpha) {
  var r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return 'rgba('+r+','+g+','+b+','+alpha+')';
}

function _applyCurveColor(color) {
  _curveColor = color;
  var el = document.getElementById('sg-curve');
  if (el) el.setAttribute('stroke', color);
  var dg = document.getElementById('sg-drag-ghost');
  if (dg) dg.setAttribute('stroke', color);
  var ep0 = document.getElementById('sg-ep0');
  if (ep0) ep0.setAttribute('stroke', color);
  var ep3 = document.getElementById('sg-ep3');
  if (ep3) ep3.setAttribute('stroke', color);
  for (var pi = 0; pi < _ptEls.length; pi++) { _ptEls[pi].inner.setAttribute('stroke', color); _ptEls[pi].sq.setAttribute('stroke', color); }
  document.querySelectorAll('.preset-thumb path').forEach(function(p) {
    if (p.getAttribute('data-oc-keep')) return; // the update tile's icon stays amber
    p.setAttribute('stroke', color);
  });
  if (/^#[0-9a-fA-F]{6}$/.test(color)) {
    var bg  = _hexToRgba(color, 0.15);
    var bg2 = _hexToRgba(color, 0.28);
    var root = document.documentElement;
    root.style.setProperty('--oc-active-color', color);
    root.style.setProperty('--oc-active-bg',    bg);
    root.style.setProperty('--oc-active-bg2',   bg2);
    root.style.setProperty('--oc-edited-bg',    _hexToRgba(color, 0.07));
    root.style.setProperty('--oc-edited-bg2',   _hexToRgba(color, 0.16));
    // The graph bar chip's preset name: the theme colour a third of the way to
    // white, so it reads brighter than the tinted fill around it
    var _nm = [1, 3, 5].map(function(i) { var c = parseInt(color.substr(i, 2), 16); return Math.round(c + (255 - c) * 0.35); });
    root.style.setProperty('--oc-name-color',   'rgb(' + _nm.join(',') + ')');
  }
  _presetEditSync(); // the edited tile's dot
}

function _showCopyToast(msg, color) {
  // Full-width flex wrapper centres the toast without transform (unreliable in
  // UXP) and lets long messages (undo results) wrap instead of truncating.
  var wrap = document.createElement('div');
  wrap.style.cssText = [
    'position:fixed', 'top:10px', 'left:0', 'right:0', 'display:flex',
    'justify-content:center', 'padding:0 12px', 'box-sizing:border-box',
    'pointer-events:none', 'z-index:99999', 'opacity:1', 'transition:opacity 0.3s',
  ].join(';');
  var toast = document.createElement('div');
  toast.textContent = msg;
  toast.style.cssText = [
    'background:#252525', 'border:1px solid rgba(255,255,255,0.12)',
    'color:'+(color||'#e4e4e4'), 'font-size:15px', 'line-height:1.3',
    'padding:7px 14px', 'border-radius:0', 'max-width:100%',
    'box-sizing:border-box', 'white-space:normal', 'text-align:center',
    'pointer-events:auto', 'cursor:pointer',
  ].join(';');
  // A press on the toast dismisses it at once (the wrapper stays click-through,
  // so only the toast itself catches the press). Both press events: CEP on
  // macOS delivers no pointerdown (see pointer-shim.js).
  function dismiss(ev) {
    if (ev) { ev.stopPropagation(); ev.preventDefault(); }
    if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
  }
  toast.addEventListener('pointerdown', dismiss);
  toast.addEventListener('mousedown', dismiss);
  wrap.appendChild(toast);
  document.body.appendChild(wrap);
  var delay = color ? 2800 : 1800;
  setTimeout(function() { wrap.style.opacity = '0'; }, delay);
  setTimeout(function() { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); }, delay + 400);
}

function _refreshUpdateNotification() {
  var list = document.getElementById('all-presets-list');
  if (!list) return;
  var existing = document.getElementById('_update-notif');
  if (existing) existing.parentNode.removeChild(existing);
  if (!_updateAvailable || _updateDismissed || !_updateNotifsOn) { if (existing) _presetUpdateFade(); return; }

  var notif = document.createElement('div');
  notif.id = '_update-notif';
  notif.className = 'preset-btn';
  notif.style.color = '#e6b800';
  notif.style.backgroundColor = 'rgba(240,180,0,0.08)';
  notif.style.position = 'relative';

  // Icon: a circled up arrow drawn as SVG in the thumbnail's own place. It
  // carries .preset-thumb, so _applyPresetLayout sizes it like the curve
  // thumbnails (28px in the list, 40-42px in the grid) and sets its stroke in
  // the 28-unit viewBox; one path, so that stroke applies to all of it.
  var iconHost = document.createElement('span');
  iconHost.innerHTML = '<svg class="preset-thumb" width="28" height="28" viewBox="0 0 28 28" fill="none" style="flex-shrink:0;margin-right:8px;">'
    + '<path d="M3 14A11 11 0 1 1 25 14A11 11 0 1 1 3 14Z M14 19.5V8.5 M9 13.5L14 8.5L19 13.5" fill="none" stroke="#e6b800" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" data-oc-keep="1"/></svg>';
  var iconWrap = iconHost.firstChild;
  notif.appendChild(iconWrap);

  var nameSpan = document.createElement('span');
  nameSpan.className = 'preset-name';
  nameSpan.innerHTML = 'Update <br class="notif-br">Available';
  notif.appendChild(nameSpan);

  var delBtn = document.createElement('div');
  delBtn.className = 'preset-delete';
  delBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><line x1="1" y1="1" x2="9" y2="9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="9" y1="1" x2="1" y2="9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
  delBtn.style.cssText = 'opacity:0;width:22px;height:22px;display:flex;align-items:center;justify-content:center;';
  notif.addEventListener('mouseenter', function() { delBtn.style.opacity = '1'; notif.style.backgroundColor = 'rgba(240,180,0,0.15)'; });
  notif.addEventListener('mouseleave', function() { delBtn.style.opacity = '0'; delBtn.style.background = 'transparent'; notif.style.backgroundColor = 'rgba(240,180,0,0.08)'; });
  delBtn.addEventListener('mouseenter', function() { delBtn.style.background = 'rgba(255,144,144,0.25)'; });
  delBtn.addEventListener('mouseleave', function() { delBtn.style.background = 'transparent'; });
  notif.addEventListener('click', function(e) {
    if (e.target === delBtn) return;
    _openReleasesPage();
  });
  delBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    _updateDismissed = true;
    _refreshUpdateNotification();
  });
  notif.appendChild(delBtn);

  list.insertBefore(notif, list.firstChild);
  _applyPresetLayout(true);
}

// Settings > Updates card: the button and the line under the title follow the
// last check (Check now, or Download once a newer release is out)
function _applyUpdateBtnState(btn, label) {
  var txt = btn._ocText || btn;
  if (btn._ocAccent) btn._ocAccent(!!_updateAvailable);
  if (_updateAvailable) {
    txt.textContent = 'Download';
    label.textContent = 'Version ' + _latestVersion + ' is out (you have v' + CURRENT_VERSION + ')';
    label.style.color = '#e6b800';
  } else {
    txt.textContent = 'Check now';
    label.textContent = 'You have v' + CURRENT_VERSION + (_latestVersion ? ', the latest' : '');
    label.style.color = '#8c8c8c';
  }
}

function _openReleasesPage() {
  var url = 'https://github.com/fayewave/OpenCurve/releases/latest';
  // Use bridge to open external URL (platform-specific)
  if (_bridge && _bridge.openExternal) {
    _bridge.openExternal(url);
  } else {
    window.open(url);
  }
}

// True only when `a` is a strictly higher semver than `b` (e.g. 1.3.0 > 1.2.3).
// Lets a dev build run ahead of the published release without seeing an
// "update available" prompt; for normal users latest is always >= installed.
function _isNewerVersion(a, b) {
  var pa = String(a).split('.').map(function(n) { return parseInt(n, 10) || 0; });
  var pb = String(b).split('.').map(function(n) { return parseInt(n, 10) || 0; });
  for (var i = 0; i < 3; i++) {
    var x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

function _checkForUpdates(silent) {
  // The silent check runs on every panel show (workspace tab, dock/undock), so it
  // is throttled and must not resurrect a tile the user dismissed. Only a manual
  // check from the flyout clears the dismissal.
  if (silent) {
    if (Date.now() - _lastUpdateCheckAt < _UPDATE_CHECK_MS) return;
  } else {
    _updateDismissed = false;
  }
  _lastUpdateCheckAt = Date.now();
  if (!silent) _showCopyToast('Checking for updates\u2026');
  fetch('https://api.github.com/repos/fayewave/OpenCurve/releases/latest')
    .then(function(r) {
      if (!r.ok) throw new Error('GitHub API returned ' + r.status);
      return r.json();
    })
    .then(function(data) {
      if (!data || typeof data !== 'object' || !data.tag_name) {
        if (!silent) _showCopyToast('Unexpected response from GitHub');
        return;
      }
      if (data.html_url && data.html_url.indexOf('fayewave/OpenCurve') === -1) {
        console.warn('[OC] Update response URL mismatch — ignoring');
        return;
      }
      var latest = (data.tag_name || '').replace(/^v/, '');
      if (!latest || !/^\d+\.\d+\.\d+/.test(latest)) { if (!silent) _showCopyToast('No valid releases found on GitHub'); return; }
      _latestVersion = latest;
      if (!_isNewerVersion(latest, CURRENT_VERSION)) {
        _updateAvailable = false;
        if (!silent) _showCopyToast('OpenCurve is up to date (v' + CURRENT_VERSION + ')');
      } else {
        _updateAvailable = true;
        if (!silent) _showCopyToast('Update available: v' + latest + ' \u2014 you have v' + CURRENT_VERSION);
      }
      var btn = document.getElementById('_updates-row');
      var lbl = document.getElementById('_updates-label');
      if (btn && lbl) _applyUpdateBtnState(btn, lbl);
      _refreshUpdateNotification();
    })
    .catch(function() { if (!silent) _showCopyToast('Could not reach GitHub'); });
}


// ─── Popup buttons (2.1.0) ────────────────────────────────────────────────
// Every popup's buttons (Save, Cancel, Delete, Apply, Let's go, ...) share the
// Settings buttons' look (_cardBtn in _showSettingsModal): a 30px outlined box,
// 6px corners, 13px text, with rest / hover / pressed looks. The outline is an
// outer box filled with its colour round a 1px inset inner box (UXP draws a
// CSS border soft, see _crispBox). kind: 'primary' is Settings' blue GitHub
// look, 'danger' a red twin of it, anything else the grey look.
var _MODAL_LIFT = 0; // UXP sets text about 1px low in its line box (Settings' _uxpLift)
var _MODAL_LOOKS = {
  plain:   { looks: [['#3c3c3c', '#222222'], ['#5a5a5a', '#2a2a2a'], ['#757575', '#343434']], text: ['#e4e4e4', '#ffffff'] },
  primary: { looks: [['#2b507c', '#161c24'], ['#6796b8', '#1a2635'], ['#8bb3d6', '#22324a']], text: ['#4a9eff', '#8ccfff'] },
  danger:  { looks: [['#7c2b2b', '#241616'], ['#b86767', '#351a1a'], ['#d68b8b', '#4a2222']], text: ['#ff6b6b', '#ffa3a3'] }
};
function _modalBtn(label, onClick, kind) {
  var k = _MODAL_LOOKS[kind] || _MODAL_LOOKS.plain;
  var b = document.createElement('div');
  b.style.cssText = 'box-sizing:border-box;height:30px;padding:1px;flex-shrink:0;border-radius:6px;cursor:pointer;';
  var inner = document.createElement('div');
  inner.style.cssText = 'display:flex;align-items:center;justify-content:center;box-sizing:border-box;height:28px;border-radius:5px;'
    + 'padding:' + (4 - _MODAL_LIFT) + 'px 12px ' + (4 + _MODAL_LIFT) + 'px;font-size:13px;line-height:18px;white-space:nowrap;';
  inner.textContent = label;
  b.appendChild(inner);
  b._ocIn = inner;
  var hot = false, down = false;
  function paint() {
    var st = down ? 2 : hot ? 1 : 0;
    b.style.backgroundColor = k.looks[st][0];
    inner.style.backgroundColor = k.looks[st][1];
    inner.style.color = k.text[st ? 1 : 0];
  }
  b.addEventListener('mouseenter', function() { hot = true; paint(); });
  b.addEventListener('mouseleave', function() { hot = false; down = false; paint(); });
  b.addEventListener('pointerdown', function() { down = true; paint(); });
  b.addEventListener('pointerup', function() { if (down) { down = false; paint(); } });
  b.addEventListener('pointercancel', function() { if (down) { down = false; paint(); } });
  if (onClick) b.addEventListener('click', onClick);
  paint();
  return b;
}

// Modal confirmation: title, message, a red action button and Cancel.
// onOk runs after the dialog has closed. Used by reset-all and preset delete.
// ─── What's new card (first launch of a release that has one) ───────────
// A one-time card listing what the release brought, shown the first time a
// build with a new _WELCOME_FOR runs: a fresh install and an upgrade both get
// it. The key stores the release it was shown for (2.0 stored '2'), so a
// release with its own list bumps _WELCOME_FOR and _WELCOME_TITLE. Returns
// true when it was shown, so the bridge / panel create can skip the
// "Updated to vX" toast that same launch.
// Replaced the CEP edition's first-run warning about the .zxp's limitations.
var _WELCOME_KEY = 'opencurve-welcome-seen';
var _WELCOME_FOR = '2.1';
var _WELCOME_TITLE = 'What\u2019s New in 2.1.0';
var _WELCOME_ITEMS = [ // titles only, split over two columns (the left one first)
  'Bounce mode',
  'Faster on big timelines',
  'Save edits to presets',
  'Replace a baked curve',
  'Auto zoom',
  'Smarter Go button',
  'Right-click property actions',
  'Redesigned Settings'
];

// force: show it even when already seen (the Settings version badge)
function _showWelcome(force) {
  if (!force) { try { if (localStorage.getItem(_WELCOME_KEY) === _WELCOME_FOR) return false; } catch(_) {} }
  if (document.getElementById('oc-welcome')) return false;

  var overlay = document.createElement('div');
  overlay.id = 'oc-welcome';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.65);z-index:99998;display:flex;align-items:center;justify-content:center;';

  var box = document.createElement('div');
  box.style.cssText = 'background:#1c1c1c;border:1px solid rgba(255,255,255,0.18);padding:26px 24px 24px;width:460px;max-width:92%;font-family:system-ui,sans-serif;box-sizing:border-box;';

  var logo = document.createElement('img');
  var _dpr = window.devicePixelRatio || 1;
  logo.src = 'img/OpenCurve2_Wordmark_small' + (_dpr >= 2.5 ? '@3x' : _dpr >= 1.5 ? '@2x' : '') + '.png';
  logo.style.cssText = 'display:block;width:145px;height:22px;margin:0 auto 16px;opacity:0.9;';
  box.appendChild(logo);

  var title = document.createElement('div');
  title.textContent = _WELCOME_TITLE;
  title.style.cssText = 'color:#e4e4e4;font-size:14px;margin-bottom:18px;text-align:center;';
  box.appendChild(title);

  // Two columns built as paired rows (item i beside item i + half), so a
  // title that wraps pushes both sides down together and the columns stay
  // level; two independent columns drifted apart when one side wrapped.
  // Each item is its own rounded card like the Settings ones: an outline-
  // coloured box round a 1px inset fill (UXP draws CSS borders soft), a
  // little lighter than the card behind it.
  var list = document.createElement('div');
  list.style.cssText = 'margin-bottom:20px;';
  var half = Math.ceil(_WELCOME_ITEMS.length / 2);
  function item(text, right) {
    var cell = document.createElement('div');
    cell.style.cssText = 'flex:1;min-width:0;display:flex;box-sizing:border-box;padding:1px;border-radius:8px;'
      + (right ? 'margin-left:8px;' : '') + (text == null ? '' : 'background-color:#2c2c2c;');
    if (text == null) return cell; // empty cell keeps an odd count level
    var inner = document.createElement('div');
    inner.style.cssText = 'flex:1;min-width:0;box-sizing:border-box;border-radius:7px;background-color:#232323;'
      + 'display:flex;flex-direction:row;align-items:center;min-height:46px;padding:9px 12px 9px 13px;';
    var dot = document.createElement('div');
    dot.style.cssText = 'width:6px;height:6px;border-radius:3px;background:' + _curveColor + ';margin-right:10px;flex:0 0 6px;';
    var txt = document.createElement('div');
    txt.textContent = text;
    txt.style.cssText = 'color:#e4e4e4;font-size:12.5px;font-weight:600;line-height:1.35;min-width:0;';
    inner.appendChild(dot);
    inner.appendChild(txt);
    cell.appendChild(inner);
    return cell;
  }
  for (var i = 0; i < half; i++) {
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:stretch;' + (i < half - 1 ? 'margin-bottom:8px;' : '');
    row.appendChild(item(_WELCOME_ITEMS[i], false));
    row.appendChild(item(i + half < _WELCOME_ITEMS.length ? _WELCOME_ITEMS[i + half] : null, true));
    list.appendChild(row);
  }
  box.appendChild(list);

  var btns = document.createElement('div');
  btns.style.cssText = 'display:flex;justify-content:center;';
  var okBtn = _modalBtn('Let’s go', null, 'primary');
  okBtn._ocIn.style.paddingLeft = okBtn._ocIn.style.paddingRight = '26px';
  // Vertical fit: the width caps itself through max-width, but a short panel
  // would clip the card, so it is scaled down as a whole (transform) to fit
  // the panel's height with a little air, and re-fitted when the panel is
  // resized while it is up. Measured at scale 1 each time, since the rect
  // of a scaled element is the scaled one. Writes only when the scale moves.
  var _fitScale = 1;
  function fit() {
    if (!overlay.parentNode) return;
    var vh = document.documentElement.clientHeight || document.body.clientHeight || 0;
    if (!vh) return;
    if (_fitScale !== 1) box.style.transform = 'none';
    var h = box.getBoundingClientRect().height || box.offsetHeight || 0;
    var s = h > vh - 16 ? Math.max(0.4, (vh - 16) / h) : 1;
    s = Math.round(s * 1000) / 1000;
    if (s !== 1 || _fitScale !== 1) box.style.transform = s === 1 ? 'none' : 'scale(' + s + ')';
    _fitScale = s;
  }
  box.style.transformOrigin = 'center center';
  var ro = null;
  function close() {
    try { localStorage.setItem(_WELCOME_KEY, _WELCOME_FOR); } catch(_) {}
    if (ro) { try { ro.disconnect(); } catch(_) {} ro = null; }
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
  }
  okBtn.addEventListener('click', close);
  overlay.addEventListener('click', function(e) { if (e.target === overlay) close(); });
  btns.appendChild(okBtn);
  box.appendChild(btns);

  overlay.appendChild(box);
  document.body.appendChild(overlay);
  fit();
  setTimeout(fit, 0); // UXP: the first rect can be measured before the wordmark and text have laid out
  if (typeof ResizeObserver === 'function') {
    try { ro = new ResizeObserver(function() { fit(); }); ro.observe(document.body); } catch(_) { ro = null; }
  }
  return true;
}

function _confirmDialog(titleText, msgText, okLabel, onOk) {
  var overlay = document.createElement('div');
  overlay.id = 'oc-confirm';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.65);z-index:99998;display:flex;align-items:center;justify-content:center;';

  var box = document.createElement('div');
  box.style.cssText = 'background:#1c1c1c;border:1px solid rgba(255,255,255,0.18);padding:20px;width:260px;font-family:system-ui,sans-serif;';

  var title = document.createElement('div');
  title.textContent = titleText;
  title.style.cssText = 'color:#e4e4e4;font-size:14px;font-weight:600;margin-bottom:8px;';

  var msg = document.createElement('div');
  msg.textContent = msgText;
  msg.style.cssText = 'color:#888;font-size:13px;margin-bottom:16px;line-height:1.5;';

  var btns = document.createElement('div');
  btns.style.cssText = 'display:flex;justify-content:flex-end;'; // no flex gap: UXP ignores it, the OK button carries a margin

  var cancelBtn = _modalBtn('Cancel', null, 'plain');
  cancelBtn.addEventListener('click', function() { document.body.removeChild(overlay); });

  var okBtn = _modalBtn(okLabel, null, 'danger');
  okBtn.style.marginLeft = '8px';
  okBtn.addEventListener('click', function() {
    document.body.removeChild(overlay);
    onOk();
  });

  btns.appendChild(cancelBtn);
  btns.appendChild(okBtn);
  box.appendChild(title);
  box.appendChild(msg);
  box.appendChild(btns);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

// Modal rename: title, a text field with the current name selected, OK and
// Cancel. Enter is OK, Esc and a click on the overlay cancel. onOk(name) runs
// after the dialog has closed with the trimmed name (unchanged if left empty).
function _renamePresetDialog(current, onOk, opts) {
  var old = document.getElementById('oc-rename');
  if (old && old.parentNode) old.parentNode.removeChild(old);
  var overlay = document.createElement('div');
  overlay.id = 'oc-rename';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.65);z-index:99998;display:flex;align-items:center;justify-content:center;';

  var box = document.createElement('div');
  box.style.cssText = 'background:#1c1c1c;border:1px solid rgba(255,255,255,0.18);padding:20px;width:260px;font-family:system-ui,sans-serif;';

  var title = document.createElement('div');
  title.textContent = (opts && opts.title) || 'Rename Preset';
  title.style.cssText = 'color:#e4e4e4;font-size:14px;font-weight:600;margin-bottom:10px;';
  var hintEl = null;
  if (opts && opts.hint) { // a line under the title (Bounce mode's number entry gives the allowed range)
    title.style.marginBottom = '4px';
    hintEl = document.createElement('div');
    hintEl.textContent = opts.hint;
    hintEl.style.cssText = 'color:#8a8a8a;font-size:12px;margin-bottom:10px;';
  }

  var input = document.createElement('input');
  input.type = 'text';
  input.value = current;
  input.style.cssText = 'display:block;width:100%;box-sizing:border-box;background:#111;border:1px solid rgba(255,255,255,0.18);color:#e4e4e4;font-size:13px;padding:5px 8px;margin-bottom:16px;outline:none;font-family:system-ui,sans-serif;';

  var btns = document.createElement('div');
  btns.style.cssText = 'display:flex;justify-content:flex-end;'; // no flex gap: UXP ignores it, the OK button carries a margin

  function close() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }
  function ok() {
    var v = input.value.trim() || current;
    close();
    onOk(v);
  }

  var cancelBtn = _modalBtn('Cancel', null, 'plain');
  cancelBtn.addEventListener('click', close);

  var okBtn = _modalBtn((opts && opts.ok) || 'Rename', null, 'primary');
  okBtn.style.marginLeft = '8px';
  okBtn.addEventListener('click', ok);

  input.addEventListener('keydown', function(ev) {
    if (ev.key === 'Enter' || ev.keyCode === 13) { ev.preventDefault(); ev.stopPropagation(); ok(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); }
  });
  // A press that starts and ends on the overlay itself cancels; presses inside the box don't
  var downOnOverlay = false;
  overlay.addEventListener('pointerdown', function(ev) { downOnOverlay = ev.target === overlay; });
  overlay.addEventListener('click', function(ev) { if (ev.target === overlay && downOnOverlay) close(); });

  btns.appendChild(cancelBtn);
  btns.appendChild(okBtn);
  box.appendChild(title);
  if (hintEl) box.appendChild(hintEl);
  box.appendChild(input);
  box.appendChild(btns);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  // After the key sink's deferred focus grab from the click that opened the menu item
  setTimeout(function() { try { input.focus(); input.select(); } catch(_) {} }, 30);
}

function _confirmReset() {
  _confirmDialog('Reset All Settings', 'This will clear all saved presets, the graph line colour, and reset the curve. This cannot be undone.', 'Reset', function() {
    // Bake records are deliberately kept: they are a record of work done on the
    // project, not a setting, and the dialog does not offer to clear them.
    ['opencurve-presets-v10', 'opencurve-sidebar-width', _WELCOME_KEY,
     _CURVE_COLOR_KEY, _GRID_KEY, _LAYOUT_KEY, _ANIM_KEY, _AUTO_ZOOM_KEY, _UPDATE_NOTIF_KEY, _GRAPH_KEY,
     _PEAK_KEY, _BN_KEY, _DRAG_GHOST_KEY, _DENSITY_KEY, _TL_KEY, _TL_ZOOM_KEY, _TL_PROPS_KEY, _TL_H_KEY
    ].forEach(function(k) { try { localStorage.removeItem(k); } catch(_) {} });

    // Everything below used to be left to the reload. If that call is a no-op
    // the panel kept the deleted presets and the old layout while the flags said
    // otherwise, and the next preset edit wrote the stale list straight back to
    // storage, undoing the reset. The panel now resets itself; CEP still reloads
    // afterwards so the welcome card comes back (the UXP edition shows it
    // again on its next panel create).
    _bakeDensity    = 1;
    _gridSize       = 8;
    _presetLayout   = 'list';
    _animationsOn   = true;
    _autoZoomOn     = true;
    _autoZoomFrom   = null;
    _updateNotifsOn = true;
    _tlZoomKeys     = false;
    _tlUserH        = null;
    _peakMode       = false;
    _setBounceMode(false);
    _bnOpts         = _bnClean(_BN_DEF);
    _dragGhost      = true;
    _graphVisible   = true;
    _tlVisible      = true;

    _applyPeakVisibility();
    _stylePeakBtn();
    if (_peakThumbRefresh) _peakThumbRefresh();
    _hideDragGhost();
    _styleGhostBtn();
    _styleViewBtns();
    _applyGraphVisibility();   // also puts the preset column back to its default width
    _applyTimelineVisibility();
    _tlApplyHeightStyle();
    _tlApplyHeight();
    _tlApplyPropsWidth();
    _applyPresetLayout(true);
    _styleLayoutBtn();
    _applyCurveColor('#ffffff');
    setState({ curve: { p1x: 0.65, p1y: 0, p2x: 0.35, p2y: 1 } });
    if (_svgW > 0 && _svgH > 0) {
      updateStaticSVG(_svgW, _svgH); // the grid size changed back to 8
      updateDynamicSVG(getState().curve, _svgW, _svgH);
    }
    if (_resetPresetsRef) _resetPresetsRef();
    _showCopyToast('Reset all settings');
    try { location.reload(); } catch(e) {}
  });
}

// ─── Text fields ─────────────────────────────────────────────────────────
// UXP paints its own frame and minimum height inside a styled <input>, so a
// bordered, padded input shows as a box inside a box with tall padding. The
// border and background therefore live on a wrapper div and the input itself
// is bare (the preset rename field has always been styled that way). Same
// look in CEP. Returns { wrap, input }; style the wrap for width/margins.
function _mkTextField(fontSize, mono, variant) {
  var wrap = document.createElement('div');
  wrap.className = 'oc-field' + (variant ? ' ' + variant : ''); // 'paste' / 'hex': the CEP stylesheet tints them
  var inp = document.createElement('input');
  inp.type = 'text';
  inp.className = 'oc-field-input' + (mono ? ' mono' : '') + (fontSize && fontSize < 13 ? ' small' : '');
  wrap.appendChild(inp);
  return { wrap: wrap, input: inp };
}

// ─── Numeric entry ───────────────────────────────────────────────────────
// Toolbar #numeric-entry: type the handle coordinates instead of dragging
// them. The four fields (the (0,0) handle and the (1,1) handle) update the
// graph as they are typed; the text field below carries the curve's copy/paste
// form (cubic-bezier() or opencurve()), the only way to type a curve that has
// added points. Enter applies, Esc or Cancel puts the starting curve back.
function _numStr(v) { return String(Math.round(v * 1000) / 1000); }
function _showNumericPanel() {
  var oldBox = document.getElementById('oc-numeric');
  if (oldBox && oldBox.parentNode) oldBox.parentNode.removeChild(oldBox);
  var oldOv = document.getElementById('oc-numeric-overlay');
  if (oldOv && oldOv.parentNode) oldOv.parentNode.removeChild(oldOv);

  var overlay = document.createElement('div');
  overlay.id = 'oc-numeric-overlay';
  // The overlay is a full-panel flex box that centres the modal itself: UXP
  // can't be trusted to report the box's height for a measured placement
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.55);z-index:9997;display:flex;align-items:center;justify-content:center;';
  document.body.appendChild(overlay);

  var box = document.createElement('div');
  box.id = 'oc-numeric';
  box.style.cssText = 'width:380px;max-width:96%;flex-shrink:0;background:#1c1c1c;border:1px solid rgba(255,255,255,0.18);padding:20px;font-family:system-ui,sans-serif;box-sizing:border-box;';
  overlay.appendChild(box);

  var start = _cloneCurve(getState().curve);
  var startPreset = _srcPresetId; // the preset it came from, edited or not

  function close() {
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
  }
  function cancel() {
    setState({ curve: start });
    if (startPreset) setPresetActive(startPreset); else clearPresetActive();
    if (_svgW > 0 && _svgH > 0) updateDynamicSVG(getState().curve, _svgW, _svgH);
    close();
  }
  // Cancel on a click on the dark area, but only a press that also started
  // there: releasing a text-selection drag over it must not close the panel
  var ovDown = false;
  overlay.addEventListener('pointerdown', function(ev) { ovDown = ev.target === overlay; });
  overlay.addEventListener('click', function(ev) { if (ev.target === overlay && ovDown) cancel(); ovDown = false; });

  var title = document.createElement('div');
  title.textContent = 'Numeric Entry';
  title.style.cssText = 'color:#e4e4e4;font-size:14px;font-weight:600;margin-bottom:10px;';
  box.appendChild(title);

  var grid = document.createElement('div');
  grid.style.cssText = 'display:flex;flex-wrap:wrap;margin:0 -5px;';
  box.appendChild(grid);
  var fields = {};
  function field(name, label, val) {
    var wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;width:50%;box-sizing:border-box;padding:0 5px 10px;';
    var lb = document.createElement('div');
    lb.textContent = label;
    lb.style.cssText = 'color:#888;font-size:12px;margin-bottom:4px;';
    var tf = _mkTextField(14), inp = tf.input;
    inp.value = _numStr(val);
    wrap.appendChild(lb); wrap.appendChild(tf.wrap);
    grid.appendChild(wrap);
    fields[name] = inp;
    inp.addEventListener('input', applyFields);
    inp.addEventListener('keydown', onKey);
    return inp;
  }
  field('p1x', 'Handle 1 X', start.p1x);
  field('p1y', 'Handle 1 Y', start.p1y);
  field('p2x', 'Handle 2 X', start.p2x);
  field('p2y', 'Handle 2 Y', start.p2y);

  var textLabel = document.createElement('div');
  textLabel.textContent = 'As text';
  textLabel.style.cssText = 'color:#888;font-size:12px;margin:2px 0 4px;';
  box.appendChild(textLabel);
  var textTf = _mkTextField(13), textInp = textTf.input;
  box.appendChild(textTf.wrap);
  textInp.addEventListener('keydown', onKey);
  _attachTooltip(textInp, 'The curve as cubic-bezier() or opencurve() text. Edit it and press Enter or Apply; this is also where a curve with added points is typed');

  var err = document.createElement('div');
  err.style.cssText = 'color:#ff9090;font-size:12px;line-height:14px;min-height:12px;margin:4px 0 0;'; // empty: the popups' 16px above the buttons
  box.appendChild(err);

  function syncFrom(c) {
    fields.p1x.value = _numStr(c.p1x); fields.p1y.value = _numStr(c.p1y);
    fields.p2x.value = _numStr(c.p2x); fields.p2y.value = _numStr(c.p2y);
    textInp.value = _curveToText(c);
  }
  syncFrom(start);

  function readFields() {
    var v = {}, names = ['p1x', 'p1y', 'p2x', 'p2y'];
    for (var i = 0; i < names.length; i++) {
      var n = parseFloat(fields[names[i]].value);
      if (!isFinite(n)) return { error: 'Enter a number in every field' };
      var isX = names[i].charAt(2) === 'x';
      if (isX && (n < 0 || n > 1)) return { error: 'X values must be between 0 and 1' };
      if (!isX && (n < Y_CLAMP_MIN || n > Y_CLAMP_MAX)) return { error: 'Y values must be between ' + Y_CLAMP_MIN + ' and ' + Y_CLAMP_MAX };
      v[names[i]] = n;
    }
    return v;
  }
  // The four fields go straight to the graph as they are typed
  function applyFields() {
    var v = readFields();
    if (v.error) { err.textContent = v.error; return false; }
    err.textContent = '';
    var c = _cloneCurve(getState().curve);
    c.p1x = v.p1x; c.p1y = v.p1y; c.p2x = v.p2x; c.p2y = v.p2y;
    _commitCurve(c);
    textInp.value = _curveToText(getState().curve);
    return true;
  }
  // The text field is applied on Enter / Apply (typing half a value would otherwise flatten the curve)
  function applyText() {
    var t = textInp.value.trim();
    if (!t || t === _curveToText(getState().curve)) return true;
    var c = _curveFromText(t);
    if (!c) { err.textContent = 'Expected cubic-bezier(x1, y1, x2, y2) or an opencurve(...) value'; return false; }
    err.textContent = '';
    _commitCurve(c);
    syncFrom(getState().curve);
    return true;
  }
  function apply() {
    var ok = (document.activeElement === textInp) ? applyText() : (applyFields() && applyText());
    if (ok) close();
  }
  function onKey(ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); apply(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); cancel(); }
  }

  var btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;justify-content:flex-end;'; // every popup: Cancel, then the main button, at the right
  btnRow.appendChild(_modalBtn('Cancel', cancel));
  var applyBtn = _modalBtn('Apply', apply, 'primary');
  applyBtn.style.marginLeft = '8px';
  btnRow.appendChild(applyBtn);
  box.appendChild(btnRow);

  setTimeout(function() { fields.p1x.focus(); fields.p1x.select(); }, 0);
}

// Preset files (Export / Import Presets in the preset bar's menu).
// CEP: the bridge shows the host's own dialogs through cep.fs.
function _saveTextFile(name, text) {
  if (!_bridge || !_bridge.saveTextFile) return Promise.reject(new Error('File dialogs are not available'));
  return _bridge.saveTextFile(name, text);
}
function _openTextFile() {
  if (!_bridge || !_bridge.openTextFile) return Promise.reject(new Error('File dialogs are not available'));
  return _bridge.openTextFile();
}

// Settings footer: the version and the edition (ZXP, CCX or Exchange) as small
// outlined badges. Inline styles only (UXP), margin instead of flex gap.
function _footerBadge(label) {
  var b = document.createElement('span');
  b.textContent = label;
  b.style.cssText = 'display:inline-block;margin-left:8px;padding:3px 7px;border:1px solid #454545;border-radius:4px;'
    + 'background-color:rgba(255,255,255,0.04);color:#b0b0b0;font-size:12px;font-weight:600;letter-spacing:0.5px;line-height:16px;';
  return b;
}

function _showSettingsModal() {
  // The flyout's Settings item is Premiere's own menu and stays reachable while
  // the modal is open, so without this a second modal stacked on the first: only
  // the top one could be closed and the buried one kept its body ResizeObserver
  // running for the session.
  if (document.getElementById('settings-modal')) return;
  var modal = document.createElement('div');
  modal.id = 'settings-modal';
  var vw = document.documentElement.clientWidth  || document.body.clientWidth;
  var vh = document.documentElement.clientHeight || document.body.clientHeight;
  modal.style.cssText = 'position:fixed;top:0;left:0;width:'+vw+'px;height:'+vh+'px;background:#111111;z-index:9998;display:flex;flex-direction:column;font-family:system-ui,sans-serif;';

  // Layout (2.1.0): a column of rounded cards, each a title, a grey line saying
  // what it does and its control at the right (a switch, the spacing picker, a
  // button), two columns once the panel is wide enough. Outlines are an outer
  // box filled with the outline colour round an opaque inner box: UXP draws a
  // 1px CSS border soft (see _crispBox).
  var _uxpLift = 0;
  var _CARD_LINE = '#262626', _CARD_FILL = '#191919', _CARD_HOT = '#1f1f1f', _CARD_DOWN = '#282828';
  // On blue: the panel accent's hue darkened until the white knob has 4.64:1
  // contrast on it (WCAG AA; #4a9eff gave only 2.75:1)
  var _SW_ON = '#1e74d6', _SW_OFF = '#3a3a3a';
  function _el(css, text) {
    var e = document.createElement('div');
    e.style.cssText = css;
    if (text) e.textContent = text;
    return e;
  }
  // Outlined box: `outline` round a 1px inset `fill`, content in box._ocIn
  function _outlined(css, innerCss, outline, fill, r) {
    var box = _el('box-sizing:border-box;padding:1px;flex-shrink:0;border-radius:' + r + 'px;background-color:' + outline + ';' + css);
    var inner = _el('box-sizing:border-box;border-radius:' + (r - 1) + 'px;background-color:' + fill + ';' + innerCss);
    box.appendChild(inner);
    box._ocIn = inner;
    return box;
  }
  // One setting: title, description, control at the right, optional extra row
  // under them (the swatches). onClick makes the whole card the control.
  function _card(title, desc, control, onClick, below) {
    var card = _outlined('margin-bottom:6px;', 'display:flex;flex-direction:column;padding:10px 12px 11px 14px;min-height:58px;justify-content:center;'
      + (onClick ? 'cursor:pointer;' : ''), _CARD_LINE, _CARD_FILL, 8);
    var row = _el('display:flex;flex-direction:row;align-items:center;');
    var text = _el('display:flex;flex-direction:column;flex:1 1 auto;min-width:0;margin-right:12px;');
    text.appendChild(_el('color:#ececec;font-size:13px;font-weight:600;line-height:18px;', title));
    // desc null: no hint line at all (the title sits alone, centred)
    var d = desc === null ? null : _el('color:#8c8c8c;font-size:12px;line-height:16px;margin-top:2px;', desc);
    if (d) text.appendChild(d);
    row.appendChild(text);
    if (control) row.appendChild(control);
    card._ocIn.appendChild(row);
    if (below) card._ocIn.appendChild(below);
    card._ocDesc = d;
    // Colours by state (outline, rest, hover, pressed); _ocSetPal swaps them,
    // e.g. the Updates card's amber while an update is out
    card._ocPal = { line: _CARD_LINE, fill: _CARD_FILL, hot: _CARD_HOT, down: _CARD_DOWN };
    card._ocPaint = function() { card.style.backgroundColor = card._ocPal.line; card._ocIn.style.backgroundColor = card._ocPal.fill; };
    card._ocSetPal = function(p) { card._ocPal = p; card._ocPaint(); };
    if (control) control._ocCard = card;
    if (onClick) {
      // Hover lights the card, a press lights it more until the release. A
      // button control (the Updates card's) follows the card: the whole card
      // is the button, so it hovers, presses and clicks with it.
      var hot = false, down = false;
      if (control && control._ocHot) control._ocInCard = true;
      var paint = function() {
        var p = card._ocPal;
        card._ocIn.style.backgroundColor = down ? p.down : hot ? p.hot : p.fill;
        if (control && control._ocInCard) control._ocHot(down ? 2 : hot ? 1 : 0);
      };
      card.addEventListener('mouseenter', function() { hot = true; paint(); });
      card.addEventListener('mouseleave', function() { hot = false; down = false; paint(); });
      card.addEventListener('pointerdown', function() { down = true; paint(); });
      card.addEventListener('pointerup', function() { if (down) { down = false; paint(); } });
      card.addEventListener('pointercancel', function() { if (down) { down = false; paint(); } });
      card.addEventListener('click', onClick);
      card._ocPaint = paint;
      card.style.backgroundColor = card._ocPal.line;
      card._ocSetPal = function(p) { card._ocPal = p; card.style.backgroundColor = p.line; paint(); };
    }
    return card;
  }
  // On/off switch: a pill with a round knob, blue and right while on. Drawn as
  // SVG: UXP rounds a div's corners coarsely, so a fully rounded pill and knob
  // came out lumpy in the CCX (2026-11-22). The pill is a path (two arcs) rather
  // than a rect with rx; only attributes change on a toggle.
  function _switch(on) {
    // 1px of room on every side (the negative margin keeps the layout): UXP
    // clipped the anti-aliased edge along the SVG's bottom and right border
    var wrap = _el('display:flex;flex-shrink:0;width:38px;height:22px;margin:-1px;');
    wrap.innerHTML = '<svg width="38" height="22" viewBox="-1 -1 38 22" fill="none">'
      + '<path d="M10 0H26A10 10 0 0 1 26 20H10A10 10 0 0 1 10 0Z" fill="' + _SW_OFF + '"/>'
      + '<circle cx="10" cy="10" r="7" fill="#9a9a9a"/></svg>';
    var pill = wrap.querySelector('path'), knob = wrap.querySelector('circle');
    wrap._ocSet = function(v) {
      pill.setAttribute('fill', v ? _SW_ON : _SW_OFF);
      knob.setAttribute('fill', v ? '#ffffff' : '#9a9a9a');
      knob.setAttribute('cx', v ? '26' : '10');
    };
    wrap._ocSet(on);
    return wrap;
  }
  // A switch card: get() reads the setting, set(v) applies and saves it
  function _toggleCard(title, desc, get, set) {
    var sw = _switch(get());
    return _card(title, desc, sw, function() { set(!get()); sw._ocSet(get()); });
  }
  // A small outlined button (the Updates card's)
  function _cardBtn(label, onClick) {
    var b = _outlined('height:30px;cursor:pointer;', 'display:flex;align-items:center;justify-content:center;height:28px;padding:' + (4 - _uxpLift) + 'px 12px ' + (4 + _uxpLift) + 'px;'
      + 'color:#e4e4e4;font-size:13px;line-height:18px;white-space:nowrap;', '#3c3c3c', '#222222', 6);
    var t = document.createElement('span');
    t.textContent = label;
    b._ocIn.appendChild(t);
    b._ocText = t;
    // Look by state: 0 rest, 1 hover, 2 pressed (outline, fill)
    var looks = [['#3c3c3c', '#222222'], ['#5a5a5a', '#2a2a2a'], ['#757575', '#343434']];
    b._ocLooks = looks;
    b._ocState = 0;
    b._ocHot = function(st) { b._ocState = st; b.style.backgroundColor = b._ocLooks[st][0]; b._ocIn.style.backgroundColor = b._ocLooks[st][1]; };
    // Inside a clickable card (_ocInCard) the card drives the look and the click
    var hot = false, down = false;
    var paint = function() { if (!b._ocInCard) b._ocHot(down ? 2 : hot ? 1 : 0); };
    b.addEventListener('mouseenter', function() { hot = true; paint(); });
    b.addEventListener('mouseleave', function() { hot = false; down = false; paint(); });
    b.addEventListener('pointerdown', function() { down = true; paint(); });
    b.addEventListener('pointerup', function() { if (down) { down = false; paint(); } });
    b.addEventListener('pointercancel', function() { if (down) { down = false; paint(); } });
    b.addEventListener('click', function(ev) { if (b._ocInCard) return; ev.stopPropagation(); onClick(); });
    return b;
  }

  // Header: the wordmark and a plain close cross. The whole banner still closes
  // the modal; hovering it lights the cross.
  var header = document.createElement('div');
  // Even padding above and below: the bottom edge is where scrolled cards are cut off
  header.style.cssText = 'display:flex;align-items:center;padding:10px 10px 10px 14px;flex-shrink:0;cursor:pointer;';
  var logoWrap = document.createElement('div');
  logoWrap.style.cssText = 'flex:1;display:flex;align-items:center;justify-content:flex-start;';
  var logo = document.createElement('img');
  // Pre-rendered at the exact display size for 1x/2x/3x screens and shown in a
  // fixed 170x26 box: letting the host shrink a larger PNG made the logo blurry
  var _dpr = window.devicePixelRatio || 1;
  logo.src = 'img/OpenCurve2_Wordmark_small' + (_dpr >= 2.5 ? '@3x' : _dpr >= 1.5 ? '@2x' : '') + '.png';
  logo.style.cssText = 'width:145px;height:22px;opacity:0.9;'; // centred: the same space above and below it
  logoWrap.appendChild(logo);
  var closeBtn = document.createElement('div');
  closeBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 12 12" fill="none"><line x1="2.5" y1="2.5" x2="9.5" y2="9.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><line x1="9.5" y1="2.5" x2="2.5" y2="9.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  _attachTooltip(closeBtn, 'Close settings');
  closeBtn.style.cssText = 'display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:6px;flex-shrink:0;cursor:pointer;color:#bdbdbd;';
  function _closeHot(on) {
    closeBtn.style.backgroundColor = on ? 'rgba(255,255,255,0.08)' : '';
    closeBtn.style.color           = on ? '#ffffff' : '#bdbdbd';
  }
  header.addEventListener('mouseenter', function() { _closeHot(true); });
  header.addEventListener('mouseleave', function() { _closeHot(false); });
  header.addEventListener('click', function() { modal.remove(); });
  header.appendChild(logoWrap);
  header.appendChild(closeBtn);

  // Content: the scroller, holding the card columns
  var content = document.createElement('div');
  content.style.cssText = 'flex:1;overflow-y:auto;display:flex;flex-direction:column;align-items:center;';
  var cols = _el('display:flex;flex-direction:row;align-items:flex-start;flex-shrink:0;box-sizing:border-box;width:100%;max-width:1000px;padding:4px 16px 6px 12px;');
  var colA = _el('display:flex;flex-direction:column;flex:1 1 0;min-width:0;');
  var colB = _el('display:flex;flex-direction:column;flex:1 1 0;min-width:0;');
  cols.appendChild(colA);
  cols.appendChild(colB);
  content.appendChild(cols);

  // Scrollbar: a wider one of our own (UXP's native scrollbar can't be styled
  // and was thin and hard to hold). It sits over the right edge of the
  // scroller, opaque so it covers UXP's own bar (CEP hides its native one with
  // .oc-sb-hidden); the thumb is SVG so its round ends come out clean in UXP.
  // Dragging it is ordinary pointer capture, so it holds on in the CCX.
  var _SB_W = 14, _SB_THUMB = 10, _SB_MIN = 28;
  var contentWrap = _el('position:relative;flex:1;display:flex;flex-direction:column;min-height:0;');
  contentWrap.appendChild(content);
  var sb = _el('position:absolute;top:0;right:0;bottom:0;width:' + _SB_W + 'px;background-color:#111111;display:none;');
  sb.innerHTML = '<svg width="' + _SB_W + '" height="40" viewBox="0 0 ' + _SB_W + ' 40" fill="none" style="position:absolute;left:0;top:0;">'
    + '<path d="" fill="rgba(255,255,255,0.18)"/></svg>';
  contentWrap.appendChild(sb);
  var sbSvg = sb.querySelector('svg'), sbPath = sb.querySelector('path');
  var sbShown = false, sbTop = -1, sbH = -1, sbHot = false, sbDrag = null;
  function _sbFill() { sbPath.setAttribute('fill', sbDrag ? 'rgba(255,255,255,0.42)' : sbHot ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.18)'); }
  function _sbGeo() {
    var ch = content.clientHeight, sh = content.scrollHeight;
    var th = Math.max(_SB_MIN, Math.round(ch * ch / Math.max(1, sh)));
    return { ch: ch, sh: sh, th: th, travel: Math.max(1, ch - th), range: Math.max(1, sh - ch) };
  }
  // Change-only, like every other write here (UXP relayouts on each one)
  function _sbSync() {
    var g = _sbGeo(), show = g.sh > g.ch + 1;
    if (show !== sbShown) { sbShown = show; sb.style.display = show ? 'block' : 'none'; }
    if (!show) return;
    var top = Math.round(g.travel * content.scrollTop / g.range);
    if (top === sbTop && g.th === sbH) return;
    if (g.th !== sbH) {
      sbSvg.setAttribute('height', String(g.th));
      sbSvg.setAttribute('viewBox', '0 0 ' + _SB_W + ' ' + g.th);
      var x = (_SB_W - _SB_THUMB) / 2, r = _SB_THUMB / 2, y0 = 2, y1 = g.th - 2;
      // A rounded bar: two half circles joined by straight sides (1px clear of the SVG's edges)
      sbPath.setAttribute('d', 'M' + x + ' ' + (y0 + r) + 'A' + r + ' ' + r + ' 0 0 1 ' + (x + _SB_THUMB) + ' ' + (y0 + r)
        + 'V' + (y1 - r) + 'A' + r + ' ' + r + ' 0 0 1 ' + x + ' ' + (y1 - r) + 'Z');
    }
    if (top !== sbTop) sbSvg.style.top = top + 'px';
    sbTop = top; sbH = g.th;
  }
  function _sbWire(c) { // the scroller's scroll listener (UXP re-runs it on _refreshScroller's swap)
    if (c._ocSb) return;
    c._ocSb = true;
    c.classList.add('oc-sb-hidden');
    c.addEventListener('scroll', _sbSync);
  }
  _sbWire(content);
  sb.addEventListener('mouseenter', function() { sbHot = true; _sbFill(); });
  sb.addEventListener('mouseleave', function() { sbHot = false; _sbFill(); });
  sb.addEventListener('pointerdown', function(e) {
    var g = _sbGeo(), y = e.clientY - sb.getBoundingClientRect().top;
    if (y < sbTop || y > sbTop + g.th) {
      // On the track: page towards the press, as a native scrollbar does
      content.scrollTop += (y < sbTop ? -1 : 1) * Math.round(g.ch * 0.9);
      return;
    }
    sbDrag = { y: e.clientY, top: content.scrollTop, id: e.pointerId };
    try { sb.setPointerCapture(e.pointerId); } catch(_) {}
    _sbFill();
    e.preventDefault();
  });
  sb.addEventListener('pointermove', function(e) {
    if (!sbDrag) return;
    var g = _sbGeo();
    content.scrollTop = Math.max(0, Math.min(g.range, sbDrag.top + (e.clientY - sbDrag.y) * g.range / g.travel));
  });
  function _sbEnd(e) {
    if (!sbDrag) return;
    try { sb.releasePointerCapture(sbDrag.id); } catch(_) {}
    sbDrag = null;
    _sbFill();
  }
  sb.addEventListener('pointerup', _sbEnd);
  sb.addEventListener('pointercancel', _sbEnd);
  // CEP gets wheel events over the bar too (UXP sends none at all)
  sb.addEventListener('wheel', function(e) { content.scrollTop += e.deltaY; e.preventDefault(); });

  // Left column: what the panel shows and how the graph behaves
  var cardsA = [
    _toggleCard('Show Graph', null,
      function() { return _graphVisible; }, function(v) { _setGraphVisible(v); }),
    _toggleCard('Show Timeline', null,
      function() { return _tlVisible; }, function(v) { _setTimelineVisible(v); }),
    _toggleCard('Ghost', 'While you drag, the curve\'s starting shape stays faintly behind it',
      function() { return _dragGhost; }, function(v) { _setDragGhost(v); }),
    _toggleCard('Hover Preview', 'A dot runs along a preset\'s thumbnail to show the pace of the ease',
      function() { return _animationsOn; }, function(v) {
        _animationsOn = v;
        localStorage.setItem(_ANIM_KEY, v ? 'on' : 'off');
      }),
    _toggleCard('Auto Zoom', 'Zooms out when a curve goes past the box, and back when it fits',
      function() { return _autoZoomOn; }, function(v) {
        _autoZoomOn = v;
        localStorage.setItem(_AUTO_ZOOM_KEY, v ? 'on' : 'off');
        // Off: go back to the user's own zoom; on: fit the curve on the graph now
        if (!v && _autoZoomFrom !== null) { _zoomAnimTo(_autoZoomFrom, _autoZoomFromOY); _autoZoomFrom = null; }
        else if (v) _autoZoomFor(getState().curve);
      }),
  ];

  // Keyframe spacing: a segmented picker, the active step raised
  var densSteps = [1, 2, 4];
  var densBtnEls = [];
  var densPick = _outlined('height:30px;', 'display:flex;flex-direction:row;height:28px;padding:2px;', '#2e2e2e', '#121212', 6);
  function _densPaint() {
    densBtnEls.forEach(function(el, idx) {
      var a = densSteps[idx] === _bakeDensity;
      el.style.backgroundColor = a ? '#333333' : (el._ocHot ? '#222222' : 'transparent');
      el.style.color = a ? '#ffffff' : '#8c8c8c';
    });
  }
  densSteps.forEach(function(step, idx) {
    var db = _el('display:flex;align-items:center;justify-content:center;box-sizing:border-box;height:24px;min-width:44px;padding:'
      + (3 - _uxpLift) + 'px 8px ' + (3 + _uxpLift) + 'px;border-radius:4px;font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap;'
      + (idx ? 'margin-left:2px;' : ''), step + ' fr');
    db.addEventListener('mouseenter', function() { db._ocHot = true; _densPaint(); });
    db.addEventListener('mouseleave', function() { db._ocHot = false; _densPaint(); });
    db.addEventListener('click', function() {
      _bakeDensity = step;
      localStorage.setItem(_DENSITY_KEY, step);
      _densPaint();
    });
    densBtnEls.push(db);
    densPick._ocIn.appendChild(db);
  });
  _densPaint();
  var densCard = _card('Keyframe Spacing', 'A keyframe every 1, 2 or 4 frames. 1 fr follows the curve exactly', densPick);

  // Theme colour: swatches under the text, the hex field at the right
  var swatchColors = ['#ffffff','#4a9eff','#ff9090','#f0a030','#c97ff0','#ff6eb4','#38fbb2','#aaaaaa'];
  var swatchRow = _el('display:flex;flex-wrap:wrap;margin-top:10px;'); // spacing via swatch margins (UXP ignores flex gap)
  swatchColors.forEach(function(col) {
    var sw = document.createElement('div');
    sw.style.cssText = 'width:22px;height:22px;border-radius:6px;background:'+col+';cursor:pointer;border:2px solid '+(col===_curveColor?'#fff':'transparent')+';box-sizing:border-box;flex-shrink:0;margin-right:6px;';
    sw.addEventListener('mouseenter', function() {
      if (sw.style.borderColor !== '#ffffff') sw.style.borderColor = 'rgba(255,255,255,0.45)';
    });
    sw.addEventListener('mouseleave', function() {
      if (sw.style.borderColor !== '#ffffff') sw.style.borderColor = 'transparent';
    });
    sw.addEventListener('click', function() {
      _applyCurveColor(col);
      localStorage.setItem(_CURVE_COLOR_KEY, col);
      hexInput.value = col.toUpperCase();
      hexPreview.style.background = col;
      swatchRow.querySelectorAll('div').forEach(function(s){ s.style.borderColor='transparent'; });
      sw.style.borderColor = '#fff';
    });
    swatchRow.appendChild(sw);
  });
  var hexRow = _el('display:flex;align-items:center;flex-shrink:0;');
  var hexInput = document.createElement('input');
  hexInput.type = 'text';
  hexInput.value = _curveColor.toUpperCase();
  hexInput.maxLength = 7;
  var hexTf = _mkTextField(13, true, 'hex');
  hexTf.wrap.style.width = '90px'; hexTf.wrap.style.flexShrink = '0';
  hexTf.wrap.replaceChild(hexInput, hexTf.input); // keep the input the rest of this code refers to
  hexInput.className = hexTf.input.className;
  var hexPreview = document.createElement('div');
  hexPreview.style.cssText = 'width:22px;height:22px;border-radius:6px;background:'+_curveColor+';flex-shrink:0;margin-left:8px;';
  hexInput.addEventListener('input', function() {
    var val = hexInput.value;
    // Strip anything that isn't # or hex digits, start with #, cap at 7 chars
    val = val.toUpperCase().replace(/[^#0-9A-F]/g, '');
    if (val.charAt(0) !== '#') val = '#' + val;
    val = val.slice(0, 7);
    hexInput.value = val;
    // Apply immediately once we have a full valid code
    if (/^#[0-9A-F]{6}$/.test(val)) {
      hexPreview.style.background = val;
      _applyCurveColor(val);
      localStorage.setItem(_CURVE_COLOR_KEY, val);
      swatchRow.querySelectorAll('div').forEach(function(s){ s.style.borderColor='transparent'; });
    }
  });
  hexInput.addEventListener('blur', function() {
    if (!/^#[0-9A-F]{6}$/.test(hexInput.value)) hexInput.value = _curveColor.toUpperCase();
  });
  hexRow.appendChild(hexTf.wrap);
  hexRow.appendChild(hexPreview);
  var colorCard = _card('Theme Colour', null, hexRow, null, swatchRow);

  // Right column: baking, the look, updates
  var cardsB = [densCard, colorCard];
  var cardsTop = []; // Updates and Update Notifications: first in the list
  // Updates: the line under the title says where you stand, the button checks
  // GitHub (or opens the release once a newer one is out); _applyUpdateBtnState
  function updAct() {
    if (_updateAvailable) {
      modal.remove();
      _openReleasesPage();
    } else {
      _checkForUpdates();
    }
  }
  var updBtn = _cardBtn('Check now', updAct);
  updBtn.id = '_updates-row';
  var updCard = _card('Updates', '', updBtn, updAct); // the whole card is the button
  updCard._ocDesc.id = '_updates-label';
  // Amber while an update is out: the card and its Download button
  // (_applyUpdateBtnState calls this after every check)
  var _updGrey  = updCard._ocPal, _updGreyLooks = updBtn._ocLooks;
  var _updAmber = { line: '#4f3f15', fill: '#1f1a0d', hot: '#272010', down: '#302713' };
  var _updAmberLooks = [['#7d5f16', '#2d2410'], ['#a47c1c', '#382c13'], ['#c49322', '#433518']];
  updBtn._ocAccent = function(on) {
    updCard._ocSetPal(on ? _updAmber : _updGrey);
    updBtn._ocLooks = on ? _updAmberLooks : _updGreyLooks;
    updBtn._ocHot(updBtn._ocState || 0);
    updBtn._ocIn.style.color = on ? '#f5c04a' : '#e4e4e4';
  };
  _applyUpdateBtnState(updBtn, updCard._ocDesc);
  var notifCard = _toggleCard('Update Notifications', 'A tile in the preset list when a new version is out',
    function() { return _updateNotifsOn; }, function(v) {
      _updateNotifsOn = v;
      localStorage.setItem(_UPDATE_NOTIF_KEY, v ? 'on' : 'off');
      _refreshUpdateNotification();
    });
  cardsTop.push(updCard, notifCard);

  // Two columns from 700px, else one: cards move between the columns only when
  // the mode changes (UXP relayouts on every write)
  var twoCols = null;
  function _layoutCards(w) {
    var two = w >= 700;
    if (two === twoCols) return;
    twoCols = two;
    colB.style.display = two ? 'flex' : 'none';
    colA.style.marginRight = two ? '8px' : '0px';
    // One list in order (Updates first), split down the middle: the left
    // column takes the extra card when the count is odd
    var all = cardsTop.concat(cardsA, cardsB), half = Math.ceil(all.length / 2);
    all.forEach(function(c, i) { (two && i >= half ? colB : colA).appendChild(c); });
  }
  _layoutCards(vw);

  // Footer
  var footer = document.createElement('div');
  footer.style.cssText = 'flex-shrink:0;';
  footer.appendChild(_el('height:1px;background-color:#202020;')); // a filled rule: UXP draws 1px borders soft
  var footerRow = document.createElement('div');
  footerRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:10px 12px;';

  var editionTag = 'ZXP';
  // Header: the version and edition badges sit beside the wordmark
  var verBadge = _footerBadge('v' + CURRENT_VERSION), edBadge = _footerBadge(editionTag);
  verBadge.style.marginLeft = '12px';
  // The version badge reopens the What's new card. Hover and press looks are
  // written inline from listeners (UXP's :hover is unreliable); the header's
  // own click closes Settings, so this one stops there.
  (function(b) {
    var looks = { rest: ['#454545', b._ocInner ? '#1a1a1a' : 'rgba(255,255,255,0.04)', '#b0b0b0'], hover: ['#5c5c5c', '#262626', '#e6e6e6'], down: ['#707070', '#333333', '#ffffff'] };
    var over = false, down = false;
    function paint() { // UXP's badge is a filled box (_crispBox), CEP's a bordered span
      var l = looks[down ? 'down' : over ? 'hover' : 'rest'];
      if (b._ocInner) { _crispTint(b, l[0], l[1]); b._ocInner.style.color = l[2]; }
      else { b.style.borderColor = l[0]; b.style.backgroundColor = l[1]; b.style.color = l[2]; }
    }
    b.style.cursor = 'pointer';
    b.addEventListener('pointerenter', function() { over = true; paint(); });
    b.addEventListener('pointerleave', function() { over = false; down = false; paint(); });
    b.addEventListener('pointerdown', function(e) { e.stopPropagation(); down = true; paint(); });
    b.addEventListener('pointerup', function() { down = false; paint(); });
    b.addEventListener('mousedown', function(e) { e.stopPropagation(); }); // CEP on macOS sends no pointerdown
    b.addEventListener('click', function(e) { e.stopPropagation(); down = false; paint(); _showWelcome(true); });
    _attachTooltip(b, 'What\u2019s new in this version', 'right');
  })(verBadge);
  logoWrap.appendChild(verBadge);
  logoWrap.appendChild(edBadge);

  // Footer, left: made by faye, the GitHub button (Report/Reset's size and
  // text, in blue) and the Veil lockup
  var footerLeft = document.createElement('div');
  footerLeft.style.cssText = 'display:flex;align-items:center;flex:0 1 auto;min-width:0;overflow:hidden;margin-right:12px;color:#888;font-size:12px;';
  var madeByText = document.createElement('span');
  madeByText.textContent = 'made by faye!';
  madeByText.style.cssText = 'flex-shrink:0;white-space:nowrap;font-size:13px;line-height:16px;color:#bdbdbd;';
  footerLeft.appendChild(madeByText);
  var ghIc = '<svg width="15" height="15" viewBox="0 0 14 14" fill="none"><path d="M8.2 2.5h3.3v3.3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M11.5 2.5L6.6 7.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M10.2 8.6v2.1a.8.8 0 01-.8.8H3.3a.8.8 0 01-.8-.8V4.6a.8.8 0 01.8-.8h2.1" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>', ghTip = 'Open OpenCurve on GitHub in your browser';
  var ghLink = _cardBtn('GitHub', function() { _openReleasesPage(); });
  ghLink._ocLooks = [['#2b507c', '#161c24'], ['#6796b8', '#1a2635'], ['#8bb3d6', '#22324a']];
  ghLink._ocHot(0);
  ghLink._ocIn.style.color = '#4a9eff';
  ghLink.style.marginRight = '8px'; // right-aligned, just before Report an Issue
  var ghIcon = document.createElement('span');
  ghIcon.style.cssText = 'display:inline-flex;width:15px;height:15px;margin-right:6px;';
  ghIcon.innerHTML = ghIc;
  ghLink._ocIn.insertBefore(ghIcon, ghLink._ocText);
  ghLink.addEventListener('mouseenter', function() { ghLink._ocIn.style.color = '#8ccfff'; });
  ghLink.addEventListener('mouseleave', function() { ghLink._ocIn.style.color = '#4a9eff'; });
  _attachTooltip(ghLink, ghTip);

  // Veil: the mark and wordmark (one evenodd path, from the Veil site's
  // veil-lockup-white.svg), grey at rest, white on hover, a tint while
  // pressed; opens veil.page. The viewBox has room round the edge (UXP clips
  // an SVG's anti-aliased border).
  var veilBtn = _el('display:flex;align-items:center;justify-content:center;flex-shrink:0;box-sizing:border-box;height:30px;padding:0 2px 0 4px;margin-left:0;border-radius:6px;cursor:pointer;');
  veilBtn.innerHTML = '<svg width="109" height="26" viewBox="-6 -6 1213 288" fill="none">' // a little under the buttons' 30px
    + '<path fill-rule="evenodd" d="M322.26,0.67L1200.74,0.67L1200.74,275.87L322.26,275.87ZM393.17 64.79H437.62L506.75 185.31H510.87L580.01 64.79H623.63L539.26 211.76H477.54ZM646.26 211.76V64.79H847.91V91.24H687.41V125.05H806.76V151.5H687.41V185.31H847.91V211.76ZM924.04 64.79V211.76H882.89V64.79ZM1006.35 64.79V185.31H1129.8V211.76H965.19V64.79ZM0.63,0.67L275.83,0.67L275.83,275.87L0.63,275.87ZM232.75,138.27L138.23,212.35L43.7,138.27L138.23,64.19Z" fill="#cccccc"/></svg>';
  // "for more plugins visit" ahead of the logo, part of the same button
  var veilText = _el('font-size:13px;line-height:16px;color:#bdbdbd;white-space:nowrap;margin-right:8px;', 'for more plugins visit');
  veilBtn.insertBefore(veilText, veilBtn.firstChild);
  var veilPath = veilBtn.querySelector('path');
  var veilHot = false, veilDown = false;
  function _veilPaint() {
    veilPath.setAttribute('fill', veilDown ? '#b8b8b8' : veilHot ? '#ffffff' : '#cccccc'); // the logo brighter than its text
    veilText.style.color = veilDown ? '#d0d0d0' : veilHot ? '#ffffff' : '#bdbdbd';
    veilBtn.style.backgroundColor = veilDown ? 'rgba(255,255,255,0.12)' : veilHot ? 'rgba(255,255,255,0.06)' : '';
  }
  veilBtn.addEventListener('mouseenter', function() { veilHot = true; _veilPaint(); });
  veilBtn.addEventListener('mouseleave', function() { veilHot = false; veilDown = false; _veilPaint(); });
  veilBtn.addEventListener('pointerdown', function() { veilDown = true; _veilPaint(); });
  veilBtn.addEventListener('pointerup', function() { if (veilDown) { veilDown = false; _veilPaint(); } });
  veilBtn.addEventListener('pointercancel', function() { if (veilDown) { veilDown = false; _veilPaint(); } });
  veilBtn.addEventListener('click', function() { var u = 'https://veil.page'; if (_bridge && _bridge.openExternal) _bridge.openExternal(u); else window.open(u); });
  _attachTooltip(veilBtn, 'Visit veil.page');
  footerLeft.appendChild(veilBtn);

  // Footer buttons: the same outlined style as the Updates card's Check now
  var resetRow = _cardBtn('Reset All Settings', function() {
    modal.remove();
    _confirmReset();
  });
  _attachTooltip(resetRow, 'Restore defaults and remove all presets');

  // Report an Issue: opens the GitHub issues page in the browser
  var issueRow = _cardBtn('Report an Issue', function() {
    var url = 'https://github.com/fayewave/OpenCurve/issues';
    if (_bridge && _bridge.openExternal) _bridge.openExternal(url); else window.open(url);
  });
  issueRow.style.marginRight = '8px';
  _attachTooltip(issueRow, 'Open the OpenCurve issues page on GitHub');

  var footerRight = document.createElement('div');
  footerRight.style.cssText = 'display:flex;align-items:center;flex-shrink:0;';
  footerRight.appendChild(ghLink);
  footerRight.appendChild(issueRow);
  footerRight.appendChild(resetRow);
  footerRow.appendChild(footerLeft);
  footerRow.appendChild(footerRight);
  footer.appendChild(footerRow);

  // Footer layout: the buttons sit to the right of the credit row while
  // both fit side by side, otherwise they drop underneath. Measured once
  // from the row layout (the elements keep their natural widths).
  var footNeed = 0, footStacked = false;
  function _layoutFooter(w) {
    if (!footNeed && !footStacked) {
      var lw = footerLeft.getBoundingClientRect().width, rw = footerRight.getBoundingClientRect().width;
      if (lw && rw) footNeed = Math.ceil(lw + rw) + 24 + 12;
    }
    var stack = footNeed ? w < footNeed : false;
    if (stack === footStacked) return;
    footStacked = stack;
    footerRow.style.flexDirection = stack ? 'column' : 'row';
    footerRow.style.alignItems = stack ? 'flex-start' : 'center';
    footerRight.style.marginTop = stack ? '8px' : '';
  }

  modal.appendChild(header);
  modal.appendChild(contentWrap);
  modal.appendChild(footer);
  document.body.appendChild(modal);
  _sbSync();
  _layoutFooter(vw);

  var _settingsRO = new ResizeObserver(function() {
    var nvw = document.documentElement.clientWidth  || document.body.clientWidth;
    var nvh = document.documentElement.clientHeight || document.body.clientHeight;
    modal.style.width  = nvw + 'px';
    modal.style.height = nvh + 'px';
    _layoutFooter(nvw);
    _layoutCards(nvw);
    _sbSync();
  });
  _settingsRO.observe(document.body);

  var _origRemove = modal.remove.bind(modal);
  modal.remove = function() { _settingsRO.disconnect(); _origRemove(); };
}

// Apply the saved curve colour on load. This is the only place the default
// lives; the bridge used to re-apply it with a stale '#4a9eff' fallback and
// painted every fresh install blue.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function() { _applyCurveColor(_curveColor); });
} else {
  _applyCurveColor(_curveColor);
}

// ─── Public API ──────────────────────────────────────────────────────────
return {
  // Version (the bridge compares it with the last one it saw, for the update toast)
  CURRENT_VERSION: CURRENT_VERSION,

  // State
  getState:    getState,
  setState:    setState,
  stateListeners: stateListeners,

  // Bezier
  sampleBezier: sampleBezier,

  // Constants
  DONE_DISPLAY_MS:  DONE_DISPLAY_MS,
  ERROR_DISPLAY_MS: ERROR_DISPLAY_MS,

  // Init
  initPanel: initPanel,
  applyCurveColor: _applyCurveColor,
  applyPresetLayout: _applyPresetLayout,
  checkForUpdates: _checkForUpdates,
  showSettingsModal: _showSettingsModal,
  btnBusy: _btnBusy, // the bridge's Undo button (next to Go) shows the spinner too
  showCopyToast: _showCopyToast,
  showWelcome: _showWelcome,
  attachTooltip: _attachTooltip,

  // isDragging flag (read by bridge poll loop)
  get isDragging() { return _isDragging; },

  // Update notification state (read by bridge)
  get updateNotifsOn() { return _updateNotifsOn; },

  // Keyframe spacing for the bake (read by the bridge when Go is pressed)
  get bakeDensity() { return _bakeDensity; },

  // Bridge setter
  setBridge: function(b) { _bridge = b; },

  // Keep Go's label clear of the floating Undo button (bridge calls it when toggling Undo)
  fitGoForUndo: _fitGoForUndo,
  tlSpansAfterBake: _tlSpansAfterBake,
};

})();
