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

// ─── Spellbook (inlined from @knights-of-the-editing-table/spell-book-uxp) ──
var _SpellbookClass = (function() {
  function SBEmitter() { this._events = {}; }
  SBEmitter.prototype.on = function(name, fn) {
    if (!this._events[name]) this._events[name] = [];
    this._events[name].push(fn); return this;
  };
  SBEmitter.prototype.emit = function(name) {
    var args = Array.prototype.slice.call(arguments, 1);
    (this._events[name] || []).forEach(function(fn) { try { fn.apply(null, args); } catch(_) {} });
    return this;
  };
  function Spellbook(pluginName, pluginID, commands) {
    SBEmitter.call(this);
    this._spellbookID = 'knights_of_the_editing_table.spell_book';
    this.pluginName   = pluginName;
    this.pluginID     = pluginID;
    this._commands    = commands || [];
    this._listen      = false; // start() called manually after entrypoints.setup()
  }
  Spellbook.prototype = Object.create(SBEmitter.prototype);
  Spellbook.prototype.constructor = Spellbook;
  Spellbook.prototype.plugin = function(data, args) {
    _appendLog('plugin() called, msg type: ' + (args && args[0] && args[0].type));
    if (!args) return;
    var msg = args[0];
    if (msg.type === 'app.opened') {
      _appendLog('app.opened received — registering commands');
      this._addCommands({ pluginID: this.pluginID, name: this.pluginName, commands: this._commands });
    } else if (msg.type === 'command.triggered' && this._listen) {
      var cmd = this._find(msg.commandID);
      if (cmd && typeof cmd.action === 'function') {
        cmd.action();
        this.emit(msg.commandID, msg.commandID);
      }
    }
  };
  Spellbook.prototype.start = function() {
    _appendLog('start() called — now listening for command.triggered');
    this._listen = true;
  };
  Spellbook.prototype.register = function() {
    _appendLog('register() called');
    this._addCommands({ pluginID: this.pluginID, name: this.pluginName, commands: this._commands });
  };
  Spellbook.prototype.stop  = function() { this._listen = false; };
  Spellbook.prototype._find = function(id) {
    return (this._commands || []).find(function(c) { return c.commandID === id; });
  };
  Spellbook.prototype._addCommands = function(data) {
    try {
      var pm = require('uxp').pluginManager;
      var all = Array.from(pm.plugins);
      var ids = all.map(function(p) { return p.id; });
      _appendLog('pluginManager plugins (' + ids.length + '): ' + ids.join(', '));
      var sb = all.find(function(p) { return p.id === 'knights_of_the_editing_table.spell_book'; });
      _appendLog('Spell Book found: ' + !!sb);
      if (sb) {
        sb.invokeCommand('commands.add', {
          pluginID:  data.pluginID,
          name:      data.name,
          commands:  data.commands.map(function(c) {
            return { commandID: c.commandID, name: c.name, group: c.group };
          })
        });
        _appendLog('commands.add sent OK');
      }
      return { ids: ids, found: !!sb };
    } catch(e) {
      _appendLog('_addCommands error: ' + e.message);
      return { ids: [], found: false, error: e.message };
    }
  };
  return Spellbook;
})();

// ─── Debug logger ─────────────────────────────────────────────────────────────
var _debugLog  = [];
var _debugPath = '(not yet written)';

function _appendLog(msg) {
  var ts = new Date().toISOString().replace('T', ' ').substr(0, 23);
  var line = '[' + ts + '] ' + msg;
  _debugLog.push(line);
  console.log('[OC-DEBUG] ' + msg);
  try {
    var storage = require('uxp').storage;
    storage.localFileSystem.getDataFolder().then(function(folder) {
      _debugPath = (folder.nativePath || '(unknown)') + '\\opencurve-debug.log';
      return folder.createFile('opencurve-debug.log', { overwrite: true });
    }).then(function(file) {
      return file.write(_debugLog.join('\n') + '\n');
    }).catch(function(e) { console.log('[OC-DEBUG] file write fail:', e && e.message); });
  } catch(e) { console.log('[OC-DEBUG] log error:', e && e.message); }
}

