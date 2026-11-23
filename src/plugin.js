/**
 * FayeSmoothify — single-file plugin bundle.
 *
 * Deliberately NOT an ES module (no import/export).
 * require() is a UXP global available in all script contexts.
 * All logic lives here so there's no module-loading chain to fail silently.
 */

console.log('[FS] plugin.js executing');

// Debug menu items (Dump Components, Poll Timing, Scroll Debug) are hidden from
// users since 2.1.0. To get them back for debugging, run
// localStorage.setItem('opencurve-dev-menu', 'on') in the plugin's DevTools and
// reload the plugin. While hidden, a debug mode left on from before is ignored,
// so nobody is stuck with logging they can't switch off.
var _DEV_MENU = (function() { try { return localStorage.getItem('opencurve-dev-menu') === 'on'; } catch(_) { return false; } })();

// Up here because the flyout menu (entrypoints.setup, just below) shows it in
// its "OpenCurve 2 - v2.1.0 - CCX" row; the Exchange build strips the CCX line
var CURRENT_VERSION = '2.1.0';
var _EDITION_TAG = 'Exchange';
_EDITION_TAG = 'CCX'; // [exchange-strip-line]

// ─── Post-scroll freeze elimination: listener types dropped at registration ─
// Windows' double-click time here is 500ms and the measured dead window is
// 507-548ms, so the engine's own input state machine is the suspect. Every
// addEventListener for a type listed here is ignored (edit, reload, measure
// with Flyout > Scroll Debug). Candidates, one at a time:
//   ['dblclick']                                              preset names + timeline lanes
//   ['mouseenter', 'mouseleave', 'pointerenter', 'pointerleave']  tooltips, hover classes, tile dot, lane highlight
//   ['contextmenu']                                           graph, preset list, lanes
var _EVT_SKIP = []; // normally empty
(function() {
  if (!_EVT_SKIP.length) return;
  var seen = [];
  [typeof EventTarget !== 'undefined' ? EventTarget : null, typeof Node !== 'undefined' ? Node : null,
   typeof Element !== 'undefined' ? Element : null, typeof Document !== 'undefined' ? Document : null,
   typeof Window !== 'undefined' ? Window : null].forEach(function(C) {
    if (!C || !C.prototype || !Object.prototype.hasOwnProperty.call(C.prototype, 'addEventListener')) return;
    var orig = C.prototype.addEventListener;
    if (seen.indexOf(orig) >= 0) return;
    seen.push(orig);
    C.prototype.addEventListener = function(type, fn, opts) {
      if (_EVT_SKIP.indexOf(type) >= 0) return;
      return orig.call(this, type, fn, opts);
    };
  });
  console.log('[OC-SCROLL] listener types dropped this session: ' + _EVT_SKIP.join(', ') + ' (patched ' + seen.length + ' prototype(s))');
})();

// ─── UXP built-ins ────────────────────────────────────────────────────────
var uxp, ppro;
try {
  uxp  = require('uxp');
  console.log('[FS] uxp loaded OK');
} catch(e) {
  console.error('[FS] FATAL: could not load uxp:', e);
}
try {
  ppro = require('premierepro');
  console.log('[FS] premierepro loaded OK');
} catch(e) {
  console.error('[FS] FATAL: could not load premierepro:', e);
}

// ─── Entrypoints ──────────────────────────────────────────────────────────
var _panelInitialised = false;

console.log('[FS] setting up entrypoints');
try {
  var ep = uxp && uxp.entrypoints ? uxp.entrypoints : require('uxp').entrypoints;
  ep.setup({
    plugin: {
      create: function() { console.log('[FS] plugin create'); },
      destroy: function() { if (pollTimer) { clearInterval(pollTimer); pollTimer=null; } },
    },
    panels: {
      'opencurve-panel': {
        create: function() {
          console.log('[FS] panel create — DOM ready');
          if (_panelInitialised) {
            console.log('[FS] panel already initialised — skipping duplicate create');
            return;
          }
          _panelInitialised = true;
          initPanel();
          _applyCurveColor(_curveColor);
          var _welcomed = _showWelcome(); // first launch of a release with a What's new card; stands in for the toast
          // [exchange-strip]
          if (localStorage.getItem('opencurve-post-update') === '1') {
            localStorage.removeItem('opencurve-post-update');
            if (!_welcomed) setTimeout(function() {
              _showCopyToast('Updated to v' + CURRENT_VERSION, '#3ddc84');
            }, 500);
          }
          // [/exchange-strip]
        },
        show: function() {
          console.log('[FS] panel show — starting poll');
          _applyPresetLayout(true);
          poll();
          // A show without a matching hide would otherwise leave an orphan
          // interval running for the session, polling at twice the rate
          if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
          if (_POLL_ON) pollTimer = setInterval(poll, POLL_MS); // _POLL_ON: scroll-freeze elimination switch
          if (_updateNotifsOn) _checkForUpdates(true); // [exchange-strip-line]
        },
        hide: function() {
          console.log('[FS] panel hide — stopping poll');
          if (pollTimer) { clearInterval(pollTimer); pollTimer=null; }
        },
        destroy: function() {
          if (pollTimer) { clearInterval(pollTimer); pollTimer=null; }
        },
        menuItems: [
          { id: 'options',       label: 'Settings' },
          { id: 'check-updates', label: 'Check for Updates' }, // [exchange-strip-line]
        ].concat(_DEV_MENU ? [
          { id: 'dump-comps',    label: 'Dump Components (Debug)' },
          { id: 'poll-timing',   label: 'Poll Timing (Debug)' },
          { id: 'scroll-debug',  label: 'Scroll Debug' },
        ] : []).concat([
          { id: 'sep',           label: '-' },
          { id: 'version',       label: 'OpenCurve 2 - v' + CURRENT_VERSION + ' - ' + _EDITION_TAG, enabled: false },
          { id: 'made-by',       label: 'made by faye', enabled: false },
        ]),
        invokeMenu: function(id) {
          if (id === 'options')       _showSettingsModal();
          if (id === 'check-updates') _checkForUpdates(); // [exchange-strip-line]
          if (!_DEV_MENU) return;
          if (id === 'dump-comps')    _dumpComponents();
          if (id === 'poll-timing')   _toggleDebugTiming();
          if (id === 'scroll-debug')  _toggleDebugScroll();
          // No 'reset' item in menuItems: Reset All Settings lives in Settings
        },
      },
    },
  });
  console.log('[FS] entrypoints.setup complete');
} catch(e) {
  console.error('[FS] entrypoints.setup FAILED:', e);
}

// ─── State ────────────────────────────────────────────────────────────────
var state = {
  status:           'idle',
  availableParams:  [],
  selectedParamKeys: [],
  validParamKeys:   [],
  paramContexts:    {},
  bakedParamKeys:   [],
  clipId:           null,   // identity (name|start|end) of the clip the rows belong to; keys bake records
  clipName:         '',     // that clip's name, shown in the status strip
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
    if (Math.abs(d) < 1e-8) break; // derivative too small — fall through to binary search
    t = Math.max(0, Math.min(1, t - err / d));
  }
  // Binary search fallback for when Newton-Raphson doesn't converge
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

