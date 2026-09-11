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
  curve: { p1x: 0.625, p1y: 0.000, p2x: 0.375, p2y: 1.000 },
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
function _animateToCurve(target, onUpdate) {
  // Multi-point curves don't tween (the point counts differ), they just switch
  if (!_animationsOn || _hasPts(target) || _hasPts(getState().curve)) { setState({ curve: target }); onUpdate(getState().curve); return; }
  if (_curveAnimRaf) { cancelAnimationFrame(_curveAnimRaf); _curveAnimRaf = null; }
  var from = _cloneCurve(getState().curve);
  var duration = 150;
  var start = null;
  function easeInOut(t) { return t < 0.5 ? 4*t*t*t : 1-Math.pow(-2*t+2,3)/2; }
  function step(ts) {
    if (!start) start = ts;
    var p = Math.min((ts - start) / duration, 1);
    var e = easeInOut(p);
    var cur = {
      p1x: from.p1x + (target.p1x - from.p1x) * e,
      p1y: from.p1y + (target.p1y - from.p1y) * e,
      p2x: from.p2x + (target.p2x - from.p2x) * e,
      p2y: from.p2y + (target.p2y - from.p2y) * e,
    };
    setState({ curve: cur });
    onUpdate(cur);
    if (p < 1) { _curveAnimRaf = requestAnimationFrame(step); }
    else { setState({ curve: Object.assign({}, target) }); onUpdate(target); _curveAnimRaf = null; }
  }
  _curveAnimRaf = requestAnimationFrame(step);
}

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
function sampleBezier(x, curve) {
  var cx = Math.max(0, Math.min(1, x));
  if (cx === 0) return 0;
  if (cx === 1) return 1;
  if (_hasPts(curve)) return _sampleMulti(cx, curve);
  var t = _tForX(cx, curve.p1x, curve.p2x);
  return _by(t, curve.p1y, curve.p2y);
}
// Lowest and highest y the curve reaches, at least 0..1. Thumbnails stretch to
// this so a Back or Bounce curve isn't clipped at the box edge.
function _curveYBounds(c) {
  var lo = 0, hi = 1, N = 32;
  for (var i = 1; i < N; i++) {
    var y = sampleBezier(i / N, c);
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

function _sampleMulti(x, c) {
  var s = _segAt(x, _segsOf(c));
  var t = _segTForX(x, s);
  return _cub(t, s.y0, s.c1y, s.c2y, s.y3);
}

// Sort anchors, keep them apart, and pull every handle's x back inside its segment
function _normalizeCurve(c) {
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
  _normalizeCurve(c);
  setState({ curve: c });
  clearPresetActive();
  if (_svgW > 0 && _svgH > 0) updateDynamicSVG(getState().curve, _svgW, _svgH);
}

// Add Point: split the widest segment at its middle (de Casteljau), so the shape
// is unchanged until the new point is dragged
function _addPoint() {
  var c = _cloneCurve(getState().curve);
  var segs = _segsOf(c), si = 0;
  for (var i = 1; i < segs.length; i++) if (segs[i].x3 - segs[i].x0 > segs[si].x3 - segs[si].x0) si = i;
  var s = segs[si];
  if (s.x3 - s.x0 < PT_MIN_GAP * 3) return;
  var t = _segTForX((s.x0 + s.x3) / 2, s);
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
  _commitCurve(c);
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
  if (!m) return null;
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
  var c = fn(_cloneCurve(getState().curve));
  clearPresetActive();
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
  var inner = _mkCircle(4, '#1e1e1e', _curveColor || '#38fbb2', 2);
  var sq = document.createElementNS(NS, 'rect');
  sq.setAttribute('x', -4); sq.setAttribute('y', -4); sq.setAttribute('width', 8); sq.setAttribute('height', 8);
  sq.setAttribute('rx', 1); sq.setAttribute('fill', '#1e1e1e');
  sq.setAttribute('stroke', _curveColor || '#38fbb2'); sq.setAttribute('stroke-width', 2);
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
    for (var j = 0; j < N; j++) {
      var x = _PEAK_EPS + j * step;
      var xa = Math.max(0, x - h), xb = Math.min(1, x + h);
      out.push({ x: x, v: (sampleBezier(xb, c) - sampleBezier(xa, c)) / (xb - xa) });
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
function _peakBellPath(curve, N, tx, ty) {
  var sm = _velSamples(curve, N), vmax = 0;
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
    function(y) { return normToSVG(0, y, W, H).cy; });
  var first = normToSVG(0, Math.max(0, Math.min(1, sm[0].v / vmax)), W, H);
  var last  = normToSVG(1, Math.max(0, Math.min(1, sm[sm.length - 1].v / vmax)), W, H);
  var cp = document.getElementById('sg-curve');
  if (cp) cp.setAttribute('d', d);
  // The bezier itself stays visible behind the bell, greyed, so both views read at once
  var ghost = document.getElementById('sg-ghost');
  if (ghost) ghost.setAttribute('d', _curvePathD(curve, W, H));
  var ep0 = document.getElementById('sg-ep0');
  if (ep0) { ep0.setAttribute('cx', first.cx); ep0.setAttribute('cy', first.cy); }
  var ep3 = document.getElementById('sg-ep3');
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
  _svgShow('sg-tan1', !_peakMode);
  _svgShow('sg-tan2', !_peakMode);
  _svgShow('sg-h1',   !_peakMode);
  _svgShow('sg-h2',   !_peakMode);
  _svgShow('sg-diag', !_peakMode);
  _svgShow('sg-peak',  _peakMode);
  _svgShow('sg-ghost', _peakMode);
  _svgShow('sg-pts',       !_peakMode);
  _svgShow('sg-pts-lines', !_peakMode);
}

function _stylePeakBtn() {
  var btn = document.getElementById('peak-mode');
  if (!btn) return;
  btn.style.background = _peakMode ? 'rgba(61,220,132,0.18)' : '';
  btn.style.color      = _peakMode ? '#3ddc84' : '';
  btn.style.opacity    = _peakMode ? '1' : '';
  // The collapsed toolbar's menu button carries the same tint, so the mode
  // stays visible while the A-curve button itself is hidden
  var mb = document.getElementById('graph-tools-menu');
  if (mb) {
    mb.style.background = _peakMode ? 'rgba(61,220,132,0.18)' : '';
    mb.style.color      = _peakMode ? '#3ddc84' : '';
  }
}

function _setPeakMode(on) {
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

// ─── Constants ────────────────────────────────────────────────────────────
var FALLBACK_FPS        = 30;
var DONE_DISPLAY_MS     = 1000;
var ERROR_DISPLAY_MS    = 3000;
var HIT_TOLERANCE       = 6;
var Y_CLAMP_MIN         = -1.0;
var Y_CLAMP_MAX         =  2.0;

// ─── SVG graph editor ─────────────────────────────────────────────────────
var PAD = 16, HANDLE_R = 5;
var _zoom = 1.0;

function normToSVG(nx, ny, W, H) {
  return {
    cx: PAD + nx * (W - 2*PAD),
    cy: PAD + (1 - ny) * (H - 2*PAD),
  };
}
function svgToNorm(cx, cy, W, H) {
  return {
    nx: (cx - PAD) / (W - 2*PAD),
    ny: 1 - (cy - PAD) / (H - 2*PAD),
  };
}

function _unscale(cx, cy) {
  return {
    cx: _svgW / 2 + (cx - _svgW / 2) / _zoom,
    cy: _svgH / 2 + (cy - _svgH / 2) / _zoom,
  };
}

function _updateContentTransform() {
  var g = document.getElementById('sg-content');
  if (!g || !_svgW || !_svgH) return;
  var cx = _svgW / 2, cy = _svgH / 2;
  g.setAttribute('transform',
    'translate(' + cx + ',' + cy + ') scale(' + _zoom + ') translate(' + (-cx) + ',' + (-cy) + ')');
}

function _setLine(id, x1, y1, x2, y2) {
  var el = document.getElementById(id);
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
  g.setAttribute('stroke', _curveColor || '#38fbb2');
  _svgShow('sg-drag-ghost', true);
}
function _hideDragGhost() { _svgShow('sg-drag-ghost', false); }

function _styleGhostBtn() {
  var btn = document.getElementById('drag-ghost');
  if (!btn) return;
  btn.style.background = _dragGhost ? 'rgba(61,220,132,0.18)' : '';
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
    var bg = pair[1] ? 'rgba(61,220,132,0.18)' : '', col = pair[1] ? '#3ddc84' : '', op = pair[1] ? '1' : '';
    if (btn.style.background !== bg) btn.style.background = bg; // write only on change: UXP relayouts on every style write
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
  if (_peakMode) { _updatePeakSVG(curve, W, H); return; }
  var p0 = normToSVG(0, 0, W, H);
  var p1 = normToSVG(curve.p1x, curve.p1y, W, H);
  var p2 = normToSVG(curve.p2x, curve.p2y, W, H);
  var p3 = normToSVG(1, 1, W, H);
  _setLine('sg-tan1', p0.cx, p0.cy, p1.cx, p1.cy);
  _setLine('sg-tan2', p3.cx, p3.cy, p2.cx, p2.cy);
  var cp = document.getElementById('sg-curve');
  if (cp) cp.setAttribute('d', _curvePathD(curve, W, H));
  var h1 = document.getElementById('sg-h1');
  if (h1) h1.setAttribute('transform', 'translate('+p1.cx+','+p1.cy+')');
  var h2 = document.getElementById('sg-h2');
  if (h2) h2.setAttribute('transform', 'translate('+p2.cx+','+p2.cy+')');
  _updatePtsSVG(curve, W, H);
}

function initGraphEditor(svg) {
  var dragging  = null;
  var liveCurve = null;
  var dragRect  = null;

  function hitTest(e) {
    if (_peakMode) return null;
    var rect = dragRect || svg.getBoundingClientRect();
    var raw  = _unscale(e.clientX - rect.left, e.clientY - rect.top);
    var c    = liveCurve || getState().curve;
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
    _showDragGhost(getState().curve, _svgW, _svgH); // before any snap moves the curve
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
      liveCurve   = _cloneCurve(getState().curve);
      dragRect    = svg.getBoundingClientRect();
      _isDragging = true;
      e.preventDefault();
      svg.style.cursor = 'grabbing';
      _applyPeakPointer(e);
      return;
    }
    var hit = hitTest(e);
    if (!hit) {
      // Snap the closest handle (never an anchor) to the click position
      var rect = svg.getBoundingClientRect();
      var raw  = _unscale(e.clientX - rect.left, e.clientY - rect.top);
      var c    = _cloneCurve(getState().curve);
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
      clearPresetActive();
      updateDynamicSVG(getState().curve, _svgW, _svgH);
    }
    svg.setPointerCapture(e.pointerId);
    dragging    = hit;
    _lastHandle = hit; // arrow keys nudge this one
    liveCurve   = _cloneCurve(getState().curve);
    dragRect    = svg.getBoundingClientRect();
    _isDragging = true;
    e.preventDefault();
    svg.style.cursor = 'grabbing';
  });

  var _coordsEl = document.getElementById('graph-coords');

  svg.addEventListener('pointerleave', function() {
    if (_coordsEl && !dragging) _coordsEl.textContent = '';
  });

  function _showCoords(nx, ny) {
    if (_coordsEl) _coordsEl.textContent = nx.toFixed(3) + ',  ' + ny.toFixed(3);
  }

  svg.addEventListener('pointermove', function(e) {
    if (dragging === 'peak') { _applyPeakPointer(e); return; }
    if (dragging) {
      // coords updated in hot path below
    } else {
      if (_peakMode) {
        svg.style.cursor = 'crosshair';
        var rectP = svg.getBoundingClientRect();
        var rp = _unscale(e.clientX - rectP.left, e.clientY - rectP.top);
        var np = svgToNorm(rp.cx, rp.cy, _svgW, _svgH);
        var hx = Math.max(0, Math.min(1, np.nx)), hy = Math.max(0, Math.min(1, np.ny));
        var hp = _peakOf(_solvePeak(hx, hy), 48);
        _showPeakCoords(hp.v <= 1.02 ? hx : hp.x, hp.v);
        return;
      }
      var hit = hitTest(e);
      svg.style.cursor = hit ? 'grab' : 'crosshair';
      if (hit) {
        var hp0 = _handlePos(getState().curve, hit);
        _showCoords(hp0.x, hp0.y);
      } else {
        var rect2 = svg.getBoundingClientRect();
        var rc = _unscale(e.clientX - rect2.left, e.clientY - rect2.top);
        var nc = svgToNorm(rc.cx, rc.cy, _svgW, _svgH);
        _showCoords(nc.nx, nc.ny);
      }
      return;
    }
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
    setState({ curve: liveCurve });
    clearPresetActive();
    dragging  = null;
    liveCurve = null;
    dragRect  = null;
    svg.style.cursor = 'crosshair';
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
  'ease-in':  { p1x:0.42, p1y:0,    p2x:1,    p2y:1   },
  'ease-out': { p1x:0,    p1y:0,    p2x:0.58, p2y:1   },
  's-curve':  { p1x:0.625, p1y:0.000, p2x:0.375, p2y:1.000 },
  'linear':   { p1x:0,    p1y:0,    p2x:1,    p2y:1   },
};

var BUILT_IN_PRESETS = [
  { id: 'linear',   name: 'Linear',  curve: PRESETS['linear'],   builtIn: true },
  { id: 's-curve',  name: 'S-Curve', curve: PRESETS['s-curve'],  builtIn: true },
];

// Starter set: seeded on a fresh install and added on demand from the preset
// list's context menu (Add Starter Presets). The Penner-style families as
// cubic-beziers, plus Back (overshoot: a handle y outside 0..1, which the bake
// follows as-is) and Bounce (a multi-point chain of parabolas, corners at the
// touches). Bounce In is Bounce Out flipped.
var _BOUNCE_OUT = {
  p1x: 0.1212, p1y: 0, p2x: 0.9697, p2y: 0.9792,
  pts: [
    { x: 0.3636, y: 1, ix: 0.2424, iy: 0.3333, ox: 0.4848, oy: 0.6667, smooth: false },
    { x: 0.7273, y: 1, ix: 0.6061, iy: 0.6667, ox: 0.7879, oy: 0.9167, smooth: false },
    { x: 0.9091, y: 1, ix: 0.8485, iy: 0.9167, ox: 0.9394, oy: 0.9792, smooth: false },
  ],
};
var STARTER_PRESETS = [
  { name: 'Ease In',      curve: { p1x: 0.42, p1y: 0,     p2x: 1,    p2y: 1    } },
  { name: 'Ease Out',     curve: { p1x: 0,    p1y: 0,     p2x: 0.58, p2y: 1    } },
  { name: 'Ease In-Out',  curve: { p1x: 0.42, p1y: 0,     p2x: 0.58, p2y: 1    } },
  { name: 'Cubic In',     curve: { p1x: 0.32, p1y: 0,     p2x: 0.67, p2y: 0    } },
  { name: 'Cubic Out',    curve: { p1x: 0.33, p1y: 1,     p2x: 0.68, p2y: 1    } },
  { name: 'Cubic In-Out', curve: { p1x: 0.65, p1y: 0,     p2x: 0.35, p2y: 1    } },
  { name: 'Quint In',     curve: { p1x: 0.64, p1y: 0,     p2x: 0.78, p2y: 0    } },
  { name: 'Quint Out',    curve: { p1x: 0.22, p1y: 1,     p2x: 0.36, p2y: 1    } },
  { name: 'Quint In-Out', curve: { p1x: 0.83, p1y: 0,     p2x: 0.17, p2y: 1    } },
  { name: 'Expo In',      curve: { p1x: 0.7,  p1y: 0,     p2x: 0.84, p2y: 0    } },
  { name: 'Expo Out',     curve: { p1x: 0.16, p1y: 1,     p2x: 0.3,  p2y: 1    } },
  { name: 'Expo In-Out',  curve: { p1x: 0.87, p1y: 0,     p2x: 0.13, p2y: 1    } },
  { name: 'Back In',      curve: { p1x: 0.36, p1y: 0,     p2x: 0.66, p2y: -0.56 } },
  { name: 'Back Out',     curve: { p1x: 0.34, p1y: 1.56,  p2x: 0.64, p2y: 1    } },
  { name: 'Back In-Out',  curve: { p1x: 0.68, p1y: -0.6,  p2x: 0.32, p2y: 1.6  } },
  { name: 'Bounce Out',   curve: _BOUNCE_OUT },
  { name: 'Bounce In',    curve: _flipCurve(_BOUNCE_OUT) },
];
// Fresh preset entries for the starter set (new ids each time; names are what dedupes them)
function _starterPresetEntries() {
  var seq = Date.now();
  return STARTER_PRESETS.map(function(p, i) {
    return { id: 's' + seq + '_' + i, name: p.name, curve: _cloneCurve(p.curve) };
  });
}

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

function clearPresetActive() {
  document.querySelectorAll('.preset-btn').forEach(function(b){
    b.classList.remove('active'); b.removeAttribute('data-active');
  });
}
function setPresetActive(id) {
  clearPresetActive();
  var btn = document.querySelector('.preset-btn[data-id="'+id+'"]');
  if (btn) { btn.classList.add('active'); btn.dataset.active='true'; }
}

// Pin button: ask the CEP bridge to move the playhead (ExtendScript does the work)
// Row undo button: the host keeps the bake records (ids arrive on each
// availableParams entry as `bakeIds`); the bridge asks it to remove them.
function _undoBakeForKey(key) {
  var live = (getState().availableParams || []).filter(function(x){ return x.key === key; })[0];
  if (!live || !live.bakeIds || !live.bakeIds.length) return;
  if (_bridge && _bridge.onUndoParam) _bridge.onUndoParam(live.bakeIds, live.displayName);
}

// Row curve button: the host attaches the curve its bake record used to the
// availableParams entry as `bakeCurve`; put it back on the graph.
function _loadBakedCurve(key) {
  var live = (getState().availableParams || []).filter(function(x){ return x.key === key; })[0];
  if (!live || !live.bakeCurve) { _showCopyToast('No curve was recorded for this bake', '#f0a030'); return; }
  clearPresetActive();
  _animateToCurve(_cloneCurve(live.bakeCurve), function(cur) { if (_svgW > 0 && _svgH > 0) updateDynamicSVG(cur, _svgW, _svgH); });
  _showCopyToast('Loaded the curve baked on ' + (live.displayName || 'this property'));
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
// the last-touched handle (Shift: a grid step) · F flip · I invert · A A-curve
// · G ghost · N numeric entry · U undo the last bake · Esc stops a preview or
// leaves full screen. Enter (Go) is handled by the caller.
var _lastHandle = { k: 'p1' }; // last handle pressed on the graph, for the arrow keys
var _ocPressInField = false; // the current press started in a text field (see the key sink listeners)
var _NATIVE_TRANSPORT = false; // CEP: Premiere does not receive Space/J/K/L while the panel has focus either (tested), so QE plays
function _panelShortcut(e) {
  var k = e.key || '', code = e.code || '';
  var lk = k.length === 1 ? k.toLowerCase() : k;
  var isTransport = k === ' ' || code === 'Space' || lk === 'j' || lk === 'k' || lk === 'l';
  if (isTransport) {
    if (_NATIVE_TRANSPORT) return false; // CEP: Premiere receives the key itself, doing it here doubled the toggle
    if (k === ' ' || code === 'Space') _transport('toggle');
    else _transport(lk === 'j' ? 'rev' : lk === 'k' ? 'stop' : 'fwd');
    return true;
  }
  if (lk === 'p') { if (_pv && _pv.back) _pvStop(); else _previewPair(); return true; }
  if (k.length === 1 && k >= '1' && k <= '9') { _pressPreset(parseInt(k, 10) - 1); return true; }
  if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown') {
    var st = e.shiftKey ? 1 / _gridSize : 0.01;
    _nudgeHandle(k === 'ArrowLeft' ? -st : k === 'ArrowRight' ? st : 0,
                 k === 'ArrowUp'   ?  st : k === 'ArrowDown'  ? -st : 0);
    return true;
  }
  if (e.repeat) return false;
  if (lk === 'f') { _applyCurveOp(_flipCurve);   return true; }
  if (lk === 'i') { _applyCurveOp(_invertCurve); return true; }
  if (lk === 'a') { _setPeakMode(!_peakMode);    return true; }
  if (lk === 'g') { _setDragGhost(!_dragGhost);  return true; }
  if (lk === 'n') { _showNumericPanel();         return true; }
  if (lk === 'u') {
    var ub = document.getElementById('undo-btn');
    if (ub && !ub.classList.contains('btn-dim')) ub.click(); else _showCopyToast('Nothing to undo');
    return true;
  }
  if (k === 'Escape') {
    if (_pv) { _pvStop(); return true; }
    if (_graphFull) { _setGraphFull(false); return true; }
  }
  return false;
}
function _pressPreset(i) {
  var list = document.getElementById('all-presets-list');
  if (!list) return;
  var tiles = Array.prototype.filter.call(list.querySelectorAll('.preset-btn'), function(b) {
    return b.id !== 'new-preset-btn' && b.id !== '_update-notif';
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
  _hostSetPlayhead(frame / st.fps, st.info).then(function() {
    st.busy = false;
    st.steps++;
    if (done) { console.log('[OC] preview: done after ' + st.steps + ' steps'); _pvStop(true); }
  }, function(e) {
    console.log('[OC] preview: set playhead failed at frame ' + frame + ':', e && e.message ? e.message : e);
    _showCopyToast('Preview failed: ' + (e && e.message ? e.message : 'could not move the playhead'), '#ff9090');
    st.busy = false;
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
var _tlUserH      = parseInt(localStorage.getItem(_TL_H_KEY), 10) || null; // dragged height of the lanes + rows area (px); null = fit the rows
var _TL_MAIN_MIN  = 100;  // the graph / preset area keeps at least this much height while dragging
var _TL_NS        = 'http://www.w3.org/2000/svg';
var _TL_PAD_X     = 6;
var _TL_ROW_H     = 32;   // lane height = .prop-btn height, so lane i sits beside row i
var _TL_MIN_H     = 32;   // the empty strip (no rows) keeps one row's height
var _TL_PROPS_KEY = 'opencurve-props-width';
var _TL_PROPS_MIN = 100, _TL_PROPS_MAX = 320, _TL_PROPS_DEF = 180; // property column width (px), dragged at #tl-prop-handle
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
// Saved preset-column width, clamped to the panel; 0 = use the CSS default
function _sidebarSavedW() {
  var w = parseInt(localStorage.getItem('opencurve-sidebar-width'), 10);
  return w >= 120 ? Math.min(w, _sidebarMaxW()) : 0;
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
var _TL_COLORS = {
  none:    { bg: 'rgba(255,255,255,0.05)', hover: 'rgba(255,255,255,0.10)', bar: 'rgba(74,158,255,0.15)', dot: '#8c8c8c', pairDot: '#7dc4ff' },
  ready:   { bg: 'rgba(255,255,255,0.05)', hover: 'rgba(255,255,255,0.10)', bar: 'rgba(74,158,255,0.15)', dot: '#8c8c8c', pairDot: '#7dc4ff' },
  active:  { bg: 'rgba(74,158,255,0.12)',  hover: 'rgba(74,158,255,0.19)',  bar: 'rgba(74,158,255,0.34)', dot: '#8c8c8c', pairDot: '#7dc4ff' },
  pending: { bg: 'rgba(240,160,48,0.10)',  hover: 'rgba(240,160,48,0.17)',  bar: 'rgba(240,160,48,0.28)', dot: '#f7b95a', pairDot: '#f7b95a' },
  baked:   { bg: 'rgba(61,220,132,0.10)',  hover: 'rgba(61,220,132,0.17)',  bar: 'rgba(61,220,132,0.30)', dot: '#8c8c8c', pairDot: '#4ce890' },
};

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
  // One lane per row; with a dragged height the SVG also fills the box, so the
  // playhead line runs the whole visible height when there are few rows
  var boxH   = (_tlUserH && _tlEls.scroll) ? _tlEls.scroll.clientHeight : 0;
  var H      = Math.max(_TL_MIN_H, params.length * laneH, boxH);
  var W      = _tlW;
  var sel    = s.selectedParamKeys || [], valid = s.validParamKeys || [], baked = s.bakedParamKeys || [];
  var sig = [W, H, n, _tlZoomKeys ? 'k' : 'c', range ? range.a.toFixed(4) + '-' + range.b.toFixed(4) : '', n === 0 ? s.status : ''].join('|');
  if (range) params.forEach(function(p) {
    sig += '|' + p.key + ':' + p.displayName + ':' + (p.tlKf || []).map(function(t){ return Math.round(t * 1000); }).join(',')
         + ':' + (p.tlOut ? 'o' : Math.round(p.tlKf0 * 1000) + '/' + Math.round(p.tlKf1 * 1000))
         + ':' + (p.tlSpans || []).map(function(sp){ return Math.round(sp[0] * 1000) + '~' + Math.round(sp[1] * 1000); }).join(',')
         + ':' + (sel.indexOf(p.key) >= 0 ? 's' : '') + (valid.indexOf(p.key) >= 0 ? 'v' : '') + (baked.indexOf(p.key) >= 0 ? 'b' : '');
  });
  if (force || sig !== _tlSig) {
    _tlSig = sig;
    _tlBuild(s, params, range, n, laneH, H, W);
  }
  _tlPlacePlayhead(s);
  _tlSetGoWidth(); // the scrollbar may have appeared or gone with this render
  _tlUpdateFade();
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
  var barH = Math.max(2, Math.min(14, laneH - 4));
  var sel  = s.selectedParamKeys || [], valid = s.validParamKeys || [], baked = s.bakedParamKeys || [];
  params.forEach(function(p, i) {
    var top = g.y0 + i * laneH, cy = top + laneH / 2;
    // Same state logic as the row: green beats selection, selected is blue when the
    // playhead is over the pair and amber until it is, unselected-but-ready gets a blue pair
    var isSel = sel.indexOf(p.key) >= 0, isValid = valid.indexOf(p.key) >= 0, isBaked = baked.indexOf(p.key) >= 0 && !isSel;
    var c = _TL_COLORS[isBaked ? 'baked' : isSel ? (isValid ? 'active' : 'pending') : isValid ? 'ready' : 'none'];
    var bg = _tlMk('rect', { x: 0, y: top, width: W, height: laneH, fill: c.bg });
    els.svg.appendChild(bg);
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
      var px0 = _tlX(pair.a, g), px1 = _tlX(pair.b, g);
      els.svg.appendChild(_tlMk('rect', { x: px0, y: cy - barH / 2, width: Math.max(1, px1 - px0), height: barH, rx: 1,
        fill: c.bar }));
    }
    // Diamonds: every keyframe except the ones inside a bar (its two ends are kept)
    var lane = { key: p.key, name: p.displayName, bg: bg, fill: c.bg, hover: c.hover, kf: [] };
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

function _tlPlacePlayhead(s) {
  if (!_tlPh || !_tlGeo || !s.tl || typeof s.tl.ph !== 'number') return;
  var g = _tlGeo, x = _tlX(s.tl.ph, g);
  var on = x >= 0 && x <= g.W;
  _tlPh.line.setAttribute('visibility', on ? 'visible' : 'hidden');
  _tlPh.tri.setAttribute('visibility',  on ? 'visible' : 'hidden');
  if (!on) return;
  x = Math.round(x) + 0.5;
  _tlPh.line.setAttribute('x1', x);
  _tlPh.line.setAttribute('x2', x);
  _tlPh.tri.setAttribute('points', (x - 3.5) + ',0 ' + (x + 3.5) + ',0 ' + x + ',4');
}

// Ghost playhead at sec (sequence seconds), hidden with null. Snaps to the same
// frame or keyframe the press would land on, so it shows exactly where the
// playhead will go.
function _tlPlaceGhost(sec) {
  _tlGhostSec = (typeof sec === 'number') ? sec : null;
  if (!_tlGhost || !_tlGeo) return;
  var g = _tlGeo, x = _tlGhostSec === null ? -1 : _tlX(_tlGhostSec, g);
  var on = x >= 0 && x <= g.W;
  _tlGhost.line.setAttribute('visibility', on ? 'visible' : 'hidden');
  _tlGhost.tri.setAttribute('visibility',  on ? 'visible' : 'hidden');
  if (!on) return;
  x = Math.round(x) + 0.5;
  _tlGhost.line.setAttribute('x1', x);
  _tlGhost.line.setAttribute('x2', x);
  _tlGhost.tri.setAttribute('points', (x - 3.5) + ',0 ' + (x + 3.5) + ',0 ' + x + ',4');
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
function _tlHighlightLane(key) {
  _tlLanes.forEach(function(l) { l.bg.setAttribute('fill', l.key === key ? l.hover : l.fill); });
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
    text = h.lane.name + (h.t.kf ? ' · keyframe' : '') + ' · ' + rel.toFixed(2) + 's · frame ' + Math.round(rel * fps)
         + (_tlValText ? ' · ' + _tlValText : '');
  }
  if (text === _tlHoverText) return;
  _tlHoverText = text;
  renderUI(getState());
}
// The property's value under the pointer (what Premiere interpolates there, so
// it reflects the baked keyframes). One host read in flight at a time; the
// latest position waits its turn. _tlValueAt is per edition.
function _tlRequestValue(info) {
  if (_tlValBusy) { _tlValNext = info; return; }
  var s = getState();
  var p = (s.availableParams || []).filter(function(a) { return a.key === info.lane.key; })[0];
  if (!p) return;
  var mediaSec = info.t.sec - (s.tl ? (s.tl.clipStart - s.tl.clipIn) : 0);
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
function _tlSpansAfterBake(s, keys) {
  return (s.availableParams || []).map(function(p) {
    if (keys.indexOf(p.key) < 0 || typeof p.tlKf0 !== 'number' || typeof p.tlKf1 !== 'number') return p;
    var q = Object.assign({}, p);
    q.tlSpans = (p.tlSpans || []).concat([[p.tlKf0, p.tlKf1]]);
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
  if (_tlVisible) { _tlSig = ''; _tlRender(getState(), true); }
}
// Height of the lanes + rows area: the saved drag height, else whatever the rows
// need. With a fixed height the inner flex row is kept at least the box tall so
// the column handle spans it, and the lanes + rows scroll together beyond it.
// `live` = mid-drag: only the box height changes, so just stretch the SVG and
// the playhead line. A full lane rebuild plus a localStorage write per pointer
// move made the drag crawl in UXP; those happen once on release.
function _tlApplyHeight(live) {
  var els = _tlEls;
  if (!els) return;
  els.root.style.height = _tlUserH ? _tlUserH + 'px' : '';
  if (els.inner) els.inner.style.minHeight = (_tlUserH && els.scroll) ? els.scroll.clientHeight + 'px' : '';
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
function _tlSavedPropsWidth() {
  var w = parseInt(localStorage.getItem(_TL_PROPS_KEY), 10);
  return Math.min(w >= _TL_PROPS_MIN ? w : _TL_PROPS_DEF, _tlMaxPropsW());
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
  var w = _tlPropsW;
  if (_tlVisible) {
    try {
      var props = document.getElementById('prop-btns');
      var pr = props ? props.getBoundingClientRect() : null;
      var rr = go.parentNode ? go.parentNode.getBoundingClientRect() : null;
      if (pr && rr && pr.width > 0 && rr.right > pr.left) w = Math.round(rr.right - pr.left);
    } catch(_) {}
  }
  if (go.style.width === w + 'px') return;
  go.style.width = w + 'px';
  go.style.flex  = '0 0 ' + w + 'px';
}
function _tlApplyPropsWidth() {
  var props = document.getElementById('prop-btns');
  if (!props) return;
  var w = _tlSavedPropsWidth();
  _tlPropsW = w;
  if (_tlVisible) {
    props.style.width    = w + 'px';
    props.style.flex     = '0 0 ' + w + 'px';
    props.style.maxWidth = '';
  } else {
    props.style.width    = '';
    props.style.flex     = '1 1 auto';
    props.style.maxWidth = 'none';
  }
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
  svg.addEventListener('pointermove', function(e) {
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
  // area keeps _TL_MAIN_MIN). A double press goes back to fitting the rows.
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
      if (now - _vLastUp < _TL_DBL_MS) { _vLastUp = 0; _tlUserH = null; _tlApplyHeight(); return; } // double press: fit the rows again
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
function _showTooltip(el, text) {
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

function _attachTooltip(el, text) {
  if (!el) return;
  var DELAY = 500;
  el.addEventListener('mouseenter', function() {
    if (_tipTimer) clearTimeout(_tipTimer);
    _tipTimer = setTimeout(function() {
      _tipTimer = null;
      var t = typeof text === 'function' ? text() : text;
      _showTooltip(el, t);
    }, DELAY);
  });
  el.addEventListener('mouseleave',  _hideTooltip);
  el.addEventListener('pointerdown', _hideTooltip);
}

function renderUI(s) {
  var propBtns = document.getElementById('prop-btns');
  if (propBtns) {
    var params  = s.availableParams || [];
    var curKeys = propBtns.dataset.keys || '';
    var newKeys = params.map(function(p){ return p.key; }).join(',');
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
        propLabel.textContent = p.displayName;
        btn.appendChild(propDiamond);
        btn.appendChild(propLabel);
        // Undo: remove the keyframes a bake added to this property. Hidden unless
        // the row has a bake record (display is toggled inline in the sync pass).
        var propUndo = document.createElement('span');
        propUndo.className = 'prop-undo';
        _addPressState(propUndo);
        propUndo.style.display = 'none';
        _attachTooltip(propUndo, 'Undo the bake on this property');
        propUndo.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3.8 5.5H8.6a2.9 2.9 0 010 5.8H6.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M5.8 3.3L3.5 5.5l2.3 2.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
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
        propCurve.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2.5 11.5C6 11.5 8 2.5 11.5 2.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="2.5" cy="11.5" r="1.6" fill="currentColor"/><circle cx="11.5" cy="2.5" r="1.6" fill="currentColor"/></svg>';
        propCurve.addEventListener('click', function(ev) {
          ev.stopPropagation();
          _loadBakedCurve(p.key);
        });
        // Pin: jump the playhead to this property's keyframes (doesn't toggle selection)
        var propPin = document.createElement('span');
        propPin.className = 'prop-pin';
        _addPressState(propPin);
        _attachTooltip(propPin, 'Jump playhead to keyframes');
        propPin.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><line x1="1.5" y1="7" x2="9" y2="7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M6 3.8L9.2 7 6 10.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><line x1="12" y1="3.2" x2="12" y2="10.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
        propPin.addEventListener('click', function(ev) {
          ev.stopPropagation();
          // Rows persist across polls, so look up the latest jump time by key
          // rather than using the `p` captured when this row was built.
          var live = (getState().availableParams || []).filter(function(x){ return x.key === p.key; })[0];
          _jumpToParam(live || p);
        });
        btn.appendChild(propCurve);
        btn.appendChild(propUndo);
        btn.appendChild(propPin);
        btn.dataset.key = p.key;
        // Hovering a row lights its lane in the mini timeline (a hovered lane lights the row)
        btn.addEventListener('mouseenter', function() { _tlHighlightLane(p.key); });
        btn.addEventListener('mouseleave', function() { _tlHighlightLane(null); });
        btn.addEventListener('click', function() { _togglePropKey(p.key); });
        propBtns.appendChild(btn);
      });
    }
    var selKeys   = s.selectedParamKeys || [];
    var bakedKeys = s.bakedParamKeys   || [];
    var validKeys = s.validParamKeys   || [];
    propBtns.querySelectorAll('.prop-btn').forEach(function(btn) {
      var k = btn.dataset.key;
      var isSel = selKeys.indexOf(k) >= 0;
      btn.classList.toggle('active', isSel);
      // Marker: a tick while selected or baked (green row); otherwise a filled
      // diamond when the playhead is already over this property's pair (the pin
      // is blue), hollow if not
      var isBakedRow = bakedKeys.indexOf(k) >= 0;
      _setMarker(btn.querySelector('.prop-diamond'), (isSel || isBakedRow) ? 'tick' : (validKeys.indexOf(k) >= 0 ? 'filled' : 'hollow'));
      // Selected but the playhead isn't between its keyframes yet: orange until it is
      btn.classList.toggle('pending', isSel && validKeys.indexOf(k) < 0);
      // Playhead is already between this property's keyframes: pin shows blue even when unselected
      btn.classList.toggle('ready', validKeys.indexOf(k) >= 0);
      btn.classList.toggle('baked',  bakedKeys.indexOf(k) >= 0 && selKeys.indexOf(k) < 0);
      // The pin carries its own state classes: UXP doesn't restyle a child when
      // only the row's class changes, so ".prop-btn.baked .prop-pin" went stale
      var pinEl = btn.querySelector('.prop-pin');
      if (pinEl) {
        var pinReady = validKeys.indexOf(k) >= 0;
        pinEl.classList.toggle('pin-ready',   pinReady);
        pinEl.classList.toggle('pin-active',  isSel);
        pinEl.classList.toggle('pin-pending', isSel && !pinReady);
        pinEl.classList.toggle('pin-baked',   bakedKeys.indexOf(k) >= 0 && !isSel);
      }
      // Undo button only on rows with a bake to undo (inline style: UXP ignores class-driven display changes)
      var undoEl = btn.querySelector('.prop-undo');
      if (undoEl) undoEl.style.display = bakedKeys.indexOf(k) >= 0 ? 'flex' : 'none';
      var curveEl = btn.querySelector('.prop-curve');
      if (curveEl) {
        var brow = (s.availableParams || []).filter(function(x){ return x.key === k; })[0];
        curveEl.style.display = (bakedKeys.indexOf(k) >= 0 && brow && brow.bakeCurve) ? 'flex' : 'none';
      }
    });
  }

  var strip = document.getElementById('status-strip');
  var txt   = document.getElementById('status-text');
  if (strip && txt) {
    var cfg  = STATUS_CONFIG[s.status] || STATUS_CONFIG['idle'];
    var msg  = typeof cfg.text === 'function' ? cfg.text(s) : cfg.text;
    strip.className = 'status-strip ' + cfg.cls;
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
      clipEl.textContent   = showClip ? s.clipName : '';
      clipEl.style.display = showClip ? 'block' : 'none'; // inline: UXP ignores class-driven display
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
    if (dotEl)  dotEl.style.color  = _sc.dot;
    txt.style.color = _sc.text;
    if (clipEl) clipEl.style.color = _sc.text;
    if (_tlHoverText) msg = _tlHoverText; // pointer over the mini timeline: what's under it
    if (showClip) msg = '\u00b7 ' + msg;
    // Clickable whenever there are valid params: click selects all, click again clears
    var _vk = s.validParamKeys || [];
    if (_vk.length > 0 && s.status !== 'done' && !s.isBaking) strip.className += ' status-clickable';
    txt.textContent = msg;
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
    var goLabel = document.getElementById('go-label');
    if (goArrow)   goArrow.style.display   = s.isBaking ? 'none' : 'inline';
    if (goLabel)   goLabel.style.display   = s.isBaking ? 'none' : 'inline';
    if (goSpinner) goSpinner.style.display = s.isBaking ? 'inline-block' : 'none';
  }

  _tlRender(s);
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
    _attachTooltip(peakBtn, function() {
      return _peakMode
        ? 'A-curve mode is on. Click to go back to the bezier handles'
        : 'A-curve mode: drag on the graph to move the peak left/right; up narrows the ease, down widens it';
    });
    peakBtn.addEventListener('click', function() { _setPeakMode(!_peakMode); });
  }
  _stylePeakBtn();
  _applyPeakVisibility();

  // Add Point: splits the curve's widest segment; unavailable in A-curve mode
  var addPtBtn = document.getElementById('add-point');
  if (addPtBtn) {
    _attachTooltip(addPtBtn, function() {
      return _peakMode
        ? 'Add a point to the curve and go back to the bezier handles, where it can be dragged'
        : 'Add a point to the curve. Drag it and its handles, right-click it to delete. Alt-drag a handle to keep both lengths, Ctrl-drag to move it on its own (makes a corner)';
    });
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

  // Preset toolbar (top of the preset column): List/Grid toggle and Paste Preset,
  // the same actions as the preset list's context menu
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
  var pasteBtn = document.getElementById('preset-paste');
  if (pasteBtn) {
    _attachTooltip(pasteBtn, 'Paste Preset: add a preset from cubic-bezier() or opencurve() text');
    pasteBtn.addEventListener('click', function() { _pasteCoordinates(); });
  }
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
                || document.getElementById('oc-numeric') || document.getElementById('_paste-box'));
    var isEnter = e.key === 'Enter' || e.keyCode === 13 || e.which === 13 || e.code === 'Enter' || e.code === 'NumpadEnter';
    if (isEnter) {
      if (e.repeat || modal) return;
      var go = document.getElementById('go-btn');
      if (!go || go.classList.contains('btn-disabled')) { console.log('[OC] Enter: Go is disabled'); return; }
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

  var zoomIn  = document.getElementById('zoom-in');
  var zoomOut = document.getElementById('zoom-out');
  _attachTooltip(zoomIn,  'Zoom in');
  _attachTooltip(zoomOut, 'Zoom out');
  function applyZoom(delta) {
    _zoom = Math.max(0.25, Math.min(1.0, _zoom + delta));
    _updateContentTransform();
  }
  var _zoomTimer = null;
  var _zoomInterval = null;
  function _stopZoom(btn) {
    clearTimeout(_zoomTimer);
    clearInterval(_zoomInterval);
    _zoomTimer = null; _zoomInterval = null;
    if (btn) { btn.style.background = ''; btn.style.color = ''; }
  }
  function addHoldZoom(btn, delta) {
    if (!btn) return;
    btn.addEventListener('pointerdown', function(e) {
      e.preventDefault();
      _stopZoom(zoomIn === btn ? zoomOut : zoomIn);
      btn.style.background = 'rgba(255,255,255,0.22)';
      btn.style.color = '#ffffff';
      applyZoom(delta);
      _zoomTimer = setTimeout(function() {
        _zoomInterval = setInterval(function() { applyZoom(delta); }, 80);
      }, 600);
    });
    function stop() { _stopZoom(btn); }
    btn.addEventListener('pointerup',     stop);
    btn.addEventListener('pointerleave',  stop);
    btn.addEventListener('pointercancel', stop);
  }
  addHoldZoom(zoomIn,   0.1);
  addHoldZoom(zoomOut, -0.1);

  // Collapsed toolbar: as soon as the bar is too narrow for the left tools and
  // the zoom/settings group to sit apart, every tool but Full Screen and
  // Settings hides and one menu button takes the top-left spot; its dropdown
  // lists all of them. Full Screen keeps its place at the far right. Widths are the
  // CSS ones (26px buttons, 5px margins, 5px padding each side), plus a little
  // air so they never touch before collapsing.
  var toolbar  = document.getElementById('graph-toolbar');
  var menuBtn  = document.getElementById('graph-tools-menu');
  var _tbTools = [peakBtn, addPtBtn, flipBtn, invertBtn, ghostBtn, numBtn, zoomOut, zoomIn];
  var _TB_NEED = (6 * 26 + 5 * 5) + (3 * 26 + 2 * 5) + 10 + 8;
  var _tbCollapsed = null;
  var _tbDismiss   = null;
  function _hideToolsMenu() {
    var m = document.getElementById('_tools-menu');
    if (m && m.parentNode) m.parentNode.removeChild(m);
    if (_tbDismiss) { window.removeEventListener('pointerdown', _tbDismiss); _tbDismiss = null; }
  }
  function _tbLayout() {
    if (!toolbar || !menuBtn) return;
    var w = toolbar.clientWidth;
    if (!(w > 0)) return;
    var collapse = w < _TB_NEED;
    if (collapse === _tbCollapsed) return;
    _tbCollapsed = collapse;
    // inline display: UXP ignores class-driven display changes
    _tbTools.forEach(function(b) { if (b) b.style.display = collapse ? 'none' : ''; });
    menuBtn.style.display = collapse ? '' : 'none';
    if (!collapse) _hideToolsMenu();
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
      if (svg) ic.appendChild(svg.cloneNode(true)); // the tool's own icon
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
    item(_peakMode ? 'A-curve Mode: On' : 'A-curve Mode', peakBtn, function() { _setPeakMode(!_peakMode); }, { active: _peakMode });
    item('Add Point', addPtBtn, function() { if (_peakMode) _setPeakMode(false); _addPoint(); });
    item('Flip',      flipBtn,   function() { _applyCurveOp(_flipCurve); });
    item('Invert',    invertBtn, function() { _applyCurveOp(_invertCurve); });
    item(_dragGhost ? 'Ghost: On' : 'Ghost', ghostBtn, function() { _setDragGhost(!_dragGhost); }, { active: _dragGhost });
    item('Numeric Entry', numBtn, function() { _showNumericPanel(); });
    item('Zoom In',   zoomIn,    function() { applyZoom(0.1); },  { keepOpen: true });
    item('Zoom Out',  zoomOut,   function() { applyZoom(-0.1); }, { keepOpen: true });
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
  if (menuBtn) {
    _attachTooltip(menuBtn, 'Graph tools');
    menuBtn.addEventListener('click', function() {
      if (document.getElementById('_tools-menu')) _hideToolsMenu(); else _showToolsMenu();
    });
  }
  if (toolbar && typeof ResizeObserver !== 'undefined') new ResizeObserver(_tbLayout).observe(toolbar);
  _tbLayout();

  // ── Unified preset system ─────────────────────────────────────
  var _STORAGE_KEY  = 'opencurve-presets-v10';

  function _loadPresetList() {
    try { return JSON.parse(localStorage.getItem(_STORAGE_KEY)); } catch(e) { return null; }
  }
  function _savePresetList(list) {
    localStorage.setItem(_STORAGE_KEY, JSON.stringify(list));
  }

  var _stored = _loadPresetList();
  var _presetList = _stored || BUILT_IN_PRESETS.map(function(p) {
    return { id: p.id, name: p.name, curve: p.curve, builtIn: true };
  }).concat(_starterPresetEntries()); // fresh install: the starter set comes along
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
    var c = getState().curve;
    t.preset.curve = _cloneCurve(c);
    _savePresetList(_presetList);
    var thumb = t.btn.querySelector('.preset-thumb path');
    if (thumb) thumb.setAttribute('d', _thumbPathD(t.preset.curve));
    _showCopyToast('Preset updated');
  }, _icOverwrite);
  _ctxItem('Delete Preset', true, function(t) {
    if (!t) return;
    _confirmDialog('Delete Preset', 'Delete "' + t.preset.name + '"? This cannot be undone.', 'Delete', function() {
      _presetList = _presetList.filter(function(p) { return p.id !== t.preset.id; });
      _savePresetList(_presetList);
      if (t.btn && t.btn.parentNode) t.btn.parentNode.removeChild(t.btn);
    });
  }, _icDelete);
  var _icSettingsCtx = '<svg width="16" height="16" viewBox="0 0 12 12" fill="none"><path d="M10.18 5 L11.53 5.12 L11.53 6.88 L10.18 7 A4.3 4.3 0 0 1 9.67 8.25 L9.67 8.25 L10.53 9.29 L9.29 10.53 L8.25 9.67 A4.3 4.3 0 0 1 7 10.18 L7 10.18 L6.88 11.53 L5.12 11.53 L5 10.18 A4.3 4.3 0 0 1 3.75 9.67 L3.75 9.67 L2.71 10.53 L1.47 9.29 L2.33 8.25 A4.3 4.3 0 0 1 1.82 7 L1.82 7 L0.47 6.88 L0.47 5.12 L1.82 5 A4.3 4.3 0 0 1 2.33 3.75 L2.33 3.75 L1.47 2.71 L2.71 1.47 L3.75 2.33 A4.3 4.3 0 0 1 5 1.82 L5 1.82 L5.12 0.47 L6.88 0.47 L7 1.82 A4.3 4.3 0 0 1 8.25 2.33 L8.25 2.33 L9.29 1.47 L10.53 2.71 L9.67 3.75 A4.3 4.3 0 0 1 10.18 5 Z M8.3 6 A2.3 2.3 0 0 0 3.7 6 A2.3 2.3 0 0 0 8.3 6 Z" fill="currentColor" fill-rule="evenodd"/></svg>'; // same gear as the graph toolbar
  _ctxItem('Open Settings', false, function() {
    _showSettingsModal();
  }, _icSettingsCtx);
  // List/Grid toggle at the bottom, same action as the empty-space menu.
  // Label and icon are refreshed each time the menu opens.
  var _icGridCtx = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><rect x="1.5" y="1.5" width="4.5" height="4.5" rx="0.5" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="8" y="1.5" width="4.5" height="4.5" rx="0.5" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="1.5" y="8" width="4.5" height="4.5" rx="0.5" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="8" y="8" width="4.5" height="4.5" rx="0.5" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
  var _icListCtx = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><line x1="1.5" y1="3.5" x2="12.5" y2="3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="1.5" y1="7" x2="12.5" y2="7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="1.5" y1="10.5" x2="12.5" y2="10.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
  var _layoutCtxItem = _ctxItem('Grid View', false, function() {
    _presetLayout = _presetLayout === 'list' ? 'grid' : 'list';
    localStorage.setItem(_LAYOUT_KEY, _presetLayout);
    _applyPresetLayout(true);
  }, _icGridCtx);
  function _syncLayoutCtxItem() {
    // Children are [iconSpan, labelSpan]; no expando properties (UXP may drop them)
    var kids = _layoutCtxItem.children;
    var lbl  = kids[kids.length - 1];
    var ic   = kids.length > 1 ? kids[0] : null;
    if (lbl) lbl.textContent = _presetLayout === 'list' ? 'Grid View' : 'List View';
    if (ic)  ic.innerHTML    = _presetLayout === 'list' ? _icGridCtx : _icListCtx;
  }

  function _showCtxMenu(preset, btn, startRename, e) {
    var existingMini = document.getElementById('_mini-ctx');
    if (existingMini && existingMini.parentNode) existingMini.parentNode.removeChild(existingMini);
    _ctxTarget = { preset: preset, btn: btn, startRename: startRename };
    _syncLayoutCtxItem();
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
  window.addEventListener('pointerdown', function(e) {
    if (!_ctxMenu.contains(e.target)) _hideCtxMenu();
  });

  // ── Thumbnails ────────────────────────────────────────────────
  // Thumbnail mapping: the 0..1 box, stretched to the curve's y extent when it
  // overshoots (Back / Bounce presets), so the shape isn't clipped
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
  // follows the Animations setting.
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

    function startRename() {
      var input = document.createElement('input');
      input.type = 'text'; input.value = preset.name;
      input.className = 'preset-rename-input';
      if (_presetLayout === 'grid') {
        input.style.width = '100%';
        input.style.maxWidth = '100%';
        input.style.textAlign = 'center';
        input.style.boxSizing = 'border-box';
      }
      btn.replaceChild(input, nameSpan);
      input.focus(); input.select();
      function commit() {
        var v = input.value.trim() || preset.name;
        preset.name = v; nameSpan.textContent = v;
        if (input.parentNode === btn) btn.replaceChild(nameSpan, input);
        _savePresetList(_presetList);
      }
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', function(ev) {
        if (ev.key === 'Enter')  { input.blur(); }
        if (ev.key === 'Escape') { input.value = preset.name; input.blur(); }
      });
    }
    nameSpan.addEventListener('dblclick', function(e) { e.stopPropagation(); startRename(); });
    btn.addEventListener('contextmenu', function(e) { e.preventDefault(); _showCtxMenu(preset, btn, startRename, e); });

    return btn;
  }

  // Drag-to-reorder
  function _initDragSort(container) {
    var dragEl = null, dropLine = null, startY = 0, startX = 0, moved = false;
    var _lastDownBtn = null, _lastDownTime = 0;
    var _dragGhost = null;

    container.addEventListener('pointerdown', function(e) {
      var btn = e.target;
      while (btn && btn !== container) {
        if (btn.classList && btn.classList.contains('preset-btn')) break;
        btn = btn.parentNode;
      }
      if (!btn || btn === container) return;
      if (btn.id === 'new-preset-btn') return;
      if (btn.id === '_update-notif') return;
      if (e.target.classList && e.target.classList.contains('preset-rename-input')) return;

      var now = Date.now();
      if (btn === _lastDownBtn && now - _lastDownTime < 350) {
        _lastDownBtn = null;
        return;
      }
      _lastDownBtn = btn;
      _lastDownTime = now;

      dragEl = btn; startX = e.clientX; startY = e.clientY; moved = false;
      _pendingPointerId = e.pointerId;
    });

    var _dropHighlight = null;
    var _pendingPointerId = null;
    container.addEventListener('pointermove', function(e) {
      if (!dragEl) return;
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
          var rect = dragEl.getBoundingClientRect();
          _dragGhost = dragEl.cloneNode(true);
          _dragGhost.style.cssText = 'position:fixed;z-index:9999;pointer-events:none;opacity:0.6;transform:scale(0.85);width:' + rect.width + 'px;';
          _dragGhost.style.left = (e.clientX - rect.width / 2) + 'px';
          _dragGhost.style.top = (e.clientY - rect.height / 2) + 'px';
          document.body.appendChild(_dragGhost);
          dragEl.style.display = 'none';
        }
      }
      if (_dragGhost) {
        var gw = _dragGhost.offsetWidth || 80;
        var gh = _dragGhost.offsetHeight || 60;
        _dragGhost.style.left = (e.clientX - gw / 2) + 'px';
        _dragGhost.style.top = (e.clientY - gh / 2) + 'px';
      }
      var isGrid = _presetCols > 1; // grid, or the two-column list
      var items = Array.from(container.children).filter(function(c) {
        return c !== dragEl && c !== dropLine && c.id !== 'new-preset-btn';
      });
      var after = null;
      if (isGrid) {
        var hoverTarget = null;
        for (var i = 0; i < items.length; i++) {
          var r = items[i].getBoundingClientRect();
          if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
            hoverTarget = items[i];
            break;
          }
        }
        if (hoverTarget) after = hoverTarget;
        if (_dropHighlight && _dropHighlight !== after) {
          _dropHighlight.style.outline = '';
        }
        if (after && after !== dragEl) {
          after.style.outline = '2px solid var(--accent)';
          _dropHighlight = after;
        } else if (_dropHighlight) {
          _dropHighlight.style.outline = '';
          _dropHighlight = null;
        }
      } else {
        if (_dropHighlight) { _dropHighlight.style.outline = ''; _dropHighlight = null; }
        for (var j = 0; j < items.length; j++) {
          var r2 = items[j].getBoundingClientRect();
          if (e.clientY < r2.top + r2.height / 2) { after = items[j]; break; }
        }
      }
      var newPBtn = document.getElementById('new-preset-btn');
      if (after) container.insertBefore(dropLine, after);
      else if (newPBtn) container.insertBefore(dropLine, newPBtn);
      else container.appendChild(dropLine);
    });

    function endDragSort() {
      if (!dragEl) return;
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
      dragEl = null; dropLine = null; moved = false; _pendingPointerId = null;
      if (_presetCols > 1) _applyPresetLayout(true);
    }

    container.addEventListener('pointerup',     endDragSort);
    container.addEventListener('pointercancel', endDragSort);
  }

  function _renderPresets() {
    var list = document.getElementById('all-presets-list');
    if (!list) return;
    var newBtn = document.getElementById('new-preset-btn');
    list.innerHTML = '';
    _presetList.forEach(function(p) { list.appendChild(_buildPresetBtn(p)); });
    if (newBtn) list.appendChild(newBtn);
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

  _renderPresets();
  _refreshUpdateNotification();

  _applyPresetLayout(true);
  var _presetListEl = document.getElementById('all-presets-list');
  if (_presetListEl && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(_updateGridCols).observe(_presetListEl);
  }

  function _parseCubicBezier(text) {
    if (!text) return null;
    var multi = _curveFromText(text); // opencurve(...) form carries points
    if (multi) return multi;
    var m = text.match(/cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/i);
    if (!m) return null;
    var vals = [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), parseFloat(m[4])];
    if (vals.some(isNaN)) return null;
    return { p1x: vals[0], p1y: vals[1], p2x: vals[2], p2y: vals[3] };
  }

  function _createPresetFromCurve(curve) {
    var list = document.getElementById('all-presets-list');
    if (!list) return;
    var preset = {
      id: 'c' + Date.now(),
      name: 'Pasted ' + (_presetList.filter(function(p){ return !p.builtIn; }).length + 1),
      curve: curve,
    };
    _presetList.push(preset);
    _savePresetList(_presetList);
    var btn = _buildPresetBtn(preset);
    var newPBtn = document.getElementById('new-preset-btn');
    if (newPBtn) list.insertBefore(btn, newPBtn); else list.appendChild(btn);
    _applyPresetLayout(true);
    var ns = btn.querySelector('.preset-name');
    if (ns) ns.dispatchEvent(new Event('dblclick'));
  }

  // Add presets in bulk (starter set, file import): tiles go in before the New tile
  function _addPresetEntries(entries) {
    var list = document.getElementById('all-presets-list');
    if (!list || !entries.length) return;
    var newPBtn = document.getElementById('new-preset-btn');
    entries.forEach(function(p) {
      _presetList.push(p);
      var btn = _buildPresetBtn(p);
      if (newPBtn) list.insertBefore(btn, newPBtn); else list.appendChild(btn);
    });
    _savePresetList(_presetList);
    _applyPresetLayout(true);
  }
  function _presetSig(p) { return p.name + '|' + _curveToText(p.curve); }
  // Starter set (see STARTER_PRESETS): only the names not already in the list are added
  function _addStarterPresets() {
    var have = {};
    _presetList.forEach(function(p) { have[p.name] = true; });
    var add = _starterPresetEntries().filter(function(p) { return !have[p.name]; });
    _addPresetEntries(add);
    _showCopyToast(add.length ? 'Added ' + add.length + ' starter preset' + (add.length === 1 ? '' : 's') : 'All starter presets are already in the list', '#3ddc84');
  }
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
      try { parsed = JSON.parse(text); } catch(_) {}
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
    box.style.cssText = 'position:fixed;top:-9999px;left:'+boxL+'px;width:'+boxW+'px;visibility:hidden;background:#1c1c1c;border:1px solid rgba(255,255,255,0.18);z-index:9998;padding:16px;font-family:system-ui,sans-serif;';
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
    pasteTf.wrap.style.marginBottom = '6px';
    box.appendChild(pasteTf.wrap);

    var err = document.createElement('div');
    err.style.cssText = 'color:#ff9090;font-size:12px;min-height:16px;margin-bottom:10px;';
    box.appendChild(err);

    var btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;justify-content:flex-start;';

    var addBtn = document.createElement('div');
    addBtn.textContent = 'Add Preset';
    addBtn.style.cssText = 'color:#4a9eff;font-size:13px;font-weight:600;cursor:pointer;padding:5px 12px;border:2px solid rgba(74,158,255,0.4);margin-right:10px;';
    addBtn.addEventListener('mouseenter', function() { addBtn.style.color='#7dc4ff'; addBtn.style.borderColor='rgba(74,158,255,0.8)'; });
    addBtn.addEventListener('mouseleave', function() { addBtn.style.color='#4a9eff'; addBtn.style.borderColor='rgba(74,158,255,0.4)'; });
    addBtn.addEventListener('click', function() {
      var curve = _parseCubicBezier(input.value.trim());
      if (!curve) { err.textContent = 'Invalid format — expected cubic-bezier(x1, y1, x2, y2) or an opencurve(...) value'; return; }
      close();
      _createPresetFromCurve(curve);
    });

    var cancelBtn = document.createElement('div');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'color:#888;font-size:13px;cursor:pointer;padding:5px 12px;border:2px solid rgba(255,255,255,0.12);';
    cancelBtn.addEventListener('mouseenter', function() { cancelBtn.style.color='#e4e4e4'; cancelBtn.style.borderColor='rgba(255,255,255,0.25)'; });
    cancelBtn.addEventListener('mouseleave', function() { cancelBtn.style.color='#888'; cancelBtn.style.borderColor='rgba(255,255,255,0.12)'; });
    cancelBtn.addEventListener('click', close);

    btnRow.appendChild(addBtn);
    btnRow.appendChild(cancelBtn);
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

  // Mini context menu
  function _showMiniCtxMenu(e, showPaste, showLayout, showGrid, pointIdx, showTlZoom) {
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
    var _icGrid = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><rect x="1.5" y="1.5" width="4.5" height="4.5" rx="0.5" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="8" y="1.5" width="4.5" height="4.5" rx="0.5" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="1.5" y="8" width="4.5" height="4.5" rx="0.5" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="8" y="8" width="4.5" height="4.5" rx="0.5" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
    var _icList = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><line x1="1.5" y1="3.5" x2="12.5" y2="3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="1.5" y1="7" x2="12.5" y2="7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="1.5" y1="10.5" x2="12.5" y2="10.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
    var _icTlKeys = '<svg width="16" height="16" viewBox="0 0 12 12" fill="none"><path d="M3.2 1.5H1.5v9h1.7M8.8 1.5h1.7v9H8.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><polygon points="6,3.4 8.6,6 6,8.6 3.4,6" fill="currentColor"/></svg>';
    var _icTlClip = '<svg width="16" height="16" viewBox="0 0 12 12" fill="none"><rect x="0.9" y="2.6" width="10.2" height="6.8" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/><polygon points="6,4.2 7.6,6 6,7.8 4.4,6" fill="currentColor"/></svg>';
    var _icPaste = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><rect x="3" y="2" width="8" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><path fill="none" d="M5.5 2V1.5a1 1 0 011-1h1a1 1 0 011 1V2" stroke="currentColor" stroke-width="1.3"/><line x1="5.5" y1="6" x2="8.5" y2="6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="5.5" y1="8.5" x2="8.5" y2="8.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';

    var _icStar   = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M7 1.6l1.6 3.4 3.7.5-2.7 2.6.7 3.7L7 10l-3.3 1.8.7-3.7L1.7 5.5l3.7-.5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    var _icExport = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M2 9.5v2.5h10V9.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M7 9V1.5M4.2 4.3L7 1.5l2.8 2.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    var _icImport = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M2 9.5v2.5h10V9.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M7 1.5V9M4.2 6.2L7 9l2.8-2.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

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
    // Timeline menu: what the lanes span, then the shared Open Settings
    if (showTlZoom) {
      _miniItem(_tlZoomKeys ? 'Show Whole Clip' : 'Zoom to Keyframes',
                _tlZoomKeys ? _icTlClip : _icTlKeys,
                function() { _tlSetZoom(!_tlZoomKeys); });
    }
    _miniItem('Open Settings', _icSettings, function() { _showSettingsModal(); });

    if (showPaste) {
      _miniItem('Paste Preset', _icPaste, function() { _pasteCoordinates(); });
      _miniItem('Add Starter Presets', _icStar, function() { _addStarterPresets(); });
      _miniItem('Export Presets\u2026', _icExport, function() { _exportPresetsToFile(); });
      _miniItem('Import Presets\u2026', _icImport, function() { _importPresetsFromFile(); });
    }

    if (showGrid) {
      var gridRow = document.createElement('div');
      gridRow.style.cssText = 'display:flex;border-top:1px solid rgba(255,255,255,0.07);';
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
      // Real presets have their own menu; the New Preset tile gets the list menu
      if (onPreset && onPreset.id !== 'new-preset-btn') return;
      _showMiniCtxMenu(e, true);
    });
  })();

  // Right-click on the mini timeline's lanes: zoom toggle + Open Settings.
  // Bound to the SVG and its wrapper both; _showMiniCtxMenu stops propagation,
  // so the wrapper only ever handles the strip of area outside the SVG.
  (function() {
    var targets = [document.getElementById('tl-svg'), document.querySelector('.tl-canvas-wrap')];
    targets.forEach(function(el) {
      if (!el) return;
      el.addEventListener('contextmenu', function(e) { _showMiniCtxMenu(e, false, false, false, null, true); });
    });
  })();

  // Right-click on graph editor
  (function() {
    var graph = document.getElementById('bezier-svg');
    if (!graph) return;
    graph.addEventListener('contextmenu', function(e) {
      var hit = _graphHitTest ? _graphHitTest(e) : null;
      if (hit && hit.k === 'a') { _showMiniCtxMenu(e, false, false, false, hit.i); return; }
      _showMiniCtxMenu(e, false, false, true);
    });
  })();

  // New Preset button
  (function() {
    var list = document.getElementById('all-presets-list');
    if (!list) return;

    // New Preset: the toolbar button at the left of the preset bar (#preset-new)
    // saves the current curve as a preset and opens its name for editing
    var newTool = document.getElementById('preset-new');
    if (newTool) {
      _attachTooltip(newTool, 'New Preset: save the current curve as a preset');
      newTool.addEventListener('click', function() {
        var preset = {
          id: 'c' + Date.now(),
          name: 'Custom ' + (_presetList.filter(function(p){ return !p.builtIn; }).length + 1),
          curve: _cloneCurve(getState().curve),
        };
        _presetList.push(preset);
        _savePresetList(_presetList);
        var btn = _buildPresetBtn(preset);
        list.appendChild(btn);
        _applyPresetLayout(true);
        var ns = btn.querySelector('.preset-name');
        if (ns) ns.dispatchEvent(new Event('dblclick'));
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
        // Select every valid property
        var up = { selectedParamKeys: valid.slice() };
        if (s.status === 'no-selection') up.status = 'valid';
        setState(up);
      } else {
        // Everything already selected: second click clears the selection
        var down = { selectedParamKeys: [] };
        if (s.status === 'valid') down.status = 'no-selection';
        setState(down);
      }
    });
  }

  function _updateStripCursor(s) {
    if (!statusStrip) return;
    var valid = s.validParamKeys || [];
    var clickable = (valid.length > 0 && s.status !== 'done' && !s.isBaking)
                 || (s.status === 'outside' && !!_nearestJumpParam(s));
    statusStrip.style.cursor = clickable ? 'pointer' : 'default';
  }
  stateListeners.push(_updateStripCursor);

  // Go button — calls bridge.onGo()
  var goBtn = document.getElementById('go-btn');
  if (goBtn) {
    _attachTooltip(goBtn, function() {
      return goBtn.classList.contains('btn-disabled')
        ? 'Select a property that the playhead is over'
        : 'Apply the curve to the selected properties';
    });
    goBtn.addEventListener('click', function() {
      var s = getState();
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
  setPresetActive('s-curve');
}

// ─── Settings / shared variables ─────────────────────────────────────────
var CURRENT_VERSION     = '2.0.0';
var _CURVE_COLOR_KEY    = 'opencurve-line-color';
var _curveColor         = localStorage.getItem(_CURVE_COLOR_KEY) || '#38fbb2';
var _updateAvailable    = false;
var _latestVersion      = null;
var _updateDismissed    = false;
var _UPDATE_NOTIF_KEY   = 'opencurve-update-notif';
var _updateNotifsOn     = localStorage.getItem(_UPDATE_NOTIF_KEY) !== 'off';
var _ANIM_KEY           = 'opencurve-animations';
var _animationsOn       = localStorage.getItem(_ANIM_KEY) !== 'off';
// 2.0.0: "Scan During Playback" is always on (the toggle only made the panel
// worse). Drop the old key so a user who had turned it off comes back on.
try { localStorage.removeItem('opencurve-scan-during-playback'); } catch(e) {}
var _GRID_KEY           = 'opencurve-grid-size';
var _gridSize           = parseInt(localStorage.getItem(_GRID_KEY), 10) || 8;
var _LAYOUT_KEY         = 'opencurve-preset-layout';
var _presetLayout       = localStorage.getItem(_LAYOUT_KEY) || 'list';
var _GRAPH_KEY          = 'opencurve-graph-visible';
// Defaults to On — only hidden when the user has explicitly disabled the graph.
var _graphVisible       = localStorage.getItem(_GRAPH_KEY) !== 'off';
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
function _applyGraphVisibility() {
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
    btn.style.background = _graphFull ? 'rgba(74,158,255,0.18)' : '';
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
  var thumbSz = isGrid ? (cols >= 3 ? 30 : 32) : 28;

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
      btn.style.minHeight = (cols >= 3 ? '58px' : '66px');
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
      n.style.whiteSpace = 'normal';
      n.style.overflow = 'visible';
      n.style.textOverflow = 'clip';
      n.style.marginTop = '4px';
    } else {
      n.style.whiteSpace = '';
      n.style.overflow = '';
      n.style.textOverflow = '';
      n.style.marginTop = '';
    }
  });

  list.querySelectorAll('.preset-thumb').forEach(function(t) {
    if (isGrid) {
      t.setAttribute('width', String(thumbSz));
      t.setAttribute('height', String(thumbSz));
      t.style.marginRight = '0';
    } else {
      t.setAttribute('width', '28');
      t.setAttribute('height', '28');
      t.style.marginRight = '';
    }
  });

  var notifEl = document.getElementById('_update-notif');
  if (notifEl) {
    var notifIcon = notifEl.querySelector('.preset-thumb');
    var notifName = notifEl.querySelector('.preset-name');
    var notifBr = notifEl.querySelector('.notif-br');
    if (isGrid) {
      if (notifIcon) { notifIcon.style.width = '22px'; notifIcon.style.height = '22px'; notifIcon.style.fontSize = '14px'; notifIcon.style.marginTop = '-4px'; }
      if (notifName) { notifName.style.fontSize = '12px'; notifName.style.marginTop = '2px'; notifName.style.lineHeight = '1.2'; }
      if (notifBr) notifBr.style.display = '';
    } else {
      if (notifIcon) { notifIcon.style.width = '28px'; notifIcon.style.height = '28px'; notifIcon.style.fontSize = '16px'; notifIcon.style.marginTop = ''; }
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
      }, 200);
    }
  }
}
var _gridColsTimer = null;
var _LIST_2COL_W = 340; // list view splits into two columns from this width
var _presetCols = 1;    // columns the last _applyPresetLayout laid out
function _updateGridCols() {
  if (_gridColsTimer) clearTimeout(_gridColsTimer);
  _gridColsTimer = setTimeout(_applyPresetLayout, 60);
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
    p.setAttribute('stroke', color);
  });
  if (/^#[0-9a-fA-F]{6}$/.test(color)) {
    var bg  = _hexToRgba(color, 0.15);
    var bg2 = _hexToRgba(color, 0.28);
    var root = document.documentElement;
    root.style.setProperty('--oc-active-color', color);
    root.style.setProperty('--oc-active-bg',    bg);
    root.style.setProperty('--oc-active-bg2',   bg2);
  }
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
  ].join(';');
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
  if (!_updateAvailable || _updateDismissed || !_updateNotifsOn) return;

  var notif = document.createElement('div');
  notif.id = '_update-notif';
  notif.className = 'preset-btn';
  notif.style.color = '#e6b800';
  notif.style.background = 'rgba(240,180,0,0.08)';
  notif.style.position = 'relative';

  var iconWrap = document.createElement('span');
  iconWrap.className = 'preset-thumb';
  iconWrap.style.cssText = 'width:28px;height:28px;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-right:8px;font-size:16px;opacity:0.9;';
  iconWrap.textContent = '\u26A0';
  notif.appendChild(iconWrap);

  var nameSpan = document.createElement('span');
  nameSpan.className = 'preset-name';
  nameSpan.innerHTML = 'Update <br class="notif-br">Available';
  notif.appendChild(nameSpan);

  var delBtn = document.createElement('div');
  delBtn.className = 'preset-delete';
  delBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><line x1="1" y1="1" x2="9" y2="9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="9" y1="1" x2="1" y2="9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
  delBtn.style.cssText = 'opacity:0;width:22px;height:22px;display:flex;align-items:center;justify-content:center;';
  notif.addEventListener('mouseenter', function() { delBtn.style.opacity = '1'; notif.style.background = 'rgba(240,180,0,0.15)'; });
  notif.addEventListener('mouseleave', function() { delBtn.style.opacity = '0'; delBtn.style.background = 'transparent'; notif.style.background = 'rgba(240,180,0,0.08)'; });
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

function _applyUpdateBtnState(btn, label) {
  var old = btn.querySelector('._update-icon');
  if (old) btn.removeChild(old);
  var oldLeft = btn.querySelector('._update-left-icon');
  if (oldLeft) btn.removeChild(oldLeft);
  var leftIcon = document.createElement('span');
  leftIcon.className = '_update-left-icon';
  leftIcon.style.cssText = 'display:flex;align-items:center;flex-shrink:0;margin-right:8px;';
  if (_updateAvailable) {
    btn.style.background = 'rgba(240,180,0,0.08)';
    label.textContent = 'Update Available';
    label.style.color = '#e6b800';
    leftIcon.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path fill="none" d="M13.5 8a5.5 5.5 0 11-1.5-3.8" stroke="#e6b800" stroke-width="1.6" stroke-linecap="round"/><polyline fill="none" points="12,2 12,5.5 8.5,5.5" stroke="#e6b800" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    var icon = document.createElement('span');
    icon.className = '_update-icon';
    icon.style.cssText = 'display:flex;align-items:center;flex-shrink:0;margin-left:8px;';
    icon.innerHTML = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M7 2L13 12H1L7 2Z" stroke="#e6b800" stroke-width="1.5" stroke-linejoin="round"/><line x1="7" y1="6" x2="7" y2="9" stroke="#e6b800" stroke-width="1.5" stroke-linecap="round"/><circle cx="7" cy="10.5" r="0.75" fill="#e6b800"/></svg>';
    btn.appendChild(icon);
  } else {
    btn.style.background = 'rgba(230,184,0,0.08)';
    label.textContent = 'Check for Updates';
    label.style.color = '#d4d4d4';
    leftIcon.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path fill="none" d="M13.5 8a5.5 5.5 0 11-1.5-3.8" stroke="#e6b800" stroke-width="1.6" stroke-linecap="round"/><polyline fill="none" points="12,2 12,5.5 8.5,5.5" stroke="#e6b800" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }
  btn.insertBefore(leftIcon, btn.firstChild);
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
  _updateDismissed = false;
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

// Modal confirmation: title, message, a red action button and Cancel.
// onOk runs after the dialog has closed. Used by reset-all and preset delete.
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

  var cancelBtn = document.createElement('div');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = 'background:transparent;border:1px solid rgba(255,255,255,0.12);color:#888;font-size:13px;padding:5px 12px;cursor:pointer;';
  cancelBtn.addEventListener('mouseenter', function() { cancelBtn.style.color='#e4e4e4'; cancelBtn.style.borderColor='rgba(255,255,255,0.25)'; });
  cancelBtn.addEventListener('mouseleave', function() { cancelBtn.style.color='#888'; cancelBtn.style.borderColor='rgba(255,255,255,0.12)'; });
  cancelBtn.addEventListener('click', function() { document.body.removeChild(overlay); });

  var okBtn = document.createElement('div');
  okBtn.textContent = okLabel;
  okBtn.style.cssText = 'background:#f06060;border:none;color:#fff;font-size:13px;padding:5px 12px;cursor:pointer;font-weight:600;margin-left:8px;';
  okBtn.addEventListener('mouseenter', function() { okBtn.style.background='#f27878'; });
  okBtn.addEventListener('mouseleave', function() { okBtn.style.background='#f06060'; });
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

function _confirmReset() {
  _confirmDialog('Reset All Settings', 'This will clear all saved presets, the graph line colour, and reset the curve. This cannot be undone.', 'Reset', function() {
    localStorage.removeItem('opencurve-presets-v10');
    localStorage.removeItem('opencurve-sidebar-width');
    localStorage.removeItem('opencurve-cep-splash-seen');
    localStorage.removeItem(_CURVE_COLOR_KEY);
    localStorage.removeItem(_GRID_KEY);
    localStorage.removeItem(_LAYOUT_KEY);
    localStorage.removeItem(_ANIM_KEY);
    localStorage.removeItem(_UPDATE_NOTIF_KEY);
    localStorage.removeItem(_GRAPH_KEY);
    localStorage.removeItem(_PEAK_KEY);
    localStorage.removeItem(_DRAG_GHOST_KEY);
    localStorage.removeItem(_DENSITY_KEY);
    localStorage.removeItem(_TL_KEY);
    localStorage.removeItem(_TL_ZOOM_KEY);
    localStorage.removeItem(_TL_PROPS_KEY);
    localStorage.removeItem(_TL_H_KEY);
    _bakeDensity        = 1;
    _applyCurveColor('#38fbb2');
    _animationsOn       = true;
    _updateNotifsOn     = true;
    _graphVisible       = true;
    _peakMode           = false;
    _tlVisible          = true;
    _tlZoomKeys         = false;
    _tlUserH            = null;
    setState({ curve: { p1x: 0.625, p1y: 0.000, p2x: 0.375, p2y: 1.000 } });
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
  box.style.cssText = 'width:272px;max-width:96%;flex-shrink:0;background:#1c1c1c;border:1px solid rgba(255,255,255,0.18);padding:16px;font-family:system-ui,sans-serif;box-sizing:border-box;';
  overlay.appendChild(box);

  var start = _cloneCurve(getState().curve);
  var activeBtn = document.querySelector('.preset-btn.active');
  var startPreset = activeBtn ? activeBtn.dataset.id : null;

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
  grid.style.cssText = 'display:flex;flex-wrap:wrap;margin:0 -4px;';
  box.appendChild(grid);
  var fields = {};
  function field(name, label, val) {
    var wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;width:50%;box-sizing:border-box;padding:0 4px 8px;';
    var lb = document.createElement('div');
    lb.textContent = label;
    lb.style.cssText = 'color:#888;font-size:11px;margin-bottom:3px;';
    var tf = _mkTextField(13), inp = tf.input;
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
  textLabel.style.cssText = 'color:#888;font-size:11px;margin:2px 0 3px;';
  box.appendChild(textLabel);
  var textTf = _mkTextField(12), textInp = textTf.input;
  box.appendChild(textTf.wrap);
  textInp.addEventListener('keydown', onKey);
  _attachTooltip(textInp, 'The curve as cubic-bezier() or opencurve() text. Edit it and press Enter or Apply; this is also where a curve with added points is typed');

  var err = document.createElement('div');
  err.style.cssText = 'color:#ff9090;font-size:12px;min-height:16px;margin:4px 0 8px;';
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
  btnRow.style.cssText = 'display:flex;justify-content:flex-start;';
  function mkBtn(label, onClick) {
    var b = document.createElement('div');
    b.textContent = label;
    b.style.cssText = 'color:#4a9eff;font-size:13px;font-weight:600;cursor:pointer;padding:5px 12px;border:2px solid rgba(74,158,255,0.4);margin-right:10px;';
    b.addEventListener('mouseenter', function() { b.style.color = '#7dc4ff'; b.style.borderColor = 'rgba(74,158,255,0.8)'; });
    b.addEventListener('mouseleave', function() { b.style.color = '#4a9eff'; b.style.borderColor = 'rgba(74,158,255,0.4)'; });
    b.addEventListener('click', onClick);
    btnRow.appendChild(b);
    return b;
  }
  mkBtn('Apply', apply);
  var cancelBtn = mkBtn('Cancel', cancel);
  cancelBtn.style.color = '#888'; cancelBtn.style.borderColor = 'rgba(255,255,255,0.15)';
  cancelBtn.addEventListener('mouseenter', function() { cancelBtn.style.color = '#e4e4e4'; cancelBtn.style.borderColor = 'rgba(255,255,255,0.35)'; });
  cancelBtn.addEventListener('mouseleave', function() { cancelBtn.style.color = '#888'; cancelBtn.style.borderColor = 'rgba(255,255,255,0.15)'; });
  box.appendChild(btnRow);

  setTimeout(function() { fields.p1x.focus(); fields.p1x.select(); }, 0);
}

// Preset files (Export / Import Presets in the preset list's context menu).
// CEP: the bridge shows the host's own dialogs through cep.fs.
function _saveTextFile(name, text) {
  if (!_bridge || !_bridge.saveTextFile) return Promise.reject(new Error('File dialogs are not available'));
  return _bridge.saveTextFile(name, text);
}
function _openTextFile() {
  if (!_bridge || !_bridge.openTextFile) return Promise.reject(new Error('File dialogs are not available'));
  return _bridge.openTextFile();
}

function _showSettingsModal() {
  var modal = document.createElement('div');
  modal.id = 'settings-modal';
  var vw = document.documentElement.clientWidth  || document.body.clientWidth;
  var vh = document.documentElement.clientHeight || document.body.clientHeight;
  modal.style.cssText = 'position:fixed;top:0;left:0;width:'+vw+'px;height:'+vh+'px;background:#111111;z-index:9998;display:flex;flex-direction:column;font-family:system-ui,sans-serif;';

  var header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;padding:10px 8px 10px 12px;border-bottom:4px solid #080808;flex-shrink:0;cursor:pointer;transition:background 0.12s;';
  var logoWrap = document.createElement('div');
  logoWrap.style.cssText = 'flex:1;display:flex;align-items:center;justify-content:flex-start;';
  var logo = document.createElement('img');
  // Pre-rendered at the exact display size for 1x/2x/3x screens and shown in a
  // fixed 170x26 box: letting the host shrink a larger PNG made the logo blurry
  var _dpr = window.devicePixelRatio || 1;
  logo.src = 'img/OpenCurve2_Wordmark_small' + (_dpr >= 2.5 ? '@3x' : _dpr >= 1.5 ? '@2x' : '') + '.png';
  logo.style.cssText = 'width:145px;height:22px;opacity:0.9;margin-top:6px;'; // margin centres 3px lower, the artwork sat high
  logoWrap.appendChild(logo);
  var closeBtn = document.createElement('div');
  closeBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 12 12" fill="none"><line x1="2.5" y1="2.5" x2="9.5" y2="9.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><line x1="9.5" y1="2.5" x2="2.5" y2="9.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  _attachTooltip(closeBtn, 'Close settings');
  // A 22px square like the row pin/undo buttons, in the panel's red
  closeBtn.style.cssText = 'display:flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:3px;flex-shrink:0;cursor:pointer;background:rgba(255,144,144,0.18);color:#ff9090;transition:background 0.12s,color 0.12s;';
  // The whole banner is the close control: hovering anywhere on it lights the
  // banner and the cross, and a press anywhere on it closes the modal
  function _closeHot(on) {
    closeBtn.style.background = on ? 'rgba(255,144,144,0.45)' : 'rgba(255,144,144,0.18)';
    closeBtn.style.color      = on ? '#ffffff' : '#ff9090';
    header.style.background   = on ? 'rgba(255,255,255,0.05)' : '';
  }
  header.addEventListener('mouseenter', function() { _closeHot(true); });
  header.addEventListener('mouseleave', function() { _closeHot(false); });
  header.addEventListener('click', function() { modal.remove(); });
  header.appendChild(logoWrap);
  header.appendChild(closeBtn);

  var content = document.createElement('div');
  var dualCol = vw > 520;
  content.style.cssText = dualCol
    ? 'flex:1;overflow-y:auto;display:flex;flex-direction:row;'
    : 'flex:1;overflow-y:auto;display:flex;flex-direction:column;';
  var rowsCol = document.createElement('div');
  rowsCol.style.cssText = dualCol ? 'flex:1;display:flex;flex-direction:column;' : 'flex-shrink:0;display:flex;flex-direction:column;';

  var colorSection = document.createElement('div');
  colorSection.style.cssText = dualCol
    ? 'padding:10px 12px 12px;width:50%;box-sizing:border-box;border-left:4px solid #080808;'
    : 'padding:10px 12px 12px;border-top:4px solid #080808;flex-shrink:0;';

  var colorLabel = document.createElement('div');
  colorLabel.textContent = 'Theme';
  colorLabel.style.cssText = 'color:#d4d4d4;font-size:14px;margin-bottom:10px;';
  colorSection.appendChild(colorLabel);

  // The default green first; red and orange are the property panel's --red / --amber tones
  var swatchColors = ['#38fbb2','#4a9eff','#ff9090','#f0a030','#c97ff0','#ff6eb4','#ffffff','#aaaaaa'];
  var swatchRow = document.createElement('div');
  swatchRow.style.cssText = 'display:flex;margin-bottom:4px;flex-wrap:wrap;'; // spacing via swatch margins (UXP ignores flex gap)
  swatchColors.forEach(function(col) {
    var sw = document.createElement('div');
    sw.style.cssText = 'width:22px;height:22px;background:'+col+';cursor:pointer;border:2px solid '+(col===_curveColor?'#fff':'transparent')+';flex-shrink:0;margin-right:6px;margin-bottom:6px;';
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
  colorSection.appendChild(swatchRow);

  var hexRow = document.createElement('div');
  hexRow.style.cssText = 'display:flex;align-items:center;';
  var hexLabel = document.createElement('span');
  hexLabel.textContent = 'Hex';
  hexLabel.style.cssText = 'color:#888;font-size:13px;';
  var hexInput = document.createElement('input');
  hexInput.type = 'text';
  hexInput.value = _curveColor.toUpperCase();
  hexInput.maxLength = 7;
  var hexTf = _mkTextField(13, true, 'hex');
  hexTf.wrap.style.width = '90px'; hexTf.wrap.style.marginLeft = '8px'; hexTf.wrap.style.flexShrink = '0';
  hexTf.wrap.replaceChild(hexInput, hexTf.input); // keep the input the rest of this code refers to
  hexInput.className = hexTf.input.className;
  var hexPreview = document.createElement('div');
  hexPreview.style.cssText = 'width:20px;height:20px;background:'+_curveColor+';flex-shrink:0;border:1px solid rgba(255,255,255,0.12);margin-left:8px;';
  hexInput.addEventListener('input', function() {
    var val = hexInput.value;
    val = val.toUpperCase().replace(/[^#0-9A-F]/g, '');
    if (val.charAt(0) !== '#') val = '#' + val;
    val = val.slice(0, 7);
    hexInput.value = val;
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
  hexRow.appendChild(hexLabel);
  hexRow.appendChild(hexTf.wrap);
  hexRow.appendChild(hexPreview);
  colorSection.appendChild(hexRow);

  // Check for updates row
  var updatesRow = document.createElement('div');
  updatesRow.id = '_updates-row';
  updatesRow.style.cssText = 'display:flex;align-items:center;padding:0 12px;height:36px;border-bottom:1px solid rgba(0,0,0,0.4);cursor:pointer;background:rgba(230,184,0,0.08);';
  var updatesLabel = document.createElement('span');
  updatesLabel.id = '_updates-label';
  updatesLabel.style.cssText = 'font-size:14px;flex:1;';
  updatesRow.appendChild(updatesLabel);
  _applyUpdateBtnState(updatesRow, updatesLabel);
  updatesRow.addEventListener('mouseenter', function() { updatesRow.style.background='rgba(230,184,0,0.15)'; });
  updatesRow.addEventListener('mouseleave', function() { updatesRow.style.background='rgba(230,184,0,0.08)'; });
  updatesRow.addEventListener('click', function() {
    if (_updateAvailable) {
      modal.remove();
      _openReleasesPage();
    } else {
      _checkForUpdates();
    }
  });
  rowsCol.appendChild(updatesRow);

  // Update notifications toggle
  var notifRow = document.createElement('div');
  notifRow.style.cssText = 'display:flex;align-items:center;padding:0 12px;height:36px;border-bottom:1px solid rgba(0,0,0,0.4);cursor:pointer;';
  var notifLabel = document.createElement('span');
  notifLabel.style.cssText = 'font-size:14px;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#d4d4d4;';
  notifLabel.textContent = 'Update Notifications';
  var notifCheck = document.createElement('span');
  notifCheck.style.cssText = 'display:flex;align-items:center;flex-shrink:0;margin-left:8px;';
  var _svgCheck = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><polyline points="1.5,6 4.5,9 10.5,3" stroke="#3ddc84" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var _svgCross = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><line x1="2" y1="2" x2="10" y2="10" stroke="#ff9090" stroke-width="1.8" stroke-linecap="round"/><line x1="10" y1="2" x2="2" y2="10" stroke="#ff9090" stroke-width="1.8" stroke-linecap="round"/></svg>';
  function _updateNotifCheck() {
    notifCheck.innerHTML = _updateNotifsOn ? _svgCheck : _svgCross;
    notifLabel.textContent = 'Update Notifications ' + (_updateNotifsOn ? 'On' : 'Off');
    notifRow.style.background = _updateNotifsOn ? 'rgba(61,220,132,0.08)' : 'rgba(255,144,144,0.08)';
  }
  var notifIcon = document.createElement('span');
  notifIcon.style.cssText = 'display:flex;align-items:center;flex-shrink:0;margin-right:8px;';
  notifIcon.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path fill="none" d="M8 2a4.5 4.5 0 014.5 4.5v3l1 1.5H2.5l1-1.5V6.5A4.5 4.5 0 018 2z" stroke="#b0b0b0" stroke-width="1.5" stroke-linejoin="round"/><path fill="none" d="M6 12.5a2 2 0 004 0" stroke="#b0b0b0" stroke-width="1.5" stroke-linecap="round"/></svg>';
  _updateNotifCheck();
  notifRow.appendChild(notifIcon);
  notifRow.appendChild(notifLabel);
  notifRow.appendChild(notifCheck);
  notifRow.addEventListener('mouseenter', function() { notifRow.style.background = _updateNotifsOn ? 'rgba(61,220,132,0.15)' : 'rgba(255,144,144,0.15)'; });
  notifRow.addEventListener('mouseleave', function() { notifRow.style.background = _updateNotifsOn ? 'rgba(61,220,132,0.08)' : 'rgba(255,144,144,0.08)'; });
  notifRow.addEventListener('click', function() {
    _updateNotifsOn = !_updateNotifsOn;
    localStorage.setItem(_UPDATE_NOTIF_KEY, _updateNotifsOn ? 'on' : 'off');
    _updateNotifCheck();
    _refreshUpdateNotification();
  });
  rowsCol.appendChild(notifRow);

  // Animations toggle
  var animRow = document.createElement('div');
  animRow.style.cssText = 'display:flex;align-items:center;padding:0 12px;height:36px;border-bottom:1px solid rgba(0,0,0,0.4);cursor:pointer;';
  var animLabel = document.createElement('span');
  animLabel.style.cssText = 'font-size:14px;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#d4d4d4;';
  var animCheck = document.createElement('span');
  animCheck.style.cssText = 'display:flex;align-items:center;flex-shrink:0;margin-left:8px;';
  function _updateAnimCheck() {
    animCheck.innerHTML = _animationsOn ? _svgCheck : _svgCross;
    animLabel.textContent = 'Animations ' + (_animationsOn ? 'On' : 'Off');
    animRow.style.background = _animationsOn ? 'rgba(61,220,132,0.08)' : 'rgba(255,144,144,0.08)';
  }
  var animIcon = document.createElement('span');
  animIcon.style.cssText = 'display:flex;align-items:center;flex-shrink:0;margin-right:8px;';
  animIcon.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path fill="none" d="M8 2l1.2 3L13 6l-2.5 2.5.6 3.5L8 10.5 4.9 12l.6-3.5L3 6l3.8-1z" stroke="#b0b0b0" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  _updateAnimCheck();
  animRow.appendChild(animIcon);
  animRow.appendChild(animLabel);
  animRow.appendChild(animCheck);
  animRow.addEventListener('mouseenter', function() { animRow.style.background = _animationsOn ? 'rgba(61,220,132,0.15)' : 'rgba(255,144,144,0.15)'; });
  animRow.addEventListener('mouseleave', function() { animRow.style.background = _animationsOn ? 'rgba(61,220,132,0.08)' : 'rgba(255,144,144,0.08)'; });
  animRow.addEventListener('click', function() {
    _animationsOn = !_animationsOn;
    localStorage.setItem(_ANIM_KEY, _animationsOn ? 'on' : 'off');
    _updateAnimCheck();
  });
  rowsCol.appendChild(animRow);

  // Graph visibility toggle row
  var graphRow = document.createElement('div');
  graphRow.style.cssText = 'display:flex;align-items:center;padding:0 12px;height:36px;border-bottom:1px solid rgba(0,0,0,0.4);cursor:pointer;';
  var graphLabel = document.createElement('span');
  graphLabel.style.cssText = 'font-size:14px;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#d4d4d4;';
  graphLabel.textContent = 'Graph';
  var graphCheck = document.createElement('span');
  graphCheck.style.cssText = 'display:flex;align-items:center;flex-shrink:0;margin-left:8px;';
  function _updateGraphCheck() {
    graphCheck.innerHTML = _graphVisible ? _svgCheck : _svgCross;
    graphLabel.textContent = 'Graph ' + (_graphVisible ? 'On' : 'Off');
    graphRow.style.background = _graphVisible ? 'rgba(61,220,132,0.08)' : 'rgba(255,144,144,0.08)';
  }
  var graphIcon = document.createElement('span');
  graphIcon.style.cssText = 'display:flex;align-items:center;flex-shrink:0;margin-right:8px;';
  graphIcon.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2.5 13.5C6 13.5 10 2.5 13.5 2.5" fill="none" stroke="#b0b0b0" stroke-width="1.4" stroke-linecap="round"/><circle cx="2.5" cy="13.5" r="1.4" fill="#b0b0b0"/><circle cx="13.5" cy="2.5" r="1.4" fill="#b0b0b0"/></svg>';
  _updateGraphCheck();
  graphRow.appendChild(graphIcon);
  graphRow.appendChild(graphLabel);
  graphRow.appendChild(graphCheck);
  graphRow.addEventListener('mouseenter', function() { graphRow.style.background = _graphVisible ? 'rgba(61,220,132,0.15)' : 'rgba(255,144,144,0.15)'; });
  graphRow.addEventListener('mouseleave', function() { graphRow.style.background = _graphVisible ? 'rgba(61,220,132,0.08)' : 'rgba(255,144,144,0.08)'; });
  graphRow.addEventListener('click', function() {
    _setGraphVisible(!_graphVisible);
    _updateGraphCheck();
  });
  rowsCol.appendChild(graphRow);

  // Timeline visibility toggle row (the keyframe strip along the bottom of the panel)
  var tlRow = document.createElement('div');
  tlRow.style.cssText = 'display:flex;align-items:center;padding:0 12px;height:36px;border-bottom:1px solid rgba(0,0,0,0.4);cursor:pointer;';
  var tlLabel = document.createElement('span');
  tlLabel.style.cssText = 'font-size:14px;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#d4d4d4;';
  var tlCheck = document.createElement('span');
  tlCheck.style.cssText = 'display:flex;align-items:center;flex-shrink:0;margin-left:8px;';
  function _updateTlCheck() {
    tlCheck.innerHTML = _tlVisible ? _svgCheck : _svgCross;
    tlLabel.textContent = 'Timeline ' + (_tlVisible ? 'On' : 'Off');
    tlRow.style.background = _tlVisible ? 'rgba(61,220,132,0.08)' : 'rgba(255,144,144,0.08)';
  }
  var tlIcon = document.createElement('span');
  tlIcon.style.cssText = 'display:flex;align-items:center;flex-shrink:0;margin-right:8px;';
  tlIcon.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><line x1="1.5" y1="8" x2="14.5" y2="8" stroke="#b0b0b0" stroke-width="1.4"/><polygon points="5,5.2 7.8,8 5,10.8 2.2,8" fill="#b0b0b0"/><polygon points="11,5.2 13.8,8 11,10.8 8.2,8" fill="#b0b0b0"/></svg>';
  _updateTlCheck();
  tlRow.appendChild(tlIcon);
  tlRow.appendChild(tlLabel);
  tlRow.appendChild(tlCheck);
  tlRow.addEventListener('mouseenter', function() { tlRow.style.background = _tlVisible ? 'rgba(61,220,132,0.15)' : 'rgba(255,144,144,0.15)'; });
  tlRow.addEventListener('mouseleave', function() { tlRow.style.background = _tlVisible ? 'rgba(61,220,132,0.08)' : 'rgba(255,144,144,0.08)'; });
  tlRow.addEventListener('click', function() {
    _setTimelineVisible(!_tlVisible);
    _updateTlCheck();
  });
  rowsCol.appendChild(tlRow);

  // Grid size row
  var gridRow = document.createElement('div');
  gridRow.style.cssText = 'display:flex;align-items:center;padding:0 0 0 12px;height:36px;border-bottom:1px solid rgba(0,0,0,0.4);';
  var gridIcon = document.createElement('span');
  gridIcon.style.cssText = 'display:flex;align-items:center;flex-shrink:0;margin-right:8px;';
  gridIcon.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="12" stroke="#b0b0b0" stroke-width="1.4" rx="1"/><line x1="6" y1="2" x2="6" y2="14" stroke="#b0b0b0" stroke-width="1"/><line x1="10" y1="2" x2="10" y2="14" stroke="#b0b0b0" stroke-width="1"/><line x1="2" y1="6" x2="14" y2="6" stroke="#b0b0b0" stroke-width="1"/><line x1="2" y1="10" x2="14" y2="10" stroke="#b0b0b0" stroke-width="1"/></svg>';
  var gridLabel = document.createElement('span');
  gridLabel.style.cssText = 'font-size:14px;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#d4d4d4;';
  gridLabel.textContent = 'Grid Spacing';
  var gridBtns = document.createElement('div');
  gridBtns.style.cssText = 'display:flex;gap:0;flex-shrink:0;align-self:stretch;';
  var gridSizes = [4, 8, 16];
  var gridBtnEls = [];
  gridSizes.forEach(function(size) {
    var gb = document.createElement('div');
    gb.textContent = size + 'x' + size;
    var isActive = _gridSize === size;
    gb.style.cssText = 'font-size:12px;padding:0 8px;cursor:pointer;display:flex;align-items:center;justify-content:center;min-width:48px;'
      + 'color:' + (isActive ? '#3ddc84' : '#666') + ';'
      + 'background:' + (isActive ? 'rgba(61,220,132,0.08)' : 'transparent') + ';';
    gb.addEventListener('mouseenter', function() { gb.style.background = _gridSize === size ? 'rgba(61,220,132,0.15)' : 'rgba(255,255,255,0.05)'; });
    gb.addEventListener('mouseleave', function() { gb.style.background = _gridSize === size ? 'rgba(61,220,132,0.08)' : 'transparent'; });
    gb.addEventListener('click', function() {
      _gridSize = size;
      localStorage.setItem(_GRID_KEY, size);
      gridBtnEls.forEach(function(el, idx) {
        var a = gridSizes[idx] === size;
        el.style.color = a ? '#3ddc84' : '#666';
        el.style.background = a ? 'rgba(61,220,132,0.08)' : 'transparent';
      });
      if (_svgW > 0 && _svgH > 0) updateStaticSVG(_svgW, _svgH);
    });
    gridBtnEls.push(gb);
    gridBtns.appendChild(gb);
  });
  gridRow.appendChild(gridIcon);
  gridRow.appendChild(gridLabel);
  gridRow.appendChild(gridBtns);
  rowsCol.appendChild(gridRow);

  // Keyframe spacing row (how far apart the baked keyframes are)
  var densRow = document.createElement('div');
  densRow.style.cssText = 'display:flex;align-items:center;padding:0 0 0 12px;height:36px;border-bottom:1px solid rgba(0,0,0,0.4);';
  _attachTooltip(densRow, 'How far apart the baked keyframes are. Every frame follows the curve exactly; 2 or 4 frames writes fewer keyframes, with straight lines between them');
  var densIcon = document.createElement('span');
  densIcon.style.cssText = 'display:flex;align-items:center;flex-shrink:0;margin-right:8px;';
  densIcon.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><line x1="1" y1="8" x2="15" y2="8" stroke="#b0b0b0" stroke-width="1.2"/><polygon points="3.5,5.5 6,8 3.5,10.5 1,8" fill="#b0b0b0"/><polygon points="8,5.5 10.5,8 8,10.5 5.5,8" fill="#b0b0b0"/><polygon points="12.5,5.5 15,8 12.5,10.5 10,8" fill="#b0b0b0"/></svg>';
  var densLabel = document.createElement('span');
  densLabel.style.cssText = 'font-size:14px;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#d4d4d4;';
  densLabel.textContent = 'Keyframe Spacing';
  var densBtns = document.createElement('div');
  densBtns.style.cssText = 'display:flex;gap:0;flex-shrink:0;align-self:stretch;';
  var densSteps = [1, 2, 4];
  var densBtnEls = [];
  densSteps.forEach(function(step) {
    var db = document.createElement('div');
    db.textContent = step + ' fr';
    var isActive = _bakeDensity === step;
    db.style.cssText = 'font-size:12px;padding:0 8px;cursor:pointer;display:flex;align-items:center;justify-content:center;min-width:48px;'
      + 'color:' + (isActive ? '#3ddc84' : '#666') + ';'
      + 'background:' + (isActive ? 'rgba(61,220,132,0.08)' : 'transparent') + ';';
    db.addEventListener('mouseenter', function() { db.style.background = _bakeDensity === step ? 'rgba(61,220,132,0.15)' : 'rgba(255,255,255,0.05)'; });
    db.addEventListener('mouseleave', function() { db.style.background = _bakeDensity === step ? 'rgba(61,220,132,0.08)' : 'transparent'; });
    db.addEventListener('click', function() {
      _bakeDensity = step;
      localStorage.setItem(_DENSITY_KEY, step);
      densBtnEls.forEach(function(el, idx) {
        var a = densSteps[idx] === step;
        el.style.color = a ? '#3ddc84' : '#666';
        el.style.background = a ? 'rgba(61,220,132,0.08)' : 'transparent';
      });
    });
    densBtnEls.push(db);
    densBtns.appendChild(db);
  });
  densRow.appendChild(densIcon);
  densRow.appendChild(densLabel);
  densRow.appendChild(densBtns);
  rowsCol.appendChild(densRow);

  // Preset layout row
  var layoutRow = document.createElement('div');
  layoutRow.style.cssText = 'display:flex;align-items:center;padding:0 0 0 12px;height:36px;border-bottom:1px solid rgba(0,0,0,0.4);';
  var layoutIcon = document.createElement('span');
  layoutIcon.style.cssText = 'display:flex;align-items:center;flex-shrink:0;margin-right:8px;';
  layoutIcon.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><line x1="2" y1="4" x2="14" y2="4" stroke="#b0b0b0" stroke-width="1.4" stroke-linecap="round"/><line x1="2" y1="8" x2="14" y2="8" stroke="#b0b0b0" stroke-width="1.4" stroke-linecap="round"/><line x1="2" y1="12" x2="14" y2="12" stroke="#b0b0b0" stroke-width="1.4" stroke-linecap="round"/></svg>';
  var layoutLabel = document.createElement('span');
  layoutLabel.style.cssText = 'font-size:14px;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#d4d4d4;';
  layoutLabel.textContent = 'Presets View';
  var layoutBtns = document.createElement('div');
  layoutBtns.style.cssText = 'display:flex;gap:0;flex-shrink:0;align-self:stretch;';
  var layoutOptions = ['list', 'grid'];
  var layoutBtnEls = [];
  layoutOptions.forEach(function(opt) {
    var lb = document.createElement('div');
    lb.textContent = opt.charAt(0).toUpperCase() + opt.slice(1);
    var isActive = _presetLayout === opt;
    lb.style.cssText = 'font-size:12px;padding:0 8px;cursor:pointer;display:flex;align-items:center;justify-content:center;min-width:48px;'
      + 'color:' + (isActive ? '#3ddc84' : '#666') + ';'
      + 'background:' + (isActive ? 'rgba(61,220,132,0.08)' : 'transparent') + ';';
    lb.addEventListener('mouseenter', function() { lb.style.background = _presetLayout === opt ? 'rgba(61,220,132,0.15)' : 'rgba(255,255,255,0.05)'; });
    lb.addEventListener('mouseleave', function() { lb.style.background = _presetLayout === opt ? 'rgba(61,220,132,0.08)' : 'transparent'; });
    lb.addEventListener('click', function() {
      _presetLayout = opt;
      localStorage.setItem(_LAYOUT_KEY, opt);
      layoutBtnEls.forEach(function(el, idx) {
        var a = layoutOptions[idx] === opt;
        el.style.color = a ? '#3ddc84' : '#666';
        el.style.background = a ? 'rgba(61,220,132,0.08)' : 'transparent';
      });
      _applyPresetLayout(true);
    });
    layoutBtnEls.push(lb);
    layoutBtns.appendChild(lb);
  });
  layoutRow.appendChild(layoutIcon);
  layoutRow.appendChild(layoutLabel);
  layoutRow.appendChild(layoutBtns);
  rowsCol.appendChild(layoutRow);

  content.appendChild(rowsCol);
  content.appendChild(colorSection);

  // Footer
  var footer = document.createElement('div');
  footer.style.cssText = 'border-top:4px solid #080808;flex-shrink:0;';
  var footerRow = document.createElement('div');
  footerRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:10px 12px;';

  var footerLeft = document.createElement('div');
  var madeBy = document.createElement('div');
  madeBy.textContent = 'made by faye  \u00B7  v' + CURRENT_VERSION + '  \u00B7  ZXP';
  madeBy.style.cssText = 'color:#888;font-size:12px;margin-bottom:4px;';
  var ghLink = document.createElement('div');
  ghLink.textContent = 'github.com/fayewave/OpenCurve';
  ghLink.style.cssText = 'color:#555;font-size:12px;cursor:pointer;';
  ghLink.addEventListener('mouseenter', function() { ghLink.style.color = '#4a9eff'; });
  ghLink.addEventListener('mouseleave', function() { ghLink.style.color = '#555'; });
  ghLink.addEventListener('click', function() {
    _openReleasesPage();
  });
  footerLeft.appendChild(madeBy);
  footerLeft.appendChild(ghLink);

  var resetRow = document.createElement('div');
  resetRow.style.cssText = 'display:flex;align-items:center;padding:5px 10px;cursor:pointer;color:#ff9090;font-size:13px;background:rgba(255,144,144,0.08);flex-shrink:0;';
  var resetLabel = document.createElement('span');
  resetLabel.textContent = 'Reset All Settings';
  _attachTooltip(resetRow, 'Restore defaults and remove all presets');
  resetRow.appendChild(resetLabel);
  resetRow.addEventListener('mouseenter', function() { resetRow.style.background='rgba(255,144,144,0.15)'; });
  resetRow.addEventListener('mouseleave', function() { resetRow.style.background='rgba(255,144,144,0.08)'; });
  resetRow.addEventListener('click', function() {
    modal.remove();
    _confirmReset();
  });

  // Report an Issue: opens the GitHub issues page in the browser
  var issueRow = document.createElement('div');
  issueRow.style.cssText = 'display:flex;align-items:center;padding:5px 10px;margin-right:8px;cursor:pointer;color:#4a9eff;font-size:13px;background:rgba(74,158,255,0.08);flex-shrink:0;';
  var issueLabel = document.createElement('span');
  issueLabel.textContent = 'Report an Issue';
  _attachTooltip(issueRow, 'Open the OpenCurve issues page on GitHub');
  issueRow.appendChild(issueLabel);
  issueRow.addEventListener('mouseenter', function() { issueRow.style.background='rgba(74,158,255,0.15)'; });
  issueRow.addEventListener('mouseleave', function() { issueRow.style.background='rgba(74,158,255,0.08)'; });
  issueRow.addEventListener('click', function() {
    var url = 'https://github.com/fayewave/OpenCurve/issues';
    if (_bridge && _bridge.openExternal) _bridge.openExternal(url); else window.open(url);
  });

  var footerRight = document.createElement('div');
  footerRight.style.cssText = 'display:flex;align-items:center;flex-shrink:0;';
  footerRight.appendChild(issueRow);
  footerRight.appendChild(resetRow);
  footerRow.appendChild(footerLeft);
  footerRow.appendChild(footerRight);
  footer.appendChild(footerRow);

  // Footer layout: the buttons sit to the right of the credit lines while
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
  modal.appendChild(content);
  modal.appendChild(footer);
  document.body.appendChild(modal);
  _layoutFooter(vw);

  var _settingsRO = new ResizeObserver(function() {
    var nvw = document.documentElement.clientWidth  || document.body.clientWidth;
    var nvh = document.documentElement.clientHeight || document.body.clientHeight;
    modal.style.width  = nvw + 'px';
    modal.style.height = nvh + 'px';
    _layoutFooter(nvw);
    var nowDual = nvw > 520;
    if (nowDual !== dualCol) {
      dualCol = nowDual;
      content.style.flexDirection = nowDual ? 'row' : 'column';
      colorSection.style.cssText = nowDual
        ? 'padding:10px 12px 12px;width:50%;box-sizing:border-box;border-left:4px solid #080808;'
        : 'padding:10px 12px 12px;border-top:4px solid #080808;flex-shrink:0;';
      rowsCol.style.cssText = nowDual
        ? 'flex:1;display:flex;flex-direction:column;'
        : 'flex-shrink:0;display:flex;flex-direction:column;';
    }
  });
  _settingsRO.observe(document.body);

  var _origRemove = modal.remove.bind(modal);
  modal.remove = function() { _settingsRO.disconnect(); _origRemove(); };
}

// Apply saved curve colour on load
document.addEventListener('DOMContentLoaded', function() {
  _applyCurveColor(_curveColor);
});

// ─── Public API ──────────────────────────────────────────────────────────
return {
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
  showCopyToast: _showCopyToast,
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