// Spell Book action refs — populated inside initPanel() once DOM is ready
var _sbGo             = function() {};
var _sbZoomIn         = function() {};
var _sbZoomOut        = function() {};
var _sbSelectAllProps  = function() {};
var _sbDeselectAllProps = function() {};

var _spellbook = new _SpellbookClass('OpenCurve', 'com.fayelab.opencurve', [
  { commandID: 'opencurve.go',               name: 'Go',                        group: 'OpenCurve', action: function() { _sbGo();             } },
  { commandID: 'opencurve.select-all-props',   name: 'Enable All Properties',   group: 'OpenCurve', action: function() { _sbSelectAllProps();   } },
  { commandID: 'opencurve.deselect-all-props', name: 'Disable All Properties',  group: 'OpenCurve', action: function() { _sbDeselectAllProps(); } },
]);

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
  var duration = 200;
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
    if (Math.abs(err) < 1e-8) break;
    var d = _bxd(t, p1x, p2x);
    if (Math.abs(d) < 1e-8) break;
    t = Math.max(0, Math.min(1, t - err / d));
  }
  return t;
}
function sampleBezier(x, curve) {
  var cx = Math.max(0, Math.min(1, x));
  if (cx === 0) return 0;
  if (cx === 1) return 1;
  var t = _tForX(cx, curve.p1x, curve.p2x);
  return _by(t, curve.p1y, curve.p2y);
}

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

  // Grid lines — positioned in value space via normToSVG
  for (var j = 1; j <= 7; j++) {
    var yc = normToSVG(0, j/8, W, H).cy;
    var lh = _makeLine('sg-gh'+j);
    lh.setAttribute('stroke', '#ffffff');
    lh.setAttribute('stroke-opacity', '0.055');
    _setLine('sg-gh'+j, rx, yc, rx + rw, yc);
  }
  for (var i = 1; i <= 7; i++) {
    var xc = normToSVG(i/8, 0, W, H).cx;
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
    if (Math.hypot(raw.cx - p1c.cx, raw.cy - p1c.cy) <= HANDLE_R + 6) return 'p1';
    if (Math.hypot(raw.cx - p2c.cx, raw.cy - p2c.cy) <= HANDLE_R + 6) return 'p2';
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
      var sy = Math.max(-0.6, Math.min(1.6, n.ny));
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
    var y   = Math.max(-0.6, Math.min(1.6, n.ny));
    if (e.shiftKey) { x = Math.round(x * 8) / 8; y = Math.round(y * 8) / 8; }
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
    for (var gi = 1; gi <= 7; gi++) {
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

async function _fps(sequence) {
  try {
    var settings = await sequence.getSettings();
    var fd = settings.videoFrameRate;
    if (fd && fd.seconds > 0) return 1 / fd.seconds;
  } catch(e) { console.log('[FS] fps error:', e.message); }
  return 25;
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

async function _clipAtPlayhead(sequence, ph) {
  // ── Strategy A: iterate video tracks (preferred — doesn't need clip selected) ──
  try {
    var vg        = await sequence.getVideoTrackGroup();
    var numTracks = await _call(vg, 'getTrackCount');
    var phTime    = ppro.TickTime.createWithSeconds(ph);

    for (var t = 0; t < numTracks; t++) {
      var track = await _call(vg, 'getTrackAt', t);
      if (!track) continue;

      var items = null;
      // Try precise range query first
      try {
        items = await track.getTrackItemsInteractingWithRange(
          phTime, phTime,
          ppro.Constants && ppro.Constants.TrackItemType
            ? ppro.Constants.TrackItemType.CLIP : undefined,
          false
        );
      } catch(_) {}

      // Fallback: all items on track, filter by time
      if (!items || items.length === 0) {
        try {
          var all = await _call(track, 'getTrackItems');
          items = (all || []).filter(function(item) {
            try {
              var s = item.startTime ? item.startTime.seconds : -1;
              var e = item.endTime   ? item.endTime.seconds   : -1;
              return ph >= s && ph <= e;
            } catch(_) { return false; }
          });
        } catch(_) {}
      }

      for (var k = 0; k < (items || []).length; k++) {
        try {
          var chain = await items[k].getComponentChain();
          if (chain) {
            var cs = await _clipStart(items[k]);
            return { clip: items[k], chain: chain, clipStart: cs };
          }
        } catch(_) {}
      }
    }
  } catch(_) { /* getVideoTrackGroup not available — fall through to selection */ }

  // ── Strategy B: use timeline selection (requires clip to be selected) ──
  try {
    var sel      = await sequence.getSelection();
    var selItems = await _call(sel, 'getTrackItems');
    for (var si = 0; si < (selItems || []).length; si++) {
      try {
        var ch2 = await selItems[si].getComponentChain();
        if (ch2) {
          var cs2 = await _clipStart(selItems[si]);
          return { clip: selItems[si], chain: ch2, clipStart: cs2 };
        }
      } catch(_) {}
    }
  } catch(_) {}

  return null;
}

// Get clip start time in sequence (seconds). Keyframe times are clip-local,
// so we need this to convert the sequence playhead into clip-local time.
async function _clipStart(clip) {
  // Try sync property first
  try {
    if (clip.startTime && typeof clip.startTime.seconds === 'number') {
      return clip.startTime.seconds;
    }
  } catch(_) {}
  // Try async method
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
    if (clip.inPoint && typeof clip.inPoint.seconds === 'number') return clip.inPoint.seconds;
  } catch(_) {}
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
  catch(e) { console.log('[FS] getComponentCount failed:', e.message); return qualified; }

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
      catch(e) { console.log('[FS] kfList err ['+i+'_'+j+']:', e.message); }
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
      try { rawVal = await _getValue(param, kf0); } catch(_) { continue; }
      if (_extractValue(rawVal) === null) continue;

      var displayName = _paramName(matchName, j, matchName + ' ' + j);
      qualified.push({ key: i+'_'+j, displayName: displayName,
                       param: param, comp: comp, paramIdx: j,
                       kf0: kf0, kf1: kf1, totalKf: kfArr.length, isOutside: isOutside });
    }
  }
  return qualified;
}