// Row Load Curve button: the baked curve drawn as its icon, in the button's
// 14-unit viewBox (shown at 16px), stretched to the curve's y extent like the
// preset thumbnails so an overshoot isn't clipped
function _rowCurveD(c) {
  if (!c) return '';
  var b = _curveYBounds(c), span = (b.hi - b.lo) || 1, pad = 1.8, g = 14 - 2 * pad;
  function r(v) { return Math.round(v * 100) / 100; }
  return _curvePathTx(c,
    function(x) { return r(pad + x * g); },
    function(y) { return r(pad + (1 - (y - b.lo) / span) * g); });
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
// Handle hover highlight: the handle (or added point) under the pointer, or
// the one being dragged, draws a thicker stroke. Only SVG attributes are
// written (cheap in UXP, unlike HTML), and only when the hovered handle
// changes. Descriptors as hitTest returns them: {k:'p1'|'p2'|'in'|'out'|'a', i}.
var _HANDLE_SW = '1.5', _HANDLE_SW_HOT = '4';  // the white disc's ring (#sg-h1 / #sg-h2 and added handles)
var _ANCHOR_SW = '2',   _ANCHOR_SW_HOT = '3.5'; // added points' circle / square
var _hoverKey = '', _hoverEls = [];
function _handleHoverEls(d) {
  if (!d) return [];
  if (d.k === 'p1' || d.k === 'p2') {
    var g = document.getElementById(d.k === 'p1' ? 'sg-h1' : 'sg-h2');
    var gc = g ? g.querySelectorAll('circle') : [];
    return gc.length > 1 ? [[gc[1], _HANDLE_SW, _HANDLE_SW_HOT]] : [];
  }
  var e = _ptEls[d.i];
  if (!e) return [];
  if (d.k === 'a') return [[e.inner, _ANCHOR_SW, _ANCHOR_SW_HOT], [e.sq, _ANCHOR_SW, _ANCHOR_SW_HOT]];
  var h = d.k === 'in' ? e.hi : e.ho;
  var hc = h ? h.querySelectorAll('circle') : [];
  return hc.length > 1 ? [[hc[1], _HANDLE_SW, _HANDLE_SW_HOT]] : []; // [0] the halo, [1] the white disc
}
function _setHandleHover(d) {
  var key = d ? d.k + (d.i != null ? d.i : '') : '';
  if (key === _hoverKey && (!key || (_hoverEls[0] && _hoverEls[0][0].parentNode))) return;
  _hoverEls.forEach(function(x) { x[0].setAttribute('stroke-width', x[1]); });
  _hoverKey = key;
  _hoverEls = _handleHoverEls(d);
  _hoverEls.forEach(function(x) { x[0].setAttribute('stroke-width', x[2]); });
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
    var bnBtn = document.getElementById('bounce-mode'); // the side column hides its buttons one by one, from the bottom
    var tint = (_peakMode && btn.style.display === 'none') || (_bounceMode && !!bnBtn && bnBtn.style.display === 'none');
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
    var x1 = b0.x - b0.s, sideBtn = document.getElementById('peak-mode'); // the column's top button, the last to hide
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
var _BN_LIFT = 1; // the segments' 1px text nudge (UXP sits text low; Settings' _uxpLift)
function _bnInit() {
  var panel = document.getElementById('bounce-panel');
  _bnInitSVG();
  if (!panel || _bnEls) return;
  _bnEls = { seg: {}, sl: {} };
  panel.style.cssText = 'display:none;flex-direction:column;flex-shrink:0;padding:6px 10px 9px 10px;background:#1a1a1a;'; // its own fill, apart from the graph's #111 surround
  var top = document.createElement('div');
  top.style.cssText = 'display:flex;align-items:center;justify-content:space-between;height:30px;margin-bottom:4px;';
  // Segmented pickers styled like Settings > Keyframe Spacing: a #2e2e2e
  // outline round a 1px inset #121212 fill (filled boxes, since UXP draws CSS
  // borders soft), 24px segments, the chosen one raised to #333
  function seg(key, items) {
    var box = document.createElement('div');
    box.style.cssText = 'box-sizing:border-box;flex-shrink:0;height:30px;padding:1px;border-radius:6px;background-color:#2e2e2e;';
    var inner = document.createElement('div');
    inner.style.cssText = 'box-sizing:border-box;display:flex;flex-direction:row;height:28px;padding:2px;border-radius:5px;background-color:#121212;';
    box.appendChild(inner);
    _bnEls.seg[key] = [];
    items.forEach(function(it, idx) {
      var b = document.createElement('div');
      b.textContent = it[1];
      b.style.cssText = 'display:flex;align-items:center;justify-content:center;box-sizing:border-box;height:24px;min-width:44px;padding:'
        + (3 - _BN_LIFT) + 'px 8px ' + (3 + _BN_LIFT) + 'px;border-radius:4px;font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap;color:#8c8c8c;'
        + (idx ? 'margin-left:2px;' : '');
      b._ocVal = it[0];
      b.addEventListener('mouseenter', function() { b._ocHov = true; _bnPaintSeg(key); });
      b.addEventListener('mouseleave', function() { b._ocHov = false; _bnPaintSeg(key); });
      b.addEventListener('click', function() { var ch = {}; ch[key] = it[0]; _bnSet(ch, false); });
      if (it[2]) _attachTooltip(b, it[2]);
      inner.appendChild(b);
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
    var bg = on ? '#333333' : b._ocHov ? '#222222' : 'transparent', col = on ? '#ffffff' : '#8c8c8c';
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
var FALLBACK_FPS        = 30;   // used when sequence frame rate can't be detected
var DONE_DISPLAY_MS     = 1000; // how long "Done!" status shows after bake
var ERROR_DISPLAY_MS    = 3000; // how long error status persists before poll resumes
var HIT_TOLERANCE       = 6;    // extra px around handle for hit detection
var Y_CLAMP_MIN         = -1.0; // min Y value for control point dragging
var Y_CLAMP_MAX         =  2.0; // max Y value for control point dragging

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

// Normalised [0,1] curve coords ↔ SVG pixel coords (always at zoom=1 logical space)
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

// Map a raw SVG viewport coordinate through the inverse of the content group's scale transform
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

// Dimensions of the SVG element — updated by ResizeObserver, read during drag
var _svgW = 0, _svgH = 0;

// Update all static elements (grid, diagonal, endpoints) — called on init + resize only
// Opacity steps for the fade zones, innermost to outermost
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
  // Full background (outer area when zoomed out)
  var bg = document.getElementById('sg-bg');
  if (bg) { bg.setAttribute('width', W); bg.setAttribute('height', H); }

  // Range background and outline — covers exactly the 0–1 value region
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

  // Grid lines — dynamic count based on _gridSize
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

// Update only the dynamic elements (curve, tangents, handles) — called on every pointer event
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
  var gd = _presetLayout === 'list' ? '' : 'none', ld = _presetLayout === 'list' ? 'none' : '';
  if (g && g.style.display !== gd) g.style.display = gd; // write only on change: UXP relayouts on every style write
  if (l && l.style.display !== ld) l.style.display = ld;
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
  var dragging  = null; // 'p1' | 'p2' | null
  var liveCurve = null; // working copy mutated during drag
  var dragRect  = null; // SVG rect cached at drag-start
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
    _setHandleHover(hit); // the dragged handle stays highlighted
    _lastHandle = hit; // arrow keys nudge this one
    liveCurve   = _cloneCurve(getState().curve);
    dragRect    = svg.getBoundingClientRect();
    _isDragging = true;
    e.preventDefault();
    setCursor('grabbing');
  });

  // No coordinate readout (removed 2026-11-22): writing its HTML text on every
  // move cost UXP a whole-panel relayout, which held the graph to ~38 pointer
  // events a second while dragging or hovering (267 / 419 without it, measured
  // live). Nothing in this path may write HTML text or inline layout styles;
  // SVG attribute writes are cheap.
  svg.addEventListener('pointermove', function(e) {
    if (dragging === 'peak') { _applyPeakPointer(e); return; }
    if (dragging === 'bn-hit' || dragging === 'bn-top') { _applyBnPointer(e); return; }
    if (!dragging) {
      if (_peakMode) { _setHandleHover(null); setCursor('crosshair'); return; }
      if (_bounceMode) {
        _setHandleHover(null);
        var hr = svg.getBoundingClientRect();
        var hw = _bnDotAt(_unscale(e.clientX - hr.left, e.clientY - hr.top), HANDLE_R + HIT_TOLERANCE + 4);
        setCursor(hw === 'hit' ? 'ew-resize' : hw === 'top' ? 'ns-resize' : 'pointer');
        return;
      }
      var curveH = liveCurve || getState().curve;
      var hovHit = hitTest(e, svg.getBoundingClientRect(), curveH);
      _setHandleHover(hovHit);
      setCursor(hovHit ? 'grab' : 'crosshair');
      return;
    }
    dragMoved = true;
    // Hot path: pure arithmetic + SVG attribute writes, no HTML and no layout
    var raw = _unscale(e.clientX - dragRect.left, e.clientY - dragRect.top);
    var n   = svgToNorm(raw.cx, raw.cy, _svgW, _svgH);
    var x   = Math.max(0,    Math.min(1,   n.nx));
    var y   = Math.max(Y_CLAMP_MIN, Math.min(Y_CLAMP_MAX, n.ny));
    if (e.shiftKey) { x = Math.round(x * _gridSize) / _gridSize; y = Math.round(y * _gridSize) / _gridSize; }
    _setHandle(liveCurve, dragging, x, y, e.altKey, e.ctrlKey || e.metaKey);
    _setSnapBg(e.shiftKey);
    updateDynamicSVG(liveCurve, _svgW, _svgH);
  });

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

  function endDrag(e) {
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
    // Whatever is under the pointer at release stays lit (the dragged handle
    // usually is); a release off the graph clears it
    _setHandleHover(e && e.clientX != null && !e._ocSynth ? hitTest(e) : null);
  }

  svg.addEventListener('pointerup',     endDrag);
  svg.addEventListener('pointerleave', function() { if (!dragging) _setHandleHover(null); });
  svg.addEventListener('pointercancel', endDrag);

  // UXP never delivers key events to window or document (see CLAUDE.md), so
  // these never fired here; the drag's own _setSnapBg(e.shiftKey) covers it.
  // The CEP edition does receive them and keeps them.


  function onResize() {
    var rect = svg.getBoundingClientRect();
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
    new ResizeObserver(onResize).observe(svg);
  }
  onResize();
}

// ─── Premiere API helpers ─────────────────────────────────────────────────

// Call a method that might be sync or async
async function _call(obj, method) {
  var args = Array.prototype.slice.call(arguments, 2);
  if (!obj || typeof obj[method] !== 'function') {
    throw new Error(method + ' is not a function');
  }
  var r = obj[method].apply(obj, args);
  return (r && typeof r.then === 'function') ? await r : r;
}

async function _fpsDetect(sequence) {
  var TICKS_PER_SEC = 254016000000; // Premiere Pro's internal tick rate

  // Primary: sequence.getTimebase() returns ticks-per-frame as a string
  try {
    if (typeof sequence.getTimebase === 'function') {
      var tb = await sequence.getTimebase();
      var ticksPerFrame = parseInt(tb, 10);
      if (ticksPerFrame > 0) {
        var fps = TICKS_PER_SEC / ticksPerFrame;
        console.log('[FS] fps from getTimebase:', fps, '(' + tb + ' ticks/frame)');
        return fps;
      }
    }
  } catch(_) {}

  // Fallback: getSettings().videoFrameRate (TickTime with .seconds)
  try {
    var settings = await sequence.getSettings();
    var fd = settings.videoFrameRate;
    if (fd && fd.seconds > 0) return 1 / fd.seconds;
    if (fd && fd.ticks > 0) return TICKS_PER_SEC / fd.ticks;
  } catch(_) {}

  console.warn('[FS] Could not detect sequence frame rate — defaulting to ' + FALLBACK_FPS + ' fps.');
  return FALLBACK_FPS;
}

async function _fps(sequence) {
  var now = Date.now();
  // Return cached fps if still fresh
  if (_cache.fps !== null && (now - _cache.fpsCheckedAt) < FPS_RECHECK_MS) {
    return _cache.fps;
  }
  var fps = await _fpsDetect(sequence);
  _cache.fps = fps;
  _cache.fpsCheckedAt = now;
  return fps;
}

// Internal property names: component matchName → { paramIndex: name }. This is
// the panel's stable identity for a property (bake records match on it, and the
// Opacity clamp and the readout's units test it), so it stays English and never
// changes. The rows show the live name from the user's own Premiere instead
// (_liveParamName below); this table only fills in when that is blank.
var PARAM_NAMES = {
  'AE.ADBE Opacity':    { 0: 'Opacity' },
  'AE.ADBE Motion':     { 0: 'Position', 1: 'Scale', 2: 'Scale Width', 3: 'Scale Height', 4: 'Rotation', 5: 'Anchor Point', 6: 'Anti-flicker Filter', 7: 'Crop Left', 8: 'Crop Top', 9: 'Crop Right', 10: 'Crop Bottom' },
  'ADBE Opacity':       { 0: 'Opacity' },
  'ADBE Motion':        { 0: 'Position', 1: 'Scale', 2: 'Scale Width', 3: 'Scale Height', 4: 'Rotation', 5: 'Anchor Point', 6: 'Anti-flicker Filter', 7: 'Crop Left', 8: 'Crop Top', 9: 'Crop Right', 10: 'Crop Bottom' },
  'AE.ADBE Geometry2':  { 0: 'Transform Anchor Point', 1: 'Transform Position', 3: 'Transform Scale', 5: 'Transform Skew', 6: 'Transform Skew Axis', 7: 'Transform Rotation', 8: 'Transform Opacity', 10: 'Transform Shutter Angle' },
  'ADBE Geometry2':     { 0: 'Transform Anchor Point', 1: 'Transform Position', 3: 'Transform Scale', 5: 'Transform Skew', 6: 'Transform Skew Axis', 7: 'Transform Rotation', 8: 'Transform Opacity', 10: 'Transform Shutter Angle' },
  // Vector Motion on graphic/shape clips (index 3 is the Uniform Scale checkbox)
  'AE.ADBE Graphic Group': { 0: 'Vector Position', 1: 'Vector Scale', 2: 'Vector Scale Width', 4: 'Vector Rotation', 5: 'Vector Anchor Point' },
  'ADBE Graphic Group':    { 0: 'Vector Position', 1: 'Vector Scale', 2: 'Vector Scale Width', 4: 'Vector Rotation', 5: 'Vector Anchor Point' },
  // Shape layer's own Transform group (index 6 is the Uniform Scale checkbox)
  'AE.ADBE Shape':      { 3: 'Shape Position', 4: 'Shape Scale', 5: 'Shape Scale Width', 7: 'Shape Rotation', 8: 'Shape Opacity', 9: 'Shape Anchor Point' },
  'ADBE Shape':         { 3: 'Shape Position', 4: 'Shape Scale', 5: 'Shape Scale Width', 7: 'Shape Rotation', 8: 'Shape Opacity', 9: 'Shape Anchor Point' },
  'AE.ADBE AECrop':     { 0: 'Crop Left', 1: 'Crop Top', 2: 'Crop Right', 3: 'Crop Bottom' },
  'ADBE AECrop':        { 0: 'Crop Left', 1: 'Crop Top', 2: 'Crop Right', 3: 'Crop Bottom' },
};
function _paramName(compMatchName, idx, fallback) {
  var map = PARAM_NAMES[compMatchName];
  return (map && map[idx]) || fallback || ('Param ' + idx);
}

// Live property names, read from the user's own Premiere: every effect gets its
// real name, third-party ones included, in the user's language, with no table.
// ComponentParam carries displayName as a plain property; getDisplayName() is a
// Component method, which is why this looked unavailable for so long. Cached per
// effect for the session, since an effect's parameter list is the same on every
// clip and each proxy read is an IPC round trip. Group headers and spacers come
// back as ' ' or '', which the caller treats as no name.
var _liveNameCache = {};   // matchName + '|' + index -> trimmed name ('' = none)
var _compNameCache = {};   // matchName -> the effect's own display name
function _liveParamName(matchName, idx, param) {
  var k = matchName + '|' + idx;
  if (matchName && _liveNameCache.hasOwnProperty(k)) return _liveNameCache[k];
  var n = '';
  try { n = param.displayName; } catch(_) {}
  n = typeof n === 'string' ? n.trim() : '';
  if (matchName) _liveNameCache[k] = n;
  return n;
}
// When no live name exists: the internal name, minus the "AE.ADBE " style prefix
function _fallbackLabel(name) {
  return String(name || '').replace(/^(AE|PR)[.]/, '').replace(/^ADBE /, '');
}
// Every row names its effect after the property, "Scale (Vector Motion)", so the
// rows say where each property lives, including "Opacity (Opacity)", which reads
// clearer than a bare "Opacity". Left off on fallback labels, which already carry
// the effect ("Turbulent Displace 7"). Rows still identical after that (one effect
// with two params of one name) are numbered: "Random Seed 2 (Turbulent Displace)".
async function _finishLabels(list) {
  for (var i = 0; i < list.length; i++) {
    var p = list[i];
    p._effect = '';
    if (!p.live) continue;
    var cn = p.matchName && _compNameCache.hasOwnProperty(p.matchName) ? _compNameCache[p.matchName] : null;
    if (cn === null) {
      cn = '';
      try { cn = String((await _call(p.comp, 'getDisplayName')) || '').trim(); } catch(_) {}
      if (p.matchName) _compNameCache[p.matchName] = cn;
    }
    p._effect = cn;
  }
  var total = {}, seen = {};
  list.forEach(function(p) { var k = p.label + '~' + p._effect; total[k] = (total[k] || 0) + 1; });
  list.forEach(function(p) {
    var k = p.label + '~' + p._effect;
    seen[k] = (seen[k] || 0) + 1;
    p.label = p.label + (total[k] > 1 && seen[k] > 1 ? ' ' + seen[k] : '') + (p._effect ? ' (' + p._effect + ')' : '');
    delete p._effect;
  });
}


async function _getValue(param, tickTime) {
  return await _call(param, 'getValueAtTime', tickTime);
}

// Extract the usable value from whatever getValueAtTime returns.
// Scalar params return {value: number} or a plain number → unwrap to number.
// Compound params (Position) return {value: [x, y]} → unwrap to array.
// Returns null only if the shape is unrecognised.
function _extractValue(v) {
  if (typeof v === 'number') return v;
  if (v !== null && typeof v === 'object' && 'value' in v) {
    if (typeof v.value === 'number') return v.value;
    // Exactly two components (Position, Anchor Point, Scale as a pair): the bake
    // writes these as a PointF. A longer array would be silently truncated to
    // its first two values, so it is refused and the row is not offered.
    if (Array.isArray(v.value) && v.value.length === 2) return v.value;
  }
  return null;
}

// Fast selection item fetch — caches which getTrackItems signature works
async function _getSelectionItems(sequence) {
  var sel = await sequence.getSelection();
  if (!sel) return null;
  var items = null;
  if (_cache.selTrackItemSig === 'noargs') {
    items = await _call(sel, 'getTrackItems');
  } else if (_cache.selTrackItemSig === 'typed') {
    items = await _call(sel, 'getTrackItems', 1, false);
  } else {
    // First call — discover which signature works
    try { items = await _call(sel, 'getTrackItems'); _cache.selTrackItemSig = 'noargs'; }
    catch(_) {}
    if (!items) {
      try { items = await _call(sel, 'getTrackItems', 1, false); _cache.selTrackItemSig = 'typed'; }
      catch(_) {}
    }
  }
  return items;
}

// Name, start and end of a clip, read in parallel. Every Premiere object here is
// a proxy and every getter is an IPC round trip, so the three go together rather
// than one after another, and callers that need the times reuse them instead of
// reading the same values again.
async function _clipInfo(item, trackIdx) {
  var r = await Promise.all([
    item.getName().then(null, function() { return ''; }),
    item.getStartTime().then(null, function() { return null; }),
    item.getEndTime().then(null, function() { return null; })
  ]);
  var n = r[0] || '';
  var s = r[1] && typeof r[1].seconds === 'number' ? r[1].seconds : '';
  var e = r[2] && typeof r[2].seconds === 'number' ? r[2].seconds : '';
  return {
    name: n,
    start: typeof s === 'number' ? s : -1,
    end:   typeof e === 'number' ? e : -1,
    id: n + '|' + s + '|' + e + (trackIdx !== undefined ? '|T' + trackIdx : '')
  };
}

// Composite clip identity — name + start + end + track index.
// Unique even for same-named clips stacked on different tracks.
async function _clipIdentity(item, trackIdx) {
  try { return (await _clipInfo(item, trackIdx)).id; } catch(_) { return '||' + (trackIdx !== undefined ? '|T' + trackIdx : ''); }
}

// Identities of every selected item, read in parallel (the cache check and the
// snapshot below both need them, and used to fetch the selection again for each).
async function _selIdentities(selItems) {
  if (!selItems || !selItems.length) return [];
  // Array.prototype.map.call: a Premiere list may be array-like (this file wraps
  // keyframe lists with Array.from for that reason) and the old code only ever
  // indexed these, so a bare .map would have been an unproven assumption
  return await Promise.all(Array.prototype.map.call(selItems, function(it) { return _clipIdentity(it); }));
}

// Returns ALL clips at the playhead across all video tracks (topmost first).
// Audio tracks are never scanned here: audio clips are only offered when they
// are selected (see _selCandidates). Scanning them as a fallback was measured
// at 5x the cost of a full scan on a 150 video / 600 audio clip timeline (10ms
// to 50ms, on every moved playhead), for every user, audio keyframes or not.
async function _clipsViaTrackScan(sequence, ph) {
  var results = [];
  await _scanTracksAt(sequence, ph, false, results);
  return results;
}
async function _scanTracksAt(sequence, ph, audio, results) {
  var numTracks;
  try { numTracks = audio ? await sequence.getAudioTrackCount() : await sequence.getVideoTrackCount(); }
  catch(_) { return; }
  if (!numTracks || numTracks <= 0) return;

  // Video top-down (highest track = topmost visible clip), audio from A1 down
  for (var n = 0; n < numTracks; n++) {
    var t = audio ? n : numTracks - 1 - n;
    var track;
    try { track = audio ? await sequence.getAudioTrack(t) : await sequence.getVideoTrack(t); } catch(_) { continue; }
    if (!track) continue;

    var all = null;
    try { all = await track.getTrackItems(1, false); } catch(_) {}
    if (!all || all.length === 0) continue;

    // Every clip's name, start and end, all in flight together. Reading them one
    // clip after another cost two sequential round trips per clip on every
    // moved playhead: 400+ on a 200-clip sequence, continuously during playback.
    var infos = [];
    try { infos = await Promise.all(Array.prototype.map.call(all, function(it) { return _clipInfo(it, t); })); } catch(_) { continue; }

    for (var i = 0; i < all.length; i++) {
      try {
        var item = all[i], info = infos[i];
        if (!info) continue;
        var s = info.start, e = info.end;
        // End is exclusive, as in Premiere: a playhead sitting on a cut belongs to
        // the incoming clip. Treating it as inside the outgoing one made the panel
        // report that clip's properties (and "Move playhead between keyframes",
        // since the playhead is at its out-point) on the first frame of the next.
        if (s < 0 || e < 0 || ph < s || ph >= e) continue;
        var chain = await item.getComponentChain();
        if (chain) {
          results.push({ clip: item, chain: chain, clipStart: s, clipEnd: e, trackIdx: t, isAudio: audio, identity: info.id });
        }
      } catch(_) {}
    }
  }
}

// The selected clips as scan candidates: `here` holds the selected clips under
// the playhead, video first (a linked clip selects its video and its audio
// together: the video is tried first, the audio when the video has no keyframed
// property; until 2.0.1 audio items were skipped outright, issue #12). With
// none under the playhead, `elsewhere` is the first selected video clip, which
// is what the panel always showed for a selection away from the playhead.
// Name, start and end of every selected item are read in one parallel batch and
// only the clips under the playhead are looked at further, so a big selection
// (Ctrl+A) doesn't cost several round trips per clip on every scan.
async function _selCandidates(sequence, selItems, ph) {
  // selItems is passed in by detectContext, which fetched it for this poll
  if (!selItems) { try { selItems = await _getSelectionItems(sequence); } catch(_) { selItems = null; } }
  var items = Array.prototype.slice.call(selItems || []);
  var infos = await Promise.all(items.map(function(it) { return _clipInfo(it).catch(function() { return null; }); }));
  async function describe(i) {
    try {
      var ch = await items[i].getComponentChain();
      if (!ch) return null;
      // Audio chains hold audio-only components ("Internal Volume Mono" and so on)
      var cc = 0; try { cc = await _call(ch, 'getComponentCount'); } catch(_) {}
      var isAudio = false;
      if (cc > 0) {
        var firstComp = await _call(ch, 'getComponentAtIndex', 0);
        var mn = ''; try { mn = await _call(firstComp, 'getMatchName'); } catch(_) {}
        isAudio = mn.indexOf('Internal') === 0;
      }
      var trackIdx = -1; try { trackIdx = await items[i].getTrackIndex(); } catch(_) {}
      var info = infos[i];
      return { clip: items[i], chain: ch, clipStart: info.start >= 0 ? info.start : 0, clipEnd: info.end,
               viaSelection: true, identity: info.id, isAudio: isAudio, trackIdx: trackIdx };
    } catch(_) { return null; }
  }
  var here = [];
  for (var i = 0; i < items.length; i++) {
    var inf = infos[i];
    if (!inf || inf.start < 0 || inf.end < 0 || ph < inf.start || ph >= inf.end) continue;
    var c = await describe(i);
    if (c) here.push(c);
  }
  here.sort(function(a, b) { return (a.isAudio ? 1 : 0) - (b.isAudio ? 1 : 0); });
  var elsewhere = null;
  if (!here.length) {
    for (var j = 0; j < items.length && !elsewhere; j++) {
      if (!infos[j]) continue;
      var d = await describe(j);
      if (d && !d.isAudio) elsewhere = d;
    }
  }
  return { here: here, elsewhere: elsewhere };
}
async function _clipViaSelection(sequence, selItems) {
  var ph = 0;
  try { ph = (await sequence.getPlayerPosition()).seconds; } catch(_) {}
  var s = await _selCandidates(sequence, selItems, ph);
  return s.here[0] || s.elsewhere || null;
}

// How a clip's keyframe times (source media seconds) map to sequence time.
// Keyframes live on the media, so on a clip with a speed change one sequence
// second covers `speed` media seconds; ignoring that put the playhead's media
// time nowhere near the keyframes on sped-up clips, so the panel said "Move
// playhead between keyframes" while it was between them (issue #15: verified
// in Premiere 26.0.2, a 200% clip's keyframes sat at srcIn + 2 x clip time).
// getInPoint may report the in-point per sequence second (ExtendScript does:
// 2.5 for a 200% clip trimmed 5 media seconds in), so which one it is gets
// worked out from the in/out span against the clip's length. A reversed clip
// keeps the old mapping (no source to test it against).
async function _clipTiming(clip, clipStart, clipEnd, inRaw) {
  var speed = 1;
  // Both in flight together: every getter is an IPC round trip, and this runs
  // for each candidate clip on every full scan
  var got = await Promise.all([
    Promise.resolve().then(function() { return clip.getSpeed(); }).catch(function() { return 1; }),
    Promise.resolve().then(function() { return clip.isSpeedReversed(); }).catch(function() { return 0; }),
  ]);
  var sp = got[0], rev = got[1];
  if (typeof sp === 'number' && isFinite(sp) && sp > 0 && !rev) speed = sp;
  var srcIn = inRaw;
  if (Math.abs(speed - 1) > 1e-6) {
    var outRaw = null;
    try { var op = await clip.getOutPoint(); if (op && typeof op.seconds === 'number') outRaw = op.seconds; } catch(_) {}
    var durSeq = (clipEnd || 0) - (clipStart || 0);
    if (outRaw !== null && durSeq > 0) {
      var durIn = outRaw - inRaw;
      // in/out a sequence-time span apart: they are scaled, so the media in-point is in x speed
      if (Math.abs(durIn - durSeq) < Math.abs(durIn - durSeq * speed)) srcIn = inRaw * speed;
    }
  }
  return { srcIn: srcIn, speed: speed };
}
// Sequence seconds <-> media seconds for a clip described by tl-like fields
// ({ clipStart, clipIn (media in-point), speed }). speed 1 is the old mapping.
function _toMedia(tl, seqSec) { return (tl.clipIn || 0) + (seqSec - (tl.clipStart || 0)) * (tl.speed || 1); }
function _toSeq(tl, mediaSec) { return (tl.clipStart || 0) + (mediaSec - (tl.clipIn || 0)) / (tl.speed || 1); }


// Get clip start time in sequence (seconds). Keyframe times are clip-local,
// so we need this to convert the sequence playhead into clip-local time.
// Clip end in sequence seconds (the mini timeline's right edge in clip view)
async function _clipEnd(clip) {
  try {
    var et = await clip.getEndTime();
    if (et && typeof et.seconds === 'number') return et.seconds;
  } catch(_) {}
  return 0;
}

// Clip's in-point in media time. KF times from getKeyframeListAsTickTimes() are
// in media time, so we need this to convert the sequence playhead to media time.
async function _clipInPoint(clip) {
  try {
    var ip = await clip.getInPoint();
    if (ip && typeof ip.seconds === 'number') return ip.seconds;
  } catch(_) {}
  return 0;
}


// kp: prefix for the row keys ('a' on an audio clip, see _detectContextFull)
async function _findQualifiedParams(chain, phLocal, kp) {
  kp = kp || '';
  var qualified = [];
  var compCount = 0;
  try { compCount = await _call(chain, 'getComponentCount'); }
  catch(e) { console.log('[OC] getComponentCount failed:', e.message); return qualified; }

  for (var i = 0; i < compCount; i++) {
    var comp;
    try { comp = await _call(chain, 'getComponentAtIndex', i); }
    catch(_) { continue; }

    var matchName = ''; try { matchName = await _call(comp, 'getMatchName'); } catch(_) {}
    var paramCount = 0; try { paramCount = await _call(comp, 'getParamCount'); } catch(_) {}

    for (var j = 0; j < paramCount; j++) {
      var param;
      try { param = await _call(comp, 'getParam', j); }
      catch(_) { continue; }

      var kfTimes = null;
      try { kfTimes = await _call(param, 'getKeyframeListAsTickTimes'); }
      catch(e) {}
      var kfArr = kfTimes ? (Array.isArray(kfTimes) ? kfTimes : Array.from(kfTimes)) : [];
      if (kfArr.length < 2) continue;

      // Find bracket KFs around phLocal; fall back to first/last with isOutside flag
      var kf0 = null, kf1 = null;
      for (var k = 0; k < kfArr.length; k++) {
        if (kfArr[k].seconds <= phLocal)      kf0 = kfArr[k];
        else if (kf1 === null)                kf1 = kfArr[k];
      }
      var isOutside = false;
      if (!kf0 || !kf1) {
        kf0 = kfArr[0]; kf1 = kfArr[kfArr.length - 1]; isOutside = true;
      }

      // Accept both scalar params (Opacity, Scale, Rotation — value is a number)
      // and compound params (Position — value is [x, y]). Skip anything unrecognised.
      var rawVal;
      try { rawVal = await _getValue(param, kf0); } catch(valErr) { continue; }
      var extracted = _extractValue(rawVal);
      if (extracted === null) continue;

      var displayName = _paramName(matchName, j, matchName + ' ' + j);
      var live  = _liveParamName(matchName, j, param);
      var label = live || _fallbackLabel(displayName);
      var kfSecs = [];
      for (var ks = 0; ks < kfArr.length; ks++) kfSecs.push(kfArr[ks].seconds);
      qualified.push({ key: kp+i+'_'+j, displayName: displayName, label: label, live: !!live, matchName: matchName,
                       param: param, comp: comp, paramIdx: j,
                       // val0 is the value at kf0 this loop already read; the bake
                       // context below used to fetch the same value a second time
                       val0: extracted,
                       kf0: kf0, kf1: kf1, totalKf: kfArr.length, isOutside: isOutside, kfSecs: kfSecs });
    }
  }
  await _finishLabels(qualified);
  return qualified;
}

// ─── dumpComponents (debug) ───────────────────────────────────────────────
// Deep probe: enumerates every component, param, clip method, ProjectItem
// chain, and VideoFilterFactory match names to find Time Remapping.
async function _dumpComponents() {
  try {
    var _dumpedParamShape = false;
    if (!ppro) { console.log('[FS] dump: premierepro not loaded'); return; }
    var project = await ppro.Project.getActiveProject();
    if (!project) { console.log('[FS] dump: no active project'); return; }
    var sequence = await project.getActiveSequence();
    if (!sequence) { console.log('[FS] dump: no active sequence'); return; }
    var playerPos = await sequence.getPlayerPosition();
    var ph = playerPos.seconds;

    // Try selected clip first, then track scan
    var found = null;
    try { found = await _clipViaSelection(sequence); } catch(_) {}
    if (!found) {
      var scanned = await _clipsViaTrackScan(sequence, ph);
      if (scanned.length > 0) found = scanned[0];
    }
    if (!found) { console.log('[FS] dump: no clip found at playhead / selection'); return; }

    var clipName = '';
    try { clipName = await found.clip.getName(); } catch(_) {}
    var speed = '';
    try { speed = await found.clip.getSpeed(); } catch(_) {}
    console.log('[FS] ══════════════════════════════════════════════');
    console.log('[FS] COMPONENT DUMP — clip: "' + clipName + '" | speed: ' + speed);
    console.log('[FS] ══════════════════════════════════════════════');

    // ── SECTION 1: TrackItem component chain ──
    console.log('[FS] ── SECTION 1: TrackItem component chain ──');
    var chain = found.chain;
    var compCount = 0;
    try { compCount = await _call(chain, 'getComponentCount'); } catch(_) {}
    console.log('[FS] Component count: ' + compCount);

    for (var i = 0; i < compCount; i++) {
      var comp;
      try { comp = await _call(chain, 'getComponentAtIndex', i); } catch(_) { continue; }
      var matchName = ''; try { matchName = await _call(comp, 'getMatchName'); } catch(_) {}
      var displayName = ''; try { displayName = await _call(comp, 'getDisplayName'); } catch(_) {}
      var paramCount = 0; try { paramCount = await _call(comp, 'getParamCount'); } catch(_) {}
      console.log('[FS] Component[' + i + ']: matchName="' + matchName + '" display="' + displayName + '" params=' + paramCount);
      for (var j = 0; j < paramCount; j++) {
        var param;
        try { param = await _call(comp, 'getParam', j); } catch(_) { continue; }
        // Param name probe. getDisplayName() is a Component method and is NOT a
        // member of ComponentParam, so the call below has always come back empty
        // (that is the "returns empty" note in CLAUDE.md). Premiere 26's own API
        // descriptor, embedded in Frontend.dll, declares ComponentParam with a
        // readOnly string PROPERTY displayName and no getDisplayName method:
        //   "name": "ComponentParam",
        //   "properties": [ { "name": "displayName", "dataType": "string",
        //                     "propType": "readOnly", "propKind": "instance" }, ... ]
        // So read it as a property. If that populates, effect params name
        // themselves and PARAM_NAMES becomes a fallback only.
        var pName = ''; try { pName = await _call(param, 'getDisplayName'); } catch(_) {}
        var pProp = '', pType = '';
        try { pProp = param.displayName; pType = typeof pProp; }
        catch (ePd) { pType = 'threw'; pProp = (ePd && ePd.message) || 'error'; }
        // Harmless if it is a plain string; catches the case where the proxy
        // hands back a promise instead.
        var pAwait = ''; try { pAwait = await param.displayName; } catch(_) {}
        var pMatch = ''; try { pMatch = await _call(param, 'getMatchName'); } catch(_) {}
        var kfSupported = '?'; try { kfSupported = await _call(param, 'areKeyframesSupported'); } catch(_) {}
        var kfTimes = null;
        try { kfTimes = await _call(param, 'getKeyframeListAsTickTimes'); } catch(_) {}
        var kfCount = kfTimes ? (Array.isArray(kfTimes) ? kfTimes.length : 0) : 0;
        console.log('[FS]   Param[' + j + ']: .displayName="' + pProp + '" (' + pType + ')'
          + ' awaited="' + pAwait + '"'
          + ' getDisplayName()="' + pName + '" match="' + pMatch + '"'
          + ' kfOK=' + kfSupported + ' kfs=' + kfCount);
        // One-off member dump: shows what the proxy actually exposes, so a miss
        // above can be told apart from the property being named something else.
        if (!_dumpedParamShape) {
          _dumpedParamShape = true;
          var forIn = []; try { for (var pk in param) forIn.push(pk); } catch(_) {}
          console.log('[FS]   (param shape) for-in: ' + forIn.join(', '));
          try { console.log('[FS]   (param shape) own: ' + Object.getOwnPropertyNames(param).join(', ')); } catch(_) {}
          try { console.log('[FS]   (param shape) proto: ' + Object.getOwnPropertyNames(Object.getPrototypeOf(param)).join(', ')); } catch(_) {}
          try { console.log('[FS]   (param shape) ctor: ' + (param.constructor && param.constructor.name)); } catch(_) {}
        }
      }
    }

    // Also try higher indices beyond reported count (in case count is wrong)
    console.log('[FS] ── Probing beyond reported count ──');
    for (var extra = compCount; extra < compCount + 5; extra++) {
      try {
        var ec = await _call(chain, 'getComponentAtIndex', extra);
        if (ec) {
          var emn = ''; try { emn = await _call(ec, 'getMatchName'); } catch(_) {}
          var edn = ''; try { edn = await _call(ec, 'getDisplayName'); } catch(_) {}
          console.log('[FS] HIDDEN Component[' + extra + ']: matchName="' + emn + '" display="' + edn + '"');
        }
      } catch(_) {}
    }

    // ── SECTION 2: Enumerate ALL methods on clip object ──
    console.log('[FS] ── SECTION 2: All clip object methods ──');
    var clipMethods = [];
    try {
      // Own properties
      var ownKeys = Object.getOwnPropertyNames(found.clip);
      for (var ok = 0; ok < ownKeys.length; ok++) clipMethods.push(ownKeys[ok]);
    } catch(_) {}
    try {
      // Prototype chain
      var proto = Object.getPrototypeOf(found.clip);
      while (proto && proto !== Object.prototype) {
        var protoKeys = Object.getOwnPropertyNames(proto);
        for (var pk = 0; pk < protoKeys.length; pk++) {
          if (clipMethods.indexOf(protoKeys[pk]) < 0) clipMethods.push(protoKeys[pk]);
        }
        proto = Object.getPrototypeOf(proto);
      }
    } catch(_) {}
    try {
      // for...in (catches enumerable + inherited)
      for (var k in found.clip) {
        if (clipMethods.indexOf(k) < 0) clipMethods.push(k);
      }
    } catch(_) {}
    console.log('[FS] Clip methods/props (' + clipMethods.length + '): ' + clipMethods.join(', '));

    // ── SECTION 3: Enumerate ALL methods on chain object ──
    console.log('[FS] ── SECTION 3: All chain object methods ──');
    var chainMethods = [];
    try {
      var ck = Object.getOwnPropertyNames(chain);
      for (var ci2 = 0; ci2 < ck.length; ci2++) chainMethods.push(ck[ci2]);
    } catch(_) {}
    try {
      var cp = Object.getPrototypeOf(chain);
      while (cp && cp !== Object.prototype) {
        var cpk = Object.getOwnPropertyNames(cp);
        for (var ci3 = 0; ci3 < cpk.length; ci3++) {
          if (chainMethods.indexOf(cpk[ci3]) < 0) chainMethods.push(cpk[ci3]);
        }
        cp = Object.getPrototypeOf(cp);
      }
    } catch(_) {}
    try { for (var ck2 in chain) { if (chainMethods.indexOf(ck2) < 0) chainMethods.push(ck2); } } catch(_) {}
    console.log('[FS] Chain methods/props (' + chainMethods.length + '): ' + chainMethods.join(', '));

    // ── SECTION 4: ProjectItem component chain ──
    console.log('[FS] ── SECTION 4: ProjectItem component chain ──');
    try {
      var projItem = await found.clip.getProjectItem();
      if (projItem) {
        console.log('[FS] Got ProjectItem');
        // Enumerate ProjectItem methods
        var piMethods = [];
        try { var pik = Object.getOwnPropertyNames(projItem); for (var pi2 = 0; pi2 < pik.length; pi2++) piMethods.push(pik[pi2]); } catch(_) {}
        try {
          var pip = Object.getPrototypeOf(projItem);
          while (pip && pip !== Object.prototype) {
            var pipk = Object.getOwnPropertyNames(pip);
            for (var pi3 = 0; pi3 < pipk.length; pi3++) { if (piMethods.indexOf(pipk[pi3]) < 0) piMethods.push(pipk[pi3]); }
            pip = Object.getPrototypeOf(pip);
          }
        } catch(_) {}
        try { for (var pi4 in projItem) { if (piMethods.indexOf(pi4) < 0) piMethods.push(pi4); } } catch(_) {}
        console.log('[FS] ProjectItem methods (' + piMethods.length + '): ' + piMethods.join(', '));

        // Try getComponentChain on ProjectItem
        if (typeof projItem.getComponentChain === 'function') {
          var piChain = await projItem.getComponentChain();
          console.log('[FS] ProjectItem.getComponentChain() returned: ' + typeof piChain + ' = ' + JSON.stringify(piChain));
          if (piChain && typeof piChain === 'object') {
            var piCC = 0; try { piCC = await _call(piChain, 'getComponentCount'); } catch(_) {}
            console.log('[FS] ProjectItem chain component count: ' + piCC);
            for (var pi5 = 0; pi5 < piCC; pi5++) {
              var pic = await _call(piChain, 'getComponentAtIndex', pi5);
              var pimn = ''; try { pimn = await _call(pic, 'getMatchName'); } catch(_) {}
              var pidn = ''; try { pidn = await _call(pic, 'getDisplayName'); } catch(_) {}
              console.log('[FS]   PI Component[' + pi5 + ']: matchName="' + pimn + '" display="' + pidn + '"');
            }
          }
        } else {
          console.log('[FS] ProjectItem has no getComponentChain()');
        }
      }
    } catch(e) { console.log('[FS] ProjectItem probe error: ' + e.message); }

    // ── SECTION 5: VideoFilterFactory — all available match names ──
    console.log('[FS] ── SECTION 5: VideoFilterFactory match names ──');
    try {
      var vff = ppro.VideoFilterFactory;
      if (!vff) {
        // Try alternate access
        try { vff = new ppro.VideoFilterFactory(); } catch(_) {}
      }
      if (vff) {
        console.log('[FS] VideoFilterFactory found, type: ' + typeof vff);
        var vffMethods = [];
        try { for (var vk in vff) vffMethods.push(vk); } catch(_) {}
        try { var vok = Object.getOwnPropertyNames(vff); for (var vi = 0; vi < vok.length; vi++) { if (vffMethods.indexOf(vok[vi]) < 0) vffMethods.push(vok[vi]); } } catch(_) {}
        console.log('[FS] VFF methods: ' + vffMethods.join(', '));

        if (typeof vff.getMatchNames === 'function') {
          var allMatchNames = await vff.getMatchNames();
          var mnArr = allMatchNames ? (Array.isArray(allMatchNames) ? allMatchNames : Array.from(allMatchNames)) : [];
          console.log('[FS] All VideoFilter matchNames (' + mnArr.length + '):');
          // Log them and flag anything with "time", "remap", "speed"
          for (var mi = 0; mi < mnArr.length; mi++) {
            var mn = String(mnArr[mi]).toLowerCase();
            var flag = '';
            if (mn.indexOf('time') >= 0 || mn.indexOf('remap') >= 0 || mn.indexOf('speed') >= 0) flag = ' *** POSSIBLE TIME REMAP ***';
            console.log('[FS]   [' + mi + '] ' + mnArr[mi] + flag);
          }
        }
      } else {
        console.log('[FS] VideoFilterFactory not accessible');
      }
    } catch(e) { console.log('[FS] VFF probe error: ' + e.message); }

    // ── SECTION 6: premierepro module exports ──
    console.log('[FS] ── SECTION 6: premierepro module exports ──');
    try {
      var pproKeys = [];
      for (var mk in ppro) pproKeys.push(mk);
      try { var mok = Object.getOwnPropertyNames(ppro); for (var mi2 = 0; mi2 < mok.length; mi2++) { if (pproKeys.indexOf(mok[mi2]) < 0) pproKeys.push(mok[mi2]); } } catch(_) {}
      console.log('[FS] ppro module keys (' + pproKeys.length + '): ' + pproKeys.join(', '));
    } catch(e) { console.log('[FS] module probe error: ' + e.message); }

    // ── SECTION 7: ComponentFactory (undocumented — may expose intrinsic components) ──
    console.log('[FS] ── SECTION 7: ComponentFactory probe ──');
    try {
      var cf = ppro.ComponentFactory;
      console.log('[FS] ComponentFactory type: ' + typeof cf);
      if (cf) {
        var cfMethods = [];
        try { for (var cfk in cf) cfMethods.push(cfk); } catch(_) {}
        try { var cfok = Object.getOwnPropertyNames(cf); for (var cfi = 0; cfi < cfok.length; cfi++) { if (cfMethods.indexOf(cfok[cfi]) < 0) cfMethods.push(cfok[cfi]); } } catch(_) {}
        try {
          var cfp = Object.getPrototypeOf(cf);
          while (cfp && cfp !== Object.prototype && cfp !== Function.prototype) {
            var cfpk = Object.getOwnPropertyNames(cfp);
            for (var cfj = 0; cfj < cfpk.length; cfj++) { if (cfMethods.indexOf(cfpk[cfj]) < 0) cfMethods.push(cfpk[cfj]); }
            cfp = Object.getPrototypeOf(cfp);
          }
        } catch(_) {}
        console.log('[FS] ComponentFactory methods: ' + cfMethods.join(', '));

        // Try getMatchNames
        if (typeof cf.getMatchNames === 'function') {
          var cfNames = await cf.getMatchNames();
          var cfArr = cfNames ? (Array.isArray(cfNames) ? cfNames : Array.from(cfNames)) : [];
          console.log('[FS] ComponentFactory matchNames (' + cfArr.length + '):');
          for (var cfmi = 0; cfmi < cfArr.length; cfmi++) {
            var cfmn = String(cfArr[cfmi]).toLowerCase();
            var cfFlag = '';
            if (cfmn.indexOf('time') >= 0 || cfmn.indexOf('remap') >= 0 || cfmn.indexOf('speed') >= 0) cfFlag = ' *** MATCH ***';
            console.log('[FS]   [' + cfmi + '] ' + cfArr[cfmi] + cfFlag);
          }
        }
        // Try createComponent with known Time Remap matchNames
        var tryCandidates = [
          'AE.ADBE Time Remapping', 'ADBE Time Remapping', 'PR.ADBE Time Remapping',
          'AE.ADBE Time Remap', 'ADBE Time Remap', 'PR.ADBE Time Remap',
          'Time Remapping', 'TimeRemapping', 'Speed',
          'AE.ADBE Speed', 'PR.ADBE Speed', 'ADBE Speed'
        ];
        if (typeof cf.createComponent === 'function') {
          for (var tri = 0; tri < tryCandidates.length; tri++) {
            try {
              var trComp = await cf.createComponent(tryCandidates[tri]);
              if (trComp) {
                console.log('[FS]   ComponentFactory.createComponent("' + tryCandidates[tri] + '") SUCCEEDED: ' + typeof trComp);
                try {
                  var trMn = await _call(trComp, 'getMatchName');
                  var trDn = await _call(trComp, 'getDisplayName');
                  var trPc = await _call(trComp, 'getParamCount');
                  console.log('[FS]     matchName="' + trMn + '" display="' + trDn + '" params=' + trPc);
                } catch(_) {}
              }
            } catch(e) {
              console.log('[FS]   ComponentFactory.createComponent("' + tryCandidates[tri] + '") → ' + e.message);
            }
          }
        }
      }
    } catch(e) { console.log('[FS] ComponentFactory probe error: ' + e.message); }

    // ── SECTION 8: ClipProjectItem — cast and get its component chain ──
    console.log('[FS] ── SECTION 8: ClipProjectItem probe ──');
    try {
      var projItem2 = await found.clip.getProjectItem();
      var cpi = ppro.ClipProjectItem;

      // Cast ProjectItem → ClipProjectItem
      var castItem = null;
      if (cpi && typeof cpi.cast === 'function') {
        try { castItem = await cpi.cast(projItem2); console.log('[FS] cast() succeeded: ' + typeof castItem); } catch(e) { console.log('[FS] cast() threw: ' + e.message); }
      }
      if (!castItem && cpi && typeof cpi.queryCast === 'function') {
        try { castItem = await cpi.queryCast(projItem2); console.log('[FS] queryCast() succeeded: ' + typeof castItem); } catch(e) { console.log('[FS] queryCast() threw: ' + e.message); }
      }

      var target = castItem || projItem2;
      if (target) {
        // Enumerate methods on the cast object
        var castMethods = [];
        try { for (var cmk in target) castMethods.push(cmk); } catch(_) {}
        try { var cmok = Object.getOwnPropertyNames(target); for (var cmi = 0; cmi < cmok.length; cmi++) { if (castMethods.indexOf(cmok[cmi]) < 0) castMethods.push(cmok[cmi]); } } catch(_) {}
        try {
          var cmp = Object.getPrototypeOf(target);
          while (cmp && cmp !== Object.prototype) {
            var cmpk = Object.getOwnPropertyNames(cmp);
            for (var cmj = 0; cmj < cmpk.length; cmj++) { if (castMethods.indexOf(cmpk[cmj]) < 0) castMethods.push(cmpk[cmj]); }
            cmp = Object.getPrototypeOf(cmp);
          }
        } catch(_) {}
        console.log('[FS] Cast item methods (' + castMethods.length + '): ' + castMethods.join(', '));

        // Try getComponentChain on the cast item
        if (typeof target.getComponentChain === 'function') {
          console.log('[FS] Cast item HAS getComponentChain!');

          // First get content type
          try {
            var contentType = await target.getContentType();
            console.log('[FS] getContentType() = ' + JSON.stringify(contentType));
          } catch(e_ct) { console.log('[FS] getContentType() threw: ' + (e_ct ? (e_ct.message || e_ct.toString()) : 'undefined')); }

          // Get Guid and other objects to try as arguments
          var mediaTypeGuid = null;
          try { mediaTypeGuid = await found.clip.getMediaType(); console.log('[FS] clip.getMediaType() = ' + JSON.stringify(mediaTypeGuid)); } catch(_) {}
          var projItemId = null;
          try { var pi = await found.clip.getProjectItem(); projItemId = await pi.getId(); console.log('[FS] projectItem.getId() = ' + JSON.stringify(projItemId)); } catch(_) {}

          // Try constructing Guid objects
          var guidObj = null;
          try { guidObj = new ppro.Guid(); console.log('[FS] new Guid() = ' + JSON.stringify(guidObj)); } catch(eg) { console.log('[FS] new Guid() threw: ' + (eg ? eg.message : '')); }
          var guidObj2 = null;
          try { guidObj2 = new ppro.Guid('video'); console.log('[FS] new Guid("video") = ' + JSON.stringify(guidObj2)); } catch(eg2) { console.log('[FS] new Guid("video") threw: ' + (eg2 ? eg2.message : '')); }

          // Try getComponentChain with everything we have
          var tryArgs = [
            { label: 'mediaTypeGuid', args: [mediaTypeGuid] },
            { label: 'projItemId', args: [projItemId] },
          ];
          if (guidObj) tryArgs.push({ label: 'new Guid()', args: [guidObj] });
          if (guidObj2) tryArgs.push({ label: 'new Guid("video")', args: [guidObj2] });
          // Also try with two arguments — maybe it needs (trackItem, type) or similar
          tryArgs.push({ label: 'clip + 0', args: [found.clip, 0] });
          tryArgs.push({ label: 'clip + 1', args: [found.clip, 1] });
          tryArgs.push({ label: '1, clip', args: [1, found.clip] });
          tryArgs.push({ label: 'mediaTypeGuid + clip', args: [mediaTypeGuid, found.clip] });
          var piChain = null;
          for (var tai = 0; tai < tryArgs.length; tai++) {
            try {
              var taResult = await target.getComponentChain.apply(target, tryArgs[tai].args);
              console.log('[FS] getComponentChain(' + tryArgs[tai].label + ') → type=' + typeof taResult + ' value=' + JSON.stringify(taResult).substring(0, 200));
              if (taResult && !piChain) piChain = taResult;
            } catch(e_ta) {
              console.log('[FS] getComponentChain(' + tryArgs[tai].label + ') THREW: ' + (e_ta ? (e_ta.message || e_ta.toString()) : 'undefined'));
            }
          }
          if (piChain && typeof piChain === 'object') {
            // Enumerate chain methods
            var piChainMethods = [];
            try { for (var pck in piChain) piChainMethods.push(pck); } catch(_) {}
            try { var pcok = Object.getOwnPropertyNames(piChain); for (var pci = 0; pci < pcok.length; pci++) { if (piChainMethods.indexOf(pcok[pci]) < 0) piChainMethods.push(pcok[pci]); } } catch(_) {}
            try {
              var pcp = Object.getPrototypeOf(piChain);
              while (pcp && pcp !== Object.prototype) {
                var pcpk = Object.getOwnPropertyNames(pcp);
                for (var pcj = 0; pcj < pcpk.length; pcj++) { if (piChainMethods.indexOf(pcpk[pcj]) < 0) piChainMethods.push(pcpk[pcj]); }
                pcp = Object.getPrototypeOf(pcp);
              }
            } catch(_) {}
            console.log('[FS] PI chain methods: ' + piChainMethods.join(', '));

            var piCC = 0;
            try { piCC = await _call(piChain, 'getComponentCount'); } catch(e3) { console.log('[FS] PI chain getComponentCount error: ' + (e3 ? e3.message : 'undefined')); }
            console.log('[FS] ClipProjectItem chain component count: ' + piCC);
            for (var pi5 = 0; pi5 < piCC; pi5++) {
              try {
                var pic = await _call(piChain, 'getComponentAtIndex', pi5);
                var pimn = ''; try { pimn = await _call(pic, 'getMatchName'); } catch(_) {}
                var pidn = ''; try { pidn = await _call(pic, 'getDisplayName'); } catch(_) {}
                var pipc = 0; try { pipc = await _call(pic, 'getParamCount'); } catch(_) {}
                var flag = '';
                var pimnLower = pimn.toLowerCase();
                if (pimnLower.indexOf('time') >= 0 || pimnLower.indexOf('remap') >= 0 || pimnLower.indexOf('speed') >= 0) flag = ' *** POSSIBLE TIME REMAP ***';
                console.log('[FS]   PI Component[' + pi5 + ']: matchName="' + pimn + '" display="' + pidn + '" params=' + pipc + flag);
                for (var pij = 0; pij < pipc; pij++) {
                  try {
                    var pip2 = await _call(pic, 'getParam', pij);
                    var pipn = ''; try { pipn = await _call(pip2, 'getDisplayName'); } catch(_) {}
                    var pipm = ''; try { pipm = await _call(pip2, 'getMatchName'); } catch(_) {}
                    var pikf = '?'; try { pikf = await _call(pip2, 'areKeyframesSupported'); } catch(_) {}
                    var pikt = null; try { pikt = await _call(pip2, 'getKeyframeListAsTickTimes'); } catch(_) {}
                    var pikc = pikt ? (Array.isArray(pikt) ? pikt.length : 0) : 0;
                    console.log('[FS]     Param[' + pij + ']: display="' + pipn + '" match="' + pipm + '" kfOK=' + pikf + ' kfs=' + pikc);
                  } catch(_) {}
                }
              } catch(e4) { console.log('[FS]   PI Component[' + pi5 + '] error: ' + (e4 ? e4.message : 'undefined')); }
            }
          } else if (piChain && typeof piChain === 'string') {
            console.log('[FS] ClipProjectItem chain is a STRING: "' + piChain + '"');
          } else {
            console.log('[FS] ClipProjectItem chain falsy or unexpected type');
          }
        } else {
          console.log('[FS] Cast item does NOT have getComponentChain');
        }

        // Try getMedia() on the cast ClipProjectItem
        console.log('[FS] ── Probing ClipProjectItem.getMedia() ──');
        try {
          if (typeof target.getMedia === 'function') {
            var media = await target.getMedia();
            console.log('[FS] getMedia() type: ' + typeof media + ' truthy: ' + !!media);
            if (media) {
              var mediaMethods = [];
              try { for (var mdk in media) mediaMethods.push(mdk); } catch(_) {}
              try { var mdok = Object.getOwnPropertyNames(media); for (var mdi = 0; mdi < mdok.length; mdi++) { if (mediaMethods.indexOf(mdok[mdi]) < 0) mediaMethods.push(mdok[mdi]); } } catch(_) {}
              try {
                var mdp = Object.getPrototypeOf(media);
                while (mdp && mdp !== Object.prototype) {
                  var mdpk = Object.getOwnPropertyNames(mdp);
                  for (var mdpi = 0; mdpi < mdpk.length; mdpi++) { if (mediaMethods.indexOf(mdpk[mdpi]) < 0) mediaMethods.push(mdpk[mdpi]); }
                  mdp = Object.getPrototypeOf(mdp);
                }
              } catch(_) {}
              console.log('[FS] Media methods (' + mediaMethods.length + '): ' + mediaMethods.join(', '));
              // Try getComponentChain on media
              if (typeof media.getComponentChain === 'function') {
                console.log('[FS] Media HAS getComponentChain!');
                try {
                  var mediaChain = await media.getComponentChain();
                  console.log('[FS] Media chain: ' + typeof mediaChain);
                } catch(e_mc) { console.log('[FS] Media.getComponentChain() threw: ' + (e_mc ? (e_mc.message || e_mc.toString()) : '')); }
              }
            }
          }
        } catch(e_med) { console.log('[FS] getMedia() error: ' + (e_med ? e_med.message : '')); }

        // Also try clip.getMatchName()
        try {
          var clipMN = await found.clip.getMatchName();
          console.log('[FS] clip.getMatchName() = "' + clipMN + '"');
        } catch(e5) { console.log('[FS] clip.getMatchName() threw: ' + (e5 ? e5.message : 'undefined')); }
      }
    } catch(e) { console.log('[FS] ClipProjectItem probe error: ' + (e ? (e.message || e.toString()) : 'undefined')); }

    // ── SECTION 9: Negative / special chain indices ──
    console.log('[FS] ── SECTION 9: Special chain indices ──');
    try {
      var specialIdx = [-1, -2, -3, 100, 999];
      for (var sii = 0; sii < specialIdx.length; sii++) {
        try {
          var scomp = await _call(chain, 'getComponentAtIndex', specialIdx[sii]);
          if (scomp) {
            var smn = ''; try { smn = await _call(scomp, 'getMatchName'); } catch(_) {}
            var sdn = ''; try { sdn = await _call(scomp, 'getDisplayName'); } catch(_) {}
            console.log('[FS] chain[' + specialIdx[sii] + ']: matchName="' + smn + '" display="' + sdn + '"');
          } else {
            console.log('[FS] chain[' + specialIdx[sii] + ']: null');
          }
        } catch(e) { console.log('[FS] chain[' + specialIdx[sii] + '] threw: ' + (e ? e.message : '')); }
      }
    } catch(_) {}

    // ── SECTION 10: VideoClipTrackItem.cast() — might reveal extra methods ──
    console.log('[FS] ── SECTION 10: VideoClipTrackItem cast + SequenceUtils/Application/Utils ──');
    try {
      var vcti = ppro.VideoClipTrackItem;
      if (vcti && typeof vcti.cast === 'function') {
        var castClip = await vcti.cast(found.clip);
        if (castClip) {
          var ccMethods = [];
          try { for (var cck in castClip) ccMethods.push(cck); } catch(_) {}
          try {
            var ccpro = Object.getPrototypeOf(castClip);
            while (ccpro && ccpro !== Object.prototype) {
              var ccpk = Object.getOwnPropertyNames(ccpro);
              for (var ccpi = 0; ccpi < ccpk.length; ccpi++) { if (ccMethods.indexOf(ccpk[ccpi]) < 0) ccMethods.push(ccpk[ccpi]); }
              ccpro = Object.getPrototypeOf(ccpro);
            }
          } catch(_) {}
          console.log('[FS] VideoClipTrackItem.cast() methods (' + ccMethods.length + '): ' + ccMethods.join(', '));
        }
      } else {
        console.log('[FS] VideoClipTrackItem has no cast()');
      }
    } catch(e) { console.log('[FS] VCTI cast error: ' + (e ? e.message : '')); }

    // Probe SequenceUtils
    try {
      var su = ppro.SequenceUtils;
      console.log('[FS] SequenceUtils type: ' + typeof su);
      if (su) {
        var suMethods = [];
        try { for (var suk in su) suMethods.push(suk); } catch(_) {}
        try { var suok = Object.getOwnPropertyNames(su); for (var sui = 0; sui < suok.length; sui++) { if (suMethods.indexOf(suok[sui]) < 0) suMethods.push(suok[sui]); } } catch(_) {}
        try { if (su.prototype) { var supk = Object.getOwnPropertyNames(su.prototype); for (var supi = 0; supi < supk.length; supi++) { if (suMethods.indexOf(supk[supi]) < 0) suMethods.push(supk[supi]); } } } catch(_) {}
        console.log('[FS] SequenceUtils methods: ' + suMethods.join(', '));
      }
    } catch(_) {}

    // Probe Application
    try {
      var app = ppro.Application;
      console.log('[FS] Application type: ' + typeof app);
      if (app) {
        var appMethods = [];
        try { for (var ak in app) appMethods.push(ak); } catch(_) {}
        try { var aok = Object.getOwnPropertyNames(app); for (var ai = 0; ai < aok.length; ai++) { if (appMethods.indexOf(aok[ai]) < 0) appMethods.push(aok[ai]); } } catch(_) {}
        try { if (app.prototype) { var apk = Object.getOwnPropertyNames(app.prototype); for (var api2 = 0; api2 < apk.length; api2++) { if (appMethods.indexOf(apk[api2]) < 0) appMethods.push(apk[api2]); } } } catch(_) {}
        console.log('[FS] Application methods: ' + appMethods.join(', '));
      }
    } catch(_) {}

    // Probe Utils
    try {
      var ut = ppro.Utils;
      console.log('[FS] Utils type: ' + typeof ut);
      if (ut) {
        var utMethods = [];
        try { for (var uk in ut) utMethods.push(uk); } catch(_) {}
        try { var uok = Object.getOwnPropertyNames(ut); for (var ui = 0; ui < uok.length; ui++) { if (utMethods.indexOf(uok[ui]) < 0) utMethods.push(uok[ui]); } } catch(_) {}
        try { if (ut.prototype) { var upk = Object.getOwnPropertyNames(ut.prototype); for (var upi = 0; upi < upk.length; upi++) { if (utMethods.indexOf(upk[upi]) < 0) utMethods.push(upk[upi]); } } } catch(_) {}
        console.log('[FS] Utils methods: ' + utMethods.join(', '));
      }
    } catch(_) {}

    // Probe Component class for static methods
    try {
      var compClass = ppro.Component;
      console.log('[FS] Component class type: ' + typeof compClass);
      if (compClass) {
        var compClassMethods = [];
        try { for (var cck2 in compClass) compClassMethods.push(cck2); } catch(_) {}
        try { var ccok = Object.getOwnPropertyNames(compClass); for (var cci = 0; cci < ccok.length; cci++) { if (compClassMethods.indexOf(ccok[cci]) < 0) compClassMethods.push(ccok[cci]); } } catch(_) {}
        try { if (compClass.prototype) { var ccpk2 = Object.getOwnPropertyNames(compClass.prototype); for (var ccpi2 = 0; ccpi2 < ccpk2.length; ccpi2++) { if (compClassMethods.indexOf(ccpk2[ccpi2]) < 0) compClassMethods.push(ccpk2[ccpi2]); } } } catch(_) {}
        console.log('[FS] Component class methods: ' + compClassMethods.join(', '));
      }
    } catch(_) {}

    // Probe SequenceEditor
    try {
      var se = ppro.SequenceEditor;
      console.log('[FS] SequenceEditor type: ' + typeof se);
      if (se) {
        var seMethods = [];
        try { for (var sek in se) seMethods.push(sek); } catch(_) {}
        try { var seok = Object.getOwnPropertyNames(se); for (var sei = 0; sei < seok.length; sei++) { if (seMethods.indexOf(seok[sei]) < 0) seMethods.push(seok[sei]); } } catch(_) {}
        try { if (se.prototype) { var sepk = Object.getOwnPropertyNames(se.prototype); for (var sepi = 0; sepi < sepk.length; sepi++) { if (seMethods.indexOf(sepk[sepi]) < 0) seMethods.push(sepk[sepi]); } } } catch(_) {}
        console.log('[FS] SequenceEditor methods: ' + seMethods.join(', '));
      }
    } catch(_) {}

    console.log('[FS] ══════════════════════════════════════════════');
    console.log('[FS] DUMP COMPLETE');
    console.log('[FS] ══════════════════════════════════════════════');
  } catch(e) {
    console.error('[FS] dump error:', e);
  }
}

// ─── detectContext ────────────────────────────────────────────────────────
// Start of the keyframe pair with a real (2+ frame) span nearest the playhead,
// and the playhead's distance from it. Media seconds in and out.
function _nearestPair(kfSecs, phLocal, fps) {
  var best = null;
  for (var i = 0; i + 1 < (kfSecs || []).length; i++) {
    var a = kfSecs[i], b = kfSecs[i + 1];
    if ((b - a) * fps < 1.5) continue; // one-frame pair (already baked)
    var d = phLocal < a ? a - phLocal : (phLocal > b ? phLocal - b : 0);
    if (!best || d < best.dist) best = { start: a, dist: d };
  }
  return best;
}

// Pin button target: the nearest 2+ frame pair when the playhead is outside every
// pair, otherwise the pair after the one it is in (wrapping to the first), so
// repeated presses walk through every keyframed area on the clip
function _jumpPair(kfSecs, phLocal, fps) {
  var pairs = [];
  for (var i = 0; i + 1 < (kfSecs || []).length; i++) {
    if ((kfSecs[i + 1] - kfSecs[i]) * fps >= 1.5) pairs.push({ start: kfSecs[i], end: kfSecs[i + 1] });
  }
  if (!pairs.length) return null;
  for (var j = 0; j < pairs.length; j++) {
    if (phLocal >= pairs[j].start - 1e-4 && phLocal < pairs[j].end - 1e-4) return pairs[(j + 1) % pairs.length];
  }
  return _nearestPair(kfSecs, phLocal, fps);
}

async function _detectContextFull(project, sequence, ph, selItems) {
  var recFloor = _bakeSeq; // records newer than this scan aren't judged by it

  // In-point, media in-point and speed of a candidate clip, then its keyframed
  // properties around the playhead's media time. Audio rows get keys starting
  // with 'a', so a linked clip's two parts never share a row key.
  async function tryClip(c) {
    c.clipIn = await _clipInPoint(c.clip); // the raw value: part of the bake records' clip identity
    var end  = typeof c.clipEnd === 'number' ? c.clipEnd : await _clipEnd(c.clip);
    c.clipEnd = end;
    var tm   = await _clipTiming(c.clip, c.clipStart || 0, end, c.clipIn);
    c.srcIn  = tm.srcIn;
    c.speed  = tm.speed;
    var phLocal = _toMedia({ clipStart: c.clipStart || 0, clipIn: c.srcIn, speed: c.speed }, ph);
    return await _findQualifiedParams(c.chain, phLocal, c.isAudio ? 'a' : '');
  }
  function anyHere(qp) { return qp.some(function(p) { return !p.isOutside; }); }
  // The first candidate whose keyframes surround the playhead, else the first
  // with any keyframed property: { qp, c } or null
  async function pick(cands) {
    var fb = null;
    for (var i = 0; i < cands.length; i++) {
      var qp = await tryClip(cands[i]);
      if (!qp.length) continue;
      if (anyHere(qp)) return { qp: qp, c: cands[i] };
      if (!fb) fb = { qp: qp, c: cands[i] };
    }
    return fb;
  }

  // 1. The selected clips first (fast path, avoids the track scan). selItems
  // comes from detectContext, which has already fetched it this poll.
  var selc = { here: [], elsewhere: null };
  try { selc = await _selCandidates(sequence, selItems, ph); } catch(_) {}
  var sels = selc.here.length ? selc.here : (selc.elsewhere ? [selc.elsewhere] : []);
  // A selected VIDEO clip is respected: no other clip's keyframes are shown.
  var respectSel = sels.some(function(c) { return !c.isAudio; });
  var parts = [];
  var scanned = [];
  if (respectSel) {
    // The selected video clip and the selected audio clip (a linked clip
    // selects both) each give their rows, video first. Until 2026-11-23 only
    // one did, whichever had a pair around the playhead, so clicking along a
    // clip with Scale and Volume keyframes flipped the rows between the two.
    // Among several selected clips of one kind, one whose keyframes surround
    // the playhead still beats one whose keyframes are all elsewhere.
    var pv = await pick(sels.filter(function(c) { return !c.isAudio; }));
    var pa = await pick(sels.filter(function(c) { return c.isAudio; }));
    if (pv) parts.push(pv);
    if (pa) parts.push(pa);
  } else {
    // A selected audio clip alone isn't respected that way: a music bed left
    // selected would otherwise hide every keyframed video clip. It wins while
    // the playhead is inside one of its keyframe pairs; otherwise the video
    // tracks are scanned exactly as before 2.0.2 (the topmost clip under the
    // playhead with a keyframed property wins), and it is the fallback.
    var pa2 = await pick(sels);
    if (pa2 && anyHere(pa2.qp)) parts.push(pa2);
    else {
      try { scanned = await _clipsViaTrackScan(sequence, ph); } catch(_) {}
      for (var ci = 0; ci < scanned.length; ci++) {
        var sqp = await tryClip(scanned[ci]);
        if (sqp.length > 0) { parts.push({ qp: sqp, c: scanned[ci] }); break; }
      }
      if (!parts.length && pa2) parts.push(pa2);
    }
  }

  // No clips found at playhead at all
  if (!sels.length && scanned.length === 0) {
    return { status: 'no-clip', availableParams: [], hint: 'No clip found at playhead position' };
  }
  if (!parts.length) {
    return { status: 'no-keyframes', availableParams: [], hint: 'No property with 2+ keyframes found on clips at playhead.' };
  }

  var seqKey = '';
  try { seqKey = String(sequence.guid || ''); } catch(_) {}
  var fps = await _fps(sequence);
  var clipId = '', clipName = '', tlInfo = null, firstHere = null, hintP = null;
  var paramList = [], validParams = [], retireList = [], paramContexts = {};
  for (var pi = 0; pi < parts.length; pi++) {
    var found = parts[pi].c, qp = parts[pi].qp;
    // Identity for bake records (per-row undo). Name + in-point survive moving
    // the clip around the timeline, unlike start/end. The UXP API has no stable
    // clip id, so a copy of the clip shares this identity; the records are also
    // checked against the property's actual keyframes (see _bakedKeysFor),
    // which limits any mix-up to copies that carry the same baked keyframes.
    // A linked clip's video and audio parts share it too: their row keys differ.
    var pIn = typeof found.clipIn === 'number' ? found.clipIn : await _clipInPoint(found.clip);
    var pName = '';
    try { pName = String((await found.clip.getName()) || ''); } catch(_) {}
    var pId = seqKey + '|' + (pName || '?') + '|' + pIn.toFixed(4);
    // Keyframe times are media time. pTl maps them to sequence time and back
    // (_toSeq / _toMedia, which account for a speed change), and mfps is frames
    // per media second, for counting frames between keyframes.
    var speed = found.speed || 1;
    var mfps  = fps / speed;
    var pEnd  = typeof found.clipEnd === 'number' ? found.clipEnd : await _clipEnd(found.clip);
    var pTl   = { clipStart: found.clipStart || 0, clipEnd: pEnd,
                  clipIn: typeof found.srcIn === 'number' ? found.srcIn : pIn, speed: speed, fps: fps, ph: ph };
    // Mini timeline: the extent of every clip the rows come from, and the
    // playhead, in sequence seconds; clipIn / speed are the first clip's
    if (!tlInfo) { tlInfo = Object.assign({}, pTl); clipId = pId; clipName = pName; }
    else {
      if (pTl.clipStart < tlInfo.clipStart) tlInfo.clipStart = pTl.clipStart;
      if (pTl.clipEnd > tlInfo.clipEnd) tlInfo.clipEnd = pTl.clipEnd;
    }
    var phMedia = _toMedia(pTl, ph);
    var seq = (function(tl) { return function(t) { return _toSeq(tl, t); }; })(pTl);
    var rows = qp.map(function(p) {
      // _param: live handle for the row undo button (a proxy kept from bake time can go stale)
      // _kf0/_kf1/_out: the playhead's bracket, so bake records only colour the row while it sits inside their span
      // clipId / _tlP / clipT: the row's own clip (its records, its time mapping)
      var jp = _jumpPair(p.kfSecs, phMedia, mfps);
      var entry = { key: p.key, displayName: p.displayName, label: p.label, jumpSec: seq(jp ? jp.start : p.kf0.seconds),
                    clipId: pId, _tlP: pTl, clipT: [pTl.clipStart, pTl.clipIn, speed],
                    _param: p.param, _kf: p.kfSecs, _kf0: p.kf0.seconds, _kf1: p.kf1.seconds, _out: !!p.isOutside,
                    _fc: Math.round((p.kf1.seconds - p.kf0.seconds) * mfps),
                    // Mini timeline lane: keyframes and the bracket in sequence seconds
                    tlKf: p.kfSecs.map(seq),
                    tlKf0: seq(p.kf0.seconds), tlKf1: seq(p.kf1.seconds), tlOut: !!p.isOutside };
      // Nearest 2+ frame pair, for the status strip's click-to-jump
      var near = _nearestPair(p.kfSecs, phMedia, mfps);
      if (near) { entry.nearSec = seq(near.start); entry.nearDist = near.dist / speed; }
      return entry;
    });
    // Which bake records hold on each row (times and values, see _evalRecords);
    // also lists records whose bake is gone from every clip that shared it
    var hereInfo = { start: found.clipStart || 0, trackIdx: found.trackIdx, isAudio: !!found.isAudio };
    if (!firstHere) firstHere = hereInfo;
    retireList = retireList.concat(await _evalRecords(pId, rows, sequence, hereInfo, recFloor));
    var vps = qp.filter(function(p) { return !p.isOutside; });
    for (var vi = 0; vi < vps.length; vi++) {
      var vp   = vps[vi];
      // val0 came back with the qualified entry; only the second value is new,
      // and the two used to be fetched one after the other
      var val0 = vp.val0 !== undefined ? vp.val0 : _extractValue(await _getValue(vp.param, vp.kf0));
      var val1 = _extractValue(await _getValue(vp.param, vp.kf1));
      var fc   = Math.round((vp.kf1.seconds - vp.kf0.seconds) * mfps);
      // fps here is frames per MEDIA second (the bake steps through media time),
      // which is the sequence rate divided by the clip's speed
      paramContexts[vp.key] = {
        param: vp.param, kf0: vp.kf0, kf1: vp.kf1,
        val0: val0, val1: val1, frameCount: fc, displayName: vp.displayName, key: vp.key,
        project: project, sequence: sequence, clip: found.clip, clipId: pId, fps: mfps, isAudio: !!found.isAudio,
        place: { start: found.clipStart || 0, trackIdx: found.trackIdx, isAudio: !!found.isAudio },
      };
    }
    // A pair inside a live bake record is that bake's own keyframes (2+ frames
    // apart when it was written with a wider spacing), so it isn't bakeable again
    _bakedKeysFor(pId, rows).forEach(function(k) { delete paramContexts[k]; });
    // For the hint: a property with a real (2+ frame) range. A baked
    // property's one-frame pairs would otherwise give a useless "302.35s – 302.36s".
    for (var hi = 0; hi < qp.length && !hintP; hi++) {
      if ((qp[hi].kf1.seconds - qp[hi].kf0.seconds) * mfps >= 2) hintP = qp[hi];
    }
    paramList = paramList.concat(rows);
    validParams = validParams.concat(vps);
  }
  function withRetire(o) { o._retire = retireList; o._retireSeq = sequence; o._retireHere = firstHere; return o; }

  if (validParams.length === 0) {
    if (!hintP) hintP = parts[0].qp[0];
    return withRetire({
      status: 'outside', availableParams: paramList, validParamKeys: [], clipId: clipId, clipName: clipName, tl: tlInfo,
      hint: 'Move playhead between keyframes (' + hintP.kf0.seconds.toFixed(2) + 's – ' + hintP.kf1.seconds.toFixed(2) + 's)',
    });
  }
  var validParamKeys = validParams
    .filter(function(p){ return paramContexts[p.key] && paramContexts[p.key].frameCount >= 2; })
    .map(function(p){ return p.key; });

  if (validParamKeys.length === 0) {
    // Playhead is inside keyframe pairs, but every pair is one a previous bake
    // left behind (a frame apart, or inside a bake record). Nothing here can be
    // eased again, so say so instead of reporting "valid" with nothing to bake.
    return withRetire({
      status: 'outside', availableParams: paramList, validParamKeys: [], clipId: clipId, clipName: clipName, tl: tlInfo,
      hint: 'Already baked here. Move the playhead to an unbaked keyframe pair',
    });
  }

  var firstCtx  = paramContexts[validParamKeys[0]];
  var hintFrames = firstCtx ? firstCtx.frameCount + ' frames' : '';
  var selectionHint = parts[0].c.viaSelection ? ' (selected clip)' : '';

  return withRetire({
    status: 'valid',
    availableParams: paramList,
    validParamKeys: validParamKeys,
    clipId: clipId,
    clipName: clipName,
    tl: tlInfo,
    paramContexts: paramContexts,
    hint: hintFrames + selectionHint,
  });
}

async function detectContext() {
  _dbgKind = 'early';
  try {
    if (!ppro) return { status: 'error', availableParams: [], hint: 'premierepro module not loaded' };

    var project = await ppro.Project.getActiveProject();
    if (!project) { _invalidateCache(); return { status: 'no-project', availableParams: [], hint: '' }; }

    var sequence = await project.getActiveSequence();
    if (!sequence) { _invalidateCache(); return { status: 'no-sequence', availableParams: [], hint: '' }; }

    // Invalidate caches if the active sequence changed
    var seqGuid = sequence.guid || null;
    if (seqGuid !== _cache.sequenceGuid) {
      console.log('[FS] sequence changed:', _cache.sequenceGuid, '→', seqGuid);
      _invalidateCache();
      _cache.sequenceGuid = seqGuid;
      _cache.fps = null; // force fps re-detection for new sequence
    }

    var playerPos = await sequence.getPlayerPosition();
    var ph = playerPos.seconds;

    // Scanning continues during playback (the 1.x "pause while playing"
    // option was removed in 2.0.0; every moved playhead gets a scan).
    // NOTE: don't write ph into _cache.playhead here. Doing so made the cache
    // check below think the playhead was static, so a move never triggered a
    // rescan and the UI only caught up on the 1s heartbeat (bug in <= 1.2.3).
    var moved = (_cache.playhead !== null && ph !== _cache.playhead);

    // The selection is fetched once per poll and its identities read in
    // parallel. The cache check, the snapshot and _clipViaSelection each used to
    // fetch it again and re-read the same names and times one after another:
    // about 2 + 3N sequential round trips on an idle tick, three times that when
    // the selection changed.
    var selItems = null, selIds = null;
    try {
      selItems = await _getSelectionItems(sequence);
      selIds   = await _selIdentities(selItems);
    } catch(_) { selItems = null; selIds = null; }
    var selCount = selIds ? selIds.length : 0;
    var selId    = selCount > 0 ? selIds.join('+') : null;

    // If playhead hasn't moved, check if selection changed before returning cache
    _cache.pollCount++;
    if (!moved && _cache.lastResult && _cache.pollCount < HEARTBEAT_POLLS) {
      var selChanged = (selCount !== _cache.selItemCount) || (selCount > 0 && selId !== _cache.selClipId);
      if (!selChanged) { _dbgKind = 'cache'; return _cache.lastResult; }
      _cache.pollCount = 0;
    }

    _cache.playhead = ph;
    _cache.pollCount = 0;

    // Snapshot selection identity for future change detection
    _cache.selItemCount = selCount;
    _cache.selClipId    = selId;

    var _tFull = Date.now();
    var result = await _detectContextFull(project, sequence, ph, selItems);
    _dbgKind = 'full'; _dbgFullMs = Date.now() - _tFull;
    _cache.lastResult   = result;
    return result;

  } catch(err) {
    _dbgKind = 'error';
    console.error('[FS] detectContext threw:', err);
    _invalidateCache();
    return { status: 'error', availableParams: [], hint: err && err.message ? err.message : String(err) };
  }
}

// ─── bakeKeyframes ────────────────────────────────────────────────────────
// Accepts an array of contexts (one per selected param) and bakes all in one transaction.
//
// Premiere 26.3+ requires that Keyframe and Action objects be created INSIDE the
// locked + transaction scope, and that the lockedAccess/executeTransaction
// callbacks be synchronous. Building actions beforehand (as earlier versions did)
// silently fails the transaction in 26.x. So we split the work into two phases:
//   1. Resolve all async values and compute plain per-frame specs (no API objects).
//   2. Create the keyframes + actions synchronously inside the transaction.
// ── Following Premiere's own interpolation (issues #10, #12) ──
// Position (and any other two-value property) is eased along the motion path
// Premiere draws between the two keyframes, not along the straight line between
// them: a curved path (auto bezier, or handles dragged in the Program Monitor)
// used to come out straight. The path is sampled with getValueAtTime and walked
// by arc length, so the curve alone decides the timing whatever the original
// keyframes' temporal interpolation was; a straight path gives exactly the old
// straight-line values. Overshoot carries on along the path's end directions.
// Returns null (straight line) if the samples look wrong.
function _pathFromSamples(pts, val0, val1) {
  if (!pts || pts.length < 3) return null;
  for (var i = 0; i < pts.length; i++) {
    if (!Array.isArray(pts[i]) || typeof pts[i][0] !== 'number' || typeof pts[i][1] !== 'number' ||
        !isFinite(pts[i][0]) || !isFinite(pts[i][1])) return null;
  }
  var chord = Math.hypot(val1[0] - val0[0], val1[1] - val0[1]);
  var tol = Math.max(1e-4, chord * 1e-3, 1e-6 * (Math.abs(val0[0]) + Math.abs(val0[1])));
  var last = pts[pts.length - 1];
  // The ends must be the keyframes' own values, or the samples aren't this pair
  if (Math.abs(pts[0][0] - val0[0]) > tol || Math.abs(pts[0][1] - val0[1]) > tol ||
      Math.abs(last[0] - val1[0]) > tol || Math.abs(last[1] - val1[1]) > tol) return null;
  pts[0] = [val0[0], val0[1]]; pts[pts.length - 1] = [val1[0], val1[1]];
  var cum = [0];
  for (var k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
  var L = cum[cum.length - 1];
  // A straight path (or no movement) is the plain straight line, exactly
  if (!(L > 1e-9) || L <= chord * (1 + 1e-6)) return null;
  return { pts: pts, cum: cum, L: L };
}
function _pathAt(path, e) {
  var pts = path.pts, cum = path.cum, L = path.L, n = pts.length, d, a, b, j;
  if (e <= 0 || e >= 1) {
    // Beyond the ends: straight on along the path's direction there
    var atEnd = e >= 1;
    a = atEnd ? pts[n - 1] : pts[0];
    for (j = 1; j < n; j++) {
      b = atEnd ? pts[n - 1 - j] : pts[j];
      d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (d > 1e-9) break;
    }
    if (!(d > 1e-9)) return [a[0], a[1]];
    var over = (atEnd ? e - 1 : -e) * L; // distance past the end
    return [a[0] + (a[0] - b[0]) / d * over, a[1] + (a[1] - b[1]) / d * over];
  }
  var s = e * L, lo = 0, hi = n - 1;
  while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
  var seg = cum[hi] - cum[lo], f = seg > 0 ? (s - cum[lo]) / seg : 0;
  return [pts[lo][0] + (pts[hi][0] - pts[lo][0]) * f, pts[lo][1] + (pts[hi][1] - pts[lo][1]) * f];
}
async function _samplePath(param, t0, t1, val0, val1, frames) {
  var K = Math.max(24, Math.min(400, frames * 3));
  try {
    var pts = await Promise.all(Array.from({ length: K + 1 }, function(_, k) {
      return Promise.resolve(_getValue(param, ppro.TickTime.createWithSeconds(t0 + (t1 - t0) * k / K)))
        .then(_extractValue, function() { return null; });
    }));
    return _pathFromSamples(pts, val0, val1);
  } catch(e) { return null; }
}
// Audio (Level, Balance, ...): Premiere doesn't fade Level in a straight line
// between two keyframes (measured on 26.0.2: 0 dB to -11 dB passes 0.103 at the
// midpoint, not 0.114), so the bake asks Premiere for the value at the eased
// time instead of drawing its own line: a Linear curve then gives exactly the
// fade the user already had. The curve is clamped to the pair (no overshoot).
// Returns null if any read fails, and the caller falls back to the line.
async function _retimedValues(param, t0, t1, es, val0, val1) {
  try {
    // The pair's own ends go first and last: if Premiere doesn't hand back the
    // keyframes' values there, these reads aren't this pair and the line is used
    var vals = await Promise.all([0].concat(es, [1]).map(function(e) {
      var c = Math.max(0, Math.min(1, e));
      return Promise.resolve(_getValue(param, ppro.TickTime.createWithSeconds(t0 + (t1 - t0) * c)))
        .then(_extractValue, function() { return null; });
    }));
    for (var i = 0; i < vals.length; i++) if (typeof vals[i] !== 'number' || !isFinite(vals[i])) return null;
    var tol = Math.max(1e-6, Math.abs(val1 - val0) * 1e-3);
    if (Math.abs(vals[0] - val0) > tol || Math.abs(vals[vals.length - 1] - val1) > tol) return null;
    return vals.slice(1, -1);
  } catch(e) { return null; }
}

// stepReq: keyframe spacing to use instead of the Settings value (an undo that
// puts a replaced bake back uses that bake's own spacing)
async function bakeKeyframes(contexts, curve, stepReq) {
  if (!contexts || contexts.length === 0) throw new Error('No contexts to bake.');
  var project = contexts[0].project;

  // ── Phase 1: precompute plain specs ({ seconds, value }) — no Premiere objects ──
  var jobs = [];
  for (var ci = 0; ci < contexts.length; ci++) {
    var context = contexts[ci];
    var param   = context.param;
    var val0    = context.val0;
    var val1    = context.val1;
    var fps     = context.fps;

    var startSec    = context.kf0.seconds;
    var totalFrames = Math.round((context.kf1.seconds - startSec) * fps);
    if (totalFrames < 2) { console.log('[FS] skipping param — KFs less than 2 frames apart'); continue; }

    var isCompound = Array.isArray(val0);
    // Overshoot (a curve y outside 0..1) is fine for Position, Scale or Rotation,
    // but Opacity only goes 0..100, so keep Back/Bounce style curves inside it
    var isOpacity  = /opacity/i.test(context.displayName || '');
    // Keyframe spacing from Settings (1, 2 or 4 frames). Short pairs are always
    // written densely enough to get at least two keyframes.
    var step  = Math.max(1, Math.min(stepReq || _bakeDensity, Math.floor((totalFrames - 1) / 2)));
    var endSec = context.kf1.seconds;
    var frames = [], eased = [];
    for (var f = step; f < totalFrames; f += step) { frames.push(f); eased.push(sampleBezier(f / totalFrames, curve)); }
    // Premiere's own path / fade between the pair, where it applies (see above)
    var path    = isCompound ? await _samplePath(param, startSec, endSec, val0, val1, totalFrames) : null;
    var retimed = (!isCompound && context.isAudio) ? await _retimedValues(param, startSec, endSec, eased, val0, val1) : null;
    var specs = [];
    for (var fi = 0; fi < frames.length; fi++) {
      var t       = eased[fi];
      var seconds = startSec + frames[fi] / fps;
      if (isCompound) {
        specs.push({ seconds: seconds, value: path ? _pathAt(path, t) : [
          val0[0] + (val1[0] - val0[0]) * t,
          val0[1] + (val1[1] - val0[1]) * t
        ]});
      } else {
        var sv = retimed ? retimed[fi]
               : val0 + (val1 - val0) * (context.isAudio ? Math.max(0, Math.min(1, t)) : t);
        if (isOpacity) sv = Math.max(0, Math.min(100, sv));
        specs.push({ seconds: seconds, value: sv });
      }
    }
    if (specs.length) jobs.push({ ci: ci, param: param, isCompound: isCompound, specs: specs, step: step });
    console.log('[FS] bake['+ci+']: '+totalFrames+' frames | compound='+isCompound+' | every '+step+' | '+specs.length+' kf'
      + (path ? ' | along path' : '') + (retimed ? ' | retimed' : ''));
  }

  if (jobs.length === 0) { console.log('[FS] bake: all params skipped (already baked or too close)'); return []; }

  // ── Phase 2: create keyframes + actions INSIDE the locked transaction (26.3+) ──
  var added = 0;
  await project.lockedAccess(function() {
    project.executeTransaction(function(compound) {
      for (var ji = 0; ji < jobs.length; ji++) {
        var param = jobs[ji].param;
        var specs = jobs[ji].specs;
        for (var si = 0; si < specs.length; si++) {
          var kf = jobs[ji].isCompound
            ? param.createKeyframe(new ppro.PointF(specs[si].value[0], specs[si].value[1]))
            : param.createKeyframe(specs[si].value);
          kf.position = ppro.TickTime.createWithSeconds(specs[si].seconds);
          var action = param.createAddKeyframeAction(kf);
          if (action) { compound.addAction(action); added++; }
        }
      }
    }, 'OpenCurve bake');
  });

  console.log('[FS] bake done: '+added+' keyframes across '+jobs.length+' param(s)');
  // What was written, per input context, so the caller can record it for undo
  if (added === 0) throw new Error('Premiere did not accept the keyframes. Try again.');
  // fp: the values sent at a few keyframes. They are settled against what
  // Premiere actually stored on the first scan that sees the record on its own
  // clip (see _evalRecords, fpPending), since a property can clamp or round.
  return jobs.map(function(j){ return { ci: j.ci, step: j.step, times: j.specs.map(function(x){ return x.seconds; }), fp: _fpFromSpecs(j.specs) }; });
}

// ─── Bake records / per-property undo ────────────────────────────────────
// Every successful bake is remembered so a row's undo button can remove just
// the keyframes that bake added (the two original keyframes are never
// touched), and so the row's curve button can put the curve that was baked
// there back on the graph. Records are matched to rows by clip identity
// (sequence|name|in-point) + property key. A record is dropped when a pair
// wider than the bake's keyframe spacing turns up inside its range, which
// means the bake was undone with Ctrl+Z.
// Records are saved to localStorage (minus the live Premiere handles) so they
// survive closing the panel and Premiere. A loaded record still colours its
// row and loads its curve, and its row undo works once the playhead is over
// the clip again (the live handle comes from the scan). Only bakes made this
// session feed the Undo button next to Go.
var _bakeRecords = [];   // { id, batch, clipId, key, displayName, param, project, fps, kf0Sec, kf1Sec, times, step, curve, prev }
var _bakeSeq     = 0;
var _bakeBatchSeq = 0;   // one batch per Go press; the panel-wide Undo button reverts the latest
var _sessionBatchFloor = 0; // batches at or below this were loaded from a previous session
var _BAKE_RECORDS_KEY  = 'opencurve-bake-records';
var _BAKE_RECORDS_MAX  = 300; // newest kept

function _loadBakeRecords() {
  try {
    var arr = JSON.parse(localStorage.getItem(_BAKE_RECORDS_KEY) || '[]');
    if (!Array.isArray(arr)) return;
    arr.forEach(function(r) {
      if (!r || typeof r.clipId !== 'string' || !Array.isArray(r.times)) return;
      // Audio rows' keys start with 'a' since 2026-11-23 (a linked clip's video
      // and audio rows show together); records baked on audio before that get it
      var key = r.key;
      if (r.place && r.place.isAudio && typeof key === 'string' && key.charAt(0) !== 'a') key = 'a' + key;
      _bakeRecords.push({
        id: r.id || 0, batch: r.batch || 0, clipId: r.clipId, key: key, displayName: r.displayName || '', label: r.label || '',
        param: null, project: null, fps: r.fps || 0, kf0Sec: r.kf0Sec, kf1Sec: r.kf1Sec,
        times: r.times, step: r.step || 1, curve: r.curve || null,
        fp: Array.isArray(r.fp) ? r.fp : null, fpTol: r.fpTol || 0, place: r.place || null, fpPending: !!r.fpPending,
        prev: _prevOk(r.prev) ? r.prev : null, dormant: !!r.dormant || undefined,
      });
      if (r.id > _bakeSeq) _bakeSeq = r.id;
      if (r.batch > _bakeBatchSeq) _bakeBatchSeq = r.batch;
    });
    _sessionBatchFloor = _bakeBatchSeq;
  } catch(_) {}
}
function _saveBakeRecords() {
  try {
    var r6 = function(v) { return Math.round(v * 1e6) / 1e6; };
    var out = _bakeRecords.slice(-_BAKE_RECORDS_MAX).map(function(r) {
      return { id: r.id, batch: r.batch, clipId: r.clipId, key: r.key, displayName: r.displayName, label: r.label || '', fps: r.fps,
               kf0Sec: r.kf0Sec, kf1Sec: r.kf1Sec, times: r.times.map(r6), step: r.step || 1, curve: r.curve || null,
               fp: r.fp || null, fpTol: r.fpTol || 0, place: r.place || null, fpPending: !!r.fpPending, prev: r.prev || null, dormant: r.dormant ? 1 : 0 };
    });
    localStorage.setItem(_BAKE_RECORDS_KEY, JSON.stringify(out));
  } catch(_) {}
}
_loadBakeRecords();

// Replace: a record made by the row's Replace button carries `prev`, the bake it
// replaced ({ batch, curve, step, prev }), so an undo puts that curve back instead
// of leaving the pair plain. Kept a few levels deep, oldest dropped.
var _PREV_DEPTH = 5;
function _prevOk(p) {
  return !!p && typeof p === 'object' && !!p.curve && typeof p.curve === 'object';
}
function _prevSnap(rec) {
  if (!rec || !rec.curve) return null;
  var snap = { batch: rec.batch || 0, curve: _cloneCurve(rec.curve), step: rec.step || 1,
               prev: _prevOk(rec.prev) ? JSON.parse(JSON.stringify(rec.prev)) : null };
  for (var p = snap, d = 1; p.prev; p = p.prev, d++) {
    if (d >= _PREV_DEPTH) { p.prev = null; break; }
  }
  return snap;
}

function _bakesFor(clipId, key) {
  return _bakeRecords.filter(function(r){ return r.clipId === clipId && (key === undefined || r.key === key); });
}
function _dropBake(rec) {
  var i = _bakeRecords.indexOf(rec);
  if (i >= 0) { _bakeRecords.splice(i, 1); _saveBakeRecords(); }
}
function _hasSessionBakes() {
  return _bakeRecords.some(function(r){ return r.batch > _sessionBatchFloor && !r.dormant; });
}
// Does this record hold on this row? _evalRecords lists the ones that don't
// (keyframes or values gone, or written by a bake on a copy of the clip) in
// p._recBad. A record made after that scan isn't listed, so it counts.
function _recOkOn(rec, p) {
  return !p || !p._recBad || p._recBad.indexOf(rec.id) < 0;
}
// Records that apply to this row where the playhead is now
function _recsForRow(clipId, row, key) {
  return _bakesFor((row && row.clipId) || clipId, key).filter(function(r){ return !row || (_recForRow(r, row) && _recOkOn(r, row) && _recHere(r, row)); });
}
// Newest record that applies to this row where the playhead is now
function _bakeRecFor(s, key) {
  var row  = (s.availableParams || []).filter(function(p){ return p.key === key; })[0];
  var recs = _recsForRow(s.clipId, row, key);
  return recs.length ? recs[recs.length - 1] : null;
}
// Row curve button: put the curve that was baked here back on the graph
function _loadBakedCurve(key) {
  var rec = _bakeRecFor(getState(), key);
  if (!rec || !rec.curve) { _showCopyToast('No curve was recorded for this bake', '#f0a030'); return; }
  // The preset it came from, if it is still in the list, lights up as if clicked
  var pid = _presetMatchRef ? _presetMatchRef(rec.curve) : null;
  if (pid !== null) {
    setPresetActive(pid);
    var tile = document.querySelector('.preset-btn[data-id="' + pid + '"]');
    if (tile) _presetGoToTile(tile); // the page it is on
  } else clearPresetActive();
  _animateToCurve(_cloneCurve(rec.curve), function(cur) { if (_svgW > 0 && _svgH > 0) updateDynamicSVG(cur, _svgW, _svgH); });
  _showCopyToast('Loaded the curve baked on ' + (rec.label || rec.displayName || 'this property'));
}
// Keys in `avail` that have a bake to undo on this clip
// Guards against undoing the wrong thing:
//  - a record belongs to a row only if the property name matches too (component
//    indices shift when effects are added or removed, so the key alone can point
//    at a different property);
//  - a record only counts while the property still carries the bake's
//    fingerprint: both original keyframes plus at least half of the ones we
//    wrote, and (records made since 2.0.2) the values written at a few of them.
function _recForRow(rec, p) {
  return !rec.displayName || !p.displayName || rec.displayName === p.displayName;
}
function _recAlive(rec, kfSecs) {
  function has(t){ return kfSecs.some(function(h){ return Math.abs(h - t) < 1e-4; }); }
  if (!has(rec.kf0Sec) || !has(rec.kf1Sec)) return false;
  // One walk over each instead of scanning kfSecs per written time: this runs
  // for every live record on every poll, and a long bake carries hundreds of
  // times. Both arrays are written ascending; the scan is the fallback.
  var times = rec.times, n = 0;
  function sorted(a) { for (var i = 1; i < a.length; i++) if (a[i] < a[i-1]) return false; return true; }
  if (sorted(kfSecs) && sorted(times)) {
    var i = 0, j = 0;
    while (i < kfSecs.length && j < times.length) {
      var d = kfSecs[i] - times[j];
      if (d < -1e-4) i++;
      else if (d > 1e-4) j++;
      else { n++; i++; j++; }
    }
  } else {
    times.forEach(function(t){ if (has(t)) n++; });
  }
  return n > 0 && n * 2 >= times.length;
}
// A record only applies to the row while the playhead's bracketing pair sits inside
// the span it baked. Elsewhere on the clip the row is a normal row, so a second
// keyframed area on the same property can be baked (and undone) on its own.
function _recHere(rec, p) {
  if (typeof p._kf0 !== 'number') return true;
  if (p._out) return false;
  return p._kf0 >= rec.kf0Sec - 1e-4 && p._kf1 <= rec.kf1Sec + 1e-4;
}

// ── Copies of a clip (issue #11) ──
// The UXP API has no stable clip id, so records name their clip by sequence +
// clip name + in-point, and a duplicate of the clip has the same identity. The
// keyframe times alone can't tell the copies apart either: a different curve
// baked on the copy writes keyframes at the very same times. So each record
// also keeps the values it wrote at a few of its keyframes (fp), and a record
// only holds on a clip whose property still has those values. And a record
// that no longer holds on one clip isn't forgotten while another clip with the
// same identity still carries it (undoing the bake on the copy used to take the
// original's green row, curve button and undo button with it).
function _fpFromSpecs(specs) {
  var n = specs.length, out = [], seen = {};
  for (var k = 1; k <= 4; k++) {
    var i = Math.min(n - 1, Math.floor(n * k / 5));
    if (i < 0 || seen[i]) continue;
    seen[i] = true;
    var v = specs[i].value;
    out.push([specs[i].seconds, Array.isArray(v) ? [v[0], v[1]] : v]);
  }
  return out;
}
// Tolerance for those values: a thousandth of the eased range (Premiere stores
// floats, and a different curve is off by far more than that)
function _fpTolFor(val0, val1) {
  var span = Array.isArray(val0)
    ? Math.max(Math.abs(val1[0] - val0[0]), Math.abs(val1[1] - val0[1]))
    : Math.abs(val1 - val0);
  return Math.max(1e-4, span * 1e-3);
}
function _valClose(a, b, tol) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= tol;
  if (Array.isArray(a) && Array.isArray(b) && a.length >= 2 && b.length >= 2)
    return Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol;
  return true; // can't compare: don't reject on it
}
async function _recValsRead(rec, param) {
  return await Promise.all(rec.fp.map(function(e) {
    return Promise.resolve(_getValue(param, ppro.TickTime.createWithSeconds(e[0]))).then(_extractValue, function() { return null; });
  }));
}
async function _recValsOk(rec, param) {
  if (!rec.fp || !rec.fp.length || !param) return true;
  var tol = rec.fpTol || 1e-3;
  try {
    var got = await _recValsRead(rec, param);
    for (var i = 0; i < got.length; i++) {
      if (got[i] === null) continue;
      if (!_valClose(got[i], rec.fp[i][1], tol)) return false;
    }
  } catch(_) {}
  return true;
}
// First look at a fresh record on the clip it was baked on, with its keyframes
// all there: whatever Premiere holds at the fingerprint times IS this bake, so
// take those values (a property may have clamped or rounded what was sent, and
// nothing here depends on how soon after the transaction a read is current).
async function _recSettleFp(rec, param) {
  try {
    var got = await _recValsRead(rec, param);
    if (got.every(function(v) { return v !== null; })) {
      rec.fp = rec.fp.map(function(e, i) { return [e[0], Array.isArray(got[i]) ? [got[i][0], got[i][1]] : got[i]]; });
    }
  } catch(_) {}
  rec.fpPending = false;
  _saveBakeRecords();
}
// Cached verdicts, so a record that doesn't hold on a copy isn't re-read (or
// the sequence re-walked for it) on every poll: record id + the clip's place
// on the timeline + the property's keyframe signature. They expire after
// _REC_VERDICT_MS, since two copies swapped into each other's place would
// otherwise inherit each other's verdicts.
var _recVerdicts = {}, _recVerdictCount = 0;
var _REC_VERDICT_MS = 10000;
function _verdict(vk) {
  var e = _recVerdicts[vk];
  return (e && Date.now() - e.at < _REC_VERDICT_MS) ? e.v : undefined;
}
function _setVerdict(vk, v) {
  if (!_recVerdicts[vk]) _recVerdictCount++;
  _recVerdicts[vk] = { v: v, at: Date.now() };
}
function _kfSig(kf) {
  var sum = 0;
  for (var i = 0; i < (kf || []).length; i++) sum += kf[i];
  return (kf || []).length + ':' + Math.round(sum * 1e4);
}
// ── Trimming the head of a clip after a bake ──
// A normal clip keeps its keyframes in media time, but a head trim changes its
// in-point, which is part of the record's clipId, so the record stopped
// matching. _adoptTrimmed takes over a record of the same sequence and clip
// name with another in-point when its whole bake (times, and values for records
// that carry them) is on this row, and renames it to this clip.
// An adjustment layer (any synthetic item: colour matte, title) is the other
// way round: its in-point stays at 3600 and Premiere moves every keyframe's
// media time by the trim so they stay put on the timeline (seen on 26.0.2), so
// the record's times miss and it was dropped as undone. _recRebase finds the
// offset that puts every keyframe the bake wrote back on the property and
// moves the record by it.
function _placeOf(here) {
  return here ? { start: here.start || 0, trackIdx: here.trackIdx, isAudio: !!here.isAudio } : null;
}
function _hasSorted(a, t) {
  var lo = 0, hi = a.length - 1;
  while (lo <= hi) {
    var mid = (lo + hi) >> 1, d = a[mid] - t;
    if (d < -1e-4) lo = mid + 1; else if (d > 1e-4) hi = mid - 1; else return true;
  }
  return false;
}
// Every written time present, and both original keyframes: stricter than
// _recAlive, for matches made without the record's own clip identity
function _recFull(rec, kf, d) {
  d = d || 0;
  var s = kf.slice().sort(function(a, b) { return a - b; });
  if (!_hasSorted(s, rec.kf0Sec + d) || !_hasSorted(s, rec.kf1Sec + d)) return false;
  for (var i = 0; i < rec.times.length; i++) if (!_hasSorted(s, rec.times[i] + d)) return false;
  return true;
}
async function _adoptTrimmed(clipId, p, here, recFloor) {
  var me = _parseClipId(clipId);
  if (!me || !me.seq) return;
  var changed = false;
  for (var i = 0; i < _bakeRecords.length; i++) {
    var r = _bakeRecords[i];
    if (r.key !== p.key || r.clipId === clipId || !_recForRow(r, p)) continue;
    if (recFloor >= 0 && r.id > recFloor) continue;
    var id = _parseClipId(r.clipId);
    if (!id || id.seq !== me.seq || id.name !== me.name) continue;
    if (!_recAlive(r, p._kf)) continue;
    if (r.fp && r.fp.length ? !(await _recValsOk(r, p._param)) : !_recFull(r, p._kf)) continue;
    r.clipId = clipId;
    r.place  = _placeOf(here);
    changed = true;
  }
  if (changed) _saveBakeRecords();
}
// Offsets d (at most a few) that put the record's two keyframes and every time
// it wrote on the property's keyframes
function _recShifts(rec, kf) {
  var out = [], times = rec.times || [];
  if (!(rec.kf1Sec > rec.kf0Sec) || !times.length || !kf || kf.length < times.length) return out;
  var s = kf.slice().sort(function(a, b) { return a - b; });
  for (var i = 0; i < s.length && out.length < 4; i++) {
    var d = s[i] - rec.kf0Sec;
    if (Math.abs(d) < 1e-4 || !_hasSorted(s, rec.kf1Sec + d)) continue;
    var all = true;
    for (var j = 0; j < times.length && all; j++) if (!_hasSorted(s, times[j] + d)) all = false;
    if (all) out.push(d);
  }
  return out;
}
async function _recRebase(rec, p, recs, here) {
  if (!Array.isArray(p._kf)) return false;
  var ds = _recShifts(rec, p._kf);
  for (var k = 0; k < ds.length; k++) {
    var d = ds[k], lo = rec.kf0Sec + d, hi = rec.kf1Sec + d;
    // Never onto another bake that is still where its record says
    var onOther = recs.some(function(o) {
      return o !== rec && lo < o.kf1Sec - 1e-4 && hi > o.kf0Sec + 1e-4 && _recAlive(o, p._kf);
    });
    if (onOther) continue;
    var fp = rec.fp ? rec.fp.map(function(e) { return [e[0] + d, e[1]]; }) : null;
    if (fp && fp.length && p._param && !(await _recValsOk({ fp: fp, fpTol: rec.fpTol }, p._param))) continue;
    rec.kf0Sec = lo;
    rec.kf1Sec = hi;
    rec.times  = rec.times.map(function(t) { return t + d; });
    rec.fp     = fp;
    rec.place  = _placeOf(here);
    _saveBakeRecords();
    return true;
  }
  return false;
}
// Mark the records that don't hold on each row (p._recBad) and return the ones
// to retire (_applyRetire forgets those whose bake is gone from every clip that
// shared it). Nothing is dropped here: a scan's result can still be thrown away
// (Go pressed meanwhile), and its pre-bake keyframes would make a fresh record
// look undone. Records made after the scan began (id above recFloor) aren't
// judged at all, for the same reason.
async function _evalRecords(clipId, avail, sequence, here, recFloor) {
  if (_recVerdictCount > 4000) { _recVerdicts = {}; _recVerdictCount = 0; }
  var place = here ? (here.isAudio ? 'A' : 'V') + here.trackIdx + '@' + (here.start || 0).toFixed(4) : '';
  var retire = [];
  for (var pi = 0; pi < (avail || []).length; pi++) {
    var p = avail[pi];
    p._recBad = [];
    if (Array.isArray(p._kf) && p._kf.length) await _adoptTrimmed(clipId, p, here, recFloor);
    var recs = _bakesFor(clipId, p.key).filter(function(r){ return _recForRow(r, p) && !(recFloor >= 0 && r.id > recFloor); });
    if (!recs.length) continue;
    var sig = _kfSig(p._kf);
    for (var ri = 0; ri < recs.length; ri++) {
      var rec = recs[ri];
      // Fingerprint gone, or the playhead's bracketing pair inside the span is
      // wider than the bake's keyframe spacing (one of ours would be narrower):
      // the bake was undone or edited outside the panel. The width is counted
      // at the frame rate the bake used (rec.fps): a record from before 2.0.2
      // on a slowed-down clip was written a sequence frame apart, which is more
      // than one frame of the media rate the rows now count in.
      var dead = Array.isArray(p._kf) && !_recAlive(rec, p._kf);
      // ...unless the whole bake is still there, moved in media time (a
      // head-trimmed adjustment layer): follow it
      if (dead && await _recRebase(rec, p, recs, here)) dead = false;
      if (!dead && _recHere(rec, p) && typeof p._kf0 === 'number' && !p._out) {
        var fcRec = rec.fps > 0 ? Math.round((p._kf1 - p._kf0) * rec.fps) : p._fc;
        if (typeof fcRec === 'number' && fcRec > (rec.step || 1)) dead = true;
      }
      var vk = rec.id + '|' + place + '|' + sig;
      var v = _verdict(vk);
      // 'kept': judged dead here with these very keyframes and carried by a copy
      if (v === 'kept') dead = true;
      else if (!dead && rec.fp) {
        if (rec.fpPending && p._param && (!rec.place || _samePlace(here, rec.place))) {
          await _recSettleFp(rec, p._param);
          v = 'ok'; _setVerdict(vk, v);
        }
        if (v === undefined) {
          v = (await _recValsOk(rec, p._param)) ? 'ok' : 'bad';
          _setVerdict(vk, v);
        }
        if (v !== 'ok') dead = true;
      }
      if (!dead) {
        // its bake is back (a redo in Premiere): wake it up
        if (rec.dormant) { delete rec.dormant; _saveBakeRecords(); _showUndoBtn(_hasSessionBakes()); }
        continue;
      }
      p._recBad.push(rec.id);
      if (rec.dormant) continue; // already retired
      if (v !== 'kept') retire.push({ rec: rec, vk: vk, here: here }); // here: the clip it was judged on
    }
  }
  return retire;
}
// Retire what a scan found dead, once its result is applied: keep a record a
// copy of the clip still carries, forget the rest. A kept record that has lost
// the very clip it was baked on (its keyframes deleted there by hand) also
// leaves the panel-wide Undo and drops its handle, like _retireBake, so that
// button never reaches across to the copy; one that merely doesn't hold on the
// clip being viewed (another copy's own bake) is left as it is.
function _samePlace(a, b) {
  return !!a && !!b && !!a.isAudio === !!b.isAudio && a.trackIdx === b.trackIdx && Math.abs((a.start || 0) - (b.start || 0)) < 1e-4;
}
async function _applyRetire(list, sequence, here) {
  for (var k = 0; k < (list || []).length; k++) {
    var r = list[k];
    if (_bakeRecords.indexOf(r.rec) < 0) continue;
    var rh = r.here || here; // a linked clip's audio part is judged on its own clip
    var other = null;
    try { other = await _findRecCarrier(r.rec, sequence, rh); } catch(_) {}
    if (other) {
      _setVerdict(r.vk, 'kept');
      if (!r.rec.place || _samePlace(rh, r.rec.place)) {
        r.rec.param = null;
        if (r.rec.batch > _sessionBatchFloor) { r.rec.batch = 0; _saveBakeRecords(); _showUndoBtn(_hasSessionBakes()); }
      }
    } else if (!r.rec.dormant) {
      // Dormant, not dropped: Ctrl+Z undoes a bake in Premiere and Ctrl+Shift+Z
      // redoes it, and a dropped record left the redone bake as a grey run for
      // good. A dormant record is marked bad on every scan (so it colours
      // nothing and blocks no bake), leaves the panel-wide Undo, wakes up in
      // _evalRecords once its bake holds again, and goes when a new bake on the
      // same property covers its span (_dropDormant).
      r.rec.dormant = true;
      _saveBakeRecords();
      _showUndoBtn(_hasSessionBakes());
    }
  }
}
function _dropDormant(rec) {
  var gone = false;
  for (var i = _bakeRecords.length - 1; i >= 0; i--) {
    var o = _bakeRecords[i];
    if (o === rec || !o.dormant || o.clipId !== rec.clipId || o.key !== rec.key) continue;
    if (o.displayName && rec.displayName && o.displayName !== rec.displayName) continue;
    if (o.kf0Sec < rec.kf1Sec - 1e-4 && o.kf1Sec > rec.kf0Sec + 1e-4) { _bakeRecords.splice(i, 1); gone = true; }
  }
  return gone;
}
// A scan result's pending retirements, applied once (the result object is
// cached and handed out again on idle polls)
async function _applyResultRetire(result) {
  if (!result || !result._retire) return;
  var rl = result._retire;
  result._retire = null;
  if (rl.length) await _applyRetire(rl, result._retireSeq, result._retireHere);
}
// clipId = sequence guid | clip name | in-point (4 decimals); the name may hold '|'
function _parseClipId(clipId) {
  var s = String(clipId || '');
  var a = s.indexOf('|'), b = s.lastIndexOf('|');
  if (a < 0 || b <= a) return null;
  return { seq: s.slice(0, a), name: s.slice(a + 1, b), inStr: s.slice(b + 1) };
}
// The property a record was baked on, in a clip's component chain: by its key
// (component and parameter index) when the name still matches, else the same
// parameter index in any component whose name for it matches
async function _paramForRec(chain, rec) {
  var parts = String(rec.key || '').replace(/^a/, '').split('_'); // 'a': an audio clip's row
  var ci = parseInt(parts[0], 10), pj = parseInt(parts[1], 10);
  if (!(pj >= 0)) return null;
  var count = 0; try { count = await _call(chain, 'getComponentCount'); } catch(_) { return null; }
  var order = [];
  if (ci >= 0 && ci < count) order.push(ci);
  for (var i = 0; i < count; i++) if (i !== ci) order.push(i);
  for (var oi = 0; oi < order.length; oi++) {
    try {
      var comp = await _call(chain, 'getComponentAtIndex', order[oi]);
      var mn = ''; try { mn = await _call(comp, 'getMatchName'); } catch(_) {}
      if (rec.displayName && _paramName(mn, pj, mn + ' ' + pj) !== rec.displayName) continue;
      var pc = 0; try { pc = await _call(comp, 'getParamCount'); } catch(_) {}
      if (pj >= pc) continue;
      return await _call(comp, 'getParam', pj);
    } catch(_) {}
  }
  return null;
}
async function _kfSecsOf(param) {
  var kfTimes = await _call(param, 'getKeyframeListAsTickTimes');
  var arr = kfTimes ? (Array.isArray(kfTimes) ? kfTimes : Array.from(kfTimes)) : [];
  return arr.map(function(t) { return t.seconds; });
}
// Every clip in the sequence (video and audio) with this name and in-point
var _identityMemo = null; // { key, at, clips }: several records of one Go press share a walk
async function _clipsWithIdentity(sequence, name, inStr) {
  var mkey = ''; try { mkey = String(sequence.guid || '') + '|' + name + '|' + inStr; } catch(_) {}
  if (_identityMemo && _identityMemo.key === mkey && Date.now() - _identityMemo.at < 1500) return _identityMemo.clips.slice();
  var out = await _clipsWithIdentityWalk(sequence, name, inStr);
  _identityMemo = { key: mkey, at: Date.now(), clips: out };
  return out.slice();
}
async function _clipsWithIdentityWalk(sequence, name, inStr) {
  var out = [];
  for (var pass = 0; pass < 2; pass++) {
    var audio = pass === 1, n = 0;
    try { n = audio ? await sequence.getAudioTrackCount() : await sequence.getVideoTrackCount(); } catch(_) { continue; }
    for (var t = 0; t < n; t++) {
      var track = null, items = null;
      try { track = audio ? await sequence.getAudioTrack(t) : await sequence.getVideoTrack(t); } catch(_) { continue; }
      if (!track) continue;
      try { items = await track.getTrackItems(1, false); } catch(_) {}
      if (!items || !items.length) continue;
      var names = await Promise.all(Array.prototype.map.call(items, function(it) {
        return Promise.resolve(it.getName()).then(function(v) { return String(v || ''); }, function() { return ''; });
      }));
      for (var i = 0; i < items.length; i++) {
        if ((names[i] || '?') !== name) continue; // clipId writes a nameless clip as '?'
        try {
          var ip = await _clipInPoint(items[i]);
          if (ip.toFixed(4) !== inStr) continue;
          var st = await items[i].getStartTime();
          out.push({ clip: items[i], trackIdx: t, isAudio: audio, start: st && typeof st.seconds === 'number' ? st.seconds : -1 });
        } catch(_) {}
      }
    }
  }
  return out;
}
// A clip other than `exclude` (or, with no exclude, any clip, the one the bake
// was made on first) whose property still carries this record: times and values.
// Returns { param, clip } or null.
async function _findRecCarrier(rec, sequence, exclude) {
  var id = _parseClipId(rec.clipId);
  if (!id || !sequence) return null;
  try { if (id.seq && String(sequence.guid || '') !== id.seq) return null; } catch(_) {}
  var clips = await _clipsWithIdentity(sequence, id.name || '', id.inStr);
  // A linked clip's video and audio parts share the identity: only look at
  // the kind the record was baked on (audio rows' keys start with 'a')
  var recAudio = String(rec.key || '').charAt(0) === 'a';
  clips = clips.filter(function(c) { return !!c.isAudio === recAudio; });
  function same(c, h) {
    return !!h && c.isAudio === !!h.isAudio && c.trackIdx === h.trackIdx && Math.abs(c.start - (h.start || 0)) < 1e-4;
  }
  if (!exclude && rec.place) clips.sort(function(a, b) { return (same(b, rec.place) ? 1 : 0) - (same(a, rec.place) ? 1 : 0); });
  for (var i = 0; i < clips.length; i++) {
    var c = clips[i];
    if (exclude && same(c, exclude)) continue;
    try {
      var chain = await c.clip.getComponentChain();
      var param = chain ? await _paramForRec(chain, rec) : null;
      if (!param) continue;
      if (!_recAlive(rec, await _kfSecsOf(param))) continue;
      if (!(await _recValsOk(rec, param))) continue;
      return { param: param, clip: c };
    } catch(_) {}
  }
  return null;
}
function _bakedKeysFor(clipId, avail) {
  var keys = [];
  (avail || []).forEach(function(p) {
    var recs = _bakesFor(p.clipId || clipId, p.key).filter(function(r){ return _recForRow(r, p) && _recOkOn(r, p) && _recHere(r, p); });
    if (recs.length) keys.push(p.key);
  });
  return keys;
}
// Mini timeline: every live bake record on the row's property as [start, end]
// in sequence seconds (drawn as green bars). Runs after _evalRecords has
// marked (and retired) the records whose fingerprint is gone.
function _tlAttachSpans(clipId, avail, tl) {
  (avail || []).forEach(function(p) {
    var ptl = p._tlP || tl; // the row's own clip
    p.tlSpans = _bakesFor(p.clipId || clipId, p.key)
      .filter(function(r){ return _recForRow(r, p) && _recOkOn(r, p) && (!Array.isArray(p._kf) || _recAlive(r, p._kf)); })
      .map(function(r){ return ptl ? [_toSeq(ptl, r.kf0Sec), _toSeq(ptl, r.kf1Sec)] : [r.kf0Sec, r.kf1Sec]; });
  });
}
function _recordBakes(s, keys, contexts, written) {
  var batchId = written.length ? ++_bakeBatchSeq : 0;
  for (var wi = 0; wi < written.length; wi++) {
    var w   = written[wi];
    var ctx = contexts[w.ci];
    var key = keys[w.ci];
    var ap  = (s.availableParams || []).filter(function(p){ return p.key === key; })[0];
    _bakeRecords.push({
      id: ++_bakeSeq, batch: batchId, clipId: ctx.clipId || s.clipId, key: key,
      displayName: ap ? ap.displayName : key,
      label: ap ? (ap.label || ap.displayName) : key,
      param: ctx.param, project: ctx.project, fps: ctx.fps,
      kf0Sec: ctx.kf0.seconds, kf1Sec: ctx.kf1.seconds, times: w.times,
      step: w.step || 1, curve: _cloneCurve(s.curve),
      fp: w.fp || null, fpTol: _fpTolFor(ctx.val0, ctx.val1), place: ctx.place || null, fpPending: !!w.fp,
    });
    _dropDormant(_bakeRecords[_bakeRecords.length - 1]);
  }
  if (written.length) _saveBakeRecords();
}

// Panel-wide Undo button (next to Go, same control as the CEP edition)
// The button always stays in place; with nothing to undo the whole button
// (background and icon) is dimmed and inert.
function _showUndoBtn(show) {
  var btn = document.getElementById('undo-btn');
  if (!btn) return;
  btn.classList.toggle('btn-dim', !show);
  btn.style.display = 'flex';
  // Inline, since UXP doesn't restyle on a class change alone, and an inline
  // colour also beats the green :hover rule, which the CCX applied to the dim
  // button anyway. The grey is opaque so a green Go doesn't show through: a
  // faint white fill read as a green square with a dark icon, and opacity
  // 0.35 didn't take in the CCX (both 2026-11-22).
  btn.style.backgroundColor = show ? '' : '#2b2b2b';
  btn.style.backgroundImage = show ? '' : 'none';
  btn.style.color      = show ? '' : '#6f6f6f';
  btn.style.opacity    = '';
  btn.style.cursor     = show ? '' : 'default';
  _fitGoForUndo();
}

// Row undo button: step this property back one bake on the current clip (a
// replaced bake comes back; otherwise the keyframes the bake added go).
// Busy look for the row Undo / Replace buttons and the Undo next to Go: while
// the action runs the icon is swapped for Go's spinner, pinned at the centre
// like _centerIcons pins the icons (the buttons are position: relative here)
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
    sp.style.cssText = 'position:absolute;left:50%;top:50%;width:12px;height:12px;margin:-6px 0 0 -6px;box-sizing:border-box;pointer-events:none;';
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
async function _undoBakeForKey(key) {
  var b = _rowBtn(key, 'undo');
  if (b && b._ocSpin) return; // already running
  _btnBusy(b, true);
  try { await _undoBakeForKeyRun(key); } finally { _btnBusy(b, false); }
}
async function _undoBakeForKeyRun(key) {
  var s = getState();
  if (s.isBaking) return;
  var row  = (s.availableParams || []).filter(function(p){ return p.key === key; })[0];
  var recs = _recsForRow(s.clipId, row, key);
  if (recs.length === 0) return;
  await _undoRecords(recs, (row && row.label) || recs[0].label || recs[0].displayName || 'property', key);
}

// Panel-wide Undo button: revert everything the most recent Go press wrote,
// whichever clip it was on. Each press again steps back one more bake.
async function _undoLastBake() {
  var b = document.getElementById('undo-btn');
  if (b && b._ocSpin) return;
  _btnBusy(b, true);
  try { await _undoLastBakeRun(); } finally { _btnBusy(b, false); }
}
async function _undoLastBakeRun() {
  var s = getState();
  // Only bakes made this session: records loaded from a previous session are
  // undone from their row button, once the playhead is over the clip
  var mine = _bakeRecords.filter(function(r){ return r.batch > _sessionBatchFloor && !r.dormant; });
  if (s.isBaking || mine.length === 0) return;
  var last = 0;
  for (var i = 0; i < mine.length; i++) if (mine[i].batch > last) last = mine[i].batch;
  var recs = mine.filter(function(r){ return r.batch === last; });
  var names = [];
  recs.forEach(function(r){ var n = r.label || r.displayName; if (names.indexOf(n) < 0) names.push(n); });
  await _undoRecords(recs, names.join(', '), null);
}

// A record whose bake is no longer on the clip it was just checked or undone
// on: forget it, unless a copy of the clip still carries it (issue #11). A
// record kept for a copy loses its handle (it pointed at the other clip) and
// leaves the panel-wide Undo button, so that button never reaches across to
// the copy; the copy's own row undo still works.
async function _retireBake(rec, sequence, here) {
  var other = null;
  try { other = await _findRecCarrier(rec, sequence, here); } catch(_) {}
  if (!other) { _dropBake(rec); return; }
  rec.param = null;
  if (rec.batch > _sessionBatchFloor) rec.batch = 0;
  _saveBakeRecords();
}

// Phase 1 of an undo or a replace: confirm each record's fingerprint is still
// on the property and list the keyframes it wrote that are still there.
// Prefer the param handle from the current scan (a proxy kept from bake time
// can go stale), but only when that row is the same-named property and the
// record holds on it. Records whose bake is gone are retired here. Returns
// { jobs: [{ rec, param, times }], unreachable }.
async function _recJobs(recs, key, s, sequence) {
  var jobs = [];
  var unreachable = 0;
  for (var ri = 0; ri < recs.length; ri++) {
    var rec = recs[ri];
    var liveRow = (s.availableParams || []).filter(function(p){
      return p.key === rec.key && (p.clipId || s.clipId) === rec.clipId && _recForRow(rec, p) && _recOkOn(rec, p);
    })[0] || null;
    var param = (liveRow && liveRow._param) ? liveRow._param : rec.param;
    var have  = null;
    if (param) {
      if (typeof param.createRemoveKeyframeAction !== 'function') {
        throw new Error('This Premiere version cannot remove keyframes from a plugin. Use Ctrl+Z in Premiere instead.');
      }
      try { have = await _kfSecsOf(param); } catch(_) { have = null; }
      // Values too: a handle kept from bake time may now point at a copy of
      // the clip that carries a different bake at the same times
      if (have && _recAlive(rec, have) && !(await _recValsOk(rec, param))) have = [];
    }
    // No handle (loaded from a previous session), a stale one (the clip moved
    // or the scan that made it is gone), or one that no longer carries the
    // bake: look for the clip that does, by name and in-point, anywhere in
    // the active sequence. Until 2.0.2 this said "Move the playhead over that
    // clip" even with the playhead on it, and the Undo button did nothing.
    // A row undo acts on the row's own clip only: if that clip doesn't carry
    // the bake, a copy elsewhere is left alone
    if (!have || !_recAlive(rec, have)) {
      var found = null;
      if (!(key && liveRow && liveRow._param)) {
        try { found = await _findRecCarrier(rec, sequence, null); } catch(_) {}
      }
      if (found) {
        param = found.param;
        rec.param = param;
        try { have = await _kfSecsOf(param); } catch(_) { have = null; }
      } else if (!have) {
        // The clip isn't in this sequence (or can't be read): keep the record
        unreachable++;
        continue;
      }
    }
    if (!have || !_recAlive(rec, have)) { await _retireBake(rec, sequence, null); continue; }
    var times = rec.times.filter(function(t){
      return have.some(function(h){ return Math.abs(h - t) < 1e-4; });
    });
    if (times.length) jobs.push({ rec: rec, param: param, times: times });
  }
  return { jobs: jobs, unreachable: unreachable };
}

// Phase 2: remove the listed keyframes inside the locked transaction. One
// remove action per keyframe we wrote, never a range, so keyframes the user
// added inside the baked span are left alone. Returns how many went.
async function _removeJobs(project, jobs) {
  var removed = 0;
  await project.lockedAccess(function() {
    project.executeTransaction(function(compound) {
      for (var ji = 0; ji < jobs.length; ji++) {
        var param = jobs[ji].param;
        var ts    = jobs[ji].times;
        for (var ti = 0; ti < ts.length; ti++) {
          // updateUI only on the last one: a single redraw per property
          var action = param.createRemoveKeyframeAction(ppro.TickTime.createWithSeconds(ts[ti]), ti === ts.length - 1);
          if (action) { compound.addAction(action); removed++; }
        }
      }
    }, 'OpenCurve undo bake');
  });
  if (removed === 0) throw new Error('Premiere did not accept the change');
  return removed;
}

// Bake `curve` on the pair a record covered (its two original keyframes are
// never removed, so they are still there once its own keyframes are gone) and
// record it. Works wherever the playhead is: the pair comes from the record,
// not from a scan. `batch` and `prev` go on the new record. Returns it, or
// throws.
async function _bakeOnRecPair(job, project, curve, step, batch, prev) {
  var rec = job.rec, param = job.param;
  var kf0 = ppro.TickTime.createWithSeconds(rec.kf0Sec);
  var kf1 = ppro.TickTime.createWithSeconds(rec.kf1Sec);
  var val0 = _extractValue(await _getValue(param, kf0));
  var val1 = _extractValue(await _getValue(param, kf1));
  if (val0 === null || val1 === null) throw new Error('Could not read the keyframe values');
  var ctx = {
    param: param, kf0: kf0, kf1: kf1, val0: val0, val1: val1, fps: rec.fps,
    displayName: rec.displayName, isAudio: !!(rec.place && rec.place.isAudio), project: project, place: rec.place || null,
  };
  var written = (await bakeKeyframes([ctx], curve, step)) || [];
  if (!written.length) throw new Error('That keyframe pair is too short to bake');
  var w = written[0];
  var nr = {
    id: ++_bakeSeq, batch: batch, clipId: rec.clipId, key: rec.key,
    displayName: rec.displayName, label: rec.label || '',
    param: param, project: project, fps: rec.fps,
    kf0Sec: rec.kf0Sec, kf1Sec: rec.kf1Sec, times: w.times,
    step: w.step || 1, curve: _cloneCurve(curve),
    fp: w.fp || null, fpTol: _fpTolFor(val0, val1), place: rec.place || null, fpPending: !!w.fp,
    prev: prev || null,
  };
  _bakeRecords.push(nr);
  _saveBakeRecords();
  return nr;
}

// Shared core of both undo buttons. Same two-phase shape as bakeKeyframes:
// await everything first, then create the remove actions synchronously inside
// the transaction. A record made by Replace then gets the bake it replaced
// written back (its curve and spacing, in its old batch, so the panel-wide
// Undo steps back in order).
// `key` limits the bakedParamKeys update to one row; null clears them all.
async function _undoRecords(recs, label, key) {
  var s = getState();
  try {
    var project  = await ppro.Project.getActiveProject();
    var sequence = project ? await project.getActiveSequence() : null;
    var pj = await _recJobs(recs, key, s, sequence);
    var jobs = pj.jobs;
    if (jobs.length === 0 && pj.unreachable > 0) {
      _showCopyToast('Open the sequence that clip is in to undo its bake', '#f0a030');
      return;
    }
    if (jobs.length === 0) {
      // Nothing of ours is left (undone with Ctrl+Z, or the keyframes were edited away)
      _showUndoBtn(_hasSessionBakes());
      _invalidateCache();
      _showCopyToast('Nothing to undo: those keyframes are already gone', '#f0a030');
      return;
    }

    if (!project) project = jobs[0].rec.project;
    var removed = await _removeJobs(project, jobs);

    // Forget each undone record, unless a copy of the clip still carries it;
    // put back the bake a replaced one took the place of
    var restored = [], restoreFailed = 0;
    for (var jr = 0; jr < jobs.length; jr++) {
      var rec = jobs[jr].rec;
      await _retireBake(rec, sequence, null);
      if (!_prevOk(rec.prev)) continue;
      try {
        await _bakeOnRecPair(jobs[jr], project, rec.prev.curve, rec.prev.step || 1, rec.prev.batch || 0, rec.prev.prev || null);
        restored.push(rec.key);
      } catch(e) {
        restoreFailed++;
        console.error('[OC] undo: could not restore the replaced bake:', e);
      }
    }
    _showUndoBtn(_hasSessionBakes());
    _invalidateCache();
    _lastStatus   = '';
    _skipPollUntil = 0;
    setState({
      bakedParamKeys: (s.bakedParamKeys || []).filter(function(k){ return key ? (k !== key || restored.indexOf(k) >= 0) : restored.indexOf(k) >= 0; }),
      status: 'idle',
    });
    if (restoreFailed) _showCopyToast('Undone, but the previous curve could not be put back on ' + label, '#ff9090');
    else if (restored.length) _showCopyToast('Undone: the previous curve is back on ' + label, '#f0a030');
    else _showCopyToast('Undone: ' + removed + ' keyframes removed from ' + label, '#f0a030');
    console.log('[OC] undo bake: removed ' + removed + ' keyframes from ' + label + (restored.length ? ', restored ' + restored.length : ''));
  } catch(err) {
    console.error('[OC] undo bake error:', err);
    _showCopyToast('Undo failed: ' + (err && err.message ? err.message : String(err)), '#ff9090');
  }
}

// The row bake button's icon: Go's bolt
var _icBolt = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none">'
  + '<path d="M13 2L4.5 13.5H12L11 22L19.5 10.5H12L13 2Z" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
// The Replace button's icon: two arrows going round
var _icReplace = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none">'
  + '<path d="M11.3 5.2A4.6 4.6 0 0 0 3 4.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>'
  + '<path d="M2.7 8.8A4.6 4.6 0 0 0 11 9.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>'
  + '<path d="M11.6 2.5v2.8H8.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>'
  + '<path d="M2.4 11.5V8.7h2.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>'
  + '</svg>';

// Replace starts dimmed: it only becomes available once the graph holds a
// different curve from the one the bake under the playhead used (a record with
// no curve, from before curves were recorded, leaves it available). Shape only:
// a point's smooth flag doesn't change the curve, so it is ignored.
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
function _replaceOk(rec, curve) { return !!rec && !(rec.curve && _sameCurve(rec.curve, curve)); }
function _replaceReady(s, key) { return _replaceOk(_bakeRecFor(s, key), s.curve); }
// Dimmed look: the same grey as the dimmed Undo next to Go, written inline
// (UXP doesn't restyle on a class change alone, and inline beats the :hover rule)
function _styleReplaceBtn(el, ready) {
  el.classList.toggle('btn-dim', !ready);
  el.style.backgroundColor = ready ? '' : '#2b2b2b';
  el.style.backgroundImage = ready ? '' : 'none';
  el.style.color           = ready ? '' : '#6f6f6f';
  el.style.cursor          = ready ? '' : 'default';
}

// Row Replace button: swap the bake on this property, where the playhead is,
// for the curve on the graph now. The old bake's keyframes go and the new
// curve is written on the same pair at the current Keyframe Spacing, as one
// step for both undo buttons (an undo brings the old curve back). If the new
// curve can't be written, the old one is put back.
async function _replaceBakeForKey(key) {
  var b = _rowBtn(key, 'replace');
  if (b && b._ocSpin) return;
  if (!_replaceReady(getState(), key)) return; // same curve as the bake: nothing to replace
  _btnBusy(b, true);
  try { await _replaceBakeForKeyRun(key); } finally { _btnBusy(b, false); }
}
async function _replaceBakeForKeyRun(key) {
  var s = getState();
  if (s.isBaking) return;
  var row  = (s.availableParams || []).filter(function(p){ return p.key === key; })[0];
  var recs = _recsForRow(s.clipId, row, key);
  if (recs.length === 0) return;
  var label = (row && row.label) || recs[0].label || recs[0].displayName || 'property';
  var curve = _cloneCurve(s.curve);
  _pvStop();
  setState({ isBaking: true, status: 'baking' });
  var failed = null;
  try {
    var project  = await ppro.Project.getActiveProject();
    var sequence = project ? await project.getActiveSequence() : null;
    var pj = await _recJobs(recs, key, s, sequence);
    if (pj.jobs.length === 0) {
      throw new Error(pj.unreachable ? 'Open the sequence that clip is in' : 'That bake is no longer on the clip');
    }
    await _removeJobs(project, pj.jobs);
    var batch = ++_bakeBatchSeq;
    for (var ji = 0; ji < pj.jobs.length; ji++) {
      var job = pj.jobs[ji];
      await _retireBake(job.rec, sequence, null);
      try {
        await _bakeOnRecPair(job, project, curve, 0, batch, _prevSnap(job.rec));
      } catch(e) {
        failed = e;
        console.error('[OC] replace: new curve failed, putting the old one back:', e);
        try { await _bakeOnRecPair(job, project, job.rec.curve, job.rec.step || 1, job.rec.batch || 0, job.rec.prev || null); }
        catch(e2) { console.error('[OC] replace: could not put the old curve back:', e2); }
      }
    }
    _showUndoBtn(_hasSessionBakes());
    _invalidateCache();
    _skipPollUntil = Date.now() + DONE_DISPLAY_MS;
    _lastStatus = '';
    if (failed) throw failed;
    setState({ isBaking: false, status: 'done' });
    _showCopyToast('Replaced the curve on ' + label);
    setTimeout(function() { _lastStatus = ''; setState({ status: 'idle' }); }, DONE_DISPLAY_MS);
  } catch(err) {
    console.error('[OC] replace error:', err);
    _invalidateCache();
    _skipPollUntil = Date.now() + ERROR_DISPLAY_MS;
    setState({ isBaking: false, status: 'error', hint: 'Replace failed: ' + (err && err.message ? err.message : String(err)) });
  }
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
// Update and Revert carry their labels when the whole chip fits labelled
// (_PE_CHIP_FULL), and also once the name has gone, when the two labelled
// buttons alone fit (_PE_BTNS_LABELLED); otherwise they are 26px icon squares.
// New (#pe-new) sits at the bar's right end, apart from the chip, and is
// counted in both: it is labelled exactly when they are
var _PE_CHIP_FULL = 310;     // name + Edited + labelled Update and Revert, + 5 + the labelled New
var _PE_BTNS_LABELLED = 222; // the labelled Update and Revert alone, + 5 + the labelled New
var _PE_NEW_W = 62;          // New with its label (an icon square is 26)
var _peNewRoom = true;       // set by the graph bar's layout: room for New at all
var _peMaxW = null;
var _peLabels = null;
function _peSetLabels(on) {
  if (on === _peLabels) return;
  _peLabels = on;
  ['pe-save', 'pe-revert', 'pe-new'].forEach(function(id) {
    var b = document.getElementById(id);
    if (!b) return;
    var sp = b.querySelector('span'), sv = b.querySelector('svg');
    if (sp) sp.style.display = on ? '' : 'none';
    b.style.padding = on ? '' : '0 5px'; // (26 - 16) / 2: the icon centred in a square
    if (sv) sv.style.marginRight = on ? '5px' : '0';
  });
}
function _peNameFits(name, ed) {
  return _peRoom >= 9 + Math.min(name.length, 8) * 6.6 + (ed ? 5 + 40 + 3 + 2 * 31 : 9) + 31; // + New... as an icon
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
  var labels;
  if (id === null) labels = _peRoom >= _PE_NEW_W;  // New alone
  else if (!ed) labels = _peRoom >= (_peNameRoom ? 9 + Math.min(name.length, 14) * 6.6 + 9 + 5 : 0) + _PE_NEW_W; // the name, then New
  else labels = _peRoom >= _PE_CHIP_FULL || (!_peNameRoom && _peRoom >= _PE_BTNS_LABELLED);
  _peSetLabels(labels);
  // The chip gets the room New leaves (an inline max-width, so it can never
  // run into it); written on every room change, compared first
  var newW = _peNewRoom ? (labels ? _PE_NEW_W : 26) + 5 : 0;
  var mw = (_peChipRoom && isFinite(_peRoom)) ? Math.max(0, Math.floor(_peRoom - newW)) + 'px' : '';
  if (mw !== _peMaxW) { var ch0 = document.getElementById('preset-edit-chip'); if (ch0) { _peMaxW = mw; ch0.style.maxWidth = mw; } }
  var sig = id + '|' + ed + '|' + name + '|' + _curveColor + '|' + _peChipRoom + '|' + _peNameRoom + '|' + labels + '|' + _peNewRoom;
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
    // New at the bar's right end: on show whenever there is room
    var nb = document.getElementById('pe-new');
    if (nb) {
      var nd = _peNewRoom ? 'flex' : 'none';
      if (nb.style.display !== nd) nb.style.display = nd;
    }
  }
}
function _peNewShown() {
  var b = document.getElementById('pe-new');
  return !!(b && b.style.display !== 'none');
}
// New Preset's default name: the next free "<source preset> N" while the curve
// came from a preset (Cubic In -> Cubic In 2), else "Custom N"
var _presetNamesRef = null; // set in initPanel: the preset names in use
function _newPresetName(customN) {
  var inf = _presetEditInfo();
  if (!inf || !_presetNamesRef) return 'Custom ' + customN;
  var taken = {};
  _presetNamesRef().forEach(function(n) { taken[n] = true; });
  var base = inf.preset.name.replace(/ \d+$/, ''), n = 2;
  while (taken[base + ' ' + n]) n++;
  return base + ' ' + n;
}
stateListeners.push(function() { _presetEditSync(); });
// Update (#pe-save): overwrite the preset the curve came from with the graph's curve (built-ins too)
function _presetEditSave() {
  var p = _presetEdited();
  if (!p || !_presetOverwriteRef) return;
  _presetOverwriteRef(p, state.curve);
  _showCopyToast('Updated "' + p.name + '"', '#3ddc84');
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

// Pin button: move the playhead to the start of this property's keyframe pair
// (the bracketing pair when the playhead is inside one, else the first keyframe).
// ─── Host hooks for the preview engine and the value readout (UXP) ────────
// The UXP API has no play/stop, so _hostTransport always hands over to the
// engine. Sequence info is fetched once per run and reused for every step.
async function _hostSeqInfo() {
  var project  = await ppro.Project.getActiveProject();
  var sequence = project ? await project.getActiveSequence() : null;
  if (!sequence) return null;
  var pos = await sequence.getPlayerPosition();
  var end = null;
  try { end = await sequence.getEndTime(); } catch(_) {}
  return { pos: pos.seconds, end: end && typeof end.seconds === 'number' ? end.seconds : pos.seconds + 3600, fps: await _fps(sequence), seq: sequence };
}
async function _hostSetPlayhead(sec, info) {
  // +1us keeps the playhead at or after the frame despite tick/float rounding
  var tt = await ppro.TickTime.createWithSeconds(Math.max(0, sec) + 0.000001);
  var sequence = info && info.seq;
  if (sequence) {
    try { await sequence.setPlayerPosition(tt); return; }
    catch(e) { console.log('[OC] preview: kept sequence handle failed, refetching:', e && e.message ? e.message : e); }
  }
  // Fresh handle (the pin buttons fetch one per jump; a kept proxy may go stale)
  var project = await ppro.Project.getActiveProject();
  sequence = project ? await project.getActiveSequence() : null;
  if (!sequence) throw new Error('No active sequence');
  await sequence.setPlayerPosition(tt);
  if (info) info.seq = sequence;
}
function _hostTransport(cmd) { return Promise.resolve(false); }
// Value readout: what Premiere interpolates for the property at that media time
async function _tlValueAt(p, mediaSec) {
  if (!p || !p._param) return null;
  var tt = await ppro.TickTime.createWithSeconds(mediaSec);
  return _extractValue(await _getValue(p._param, tt));
}

async function _jumpToParam(p) {
  if (!p || typeof p.jumpSec !== 'number') return;
  _pvStop();
  try {
    var project  = await ppro.Project.getActiveProject();
    var sequence = project ? await project.getActiveSequence() : null;
    if (!sequence) return;
    // +1us keeps the playhead at or after the keyframe despite tick/float rounding
    var tt = await ppro.TickTime.createWithSeconds(Math.max(0, p.jumpSec) + 0.000001);
    await sequence.setPlayerPosition(tt);
    _invalidateCache();
    _skipPollUntil = 0;
  } catch(e) {
    console.log('[FS] jump failed:', e);
    _showCopyToast('Could not move playhead');
  }
}

// ─── Panel shortcuts ─────────────────────────────────────────────────────
// Keys reach the panel through #oc-key-sink (see initPanel). Space play/stop ·
// J K L shuttle · P preview the pair · 1-9 the first presets · arrows nudge
// the last-touched handle (Shift: a grid step; Bounce mode: hit and height) · F flip · I invert · A A-curve · B bounce
// · G ghost · N numeric entry · U undo the last bake · Esc stops a preview or
// leaves full screen. Enter (Go) is handled by the caller.
var _lastHandle = { k: 'p1' }; // last handle pressed on the graph, for the arrow keys
var _ocPressInField = false; // the current press started in a text field (see the key sink listeners)
var _NATIVE_TRANSPORT = false; // UXP: a focused panel field swallows Space/J/K/L, so the panel handles them
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
  if (k === 'PageUp' || k === 'PageDown') { _presetPageStep(k === 'PageUp' ? -1 : 1); return true; }
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
    return b.id !== '_update-notif' && b.style.display !== 'none'; // the page on show
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
var _TL_SEC_BANDS   = 6;     // fade steps per second line and lane (each one SVG path; see _tlBuild)
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
// they stop short of the scrollbar so that stays crisp. The scroll position
// comes from scrollTop, not from where the inner box's rect sits: in the CCX,
// once renders stopped calling this (58e1cd4, so only scroll events do), the
// fades stuck as they were at the bottom after a scroll back up (2026-09-17).
// The likeliest reason is that a scroll change doesn't dirty UXP's layout, so
// that rect keeps the offset of the last relayout; scrollTop is always current.
// keep === 'keep' (the settle right after a _refreshScroller swap) reuses the
// last measured sizes: measured on the just-inserted element, the bottom fade
// flashed on at the bottom of the list until the next scroll event.
var _tlFadeSize = null; // { over, right } from the last measured call
function _tlUpdateFade(keep) {
  var els = _tlEls;
  if (!els || !els.fade || !els.scroll || !els.inner) return;
  var size = _tlFadeSize, top = 0;
  try { top = els.scroll.scrollTop; } catch(_) {}
  if (keep !== 'keep' || !size) {
    size = { over: 0, right: 0 };
    try {
      var sr = els.scroll.getBoundingClientRect(), ir = els.inner.getBoundingClientRect();
      size.over = Math.max(0, ir.height - sr.height); // how far the box can scroll
      var props = document.getElementById('prop-btns');
      var pr = (props && _tlVisible) ? props.getBoundingClientRect() : null;
      var rr = els.root.getBoundingClientRect();
      if (pr && pr.width > 0) size.right = Math.max(0, Math.round(rr.right - pr.right));
    } catch(_) {}
    _tlFadeSize = size;
  }
  var showBottom = (size.over - top) > 1; // content still hidden under the bottom edge
  var showTop    = top > 1;               // content scrolled up past the top edge
  // Change-only writes: this runs on every scroll event of the box and after
  // every render, and UXP relayouts the panel on any inline style write
  var right = size.right + 'px', ob = showBottom ? '1' : '0', ot = showTop ? '1' : '0';
  var fs = els.fade.style;
  if (fs.right   !== right) fs.right   = right;
  if (fs.opacity !== ob)    fs.opacity = ob;
  if (els.fadeTop) {
    var ts = els.fadeTop.style;
    if (ts.right   !== right) ts.right   = right;
    if (ts.opacity !== ot)    ts.opacity = ot;
  }
}

// UXP only: the second lines' fades come out lighter here than the same colours
// drawn by CEP (the two editions side by side, 2026-09-13), so the top of each
// line's gradient is multiplied by this to look the same. Tune by eye.
var _TL_SEC_UXP_GAIN = 2.0;
function _tlSecAlpha(col, k) { // col with its alpha multiplied by k (capped at 1)
  return col.replace(/,\s*([0-9.]+)\)$/, function(m0, a) { return ',' + Math.min(1, parseFloat(a) * k).toFixed(3) + ')'; });
}

function _tlBuild(s, params, range, n, laneH, H, W) {
  var els = _tlEls;
  els.svg.setAttribute('width', W);
  els.svg.setAttribute('height', H);
  _tlClear(els.svg);
  // Lane dividers are HTML divs laid over the SVG (see the loop below); drop the old set
  if (els.wrap) els.wrap.querySelectorAll('.tl-lane-div').forEach(function(el) { el.parentNode.removeChild(el); });
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
  // Second lines (_tlSecondXs), tinted per lane (_TL_COLORS sec) and faded top to
  // bottom within each lane: full tint at the lane's top edge, transparent at its
  // bottom, stopping above the divider row. Until 2026-11-22 each was a 1px HTML
  // div with a CSS gradient (HTML edges snap to device pixels, where thin SVG
  // lines were thought to come out soft).
  //
  // They are SVG paths now, not divs: every HTML element in the panel
  // is repainted on any change anywhere in it, and one div per line per lane (100
  // for two lanes on a short clip) halved the frame rate of every hover change
  // (measured live: a toolbar tint toggled per frame ran at 37fps with the divs,
  // 53-61 without; a flat colour on the same divs cost the same). So each lane
  // draws _TL_SEC_BANDS paths, one per fade step, each holding every line's
  // segment for that step: a few elements per lane however many lines there are.
  // The fade is stepped (no SVG gradients in UXP), each step at the alpha the
  // CSS gradient had at its middle. Drawn first, so the lane rects tint over them
  // as they did over the divs.
  _tlSecondRows(params, sel, valid, baked, laneH, g.y0, function(y, h, col, st, xs) {
    if (!xs.length || h <= 0) return;
    var N = Math.max(1, Math.min(_TL_SEC_BANDS, h));
    for (var k = 0; k < N; k++) {
      var ya = y + Math.round(k * h / N), yb = y + Math.round((k + 1) * h / N);
      if (yb <= ya) continue;
      var d = '';
      for (var j = 0; j < xs.length; j++) d += 'M' + (xs[j] + 0.5) + ' ' + ya + 'V' + yb;
      els.svg.appendChild(_tlMk('path', { d: d, fill: 'none', 'stroke-width': 1,
        stroke: _tlSecAlpha(col, _TL_SEC_UXP_GAIN * (1 - (k + 0.5) / N)), 'pointer-events': 'none' }));
    }
  }, _tlSecondXs(g, tl.clipStart, fps));
  params.forEach(function(p, i) {
    var top = g.y0 + i * laneH, cy = top + laneH / 2;
    // Same state logic as the row: green beats selection, selected is blue when the
    // playhead is over the pair and amber until it is, unselected-but-ready gets a blue pair
    var isSel = sel.indexOf(p.key) >= 0, isValid = valid.indexOf(p.key) >= 0;
    var c = _TL_COLORS[_tlLaneState(p.key, sel, valid, baked)];
    var bg = _tlMk('rect', { x: 0, y: top, width: W, height: laneH - 1, fill: c.bg }); // leaves the divider row clear
    els.svg.appendChild(bg);
    // Divider like the property rows': a dark 1px line at the bottom of the lane
    // (a light line here looked like a white rule). It is an HTML div over the
    // SVG, not an SVG rect: UXP resamples the SVG as a whole, so a 1px rect came
    // out soft and thicker than the rows' border, while HTML edges snap to device
    // pixels like the rows do (crispEdges on the rect made no difference).
    // Sheen like the property rows': brighter at the left of the lane, fading right
    // into its tint. A CSS gradient on a div under the translucent lane rect, since
    // UXP draws no SVG gradients. The divider is the same div's bottom border (one
    // div per lane instead of two: every HTML element is repainted on any change
    // in the panel, see the second lines above). Under the SVG, so the playhead
    // line paints over it.
    if (els.wrap) {
      var sh = document.createElement('div');
      sh.className = 'tl-lane-div'; // a rebuild clears every .tl-lane-div
      sh.style.cssText = 'position:absolute;left:0;right:0;top:' + top + 'px;height:' + laneH + 'px;box-sizing:border-box;border-bottom:1px solid #080808;background-image:linear-gradient(to right, rgba(255,255,255,0.045), rgba(255,255,255,0));pointer-events:none;';
      els.wrap.insertBefore(sh, els.svg);
    }
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
// Nothing here touches the strip or Premiere while the pointer moves: every
// HTML text change costs UXP a whole-panel relayout, and the value is a
// Premiere call per frame position. Writing and asking on every move held the
// lanes to ~44 pointer events a second (measured live 2026-11-22; see
// CLAUDE.md). So the text is written, and the value asked for, once the
// pointer has rested _TL_READOUT_MS; the value is added as soon as it lands,
// and leaving the lanes clears the text at once.
var _TL_READOUT_MS  = 90;
function _tlShowReadout(t, lane) {
  var info = (t && lane) ? { t: t, lane: lane } : null;
  var moved = !_tlHoverInfo || !info || _tlHoverInfo.lane.key !== info.lane.key || _tlHoverInfo.t.sec !== info.t.sec;
  _tlHoverInfo = info;
  if (!info) {
    if (_tlReadoutTimer) { clearTimeout(_tlReadoutTimer); _tlReadoutTimer = null; }
    _tlValText = ''; _tlValNext = null; _tlValReq++;
    _tlWriteReadout('');
    return;
  }
  if (!moved) return;
  _tlValText = ''; _tlValNext = null; _tlValReq++; // the value belonged to the old position
  if (_tlReadoutTimer) clearTimeout(_tlReadoutTimer);
  _tlReadoutTimer = setTimeout(function() {
    _tlReadoutTimer = null;
    if (!_tlHoverInfo) return;
    _tlComposeReadout();
    _tlRequestValue(_tlHoverInfo);
  }, _TL_READOUT_MS);
}
function _tlComposeReadout() {
  var text = '', h = _tlHoverInfo;
  if (h) {
    var s = getState(), fps = (s.tl && s.tl.fps) || 25;
    var rel = h.t.sec - (s.tl ? s.tl.clipStart : 0);
    text = (h.lane.label || h.lane.name) + (h.t.kf ? ' · keyframe' : '') + ' · ' + rel.toFixed(2) + 's · frame ' + Math.round(rel * fps)
         + (_tlValText ? ' · ' + _tlValText : '');
  }
  _tlWriteReadout(text);
}
var _tlReadoutTimer = null;
function _tlWriteReadout(text) {
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
  // The row's own clip when it says (clipT: start, media in-point, speed): a
  // linked clip's audio rows sit beside its video rows and can be trimmed differently
  var ct = p.clipT;
  var mediaSec = ct ? _toMedia({ clipStart: ct[0], clipIn: ct[1], speed: ct[2] }, info.t.sec)
               : s.tl ? _toMedia(s.tl, info.t.sec) : info.t.sec;
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
  // Change-only writes: this runs from the .main-row ResizeObserver, which UXP
  // fires on scroll too, and UXP relayouts the panel on every style write
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
  function _wireTlScroll(el) {
    var swapped = _tlEls.scroll && _tlEls.scroll !== el;
    _tlEls.scroll = el;
    el.addEventListener('scroll', _tlUpdateFade);
    _smoothWheel(el);           // UXP: proper wheel steps with easing
    _sdWatch(el, 'timeline box');
    _holdFixWatch(el);          // fresh element after each scroll burst
    el._ocRewire = _wireTlScroll;
    // The swap's scrollTop restore can land before this listener exists (or
    // fire nothing at 0), so settle the fades once on the replacement, with the
    // sizes measured before the swap (see _tlUpdateFade)
    if (swapped) _tlUpdateFade('keep');
  }
  if (_tlEls.scroll) _wireTlScroll(_tlEls.scroll);
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
    // Settings > Double-Click Lanes off: a second press is just another jump
    if (_tlDblOn && lastUp && li >= 0 && lastUp.lane === li && now - lastUp.t < _TL_DBL_MS && Math.abs(p.x - lastUp.x) < 12) {
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
  svg.addEventListener('dblclick', function(e) { if (_tlDblOn) toggleLane(laneAt(pos(e).y)); });
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
    // Moves are applied once per frame: each width write relayouts the panel
    // in UXP, and writing per move held the drag to ~38 events a second with
    // ~100ms stalls (measured live 2026-11-22)
    var _pX = null, _pRaf = 0;
    function _applyPropsW() {
      _pRaf = 0;
      if (_pX === null) return;
      var w = Math.max(_TL_PROPS_MIN, Math.min(_tlMaxPropsW(), _rw + (_rx - _pX)));
      _pX = null;
      if (w === _tlPropsW && props.style.width === w + 'px') return;
      props.style.width = w + 'px';
      props.style.flex  = '0 0 ' + w + 'px';
      _tlPropsW = w;
      _tlSetGoWidth();
    }
    handle.addEventListener('pointermove', function(e) {
      if (!_resizing) return;
      _pX = e.clientX;
      if (!_pRaf) _pRaf = requestAnimationFrame(_applyPropsW);
    });
    function _endResize() {
      if (_pRaf) { cancelAnimationFrame(_pRaf); _applyPropsW(); } // the last move lands before the save
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
  if (!el || !_PRESS_STATE_ON) return;
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
  if (!el || !_TOOLTIPS_ON) return;
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
  // Property buttons
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
        propDiamond.innerHTML = '<svg width="10" height="10" viewBox="-1 -1 10 10" fill="none"><polygon class="mk-diamond" points="4,0.9 7.1,4 4,7.1 0.9,4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path class="mk-tick" d="M0.7 4.4 L3.1 6.8 L7.4 1.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" opacity="0" visibility="hidden"/></svg>';
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
        propUndo.innerHTML = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M2.4 5H8.3a3.3 3.3 0 010 6.6H5.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 2.4L2.4 5l2.6 2.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
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
        propCurve.innerHTML = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M1.8 12.2C6 12.2 8 1.8 12.2 1.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'; // the path becomes the baked curve (sync pass)
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
        propPin.innerHTML = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><line x1="1.5" y1="7" x2="9" y2="7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M6 3.8L9.2 7 6 10.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><line x1="12" y1="3.2" x2="12" y2="10.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
        propPin.addEventListener('click', function(ev) {
          ev.stopPropagation();
          // Rows persist across polls, so look up the latest jump time by key
          // rather than using the `p` captured when this row was built.
          var live = (getState().availableParams || []).filter(function(x){ return x.key === p.key; })[0];
          _jumpToParam(live || p);
        });
        // Bake: Go for this property alone, without selecting it. On every row
        // without a bake. Outside the property's pairs it jumps to the nearest
        // one first, like Go; dimmed when there is none (sync pass, _bakeMode)
        var propBake = document.createElement('span');
        propBake.className = 'prop-bake';
        _addPressState(propBake);
        _attachTooltip(propBake, function() {
          var m = propBake._ocMode;
          return m === 'jump' ? 'Jump to this property\'s nearest keyframe pair (press again to apply the curve)'
               : m === 'off'  ? 'No keyframe pair to apply the curve to'
               : 'Apply the curve to this property now';
        });
        propBake.innerHTML = _icBolt;
        propBake.addEventListener('click', function(ev) {
          ev.stopPropagation();
          _bakeRowKey(p.key);
        });
        btn.appendChild(propCurve);
        btn.appendChild(propReplace);
        btn.appendChild(propUndo);
        btn.appendChild(propBake);
        btn.appendChild(propPin);
        btn.dataset.key = p.key;
        // The sync pass below reads these instead of querying for them each tick
        btn._oc = { mark: propDiamond, pin: propPin, undo: propUndo, curve: propCurve, replace: propReplace, bake: propBake };
        // Hovering a row lights its lane in the mini timeline (a hovered lane lights the row)
        btn.addEventListener('mouseenter', function() { _tlHighlightLane(p.key); });
        btn.addEventListener('mouseleave', function() { _tlHighlightLane(null); });
        btn.addEventListener('click', function() { _togglePropKey(p.key); });
        propBtns.appendChild(btn);
      });
    }
    // Sync active state. This runs on every render, which is every 100ms poll
    // while the playhead moves, so each row first checks whether anything it
    // draws actually changed: without that it cost four querySelectors, eight
    // classList writes and two inline display writes per row per tick.
    var selKeys   = s.selectedParamKeys || [];
    var bakedKeys = s.bakedParamKeys   || [];
    var validKeys = s.validParamKeys   || [];
    propBtns.querySelectorAll('.prop-btn').forEach(function(btn) {
      var k = btn.dataset.key;
      var isSel      = selKeys.indexOf(k) >= 0;
      var isBakedRow = bakedKeys.indexOf(k) >= 0;
      var isValid    = validKeys.indexOf(k) >= 0;
      var brec       = isBakedRow ? _bakeRecFor(s, k) : null;
      var hasCurve   = !!(brec && brec.curve);
      var replOk     = _replaceOk(brec, s.curve);
      var stateKey   = (isSel ? 's' : '') + (isBakedRow ? 'b' : '') + (isValid ? 'v' : '') + (hasCurve ? 'c' : '') + (replOk ? 'r' : '') + (!isValid && !isBakedRow && _rowNearSec(s, k) !== null ? 'j' : '');
      // The Load Curve icon draws the baked curve: compared as its path, so a
      // Replace (a new curve with the same state key) redraws it
      var curveD     = hasCurve ? _rowCurveD(brec.curve) : '';
      if (btn._ocState === stateKey && btn._ocCurveD === curveD) return;
      btn._ocState = stateKey;
      if (btn._ocCurveD !== curveD) {
        btn._ocCurveD = curveD;
        var cvEl = (btn._oc && btn._oc.curve) || btn.querySelector('.prop-curve');
        var cvPath = cvEl && cvEl.querySelector('path');
        if (cvPath && curveD) cvPath.setAttribute('d', curveD);
      }
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
      var bakeEl = els.bake || btn.querySelector('.prop-bake');
      if (bakeEl) {
        var bd = isBakedRow ? 'none' : 'flex'; if (bakeEl.style.display !== bd) bakeEl.style.display = bd;
        _styleBakeBtn(bakeEl, _bakeMode(s, k, isValid));
      }
    });
  }

  // Status strip
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

  // Go button
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
    // A row's bolt shows its own spinner, not Go's
    var goBusy = s.isBaking && !_rowBakeKey;
    var onD = goBusy ? 'none' : 'inline', spD = goBusy ? 'inline-block' : 'none';
    if (goArrow   && goArrow.style.display   !== onD) goArrow.style.display   = onD;
    if (goLabel   && goLabel.style.display   !== onD) goLabel.style.display   = onD;
    if (goSpinner && goSpinner.style.display !== spD) goSpinner.style.display = spD;
  }

  _tlRender(s);
  _centerIcons();
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

// UXP's flex centring leaves the 14px button icons a little down and right
// of centre, and stylesheet rules on the SVGs reach only some of them, so each
// icon is pinned inline half a pixel short of the exact centre of its button:
// at the centre offset (6px / 4px) the icons sat a pixel down and right, one
// pixel less put them a pixel up and left, so UXP paints the SVG content half
// a pixel off its box (checked by eye, 2026-09). Run after every render
// because the property rows are rebuilt there.
// One offset for a square button, [left, top] for a wide one (the pager's 48x22 arrows)
var _ICON_OFF = { 'tool-btn': 4.5, 'prop-pin': 3.5, 'prop-undo': 3.5, 'prop-curve': 3.5, 'prop-replace': 3.5, 'prop-bake': 3.5, 'btn-undo': 3.5, 'pager-btn': [15.5, 2.5] };
function _centerIcons() {
  Object.keys(_ICON_OFF).forEach(function(cls) {
    var o = _ICON_OFF[cls], offX = (o.length ? o[0] : o) + 'px', offY = (o.length ? o[1] : o) + 'px';
    var svgs = document.querySelectorAll('.' + cls + ' > svg');
    for (var i = 0; i < svgs.length; i++) {
      var sv = svgs[i];
      if (sv._ocCentered) continue;
      sv._ocCentered = true;
      sv.style.display  = sv.style.display === 'none' ? 'none' : 'block';
      sv.style.position = 'absolute';
      sv.style.left     = offX;
      sv.style.top      = offY;
      sv.style.margin   = '0';
      sv.style.padding  = '0';
    }
  });
}

// ─── Post-scroll pointer freeze: diagnostic + elimination switches (UXP) ──
// CCX build: after wheel-scrolling a list, the OS delivers NO pointer events
// to that scroll view for ~500ms after its last scroll change, or until the
// pointer leaves it (measured 2026-09-11/12, first real event at +500..+550ms
// in every burst; a press before that is dropped before JS). Events earlier
// than ~60ms after a scroll change are synthesized by content moving under a
// still pointer. It is the platform: a bare test plugin with nothing in it
// (F:/tmp/oc-scrolltest) measures the same in a docked panel and in a dialog,
// and with every switch below off this panel measured the same too. What
// does end it: a fresh scroller element (kick 6 below measured 61-68ms), now
// shipped as _refreshScroller in the next block. Fewer notches help too
// (_smoothWheel's amplification). Flyout > Scroll Debug prints the
// measurement, one short block per scroll burst:
//   [OC-SCROLL] burst: <scroller> top=<px>
//   [OC-SCROLL] +<ms> quiet          (a 100ms window with no OS pointer event)
//   [OC-SCROLL] FIRST real event +<ms>: <type> -> <target>   <= the dead window
//   [OC-SCROLL] pointerdown/click +<ms> -> <target>
//   [OC-SCROLL] burst done: <n> scroll events over <ms>ms, dead window <ms>ms
// Protocol: one notch, keep the mouse moving over the tiles, then click.
// Well-behaved = FIRST real event under ~100ms. document.elementFromPoint
// always returns null in UXP, don't use it.
var _SINK_FOCUS_ON  = true;  // false = never focus #oc-key-sink (Enter-to-Go and the shortcuts stop)
var _TOOLTIPS_ON    = true;  // false = _attachTooltip attaches nothing
var _PRESS_STATE_ON = true;  // false = _addPressState attaches nothing (hover/pressed classes)
var _POLL_ON        = true;  // false = the host is never polled after startup (rows/timeline freeze)
var _THUMBS_ON      = true;  // false = preset tiles are built without their SVG thumbnail
var _TRANSITIONS_ON = true;  // false = a style rule kills every CSS transition/animation at init
var _CONTAIN_ON     = true;  // false = contain:none on #all-presets-list at init
var _SCROLL_KICK    = 0;     // experiment tooling only; the shipped workaround is _refreshScroller. A number or a list rotated per burst. After a scroll: 1 = toggle a transform on the scroller, 2 = re-create its scroll view (overflow off/on, scrollTop kept), 3 = pointer-events:none for one frame, 4 = display:none and back, 5 = detach and re-insert the same node, 6 = swap the list for a fresh element rebuilt by _renderPresets (a clone elsewhere). Leaving the list by hand ends the hold at once, so the aim is a view the pointer has not scrolled
var _SCROLL_KICK_MS = 40;    // delay after the last scroll event of a burst
var _SCROLL_TESTLIST = false; // a bare plain scroller (40 rows) floated over the graph, watched as 'bare list', never kicked: tells the list's structure from any scroll view in this panel
var _DEBUG_SCROLL_KEY = 'opencurve-debug-scroll';
var _debugScroll = _DEV_MENU && localStorage.getItem(_DEBUG_SCROLL_KEY) === 'on';
function _toggleDebugScroll() {
  _debugScroll = !_debugScroll;
  localStorage.setItem(_DEBUG_SCROLL_KEY, _debugScroll ? 'on' : 'off');
  if (_debugScroll) {
    console.log('[OC-SCROLL] ON. Switches: sink ' + _SINK_FOCUS_ON + ', tooltips ' + _TOOLTIPS_ON + ', pressState ' + _PRESS_STATE_ON
      + ', poll ' + _POLL_ON + ', wheel ' + _WHEEL_ON + '/' + _WHEEL_MS + 'ms, kick ' + _SCROLL_KICK
      + ', thumbs ' + _THUMBS_ON + ', transitions ' + _TRANSITIONS_ON + ', contain ' + _CONTAIN_ON + ', bare list ' + _SCROLL_TESTLIST
      + ', holdFix ' + _HOLD_FIX + '/' + _HOLD_FIX_MS + 'ms'
      + ', dropped listener types [' + _EVT_SKIP.join(', ') + ']');
  }
  _showCopyToast('Scroll debug ' + (_debugScroll ? 'ON: scroll a list, keep the mouse moving, then click' : 'OFF'));
}
var _sd = { last: 0, name: '', el: null, x: -1, y: -1, timer: null, n: 0, burst0: 0, cnt: 0, late: 0, dead: -1, kickTimer: null };
function _sdDesc(el) {
  if (!el) return 'null';
  var d = el.id ? '#' + el.id : (typeof el.className === 'string' && el.className ? '.' + el.className.split(' ')[0] : el.nodeName);
  var tile = el.closest ? (el.closest('.preset-btn') || el.closest('.prop-btn')) : null;
  if (tile) d += ' "' + (tile.textContent || '').trim().slice(0, 18) + '"';
  return d;
}
function _sdInside(el, x, y) {
  var r = el.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}
function _sdWatch(el, name, noKick) {
  if (!el || el._sdWatched) return;
  el._sdWatched = true;
  el.addEventListener('scroll', function() {
    if (el._sdKicking) return;
    var now = Date.now();
    if (_SCROLL_KICK && !noKick) {
      if (_sd.kickTimer) clearTimeout(_sd.kickTimer);
      _sd.kickTimer = setTimeout(function() { _sdKick(el); }, _SCROLL_KICK_MS);
    }
    if (!_debugScroll) return;
    if (now - _sd.last > 300) {
      _sd.n = 0; _sd.burst0 = now;
      console.log('[OC-SCROLL] burst: ' + name + ' top=' + el.scrollTop);
    }
    _sd.n++; _sd.last = now; _sd.name = name; _sd.el = el; _sd.late = 0; _sd.cnt = 0; _sd.dead = -1;
    if (_sd.timer) clearTimeout(_sd.timer);
    _sd.timer = setTimeout(_sdProbe, 100);
  });
}
var _sdKickN = 0;
var _renderPresetsRef = null; // set in initPanel; kick 6 rebuilds the preset list into a fresh element with it
var _presetMatchRef   = null; // set by initPanel: id of the preset with a given curve (Load Baked Curve)
var _resetPresetsRef  = null; // set in initPanel; Reset All Settings rebuilds the preset list with it
function _sdKick(el) {
  _sd.kickTimer = null;
  var kind = Array.isArray(_SCROLL_KICK) ? _SCROLL_KICK[_sdKickN++ % _SCROLL_KICK.length] : _SCROLL_KICK;
  el._sdKicking = true;
  var top = el.scrollTop, done = el;
  try {
    if (kind === 1) { el.style.transform = 'translateZ(0)'; void el.offsetHeight; el.style.transform = ''; }
    else if (kind === 2) { el.style.overflowY = 'hidden'; void el.offsetHeight; el.style.overflowY = 'auto'; el.scrollTop = top; }
    else if (kind === 3) { el.style.pointerEvents = 'none'; void el.offsetHeight; setTimeout(function() { el.style.pointerEvents = ''; }, 16); }
    else if (kind === 4) { var disp = el.style.display; el.style.display = 'none'; void el.offsetHeight; el.style.display = disp; el.scrollTop = top; }
    else if (kind === 5) { var par = el.parentNode, next = el.nextSibling; par.removeChild(el); void par.offsetHeight; par.insertBefore(el, next); el.scrollTop = top; }
    else if (kind === 6) {
      // A brand-new element (so a brand-new native scroll view) rebuilt by the
      // real renderer, so tiles keep their handlers; clone only as a fallback
      var c;
      if (el.id === 'all-presets-list' && _renderPresetsRef) {
        c = document.createElement('div');
        c.id = el.id; c.className = el.className; c.style.cssText = el.style.cssText;
        c._sdKicking = true;
        el.parentNode.replaceChild(c, el);
        _renderPresetsRef();
        _applyPresetLayout(true);
      } else {
        c = el.cloneNode(true);
        c._sdKicking = true;
        el.parentNode.replaceChild(c, el);
      }
      c.scrollTop = top;
      _sdWatch(c, _sd.name);
      _smoothWheel(c);
      if (_sd.el === el) _sd.el = c;
      done = c;
    }
  } catch(err) { if (_debugScroll) console.log('[OC-SCROLL] kick ' + kind + ' threw: ' + err); }
  setTimeout(function() { done._sdKicking = false; el._sdKicking = false; }, 50);
  if (_debugScroll) console.log('[OC-SCROLL] kick ' + kind + ' applied to ' + (el.id || el.nodeName) + ' (top ' + top + ' -> ' + done.scrollTop + ')');
}
function _sdProbe() {
  _sd.timer = null;
  if (!_debugScroll || !_sd.el) return;
  var dt = Date.now() - _sd.last;
  if (dt > 1500) {
    console.log('[OC-SCROLL] burst done: ' + _sd.n + ' scroll events over ' + (_sd.last - _sd.burst0) + 'ms, dead window '
      + (_sd.dead < 0 ? 'unknown (no OS pointer event seen in 1.5s)' : _sd.dead + 'ms'));
    return;
  }
  if (!_sd.cnt && !_sd.late) console.log('[OC-SCROLL] +' + dt + ' quiet');
  _sd.cnt = 0;
  _sd.timer = setTimeout(_sdProbe, 100);
}
function _sdInit() {
  ['pointermove', 'pointerover', 'pointerdown', 'pointerup', 'click'].forEach(function(type) {
    document.addEventListener(type, function(e) {
      if (type === 'pointermove') { _sd.x = e.clientX; _sd.y = e.clientY; }
      if (!_debugScroll || !_sd.el) return;
      var dt = Date.now() - _sd.last;
      if (dt > 1500) return;
      _sd.cnt++;
      // Events in the first 60ms after a scroll change are synthesized by the
      // content moving under the pointer; the first one after that is the OS
      if (!_sd.late && dt >= 60) {
        _sd.late = dt; _sd.dead = dt;
        console.log('[OC-SCROLL] FIRST real event +' + dt + 'ms: ' + type + ' -> ' + _sdDesc(e.target));
      }
      if (type === 'pointerdown' || type === 'click') console.log('[OC-SCROLL] ' + type + ' +' + dt + 'ms -> ' + _sdDesc(e.target));
    }, true);
  });
}

// ─── Post-scroll input hold: the workaround (UXP) ──────────────────────────
// UXP keeps OS pointer input off a scroll view for 500ms after its last
// scroll change, unless the pointer leaves it (measured, see the block above).
// The hold belongs to the element's native scroll view: a brand-new element
// with the same children has none (measured 61-68ms with kick 6 on
// 2026-09-12, against ~500ms for hide/show, overflow toggles or detaching and
// re-inserting the same node). So _HOLD_FIX_MS after the last scroll event of
// a burst the scroller is replaced by a fresh element and its children are
// moved across, which keeps every handler on them; each scroller's wiring is
// a function stored as el._ocRewire and run again on the replacement.
// Skipped while a press is in progress (drag-sort, a scrollbar drag) or a
// field inside the scroller has focus (a rename).
var _HOLD_FIX    = true; // false = leave UXP's 500ms post-scroll hold alone (tried 2026-09-17, the 7px notches and dead half-second felt worse)
var _HOLD_FIX_MS = 40; // after the last scroll event; the amplification's own writes count, so its ease runs first
var _ocPtrDown   = false;
var _ocHoldDeferred = null; // scroller whose refresh was skipped because a press was in progress
var _ocCursorHeld   = null; // element carrying the hovered cursor across a swap (cleared on the next hover)
document.addEventListener('pointerdown',   function(e) { _ocPtrDown = true; _ocPtrX = e.clientX; _ocPtrY = e.clientY; }, true);
document.addEventListener('pointerup',     function() { _ocPtrDown = false; _holdFixResume(); }, true);
document.addEventListener('pointercancel', function() { _ocPtrDown = false; _holdFixResume(); }, true);

// Lost releases (2026-11-23, CCX only): a double-click anywhere left whatever
// was pressed dragging after the button was let go, so every press-drag (graph
// handles, preset reorder, the dividers, the timeline height) waited for a
// pointerup that never came. Windows sends the second press of a double-click
// as its own message and UXP evidently doesn't always give it a matching
// pointerup. Every drag here ends on pointerup, so a press whose release went
// missing gets a synthetic one, dispatched at the element that was pressed (it
// bubbles through the capturing parent), as soon as anything shows the button
// is up: a click, dblclick or mouseup with no pointerup since the press, or a
// move reporting no button held. A real pointerup clears the pending press
// first, so a normal press never gets a second one; the drag ends are
// idempotent anyway. Not confirmed with an event log in the CCX yet (the UDT
// probe of 2026-11-23 couldn't open the panel next to the installed one).
var _ocPress = null; // { target, id, x, y } while a press waits for its pointerup
function _ocSynthUp(why, x, y) {
  var p = _ocPress;
  _ocPress = null;
  if (!p || !p.target) return;
  console.log('[OC] pointerup missing after a press (' + why + '); ending it');
  var init = { bubbles: true, cancelable: true, pointerId: p.id, isPrimary: true, button: 0, buttons: 0,
               clientX: x != null ? x : p.x, clientY: y != null ? y : p.y, pointerType: 'mouse' };
  // A plain Event with the fields the handlers read, never `new PointerEvent`:
  // UXP's PointerEvent constructor ignores its init (pointerId, clientX and
  // detail come back empty) and dispatching one hands it to UXP's native event
  // path, which throws "Cannot read properties of undefined (reading 'detail')"
  // inside dispatchNativeEvent (measured live 2026-11-23, Premiere 26.0.2; it
  // happened on every double-click). A plain Event dispatches cleanly.
  var ev;
  try { ev = new Event('pointerup', { bubbles: true, cancelable: true }); } catch(_) { return; }
  ['pointerId', 'isPrimary', 'button', 'buttons', 'clientX', 'clientY', 'pointerType'].forEach(function(k) {
    try { Object.defineProperty(ev, k, { value: init[k] }); } catch(_) {}
  });
  ev._ocSynth = true;
  var t = p.target;
  if (!t.isConnected && t.parentNode == null) t = document; // rebuilt under the press: the document listeners still end it
  try { t.dispatchEvent(ev); } catch(e) { console.log('[OC] synthetic pointerup failed:', e); }
  // Some drags never release their capture themselves; whichever element
  // still holds it (the pressed one or a parent) lets go here
  for (var n = p.target; n && n.hasPointerCapture; n = n.parentNode) {
    try { if (n.hasPointerCapture(p.id)) n.releasePointerCapture(p.id); } catch(_) {}
  }
}
document.addEventListener('pointerdown', function(e) {
  if (e.button !== 0) return;
  _ocPress = { target: e.target, id: e.pointerId, x: e.clientX, y: e.clientY };
}, true);
document.addEventListener('pointerup',     function(e) { if (!e._ocSynth) _ocPress = null; }, true);
document.addEventListener('pointercancel', function() { _ocPress = null; }, true);
['click', 'dblclick', 'mouseup'].forEach(function(type) {
  document.addEventListener(type, function(e) {
    if (_ocPress && (type !== 'mouseup' || e.button === 0)) _ocSynthUp(type, e.clientX, e.clientY);
  }, true);
});
document.addEventListener('pointermove', function(e) {
  if (_ocPress && typeof e.buttons === 'number' && (e.buttons & 1) === 0) _ocSynthUp('move without button', e.clientX, e.clientY);
}, true);
// The next real hover ends the carried cursor: UXP has hit-tested again by then
document.addEventListener('pointerover', function() {
  if (_ocCursorHeld) { _ocCursorHeld.style.cursor = ''; document.body.style.cursor = ''; _ocCursorHeld = null; }
}, true);
// Native scrollbar drags (2026-11-22: dragging Settings' scrollbar in the CCX
// kept letting go). Nothing showed the panel that the scrollbar was held, so a
// drag's small steps were taken as wheel notches and eased away from the thumb,
// and a pause of _HOLD_FIX_MS swapped the scroller out from under the drag.
// The panel now remembers where the pointer was last seen; while that is in a
// scroller's scrollbar strip (its right _SCROLLBAR_STRIP px, generous because
// UXP may send no pointer events over the native scrollbar itself), scroll
// steps aren't notches and the swap waits until the pointer is seen elsewhere.
var _ocPtrX = -1, _ocPtrY = -1;
var _SCROLLBAR_STRIP = 18;
function _onScrollbar(el) {
  if (_ocPtrX < 0 || !el || el.scrollHeight <= el.clientHeight) return false;
  var r = el.getBoundingClientRect();
  return _ocPtrY >= r.top && _ocPtrY <= r.bottom && _ocPtrX <= r.right && _ocPtrX >= r.right - _SCROLLBAR_STRIP;
}
document.addEventListener('pointermove', function(e) {
  _ocPtrX = e.clientX; _ocPtrY = e.clientY;
  // A swap held back for the scrollbar: do it once the pointer has left it
  if (_ocHoldDeferred && !_ocPtrDown && !_onScrollbar(_ocHoldDeferred)) _holdFixResume();
}, true);
function _holdFixResume() {
  // A press skipped the refresh (so a drag was not broken); do it once the press ends
  var el = _ocHoldDeferred;
  _ocHoldDeferred = null;
  if (el) setTimeout(function() { _holdFixTry(el); }, 20);
}
function _holdFixTry(el) {
  if (!el.parentNode) return;
  if (_ocPtrDown || _onScrollbar(el)) { _ocHoldDeferred = el; return; } // a press, or the pointer on the scrollbar
  // A wheel ease still running (its frames stalled behind a heavy poll, so the
  // scroll events went quiet before it landed): swapping now would copy an
  // intermediate position and let the rest of the ease run on the detached
  // node, so the list stopped short or sat back where the notch began. Wait.
  if (el._ocWheelActive && el._ocWheelActive()) { setTimeout(function() { _holdFixTry(el); }, _HOLD_FIX_MS); return; }
  var ae = document.activeElement;
  if (ae && ae !== document.body && el.contains(ae)) return; // a field inside (a rename) has focus
  _refreshScroller(el);
}
function _holdFixWatch(el) {
  if (!_HOLD_FIX || !el || el._ocHoldFix) return;
  el._ocHoldFix = true;
  var timer = null;
  el.addEventListener('scroll', function() {
    if (el._ocRefreshing) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(function() { timer = null; _holdFixTry(el); }, _HOLD_FIX_MS);
  });
}
function _refreshScroller(el) {
  if (el._ocWheelFinish) el._ocWheelFinish(); // land any ease first, so the position carried over is the intended one
  var fresh = el.cloneNode(false), top = el.scrollTop; // same tag, attributes and inline style, no children
  // The swap takes the hovered element out of the document for an instant and
  // UXP drops the cursor to the arrow until the next mouse move; carry the
  // hovered element's cursor on the new scroller and the body until then
  var cursor = '';
  try {
    var hov = el.querySelectorAll(':hover');
    if (hov.length) cursor = getComputedStyle(hov[hov.length - 1]).cursor || '';
  } catch(_) {}
  fresh._ocRefreshing = true;
  while (el.firstChild) fresh.appendChild(el.firstChild);
  el.parentNode.replaceChild(fresh, el);
  fresh.scrollTop = top;
  if (cursor && cursor !== 'auto' && cursor !== 'default') {
    fresh.style.cursor = cursor;
    document.body.style.cursor = cursor;
    _ocCursorHeld = fresh;
  }
  if (typeof el._ocRewire === 'function') el._ocRewire(fresh);
  setTimeout(function() { fresh._ocRefreshing = false; }, 60);
  if (_debugScroll) console.log('[OC-SCROLL] scroller refreshed: #' + fresh.id + ' (top ' + top + ' -> ' + fresh.scrollTop + (cursor ? ', cursor ' + cursor : '') + ')');
  return fresh;
}

// ─── Smooth wheel scrolling (UXP) ─────────────────────────────────────────
// UXP delivers no wheel events at all (checked 2026-09: nothing on the
// element, document or window, and `onwheel` isn't even a property). Its own
// wheel handling scrolls a fixed few px per notch (9, later 11 on the same
// machine) with no easing and fires a `scroll` event for it. So the wheel is
// amplified after the fact: a scroll event whose step is at most
// _UXP_NOTCH_MAX px is taken as one notch, and scrollTop is eased on to where
// a _WHEEL_STEP notch would land. Fewer notches also means fewer of UXP's
// 500ms post-scroll input holds (see the block above).
// Our own writes fire scroll events too; they are recognised by landing on
// the value just written and ignored. Any other step (the scrollbar being
// dragged, a programmatic jump) cancels the easing and is left alone.
var _UXP_NOTCH_MAX = 24; // any scroll step up to this is taken as one wheel notch (UXP moved 9px per notch, later 11px)
var _WHEEL_STEP = 90;
var _WHEEL_MS   = 110; // ease duration; 0 = one write per notch, no easing (tried 2026-09-17, the 110ms glide felt best)
var _WHEEL_ON   = true;  // false = leave UXP's own per-notch scrolling alone (tried 2026-09-17, felt worse)
function _smoothWheel(el) {
  if (!_WHEEL_ON || !el || el._ocWheel) return;
  el._ocWheel = true;
  // UXP applies a notch to the position its view last painted, which can lag
  // several frames behind the panel's writes when the main thread is busy
  // (measured 2026-09-17: the ease had written 43 when the next notch landed at
  // 7 + 7 = 14, then at 43 + 7 = 50 once the write was consumed). So a step is
  // measured against whichever reference is nearest: UXP's own last position
  // (lastUxp) or the panel's last write (lastWrite), and the panel's intended
  // position is reasserted rather than followed back to the stale one.
  var target = null, raf = 0, wrote = [], from = 0, t0 = 0;
  var lastUxp = el.scrollTop, lastWrite = null, lastNotchAt = 0;
  // Own writes are recognised by value; a list, since two writes can land
  // before the first one's scroll event arrives
  function write(v) { wrote.push({ v: v, t: Date.now() }); if (wrote.length > 8) wrote.shift(); lastWrite = v; el.scrollTop = v; }
  function finish() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (target !== null && el.scrollTop !== target) write(target);
    target = null;
  }
  function step() {
    raf = 0;
    if (target === null) return;
    var p = Math.min(1, (Date.now() - t0) / _WHEEL_MS);
    var e = 1 - Math.pow(1 - p, 3); // ease-out: fast at first, settles quickly
    var next = Math.round(from + (target - from) * e);
    if (p >= 1) { finish(); return; }
    if (next !== el.scrollTop) write(next);
    raf = requestAnimationFrame(step);
  }
  el.addEventListener('scroll', function() {
    var top = el.scrollTop;
    var wi = -1, wnow = Date.now();
    while (wrote.length && wnow - wrote[0].t > 300) wrote.shift(); // events coalesce, so old entries just expire
    for (var k = 0; k < wrote.length; k++) if (wrote[k].v === top) { wi = k; break; }
    if (wi >= 0) { wrote.splice(wi, 1); return; } // our own write landing
    // Nearest reference: UXP's own last position, or our last write once consumed
    var ref = lastUxp, d = top - lastUxp;
    if (lastWrite !== null && Math.abs(top - lastWrite) < Math.abs(d)) { ref = lastWrite; d = top - lastWrite; }
    lastUxp = top;
    if (!d) return;
    var now = Date.now();
    var max = el.scrollHeight - el.clientHeight;
    if (Math.abs(d) > _UXP_NOTCH_MAX || _ocPtrDown || _onScrollbar(el)) {
      // scrollbar drag or a jump: not the wheel, stop easing and follow it
      if (_debugScroll) console.log('[OC-SCROLL] jump ' + ref + ' -> ' + top + (target !== null ? ' (ease to ' + target + ' cancelled)' : ''));
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      target = null; lastWrite = null; wrote = [];
      return;
    }
    var notches = d > 0 ? 1 : -1;
    // Where the panel meant to be: the running ease's target, else the last
    // write (UXP may not have painted it yet), else the position before the notch
    var base = target !== null ? target : (lastWrite !== null && now - lastNotchAt < 1000 ? lastWrite : top - d);
    lastNotchAt = now;
    var want = Math.max(0, Math.min(max, Math.round(base + notches * _WHEEL_STEP)));
    if (want === top) { target = null; return; }
    if (_debugScroll && ref !== top - d) console.log('[OC-SCROLL] lagged notch ' + ref + ' -> ' + top + ', intended ' + base + ' -> ' + want);
    target = want;
    if (_WHEEL_MS <= 0) { finish(); return; } // no easing: land in one write
    // Ease from the intended position, not the stale one UXP just showed
    from = (ref === lastWrite && lastWrite !== null) ? top : (lastWrite !== null ? lastWrite : top);
    from = Math.max(0, Math.min(max, from));
    if (from !== top) write(from);
    t0 = now;
    if (!raf) raf = requestAnimationFrame(step);
  });
  // A press while easing: land now so the click hits what the user sees
  el.addEventListener('pointerdown', finish, true);
  // _holdFixTry waits for a running ease; _refreshScroller lands it before a swap
  el._ocWheelActive = function() { return target !== null; };
  el._ocWheelFinish = finish;
}

// ─── Panel init ───────────────────────────────────────────────────────────
function initPanel() {
  console.log('[FS] initPanel called');
  // Scroll-freeze elimination switches (see the block before _smoothWheel)
  if (!_TRANSITIONS_ON) {
    var _noTr = document.createElement('style');
    _noTr.textContent = '* { transition: none !important; animation: none !important; }';
    document.head.appendChild(_noTr);
  }
  if (!_CONTAIN_ON) { var _pl = document.getElementById('all-presets-list'); if (_pl) _pl.style.contain = 'none'; }

  var svg = document.getElementById('bezier-svg');
  if (svg) {
    initGraphEditor(svg); // handles initial sizing + draw via ResizeObserver
  }

  // A-curve (peak) mode toggle
  _tlInit(); // mini timeline strip along the bottom
  // Preset list: pages, not a scroller (the paging block after _updateGridCols),
  // so none of the scroll-view work (_smoothWheel, _holdFixWatch, the
  // _refreshScroller swap) applies to it any more; the lanes + rows box and
  // Settings still use all of that
  var _presetRO = null;
  (function(el) {
    if (!el) return;
    el.addEventListener('contextmenu', function(e) {
      // Right-click on empty space: Open Settings alone; presets have their own menu
      var onPreset = e.target.closest && e.target.closest('.preset-btn');
      if (onPreset) return;
      _showMiniCtxMenu(e, true);
    });
  })(document.getElementById('all-presets-list'));
  _presetPagerInit();
  _sdInit(); // post-scroll freeze diagnostic (logs only while Flyout > Scroll Debug is on)
  if (_SCROLL_TESTLIST) {
    var _bare = document.createElement('div');
    _bare.id = 'oc-bare-list';
    _bare.style.cssText = 'position:fixed;left:8px;bottom:70px;width:150px;height:110px;overflow-y:auto;background:#222;border:1px solid #666;z-index:5000;font-size:12px;color:#ccc;';
    for (var bi = 1; bi <= 40; bi++) {
      var br = document.createElement('div');
      br.textContent = 'bare row ' + bi;
      br.style.cssText = 'padding:3px 6px;border-bottom:1px solid #333;';
      _bare.appendChild(br);
    }
    document.body.appendChild(_bare);
    _sdWatch(_bare, 'bare list', true);
  }
  _centerIcons(); // UXP: pin the button icons at their centres (see _centerIcons)

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
    if (!keySink || !_SINK_FOCUS_ON || !_shortcutsOn) return;
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
    // A press on a scroller's own scrollbar keeps its focus: moving focus to the
    // sink mid-press could end the native drag
    if (!_ocPressInField && !_onScrollbar(e.target)) setTimeout(function() { _focusSink('pointerdown'); }, 0);
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
    // Settings > Keyboard Shortcuts off: only Esc (closing menus, the zoom
    // slider, a preview, full screen) is still handled
    if (!_shortcutsOn && e.key !== 'Escape') return;
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
    _attachTooltip(fullBtn, function() { return _graphFull ? 'Exit full screen' : 'Full-screen graph'; }, 'right');
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
  // bottom-left corner. When the area is too short for all of them, the
  // column's buttons hide one by one from the bottom with inline display
  // (_sideFits) and the graph menu lists the hidden ones.
  // The bar itself only holds the menu button and the preset chip at the left
  // and New at the right (_tbChipLayout); Full Screen sits under Zoom in the
  // graph area's bottom-left corner.
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
  // Bar: the menu button on the left
  var _TB_NEED = 26 + 10 + 8;
  // Column: the three mode buttons and their 5px gaps from the top + 8px air
  // + Zoom and Full Screen in the bottom-left corner, each 26px + 5px
  // The buttons hide one at a time from the bottom (Add Point, then Bounce,
  // then A-curve) as the area gets shorter: button i (from 0) spans
  // 31i..31i+26 from the top and needs 8px air above Zoom and Full Screen
  var _SIDE_BOTTOM = 8 + 2 * (26 + 5);
  function _sideFits(h) { return Math.max(0, Math.min(_tbTools.length, Math.floor((h - _SIDE_BOTTOM - 26) / 31) + 1)); }
  var _tbShown = null;     // how many of the column's buttons show, from the top
  var _tbCollapsed = null; // any of them hidden
  var _tbDismiss   = null;
  function _hideToolsMenu() {
    var m = document.getElementById('_tools-menu');
    if (m && m.parentNode) m.parentNode.removeChild(m);
    if (_tbDismiss) { window.removeEventListener('pointerdown', _tbDismiss); _tbDismiss = null; }
  }
  // Edited preset chip (#preset-edit-chip, after the menu button) and New
  // (#pe-new, the right end): they share the rest of the bar (_presetEditSync
  // caps the chip with an inline max-width so it never runs into New).
  // Below _PE_CHIP_FULL, Update, Revert and New drop their labels and become
  // 26px icon buttons; once the name would be cut short (_peNameFits) it and
  // "Edited" go and the buttons stay; below _PE_CHIP_BARE the chip hides and
  // below 26px New does too (the dropdown then lists what went).
  var _PE_CHIP_BARE = 88;  // icon-only Update and Revert (57) + New as an icon (31)
  function _tbChipLayout(w) {
    var room = w - 36 - 5; // #pe-center's width: from after the menu button to the bar's right padding
    _peRoom = room;
    _peChipRoom = room >= _PE_CHIP_BARE;
    _peNewRoom = room >= 26;
    _presetEditSync(); // compares first: the name test and the chip's max-width depend on the room
  }
  function _tbLayout() {
    if (!toolbar || !menuBtn) return;
    var w = toolbar.clientWidth;
    if (w > 0) _tbChipLayout(w);
    var h = canvasWrap ? canvasWrap.clientHeight : 0;
    if (!(h > 0)) return; // the graph is hidden
    var shown = _sideFits(h);
    if (shown === _tbShown) return;
    _tbShown = shown;
    _tbCollapsed = shown < _tbTools.length;
    // inline display: UXP ignores class-driven display changes
    _tbTools.forEach(function(b, i) { if (b) { var d = i < shown ? '' : 'none'; if (b.style.display !== d) b.style.display = d; } });
    _hideToolsMenu();
    _hideZoomSlider(); // its anchor may just have been hidden
    _stylePeakBtn(); // the menu button carries the mode's tint while that mode's button is hidden
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
      item('Update "' + edP.name + '"', document.getElementById('pe-save'), _presetEditSave);
      item('Revert to "' + edP.name + '"', document.getElementById('pe-revert'), _presetEditRevert);
    }
    var peNewM = document.getElementById('pe-new');
    if (peNewM && !_peNewShown()) item('New Preset\u2026', peNewM, function() { peNewM.click(); });
    // The side column's hidden buttons (it hides them from the bottom up)
    var _hid = function(b) { return !!b && b.style.display === 'none'; };
    if (_hid(peakBtn))   item(_peakMode ? 'A-curve Mode: On' : 'A-curve Mode', peakBtn, function() { _setPeakMode(!_peakMode); }, { active: _peakMode });
    if (_hid(bounceBtn)) item(_bounceMode ? 'Bounce Mode: On' : 'Bounce Mode', bounceBtn, function() { _setBounceMode(!_bounceMode); }, { active: _bounceMode });
    if (_hid(addPtBtn))  item('Add Point', addPtBtn, function() { if (_peakMode) _setPeakMode(false); _addPoint(); });
    item('Flip',      flipBtn,   function() { _applyCurveOp(_flipCurve); });
    item('Invert',    invertBtn, function() { _applyCurveOp(_invertCurve); });
    item('Numeric Entry', numBtn, function() { _showNumericPanel(); });
    menu.style.left = '0px';
    menu.style.top  = '0px';
    document.body.appendChild(menu);
    _ctxMenuShadow(menu);
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
    _attachTooltip(peSave, function() { var p = _presetEdited(); return p ? 'Overwrite "' + p.name + '" with this curve' : ''; });
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
  var _icPaste = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><rect x="3" y="2" width="8" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/><path fill="none" d="M5.5 2V1.5a1 1 0 011-1h1a1 1 0 011 1V2" stroke="currentColor" stroke-width="1.6"/><line x1="5.5" y1="6" x2="8.5" y2="6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><line x1="5.5" y1="8.5" x2="8.5" y2="8.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
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
  // New Preset shows here only while the graph is off (with the graph on it is
  // New... in the graph bar, #pe-new), so it only counts, and only collapses
  // here, then (_newPresetPlace)
  // Never since 2026-11-23 (Faye's request): with the graph off New Preset is
  // an item in this bar's menu instead of a button here
  function _newInPtb() { return false; }
  // Left: the menu button (and New Preset while it is here); right: List/Grid, Graph, Timeline, Settings
  // ... plus the search box's _PS_MIN and its 5px margin
  var _PS_MIN = 100;
  function _ptbNeed() { var left = _newInPtb() ? 2 : 1; return (left * 26 + (left - 1) * 5) + (4 * 26 + 3 * 5) + 10 + 8 + _PS_MIN + 5; }
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
    if (collapse === _ptbCollapsed) { _psCheckWidth(); return; }
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
    _psCheckWidth(); // the search box's width after the tools moved
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
    // With the graph off the graph bar's New... is hidden too, so New Preset is here
    if (!_graphVisible) item('New Preset…', svgOf('preset-new'), function() { var nb = document.getElementById('preset-new'); if (nb) nb.click(); });
    item('Paste Preset', _icPaste, function() { _pasteCoordinates(); });
    item('Export Presets\u2026', _icExport, function() { _exportPresetsToFile(); });
    item('Import Presets\u2026', _icImport, function() { _importPresetsFromFile(); });
    if (_ptbCollapsed) {
      // The hidden tools, after a divider
      var sep = document.createElement('div');
      sep.style.cssText = 'border-top:1px solid rgba(255,255,255,0.07);margin:3px 0;';
      menu.appendChild(sep);
      item(_presetLayout === 'list' ? 'Grid View' : 'List View',
           svgOf('preset-layout', _presetLayout === 'list' ? '.ic-grid' : '.ic-list'),
           function() { _presetLayout = _presetLayout === 'list' ? 'grid' : 'list'; localStorage.setItem(_LAYOUT_KEY, _presetLayout); _applyPresetLayout(true); });
      item(_graphVisible ? 'Graph: On' : 'Graph: Off', svgOf('toggle-graph'), function() { _setGraphVisible(!_graphVisible); }, { active: _graphVisible });
      item(_tlVisible ? 'Timeline: On' : 'Timeline: Off', svgOf('toggle-timeline'), function() { _setTimelineVisible(!_tlVisible); }, { active: _tlVisible });
    }
    menu.style.left = '0px';
    menu.style.top  = '0px';
    document.body.appendChild(menu);
    _ctxMenuShadow(menu);
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
  // New Preset (#preset-new, next to the preset bar's menu button) shows only
  // while the graph is off; with the graph on, New... in the graph bar
  // (#pe-new) does its job. _applyGraphVisibility calls this on every change.
  var _newPlacedFor = null;
  _newPresetPlace = function() {
    var b = document.getElementById('preset-new');
    if (!b || !ptb || !pMenuBtn || _newPlacedFor === _graphVisible) return;
    _newPlacedFor = _graphVisible;
    if (b.style.display !== 'none') b.style.display = 'none'; // never shown in the bar (the menu has it while the graph is off)
    _ptbCollapsed = null; _ptbLayout();
  };
  _newPresetPlace();
  _ptbLayout();
  _presetSearchInit();

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
      var o = { id: String(p.id || ('p' + i)), name: p.name, curve: _normalizeCurve(_cloneCurve(p.curve)), builtIn: !!p.builtIn };
      var tg = _cleanTag(p.tag);
      if (tg) o.tag = tg; // colour tag
      out.push(o);
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

  // _presetList: array of { id, name, curve, builtIn? }
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

  var _ctxTarget = null; // { preset, btn, startRename }

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
      var t = _ctxTarget; // capture before hide nulls it
      _hideCtxMenu();
      onClick(t);
    });
    _ctxMenu.appendChild(item);
    return item;
  }

  var _icRename = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path fill="none" d="M8.5 2.5l3 3M2 9l6.5-6.5 3 3L5 12H2V9z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var _icCopy = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><rect x="4.5" y="4.5" width="7" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/><path fill="none" d="M9.5 4.5V3a1 1 0 00-1-1H3a1 1 0 00-1 1v5.5a1 1 0 001 1h1.5" stroke="currentColor" stroke-width="1.6"/></svg>';
  var _icOverwrite = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path fill="none" d="M7 2v7M4.5 6.5L7 9l2.5-2.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path fill="none" d="M2 11h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  var _icDelete = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path fill="none" d="M3 4h8M5.5 4V3a1 1 0 011-1h1a1 1 0 011 1v1M4.5 4l.5 7.5a1 1 0 001 .5h2a1 1 0 001-.5L9.5 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  _ctxItem('Rename Preset', false, function(t) {
    if (t) t.startRename();
  }, _icRename);
  _ctxItem('Copy Preset', false, function(t) {
    if (!t) return;
    var c = t.preset.curve;
    var text = _curveToText(c);
    console.log('[FS] Coordinates:', text);
    var copied = false;
    try {
      if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function() {
          console.log('[FS] Copied to clipboard:', text);
          _showCopyToast('Copied!');
        }).catch(function(e) {
          console.log('[FS] clipboard writeText failed:', e);
          _showCopyToast(text);
        });
        copied = true;
      }
    } catch(e) { /* navigator.clipboard not available */ }
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
      _applyPresetLayout(true); // re-pages
    });
  }, _icDelete);
  // Colour tag row (2026-11-23, like Looker): seven swatches with no names
  // after a divider; the preset's own colour wears a ring, and clicking it
  // again takes the tag off. Built once; _showCtxMenu moves the ring.
  var _tagCells = [];
  (function() {
    var sep = document.createElement('div');
    sep.style.cssText = 'border-top:1px solid rgba(255,255,255,0.07);margin:4px 0;';
    _ctxMenu.appendChild(sep);
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;height:30px;padding:0 10px;';
    _TAG_COLOURS.forEach(function(col, i) {
      var cell = document.createElement('div');
      cell.style.cssText = 'display:flex;align-items:center;justify-content:center;flex-shrink:0;width:24px;height:30px;cursor:pointer;';
      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('width', '24'); svg.setAttribute('height', '24'); svg.setAttribute('viewBox', '0 0 24 24');
      var ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      ring.setAttribute('cx', '12'); ring.setAttribute('cy', '12'); ring.setAttribute('r', '10');
      ring.setAttribute('fill', 'none'); ring.setAttribute('stroke', '#d4d4d4'); ring.setAttribute('stroke-width', '1.5');
      ring.setAttribute('visibility', 'hidden'); ring.setAttribute('opacity', '0'); // UXP ignores visibility alone (like _svgShow)
      var dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('cx', '12'); dot.setAttribute('cy', '12'); dot.setAttribute('r', '7');
      dot.setAttribute('fill', col.hex);
      svg.appendChild(ring); svg.appendChild(dot);
      cell.appendChild(svg);
      cell.addEventListener('pointerenter', function() { dot.setAttribute('r', '8'); });
      cell.addEventListener('pointerleave', function() { dot.setAttribute('r', '7'); });
      cell.addEventListener('click', function(ev) {
        ev.stopPropagation();
        var t = _ctxTarget; // capture before hide nulls it
        _hideCtxMenu();
        dot.setAttribute('r', '7');
        if (!t) return;
        var tag = (t.preset.tag | 0) === i + 1 ? 0 : i + 1; // its own colour again: untag
        if (tag) t.preset.tag = tag; else delete t.preset.tag;
        _savePresetList(_presetList);
        if (t.btn) { t.btn._ocTag = tag; _tagSyncTile(t.btn); }
        _applyPresetLayout(true); // a colour filter may now hide or show it
      });
      _attachTooltip(cell, col.name);
      row.appendChild(cell);
      _tagCells.push(ring);
    });
    _ctxMenu.appendChild(row);
  })();
  function _showCtxMenu(preset, btn, startRename, e) {
    var existingMini = document.getElementById('_mini-ctx');
    if (existingMini && existingMini.parentNode) existingMini.parentNode.removeChild(existingMini);
    _ctxTarget = { preset: preset, btn: btn, startRename: startRename };
    _hideTagFilterMenu();
    for (var ti = 0; ti < _tagCells.length; ti++) {
      var mine = (preset.tag | 0) === ti + 1, vis = mine ? 'visible' : 'hidden';
      if (_tagCells[ti].getAttribute('visibility') !== vis) {
        _tagCells[ti].setAttribute('visibility', vis);
        _tagCells[ti].setAttribute('opacity', mine ? '1' : '0');
      }
    }
    _ctxMenuShadow(_ctxMenu);
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
    if (_hideTagFilterMenu()) open = true;
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

    // Thumbnail (_THUMBS_ON: scroll-freeze elimination switch)
    var thumb = null;
    if (_THUMBS_ON) {
      thumb = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      thumb.setAttribute('class', 'preset-thumb');
      thumb.setAttribute('width', '28'); thumb.setAttribute('height', '28'); thumb.setAttribute('viewBox', '0 0 28 28');
      var tp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      tp.setAttribute('fill', 'none'); tp.setAttribute('stroke', _curveColor);
      tp.setAttribute('stroke-width', '2'); tp.setAttribute('stroke-linecap', 'round');
      tp.setAttribute('d', _thumbPathD(preset.curve));
      thumb.appendChild(tp); btn.appendChild(thumb);
      _tileAnimHook(btn, thumb, function() { return preset.curve; });
    }

    // Name
    var nameSpan = document.createElement('span');
    nameSpan.className = 'preset-name';
    nameSpan.textContent = preset.name;
    btn.appendChild(nameSpan);
    btn._ocTag = _cleanTag(preset.tag); // colour tag dot
    _tagSyncTile(btn);

    // Apply curve on click
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
        if (_presetQuery) _applyPresetLayout(true); // the new name may not match the search
      }, opts && opts.title ? opts : null);
    }
    btn._ocRename = startRename; // New Preset / Paste open it for the fresh tile
    btn.addEventListener('contextmenu', function(e) { e.preventDefault(); _showCtxMenu(preset, btn, startRename, e); });

    return btn;
  }

  // Drag-to-reorder (pointer events)
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
    var _flipTimer = null, _flipDir = 0, _lastX = 0, _lastY = 0;

    // Floating ghost of the tile (grid and two-column list from the first move;
    // the one-column list once a drag crosses pages). Its size never changes,
    // so it is measured once here instead of reading offsetWidth/offsetHeight
    // on every move (a read straight after a style write forces a layout).
    function makeGhost(x, y) {
      if (_dragGhost || !dragEl) return;
      var rect = dragEl.getBoundingClientRect();
      _ghostW = rect.width || 80;
      _ghostH = rect.height || 60;
      _dragGhost = dragEl.cloneNode(true);
      _dragGhost.style.cssText = 'position:fixed;z-index:9999;pointer-events:none;opacity:0.6;transform:scale(0.85);width:' + rect.width + 'px;';
      _dragGhost.style.left = (x - _ghostW / 2) + 'px';
      _dragGhost.style.top = (y - _ghostH / 2) + 'px';
      document.body.appendChild(_dragGhost);
      dragEl.style.display = 'none';
    }
    function inRect(el, x, y) {
      if (!el) return false;
      var r = el.getBoundingClientRect();
      return r.width > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    }
    // Hovering a pager arrow while dragging flips the page after _PAGE_FLIP_MS
    // (and again while the pointer stays); the tile follows as its ghost
    function pagerCheck(x, y) {
      var dir = inRect(document.getElementById('preset-pager-prev'), x, y) ? -1
              : inRect(document.getElementById('preset-pager-next'), x, y) ? 1 : 0;
      if (dir === _flipDir) return;
      _flipDir = dir;
      if (_flipTimer) { clearTimeout(_flipTimer); _flipTimer = null; }
      if (!dir) return;
      var tick = function() {
        _flipTimer = null;
        if (!dragEl || !_flipDir) return;
        makeGhost(_lastX, _lastY);
        if (_presetPageStep(_flipDir)) _flipTimer = setTimeout(tick, _PAGE_FLIP_MS);
      };
      _flipTimer = setTimeout(tick, _PAGE_FLIP_MS);
    }

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
        if (_presetCols > 1) makeGhost(e.clientX, e.clientY);
      }
      _lastX = e.clientX; _lastY = e.clientY;
      // Measure before writing anything this move, so the rect reads below don't
      // force a layout on the ghost's new position.
      var isGrid = _presetCols > 1; // grid, or the two-column list
      var items = Array.from(container.children).filter(function(c) {
        return c !== dragEl && c !== dropLine && c.style.display !== 'none'; // this page's tiles
      });
      // Nothing under the pointer: the drop goes after the page's last tile
      // (before the next page's first), not at the end of the whole list
      var endRef = items.length ? items[items.length - 1].nextSibling : null;
      if (endRef === dropLine) endRef = dropLine.nextSibling;
      pagerCheck(e.clientX, e.clientY);
      var after = null;
      if (isGrid) {
        // Insert before the tile the cursor is over (the dragged item takes its place)
        // (each tile's hit box takes half the gap round it, so the gaps between
        // separate tiles never read as empty space)
        var hg = _TILE_GAP / 2;
        for (var i = 0; i < items.length; i++) {
          var r = items[i].getBoundingClientRect();
          if (e.clientX >= r.left - hg && e.clientX <= r.right + hg && e.clientY >= r.top - hg && e.clientY <= r.bottom + hg) {
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
      if (!after) after = endRef;
      // Writes from here down
      var wantHi = (isGrid && after && after !== dragEl && after.style.display !== 'none') ? after : null;
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
      if (_flipTimer) { clearTimeout(_flipTimer); _flipTimer = null; }
      _flipDir = 0;
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
      var didMove = moved, dropped = dragEl;
      dragEl = null; dropLine = null; moved = false;
      // Only after a real reorder (it re-pages too): a plain click used to rewrite
      // every tile's inline styles, and each write relayouts the panel in UXP.
      // Then show the page the tile landed on: a drop before the first tile of
      // a page puts it at the end of the page before.
      if (didMove) { _applyPresetLayout(true); _presetGoToTile(dropped); }
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

  _renderPresetsRef = _renderPresets;
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
    _presetPage = 0;
    _renderPresets();
    _refreshUpdateNotification(); // [exchange-strip-line]
    _applyPresetLayout(true);
  };
  _renderPresets();
  _refreshUpdateNotification(); // [exchange-strip-line]

  _applyPresetLayout(true);
  // The column, not the list: the pager row toggling changes the list's box
  // but not the rows per page, which come from the column's height
  var _presetListEl = document.getElementById('all-presets-list');
  if (_presetListEl && _presetListEl.parentNode && typeof ResizeObserver !== 'undefined') {
    _presetRO = new ResizeObserver(_updateGridCols);
    _presetRO.observe(_presetListEl.parentNode);
  }

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
      _presetSearchClearAll(); // so the new tile is on show
      var preset = { id: 'c' + Date.now(), name: name, curve: curve };
      _presetList.push(preset);
      _savePresetList(_presetList);
      var btn = _buildPresetBtn(preset);
      var list = document.getElementById('all-presets-list');
      if (list) list.appendChild(btn);
      _applyPresetLayout(true);
      _presetGoToTile(btn); // the page it landed on
      if (makeActive) setPresetActive(preset.id); // an edited preset it came from is left as it was
    }, { title: title, ok: 'Save' });
  }
  function _customCount() { return _presetList.filter(function(p){ return !p.builtIn; }).length + 1; }
  _presetNamesRef = function() { return _presetList.map(function(p) { return p.name; }); };
  // Paste Preset: a parsed curve becomes a preset once it is named
  function _createPresetFromCurve(curve) {
    _promptNewPreset(curve, 'Pasted ' + _customCount(), 'Name Pasted Preset', false);
  }

  // Show paste-coordinates input panel
  // Add presets in bulk (file import): tiles go in before the New tile
  function _addPresetEntries(entries) {
    var list = document.getElementById('all-presets-list');
    if (!list || !entries.length) return;
    _presetSearchClearAll(); // so the new tiles are on show
    var first = null;
    entries.forEach(function(p) {
      _presetList.push(p);
      var btn = _buildPresetBtn(p);
      list.appendChild(btn);
      if (!first) first = btn;
    });
    _savePresetList(_presetList);
    _applyPresetLayout(true);
    if (first) _presetGoToTile(first); // the page the new tiles start on
  }
  function _presetSig(p) { return p.name + '|' + _curveToText(p.curve); }
  // Export / Import Presets: a JSON file { opencurve: 1, presets: [{ name, curve }] }.
  // Built-ins stay out of the file; imports skip entries already in the list.
  function _exportPresetsToFile() {
    var mine = _presetList.filter(function(p) { return !p.builtIn; });
    if (!mine.length) { _showCopyToast('No presets to export'); return; }
    var data = { opencurve: 1, version: CURRENT_VERSION, presets: mine.map(function(p) { var o = { name: p.name, curve: _cloneCurve(p.curve) }; if (p.tag) o.tag = p.tag; return o; }) };
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
        var itg = _cleanTag(p.tag);
        if (itg) entry.tag = itg;
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

    // Position vertically once box has height
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

  // Paste coordinates: always show panel, pre-fill clipboard if valid
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
        // The row icons carry _centerIcons' inline absolute position (UXP), which
        // stacked every copy in the menu's top-left corner: drop the style
        var rIc = function(el) { return el ? el.innerHTML.replace(/\sstyle="[^"]*"/g, '') : ''; };
        var rSel   = (rs.selectedParamKeys || []).indexOf(rowKey) >= 0;
        var rValid = (rs.validParamKeys    || []).indexOf(rowKey) >= 0;
        var rBaked = (rs.bakedParamKeys    || []).indexOf(rowKey) >= 0;
        var _icSel   = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M2.6 7.4L5.6 10.4L11.4 3.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        var _icUnsel = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M3.5 3.5L10.5 10.5M10.5 3.5L3.5 10.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
        if (rValid && !rBaked) _miniItem('Apply Curve Now', _icBolt, function() { _bakeRowKey(rowKey); });
        if (rSel) _miniItem('Deselect', _icUnsel, function() { _togglePropKey(rowKey); });
        else if (rValid) _miniItem('Select for Go', _icSel, function() { _togglePropKey(rowKey); });
        _miniItem('Jump to Keyframes', rIc(rels.pin), function() {
          var live = (getState().availableParams || []).filter(function(x) { return x.key === rowKey; })[0];
          _jumpToParam(live || rrow);
        });
        if (rBaked) {
          if ((_bakeRecFor(rs, rowKey) || {}).curve) _miniItem('Load Baked Curve', rIc(rels.curve), function() { _loadBakedCurve(rowKey); });
          if (_replaceReady(rs, rowKey)) _miniItem('Replace with Current Curve', rIc(rels.replace), function() { _replaceBakeForKey(rowKey); });
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
    _ctxMenuShadow(mini);
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

  // New Preset button (the list is looked up at click time: the UXP scroller
  // refresh replaces the element, so a reference kept here would go stale)
  (function() {
    if (!document.getElementById('all-presets-list')) return;

    // New Preset: the toolbar button at the left of the preset bar (#preset-new)
    // saves the current curve as a preset and opens its name for editing
    var newTool = document.getElementById('preset-new');
    if (newTool) {
      _attachTooltip(newTool, 'New Preset: save the current curve as a preset');
      newTool.addEventListener('click', function() {
        _promptNewPreset(getState().curve, _newPresetName(_customCount()), 'New Preset', true);
      });
    }
    // New... in the graph bar, beside the preset chip (the same job while the graph is shown)
    var peNew = document.getElementById('pe-new');
    if (peNew) {
      _attachTooltip(peNew, 'New Preset: save this curve as a new preset');
      peNew.addEventListener('click', function() {
        _promptNewPreset(getState().curve, _newPresetName(_customCount()), 'New Preset', true);
      });
    }
  }());

  // Resize handle — drag to adjust left/right column split
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
    // Applied once per frame, like the property column's handle: each width
    // write relayouts the panel in UXP (measured live 2026-11-22)
    var _sX = null, _sRaf = 0;
    function _applySideW() {
      _sRaf = 0;
      if (_sX === null) return;
      var newW = Math.max(120, Math.min(_sidebarMaxW(), _rw + (_rx - _sX)));
      _sX = null;
      if (rightCol.style.width !== newW + 'px') rightCol.style.width = newW + 'px';
    }
    resizeHandle.addEventListener('pointermove', function(e) {
      if (!_resizing) return;
      _sX = e.clientX;
      if (!_sRaf) _sRaf = requestAnimationFrame(_applySideW);
    });
    function _endResize() {
      if (_sRaf) { cancelAnimationFrame(_sRaf); _applySideW(); } // the last move lands before the save
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

  // Go button
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
    goBtn.addEventListener('click', async function() {
      var s = getState();
      if (_goSelectsAll(s)) { _selectAllValid(s); return; }
      if (_goJumps(s)) { _jumpToParam({ jumpSec: _nearestJumpParam(s).nearSec }); return; }
      if (s.status !== 'valid') return;
      await _bakeKeysNow(s.selectedParamKeys || [], null);
    });
  }

  // Undo button (next to Go): reverts the most recent Go press
  var undoBtn = document.getElementById('undo-btn');
  if (undoBtn) {
    _attachTooltip(undoBtn, function() { return undoBtn.classList.contains('btn-dim') ? 'Nothing to undo' : 'Undo last bake'; });
    undoBtn.addEventListener('click', function() { if (!undoBtn.classList.contains('btn-dim')) _undoLastBake(); });
    // Start in the right state with its inline colours: the stylesheet alone
    // left a fresh panel's dim button green in the CCX (its :hover rule won)
    _showUndoBtn(_hasSessionBakes());
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

// The bolt's three looks: 'ready' (blue: a press bakes), 'jump' (grey but live:
// the playhead isn't inside any of the property's pairs, so a press jumps to the
// nearest one, like Go), 'off' (dimmed and inert: no pair to apply the curve to)
function _rowNearSec(s, key) {
  var r = (s.availableParams || []).filter(function(p) { return p.key === key; })[0];
  return r && typeof r.nearSec === 'number' ? r.nearSec : null;
}
function _bakeMode(s, key, isValid) {
  return isValid ? 'ready' : (_rowNearSec(s, key) !== null ? 'jump' : 'off');
}
function _styleBakeBtn(el, mode) {
  if (el._ocMode === mode) return;
  el._ocMode = mode;
  el.classList.toggle('bake-jump', mode === 'jump');
  _styleReplaceBtn(el, mode !== 'off');
}
// Row bolt button: bake this one property now, as if it alone were selected
// and Go pressed. The selection is left as it was (minus this property, which
// is baked). Its own spinner shows while it runs, not Go's.
// Outside every pair of the property, it acts like Go does then: the first
// press jumps to the property's nearest pair, the next one bakes it.
var _rowBakeKey = null; // the row whose bolt started the bake that is running
async function _bakeRowKey(key) {
  var s = getState();
  var b = _rowBtn(key, 'bake');
  if (s.isBaking || (b && b._ocSpin)) return;
  if ((s.validParamKeys || []).indexOf(key) < 0 || !(s.paramContexts && s.paramContexts[key])) {
    var near = _rowNearSec(s, key);
    if (near !== null) _jumpToParam({ jumpSec: near });
    return;
  }
  _btnBusy(b, true);
  try { await _bakeKeysNow([key], key); } finally { _btnBusy(b, false); }
}
// Go's bake: the given properties that are ready under the playhead, re-read
// from Premiere first, then recorded for the undo buttons
async function _bakeKeysNow(keys, rowKey) {
  var s = getState();
  var bakedKeys = (keys || [])
    .filter(function(k){ return (s.validParamKeys || []).indexOf(k) >= 0 && s.paramContexts && s.paramContexts[k]; });
  var contexts = bakedKeys.map(function(k){ return s.paramContexts[k]; });
  if (s.isBaking || contexts.length === 0) return;
  _pvStop();
  _rowBakeKey = rowKey || null;
  setState({ isBaking: true, status: 'baking' });
  try {
    // The rows come from the last poll, which can be up to a second old (it
    // is cached while the playhead stands still), and its values and
    // property handles go stale as soon as a keyframe is edited in Effect
    // Controls. Re-read the clip now and bake what is really there.
    var fresh = await _freshBakeContexts(s, bakedKeys);
    bakedKeys = fresh.keys;
    contexts  = fresh.contexts;
    s = Object.assign({}, s, { clipId: fresh.result.clipId, availableParams: fresh.result.availableParams || [],
                               paramContexts: fresh.result.paramContexts || {}, validParamKeys: fresh.result.validParamKeys || [] });
    var written = (await bakeKeyframes(contexts, s.curve)) || [];
    _recordBakes(s, bakedKeys, contexts, written); // remembered for the undo buttons
    _showUndoBtn(_hasSessionBakes());
    _invalidateCache(); // keyframes changed — force full re-scan on next poll
    _skipPollUntil = Date.now() + DONE_DISPLAY_MS;
    var newBaked = (s.bakedParamKeys || []).concat(bakedKeys.filter(function(k){ return (s.bakedParamKeys || []).indexOf(k) < 0; }));
    // The baked pairs are one frame apart now, so those properties are no
    // longer bakeable; drop them from the valid set straight away rather
    // than waiting for the next poll (polling pauses while "Done" shows).
    var ctxLeft = {};
    Object.keys(s.paramContexts || {}).forEach(function(k){ if (bakedKeys.indexOf(k) < 0) ctxLeft[k] = s.paramContexts[k]; });
    setState({
      isBaking: false, status: 'done',
      bakedParamKeys:    newBaked,
      availableParams:   _tlSpansAfterBake(s, bakedKeys), // green bar on the timeline right away
      validParamKeys:    (s.validParamKeys || []).filter(function(k){ return bakedKeys.indexOf(k) < 0; }),
      paramContexts:     ctxLeft,
      selectedParamKeys: (s.selectedParamKeys || []).filter(function(k){ return bakedKeys.indexOf(k) < 0; }),
    });
    setTimeout(function() {
      _lastStatus = '';
      setState({ status: 'idle' });
    }, DONE_DISPLAY_MS);
  } catch(err) {
    console.error('[FS] bake error:', err);
    _skipPollUntil = Date.now() + ERROR_DISPLAY_MS;
    setState({ isBaking: false, status: 'error', hint: err && err.message ? err.message : String(err) });
  } finally {
    _rowBakeKey = null;
  }
}

// Go: scan the clip again and keep the selected properties that are still
// bakeable, with fresh values and handles (issue #14). Throws with a message
// for the strip when nothing selected is left to bake.
async function _freshBakeContexts(s, keys) {
  var project  = await ppro.Project.getActiveProject();
  var sequence = project ? await project.getActiveSequence() : null;
  if (!sequence) throw new Error('No active sequence');
  var ph = (await sequence.getPlayerPosition()).seconds;
  var selItems = null;
  try { selItems = await _getSelectionItems(sequence); } catch(_) {}
  var r = await _detectContextFull(project, sequence, ph, selItems);
  await _applyResultRetire(r);
  var keep = [], ctxs = [];
  if (r.status === 'valid' && r.clipId === s.clipId) {
    keys.forEach(function(k) {
      var c = r.paramContexts && r.paramContexts[k];
      var old = s.paramContexts && s.paramContexts[k];
      if (!c || (r.validParamKeys || []).indexOf(k) < 0) return;
      if (old && old.displayName !== c.displayName) return; // effects added or removed: not the same property
      keep.push(k); ctxs.push(c);
    });
  }
  if (!keep.length) {
    _invalidateCache();
    throw new Error('The playhead or keyframes changed. Check the properties and press Go again.');
  }
  return { keys: keep, contexts: ctxs, result: r };
}

// ─── Detection cache ─────────────────────────────────────────────────────
var _cache = {
  playhead:       null,   // last playhead seconds
  sequenceGuid:   null,   // guid of active sequence
  fps:            null,   // cached fps for current sequence
  fpsCheckedAt:   0,      // timestamp of last fps detection
  selClipId:      null,   // composite identity string: name|start|end
  selItemCount:   0,      // number of selected items (fast identity check)
  selTrackItemSig: null,  // 'noargs' | 'typed' — which getTrackItems call works on selection
  lastResult:     null,   // full detectContext result
  pollCount:      0,      // polls since last full detection
};

var FPS_RECHECK_MS     = 30000; // re-detect fps every 30s to catch mid-session changes
var HEARTBEAT_POLLS    = 10;    // force full re-scan every N polls even if playhead is static (~1s at 100ms)

function _invalidateCache() {
  _cache.playhead      = null;
  _cache.selClipId     = null;
  _cache.selItemCount  = 0;
  _cache.lastResult    = null;
  _cache.pollCount     = 0;
}

// ─── Polling ──────────────────────────────────────────────────────────────
var pollTimer      = null;
var POLL_MS        = 100;  // measured: full scan ~9ms avg / 23ms max, so 100ms leaves 4x headroom (was 200)
var _lastStatus    = '';
var _skipPollUntil = 0;
var _pollRunning   = false; // prevents concurrent poll calls piling up
var _pollStartedAt = 0;     // when the running scan began, for the stuck-scan guard
var _pollToken     = 0;     // identifies the scan that owns _pollRunning
var _POLL_STUCK_MS = 5000;  // a scan still running after this is abandoned
var _isDragging    = false; // pause polling while handle is being dragged

// ─── Debug: poll timing ──────────────────────────────────────────────────
// Toggle from the flyout menu (or set localStorage 'opencurve-debug-timing' to 'on').
// Logs every poll to the console with what it did and how long it took, and
// prints a summary when turned off. Costs one boolean check per poll when off.
var _DEBUG_TIMING_KEY = 'opencurve-debug-timing';
var _debugTiming = _DEV_MENU && localStorage.getItem(_DEBUG_TIMING_KEY) === 'on';
var _dbgKind   = '';   // what the last detect did: cache | full | playing | early | error
var _dbgFullMs = 0;    // time spent inside the full scan itself (UXP only)
var _dbgStats  = null;
function _dbgReset() {
  _dbgStats = { since: Date.now(), polls: 0, dropped: 0, kinds: {}, full: [], cache: [], slowest: 0, slowestKind: '',
                lastAt: 0, gaps: [], render: [], phChanges: 0, lastPh: null };
}
// kind/ms: what detectContext did and how long it took. t0: when this poll
// started (gives the wall-clock gap to the previous poll, i.e. whether the
// timer really fires every POLL_MS). renderMs: time spent in setState/renderUI.
// ph: the playhead seconds this poll saw; a trailing * marks a change.
function _dbgRecord(kind, ms, result, t0, renderMs, ph) {
  if (!_dbgStats) _dbgReset();
  var st = _dbgStats;
  st.polls++;
  st.kinds[kind] = (st.kinds[kind] || 0) + 1;
  if (kind === 'full') st.full.push(ms); else if (kind === 'cache') st.cache.push(ms);
  if (ms > st.slowest) { st.slowest = ms; st.slowestKind = kind; }
  var gap = (t0 && st.lastAt) ? t0 - st.lastAt : 0;
  if (t0) st.lastAt = t0;
  if (gap) st.gaps.push(gap);
  if (typeof renderMs === 'number') st.render.push(renderMs);
  var phMoved = (typeof ph === 'number' && st.lastPh !== null && ph !== st.lastPh);
  if (phMoved) st.phChanges++;
  if (typeof ph === 'number') st.lastPh = ph;
  var budget = POLL_MS;
  var over = ms > budget ? '  OVER BUDGET (' + budget + 'ms poll interval)' : '';
  var scan = (kind === 'full' && _dbgFullMs) ? '  scan=' + _dbgFullMs + 'ms' : '';
  console.log('[OC-TIMING] ' + (kind + '       ').slice(0, 7) + ' ' + ('    ' + ms).slice(-4) + 'ms' + scan +
    '  gap=' + ('   ' + gap).slice(-3) + 'ms' +
    '  render=' + ('  ' + (renderMs || 0)).slice(-2) + 'ms' +
    (typeof ph === 'number' ? '  ph=' + ph.toFixed(3) + (phMoved ? '*' : ' ') : '') +
    '  status=' + (result && result.status) +
    '  params=' + ((result && result.availableParams) ? result.availableParams.length : 0) +
    (result && result.hint ? '  hint="' + result.hint + '"' : '') + over);
}
function _dbgSummary() {
  var st = _dbgStats; if (!st) return 'No polls recorded';
  function avg(a){ return a.length ? Math.round(a.reduce(function(x,y){ return x+y; }, 0) / a.length) : 0; }
  function max(a){ return a.length ? Math.max.apply(null, a) : 0; }
  var secs = Math.round((Date.now() - st.since) / 1000);
  console.log('[OC-TIMING] summary over ' + secs + 's\n' +
    '  polls      : ' + st.polls + ' (' + st.dropped + ' dropped because the previous poll was still running)\n' +
    '  full scans : ' + st.full.length + '  avg ' + avg(st.full) + 'ms  max ' + max(st.full) + 'ms\n' +
    '  cache hits : ' + st.cache.length + '  avg ' + avg(st.cache) + 'ms  max ' + max(st.cache) + 'ms\n' +
    '  interval   : avg ' + avg(st.gaps) + 'ms between polls (timer set to ' + POLL_MS + 'ms)  max ' + max(st.gaps) + 'ms\n' +
    '  render     : avg ' + avg(st.render) + 'ms  max ' + max(st.render) + 'ms\n' +
    '  playhead   : moved on ' + st.phChanges + ' of ' + st.polls + ' polls\n' +
    '  by kind    : ' + JSON.stringify(st.kinds) + '\n' +
    '  slowest    : ' + st.slowest + 'ms (' + st.slowestKind + ')');
  return 'full avg ' + avg(st.full) + 'ms / max ' + max(st.full) + 'ms, cache avg ' + avg(st.cache) + 'ms, interval avg ' + avg(st.gaps) + 'ms, render avg ' + avg(st.render) + 'ms, ' + st.dropped + ' dropped';
}
function _toggleDebugTiming() {
  _debugTiming = !_debugTiming;
  localStorage.setItem(_DEBUG_TIMING_KEY, _debugTiming ? 'on' : 'off');
  if (_debugTiming) { _dbgReset(); _showCopyToast('Poll timing ON: watch the debug console'); }
  else { _showCopyToast('Poll timing OFF: ' + _dbgSummary()); }
}

async function poll() {
  if (_pollRunning) {
    // Every call in detectContext awaits a Premiere proxy. A promise that never
    // settles would leave this flag set and stop the panel updating for the rest
    // of the session with no sign of why, so a stuck scan is abandoned.
    if (_pollStartedAt && Date.now() - _pollStartedAt > _POLL_STUCK_MS) {
      console.log('[OC] poll: abandoning a scan stuck for ' + (Date.now() - _pollStartedAt) + 'ms');
      _pollRunning = false;
      _invalidateCache();
    } else {
      if (_debugTiming && _dbgStats) _dbgStats.dropped++;
      return; // previous tick still running
    }
  }
  if (_isDragging)  return; // keep event loop free while user is dragging
  var s = getState();
  if (s.isBaking) return;
  if (Date.now() < _skipPollUntil) return;
  _pollRunning = true;
  _pollStartedAt = Date.now();
  var _myPoll = ++_pollToken; // an abandoned scan must not clear the flag or apply its result
  try {
    var _t0 = _debugTiming ? Date.now() : 0;
    var result = await detectContext();
    var _tDet = _debugTiming ? Date.now() - _t0 : 0;
    if (_pollToken !== _myPoll) return; // this scan was abandoned; a newer one owns the state
    // A scan that was already running when Go was pressed describes the
    // keyframes as they were before the bake. Applying it would restore the
    // pre-bake selection and, worse, its 2+ frame bracket pair inside the new
    // record's range would look like an outside undo and drop the record
    // (the row then showed orange instead of green). Discard it.
    if (getState().isBaking || Date.now() < _skipPollUntil) return;
    // Records this scan found dead are only forgotten now that its result is kept
    if (result && result._retire) {
      await _applyResultRetire(result);
      if (_pollToken !== _myPoll || getState().isBaking || Date.now() < _skipPollUntil) return;
    }
    s = getState();
    var updates = {
      status:          result.status,
      clipId:          result.clipId || null,
      clipName:        result.clipName || '',
      availableParams: result.availableParams || [],
      hint:            result.hint || '',
      errorMessage:    result.errorMessage || result.hint || '',
      tl:              result.tl || null, // mini timeline: clip extent + playhead
    };

    if (result.status === 'valid') {
      var avail      = result.availableParams || [];
      var validKeys  = result.validParamKeys  || [];

      // Keep selected keys that are still in availableParams; drop stale ones
      var currentSel = (s.selectedParamKeys || []).filter(function(k) {
        return avail.some(function(p){ return p.key === k; });
      });

      // Auto-select all valid params only on fresh detection (when clip just came into range)
      var wasEmpty = (s.availableParams || []).length === 0;
      if (currentSel.length === 0 && validKeys.length > 0 && wasEmpty) {
        currentSel = validKeys.slice();
      }

      updates.selectedParamKeys = currentSel;
      updates.validParamKeys    = validKeys;
      updates.paramContexts     = result.paramContexts || {};
      // Bake records drive the green state; _bakedKeysFor drops any record
      // whose bake was undone outside the panel (Ctrl+Z)
      updates.bakedParamKeys    = _bakedKeysFor(result.clipId, avail);
      _tlAttachSpans(result.clipId, avail, result.tl);
      // A green (baked) row can't stay selected unless the playhead is over an unbaked pair of it
      updates.selectedParamKeys = updates.selectedParamKeys.filter(function(k){
        return updates.bakedParamKeys.indexOf(k) < 0 || validKeys.indexOf(k) >= 0;
      });

      // Downgrade status if no selected param is actually valid
      var activeCount = currentSel.filter(function(k){ return validKeys.indexOf(k) >= 0; }).length;
      if (activeCount === 0) updates.status = 'no-selection';
    } else if (result.status === 'outside') {
      // Same clip, playhead outside every keyframe pair: keep any selection the
      // user made (shown orange) so it turns blue once the playhead reaches it.
      var availOut = result.availableParams || [];
      updates.selectedParamKeys = (s.selectedParamKeys || []).filter(function(k) {
        return availOut.some(function(p){ return p.key === k; });
      });
      updates.validParamKeys    = [];
      updates.paramContexts     = {};
      updates.bakedParamKeys    = _bakedKeysFor(result.clipId, availOut);
      _tlAttachSpans(result.clipId, availOut, result.tl);
      updates.selectedParamKeys = updates.selectedParamKeys.filter(function(k){ return updates.bakedParamKeys.indexOf(k) < 0; });
    } else {
      updates.selectedParamKeys = [];
      updates.validParamKeys    = [];
      updates.paramContexts     = {};
      updates.bakedParamKeys    = [];
    }

    if (result.status !== _lastStatus) {
      console.log('[FS] status changed:', _lastStatus, '→', result.status, result.hint || '');
      _lastStatus = result.status;
    }
    // Nothing the UI shows has changed: keep the newest live handles (param
    // proxies, timeline data) without notifying the listeners. UXP repaints on
    // every style write, so an idle tick used to pay for a full renderUI, a
    // timeline pass and six forced layouts ten times a second for nothing.
    if (_pollSig(updates) === _pollSig(state)) {
      Object.assign(state, { availableParams: updates.availableParams, paramContexts: updates.paramContexts, tl: updates.tl });
      if (_debugTiming) _dbgRecord(_dbgKind, _tDet, result, _t0, 0, _cache.playhead);
      return;
    }
    var _tR = _debugTiming ? Date.now() : 0;
    setState(updates);
    if (_debugTiming) _dbgRecord(_dbgKind, _tDet, result, _t0, Date.now() - _tR, _cache.playhead);
  } catch(err) {
    console.error('[FS] poll error:', err);
  } finally {
    if (_pollToken === _myPoll) _pollRunning = false;
  }
}
window.__opencurvePoll = poll;

// Everything renderUI / the timeline / the strip cursor read from a poll's
// updates, as one string, so a tick that changes nothing visible can skip the
// render. Compared against the current state (not the last poll) so a change
// made through setState elsewhere is never left un-rendered.
function _pollSig(u) {
  var ps = (u.availableParams || []).map(function(p) {
    return p.key + ':' + p.displayName + ':' + (p.label || '')
      + ':' + (p.tlOut ? 'o' : Math.round(p.tlKf0 * 1000) + '/' + Math.round(p.tlKf1 * 1000))
      + ':' + (p.tlKf || []).map(function(t) { return Math.round(t * 1000); }).join(',')
      + ':' + (p.tlSpans || []).map(function(sp) { return Math.round(sp[0] * 1000) + '~' + Math.round(sp[1] * 1000); }).join(',')
      + ':' + (typeof p.nearSec === 'number' ? Math.round(p.nearSec * 1000) : '');
  }).join(';');
  var tl = u.tl ? [u.tl.ph, u.tl.clipStart, u.tl.clipEnd, u.tl.clipIn, u.tl.speed || 1, u.tl.fps].join('/') : '';
  return [u.status, u.clipId || '', u.clipName || '', u.hint || '', u.errorMessage || '', tl, ps,
          (u.selectedParamKeys || []).join(','), (u.validParamKeys || []).join(','), (u.bakedParamKeys || []).join(',')].join('|');
}

// ─── Settings / flyout ─────────────────────────────────────────────────────
var _CURVE_COLOR_KEY    = 'opencurve-line-color';
var _curveColor         = localStorage.getItem(_CURVE_COLOR_KEY) || '#ffffff';
// [exchange-strip]
var _updateAvailable    = false;
var _latestVersion      = null;
var _updateDismissed    = false;
var _lastUpdateCheckAt  = 0;       // throttles the silent check (see _checkForUpdates)
var _UPDATE_CHECK_MS    = 3600000; // an hour between silent checks
// [/exchange-strip]
var _UPDATE_NOTIF_KEY   = 'opencurve-update-notif'; // kept in the Exchange build: Reset still clears it
var _updateNotifsOn     = localStorage.getItem(_UPDATE_NOTIF_KEY) !== 'off'; // [exchange-strip-line]
var _ANIM_KEY           = 'opencurve-animations';
var _animationsOn       = localStorage.getItem(_ANIM_KEY) !== 'off';
// Settings > Double-Click Lanes: a double press on a timeline lane selects or
// deselects that property for Go (on by default)
var _TL_DBL_KEY         = 'opencurve-tl-dblclick';
var _tlDblOn            = localStorage.getItem(_TL_DBL_KEY) !== 'off';
// Settings > Keyboard Shortcuts: Enter for Go and every panel key (on by
// default). Off, the key sink is never focused either, so keys pressed after
// clicking the panel stay Premiere's (only Esc is still handled when it
// arrives)
var _SHORTCUTS_KEY      = 'opencurve-shortcuts';
var _shortcutsOn        = localStorage.getItem(_SHORTCUTS_KEY) !== 'off';
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
// trades a little accuracy for a lighter keyframe track (see bakeKeyframes).
var _bakeDensity        = parseInt(localStorage.getItem(_DENSITY_KEY), 10) || 1;
if ([1, 2, 4].indexOf(_bakeDensity) < 0) _bakeDensity = 1;

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

// ─── Preset search (2026-11-23) ───────────────────────────────
// The box in the preset bar (#preset-search) filters the tiles by name as it is
// typed: every word has to appear in the name, case ignored. A tile that misses
// carries _ocFiltered (_presetTiles leaves them out and _presetPageApply hides them); the
// update tile shows only with no search. While a search is on, the box takes
// the theme colour (its outline, the icon and an "n of N" count) and the clear
// cross shows (a right-click on the box clears it too); a search with no match
// puts a line over the empty list. Esc in
// the box clears it (a second Esc leaves the box), Enter clicks the first tile
// left. Adding a preset (New, Paste, Import) clears the search so the new tile
// is on show. Session only. _applyPresetLayout marks the tiles on every pass.
var _presetQuery = '';
var _psSig = '';
// A box narrower than this leaves the "n of N" count out, so the typed text
// keeps its room (_psCheckWidth, from the preset bar's ResizeObserver)
var _PS_COUNT_MIN = 190, _psNarrow = false;
function _psCheckWidth() { _presetSearchSync(); } // the width is measured there
function _psMeasure(box) {
  var w = box.offsetWidth;
  if (w > 0) _psNarrow = w < _PS_COUNT_MIN;
}
var _psLastRes = { shown: 0, total: 0 };
function _presetWords() {
  return _presetQuery.toLowerCase().split(/\s+/).filter(function(w) { return !!w; });
}
function _presetFilterMark() {
  var list = document.getElementById('all-presets-list');
  var res = { shown: 0, total: 0 };
  if (!list) return res;
  var words = _presetWords();
  var tagOn = _tagFilterOn();
  var tiles = list.querySelectorAll('.preset-btn');
  for (var i = 0; i < tiles.length; i++) {
    var b = tiles[i], f = false;
    if (b.id === '_update-notif') f = words.length > 0 || tagOn;
    else {
      var n = b.querySelector('.preset-name'), t = n ? String(n.textContent).toLowerCase() : '';
      for (var k = 0; k < words.length; k++) if (t.indexOf(words[k]) < 0) { f = true; break; }
      if (!f && tagOn && !_tagFilter[b._ocTag | 0]) f = true; // the funnel's colours: any of them
      res.total++;
      if (!f) res.shown++;
    }
    b._ocFiltered = f;
  }
  _presetSearchSync(res);
  return res;
}
function _presetSearchSync(res) {
  if (res) _psLastRes = res; else res = _psLastRes;
  var box = document.getElementById('preset-search');
  if (!box) return;
  var tags = _tagFilterList(), tagOn = tags.length > 0;
  var on = _presetWords().length > 0 || tagOn;
  var col = /^#[0-9a-fA-F]{6}$/.test(_curveColor) ? _curveColor : '#ffffff';
  _psMeasure(box); // also on every search change, not only on a bar resize
  var sig = (on ? 1 : 0) + '|' + col + '|' + res.shown + '|' + res.total + '|' + _presetQuery + '|' + tags.join(',') + '|' + (_psNarrow ? 1 : 0);
  if (sig === _psSig) return; // every write below is behind this
  _psSig = sig;
  box.style.backgroundColor = on ? _hexToRgba(col, 0.8) : '';
  var ic = box.querySelector('.ps-icon');
  if (ic) {
    var parts = ic.querySelectorAll('circle, line');
    for (var i = 0; i < parts.length; i++) parts[i].setAttribute('stroke', on ? col : '#8c8c8c');
  }
  var cnt = document.getElementById('preset-search-count');
  if (cnt) {
    cnt.style.display = (on && !_psNarrow) ? '' : 'none';
    if (on) { cnt.textContent = res.shown + ' of ' + res.total; cnt.style.color = col; }
  }
  var clr = document.getElementById('preset-search-clear');
  if (clr) clr.style.display = (_presetQuery || tagOn) ? 'flex' : 'none';
  // The colours being filtered on, as dots before the text, and a lit funnel
  var chips = document.getElementById('preset-search-tags');
  if (chips) {
    while (chips.firstChild) chips.removeChild(chips.firstChild);
    tags.forEach(function(tg, j) {
      var d = _tagDotSvg(_TAG_COLOURS[tg - 1].hex, 8);
      d.style.cssText = 'flex-shrink:0;' + (j ? 'margin-left:3px;' : '');
      chips.appendChild(d);
    });
    chips.style.display = tagOn ? 'flex' : 'none';
  }
  var fb = document.getElementById('preset-search-filter');
  if (fb) {
    fb.style.backgroundColor = tagOn ? _hexToRgba(col, 0.2) : '';
    var fp = fb.querySelector('path');
    if (fp) fp.setAttribute('stroke', tagOn ? col : 'currentColor');
  }
  var empty = document.getElementById('preset-search-empty');
  if (empty) {
    var none = on && res.shown === 0;
    empty.style.display = none ? '' : 'none';
    if (none) {
      var q = _presetQuery.trim();
      if (q.length > 30) q = q.slice(0, 29) + '\u2026';
      var names = tags.map(function(tg) { return _TAG_COLOURS[tg - 1].name; }).join(' or ');
      empty.textContent = !tagOn ? 'No presets match \u201c' + q + '\u201d'
        : (q ? 'No ' + names + ' presets match \u201c' + q + '\u201d' : 'No presets tagged ' + names);
    }
  }
}
function _psRelayout() {
  _presetPage = 0;          // a new search starts on its first page
  _applyPresetLayout(true); // marks the tiles; _presetPageApply pages what is left
}
function _presetSearchSet(q) {
  q = String(q || '');
  var inp = document.getElementById('preset-search-input');
  if (inp && inp.value !== q) inp.value = q;
  if (q === _presetQuery) return;
  _presetQuery = q;
  _psRelayout();
}
function _presetSearchInit() {
  var box = document.getElementById('preset-search');
  var inp = document.getElementById('preset-search-input');
  var clr = document.getElementById('preset-search-clear');
  var fb  = document.getElementById('preset-search-filter');
  if (!box || !inp || box._ocWired) return;
  box._ocWired = true;
  function fromInput() { _presetSearchSet(inp.value); }
  inp.addEventListener('input', fromInput);
  inp.addEventListener('keyup', fromInput); // a host that sends no input event
  inp.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' || e.keyCode === 27) {
      e.preventDefault();
      if (_hideTagFilterMenu()) return;
      if (_presetQuery || _tagFilterOn()) _presetSearchClearAll(); else { try { inp.blur(); } catch(_) {} }
    } else if (e.key === 'Enter' || e.keyCode === 13) {
      e.preventDefault();
      _pressPreset(0); // the first tile left
    }
  });
  // A press anywhere on the box types into it (the key sink's own deferred
  // grab is queued first, so this one wins)
  box.addEventListener('pointerdown', function(e) {
    if (e.target === inp || (clr && clr.contains(e.target)) || (fb && fb.contains(e.target))) return;
    setTimeout(function() { try { inp.focus(); } catch(_) {} }, 0);
  });
  // Right-click anywhere on the box clears it, like the cross (no Cut / Copy /
  // Paste menu on this field): the words and the colour filter together
  box.addEventListener('contextmenu', function(e) {
    e.preventDefault();
    e.stopPropagation();
    _presetSearchClearAll();
  });
  if (clr) {
    clr.addEventListener('click', function(e) { e.stopPropagation(); _presetSearchClearAll(); });
    _attachTooltip(clr, 'Clear search (Esc)');
  }
  if (fb) {
    fb.addEventListener('click', function(e) {
      e.stopPropagation();
      if (!_hideTagFilterMenu()) _showTagFilterMenu(false);
    });
    _attachTooltip(fb, function() {
      if (document.getElementById('_tag-filter-menu')) return '';
      var on = _tagFilterList();
      if (!on.length) return 'Filter by colour tag';
      return 'Showing ' + on.map(function(t) { return _TAG_COLOURS[t - 1].name; }).join(' or ') + ' (right-click to clear)';
    });
  }
  _presetFilterMark();
}

// ─── Colour tags (2026-11-23, like Looker) ─────────────────────
// A preset can carry one colour tag (preset.tag, 1-7 into _TAG_COLOURS; saved
// with the list and in exported files), set from the tile's right-click menu:
// a row of seven swatches, the preset's own colour ringed, a click on it again
// takes the tag off. Tagged tiles show an 8px dot (_tagSyncTile: at the right
// end of a list row, the top-left corner of a grid tile; the edited dot keeps
// the top-right). The funnel in the search box (#preset-search-filter) opens a
// menu of the colours with their counts; picks toggle (_tagFilter, several
// colours = any of them) and the menu stays open. Colours and the typed words
// combine (both have to match). While colours filter, their dots show before
// the text and the funnel takes the theme colour. The cross, Esc and a
// right-click on the box clear the words and the colours together.
var _TAG_COLOURS = [
  { name: 'Red',    hex: '#e5484d' },
  { name: 'Orange', hex: '#f08a24' },
  { name: 'Yellow', hex: '#f2c94c' },
  { name: 'Green',  hex: '#46a758' },
  { name: 'Blue',   hex: '#3e8eed' },
  { name: 'Purple', hex: '#9b59d0' },
  { name: 'Grey',   hex: '#8b8b8b' }
];
var _tagFilter = {}; // tag (1-7) -> true while the funnel filters on it
function _cleanTag(t) {
  t = +t;
  return (t >= 1 && t <= _TAG_COLOURS.length && Math.floor(t) === t) ? t : 0;
}
function _tagFilterOn() { for (var k in _tagFilter) if (_tagFilter[k]) return true; return false; }
function _tagFilterList() {
  var out = [];
  for (var i = 1; i <= _TAG_COLOURS.length; i++) if (_tagFilter[i]) out.push(i);
  return out;
}
function _tagDotSvg(hex, size) {
  var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', String(size)); svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 8 8');
  var c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  c.setAttribute('cx', '4'); c.setAttribute('cy', '4'); c.setAttribute('r', '4');
  c.setAttribute('fill', hex);
  svg.appendChild(c);
  return svg;
}
// The tile's tag dot, built, recoloured, placed or removed; change-only
function _tagSyncTile(btn) {
  var col = _TAG_COLOURS[(btn._ocTag | 0) - 1];
  var dot = btn._ocTagDot;
  if (!col) {
    if (dot && dot.parentNode) dot.parentNode.removeChild(dot);
    btn._ocTagDot = null;
    return;
  }
  if (!dot) {
    dot = _tagDotSvg(col.hex, 8);
    dot.setAttribute('class', 'preset-tag-dot');
    btn._ocTagDot = dot;
  }
  if (dot.parentNode !== btn) btn.appendChild(dot); // after the name: a list row's flex end
  var c = dot.firstChild;
  if (c.getAttribute('fill') !== col.hex) c.setAttribute('fill', col.hex);
  var css = _presetLayout === 'grid'
    ? 'position:absolute;top:7px;left:7px;pointer-events:none;'
    : 'flex-shrink:0;margin-left:8px;margin-right:2px;pointer-events:none;';
  if (dot._ocCss !== css) { dot.style.cssText = css; dot._ocCss = css; }
}
function _presetSearchClearAll() {
  _tagFilter = {};
  _hideTagFilterMenu();
  var inp = document.getElementById('preset-search-input');
  if (inp && inp.value) inp.value = '';
  _presetQuery = '';
  _psRelayout();
}
var _tagMenuDismiss = null, _tagMenuPos = null;
function _hideTagFilterMenu() {
  var m = document.getElementById('_tag-filter-menu');
  if (_tagMenuDismiss) { window.removeEventListener('pointerdown', _tagMenuDismiss, true); _tagMenuDismiss = null; }
  if (m && m.parentNode) { m.parentNode.removeChild(m); return true; }
  return false;
}
function _showTagFilterMenu(keepPos) {
  var fb = document.getElementById('preset-search-filter');
  if (!fb) return;
  var old = document.getElementById('_tag-filter-menu');
  if (old && old.parentNode) old.parentNode.removeChild(old);
  // How many presets wear each colour
  var counts = {};
  var tiles = document.querySelectorAll('#all-presets-list .preset-btn');
  for (var t = 0; t < tiles.length; t++) {
    var tg = tiles[t]._ocTag | 0;
    if (tg) counts[tg] = (counts[tg] || 0) + 1;
  }
  var menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.id = '_tag-filter-menu';
  menu.style.display = 'block';
  menu.style.minWidth = '180px';
  _TAG_COLOURS.forEach(function(col, i) {
    var tag = i + 1, on = !!_tagFilter[tag], n = counts[tag] || 0;
    var it = document.createElement('div');
    it.className = 'ctx-menu-item';
    it.style.display = 'flex';
    it.style.alignItems = 'center';
    if (!n && !on) it.style.color = '#7a7a7a';
    var tick = document.createElement('span');
    tick.style.cssText = 'display:flex;align-items:center;justify-content:center;flex-shrink:0;width:14px;margin-right:8px;';
    if (on) tick.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2.5 7.5l3 3 6-6.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    it.appendChild(tick);
    var dot = _tagDotSvg(col.hex, 10);
    dot.style.cssText = 'flex-shrink:0;margin-right:10px;';
    it.appendChild(dot);
    var lb = document.createElement('span');
    lb.textContent = col.name;
    it.appendChild(lb);
    var cn = document.createElement('span');
    cn.textContent = String(n);
    cn.style.cssText = 'margin-left:auto;padding-left:16px;font-size:12px;color:#8c8c8c;';
    it.appendChild(cn);
    it.addEventListener('click', function(ev) {
      ev.stopPropagation();
      if (_tagFilter[tag]) delete _tagFilter[tag]; else _tagFilter[tag] = true;
      _psRelayout();
      _showTagFilterMenu(true); // stays open, ticks updated
    });
    menu.appendChild(it);
  });
  if (_tagFilterOn()) {
    var sep = document.createElement('div');
    sep.style.cssText = 'border-top:1px solid rgba(255,255,255,0.07);margin:3px 0;';
    menu.appendChild(sep);
    var cl = document.createElement('div');
    cl.className = 'ctx-menu-item';
    cl.textContent = 'Clear colour filter';
    cl.addEventListener('click', function(ev) {
      ev.stopPropagation();
      _tagFilter = {};
      _psRelayout();
      _hideTagFilterMenu();
    });
    menu.appendChild(cl);
  }
  menu.style.left = '0px';
  menu.style.top = '0px';
  document.body.appendChild(menu);
  if (typeof _ctxMenuShadow === 'function') _ctxMenuShadow(menu);
  void menu.offsetHeight;
  if (!(keepPos && _tagMenuPos)) {
    // Below the funnel, its right edge on the funnel's; above when there is no room
    var r = fb.getBoundingClientRect();
    var mw = menu.offsetWidth || 180, mh = menu.offsetHeight || 220;
    var ww = document.documentElement.clientWidth || document.body.clientWidth;
    var wh = document.documentElement.clientHeight || document.body.clientHeight;
    var x = Math.max(0, Math.min(r.right + 3 - mw, ww - mw));
    var y = (r.bottom + 5 + mh > wh) ? Math.max(0, r.top - 5 - mh) : r.bottom + 5;
    _tagMenuPos = { x: x, y: y };
  }
  menu.style.left = _tagMenuPos.x + 'px';
  menu.style.top = _tagMenuPos.y + 'px';
  if (_tagMenuDismiss) window.removeEventListener('pointerdown', _tagMenuDismiss, true);
  _tagMenuDismiss = function(ev) {
    var m = document.getElementById('_tag-filter-menu');
    if ((m && m.contains(ev.target)) || fb.contains(ev.target)) return;
    _hideTagFilterMenu();
  };
  var d = _tagMenuDismiss;
  setTimeout(function() { if (_tagMenuDismiss === d) window.addEventListener('pointerdown', d, true); }, 0);
}

