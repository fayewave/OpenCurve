/**
 * FayeSmoothify — single-file plugin bundle.
 *
 * Deliberately NOT an ES module (no import/export).
 * require() is a UXP global available in all script contexts.
 * All logic lives here so there's no module-loading chain to fail silently.
 */

console.log('[FS] plugin.js executing');

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
          if (localStorage.getItem('opencurve-post-update') === '1') {
            localStorage.removeItem('opencurve-post-update');
            setTimeout(function() {
              _showCopyToast('Updated to v' + CURRENT_VERSION, '#3ddc84');
            }, 500);
          }
        },
        show: function() {
          console.log('[FS] panel show — starting poll');
          _applyPresetLayout(true);
          poll();
          pollTimer = setInterval(poll, POLL_MS);
          if (_updateNotifsOn) _checkForUpdates(true);
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
          { id: 'check-updates', label: 'Check for Updates' },
          { id: 'dump-comps',    label: 'Dump Components (Debug)' },
          { id: 'sep',           label: '-' },
          { id: 'made-by',       label: 'made by faye', enabled: false },
        ],
        invokeMenu: function(id) {
          if (id === 'options')       _showSettingsModal();
          if (id === 'check-updates') _checkForUpdates();
          if (id === 'dump-comps')    _dumpComponents();
          if (id === 'reset')         _confirmReset();
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
  errorMessage:     '',
  hint:             '',
  isBaking:         false,
  curve: { p1x: 0.625, p1y: 0.000, p2x: 0.375, p2y: 1.000 },
};
var stateListeners = [];

function getState() {
  return Object.assign({}, state, { curve: Object.assign({}, state.curve) });
}
function setState(updates) {
  Object.assign(state, updates);
  if (updates.curve) Object.assign(state.curve, updates.curve);
  var snap = getState();
  stateListeners.forEach(function(fn) { try { fn(snap); } catch(_) {} });
}