// ─── detectContext ────────────────────────────────────────────────────────
async function detectContext() {
  try {
    if (!ppro) return { status: 'error', availableParams: [], hint: 'premierepro module not loaded' };

    var project = await ppro.Project.getActiveProject();
    if (!project) return { status: 'no-project', availableParams: [], hint: '' };

    var sequence = await project.getActiveSequence();
    if (!sequence) return { status: 'no-sequence', availableParams: [], hint: '' };

    var playerPos = await sequence.getPlayerPosition();
    var ph = playerPos.seconds;

    var found = await _clipAtPlayhead(sequence, ph);
    if (!found) {
      return { status: 'no-clip', availableParams: [], hint: 'No video clip found at playhead position' };
    }

    var clipStart   = found.clipStart || 0;
    var clipInPoint = await _clipInPoint(found.clip);
    var phLocal     = (ph - clipStart) + clipInPoint;

    var qualifiedParams = await _findQualifiedParams(found.chain, phLocal);

    if (qualifiedParams.length === 0) {
      return { status: 'no-keyframes', availableParams: [], hint: 'No property with 2+ keyframes found on this clip.' };
    }

    var paramList  = qualifiedParams.map(function(p){ return { key: p.key, displayName: p.displayName }; });
    var validParams = qualifiedParams.filter(function(p){ return !p.isOutside; });

    if (validParams.length === 0) {
      var first = qualifiedParams[0];
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

    // Exclude params where the bracket is less than 2 frames apart — already baked
    var validParamKeys = validParams
      .filter(function(p){ return paramContexts[p.key] && paramContexts[p.key].frameCount >= 2; })
      .map(function(p){ return p.key; });
    console.log('[FS] VALID — params:', validParamKeys.join(', '));

    var firstCtx  = validParamKeys.length > 0 ? paramContexts[validParamKeys[0]] : null;
    var hintFrames = firstCtx ? firstCtx.frameCount + ' frames' : '';

    return {
      status: 'valid',
      availableParams: paramList,
      validParamKeys: validParamKeys,
      paramContexts: paramContexts,
      hint: hintFrames,
    };

  } catch(err) {
    console.error('[FS] detectContext threw:', err);
    return { status: 'error', availableParams: [], hint: err && err.message ? err.message : String(err) };
  }
}

// ─── bakeKeyframes ────────────────────────────────────────────────────────
// Accepts an array of contexts (one per selected param) and bakes all in one transaction.
async function bakeKeyframes(contexts, curve) {
  if (!contexts || contexts.length === 0) throw new Error('No contexts to bake.');
  var project = contexts[0].project;
  var allActions = [];

  for (var ci = 0; ci < contexts.length; ci++) {
    var context = contexts[ci];
    var param   = context.param;
    var kf0     = context.kf0;
    var kf1     = context.kf1;
    var val0    = context.val0;
    var val1    = context.val1;
    var fps     = context.fps;

    var startSec    = kf0.seconds;
    var totalFrames = Math.round((kf1.seconds - startSec) * fps);
    if (totalFrames < 2) { console.log('[FS] skipping param — KFs less than 2 frames apart'); continue; }

    var isCompound = Array.isArray(val0);
    console.log('[FS] bake['+ci+']: '+totalFrames+' frames | compound='+isCompound);

    if (isCompound) {
      for (var f2 = 1; f2 < totalFrames; f2++) {
        var easedT2    = sampleBezier(f2 / totalFrames, curve);
        var kfPerFrame = await _call(param, 'getKeyframePtr', kf0);
        kfPerFrame.position = ppro.TickTime.createWithSeconds(startSec + f2 / fps);
        kfPerFrame.value    = new ppro.PointF(
          val0[0] + (val1[0] - val0[0]) * easedT2,
          val0[1] + (val1[1] - val0[1]) * easedT2
        );
        try {
          var act2 = param.createAddKeyframeAction(kfPerFrame);
          if (act2 && typeof act2.then === 'function') act2 = await act2;
          if (act2) allActions.push(act2);
          else break;
        } catch(e) { console.log('[FS] compound kf['+f2+'] threw:', e.message); break; }
      }
    } else {
      var keyframes = [];
      for (var f = 1; f < totalFrames; f++) {
        var value = val0 + (val1 - val0) * sampleBezier(f / totalFrames, curve);
        var kf    = param.createKeyframe(0, 0);
        kf.position = ppro.TickTime.createWithSeconds(startSec + f / fps);
        kf.value    = value;
        keyframes.push(kf);
      }
      for (var i = 0; i < keyframes.length; i++) {
        try {
          var action = param.createAddKeyframeAction(keyframes[i]);
          if (action && typeof action.then === 'function') action = await action;
          if (action) allActions.push(action);
          else break;
        } catch(e) { console.log('[FS] createAddKeyframeAction threw:', e.message); break; }
      }
    }
  }

  if (allActions.length === 0) { console.log('[FS] bake: all params skipped (already baked or too close)'); return; }

  try {
    await project.lockedAccess(async function() {
      await project.executeTransaction(function(compound) {
        for (var j = 0; j < allActions.length; j++) compound.addAction(allActions[j]);
      }, 'FayeSmoothify bake');
    });
  } catch(e) { console.log('[FS] transaction threw:', e.message); }

  console.log('[FS] bake done: '+allActions.length+' actions across '+contexts.length+' param(s)');
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
  'idle':         { cls:'status-idle',  text: function(s){ return s.hint || 'Open a project and select a clip'; } },
  'no-project':   { cls:'status-idle',  text: 'No project open' },
  'no-sequence':  { cls:'status-idle',  text: 'No active sequence' },
  'no-clip':      { cls:'status-idle',  text: function(s){ return s.hint || 'No clip found at playhead'; } },
  'no-keyframes': { cls:'status-warn',  text: function(s){ return s.hint || 'No property with exactly 2 keyframes'; } },
  'outside':      { cls:'status-warn',  text: function(s){ return s.hint || 'Move playhead between the two keyframes'; } },
  'no-selection': { cls:'status-warn',  text: function(s){
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
  _sbZoomIn         = function() { applyZoom( 0.1); };
  _sbZoomOut        = function() { applyZoom(-0.1); };
  _sbGo             = function() { var b = document.getElementById('go-btn'); if (b && !b.classList.contains('btn-disabled')) b.click(); };
  _sbSelectAllProps = function() {
    var s = getState();
    var allKeys = (s.availableParams || []).map(function(p) { return p.key; });
    if (allKeys.length > 0) setState({ selectedParamKeys: allKeys });
  };
  _sbDeselectAllProps = function() {
    setState({ selectedParamKeys: [] });
  };
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

  function _ctxItem(label, danger, onClick) {
    var item = document.createElement('div');
    item.className = 'ctx-menu-item' + (danger ? ' ctx-menu-item-danger' : '');
    item.textContent = label;
    item.addEventListener('click', function(e) {
      e.stopPropagation();
      var t = _ctxTarget; // capture before hide nulls it
      _hideCtxMenu();
      onClick(t);
    });
    _ctxMenu.appendChild(item);
  }

  _ctxItem('Rename', false, function(t) {
    if (t) t.startRename();
  });
  _ctxItem('Copy Coordinates', false, function(t) {
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
  });
  _ctxItem('Apply Current Curve', false, function(t) {
    if (!t) return;
    var c = getState().curve;
    t.preset.curve = { p1x: c.p1x, p1y: c.p1y, p2x: c.p2x, p2y: c.p2y };
    _savePresetList(_presetList);
    var thumb = t.btn.querySelector('.preset-thumb path');
    if (thumb) thumb.setAttribute('d', _thumbPathD(t.preset.curve));
    _showCopyToast('Preset updated');
  });
  _ctxItem('Delete', true, function(t) {
    if (!t) return;
    _presetList = _presetList.filter(function(p) { return p.id !== t.preset.id; });
    _savePresetList(_presetList);
    if (t.btn && t.btn.parentNode) t.btn.parentNode.removeChild(t.btn);
  });

  function _showCtxMenu(preset, btn, startRename, e) {
    _ctxTarget = { preset: preset, btn: btn, startRename: startRename };
    var mw = 170;
    var mh = 112;
    var ww = document.documentElement.clientWidth  || document.body.clientWidth;
    var wh = document.documentElement.clientHeight || document.body.clientHeight;
    var x = Math.min(e.clientX, ww - mw);
    var y = e.clientY + mh > wh ? e.clientY - mh : e.clientY;
    _ctxMenu.style.left = Math.max(0, x) + 'px';
    _ctxMenu.style.top  = Math.max(0, y) + 'px';
    _ctxMenu.style.display = 'block';
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
    thumb.setAttribute('width', '28'); thumb.setAttribute('height', '28');
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

    // Delete button
    var delBtn = document.createElement('div');
    delBtn.className = 'preset-delete';
    delBtn.textContent = '×';
    btn.appendChild(delBtn);

    // Apply curve on click
    btn.addEventListener('click', function(e) {
      if (e.target === delBtn) return;
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

    // Delete
    delBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      _presetList = _presetList.filter(function(p) { return p.id !== preset.id; });
      _savePresetList(_presetList);
      if (btn.parentNode) btn.parentNode.removeChild(btn);
    });

    return btn;
  }

  // Drag-to-reorder (pointer events)
  function _initDragSort(container) {
    var dragEl = null, dropLine = null, startY = 0, moved = false;
    var _lastDownBtn = null, _lastDownTime = 0;

    container.addEventListener('pointerdown', function(e) {
      var btn = e.target;
      while (btn && btn !== container) {
        if (btn.classList && btn.classList.contains('preset-btn')) break;
        btn = btn.parentNode;
      }
      if (!btn || btn === container) return;
      if (e.target.classList && e.target.classList.contains('preset-delete')) return;
      if (e.target.classList && e.target.classList.contains('preset-rename-input')) return;

      // If this is a rapid second press on the same button, let dblclick fire instead
      var now = Date.now();
      if (btn === _lastDownBtn && now - _lastDownTime < 350) {
        _lastDownBtn = null;
        return;
      }
      _lastDownBtn = btn;
      _lastDownTime = now;

      dragEl = btn; startY = e.clientY; moved = false;
      container.setPointerCapture(e.pointerId);
    });

    container.addEventListener('pointermove', function(e) {
      if (!dragEl) return;
      if (!moved && Math.abs(e.clientY - startY) < 5) return;
      if (!moved) {
        moved = true;
        dropLine = document.createElement('div');
        dropLine.className = 'preset-drop-line';
        dragEl.classList.add('preset-dragging');
      }
      // Find insertion point
      var items = Array.from(container.children).filter(function(c) {
        return c !== dragEl && c !== dropLine;
      });
      var after = null;
      for (var i = 0; i < items.length; i++) {
        var r = items[i].getBoundingClientRect();
        if (e.clientY < r.top + r.height / 2) { after = items[i]; break; }
      }
      if (after) container.insertBefore(dropLine, after);
      else        container.appendChild(dropLine);
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
      dragEl.classList.remove('preset-dragging');
      dragEl = null; dropLine = null; moved = false;
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

  _renderPresets();
  _refreshUpdateNotification();

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
    list.appendChild(btn);
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
    title.textContent = 'Paste Coordinates';
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
  function _showMiniCtxMenu(e, showPaste) {
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

    var settingsItem = document.createElement('div');
    settingsItem.className = 'ctx-menu-item';
    settingsItem.textContent = 'Settings';
    settingsItem.addEventListener('click', function(ev) {
      ev.stopPropagation();
      if (mini.parentNode) mini.parentNode.removeChild(mini);
      _showSettingsModal();
    });
    mini.appendChild(settingsItem);

    if (showPaste) {
      var pasteItem = document.createElement('div');
      pasteItem.className = 'ctx-menu-item';
      pasteItem.textContent = 'Paste Coordinates';
      pasteItem.addEventListener('click', function(ev) {
        ev.stopPropagation();
        if (mini.parentNode) mini.parentNode.removeChild(mini);
        _pasteCoordinates();
      });
      mini.appendChild(pasteItem);
    }

    document.body.appendChild(mini);

    var mw = 170, mh = showPaste ? 72 : 36;
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
      _showMiniCtxMenu(e, false);
    });
  })();

  // Build the New Preset button using identical DOM structure to preset buttons
  (function() {
    var list = document.getElementById('all-presets-list');
    if (!list || !list.parentNode) return;

    var newBtn = document.createElement('div');
    newBtn.id = 'new-preset-btn';
    newBtn.className = 'preset-btn new-preset-btn';

    // "+" thumbnail
    var thumb = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    thumb.setAttribute('class', 'preset-thumb');
    thumb.setAttribute('width', '28'); thumb.setAttribute('height', '28');
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
      list.appendChild(btn);
      var ns = btn.querySelector('.preset-name');
      if (ns) ns.dispatchEvent(new Event('dblclick'));
    });

    list.parentNode.insertBefore(newBtn, list.nextSibling);
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
        _skipPollUntil = Date.now() + 1000;
        var newBaked = (s.bakedParamKeys || []).concat(bakedKeys.filter(function(k){ return (s.bakedParamKeys || []).indexOf(k) < 0; }));
        setState({
          isBaking: false, status: 'done',
          bakedParamKeys:    newBaked,
          selectedParamKeys: (s.selectedParamKeys || []).filter(function(k){ return bakedKeys.indexOf(k) < 0; }),
        });
        setTimeout(function() {
          _lastStatus = '';
          setState({ status: 'idle' });
        }, 1000);
      } catch(err) {
        console.error('[FS] bake error:', err);
        setState({ isBaking: false, status: 'error', hint: err && err.message ? err.message : String(err) });
      }
    });
  }

  // State → UI
  stateListeners.push(renderUI);
  renderUI(getState());
  setPresetActive('s-curve');
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
var CURRENT_VERSION     = '1.0.3';
var _CURVE_COLOR_KEY    = 'opencurve-line-color';
var _curveColor         = localStorage.getItem(_CURVE_COLOR_KEY) || '#4a9eff';
var _updateAvailable    = false;
var _latestVersion      = null;
var _updateDismissed    = false;
var _UPDATE_NOTIF_KEY   = 'opencurve-update-notif';
var _updateNotifsOn     = localStorage.getItem(_UPDATE_NOTIF_KEY) !== 'off';
var _ANIM_KEY           = 'opencurve-animations';
var _animationsOn       = localStorage.getItem(_ANIM_KEY) !== 'off';

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

  // Icon area (same 28x28 space as thumbnail)
  var iconWrap = document.createElement('span');
  iconWrap.style.cssText = 'width:28px;height:28px;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-right:8px;font-size:16px;opacity:0.9;';
  iconWrap.textContent = '⚠';
  notif.appendChild(iconWrap);

  var nameSpan = document.createElement('span');
  nameSpan.className = 'preset-name';
  nameSpan.textContent = 'Update Available';
  notif.appendChild(nameSpan);

  var delBtn = document.createElement('div');
  delBtn.className = 'preset-delete';
  delBtn.textContent = '×';
  delBtn.style.opacity = '0';
  notif.addEventListener('mouseenter', function() { delBtn.style.opacity = '1'; notif.style.background = 'rgba(240,180,0,0.15)'; });
  notif.addEventListener('mouseleave', function() { delBtn.style.opacity = '0'; notif.style.background = 'rgba(240,180,0,0.08)'; });
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
    icon.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2L13 12H1L7 2Z" stroke="#e6b800" stroke-width="1.5" stroke-linejoin="round"/><line x1="7" y1="6" x2="7" y2="9" stroke="#e6b800" stroke-width="1.5" stroke-linecap="round"/><circle cx="7" cy="10.5" r="0.75" fill="#e6b800"/></svg>';
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
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var latest = (data.tag_name || '').replace(/^v/, '');
      if (!latest) { if (!silent) _showCopyToast('No releases found on GitHub'); return; }
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
    _applyCurveColor('#4a9eff');
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
  logo.src = 'img/OpenCurve Logo8.png';
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
  var dualCol = vw >= 300;
  content.style.cssText = dualCol
    ? 'flex:1;overflow-y:auto;display:flex;flex-direction:row;'
    : 'flex:1;overflow-y:auto;';
  var rowsCol = document.createElement('div');
  rowsCol.style.cssText = dualCol ? 'flex:1;display:flex;flex-direction:column;' : '';

  // Graph line colour section
  var colorSection = document.createElement('div');
  colorSection.style.cssText = dualCol
    ? 'padding:10px 12px 12px;width:50%;box-sizing:border-box;border-left:1px solid rgba(255,255,255,0.07);'
    : 'padding:10px 12px 12px;border-top:1px solid rgba(255,255,255,0.07);';

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
  // Shortcuts section (Spell Book)
  var shortcutsSection = document.createElement('div');
  shortcutsSection.style.cssText = 'padding:10px 0 0;margin-top:10px;border-top:1px solid rgba(255,255,255,0.07);';
  var shortcutsLabel = document.createElement('div');
  shortcutsLabel.textContent = 'Shortcuts';
  shortcutsLabel.style.cssText = 'color:#b0b0b0;font-size:14px;margin-bottom:6px;';
  var shortcutsSub = document.createElement('div');
  shortcutsSub.textContent = 'Assign keys via Spell Book';
  shortcutsSub.style.cssText = 'font-size:11px;color:#555;margin-bottom:10px;';
  shortcutsSection.appendChild(shortcutsLabel);
  shortcutsSection.appendChild(shortcutsSub);
  [
    { id: 'opencurve.go',               label: 'Go'                    },
    { id: 'opencurve.select-all-props',   label: 'Enable All Properties'  },
    { id: 'opencurve.deselect-all-props', label: 'Disable All Properties' },
  ].forEach(function(s) {
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:5px;';
    var labelSpan = document.createElement('span');
    labelSpan.textContent = s.label;
    labelSpan.style.cssText = 'font-size:13px;color:#888;';
    var idSpan = document.createElement('span');
    idSpan.textContent = s.id;
    idSpan.style.cssText = 'font-size:11px;color:#555;font-family:monospace;';
    row.appendChild(labelSpan);
    row.appendChild(idSpan);
    shortcutsSection.appendChild(row);
  });
  // Divider
  var sbDivider = document.createElement('div');
  sbDivider.style.cssText = 'border-top:1px solid rgba(255,255,255,0.07);margin-top:10px;';
  shortcutsSection.appendChild(sbDivider);

  // Debug row
  var sbDebugRow = document.createElement('div');
  sbDebugRow.style.cssText = 'margin-top:10px;display:flex;flex-direction:column;gap:10px;';

  var sbPathEl = document.createElement('div');
  sbPathEl.style.cssText = 'font-size:10px;color:#444;word-break:break-all;line-height:1.4;cursor:pointer;';
  sbPathEl.textContent = 'Log: ' + _debugPath;
  sbPathEl.addEventListener('mouseenter', function() { sbPathEl.style.color = '#4a9eff'; });
  sbPathEl.addEventListener('mouseleave', function() { sbPathEl.style.color = '#444'; });
  sbPathEl.addEventListener('click', function() {
    navigator.clipboard.writeText(_debugPath).then(function() {
      _showCopyToast('Path copied — paste in Explorer address bar');
    });
  });
  sbDebugRow.appendChild(sbPathEl);

  var sbBtnRow = document.createElement('div');
  sbBtnRow.style.cssText = 'display:flex;gap:6px;margin-top:8px;';