function _applyPresetLayout(force) {
  var list = document.getElementById('all-presets-list');
  if (!list) return;
  _presetFilterMark(); // the search: which tiles are on show at all
  var isGrid = _presetLayout === 'grid';
  var w = list.offsetWidth || 180;
  // Grid: 3 columns from 220px, else 2. List: two columns side by side once
  // the column is wide enough for two readable rows (_LIST_2COL_W).
  var cols = isGrid ? (w >= 220 ? 3 : 2) : (w >= _LIST_2COL_W ? 2 : 1);
  _presetCols = cols;
  var multi = cols > 1;
  var btnCount = list.querySelectorAll('.preset-btn').length;
  var thumbSz = isGrid ? (cols >= 3 ? 40 : 42) : 28;
  // Rows per page from the column's height (the pager row always reserved)
  // and the tile height the styles below give; see the paging block after
  // _updateGridCols. The list is a page, not a scroller.
  var panel = list.parentNode, panelH = panel ? panel.clientHeight : 0;
  var tileH = isGrid ? thumbSz + 34 : _TILE_H_LIST;
  // Separate tiles (2026-11-23): _TILE_GAP of the list's ground round every
  // tile. The list is padded by the gap at its left (none at the top: the
  // toolbar's own 5px bottom padding is the gap there) and each tile has
  // the gap as its right and bottom margin (only bottom margins, so a block
  // list collapses nothing; UXP has no flex gap), with widths in whole pixels
  // because UXP has no calc(); so a row takes tileH + gap
  var G = _TILE_GAP;
  var rows = Math.max(1, Math.floor((panelH - _PAGER_H) / (tileH + G)));
  var listW = list.clientWidth || w;
  var tileW = Math.max(20, Math.floor((listW - G) / cols) - G);
  _presetPerPage = rows * cols;
  _presetRows = rows; _presetPanelH = panelH; _presetTileH = tileH; // for the row stretch in _presetPageApply
  _presetGridThumb = isGrid ? thumbSz : 0;
  var cacheKey = (isGrid ? 'g' : 'l') + cols + '_' + btnCount + '_' + _presetPerPage + '_' + tileW;
  if (!force && _applyPresetLayout._lastKey === cacheKey) { _presetPageApply(); return; }
  _applyPresetLayout._lastKey = cacheKey;
  // Only past the cache check: UXP fires the list's ResizeObserver on every
  // scroll, and any style write here (even to the same value) makes it
  // relayout the panel, which left the list unresponsive after scrolling
  // (the v1.2.0 "smoother scrolling" bug, back when the toolbar button arrived)
  _styleLayoutBtn();
  var itemW = tileW + 'px', gapPx = G + 'px';

  // List container
  list.style.padding = '0 0 0 ' + gapPx;
  if (multi) {
    list.style.display = 'flex';
    list.style.flexWrap = 'wrap';
    list.style.alignContent = 'flex-start';
    list.style.gap = '0';
  } else {
    list.style.display = '';
    list.style.flexWrap = '';
    list.style.alignContent = '';
    list.style.gap = '';
  }

  // Each preset button
  list.querySelectorAll('.preset-btn').forEach(function(btn) {
    btn.style.flexShrink = '0';
    if (isGrid) {
      btn.style.width = itemW;
      btn.style.flexDirection = 'column';
      btn.style.padding = '4px 4px';
      btn.style.justifyContent = 'center'; // rows are stretched to fill the page, content stays centred
      btn.style.border = 'none';
      btn.style.borderBottom = 'none';
      btn.style.marginRight = gapPx;
      btn.style.marginBottom = gapPx;
      btn.style.textAlign = 'center';
      btn.style.gap = '0';
      btn.style.alignItems = 'center';
      btn.style.alignSelf = 'flex-start';
      btn.style.overflow = 'visible';
      btn.style.whiteSpace = 'normal';
      btn.style.minHeight = (thumbSz + 34) + 'px'; // padding + thumbnail + 4px gap + a line of name (the rows-per-page tile height)
    } else if (multi) {
      // Two-column list: ordinary rows, half width each, so the whole
      // button set (width, wrap) is inline like the grid (UXP relayout rule).
      btn.style.width = itemW;
      btn.style.flexDirection = '';
      btn.style.padding = '';
      btn.style.border = '';
      btn.style.borderBottom = '';
      btn.style.marginRight = gapPx;
      btn.style.marginBottom = gapPx;
      btn.style.textAlign = '';
      btn.style.gap = '';
      btn.style.alignItems = '';
      btn.style.alignSelf = 'flex-start';
      btn.style.overflow = '';
      btn.style.whiteSpace = '';
      btn.style.minHeight = '';
      btn.style.justifyContent = '';
    } else {
      btn.style.width = itemW;
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
      btn.style.justifyContent = '';
      btn.style.marginRight = gapPx;
      btn.style.marginBottom = gapPx;
    }
  });

  // Preset name text wrapping
  list.querySelectorAll('.preset-btn').forEach(_tagSyncTile); // tag dots: list end or grid corner
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

  // Thumbnails
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

  // [exchange-strip]
  // Update notif — compact in grid mode
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
  // [/exchange-strip]

  // UXP may ignore inline styles on first render — force reflow,
  // then re-assert align-self on each tile after a delay (no full re-call)
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
  _presetPageApply(); // tiles added, removed or the rows per page changed
}
var _gridColsTimer = null;
var _LIST_2COL_W = 340; // list view splits into two columns from this width
var _presetCols = 1;    // columns the last _applyPresetLayout laid out
var _gridColsSize = '';
function _updateGridCols(entries) {
  // UXP fires this on scroll as well as on a real resize; a scroll never
  // changes the list's box, so ignore callbacks where the size is the same
  if (entries && entries[0] && entries[0].contentRect) {
    var r = entries[0].contentRect, sz = Math.round(r.width) + 'x' + Math.round(r.height);
    if (sz === _gridColsSize) return;
    _gridColsSize = sz;
  }
  if (_gridColsTimer) clearTimeout(_gridColsTimer);
  _gridColsTimer = setTimeout(function() { _applyPresetLayout(); }, 60); // a height change alters the rows per page
}