// ─── Curve animation ─────────────────────────────────────────────────────
var _curveAnimRaf = null;
function _animateToCurve(target, onUpdate) {
  if (!_animationsOn) { setState({ curve: Object.assign({}, target) }); onUpdate(target); return; }
  if (_curveAnimRaf) { cancelAnimationFrame(_curveAnimRaf); _curveAnimRaf = null; }
  var from = Object.assign({}, getState().curve);
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
function sampleBezier(x, curve) {
  var cx = Math.max(0, Math.min(1, x));
  if (cx === 0) return 0;
  if (cx === 1) return 1;
  var t = _tForX(cx, curve.p1x, curve.p2x);
  return _by(t, curve.p1y, curve.p2y);
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

// Normalised [0,1] curve coords ↔ SVG pixel coords (always at zoom=1 logical space)
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

// Map a raw SVG viewport coordinate through the inverse of the content group's scale transform
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
  var ep0 = document.getElementById('sg-ep0');
  if (ep0) { ep0.setAttribute('cx', ds.cx); ep0.setAttribute('cy', ds.cy); }
  var ep3 = document.getElementById('sg-ep3');
  if (ep3) { ep3.setAttribute('cx', de.cx); ep3.setAttribute('cy', de.cy); }
}

// Update only the dynamic elements (curve, tangents, handles) — called on every pointer event
function updateDynamicSVG(curve, W, H) {
  var p0 = normToSVG(0, 0, W, H);
  var p1 = normToSVG(curve.p1x, curve.p1y, W, H);
  var p2 = normToSVG(curve.p2x, curve.p2y, W, H);
  var p3 = normToSVG(1, 1, W, H);
  _setLine('sg-tan1', p0.cx, p0.cy, p1.cx, p1.cy);
  _setLine('sg-tan2', p3.cx, p3.cy, p2.cx, p2.cy);
  var cp = document.getElementById('sg-curve');
  if (cp) cp.setAttribute('d', 'M'+p0.cx+','+p0.cy+' C'+p1.cx+','+p1.cy+' '+p2.cx+','+p2.cy+' '+p3.cx+','+p3.cy);
  var h1 = document.getElementById('sg-h1');
  if (h1) h1.setAttribute('transform', 'translate('+p1.cx+','+p1.cy+')');
  var h2 = document.getElementById('sg-h2');
  if (h2) h2.setAttribute('transform', 'translate('+p2.cx+','+p2.cy+')');
}

function initGraphEditor(svg) {
  var dragging  = null; // 'p1' | 'p2' | null
  var liveCurve = null; // working copy mutated during drag
  var dragRect  = null; // SVG rect cached at drag-start

  function hitTest(e) {
    var rect = dragRect || svg.getBoundingClientRect();
    var raw  = _unscale(e.clientX - rect.left, e.clientY - rect.top);
    var c    = liveCurve || getState().curve;
    var p1c  = normToSVG(c.p1x, c.p1y, _svgW, _svgH);
    var p2c  = normToSVG(c.p2x, c.p2y, _svgW, _svgH);
    if (Math.hypot(raw.cx - p1c.cx, raw.cy - p1c.cy) <= HANDLE_R + HIT_TOLERANCE) return 'p1';
    if (Math.hypot(raw.cx - p2c.cx, raw.cy - p2c.cy) <= HANDLE_R + HIT_TOLERANCE) return 'p2';
    return null;
  }

  svg.addEventListener('pointerdown', function(e) {
    if (e.button !== 0) return;
    var hit = hitTest(e);
    if (!hit) {
      // Snap the closest handle to the click position
      var rect = svg.getBoundingClientRect();
      var raw  = _unscale(e.clientX - rect.left, e.clientY - rect.top);
      var c    = getState().curve;
      var p1c  = normToSVG(c.p1x, c.p1y, _svgW, _svgH);
      var p2c  = normToSVG(c.p2x, c.p2y, _svgW, _svgH);
      var d1   = Math.hypot(raw.cx - p1c.cx, raw.cy - p1c.cy);
      var d2   = Math.hypot(raw.cx - p2c.cx, raw.cy - p2c.cy);
      hit = (d1 <= d2) ? 'p1' : 'p2';
      var n  = svgToNorm(raw.cx, raw.cy, _svgW, _svgH);
      var sx = Math.max(0, Math.min(1, n.nx));
      var sy = Math.max(Y_CLAMP_MIN, Math.min(Y_CLAMP_MAX, n.ny));
      var snap = {};
      if (hit === 'p1') { snap.p1x = sx; snap.p1y = sy; }
      else              { snap.p2x = sx; snap.p2y = sy; }
      setState({ curve: Object.assign({}, c, snap) });
      clearPresetActive();
      updateDynamicSVG(getState().curve, _svgW, _svgH);
    }
    svg.setPointerCapture(e.pointerId);
    dragging    = hit;
    liveCurve   = Object.assign({}, getState().curve);
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
    if (dragging) {
      // coords updated in hot path below
    } else {
      var hit = hitTest(e);
      svg.style.cursor = hit ? 'grab' : 'crosshair';
      if (hit) {
        // Snap to handle position
        var hc = getState().curve;
        if (hit === 'p1') _showCoords(hc.p1x, hc.p1y);
        else              _showCoords(hc.p2x, hc.p2y);
      } else {
        var rect2 = svg.getBoundingClientRect();
        var rc = _unscale(e.clientX - rect2.left, e.clientY - rect2.top);
        var nc = svgToNorm(rc.cx, rc.cy, _svgW, _svgH);
        _showCoords(nc.nx, nc.ny);
      }
      return;
    }
    // Hot path: pure arithmetic + 5 setAttribute calls — no layout, no redraw
    var raw = _unscale(e.clientX - dragRect.left, e.clientY - dragRect.top);
    var n   = svgToNorm(raw.cx, raw.cy, _svgW, _svgH);
    var x   = Math.max(0,    Math.min(1,   n.nx));
    var y   = Math.max(Y_CLAMP_MIN, Math.min(Y_CLAMP_MAX, n.ny));
    if (e.shiftKey) { x = Math.round(x * _gridSize) / _gridSize; y = Math.round(y * _gridSize) / _gridSize; }
    if (dragging === 'p1') { liveCurve.p1x = x; liveCurve.p1y = y; }
    else                   { liveCurve.p2x = x; liveCurve.p2y = y; }
    _setSnapBg(e.shiftKey);
    _showCoords(x, y);
    updateDynamicSVG(liveCurve, _svgW, _svgH);
  });

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
    setState({ curve: Object.assign({}, liveCurve) });
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
    var rect = svg.getBoundingClientRect();
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

// Known param display names: component matchName → { paramIndex: displayName }
// getDisplayName() returns "" for params in this version of the UXP API.
var PARAM_NAMES = {
  'AE.ADBE Opacity':    { 0: 'Opacity' },
  'AE.ADBE Motion':     { 0: 'Position', 1: 'Scale', 2: 'Scale Width', 3: 'Scale Height', 4: 'Rotation', 5: 'Anchor Point', 7: 'Crop Left', 8: 'Crop Top', 9: 'Crop Right', 10: 'Crop Bottom' },
  'ADBE Opacity':       { 0: 'Opacity' },
  'ADBE Motion':        { 0: 'Position', 1: 'Scale', 2: 'Scale Width', 3: 'Scale Height', 4: 'Rotation', 5: 'Anchor Point', 7: 'Crop Left', 8: 'Crop Top', 9: 'Crop Right', 10: 'Crop Bottom' },
  'AE.ADBE Geometry2':  { 0: 'Transform Anchor Point', 1: 'Transform Position', 3: 'Transform Scale', 5: 'Transform Skew', 6: 'Transform Skew Axis', 7: 'Transform Rotation', 8: 'Transform Opacity', 10: 'Transform Shutter Angle' },
  'ADBE Geometry2':     { 0: 'Transform Anchor Point', 1: 'Transform Position', 3: 'Transform Scale', 5: 'Transform Skew', 6: 'Transform Skew Axis', 7: 'Transform Rotation', 8: 'Transform Opacity', 10: 'Transform Shutter Angle' },
  'AE.ADBE AECrop':     { 0: 'Crop Left', 1: 'Crop Top', 2: 'Crop Right', 3: 'Crop Bottom' },
  'ADBE AECrop':        { 0: 'Crop Left', 1: 'Crop Top', 2: 'Crop Right', 3: 'Crop Bottom' },
};
function _paramName(compMatchName, idx, fallback) {
  var map = PARAM_NAMES[compMatchName];
  return (map && map[idx]) || fallback || ('Param ' + idx);
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
    if (Array.isArray(v.value) && v.value.length > 0) return v.value;
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

// Composite clip identity — name + start + end + track index.
// Unique even for same-named clips stacked on different tracks.
async function _clipIdentity(item, trackIdx) {
  var n = '', s = '', e = '';
  try { n = await item.getName(); } catch(_) {}
  try { var st = await item.getStartTime(); s = st && typeof st.seconds === 'number' ? st.seconds : ''; } catch(_) {}
  try { var et = await item.getEndTime();   e = et && typeof et.seconds === 'number' ? et.seconds : ''; } catch(_) {}
  return n + '|' + s + '|' + e + (trackIdx !== undefined ? '|T' + trackIdx : '');
}

// Returns ALL clips at the playhead across all video tracks (topmost first)
async function _clipsViaTrackScan(sequence, ph) {
  var numTracks;
  try { numTracks = await sequence.getVideoTrackCount(); }
  catch(_) { return []; }
  if (!numTracks || numTracks <= 0) return [];

  var results = [];

  // Iterate top-down (highest track = topmost visible clip in timeline)
  for (var t = numTracks - 1; t >= 0; t--) {
    var track;
    try { track = await sequence.getVideoTrack(t); } catch(_) { continue; }
    if (!track) continue;

    var all = null;
    try { all = await track.getTrackItems(1, false); } catch(_) {}
    if (!all || all.length === 0) continue;

    for (var i = 0; i < all.length; i++) {
      try {
        var item = all[i];
        var st = await item.getStartTime();
        var et = await item.getEndTime();
        var s = st && typeof st.seconds === 'number' ? st.seconds : -1;
        var e = et && typeof et.seconds === 'number' ? et.seconds : -1;
        if (ph >= s && ph <= e) {
          var chain = await item.getComponentChain();
          if (chain) {
            var id = await _clipIdentity(item, t);
            results.push({ clip: item, chain: chain, clipStart: s, trackIdx: t, identity: id });
          }
        }
      } catch(_) {}
    }
  }
  return results;
}

async function _clipViaSelection(sequence) {
  var selItems = await _getSelectionItems(sequence);
  for (var si = 0; si < (selItems || []).length; si++) {
    try {
      var ch = await selItems[si].getComponentChain();
      if (!ch) continue;
      // Skip audio track items — their chain contains audio-only components
      // (e.g. "Internal Volume Mono") instead of video components (Opacity, Motion).
      var cc = 0; try { cc = await _call(ch, 'getComponentCount'); } catch(_) {}
      if (cc > 0) {
        var firstComp = await _call(ch, 'getComponentAtIndex', 0);
        var mn = ''; try { mn = await _call(firstComp, 'getMatchName'); } catch(_) {}
        if (mn.indexOf('Internal') === 0) continue; // Audio chain — skip
      }
      var cs = await _clipStart(selItems[si]);
      var id = await _clipIdentity(selItems[si]);
      return { clip: selItems[si], chain: ch, clipStart: cs, viaSelection: true, identity: id };
    } catch(_) {}
  }
  return null;
}


// Get clip start time in sequence (seconds). Keyframe times are clip-local,
// so we need this to convert the sequence playhead into clip-local time.
async function _clipStart(clip) {
  try {
    var st = await clip.getStartTime();
    if (st && typeof st.seconds === 'number') return st.seconds;
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


async function _findQualifiedParams(chain, phLocal) {
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
      qualified.push({ key: i+'_'+j, displayName: displayName,
                       param: param, comp: comp, paramIdx: j,
                       kf0: kf0, kf1: kf1, totalKf: kfArr.length, isOutside: isOutside });
    }
  }
  return qualified;
}

// ─── dumpComponents (debug) ───────────────────────────────────────────────
// Deep probe: enumerates every component, param, clip method, ProjectItem
// chain, and VideoFilterFactory match names to find Time Remapping.
async function _dumpComponents() {
  try {
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
        var pName = ''; try { pName = await _call(param, 'getDisplayName'); } catch(_) {}
        var pMatch = ''; try { pMatch = await _call(param, 'getMatchName'); } catch(_) {}
        var kfSupported = '?'; try { kfSupported = await _call(param, 'areKeyframesSupported'); } catch(_) {}
        var kfTimes = null;
        try { kfTimes = await _call(param, 'getKeyframeListAsTickTimes'); } catch(_) {}
        var kfCount = kfTimes ? (Array.isArray(kfTimes) ? kfTimes.length : 0) : 0;
        console.log('[FS]   Param[' + j + ']: display="' + pName + '" match="' + pMatch + '" kfOK=' + kfSupported + ' kfs=' + kfCount);
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
async function _detectContextFull(project, sequence, ph) {
  var bestQualified = null;
  var bestFound     = null;

  // 1. Try selected clip first — fast path, avoids expensive track scan
  var sel = null;
  try { sel = await _clipViaSelection(sequence); } catch(_) {}
  if (sel) {
    var clipStart   = sel.clipStart || 0;
    var clipInPoint = await _clipInPoint(sel.clip);
    var phLocal     = (ph - clipStart) + clipInPoint;
    var qualifiedParams = await _findQualifiedParams(sel.chain, phLocal);
    if (qualifiedParams.length > 0) {
      bestQualified = qualifiedParams;
      bestFound     = sel;
    }
  }

  // 2. Fall back to track scan only if NO clip is selected.
  // When a clip IS selected but has no qualifying params, respect
  // that selection — don't show another clip's keyframes.
  var scanned = [];
  if (!bestQualified && !sel) {
    try { scanned = await _clipsViaTrackScan(sequence, ph); } catch(_) {}

    for (var ci = 0; ci < scanned.length; ci++) {
      var found = scanned[ci];
      var clipStart   = found.clipStart || 0;
      var clipInPoint = await _clipInPoint(found.clip);
      var phLocal     = (ph - clipStart) + clipInPoint;
      var qualifiedParams = await _findQualifiedParams(found.chain, phLocal);
      if (qualifiedParams.length > 0) {
        bestQualified = qualifiedParams;
        bestFound     = found;
        break;
      }
    }
  }

  // No clips found at playhead at all
  if (!sel && scanned.length === 0) {
    _cache.clipStartSec = null;
    return { status: 'no-clip', availableParams: [], hint: 'No video clip found at playhead position' };
  }

  if (!bestQualified) {
    return { status: 'no-keyframes', availableParams: [], hint: 'No property with 2+ keyframes found on clips at playhead.' };
  }

  var found = bestFound;
  _cache.clipStartSec = found.clipStart || 0;

  var paramList   = bestQualified.map(function(p){ return { key: p.key, displayName: p.displayName }; });
  var validParams = bestQualified.filter(function(p){ return !p.isOutside; });

  if (validParams.length === 0) {
    var first = bestQualified[0];
    return {
      status: 'outside', availableParams: paramList, validParamKeys: [],
      hint: 'Move playhead between keyframes (' + first.kf0.seconds.toFixed(2) + 's – ' + first.kf1.seconds.toFixed(2) + 's)',
    };
  }

  var fps = await _fps(sequence);
  var paramContexts = {};
  for (var vi = 0; vi < validParams.length; vi++) {
    var vp   = validParams[vi];
    var val0 = _extractValue(await _getValue(vp.param, vp.kf0));
    var val1 = _extractValue(await _getValue(vp.param, vp.kf1));
    var fc   = Math.round((vp.kf1.seconds - vp.kf0.seconds) * fps);
    paramContexts[vp.key] = {
      param: vp.param, kf0: vp.kf0, kf1: vp.kf1,
      val0: val0, val1: val1, frameCount: fc,
      project: project, sequence: sequence, clip: found.clip, fps: fps,
    };
  }

  var validParamKeys = validParams
    .filter(function(p){ return paramContexts[p.key] && paramContexts[p.key].frameCount >= 2; })
    .map(function(p){ return p.key; });

  var firstCtx  = validParamKeys.length > 0 ? paramContexts[validParamKeys[0]] : null;
  var hintFrames = firstCtx ? firstCtx.frameCount + ' frames' : '';
  var selectionHint = found.viaSelection ? ' (selected clip)' : '';

  return {
    status: 'valid',
    availableParams: paramList,
    validParamKeys: validParamKeys,
    paramContexts: paramContexts,
    hint: hintFrames + selectionHint,
  };
}

async function detectContext() {
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

    // Track sustained playhead movement to distinguish playing from scrubbing.
    // Short scrubs (1-2 polls) get real-time detection; sustained playback (3+) pauses it.
    // If the user has enabled "scan during playback" in Settings, we never pause.
    if (_cache.playhead !== null && ph !== _cache.playhead) {
      _cache.movingCount++;
      _cache.playhead = ph;
      _cache.pollCount = 0;
      if (!_scanDuringPlayback && _cache.movingCount >= 3) {
        return { status: 'playing', availableParams: [], hint: 'Keyframe detection paused while playing' };
      }
    } else {
      _cache.movingCount = 0;
    }

    // If playhead hasn't moved, check if selection changed before returning cache
    _cache.pollCount++;
    if (_cache.playhead === ph && _cache.lastResult && _cache.pollCount < HEARTBEAT_POLLS) {
      // Selection identity check — combined identity of ALL selected items
      var selChanged = false;
      try {
        var selItems = await _getSelectionItems(sequence);
        var selCount = selItems ? selItems.length : 0;
        if (selCount !== _cache.selItemCount) {
          selChanged = true;
        } else if (selCount > 0) {
          var ids = [];
          for (var si = 0; si < selCount; si++) ids.push(await _clipIdentity(selItems[si]));
          var combinedId = ids.join('+');
          if (combinedId !== _cache.selClipId) selChanged = true;
        }
      } catch(_) {}
      if (!selChanged) return _cache.lastResult;
      _cache.pollCount = 0;
    }

    _cache.playhead = ph;
    _cache.pollCount = 0;

    // Snapshot selection identity for future change detection
    try {
      var selSnap = await _getSelectionItems(sequence);
      var snapCount = selSnap ? selSnap.length : 0;
      _cache.selItemCount = snapCount;
      if (snapCount > 0) {
        var snapIds = [];
        for (var si2 = 0; si2 < snapCount; si2++) snapIds.push(await _clipIdentity(selSnap[si2]));
        _cache.selClipId = snapIds.join('+');
      } else {
        _cache.selClipId = null;
      }
    } catch(_) {
      _cache.selItemCount = 0;
      _cache.selClipId    = null;
    }

    var result = await _detectContextFull(project, sequence, ph);
    _cache.lastResult   = result;
    _cache.lastResultAt = Date.now();
    return result;

  } catch(err) {
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
async function bakeKeyframes(contexts, curve) {
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
    var specs = [];
    for (var f = 1; f < totalFrames; f++) {
      var t       = sampleBezier(f / totalFrames, curve);
      var seconds = startSec + f / fps;
      if (isCompound) {
        specs.push({ seconds: seconds, value: [
          val0[0] + (val1[0] - val0[0]) * t,
          val0[1] + (val1[1] - val0[1]) * t
        ]});
      } else {
        specs.push({ seconds: seconds, value: val0 + (val1 - val0) * t });
      }
    }
    if (specs.length) jobs.push({ param: param, isCompound: isCompound, specs: specs });
    console.log('[FS] bake['+ci+']: '+totalFrames+' frames | compound='+isCompound+' | '+specs.length+' kf');
  }

  if (jobs.length === 0) { console.log('[FS] bake: all params skipped (already baked or too close)'); return; }

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
}

function _kfCount(param) {
  try {
    var arr = param.getKeyframeListAsTickTimes();
    return Array.isArray(arr) ? arr.length : Array.from(arr).length;
  } catch(_) { return -1; }
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

var STATUS_CONFIG = {
  'playing':      { cls:'status-idle',  text: 'Keyframe detection paused while playing' },
  'idle':         { cls:'status-idle',  text: function(s){ return s.hint || 'Open a project and select a clip'; } },
  'no-project':   { cls:'status-idle',  text: 'No project open' },
  'no-sequence':  { cls:'status-idle',  text: 'No active sequence' },
  'no-clip':      { cls:'status-idle',  text: function(s){ return s.hint || 'No clip found at playhead'; } },
  'no-keyframes': { cls:'status-warn',  text: function(s){ return s.hint || 'No property with exactly 2 keyframes'; } },
  'outside':      { cls:'status-warn',  text: function(s){ return s.hint || 'Move playhead between the two keyframes'; } },
  'no-selection': { cls:'status-detected',  text: function(s){
    var names = (s.availableParams || []).map(function(p){ return p.displayName; }).join(', ');
    return (names || 'Properties detected') + (s.hint ? ' · ' + s.hint : '');
  }},
  'valid':        { cls:'status-valid', text: function(s){
    var selected = (s.selectedParamKeys || []);
    var names = selected.map(function(k){
      var p = (s.availableParams || []).find(function(x){ return x.key === k; });
      return p ? p.displayName : k;
    });
    var paramStr = names.length ? names.join(', ') : 'property';
    return paramStr + (s.hint ? ' · ' + s.hint : '');
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

function renderUI(s) {
  // Property buttons
  var propBtns = document.getElementById('prop-btns');
  if (propBtns) {
    var params  = s.availableParams || [];
    var curKeys = propBtns.dataset.keys || '';
    var newKeys = params.map(function(p){ return p.key; }).join(',');
    if (curKeys !== newKeys) {
      propBtns.innerHTML = '';
      propBtns.dataset.keys = newKeys;
      params.forEach(function(p) {
        var btn = document.createElement('div');
        btn.className = 'prop-btn';
        btn.textContent = p.displayName;
        btn.dataset.key = p.key;
        btn.addEventListener('click', function() {
          var s2    = getState();
          var baked = (s2.bakedParamKeys || []).slice();
          var bi    = baked.indexOf(p.key);
          if (bi >= 0) {
            // First click on a green button clears baked state, leaves unselected
            baked.splice(bi, 1);
            setState({ bakedParamKeys: baked });
            return;
          }
          var keys = (s2.selectedParamKeys || []).slice();
          var idx  = keys.indexOf(p.key);
          if (idx >= 0) keys.splice(idx, 1);
          else          keys.push(p.key);
          setState({ selectedParamKeys: keys });
        });
        propBtns.appendChild(btn);
      });
    }
    // Sync active state
    var selKeys   = s.selectedParamKeys || [];
    var bakedKeys = s.bakedParamKeys   || [];
    propBtns.querySelectorAll('.prop-btn').forEach(function(btn) {
      var k = btn.dataset.key;
      btn.classList.toggle('active', selKeys.indexOf(k) >= 0);
      btn.classList.toggle('baked',  bakedKeys.indexOf(k) >= 0 && selKeys.indexOf(k) < 0);
    });
  }

  // Status strip
  var strip = document.getElementById('status-strip');
  var txt   = document.getElementById('status-text');
  if (strip && txt) {
    var cfg  = STATUS_CONFIG[s.status] || STATUS_CONFIG['idle'];
    var msg  = typeof cfg.text === 'function' ? cfg.text(s) : cfg.text;
    strip.className = 'status-strip ' + cfg.cls;
    txt.textContent = msg;
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
    var goLabel = document.getElementById('go-label');
    if (goArrow)   goArrow.style.display   = s.isBaking ? 'none' : 'inline';
    if (goLabel)   goLabel.style.display   = s.isBaking ? 'none' : 'inline';
    if (goSpinner) goSpinner.style.display = s.isBaking ? 'inline-block' : 'none';
  }
}

// ─── Panel init ───────────────────────────────────────────────────────────
function initPanel() {
  console.log('[FS] initPanel called');

  var svg = document.getElementById('bezier-svg');
  if (svg) {
    initGraphEditor(svg); // handles initial sizing + draw via ResizeObserver
  }

  var zoomIn  = document.getElementById('zoom-in');
  var zoomOut = document.getElementById('zoom-out');
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

  // _presetList: array of { id, name, curve, builtIn? }
  var _stored = _loadPresetList();
  var _presetList = _stored || BUILT_IN_PRESETS.map(function(p) {
    return { id: p.id, name: p.name, curve: p.curve, builtIn: true };
  });

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
  }

  var _icRename = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path fill="none" d="M8.5 2.5l3 3M2 9l6.5-6.5 3 3L5 12H2V9z" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var _icCopy = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><rect x="4.5" y="4.5" width="7" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><path fill="none" d="M9.5 4.5V3a1 1 0 00-1-1H3a1 1 0 00-1 1v5.5a1 1 0 001 1h1.5" stroke="currentColor" stroke-width="1.3"/></svg>';
  var _icOverwrite = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path fill="none" d="M7 2v7M4.5 6.5L7 9l2.5-2.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path fill="none" d="M2 11h10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
  var _icDelete = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path fill="none" d="M3 4h8M5.5 4V3a1 1 0 011-1h1a1 1 0 011 1v1M4.5 4l.5 7.5a1 1 0 001 .5h2a1 1 0 001-.5L9.5 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  _ctxItem('Rename', false, function(t) {
    if (t) t.startRename();
  }, _icRename);
  _ctxItem('Copy Preset', false, function(t) {
    if (!t) return;
    var c = t.preset.curve;
    var text = 'cubic-bezier(' + c.p1x + ', ' + c.p1y + ', ' + c.p2x + ', ' + c.p2y + ')';
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
    var c = getState().curve;
    t.preset.curve = { p1x: c.p1x, p1y: c.p1y, p2x: c.p2x, p2y: c.p2y };
    _savePresetList(_presetList);
    var thumb = t.btn.querySelector('.preset-thumb path');
    if (thumb) thumb.setAttribute('d', _thumbPathD(t.preset.curve));
    _showCopyToast('Preset updated');
  }, _icOverwrite);
  _ctxItem('Delete', true, function(t) {
    if (!t) return;
    _presetList = _presetList.filter(function(p) { return p.id !== t.preset.id; });
    _savePresetList(_presetList);
    if (t.btn && t.btn.parentNode) t.btn.parentNode.removeChild(t.btn);
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
  window.addEventListener('pointerdown', function(e) {
    if (!_ctxMenu.contains(e.target)) _hideCtxMenu();
  });

  // ── Thumbnails ────────────────────────────────────────────────
  function _thumbPathD(c) {
    var W = 28, H = 28, pad = 3, gW = W - 2*pad, gH = H - 2*pad;
    function tx(n) { return pad + n * gW; }
    function ty(n) { return pad + (1 - n) * gH; }
    return 'M'+tx(0)+','+ty(0)+' C'+tx(c.p1x)+','+ty(c.p1y)+' '+tx(c.p2x)+','+ty(c.p2y)+' '+tx(1)+','+ty(1);
  }

  function _buildPresetBtn(preset) {
    var btn = document.createElement('div');
    btn.className = 'preset-btn';
    btn.dataset.id = preset.id;

    // Thumbnail
    var thumb = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    thumb.setAttribute('class', 'preset-thumb');
    thumb.setAttribute('width', '28'); thumb.setAttribute('height', '28'); thumb.setAttribute('viewBox', '0 0 28 28');
    var tp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    tp.setAttribute('fill', 'none'); tp.setAttribute('stroke', _curveColor);
    tp.setAttribute('stroke-width', '2'); tp.setAttribute('stroke-linecap', 'round');
    tp.setAttribute('d', _thumbPathD(preset.curve));
    thumb.appendChild(tp); btn.appendChild(thumb);

    // Name
    var nameSpan = document.createElement('span');
    nameSpan.className = 'preset-name';
    nameSpan.textContent = preset.name;
    btn.appendChild(nameSpan);

    // Apply curve on click
    btn.addEventListener('click', function(e) {
      setPresetActive(preset.id);
      _animateToCurve(preset.curve, function(cur) {
        updateDynamicSVG(cur, _svgW, _svgH);
      });
    });

    // Rename: dblclick or right-click
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

  // Drag-to-reorder (pointer events)
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

      // If this is a rapid second press on the same button, let dblclick fire instead
      var now = Date.now();
      if (btn === _lastDownBtn && now - _lastDownTime < 350) {
        _lastDownBtn = null;
        return;
      }
      _lastDownBtn = btn;
      _lastDownTime = now;

      dragEl = btn; startX = e.clientX; startY = e.clientY; moved = false;
      container.setPointerCapture(e.pointerId);
    });

    var _dropHighlight = null;
    container.addEventListener('pointermove', function(e) {
      if (!dragEl) return;
      if (!moved && Math.abs(e.clientY - startY) < 5) return;
      if (!moved) {
        moved = true;
        dropLine = document.createElement('div');
        dropLine.className = 'preset-drop-line';
        dragEl.classList.add('preset-dragging');
        if (_presetLayout === 'grid') {
          // Create floating ghost
          var rect = dragEl.getBoundingClientRect();
          _dragGhost = dragEl.cloneNode(true);
          _dragGhost.style.cssText = 'position:fixed;z-index:9999;pointer-events:none;opacity:0.6;transform:scale(0.85);width:' + rect.width + 'px;';
          _dragGhost.style.left = (e.clientX - rect.width / 2) + 'px';
          _dragGhost.style.top = (e.clientY - rect.height / 2) + 'px';
          document.body.appendChild(_dragGhost);
          dragEl.style.display = 'none';
        }
      }
      // Move ghost
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
        // Find which tile the cursor is over
        var hoverTarget = null;
        for (var i = 0; i < items.length; i++) {
          var r = items[i].getBoundingClientRect();
          if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
            hoverTarget = items[i];
            break;
          }
        }
        // Insert before the hovered tile (dragged item takes its place)
        if (hoverTarget) after = hoverTarget;
        // Highlight the target tile
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
      dragEl = null; dropLine = null; moved = false;
      if (_presetLayout === 'grid') _applyPresetLayout(true);
    }

    container.addEventListener('pointerup',     endDragSort);
    container.addEventListener('pointercancel', endDragSort);
  }

  function _renderPresets() {
    var list = document.getElementById('all-presets-list');
    if (!list) return;
    // Preserve the New Preset button if it exists
    var newBtn = document.getElementById('new-preset-btn');
    list.innerHTML = '';
    _presetList.forEach(function(p) { list.appendChild(_buildPresetBtn(p)); });
    if (newBtn) list.appendChild(newBtn);
    _initDragSort(list);
  }

  _renderPresets();
  _refreshUpdateNotification();

  _applyPresetLayout(true);
  var _presetListEl = document.getElementById('all-presets-list');
  if (_presetListEl && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(_updateGridCols).observe(_presetListEl);
  }

  // Parse cubic-bezier string → curve object or null
  function _parseCubicBezier(text) {
    if (!text) return null;
    var m = text.match(/cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/i);
    if (!m) return null;
    var vals = [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), parseFloat(m[4])];
    if (vals.some(isNaN)) return null;
    return { p1x: vals[0], p1y: vals[1], p2x: vals[2], p2y: vals[3] };
  }

  // Create a preset from a parsed curve and add it to the list
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

  // Show paste-coordinates input panel
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
    desc.textContent = 'Paste a cubic-bezier() value:';
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
      if (!curve) { err.textContent = 'Invalid format — expected cubic-bezier(x1, y1, x2, y2)'; return; }
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

  // Mini Settings-only context menu (used in preset list empty space + graph)
  function _showMiniCtxMenu(e, showPaste, showLayout, showGrid) {
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

    var _icSettings = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="4" cy="8" r="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="12" cy="8" r="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
    var _icGrid = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><rect x="1.5" y="1.5" width="4.5" height="4.5" rx="0.5" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="8" y="1.5" width="4.5" height="4.5" rx="0.5" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="1.5" y="8" width="4.5" height="4.5" rx="0.5" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="8" y="8" width="4.5" height="4.5" rx="0.5" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
    var _icList = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><line x1="1.5" y1="3.5" x2="12.5" y2="3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="1.5" y1="7" x2="12.5" y2="7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="1.5" y1="10.5" x2="12.5" y2="10.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
    var _icPaste = '<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><rect x="3" y="2" width="8" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><path fill="none" d="M5.5 2V1.5a1 1 0 011-1h1a1 1 0 011 1V2" stroke="currentColor" stroke-width="1.3"/><line x1="5.5" y1="6" x2="8.5" y2="6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="5.5" y1="8.5" x2="8.5" y2="8.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';

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
      if (onPreset) return;
      _showMiniCtxMenu(e, true);
    });
  })();

  // Right-click on graph editor
  (function() {
    var graph = document.getElementById('bezier-svg');
    if (!graph) return;
    graph.addEventListener('contextmenu', function(e) {
      _showMiniCtxMenu(e, false, false, true);
    });
  })();

  // Build the New Preset button inside the preset list
  (function() {
    var list = document.getElementById('all-presets-list');
    if (!list) return;

    function _buildNewPresetBtn() {
      var newBtn = document.createElement('div');
      newBtn.id = 'new-preset-btn';
      newBtn.className = 'preset-btn new-preset-btn';

      // "+" thumbnail
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
          curve: { p1x: c.p1x, p1y: c.p1y, p2x: c.p2x, p2y: c.p2y },
        };
        _presetList.push(preset);
        _savePresetList(_presetList);
        var btn = _buildPresetBtn(preset);
        // Insert before the New Preset button
        list.insertBefore(btn, newBtn);
        _applyPresetLayout(true);
        var ns = btn.querySelector('.preset-name');
        if (ns) ns.dispatchEvent(new Event('dblclick'));
      });

      return newBtn;
    }

    list.appendChild(_buildNewPresetBtn());
  }());

  // Resize handle — drag to adjust left/right column split
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

  // Status strip — click to select all valid params
  var statusStrip = document.getElementById('status-strip');
  if (statusStrip) {
    statusStrip.addEventListener('click', function() {
      var s = getState();
      var valid = s.validParamKeys || [];
      if (valid.length > 0) setState({ selectedParamKeys: valid.slice() });
    });
  }

  function _updateStripCursor(s) {
    if (!statusStrip) return;
    var clickable = s.status !== 'valid' && s.status !== 'done' && (s.validParamKeys || []).length > 0;
    statusStrip.style.cursor = clickable ? 'pointer' : 'default';
  }
  stateListeners.push(_updateStripCursor);

  // Go button
  var goBtn = document.getElementById('go-btn');
  if (goBtn) {
    goBtn.addEventListener('click', async function() {
      var s = getState();
      var bakedKeys = (s.selectedParamKeys || [])
        .filter(function(k){ return (s.validParamKeys || []).indexOf(k) >= 0 && s.paramContexts && s.paramContexts[k]; });
      var contexts = bakedKeys.map(function(k){ return s.paramContexts[k]; });
      if (s.status !== 'valid' || s.isBaking || contexts.length === 0) return;
      setState({ isBaking: true, status: 'baking' });
      try {
        await bakeKeyframes(contexts, s.curve);
        _invalidateCache(); // keyframes changed — force full re-scan on next poll
        _skipPollUntil = Date.now() + DONE_DISPLAY_MS;
        var newBaked = (s.bakedParamKeys || []).concat(bakedKeys.filter(function(k){ return (s.bakedParamKeys || []).indexOf(k) < 0; }));
        setState({
          isBaking: false, status: 'done',
          bakedParamKeys:    newBaked,
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
      }
    });
  }

  // State → UI
  stateListeners.push(renderUI);
  renderUI(getState());
  setPresetActive('s-curve');
}

// ─── Detection cache ─────────────────────────────────────────────────────
var _cache = {
  playhead:       null,   // last playhead seconds
  sequenceGuid:   null,   // guid of active sequence
  fps:            null,   // cached fps for current sequence
  fpsCheckedAt:   0,      // timestamp of last fps detection
  clipStrategy:   null,   // 'track' | 'selection' — whichever worked last
  clipStartSec:   null,   // start time of last detected clip (identity key)
  selClipId:      null,   // composite identity string: name|start|end
  selItemCount:   0,      // number of selected items (fast identity check)
  selTrackItemSig: null,  // 'noargs' | 'typed' — which getTrackItems call works on selection
  lastResult:     null,   // full detectContext result
  lastResultAt:   0,      // timestamp of last full detection
  pollCount:      0,      // polls since last full detection
  movingCount:    0,      // consecutive polls where playhead moved
};

var FPS_RECHECK_MS     = 30000; // re-detect fps every 30s to catch mid-session changes
var HEARTBEAT_POLLS    = 5;     // force full re-scan every N polls even if playhead is static (~1s)

function _invalidateCache() {
  _cache.playhead      = null;
  _cache.clipStartSec  = null;
  _cache.selClipId     = null;
  _cache.selItemCount  = 0;
  _cache.lastResult    = null;
  _cache.pollCount     = 0;
}

// ─── Polling ──────────────────────────────────────────────────────────────
var pollTimer      = null;
var POLL_MS        = 200;
var _lastStatus    = '';
var _skipPollUntil = 0;
var _pollRunning   = false; // prevents concurrent poll calls piling up
var _isDragging    = false; // pause polling while handle is being dragged

async function poll() {
  if (_pollRunning) return; // drop the tick if the previous one isn't done yet
  if (_isDragging)  return; // keep event loop free while user is dragging
  var s = getState();
  if (s.isBaking) return;
  if (Date.now() < _skipPollUntil) return;
  _pollRunning = true;
  try {
    var result = await detectContext();
    var updates = {
      status:          result.status,
      availableParams: result.availableParams || [],
      hint:            result.hint || '',
      errorMessage:    result.errorMessage || result.hint || '',
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
      updates.bakedParamKeys    = (s.bakedParamKeys || []).filter(function(k){
        // Drop baked state if param is back in validParamKeys (undo restored original KFs)
        var inAvail = avail.some(function(p){ return p.key === k; });
        var inValid = validKeys.indexOf(k) >= 0;
        return inAvail && !inValid;
      });

      // Downgrade status if no selected param is actually valid
      var activeCount = currentSel.filter(function(k){ return validKeys.indexOf(k) >= 0; }).length;
      if (activeCount === 0) updates.status = 'no-selection';
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
    setState(updates);
  } catch(err) {
    console.error('[FS] poll error:', err);
  } finally {
    _pollRunning = false;
  }
}
window.__opencurvePoll = poll;

// ─── Settings / flyout ─────────────────────────────────────────────────────
var CURRENT_VERSION     = '1.2.3';
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

  // List container
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

  // Each preset button
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

  // Preset name text wrapping
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

  // Thumbnails
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

  // Update notif — compact in grid mode
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

  // UXP may ignore inline styles on first render — force reflow,
  // then re-assert align-self on each tile after a delay (no full re-call)
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
  document.querySelectorAll('.preset-thumb path').forEach(function(p) {
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
  }
}

function _showCopyToast(msg, color) {
  var toast = document.createElement('div');
  toast.textContent = msg;
  toast.style.cssText = [
    'position:fixed', 'top:10px', 'left:50%', 'transform:translateX(-50%)',
    'background:#252525', 'border:1px solid rgba(255,255,255,0.12)',
    'color:'+(color||'#e4e4e4'), 'font-size:15px', 'padding:7px 14px',
    'border-radius:0', 'pointer-events:none', 'z-index:99999',
    'white-space:nowrap', 'max-width:320px', 'overflow:hidden',
    'text-overflow:ellipsis', 'opacity:1', 'transition:opacity 0.3s',
  ].join(';');
  document.body.appendChild(toast);
  var delay = color ? 2800 : 1800;
  setTimeout(function() { toast.style.opacity = '0'; }, delay);
  setTimeout(function() { if (toast.parentNode) toast.parentNode.removeChild(toast); }, delay + 400);
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

  // Icon area (same 28x28 space as thumbnail)
  var iconWrap = document.createElement('span');
  iconWrap.className = 'preset-thumb';
  iconWrap.style.cssText = 'width:28px;height:28px;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-right:8px;font-size:16px;opacity:0.9;';
  iconWrap.textContent = '⚠';
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
    label.style.color = '#b0b0b0';
    leftIcon.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path fill="none" d="M13.5 8a5.5 5.5 0 11-1.5-3.8" stroke="#e6b800" stroke-width="1.6" stroke-linecap="round"/><polyline fill="none" points="12,2 12,5.5 8.5,5.5" stroke="#e6b800" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }
  btn.insertBefore(leftIcon, btn.firstChild);
}

function _openReleasesPage() {
  var url = 'https://github.com/fayewave/OpenCurve/releases/latest';
  require('uxp').shell.openExternal(url).then(function() {
    _showCopyToast('Opened link in browser', '#e6b800');
  }).catch(function(e) {
    console.error('[OC] openExternal failed:', e);
    navigator.clipboard.writeText(url).then(function() {
      _showCopyToast('Link copied — paste in browser', '#e6b800');
    });
  });
}

function _checkForUpdates(silent) {
  _updateDismissed = false;
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
      if (latest === CURRENT_VERSION) {
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

function _confirmReset() {
  var overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.65);z-index:99998;display:flex;align-items:center;justify-content:center;';

  var box = document.createElement('div');
  box.style.cssText = 'background:#1c1c1c;border:1px solid rgba(255,255,255,0.18);padding:20px;width:260px;font-family:system-ui,sans-serif;';

  var title = document.createElement('div');
  title.textContent = 'Reset All Settings';
  title.style.cssText = 'color:#e4e4e4;font-size:14px;font-weight:600;margin-bottom:8px;';

  var msg = document.createElement('div');
  msg.textContent = 'This will clear all saved presets, the graph line colour, and reset the curve. This cannot be undone.';
  msg.style.cssText = 'color:#888;font-size:13px;margin-bottom:16px;line-height:1.5;';

  var btns = document.createElement('div');
  btns.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';

  var cancelBtn = document.createElement('div');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = 'background:transparent;border:1px solid rgba(255,255,255,0.12);color:#888;font-size:13px;padding:5px 12px;cursor:pointer;';
  cancelBtn.addEventListener('mouseenter', function() { cancelBtn.style.color='#e4e4e4'; cancelBtn.style.borderColor='rgba(255,255,255,0.25)'; });
  cancelBtn.addEventListener('mouseleave', function() { cancelBtn.style.color='#888'; cancelBtn.style.borderColor='rgba(255,255,255,0.12)'; });
  cancelBtn.addEventListener('click', function() { document.body.removeChild(overlay); });

  var resetBtn = document.createElement('div');
  resetBtn.textContent = 'Reset';
  resetBtn.style.cssText = 'background:#f06060;border:none;color:#fff;font-size:13px;padding:5px 12px;cursor:pointer;font-weight:600;';
  resetBtn.addEventListener('mouseenter', function() { resetBtn.style.background='#f27878'; });
  resetBtn.addEventListener('mouseleave', function() { resetBtn.style.background='#f06060'; });
  resetBtn.addEventListener('click', function() {
    localStorage.removeItem('opencurve-presets-v10');
    localStorage.removeItem('opencurve-sidebar-width');
    localStorage.removeItem(_CURVE_COLOR_KEY);
    localStorage.removeItem(_GRID_KEY);
    localStorage.removeItem(_LAYOUT_KEY);
    localStorage.removeItem(_ANIM_KEY);
    localStorage.removeItem(_UPDATE_NOTIF_KEY);
    localStorage.removeItem(_SCAN_PLAYBACK_KEY);
    _applyCurveColor('#4a9eff');
    _animationsOn       = true;
    _updateNotifsOn     = true;
    _scanDuringPlayback = true;
    setState({ curve: { p1x: 0.625, p1y: 0.000, p2x: 0.375, p2y: 1.000 } });
    document.body.removeChild(overlay);
    _showCopyToast('Reset all settings');
    try { location.reload(); } catch(e) {}
  });

  btns.appendChild(cancelBtn);
  btns.appendChild(resetBtn);
  box.appendChild(title);
  box.appendChild(msg);
  box.appendChild(btns);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

function _showSettingsModal() {

  var modal = document.createElement('div');
  modal.id = 'settings-modal';
  var vw = document.documentElement.clientWidth  || document.body.clientWidth;
  var vh = document.documentElement.clientHeight || document.body.clientHeight;
  modal.style.cssText = 'position:fixed;top:0;left:0;width:'+vw+'px;height:'+vh+'px;background:#1c1c1c;z-index:9998;display:flex;flex-direction:column;font-family:system-ui,sans-serif;';

  // Logo + close row
  var header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;padding:10px 8px 10px 12px;border-bottom:1px solid rgba(255,255,255,0.07);flex-shrink:0;';
  var logoSpacer = document.createElement('div');
  logoSpacer.style.cssText = 'width:24px;flex-shrink:0;';
  var logoWrap = document.createElement('div');
  logoWrap.style.cssText = 'flex:1;display:flex;align-items:center;justify-content:center;';
  var logo = document.createElement('img');
  logo.src = 'img/OpenCurve_Logo14.png';
  logo.style.cssText = 'height:26px;opacity:0.9;';
  logoWrap.appendChild(logo);
  var closeBtn = document.createElement('div');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = 'color:#888;font-size:13px;cursor:pointer;padding:4px 6px;flex-shrink:0;';
  closeBtn.addEventListener('mouseenter', function() { closeBtn.style.color='#e4e4e4'; });
  closeBtn.addEventListener('mouseleave', function() { closeBtn.style.color='#888'; });
  closeBtn.addEventListener('click', function() {
    modal.remove();
  });
  header.appendChild(logoSpacer);
  header.appendChild(logoWrap);
  header.appendChild(closeBtn);

  // Content
  var content = document.createElement('div');
  var dualCol = vw > 520;
  content.style.cssText = dualCol
    ? 'flex:1;overflow-y:auto;display:flex;flex-direction:row;'
    : 'flex:1;overflow-y:auto;display:flex;flex-direction:column;';
  var rowsCol = document.createElement('div');
  rowsCol.style.cssText = dualCol ? 'flex:1;display:flex;flex-direction:column;' : 'flex-shrink:0;display:flex;flex-direction:column;';

  // Graph line colour section
  var colorSection = document.createElement('div');
  colorSection.style.cssText = dualCol
    ? 'padding:10px 12px 12px;width:50%;box-sizing:border-box;border-left:1px solid rgba(255,255,255,0.07);'
    : 'padding:10px 12px 12px;border-top:1px solid rgba(255,255,255,0.07);flex-shrink:0;';

  var colorLabel = document.createElement('div');
  colorLabel.textContent = 'Theme';
  colorLabel.style.cssText = 'color:#b0b0b0;font-size:14px;margin-bottom:10px;';
  colorSection.appendChild(colorLabel);

  // Swatches
  var swatchColors = ['#4a9eff','#3ddc84','#f06060','#f0a030','#c97ff0','#ff6eb4','#ffffff','#aaaaaa'];
  var swatchRow = document.createElement('div');
  swatchRow.style.cssText = 'display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap;';
  swatchColors.forEach(function(col) {
    var sw = document.createElement('div');
    sw.style.cssText = 'width:22px;height:22px;background:'+col+';cursor:pointer;border:2px solid '+(col===_curveColor?'#fff':'transparent')+';flex-shrink:0;';
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

  // Hex input
  var hexRow = document.createElement('div');
  hexRow.style.cssText = 'display:flex;align-items:center;gap:8px;';
  var hexLabel = document.createElement('span');
  hexLabel.textContent = 'Hex';
  hexLabel.style.cssText = 'color:#888;font-size:13px;';
  var hexInput = document.createElement('input');
  hexInput.type = 'text';
  hexInput.value = _curveColor.toUpperCase();
  hexInput.maxLength = 7;
  hexInput.style.cssText = 'background:#252525;border:1px solid rgba(255,255,255,0.12);color:#e4e4e4;font-size:13px;padding:3px 8px;width:90px;outline:none;font-family:monospace;';
  var hexPreview = document.createElement('div');
  hexPreview.style.cssText = 'width:20px;height:20px;background:'+_curveColor+';flex-shrink:0;border:1px solid rgba(255,255,255,0.12);';
  hexInput.addEventListener('input', function() {
    var val = hexInput.value;
    // Strip anything that isn't # or hex digits
    val = val.toUpperCase().replace(/[^#0-9A-F]/g, '');
    // Ensure it starts with #
    if (val.charAt(0) !== '#') val = '#' + val;
    // Cap at 7 chars
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

  // Update notifications toggle row
  var notifRow = document.createElement('div');
  notifRow.style.cssText = 'display:flex;align-items:center;padding:0 12px;height:36px;border-bottom:1px solid rgba(255,255,255,0.07);cursor:pointer;';
  var notifLabel = document.createElement('span');
  notifLabel.style.cssText = 'font-size:14px;flex:1;color:#b0b0b0;';
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

  var animRow = document.createElement('div');
  animRow.style.cssText = 'display:flex;align-items:center;padding:0 12px;height:36px;border-bottom:1px solid rgba(255,255,255,0.07);cursor:pointer;';
  var animLabel = document.createElement('span');
  animLabel.style.cssText = 'font-size:14px;flex:1;color:#b0b0b0;';
  animLabel.textContent = 'Animations';
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
  scanLabel.style.cssText = 'font-size:14px;flex:1;color:#b0b0b0;';
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

  // Grid size row
  var gridRow = document.createElement('div');
  gridRow.style.cssText = 'display:flex;align-items:center;padding:0 0 0 12px;height:36px;border-bottom:1px solid rgba(255,255,255,0.07);';
  var gridIcon = document.createElement('span');
  gridIcon.style.cssText = 'display:flex;align-items:center;flex-shrink:0;margin-right:8px;';
  gridIcon.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="12" stroke="#b0b0b0" stroke-width="1.4" rx="1"/><line x1="6" y1="2" x2="6" y2="14" stroke="#b0b0b0" stroke-width="1"/><line x1="10" y1="2" x2="10" y2="14" stroke="#b0b0b0" stroke-width="1"/><line x1="2" y1="6" x2="14" y2="6" stroke="#b0b0b0" stroke-width="1"/><line x1="2" y1="10" x2="14" y2="10" stroke="#b0b0b0" stroke-width="1"/></svg>';
  var gridLabel = document.createElement('span');
  gridLabel.style.cssText = 'font-size:14px;flex:1;color:#b0b0b0;';
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

  // Preset layout row
  var layoutRow = document.createElement('div');
  layoutRow.style.cssText = 'display:flex;align-items:center;padding:0 0 0 12px;height:36px;border-bottom:1px solid rgba(255,255,255,0.07);';
  var layoutIcon = document.createElement('span');
  layoutIcon.style.cssText = 'display:flex;align-items:center;flex-shrink:0;margin-right:8px;';
  layoutIcon.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><line x1="2" y1="4" x2="14" y2="4" stroke="#b0b0b0" stroke-width="1.4" stroke-linecap="round"/><line x1="2" y1="8" x2="14" y2="8" stroke="#b0b0b0" stroke-width="1.4" stroke-linecap="round"/><line x1="2" y1="12" x2="14" y2="12" stroke="#b0b0b0" stroke-width="1.4" stroke-linecap="round"/></svg>';
  var layoutLabel = document.createElement('span');
  layoutLabel.style.cssText = 'font-size:14px;flex:1;color:#b0b0b0;';
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
  madeBy.textContent = 'made by faye  ·  v' + CURRENT_VERSION;
  madeBy.style.cssText = 'color:#888;font-size:12px;margin-bottom:4px;';
  var ghLink = document.createElement('div');
  ghLink.textContent = 'github.com/fayewave/OpenCurve';
  ghLink.style.cssText = 'color:#555;font-size:12px;cursor:pointer;';
  ghLink.addEventListener('mouseenter', function() { ghLink.style.color = '#4a9eff'; });
  ghLink.addEventListener('mouseleave', function() { ghLink.style.color = '#555'; });
  ghLink.addEventListener('click', function() {
    try { require('uxp').shell.openExternal('https://github.com/fayewave/OpenCurve'); } catch(e) {}
  });
  footerLeft.appendChild(madeBy);
  footerLeft.appendChild(ghLink);

  var resetRow = document.createElement('div');
  resetRow.style.cssText = 'display:flex;align-items:center;gap:6px;padding:5px 10px;cursor:pointer;color:#f06060;font-size:13px;background:rgba(240,96,96,0.08);flex-shrink:0;';
  var resetIcon = document.createElement('span');
  resetIcon.style.cssText = 'display:flex;align-items:center;';
  resetIcon.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path fill="none" d="M3 5h10M6 5V4h4v1M6.5 7.5v4M9.5 7.5v4M4.5 5l.5 8h6l.5-8" stroke="#f06060" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var resetLabel = document.createElement('span');
  resetLabel.textContent = 'Reset All Settings';
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

  // Resize with the panel
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