var sbCopyBtn = document.createElement('div');
  sbCopyBtn.textContent = 'Copy Log';
  sbCopyBtn.style.cssText = 'font-size:12px;color:#555;cursor:pointer;padding:4px 8px;border:1px solid rgba(255,255,255,0.08);';
  sbCopyBtn.addEventListener('mouseenter', function() { sbCopyBtn.style.color='#888'; sbCopyBtn.style.borderColor='rgba(255,255,255,0.18)'; });
  sbCopyBtn.addEventListener('mouseleave', function() { sbCopyBtn.style.color='#555'; sbCopyBtn.style.borderColor='rgba(255,255,255,0.08)'; });
  sbCopyBtn.addEventListener('click', function() {
    var text = _debugLog.join('\n');
    if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function() {
        _showCopyToast('Log copied!', '#3ddc84');
      }).catch(function() { _showCopyToast('Copy failed — open log file manually'); });
    } else {
      _showCopyToast('Copy not available — open log file manually');
    }
  });

  sbBtnRow.appendChild(sbCopyBtn);
  sbDebugRow.appendChild(sbBtnRow);
  shortcutsSection.appendChild(sbDebugRow);
  colorSection.appendChild(shortcutsSection);

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
    var nowDual = nvw >= 300;
    if (nowDual !== dualCol) {
      dualCol = nowDual;
      content.style.flexDirection = nowDual ? 'row' : 'column';
      colorSection.style.cssText = nowDual
        ? 'padding:10px 12px 12px;width:50%;box-sizing:border-box;border-left:1px solid rgba(255,255,255,0.07);'
        : 'padding:10px 12px 12px;border-top:1px solid rgba(255,255,255,0.07);';
      rowsCol.style.cssText = nowDual
        ? 'flex:1;display:flex;flex-direction:column;'
        : '';
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

// ─── Entrypoints ──────────────────────────────────────────────────────────
var _panelCreated = false;

console.log('[FS] setting up entrypoints');
try {
  var ep = uxp && uxp.entrypoints ? uxp.entrypoints : require('uxp').entrypoints;
  ep.setup({
    plugin: {
      create: function() { console.log('[FS] plugin create'); },
      destroy: function() { if (pollTimer) { clearInterval(pollTimer); pollTimer=null; } },
    },
    commands: {
      'spellbook.plugin': {
        run: function(data, args) { _spellbook.plugin(data, args); },
      },
    },
    panels: {
      'opencurve-panel': {
        create: function() {
          console.log('[FS] panel create — DOM ready');
          _panelCreated = true;
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
          poll();
          pollTimer = setInterval(poll, POLL_MS);
          if (_updateNotifsOn) _checkForUpdates(true);
          _spellbook.register();
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
          { id: 'sep',           label: '-' },
          { id: 'made-by',       label: 'made by faye', enabled: false },
        ],
        invokeMenu: function(id) {
          if (id === 'options')       _showSettingsModal();
          if (id === 'check-updates') _checkForUpdates();
          if (id === 'reset')         _confirmReset();
        },
      },
    },
  });
  console.log('[FS] entrypoints.setup complete');
  _spellbook.start();
} catch(e) {
  console.error('[FS] entrypoints.setup FAILED:', e);
}