// Pages instead of scrolling (September 2026). The list never scrolls: it
// shows as many whole rows as fit its height, and the pager row under it
// (#preset-pager) flips through the rest. _applyPresetLayout works the rows
// per page out from the column's height less the pager row (always reserved,
// so showing the pager can't change the count) and the tile height its styles
// give (45px list rows, thumbSz + 34 grid tiles; both border-box, so no
// measuring), keeps it in _presetPerPage and calls _presetPageApply, which sets
// the tiles' inline display and the pager's label and arrows, all change-only.
// The page is session state, clamped on every apply. A tile being dragged is
// left alone (the drag hides it behind its ghost and the layout pass after the
// drop pages it). The pager arrows, PageUp/PageDown and the wheel (CEP; UXP
// delivers no wheel events, and with no scroll view there is no post-scroll
// input hold on the list, which is the point) flip pages; hovering an arrow
// during a drag flips after _PAGE_FLIP_MS and keeps flipping while it stays.
var _PAGER_H      = 26;   // the pager row's CSS height
var _TILE_H_LIST  = 44;   // list row: 28px thumb + 16px padding
var _TILE_GAP     = 6;    // the list's ground between tiles and round the page's edges
var _PAGE_FLIP_MS = 600;  // hover on a pager arrow while dragging a tile
var _presetPage    = 0;
var _presetPerPage = 1;
var _presetPages   = 1;
var _presetRows = 1, _presetPanelH = 0, _presetTileH = 45; // from the last layout pass
var _presetGridThumb = 0;  // thumbnail size while in grid view, else 0
var _GRID_NAME_H = 17;     // one line of the 14px name
function _presetTiles() {
  // The tiles a search leaves on show (all of them with no search)
  var list = document.getElementById('all-presets-list');
  if (!list) return [];
  return Array.prototype.filter.call(list.querySelectorAll('.preset-btn'), function(t) { return !t._ocFiltered; });
}
function _presetPageApply() {
  var tiles = _presetTiles(), per = Math.max(1, _presetPerPage);
  var pages = Math.max(1, Math.ceil(tiles.length / per));
  if (_presetPage > pages - 1) _presetPage = pages - 1;
  if (_presetPage < 0) _presetPage = 0;
  _presetPages = pages;
  var from = _presetPage * per, to = from + per;
  var gone = document.querySelectorAll('#all-presets-list .preset-btn');
  for (var g = 0; g < gone.length; g++) {
    if (gone[g]._ocFiltered && gone[g].style.display !== 'none' && !gone[g].classList.contains('preset-dragging')) gone[g].style.display = 'none';
  }
  for (var i = 0; i < tiles.length; i++) {
    var t = tiles[i];
    if (t.classList.contains('preset-dragging')) continue;
    var d = (i >= from && i < to) ? '' : 'none';
    if (t.style.display !== d) t.style.display = d;
  }
  // Rows stretch to fill the page: the list's height (the column less the pager
  // while it shows) over the rows that fit it, so no empty band is left under
  // the last row. The same height on every page, so a short last page keeps
  // its tiles the size of the others. Unknown height (first render): none set.
  // Each row is a tile plus _TILE_GAP under it (the list has no top padding).
  var G = _TILE_GAP;
  var listH = pages > 1 ? _presetPanelH - _PAGER_H : _presetPanelH;
  var rowsFit = pages > 1 ? _presetRows : Math.max(1, Math.floor(_presetPanelH / (_presetTileH + G)));
  var rowPx = listH > 0 ? Math.max(_presetTileH, listH / rowsFit - G) : 0;
  var rowH = rowPx ? rowPx.toFixed(2) + 'px' : '';
  // Grid: centre the thumbnail + name in the stretched row through the top
  // padding (UXP's flex justify-content left them at the top)
  var pad = '';
  if (_presetGridThumb) {
    var content = _presetGridThumb + 4 + _GRID_NAME_H;
    pad = Math.max(4, rowPx ? (rowPx - content) / 2 : 4).toFixed(2) + 'px 4px 4px';
  }
  for (var j = 0; j < tiles.length; j++) {
    if (tiles[j].style.height !== rowH) tiles[j].style.height = rowH;
    if (pad && tiles[j].style.padding !== pad) tiles[j].style.padding = pad;
  }
  var pager = document.getElementById('preset-pager');
  if (!pager) return;
  var pd = pages > 1 ? 'flex' : 'none';
  if (pager.style.display !== pd) pager.style.display = pd;
  var lab = document.getElementById('preset-pager-label');
  var txt = (_presetPage + 1) + ' / ' + pages;
  if (lab && lab.textContent !== txt) lab.textContent = txt;
  // The pages loop (2.1.0), so both arrows always work
  _presetPagerArrow('preset-pager-prev', true);
  _presetPagerArrow('preset-pager-next', true);
}
function _presetPagerArrow(id, on) {
  var b = document.getElementById(id);
  if (!b) return;
  var op = on ? '' : '0.3', cur = on ? '' : 'default';
  if (b.style.opacity !== op) b.style.opacity = op;
  if (b.style.cursor  !== cur) b.style.cursor  = cur;
}
function _presetPageStep(d) {
  // Wraps round: past the last page is the first, before the first the last
  var n = Math.max(1, _presetPages);
  var p = ((_presetPage + d) % n + n) % n;
  if (p === _presetPage) return false;
  _presetPage = p;
  _presetPageApply();
  return true;
}
// Show the page a tile is on (a new preset about to be renamed)
function _presetGoToTile(btn) {
  var i = _presetTiles().indexOf(btn);
  if (i < 0) return;
  _presetPage = Math.floor(i / Math.max(1, _presetPerPage));
  _presetPageApply();
}
var _presetWheelAt = 0;
function _presetWheel(e) {
  e.preventDefault();
  var now = Date.now();
  if (now - _presetWheelAt < 150) return; // a trackpad sends many small deltas per flick
  _presetWheelAt = now;
  if (e.deltaY > 0) _presetPageStep(1); else if (e.deltaY < 0) _presetPageStep(-1);
}
function _presetPagerInit() {
  var prev = document.getElementById('preset-pager-prev'), next = document.getElementById('preset-pager-next');
  if (prev) { prev.addEventListener('click', function() { _presetPageStep(-1); }); _attachTooltip(prev, 'Previous page (Page Up)'); }
  if (next) { next.addEventListener('click', function() { _presetPageStep(1); });  _attachTooltip(next, 'Next page (Page Down)'); }
  var list = document.getElementById('all-presets-list');
  if (list) list.addEventListener('wheel', _presetWheel, { passive: false });
}

