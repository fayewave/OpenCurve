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
  // Anchor: same empty circle as the two end points (#sg-ep0 / #sg-ep3)
  var a = document.createElementNS(NS, 'g');
  var inner = _mkCircle(4, '#1e1e1e', _curveColor || '#4a9eff', 2);
  a.appendChild(inner);
  return { li: line(), lo: line(), hi: handle(), ho: handle(), a: a, inner: inner };
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
  // Add Point only makes sense on the bezier view
  // Dim the icon itself (its strokes use currentColor) and pin the background so
  // hover can't light it back up; opacity alone was not reliable in UXP
  var add = document.getElementById('add-point');
  if (add) {
    add.style.color      = _peakMode ? 'rgba(212,212,212,0.28)' : '';
    add.style.background = _peakMode ? 'rgba(255,255,255,0.03)' : '';
    add.style.opacity    = _peakMode ? '0.5' : '';
    add.style.cursor     = _peakMode ? 'default' : '';
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
    if (_peakMode) {
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

  function _setSnapBg(snap) {
    var bg = document.getElementById('sg-range-bg');
    if (bg) {
      bg.setAttribute('fill', snap ? '#4a9eff' : '#1e1e1e');
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
  'playing':      { cls:'status-idle',  text: 'Keyframe detection paused while playing' },
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

function _jumpToParam(p) {
  if (!p || typeof p.jumpSec !== 'number') return;
  if (_bridge && _bridge.onJump) _bridge.onJump(p.jumpSec);
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
  el.addEventListener('pointerleave', up);
  el.addEventListener('pointercancel', up);
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
        propDiamond.innerHTML = '<svg width="8" height="8" viewBox="0 0 8 8" fill="none"><polygon points="4,0 8,4 4,8 0,4" fill="currentColor"/></svg>';
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
        btn.addEventListener('click', function() {
          var s2   = getState();
          // A baked (green) row stays green: clicking does nothing unless the
          // playhead is over another, unbaked pair of this property, in which
          // case it selects normally (blue) so that pair can be baked too.
          var isBakedRow = (s2.bakedParamKeys || []).indexOf(p.key) >= 0;
          var isValidRow = (s2.validParamKeys || []).indexOf(p.key) >= 0;
          if (isBakedRow && !isValidRow) return;
          var keys = (s2.selectedParamKeys || []).slice();
          var idx  = keys.indexOf(p.key);
          if (idx >= 0) keys.splice(idx, 1);
          else          keys.push(p.key);
          setState({ selectedParamKeys: keys });
        });
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
      // Selected but the playhead isn't between its keyframes yet: orange until it is
      btn.classList.toggle('pending', isSel && validKeys.indexOf(k) < 0);
      // Playhead is already between this property's keyframes: pin shows blue even when unselected
      btn.classList.toggle('ready', validKeys.indexOf(k) >= 0);
      btn.classList.toggle('baked',  bakedKeys.indexOf(k) >= 0 && selKeys.indexOf(k) < 0);
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
    // Clip name lives in its own span so a long name truncates on its own
    // instead of pushing the count off the end of the strip
    var clipEl   = document.getElementById('status-clip');
    var showClip = !!clipEl && !!cfg.clip && !!s.clipName;
    if (clipEl) {
      clipEl.textContent   = showClip ? s.clipName : '';
      clipEl.style.display = showClip ? 'block' : 'none'; // inline: UXP ignores class-driven display
    }
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
}

// ─── Panel init ───────────────────────────────────────────────────────────
function initPanel() {
  console.log('[OC] initPanel called');

  var svg = document.getElementById('bezier-svg');
  if (svg) {
    initGraphEditor(svg);
  }

  // A-curve (peak) mode toggle
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
        ? 'Add Point is unavailable in A-curve mode'
        : 'Add a point to the curve. Drag it and its handles, right-click it to delete. Alt-drag a handle to keep both lengths, Ctrl-drag to move it on its own (makes a corner)';
    });
    addPtBtn.addEventListener('click', function() { if (!_peakMode) _addPoint(); });
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
  document.addEventListener('pointerdown', function(e) { if (!_isField(e.target)) setTimeout(function() { _focusSink('pointerdown'); }, 0); }, true);
  document.addEventListener('click',       function(e) { if (!_isField(e.target)) setTimeout(function() { _focusSink('click'); }, 0); }, true);
  if (keySink) {
    // Nothing should ever be typed into it
    keySink.addEventListener('input', function() { keySink.value = ''; });
  }
  function _enterGo(e) {
    var isEnter = e.key === 'Enter' || e.keyCode === 13 || e.which === 13 || e.code === 'Enter' || e.code === 'NumpadEnter';
    if (!isEnter || e.repeat || e._ocEnter) return;
    e._ocEnter = true; // the sink's own listener and the document one both see it
    if (_isField(e.target)) return;
    if (document.getElementById('settings-modal') || document.getElementById('oc-confirm')) return;
    var go = document.getElementById('go-btn');
    if (!go || go.classList.contains('btn-disabled')) { console.log('[OC] Enter: Go is disabled'); return; }
    e.preventDefault();
    console.log('[OC] Enter: pressing Go');
    go.click();
  }
  if (keySink) {
    keySink.addEventListener('keydown', _enterGo);
  }
  document.addEventListener('keydown', _enterGo, true);

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
  });

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
  var _icSettingsCtx = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="1.8" fill="none" stroke="currentColor" stroke-width="1.3"/><line x1="13" y1="8" x2="15" y2="8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="3" y1="8" x2="1" y2="8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="8" y1="13" x2="8" y2="15" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="8" y1="3" x2="8" y2="1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="11.54" y1="11.54" x2="12.95" y2="12.95" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="4.46" y1="11.54" x2="3.05" y2="12.95" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="4.46" y1="4.46" x2="3.05" y2="3.05" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="11.54" y1="4.46" x2="12.95" y2="3.05" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
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
  function _thumbPathD(c) {
    var W = 28, H = 28, pad = 3, gW = W - 2*pad, gH = H - 2*pad;
    function tx(n) { return pad + n * gW; }
    function ty(n) { return pad + (1 - n) * gH; }
    if (_peakMode) return _peakBellPath(c, 40, tx, ty); // A-curve mode: thumbnails show the bell too
    return _curvePathTx(c, tx, ty);
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
        if (_presetLayout === 'grid') {
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
      var isGrid = _presetLayout === 'grid';
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
      if (_presetLayout === 'grid') _applyPresetLayout(true);
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
    overlay.addEventListener('click', close);

    var title = document.createElement('div');
    title.textContent = 'Paste Preset';
    title.style.cssText = 'color:#e4e4e4;font-size:14px;font-weight:600;margin-bottom:8px;';
    box.appendChild(title);

    var desc = document.createElement('div');
    desc.textContent = 'Paste a cubic-bezier() or opencurve() value:';
    desc.style.cssText = 'color:#888;font-size:13px;margin-bottom:10px;';
    box.appendChild(desc);

    var input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'cubic-bezier(0.42, 0, 0.58, 1)';
    input.style.cssText = 'width:100%;background:#1c1c1c;border:1px solid rgba(255,255,255,0.12);color:#e4e4e4;font-size:13px;padding:7px 10px;outline:none;margin-bottom:6px;box-sizing:border-box;font-family:inherit;';
    box.appendChild(input);

    var err = document.createElement('div');
    err.style.cssText = 'color:#f06060;font-size:12px;min-height:16px;margin-bottom:10px;';
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
  function _showMiniCtxMenu(e, showPaste, showLayout, showGrid, pointIdx) {
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

    var _icSettings = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="1.8" fill="none" stroke="currentColor" stroke-width="1.3"/><line x1="13" y1="8" x2="15" y2="8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="3" y1="8" x2="1" y2="8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="8" y1="13" x2="8" y2="15" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="8" y1="3" x2="8" y2="1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="11.54" y1="11.54" x2="12.95" y2="12.95" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="4.46" y1="11.54" x2="3.05" y2="12.95" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="4.46" y1="4.46" x2="3.05" y2="3.05" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="11.54" y1="4.46" x2="12.95" y2="3.05" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
    var _icGrid = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><rect x="1.5" y="1.5" width="4.5" height="4.5" rx="0.5" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="8" y="1.5" width="4.5" height="4.5" rx="0.5" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="1.5" y="8" width="4.5" height="4.5" rx="0.5" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="8" y="8" width="4.5" height="4.5" rx="0.5" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
    var _icList = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><line x1="1.5" y1="3.5" x2="12.5" y2="3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="1.5" y1="7" x2="12.5" y2="7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="1.5" y1="10.5" x2="12.5" y2="10.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
    var _icPaste = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><rect x="3" y="2" width="8" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><path fill="none" d="M5.5 2V1.5a1 1 0 011-1h1a1 1 0 011 1V2" stroke="currentColor" stroke-width="1.3"/><line x1="5.5" y1="6" x2="8.5" y2="6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="5.5" y1="8.5" x2="8.5" y2="8.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
    var _icGraphOn = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M1.5 12.5C5 12.5 9 1.5 12.5 1.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="1.5" cy="12.5" r="1.3" fill="currentColor"/><circle cx="12.5" cy="1.5" r="1.3" fill="currentColor"/></svg>';
    var _icGraphOff = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M1.5 12.5C5 12.5 9 1.5 12.5 1.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" opacity="0.45"/><line x1="2" y1="2" x2="12" y2="12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

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
    _miniItem('Open Settings', _icSettings, function() { _showSettingsModal(); });

    if (showLayout !== false) {
      _miniItem(
        _presetLayout === 'list' ? 'Grid View' : 'List View',
        _presetLayout === 'list' ? _icGrid : _icList,
        function() {
          _presetLayout = _presetLayout === 'list' ? 'grid' : 'list';
          localStorage.setItem(_LAYOUT_KEY, _presetLayout);
          _applyPresetLayout(true);
        }
      );
    }

    _miniItem(
      _graphVisible ? 'Disable Graph' : 'Enable Graph',
      _graphVisible ? _icGraphOff : _icGraphOn,
      function() {
        _graphVisible = !_graphVisible;
        localStorage.setItem(_GRAPH_KEY, _graphVisible ? 'on' : 'off');
        _applyGraphVisibility();
      }
    );

    if (showPaste) {
      _miniItem('Paste Preset', _icPaste, function() { _pasteCoordinates(); });
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

    function _buildNewPresetBtn() {
      var newBtn = document.createElement('div');
      newBtn.id = 'new-preset-btn';
      newBtn.className = 'preset-btn new-preset-btn';
      _attachTooltip(newBtn, 'Save the current curve as a preset');

      var thumb = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      thumb.setAttribute('class', 'preset-thumb');
      thumb.setAttribute('width', '28'); thumb.setAttribute('height', '28'); thumb.setAttribute('viewBox', '0 0 28 28');
      var l1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      l1.setAttribute('x1', '14'); l1.setAttribute('y1', '7');
      l1.setAttribute('x2', '14'); l1.setAttribute('y2', '21');
      l1.setAttribute('stroke', 'currentColor'); l1.setAttribute('stroke-width', '2'); l1.setAttribute('stroke-linecap', 'round');
      var l2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      l2.setAttribute('x1', '7');  l2.setAttribute('y1', '14');
      l2.setAttribute('x2', '21'); l2.setAttribute('y2', '14');
      l2.setAttribute('stroke', 'currentColor'); l2.setAttribute('stroke-width', '2'); l2.setAttribute('stroke-linecap', 'round');
      thumb.appendChild(l1); thumb.appendChild(l2);
      newBtn.appendChild(thumb);

      var nameSpan = document.createElement('span');
      nameSpan.className = 'preset-name';
      nameSpan.textContent = 'New Preset';
      newBtn.appendChild(nameSpan);

      newBtn.addEventListener('click', function() {
        var c = getState().curve;
        var preset = {
          id: 'c' + Date.now(),
          name: 'Custom ' + (_presetList.filter(function(p){ return !p.builtIn; }).length + 1),
          curve: _cloneCurve(c),
        };
        _presetList.push(preset);
        _savePresetList(_presetList);
        var btn = _buildPresetBtn(preset);
        list.insertBefore(btn, newBtn);
        _applyPresetLayout(true);
        var ns = btn.querySelector('.preset-name');
        if (ns) ns.dispatchEvent(new Event('dblclick'));
      });

      return newBtn;
    }

    list.appendChild(_buildNewPresetBtn());
  }());

  // Resize handle
  var resizeHandle = document.getElementById('resize-handle');
  var rightCol     = document.getElementById('right-col');
  if (resizeHandle && rightCol) {
    var _RESIZE_KEY = 'opencurve-sidebar-width';
    var _savedW = parseInt(localStorage.getItem(_RESIZE_KEY), 10);
    if (_savedW && _savedW >= 120 && _savedW <= 320) rightCol.style.width = _savedW + 'px';

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
      var newW = Math.max(120, Math.min(320, _rw + (_rx - e.clientX)));
      rightCol.style.width = newW + 'px';
    });
    function _endResize() {
      if (_resizing) localStorage.setItem(_RESIZE_KEY, rightCol.offsetWidth);
      _resizing = false;
    }
    resizeHandle.addEventListener('pointerup',     _endResize);
    resizeHandle.addEventListener('pointercancel', _endResize);
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
var _curveColor         = localStorage.getItem(_CURVE_COLOR_KEY) || '#4a9eff';
var _updateAvailable    = false;
var _latestVersion      = null;
var _updateDismissed    = false;
var _UPDATE_NOTIF_KEY   = 'opencurve-update-notif';
var _updateNotifsOn     = localStorage.getItem(_UPDATE_NOTIF_KEY) !== 'off';
var _ANIM_KEY           = 'opencurve-animations';
var _animationsOn       = localStorage.getItem(_ANIM_KEY) !== 'off';
var _SCAN_PLAYBACK_KEY  = 'opencurve-scan-during-playback';
// Defaults to On — only off when the user has explicitly turned it off.
var _scanDuringPlayback = localStorage.getItem(_SCAN_PLAYBACK_KEY) !== 'off';
var _GRID_KEY           = 'opencurve-grid-size';
var _gridSize           = parseInt(localStorage.getItem(_GRID_KEY), 10) || 8;
var _LAYOUT_KEY         = 'opencurve-preset-layout';
var _presetLayout       = localStorage.getItem(_LAYOUT_KEY) || 'list';
var _GRAPH_KEY          = 'opencurve-graph-visible';
// Defaults to On — only hidden when the user has explicitly disabled the graph.
var _graphVisible       = localStorage.getItem(_GRAPH_KEY) !== 'off';
var _DENSITY_KEY        = 'opencurve-bake-density';
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
// full panel width and the status strip moves above the Go button so clip
// detection stays visible. Everything is done with inline styles because UXP
// does not relayout on class changes.
function _applyGraphVisibility() {
  var leftCol  = document.querySelector('.left-col');
  var handle   = document.getElementById('resize-handle');
  var rightCol = document.getElementById('right-col');
  var strip    = document.getElementById('status-strip');
  var goBtn    = document.getElementById('go-btn');
  if (!leftCol || !rightCol) return;
  // The Go control is the button itself (UXP) or the go-row wrapper holding Go + Undo (CEP)
  var goEl = (goBtn && goBtn.parentNode && goBtn.parentNode.classList && goBtn.parentNode.classList.contains('go-row')) ? goBtn.parentNode : goBtn;
  var row  = document.getElementById('_bottom-row');
  if (_graphVisible) {
    leftCol.style.display = '';
    if (handle) handle.style.display = '';
    var savedW = parseInt(localStorage.getItem('opencurve-sidebar-width'), 10);
    rightCol.style.width    = (savedW && savedW >= 120 && savedW <= 320) ? savedW + 'px' : '';
    rightCol.style.maxWidth = '';
    rightCol.style.flex     = '';
    // Put the status strip back under the graph and Go back at the bottom of the right column
    if (strip) { strip.style.flex = ''; strip.style.minWidth = ''; leftCol.appendChild(strip); }
    if (goEl)  { rightCol.appendChild(goEl); }
    if (goBtn) { goBtn.style.width = ''; goBtn.style.flex = ''; goBtn.style.borderLeft = ''; }
    if (goEl && goEl !== goBtn) { goEl.style.flexShrink = ''; }
    if (row && row.parentNode) row.parentNode.removeChild(row);
  } else {
    leftCol.style.display = 'none';
    if (handle) handle.style.display = 'none';
    rightCol.style.width    = '100%';
    rightCol.style.maxWidth = 'none';
    rightCol.style.flex     = '1 1 auto';
    // Status strip and Go share one bottom row: strip takes the width, Go is a narrow button on the right
    if (!row && strip && goEl) {
      row = document.createElement('div');
      row.id = '_bottom-row';
      row.style.cssText = 'display:flex;flex-direction:row;align-items:stretch;flex-shrink:0;';
      rightCol.appendChild(row);
      row.appendChild(strip);
      row.appendChild(goEl);
      strip.style.flex     = '1 1 auto';
      strip.style.minWidth = '0';
      goBtn.style.width      = '112px';
      goBtn.style.flex       = '0 0 112px';
      goBtn.style.borderLeft = '1px solid rgba(255,255,255,0.08)';
      if (goEl !== goBtn) goEl.style.flexShrink = '0';
    }
  }
  _fitGoForUndo();
  _applyPresetLayout(true);
}

// The Undo button floats over the right end of Go. In the hidden-graph layout
// Go is only 112px wide, so nudge its label left while the button is showing.
// Inline style because UXP doesn't relayout on class changes.
function _fitGoForUndo() {
  var goBtn = document.getElementById('go-btn');
  var undo  = document.getElementById('undo-btn');
  if (!goBtn) return;
  var shown  = !!undo && undo.style.display !== 'none' && !undo.classList.contains('btn-hidden');
  var narrow = !!document.getElementById('_bottom-row');
  goBtn.style.paddingRight = (shown && narrow) ? '28px' : '';
}

function _applyPresetLayout(force) {
  var list = document.getElementById('all-presets-list');
  if (!list) return;
  var isGrid = _presetLayout === 'grid';
  var w = list.offsetWidth || 180;
  var cols = isGrid ? (w >= 220 ? 3 : 2) : 1;
  var btnCount = list.querySelectorAll('.preset-btn').length;
  var cacheKey = (isGrid ? 'g' : 'l') + cols + '_' + btnCount;
  if (!force && _applyPresetLayout._lastKey === cacheKey) return;
  _applyPresetLayout._lastKey = cacheKey;
  var itemW = isGrid ? (100/cols).toFixed(3) + '%' : '100%';
  var thumbSz = isGrid ? (cols >= 3 ? 30 : 32) : 28;

  if (isGrid) {
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

  if (isGrid) {
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
function _updateGridCols() {
  if (_presetLayout !== 'grid') return;
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
  var ep0 = document.getElementById('sg-ep0');
  if (ep0) ep0.setAttribute('stroke', color);
  var ep3 = document.getElementById('sg-ep3');
  if (ep3) ep3.setAttribute('stroke', color);
  for (var pi = 0; pi < _ptEls.length; pi++) _ptEls[pi].inner.setAttribute('stroke', color);
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
  delBtn.addEventListener('mouseenter', function() { delBtn.style.background = 'rgba(240,96,96,0.25)'; });
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
    localStorage.removeItem(_SCAN_PLAYBACK_KEY);
    localStorage.removeItem(_GRAPH_KEY);
    localStorage.removeItem(_PEAK_KEY);
    localStorage.removeItem(_DENSITY_KEY);
    _bakeDensity        = 1;
    _applyCurveColor('#4a9eff');
    _animationsOn       = true;
    _updateNotifsOn     = true;
    _scanDuringPlayback = true;
    _graphVisible       = true;
    _peakMode           = false;
    setState({ curve: { p1x: 0.625, p1y: 0.000, p2x: 0.375, p2y: 1.000 } });
    _showCopyToast('Reset all settings');
    try { location.reload(); } catch(e) {}
  });
}

function _showSettingsModal() {
  var modal = document.createElement('div');
  modal.id = 'settings-modal';
  var vw = document.documentElement.clientWidth  || document.body.clientWidth;
  var vh = document.documentElement.clientHeight || document.body.clientHeight;
  modal.style.cssText = 'position:fixed;top:0;left:0;width:'+vw+'px;height:'+vh+'px;background:#1c1c1c;z-index:9998;display:flex;flex-direction:column;font-family:system-ui,sans-serif;';

  var header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;padding:10px 8px 10px 12px;border-bottom:1px solid rgba(255,255,255,0.07);flex-shrink:0;';
  var logoSpacer = document.createElement('div');
  logoSpacer.style.cssText = 'width:24px;flex-shrink:0;';
  var logoWrap = document.createElement('div');
  logoWrap.style.cssText = 'flex:1;display:flex;align-items:center;justify-content:center;';
  var logo = document.createElement('img');
  logo.src = 'img/OpenCurve_Logo14_small.png';
  logo.style.cssText = 'height:26px;opacity:0.9;';
  logoWrap.appendChild(logo);
  var closeBtn = document.createElement('div');
  closeBtn.textContent = '\u2715';
  _attachTooltip(closeBtn, 'Close settings');
  closeBtn.style.cssText = 'color:#888;font-size:13px;cursor:pointer;padding:4px 6px;flex-shrink:0;';
  closeBtn.addEventListener('mouseenter', function() { closeBtn.style.color='#e4e4e4'; });
  closeBtn.addEventListener('mouseleave', function() { closeBtn.style.color='#888'; });
  closeBtn.addEventListener('click', function() { modal.remove(); });
  header.appendChild(logoSpacer);
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
    ? 'padding:10px 12px 12px;width:50%;box-sizing:border-box;border-left:1px solid rgba(255,255,255,0.07);'
    : 'padding:10px 12px 12px;border-top:1px solid rgba(255,255,255,0.07);flex-shrink:0;';

  var colorLabel = document.createElement('div');
  colorLabel.textContent = 'Theme';
  colorLabel.style.cssText = 'color:#d4d4d4;font-size:14px;margin-bottom:10px;';
  colorSection.appendChild(colorLabel);

  var swatchColors = ['#4a9eff','#3ddc84','#f06060','#f0a030','#c97ff0','#ff6eb4','#ffffff','#aaaaaa'];
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
  hexInput.style.cssText = 'background:#252525;border:1px solid rgba(255,255,255,0.12);color:#e4e4e4;font-size:13px;padding:3px 8px;width:90px;outline:none;font-family:monospace;margin-left:8px;';
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
  hexRow.appendChild(hexInput);
  hexRow.appendChild(hexPreview);
  colorSection.appendChild(hexRow);

  // Check for updates row
  var updatesRow = document.createElement('div');
  updatesRow.id = '_updates-row';
  updatesRow.style.cssText = 'display:flex;align-items:center;padding:0 12px;height:36px;border-bottom:1px solid rgba(255,255,255,0.07);cursor:pointer;background:rgba(230,184,0,0.08);';
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
  notifRow.style.cssText = 'display:flex;align-items:center;padding:0 12px;height:36px;border-bottom:1px solid rgba(255,255,255,0.07);cursor:pointer;';
  var notifLabel = document.createElement('span');
  notifLabel.style.cssText = 'font-size:14px;flex:1;color:#d4d4d4;';
  notifLabel.textContent = 'Update Notifications';
  var notifCheck = document.createElement('span');
  notifCheck.style.cssText = 'display:flex;align-items:center;flex-shrink:0;margin-left:8px;';
  var _svgCheck = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><polyline points="1.5,6 4.5,9 10.5,3" stroke="#3ddc84" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var _svgCross = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><line x1="2" y1="2" x2="10" y2="10" stroke="#f06060" stroke-width="1.8" stroke-linecap="round"/><line x1="10" y1="2" x2="2" y2="10" stroke="#f06060" stroke-width="1.8" stroke-linecap="round"/></svg>';
  function _updateNotifCheck() {
    notifCheck.innerHTML = _updateNotifsOn ? _svgCheck : _svgCross;
    notifLabel.textContent = 'Update Notifications ' + (_updateNotifsOn ? 'On' : 'Off');
    notifRow.style.background = _updateNotifsOn ? 'rgba(61,220,132,0.08)' : 'rgba(240,96,96,0.08)';
  }
  var notifIcon = document.createElement('span');
  notifIcon.style.cssText = 'display:flex;align-items:center;flex-shrink:0;margin-right:8px;';
  notifIcon.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path fill="none" d="M8 2a4.5 4.5 0 014.5 4.5v3l1 1.5H2.5l1-1.5V6.5A4.5 4.5 0 018 2z" stroke="#b0b0b0" stroke-width="1.5" stroke-linejoin="round"/><path fill="none" d="M6 12.5a2 2 0 004 0" stroke="#b0b0b0" stroke-width="1.5" stroke-linecap="round"/></svg>';
  _updateNotifCheck();
  notifRow.appendChild(notifIcon);
  notifRow.appendChild(notifLabel);
  notifRow.appendChild(notifCheck);
  notifRow.addEventListener('mouseenter', function() { notifRow.style.background = _updateNotifsOn ? 'rgba(61,220,132,0.15)' : 'rgba(240,96,96,0.15)'; });
  notifRow.addEventListener('mouseleave', function() { notifRow.style.background = _updateNotifsOn ? 'rgba(61,220,132,0.08)' : 'rgba(240,96,96,0.08)'; });
  notifRow.addEventListener('click', function() {
    _updateNotifsOn = !_updateNotifsOn;
    localStorage.setItem(_UPDATE_NOTIF_KEY, _updateNotifsOn ? 'on' : 'off');
    _updateNotifCheck();
    _refreshUpdateNotification();
  });
  rowsCol.appendChild(notifRow);

  // Animations toggle
  var animRow = document.createElement('div');
  animRow.style.cssText = 'display:flex;align-items:center;padding:0 12px;height:36px;border-bottom:1px solid rgba(255,255,255,0.07);cursor:pointer;';
  var animLabel = document.createElement('span');
  animLabel.style.cssText = 'font-size:14px;flex:1;color:#d4d4d4;';
  var animCheck = document.createElement('span');
  animCheck.style.cssText = 'display:flex;align-items:center;flex-shrink:0;margin-left:8px;';
  function _updateAnimCheck() {
    animCheck.innerHTML = _animationsOn ? _svgCheck : _svgCross;
    animLabel.textContent = 'Animations ' + (_animationsOn ? 'On' : 'Off');
    animRow.style.background = _animationsOn ? 'rgba(61,220,132,0.08)' : 'rgba(240,96,96,0.08)';
  }
  var animIcon = document.createElement('span');
  animIcon.style.cssText = 'display:flex;align-items:center;flex-shrink:0;margin-right:8px;';
  animIcon.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path fill="none" d="M8 2l1.2 3L13 6l-2.5 2.5.6 3.5L8 10.5 4.9 12l.6-3.5L3 6l3.8-1z" stroke="#b0b0b0" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  _updateAnimCheck();
  animRow.appendChild(animIcon);
  animRow.appendChild(animLabel);
  animRow.appendChild(animCheck);
  animRow.addEventListener('mouseenter', function() { animRow.style.background = _animationsOn ? 'rgba(61,220,132,0.15)' : 'rgba(240,96,96,0.15)'; });
  animRow.addEventListener('mouseleave', function() { animRow.style.background = _animationsOn ? 'rgba(61,220,132,0.08)' : 'rgba(240,96,96,0.08)'; });
  animRow.addEventListener('click', function() {
    _animationsOn = !_animationsOn;
    localStorage.setItem(_ANIM_KEY, _animationsOn ? 'on' : 'off');
    _updateAnimCheck();
  });
  rowsCol.appendChild(animRow);

  // Scan during playback toggle row
  var scanRow = document.createElement('div');
  scanRow.style.cssText = 'display:flex;align-items:center;padding:0 12px;height:36px;border-bottom:1px solid rgba(255,255,255,0.07);cursor:pointer;';
  var scanLabel = document.createElement('span');
  scanLabel.style.cssText = 'font-size:14px;flex:1;color:#d4d4d4;';
  scanLabel.textContent = 'Scan During Playback';
  var scanCheck = document.createElement('span');
  scanCheck.style.cssText = 'display:flex;align-items:center;flex-shrink:0;margin-left:8px;';
  function _updateScanCheck() {
    scanCheck.innerHTML = _scanDuringPlayback ? _svgCheck : _svgCross;
    scanLabel.textContent = 'Scan During Playback ' + (_scanDuringPlayback ? 'On' : 'Off');
    scanRow.style.background = _scanDuringPlayback ? 'rgba(61,220,132,0.08)' : 'rgba(240,96,96,0.08)';
  }
  var scanIcon = document.createElement('span');
  scanIcon.style.cssText = 'display:flex;align-items:center;flex-shrink:0;margin-right:8px;';
  scanIcon.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><polygon points="4,2 4,14 13,8" fill="none" stroke="#b0b0b0" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  _updateScanCheck();
  scanRow.appendChild(scanIcon);
  scanRow.appendChild(scanLabel);
  scanRow.appendChild(scanCheck);
  scanRow.addEventListener('mouseenter', function() { scanRow.style.background = _scanDuringPlayback ? 'rgba(61,220,132,0.15)' : 'rgba(240,96,96,0.15)'; });
  scanRow.addEventListener('mouseleave', function() { scanRow.style.background = _scanDuringPlayback ? 'rgba(61,220,132,0.08)' : 'rgba(240,96,96,0.08)'; });
  scanRow.addEventListener('click', function() {
    _scanDuringPlayback = !_scanDuringPlayback;
    localStorage.setItem(_SCAN_PLAYBACK_KEY, _scanDuringPlayback ? 'on' : 'off');
    _updateScanCheck();
  });
  rowsCol.appendChild(scanRow);

  // Graph visibility toggle row
  var graphRow = document.createElement('div');
  graphRow.style.cssText = 'display:flex;align-items:center;padding:0 12px;height:36px;border-bottom:1px solid rgba(255,255,255,0.07);cursor:pointer;';
  var graphLabel = document.createElement('span');
  graphLabel.style.cssText = 'font-size:14px;flex:1;color:#d4d4d4;';
  graphLabel.textContent = 'Graph';
  var graphCheck = document.createElement('span');
  graphCheck.style.cssText = 'display:flex;align-items:center;flex-shrink:0;margin-left:8px;';
  function _updateGraphCheck() {
    graphCheck.innerHTML = _graphVisible ? _svgCheck : _svgCross;
    graphLabel.textContent = 'Graph ' + (_graphVisible ? 'On' : 'Off');
    graphRow.style.background = _graphVisible ? 'rgba(61,220,132,0.08)' : 'rgba(240,96,96,0.08)';
  }
  var graphIcon = document.createElement('span');
  graphIcon.style.cssText = 'display:flex;align-items:center;flex-shrink:0;margin-right:8px;';
  graphIcon.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2.5 13.5C6 13.5 10 2.5 13.5 2.5" fill="none" stroke="#b0b0b0" stroke-width="1.4" stroke-linecap="round"/><circle cx="2.5" cy="13.5" r="1.4" fill="#b0b0b0"/><circle cx="13.5" cy="2.5" r="1.4" fill="#b0b0b0"/></svg>';
  _updateGraphCheck();
  graphRow.appendChild(graphIcon);
  graphRow.appendChild(graphLabel);
  graphRow.appendChild(graphCheck);
  graphRow.addEventListener('mouseenter', function() { graphRow.style.background = _graphVisible ? 'rgba(61,220,132,0.15)' : 'rgba(240,96,96,0.15)'; });
  graphRow.addEventListener('mouseleave', function() { graphRow.style.background = _graphVisible ? 'rgba(61,220,132,0.08)' : 'rgba(240,96,96,0.08)'; });
  graphRow.addEventListener('click', function() {
    _graphVisible = !_graphVisible;
    localStorage.setItem(_GRAPH_KEY, _graphVisible ? 'on' : 'off');
    _updateGraphCheck();
    _applyGraphVisibility();
  });
  rowsCol.appendChild(graphRow);

  // Grid size row
  var gridRow = document.createElement('div');
  gridRow.style.cssText = 'display:flex;align-items:center;padding:0 0 0 12px;height:36px;border-bottom:1px solid rgba(255,255,255,0.07);';
  var gridIcon = document.createElement('span');
  gridIcon.style.cssText = 'display:flex;align-items:center;flex-shrink:0;margin-right:8px;';
  gridIcon.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="12" stroke="#b0b0b0" stroke-width="1.4" rx="1"/><line x1="6" y1="2" x2="6" y2="14" stroke="#b0b0b0" stroke-width="1"/><line x1="10" y1="2" x2="10" y2="14" stroke="#b0b0b0" stroke-width="1"/><line x1="2" y1="6" x2="14" y2="6" stroke="#b0b0b0" stroke-width="1"/><line x1="2" y1="10" x2="14" y2="10" stroke="#b0b0b0" stroke-width="1"/></svg>';
  var gridLabel = document.createElement('span');
  gridLabel.style.cssText = 'font-size:14px;flex:1;color:#d4d4d4;';
  gridLabel.textContent = 'Grid';
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
  densRow.style.cssText = 'display:flex;align-items:center;padding:0 0 0 12px;height:36px;border-bottom:1px solid rgba(255,255,255,0.07);';
  _attachTooltip(densRow, 'How far apart the baked keyframes are. Every frame follows the curve exactly; 2 or 4 frames writes fewer keyframes, with straight lines between them');
  var densIcon = document.createElement('span');
  densIcon.style.cssText = 'display:flex;align-items:center;flex-shrink:0;margin-right:8px;';
  densIcon.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><line x1="1" y1="8" x2="15" y2="8" stroke="#b0b0b0" stroke-width="1.2"/><polygon points="3.5,5.5 6,8 3.5,10.5 1,8" fill="#b0b0b0"/><polygon points="8,5.5 10.5,8 8,10.5 5.5,8" fill="#b0b0b0"/><polygon points="12.5,5.5 15,8 12.5,10.5 10,8" fill="#b0b0b0"/></svg>';
  var densLabel = document.createElement('span');
  densLabel.style.cssText = 'font-size:14px;flex:1;color:#d4d4d4;';
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
  layoutRow.style.cssText = 'display:flex;align-items:center;padding:0 0 0 12px;height:36px;border-bottom:1px solid rgba(255,255,255,0.07);';
  var layoutIcon = document.createElement('span');
  layoutIcon.style.cssText = 'display:flex;align-items:center;flex-shrink:0;margin-right:8px;';
  layoutIcon.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><line x1="2" y1="4" x2="14" y2="4" stroke="#b0b0b0" stroke-width="1.4" stroke-linecap="round"/><line x1="2" y1="8" x2="14" y2="8" stroke="#b0b0b0" stroke-width="1.4" stroke-linecap="round"/><line x1="2" y1="12" x2="14" y2="12" stroke="#b0b0b0" stroke-width="1.4" stroke-linecap="round"/></svg>';
  var layoutLabel = document.createElement('span');
  layoutLabel.style.cssText = 'font-size:14px;flex:1;color:#d4d4d4;';
  layoutLabel.textContent = 'Presets';
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
  footer.style.cssText = 'border-top:1px solid rgba(255,255,255,0.07);flex-shrink:0;';
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
  resetRow.style.cssText = 'display:flex;align-items:center;padding:5px 10px;cursor:pointer;color:#f06060;font-size:13px;background:rgba(240,96,96,0.08);flex-shrink:0;';
  var resetIcon = document.createElement('span');
  resetIcon.style.cssText = 'display:flex;align-items:center;';
  resetIcon.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path fill="none" d="M3 5h10M6 5V4h4v1M6.5 7.5v4M9.5 7.5v4M4.5 5l.5 8h6l.5-8" stroke="#f06060" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var resetLabel = document.createElement('span');
  resetLabel.textContent = 'Reset All Settings';
  resetLabel.style.marginLeft = '6px';
  _attachTooltip(resetRow, 'Restore defaults and remove all presets');
  resetRow.appendChild(resetIcon);
  resetRow.appendChild(resetLabel);
  resetRow.addEventListener('mouseenter', function() { resetRow.style.background='rgba(240,96,96,0.15)'; });
  resetRow.addEventListener('mouseleave', function() { resetRow.style.background='rgba(240,96,96,0.08)'; });
  resetRow.addEventListener('click', function() {
    modal.remove();
    _confirmReset();
  });

  footerRow.appendChild(footerLeft);
  footerRow.appendChild(resetRow);
  footer.appendChild(footerRow);

  modal.appendChild(header);
  modal.appendChild(content);
  modal.appendChild(footer);
  document.body.appendChild(modal);

  var _settingsRO = new ResizeObserver(function() {
    var nvw = document.documentElement.clientWidth  || document.body.clientWidth;
    var nvh = document.documentElement.clientHeight || document.body.clientHeight;
    modal.style.width  = nvw + 'px';
    modal.style.height = nvh + 'px';
    var nowDual = nvw > 520;
    if (nowDual !== dualCol) {
      dualCol = nowDual;
      content.style.flexDirection = nowDual ? 'row' : 'column';
      colorSection.style.cssText = nowDual
        ? 'padding:10px 12px 12px;width:50%;box-sizing:border-box;border-left:1px solid rgba(255,255,255,0.07);'
        : 'padding:10px 12px 12px;border-top:1px solid rgba(255,255,255,0.07);flex-shrink:0;';
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

  // Scan-during-playback toggle (read by bridge poll loop)
  get scanDuringPlayback() { return _scanDuringPlayback; },

  // Keyframe spacing for the bake (read by the bridge when Go is pressed)
  get bakeDensity() { return _bakeDensity; },

  // Bridge setter
  setBridge: function(b) { _bridge = b; },

  // Keep Go's label clear of the floating Undo button (bridge calls it when toggling Undo)
  fitGoForUndo: _fitGoForUndo,
};

})();