function _hexToRgba(hex, alpha) {
  var r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return 'rgba('+r+','+g+','+b+','+alpha+')';
}

function _applyCurveColor(color) {
  _curveColor = color;
  _presetSearchSync(); // an active search box wears the theme colour
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
  // Update active preset button theme colours
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

// Context menu drop shadow (2.1.0, UXP only). UXP draws no CSS box-shadow, so
// the shadow is faked the way gradients are elsewhere: nested frames around
// the menu, each a transparent box with a dark border, fading outward and
// deeper below. Every frame sits wholly outside the menu (its inner edge is
// the previous frame's outer edge), so nothing over the menu itself darkens.
// Safe to call again on the same menu. The CEP edition uses box-shadow.
var _CTX_SHADOW = [0.42, 0.3, 0.21, 0.14, 0.09, 0.055, 0.03, 0.015]; // alpha per frame, inner to outer (matched by eye to the CEP box-shadow)
function _ctxMenuShadow(menu) {
  if (!menu || menu._ocShadow) return;
  menu._ocShadow = true;
  var side = 2, top = 1, bottom = 3; // px per frame on each side: 16px spread at the sides, 8 above, 24 below
  for (var i = 0; i < _CTX_SHADOW.length; i++) {
    var k = i + 1, f = document.createElement('div');
    f.className = 'ctx-shadow';
    f.style.cssText = 'position:absolute;pointer-events:none;box-sizing:border-box;background:transparent;'
      + 'left:' + (-side * k) + 'px;right:' + (-side * k) + 'px;top:' + (-top * k) + 'px;bottom:' + (-bottom * k) + 'px;'
      + 'border-style:solid;border-color:rgba(0,0,0,' + _CTX_SHADOW[i] + ');'
      + 'border-width:' + top + 'px ' + side + 'px ' + bottom + 'px ' + side + 'px;';
    menu.appendChild(f);
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

// Opens a link in the browser, falling back to copying it. The Exchange build
// has no launchProcess permission, so scripts/build.js exchange strips the browser
// half and it always copies.
function _openUrl(url) {
  function copy() {
    navigator.clipboard.writeText(url).then(function() {
      _showCopyToast('Link copied — paste in browser', '#4a9eff');
    }, function(e) {
      console.error('[OC] clipboard write failed:', e);
      _showCopyToast('Could not open ' + url, '#ff9090');
    });
  }
  // [exchange-strip]
  try {
    require('uxp').shell.openExternal(url).catch(function(e) {
      console.error('[OC] openExternal failed:', e);
      copy();
    });
  } catch(e) { console.error('[OC] openExternal failed:', e); copy(); }
  return;
  // [/exchange-strip]
  copy();
}

// [exchange-strip]
function _refreshUpdateNotification() {
  var list = document.getElementById('all-presets-list');
  if (!list) return;
  var existing = document.getElementById('_update-notif');
  if (existing) existing.parentNode.removeChild(existing);
  if (!_updateAvailable || _updateDismissed || !_updateNotifsOn) { if (existing) _applyPresetLayout(true); return; }

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
  delBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><line x1="1" y1="1" x2="9" y2="9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><line x1="9" y1="1" x2="1" y2="9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
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
  require('uxp').shell.openExternal(url).then(function() {
    _showCopyToast('Opened link in browser', '#e6b800');
  }).catch(function(e) {
    console.error('[OC] openExternal failed:', e);
    navigator.clipboard.writeText(url).then(function() {
      _showCopyToast('Link copied — paste in browser', '#e6b800');
    }, function(e2) {
      // Both the browser launch and the clipboard refused: say so rather than
      // leave an unhandled rejection and a click that appears to do nothing
      console.error('[OC] clipboard write failed:', e2);
      _showCopyToast('Could not open ' + url, '#ff9090');
    });
  });
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
  if (!silent) _showCopyToast('Checking for updates…');
  fetch('https://api.github.com/repos/fayewave/OpenCurve/releases/latest')
    .then(function(r) {
      if (!r.ok) throw new Error('GitHub API returned ' + r.status);
      return r.json();
    })
    .then(function(data) {
      // Validate the response is from the expected repository
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
        if (!silent) _showCopyToast('Update available: v' + latest + ' — you have v' + CURRENT_VERSION);
      }
      var btn = document.getElementById('_updates-row');
      var lbl = document.getElementById('_updates-label');
      if (btn && lbl) _applyUpdateBtnState(btn, lbl);
      _refreshUpdateNotification();
    })
    .catch(function() { if (!silent) _showCopyToast('Could not reach GitHub'); });
}

// [/exchange-strip]

// ─── Popup buttons (2.1.0) ────────────────────────────────────────────────
// Every popup's buttons (Save, Cancel, Delete, Apply, Let's go, ...) share the
// Settings buttons' look (_cardBtn in _showSettingsModal): a 30px outlined box,
// 6px corners, 13px text, with rest / hover / pressed looks. The outline is an
// outer box filled with its colour round a 1px inset inner box (UXP draws a
// CSS border soft, see _crispBox). kind: 'primary' is Settings' blue GitHub
// look, 'danger' a red twin of it, anything else the grey look.
var _MODAL_LIFT = 1; // UXP sets text about 1px low in its line box (Settings' _uxpLift)
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
  'Smoother performance',
  'Save edits to presets',
  'Replace a baked curve',
  'Instant bake per property',
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
      + 'display:flex;flex-direction:row;align-items:center;min-height:34px;padding:6px 12px 6px 13px;';
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
    row.style.cssText = 'display:flex;align-items:stretch;' + (i < half - 1 ? 'margin-bottom:6px;' : '');
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
    ['opencurve-presets-v10', 'opencurve-sidebar-width', _WELCOME_KEY, _CURVE_COLOR_KEY, _GRID_KEY,
     _LAYOUT_KEY, _ANIM_KEY, _TL_DBL_KEY, _SHORTCUTS_KEY, _AUTO_ZOOM_KEY, _UPDATE_NOTIF_KEY, _GRAPH_KEY, _PEAK_KEY, _BN_KEY, _DRAG_GHOST_KEY,
     _DENSITY_KEY, _TL_KEY, _TL_ZOOM_KEY, _TL_PROPS_KEY, _TL_H_KEY
    ].forEach(function(k) { try { localStorage.removeItem(k); } catch(_) {} });

    // Everything below used to be left to location.reload(). If that call is a
    // no-op the panel kept the deleted presets and the old layout while the
    // flags said otherwise, and the next preset edit wrote the stale list
    // straight back to storage, undoing the reset. The panel now resets itself
    // and does not reload.
    _bakeDensity    = 1;
    _gridSize       = 8;
    _presetLayout   = 'list';
    _animationsOn   = true;
    _tlDblOn        = true;
    _shortcutsOn    = true;
    _autoZoomOn     = true;
    _autoZoomFrom   = null;
    _updateNotifsOn = true; // [exchange-strip-line]
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
    _showWelcome(); // the key was cleared above; CEP gets this from its reload, UXP does not reload
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
// UXP: the plugin's own file pickers; the manifest asks for localFileSystem "request".
function _saveTextFile(name, text) {
  var lfs = require('uxp').storage.localFileSystem;
  return lfs.getFileForSaving(name, { types: ['json'] }).then(function(file) {
    if (!file) return false; // cancelled
    return file.write(text).then(function() { return true; });
  });
}
function _openTextFile() {
  var lfs = require('uxp').storage.localFileSystem;
  return lfs.getFileForOpening({ types: ['json'] }).then(function(file) {
    if (!file) return null; // cancelled
    return file.read();
  });
}

// Settings footer: the version and the edition (ZXP, CCX or Exchange) as small
// outlined badges. Inline styles only (UXP), margin instead of flex gap.
function _footerBadge(label) {
  var b = _crispBox(24, '2px 7px 4px', '#454545', '#1a1a1a', 'inline-flex');
  b.style.marginLeft = '8px';
  b._ocInner.style.cssText += 'color:#b0b0b0;font-size:12px;font-weight:600;letter-spacing:0.5px;line-height:16px;';
  b._ocInner.textContent = label;
  return b;
}

// An outlined box with a crisp 1px outline. UXP draws a CSS border (rounded or
// square, on whole pixels or not) as two half-bright pixels on its top and left
// edges and one on the others, so the Settings footer's badges and buttons
// looked soft and thick in the CCX next to the ZXP; filled boxes come out sharp
// (measured from screenshots, 2026-11-22). So the outline is the outer box's
// fill, showing round a 1px inset inner box. Fills must be opaque: the inner
// one hides the outline colour behind it. Content goes in `box._ocInner`;
// `_crispTint(box, outline, fill)` recolours both (hover). UXP sets text about
// 1px lower in its line box than Chromium, so callers pad 1px less on top than
// below to centre it like the ZXP.
function _crispBox(h, pad, outline, fill, display) {
  var box = document.createElement('div');
  box.style.cssText = 'display:' + (display || 'flex') + ';box-sizing:border-box;height:' + h + 'px;padding:1px;'
    + 'border-radius:4px;background-color:' + outline + ';flex-shrink:0;';
  var inner = document.createElement('div');
  inner.style.cssText = 'display:flex;align-items:center;justify-content:center;box-sizing:border-box;height:' + (h - 2) + 'px;'
    + 'padding:' + pad + ';border-radius:3px;background-color:' + fill + ';white-space:nowrap;';
  box.appendChild(inner);
  box._ocInner = inner;
  return box;
}
function _crispTint(box, outline, fill) {
  box.style.backgroundColor = outline;
  box._ocInner.style.backgroundColor = fill;
}

function _showSettingsModal() {
  // The flyout's Settings item is Premiere's own menu and stays reachable while
  // the modal is open, so without this a second modal stacked on the first: only
  // the top one could be closed and the buried one kept its body ResizeObserver
  // running for the session. The patched remove() disconnects that observer.
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
  var _uxpLift = 1;
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
  function _wireContent(c) { // re-run on the fresh element _refreshScroller swaps in after a scroll
    content = c;
    _smoothWheel(c);           // UXP: proper wheel steps with easing
    _sdWatch(c, 'settings');
    _holdFixWatch(c);
    if (typeof _sbWire === 'function' && sb) _sbWire(c); // the new scroller needs the bar's scroll listener
    c._ocRewire = _wireContent;
  }
  _wireContent(content);
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
    _toggleCard('Double-Click Lanes', 'Double-click a timeline lane to select its property for Go',
      function() { return _tlDblOn; }, function(v) {
        _tlDblOn = v;
        localStorage.setItem(_TL_DBL_KEY, v ? 'on' : 'off');
      }),
    _toggleCard('Keyboard Shortcuts', 'Enter for Go, Space, J K L, 1-9 and the other panel keys',
      function() { return _shortcutsOn; }, function(v) {
        _shortcutsOn = v;
        localStorage.setItem(_SHORTCUTS_KEY, v ? 'on' : 'off');
        // Off: let go of the key sink so the next keys reach Premiere
        var sink = document.getElementById('oc-key-sink');
        if (!v && sink && document.activeElement === sink) { try { sink.blur(); } catch(_) {} }
      }),
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
  // [exchange-strip]
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
  // [/exchange-strip]

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

  // Edition badge: the Exchange build strips the CCX line (scripts/build.js
  // exchange), so only the Exchange .ccx says Exchange
  var editionTag = _EDITION_TAG; // CCX, or Exchange in the Exchange build
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
  // The Exchange build can't open a browser (no launchProcess), so _openUrl
  // copies the link there: GitHub shows a copy icon instead of open-in-browser
  var ghIc = '<svg width="15" height="15" viewBox="0 0 14 14" fill="none"><rect x="4.6" y="4.6" width="7" height="7" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M9.4 2.5H3.7a1.2 1.2 0 00-1.2 1.2v5.7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>', ghTip = 'Copy the GitHub link';
  ghIc = '<svg width="15" height="15" viewBox="0 0 14 14" fill="none"><path d="M8.2 2.5h3.3v3.3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M11.5 2.5L6.6 7.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M10.2 8.6v2.1a.8.8 0 01-.8.8H3.3a.8.8 0 01-.8-.8V4.6a.8.8 0 01.8-.8h2.1" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'; // [exchange-strip-line]
  ghTip = 'Open OpenCurve on GitHub in your browser'; // [exchange-strip-line]
  var ghLink = _cardBtn('GitHub', function() { _openUrl('https://github.com/fayewave/OpenCurve'); });
  ghLink.style.marginRight = '8px'; // right-aligned, just before Report an Issue
  var ghIcon = document.createElement('span');
  ghIcon.style.cssText = 'display:inline-flex;width:15px;height:15px;margin-right:6px;';
  ghIcon.innerHTML = ghIc;
  ghLink._ocIn.insertBefore(ghIcon, ghLink._ocText);
  _attachTooltip(ghLink, ghTip);

  // Veil: the mark and wordmark (one evenodd path, from the Veil site's
  // veil-lockup-white.svg), grey at rest, white on hover, a tint while
  // pressed; opens veil.page. The viewBox has room round the edge (UXP clips
  // an SVG's anti-aliased border).
  var veilBtn = _el('display:flex;align-items:center;justify-content:center;flex-shrink:0;box-sizing:border-box;height:30px;padding:0 2px 0 4px;margin-left:0;border-radius:6px;cursor:pointer;');
  veilBtn.innerHTML = '<svg width="109" height="26" viewBox="-6 -6 1213 288" fill="none">' // a little under the buttons' 30px
    + '<path fill-rule="evenodd" d="M322.26,0.67L1200.74,0.67L1200.74,275.87L322.26,275.87ZM393.17 64.79H437.62L506.75 185.31H510.87L580.01 64.79H623.63L539.26 211.76H477.54ZM646.26 211.76V64.79H847.91V91.24H687.41V125.05H806.76V151.5H687.41V185.31H847.91V211.76ZM924.04 64.79V211.76H882.89V64.79ZM1006.35 64.79V185.31H1129.8V211.76H965.19V64.79ZM0.63,0.67L275.83,0.67L275.83,275.87L0.63,275.87ZM232.75,138.27L138.23,212.35L43.7,138.27L138.23,64.19Z" fill="#cccccc"/></svg>';
  // "for more of my free plugins visit" ahead of the logo, part of the same button
  var veilText = _el('font-size:13px;line-height:16px;color:#bdbdbd;white-space:nowrap;margin-right:8px;', 'for more of my free plugins visit');
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
  veilBtn.addEventListener('click', function() { _openUrl('https://veil.page'); });
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
    _openUrl('https://github.com/fayewave/OpenCurve/issues');
  });
  issueRow.style.marginRight = '8px';
  _attachTooltip(issueRow, 'Open the OpenCurve issues page on GitHub');
  // The GitHub button's icon (open in browser; the copy icon in the Exchange build)
  var issueIcon = document.createElement('span');
  issueIcon.style.cssText = 'display:inline-flex;width:15px;height:15px;margin-right:6px;';
  issueIcon.innerHTML = ghIc;
  issueRow._ocIn.insertBefore(issueIcon, issueRow._ocText);

  var footerRight = document.createElement('div');
  footerRight.style.cssText = 'display:flex;align-items:center;flex-shrink:0;';
  footerRight.appendChild(ghLink);
  footerRight.appendChild(issueRow);
  footerRight.appendChild(resetRow);
  footerRow.appendChild(footerLeft);
  footerRow.appendChild(footerRight);
  footer.appendChild(footerRow);

  // Footer layout, narrowing in steps: everything on one row; then the
  // buttons under the credit row, both rows centred; then Report an Issue and
  // Reset All Settings shortened to Report / Reset, once the full buttons no
  // longer fit on a row of their own; and when even the credit row is too
  // wide, "for more of my free plugins visit" hidden so only the Veil logo
  // follows "made by faye!". Widths are measured once, from the full row with
  // the full labels (the layout stays that way until they are known).
  var _footShort = [[issueRow, 'Report an Issue', 'Report'], [resetRow, 'Reset All Settings', 'Reset']];
  var footNeed = 0, footLW = 0, footRW = 0, footMode = '';
  function _footSetShort(on) {
    _footShort.forEach(function(e) {
      var t = on ? e[2] : e[1];
      if (e[0]._ocText.textContent !== t) e[0]._ocText.textContent = t;
    });
  }
  function _layoutFooter(w) {
    if (!footNeed) {
      // scrollWidth: the credit row's own width even when a narrow panel has
      // already squeezed it (it may shrink, the buttons never do)
      var lw = Math.max(footerLeft.getBoundingClientRect().width, footerLeft.scrollWidth || 0), rw = footerRight.getBoundingClientRect().width;
      if (lw && rw) {
        footNeed = Math.ceil(lw + rw) + 24 + 12; // the footer's padding, the gap between the two
        footLW   = Math.ceil(lw) + 24;           // each on a row of its own
        footRW   = Math.ceil(rw) + 24;
      }
    }
    var stack = !!footNeed && w < footNeed;
    var short = stack && w < footRW;
    var tight = stack && w < footLW;
    var mode = (stack ? 's' : 'r') + (short ? 'h' : '') + (tight ? 't' : '');
    if (mode === footMode) return;
    footMode = mode;
    _footSetShort(short);
    footerRow.style.flexDirection = stack ? 'column' : 'row';
    footerRow.style.alignItems = 'center'; // stacked, each row sits centred
    footerRight.style.marginTop = stack ? '8px' : '';
    footerLeft.style.marginRight = stack ? '0' : '12px'; // or the credit row sits off centre
    veilText.style.display = tight ? 'none' : '';
    veilBtn.style.marginLeft = tight ? '6px' : '0'; // the word space the text's own padding gave
  }
  // The widths are read straight after the modal is added, and the panel may
  // not have laid it out yet: an empty read left the footer on one row, cut
  // off in a narrow panel, until a resize measured again (seen on opening
  // Settings, 2026-11-23). So for a moment after opening, a missing
  // measurement is retried, and a footer that still spills over its box goes
  // back to the full row and is measured afresh.
  function _footVw() { return document.documentElement.clientWidth || document.body.clientWidth; }
  function _footSpills() {
    var mr = modal.getBoundingClientRect(), rr = footerRight.getBoundingClientRect();
    if (!mr.width || !rr.width) return false;
    return rr.right > mr.right + 1 || rr.left < mr.left - 1 || footerLeft.scrollWidth > footerLeft.clientWidth + 1;
  }
  function _footRemeasure() {
    footNeed = 0; footMode = '';
    _footSetShort(false);
    footerRow.style.flexDirection = 'row';
    footerRight.style.marginTop = '';
    footerLeft.style.marginRight = '12px';
    veilText.style.display = '';
    veilBtn.style.marginLeft = '0';
    setTimeout(function() { if (modal.parentNode) _layoutFooter(_footVw()); }, 0);
  }
  function _footSettle(n) {
    if (n > 6) return;
    setTimeout(function() {
      if (!modal.parentNode) return;
      if (!footNeed) _layoutFooter(_footVw());
      else if (_footSpills()) _footRemeasure();
      _footSettle(n + 1);
    }, n ? 60 : 0);
  }

  modal.appendChild(header);
  modal.appendChild(contentWrap);
  modal.appendChild(footer);
  document.body.appendChild(modal);
  _sbSync();
  _layoutFooter(vw);
  _footSettle(0);

  // Resize with the panel
  var _settingsRO = new ResizeObserver(function() {
    var nvw = document.documentElement.clientWidth  || document.body.clientWidth;
    var nvh = document.documentElement.clientHeight || document.body.clientHeight;
    // Change-only writes (UXP relayouts the panel on any inline style write)
    var mw = nvw + 'px', mh = nvh + 'px';
    if (modal.style.width  !== mw) modal.style.width  = mw;
    if (modal.style.height !== mh) modal.style.height = mh;
    _layoutFooter(nvw);
    _layoutCards(nvw);
    _sbSync();
  });
  _settingsRO.observe(document.body);

  // The main panel is display:none while Settings covers it (Settings is opaque
  // and fills the panel). UXP repaints the main panel's elements on every
  // change in Settings too: a row's hover tint ran at 22-33fps with it there
  // and 50-65fps without (measured live 2026-11-22; visibility:hidden only
  // reached 35-57). Its resize observers see zero sizes meanwhile and write
  // nothing that is saved; the layout is re-run once it is back.
  var appEl = document.getElementById('app');
  var appDisplay = appEl ? appEl.style.display : '';
  if (appEl) appEl.style.display = 'none';

  var _origRemove = modal.remove.bind(modal);
  modal.remove = function() {
    _settingsRO.disconnect();
    _origRemove();
    if (appEl && appEl.style.display === 'none') {
      appEl.style.display = appDisplay;
      _applyPresetLayout(true);
      _tlSig = '';
      _tlRender(getState(), true);
    }
  };
}

// The colour is applied by `create` right after initPanel(); a DOMContentLoaded
// listener here would also never fire on the loader's plugin-update.js path,
// where the script is appended after the document is ready.


