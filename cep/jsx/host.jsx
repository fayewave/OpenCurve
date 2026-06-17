/**
 * OpenCurve CEP — ExtendScript host for Premiere Pro.
 *
 * All Premiere Pro API calls happen here (synchronous ExtendScript).
 * Called from the panel JS via CSInterface.evalScript().
 *
 * Two main entry points:
 *   detectContext()       → JSON string with clip/keyframe info
 *   bakeKeyframes(json)   → JSON string with success/error
 */

// ─── Helpers ─────────────────────────────────────────────────────────────

// Known param display names (same as UXP version)
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

function _paramName(matchName, idx) {
  var map = PARAM_NAMES[matchName];
  if (map && map[idx] !== undefined) return map[idx];
  return matchName + ' ' + idx;
}

function _jsonStringify(obj) {
  // ExtendScript doesn't have JSON.stringify in older versions
  if (typeof JSON !== 'undefined' && JSON.stringify) return JSON.stringify(obj);
  // Minimal fallback
  if (obj === null) return 'null';
  if (typeof obj === 'undefined') return 'null';
  if (typeof obj === 'number' || typeof obj === 'boolean') return String(obj);
  if (typeof obj === 'string') return '"' + obj.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
  if (obj instanceof Array) {
    var parts = [];
    for (var i = 0; i < obj.length; i++) parts.push(_jsonStringify(obj[i]));
    return '[' + parts.join(',') + ']';
  }
  if (typeof obj === 'object') {
    var pairs = [];
    for (var k in obj) {
      if (obj.hasOwnProperty(k)) {
        pairs.push('"' + k + '":' + _jsonStringify(obj[k]));
      }
    }
    return '{' + pairs.join(',') + '}';
  }
  return 'null';
}

function _jsonParse(str) {
  if (typeof JSON !== 'undefined' && JSON.parse) return JSON.parse(str);
  // Fallback — eval is available in ExtendScript
  return eval('(' + str + ')');
}

// ─── FPS detection ───────────────────────────────────────────────────────

function _detectFps(sequence) {
  try {
    // sequence.getSettings() returns an object with videoFrameRate
    var settings = sequence.getSettings();
    if (settings && settings.videoFrameRate) {
      var fr = settings.videoFrameRate;
      // Could be a TimeObject with seconds, or a direct number
      if (typeof fr === 'number' && fr > 0) return fr;
      if (fr.seconds && fr.seconds > 0) return 1.0 / fr.seconds;
      if (fr.ticks && fr.ticks > 0) return 254016000000 / fr.ticks;
    }
  } catch(e) {}

  try {
    // Try timebase approach
    var tb = sequence.timebase;
    if (tb && typeof tb === 'string') {
      var tpf = parseInt(tb, 10);
      if (tpf > 0) return 254016000000 / tpf;
    }
  } catch(e) {}

  return 30; // fallback
}

// ─── Detection cache ─────────────────────────────────────────────────────
// ExtendScript module-level vars persist across evalScript() calls, so we use
// them to skip the expensive component/property walk when nothing relevant has
// changed since the last poll. A full rescan is forced every _OC_HEARTBEAT
// polls so keyframe edits made elsewhere are still picked up.
var _ocCacheKey    = null;
var _ocCacheResult = null;
var _ocPollCount   = 0;
var _OC_HEARTBEAT  = 6;

var _ocFps      = 0;
var _ocFpsSeqId = null;

function _ocReturn(jsonStr) {
  _ocCacheResult = jsonStr;
  return jsonStr;
}

// FPS rarely changes within a session — cache per sequence instead of
// re-reading getSettings() on every poll.
function _fpsCached(sequence) {
  var seqId = '';
  try { seqId = String(sequence.sequenceID || sequence.name || ''); } catch(e) {}
  if (_ocFps > 0 && seqId === _ocFpsSeqId) return _ocFps;
  _ocFps = _detectFps(sequence);
  _ocFpsSeqId = seqId;
  return _ocFps;
}

// ─── detectContext ────────────────────────────────────────────────────────

function detectContext() {
  try {
    var project = app.project;
    if (!project) {
      return _jsonStringify({ status: 'no-project', availableParams: [], hint: '' });
    }

    var sequence = project.activeSequence;
    if (!sequence) {
      return _jsonStringify({ status: 'no-sequence', availableParams: [], hint: '' });
    }

    var playerPos = sequence.getPlayerPosition();
    var ph = playerPos.seconds;
    var fps = _fpsCached(sequence);

    // Find clips at playhead across all video tracks
    // Selected clip goes first so user can override which clip is targeted
    var numTracks = sequence.videoTracks.numTracks;
    var selectedClips = [];
    var otherClips = [];

    for (var t = numTracks - 1; t >= 0; t--) {
      var track = sequence.videoTracks[t];
      var clips = track.clips;
      for (var c = 0; c < clips.numItems; c++) {
        var clip = clips[c];
        var startSec = clip.start.seconds;
        var endSec = clip.end.seconds;
        if (ph >= startSec && ph <= endSec) {
          var entry = {
            trackIdx: t,
            clipIdx: c,
            clip: clip,
            clipStart: startSec,
            clipInPoint: clip.inPoint ? clip.inPoint.seconds : 0,
          };
          var isSel = false;
          try { isSel = clip.isSelected(); } catch(e) {}
          if (isSel) {
            selectedClips.push(entry);
          } else {
            otherClips.push(entry);
          }
        }
      }
    }

    // When a clip is selected, only check that clip — don't fall through
    // to other clips if it has no keyframes.
    var hasSelection = selectedClips.length > 0;
    var allClipResults = hasSelection ? selectedClips : otherClips;

    // ── Cache short-circuit ──
    // Build a cheap signature from the playhead + the clips at the playhead.
    // If it matches the last poll (within the heartbeat window), skip the whole
    // component/property/getKeys walk and tell the panel nothing changed.
    var _sig = Math.round(ph * 1000) + '|' + numTracks + '|';
    for (var _si = 0; _si < allClipResults.length; _si++) {
      var _ce = allClipResults[_si];
      var _cn = ''; try { _cn = _ce.clip.name; } catch(e) {}
      _sig += _cn + '@' + _ce.clipStart.toFixed(3) + ':' + _ce.clipInPoint.toFixed(3)
            + '#' + _ce.trackIdx + '/' + _ce.clipIdx + ';';
    }
    if (_sig === _ocCacheKey && _ocPollCount < _OC_HEARTBEAT && _ocCacheResult !== null) {
      _ocPollCount++;
      return '{"status":"unchanged","ph":' + ph + '}';
    }
    _ocPollCount = 0;
    _ocCacheKey  = _sig;

    if (selectedClips.length === 0 && otherClips.length === 0) {
      return _ocReturn(_jsonStringify({ status: 'no-clip', availableParams: [], hint: 'No video clip found at playhead position', ph: ph }));
    }

    // Find qualifying params (properties with 2+ keyframes)
    var bestParams = null;

    for (var ci = 0; ci < allClipResults.length; ci++) {
      var clipInfo = allClipResults[ci];
      var clip = clipInfo.clip;
      var phLocal = (ph - clipInfo.clipStart) + clipInfo.clipInPoint;
      var components = clip.components;
      var qualifiedParams = [];

      for (var compIdx = 0; compIdx < components.numItems; compIdx++) {
        var comp = components[compIdx];
        var matchName = '';
        try { matchName = comp.matchName; } catch(e) {}

        var props = comp.properties;
        for (var propIdx = 0; propIdx < props.numItems; propIdx++) {
          var prop = props[propIdx];

          // Check if property has keyframes
          try {
            if (!prop.isTimeVarying()) continue;
          } catch(e) { continue; }

          // getKeys() returns array of Time objects with .seconds and .ticks
          var kfTimes;
          try { kfTimes = prop.getKeys(); } catch(e) { continue; }
          if (!kfTimes || kfTimes.length < 2) continue;

          // Find bracket keyframes around phLocal
          var kf0Time = null, kf1Time = null;
          for (var k = 0; k < kfTimes.length; k++) {
            var kt = kfTimes[k].seconds;
            if (kt <= phLocal) kf0Time = kt;
            else if (kf1Time === null) kf1Time = kt;
          }

          var isOutside = false;
          if (kf0Time === null || kf1Time === null) {
            kf0Time = kfTimes[0].seconds;
            kf1Time = kfTimes[kfTimes.length - 1].seconds;
            isOutside = true;
          }

          // getValueAtKey takes a time (seconds), not an index
          var val0, val1;
          try {
            val0 = prop.getValueAtKey(kf0Time);
            val1 = prop.getValueAtKey(kf1Time);
          } catch(e) { continue; }

          // Handle numeric and compound (Position [x,y]) values
          var isCompound = false;
          if (typeof val0 !== 'number') {
            if (typeof val0 === 'object' && val0 !== null && val0.length === 2) {
              isCompound = true;
            } else {
              continue;
            }
          }

          var displayName = _paramName(matchName, propIdx);
          var frameCount = Math.round((kf1Time - kf0Time) * fps);

          // Convert compound values to plain arrays for JSON
          var serVal0 = isCompound ? [val0[0], val0[1]] : val0;
          var serVal1 = isCompound ? [val1[0], val1[1]] : val1;

          qualifiedParams.push({
            key: compIdx + '_' + propIdx,
            displayName: displayName,
            trackIdx: clipInfo.trackIdx,
            clipIdx: clipInfo.clipIdx,
            compIdx: compIdx,
            propIdx: propIdx,
            kf0Time: kf0Time,
            kf1Time: kf1Time,
            val0: serVal0,
            val1: serVal1,
            frameCount: frameCount,
            isOutside: isOutside,
            isCompound: isCompound,
            fps: fps,
            totalKf: kfTimes.length,
          });
        }
      }

      if (qualifiedParams.length > 0) {
        bestParams = qualifiedParams;
        break;
      }
    }

    if (!bestParams) {
      return _ocReturn(_jsonStringify({
        status: 'no-keyframes',
        availableParams: [],
        hint: 'No property with 2+ keyframes found on clips at playhead.',
        ph: ph,
      }));
    }

    var paramList = [];
    var validParamKeys = [];
    var paramContexts = {};

    for (var pi = 0; pi < bestParams.length; pi++) {
      var p = bestParams[pi];
      paramList.push({ key: p.key, displayName: p.displayName });

      if (!p.isOutside && p.frameCount >= 2) {
        validParamKeys.push(p.key);
        paramContexts[p.key] = {
          trackIdx: p.trackIdx,
          clipIdx: p.clipIdx,
          compIdx: p.compIdx,
          propIdx: p.propIdx,
          displayName: p.displayName,
          kf0Time: p.kf0Time,
          kf1Time: p.kf1Time,
          val0: p.val0,
          val1: p.val1,
          frameCount: p.frameCount,
          isCompound: p.isCompound || false,
          fps: p.fps,
        };
      }
    }

    if (validParamKeys.length === 0) {
      var first = bestParams[0];
      return _ocReturn(_jsonStringify({
        status: 'outside',
        availableParams: paramList,
        validParamKeys: [],
        hint: 'Move playhead between keyframes (' + first.kf0Time.toFixed(2) + 's \u2013 ' + first.kf1Time.toFixed(2) + 's)',
        ph: ph,
      }));
    }

    var firstCtx = paramContexts[validParamKeys[0]];
    var hintFrames = firstCtx ? firstCtx.frameCount + ' frames' : '';

    return _ocReturn(_jsonStringify({
      status: 'valid',
      availableParams: paramList,
      validParamKeys: validParamKeys,
      paramContexts: paramContexts,
      hint: hintFrames,
      ph: ph,
    }));

  } catch(err) {
    _ocCacheKey = null; // don't let a transient error poison the cache
    return _jsonStringify({
      status: 'error',
      availableParams: [],
      hint: err.message || String(err),
    });
  }
}

// ─── bakeKeyframes ───────────────────────────────────────────────────────

function bakeKeyframes(argsJSON) {
  try {
    var args = _jsonParse(argsJSON);
    var paramRefs = args.params;
    var curve = args.curve;

    var project = app.project;
    var sequence = project.activeSequence;
    var totalActions = 0;
    var firstErr = null;

    var undoInfo = [];

    // Premiere's ExtendScript `app` has no beginUndoGroup/endUndoGroup (that's
    // an After Effects API), so only use it if present. Undo is handled by the
    // panel's own undo button (_undoStack) regardless. The real apply speed-up
    // comes from passing updateUI=false on intermediate keys (see below).
    var _hasUndoGroup = (typeof app.beginUndoGroup === 'function' && typeof app.endUndoGroup === 'function');
    if (_hasUndoGroup) app.beginUndoGroup('OpenCurve bake');
    try {
      for (var pi = 0; pi < paramRefs.length; pi++) {
        var ref = paramRefs[pi];
        var track = sequence.videoTracks[ref.trackIdx];
        var clip = track.clips[ref.clipIdx];
        var comp = clip.components[ref.compIdx];
        var prop = comp.properties[ref.propIdx];

        var startSec = ref.kf0Time;
        var totalFrames = ref.frameCount;
        var val0 = ref.val0;
        var val1 = ref.val1;
        var fps = ref.fps;
        var isCompound = ref.isCompound || false;
        var label = ref.displayName || ('param ' + ref.propIdx);

        if (totalFrames < 2) continue;

        var addedTimes = [];

        for (var f = 1; f < totalFrames; f++) {
          var t = f / totalFrames;
          var easedT = _sampleBezier(t, curve);
          // Compound (Position / Anchor Point) values are passed as [x, y]
          // arrays — the correct format for 2D spatial params (the old
          // "illegal parameter type" bug was fixed in PPro 14.0.1).
          var value;
          if (isCompound) {
            value = [
              val0[0] + (val1[0] - val0[0]) * easedT,
              val0[1] + (val1[1] - val0[1]) * easedT
            ];
          } else {
            value = val0 + (val1 - val0) * easedT;
          }
          var timeSec = startSec + f / fps;

          // Pass updateUI=true only on the final key of each property: one
          // redraw per param (so the keyframes actually appear without
          // re-selecting the clip) instead of a redraw on every frame, which
          // would defeat the batching speed-up.
          var doUpdate = (f === totalFrames - 1);

          try {
            prop.addKey(timeSec);
            prop.setValueAtKey(timeSec, value, doUpdate);
            addedTimes.push(timeSec);
            totalActions++;
          } catch(e) { if (!firstErr) firstErr = label + ': ' + (e.message || String(e)); }
        }

        // Capture a stable clip/component identity alongside the indices so
        // undo can detect a changed timeline and refuse to touch the wrong
        // property.
        var bClipName = '';  try { bClipName = clip.name; } catch(e) {}
        var bClipStart = 0;  try { bClipStart = clip.start.seconds; } catch(e) {}
        var bMatchName = ''; try { bMatchName = comp.matchName; } catch(e) {}

        undoInfo.push({
          trackIdx: ref.trackIdx,
          clipIdx: ref.clipIdx,
          compIdx: ref.compIdx,
          propIdx: ref.propIdx,
          clipName: bClipName,
          clipStart: bClipStart,
          matchName: bMatchName,
          times: addedTimes,
        });
      }
    } finally {
      if (_hasUndoGroup) app.endUndoGroup();
    }

    // Detection caches by playhead+clip identity; the clip's keyframes just
    // changed, so force a fresh scan on the next poll.
    _ocCacheKey = null;

    if (totalActions === 0) {
      return _jsonStringify({ success: false, error: firstErr || 'No keyframes were written.' });
    }

    _undoStack.push(undoInfo);
    return _jsonStringify({ success: true, actions: totalActions, warning: firstErr });
  } catch(err) {
    return _jsonStringify({ success: false, error: err.message || String(err) });
  }
}

// ─── Undo last bake ──────────────────────────────────────────────────────

var _undoStack = [];

function undoBake() {
  try {
    if (_undoStack.length === 0) {
      return _jsonStringify({ success: false, error: 'Nothing to undo' });
    }

    var batch = _undoStack.pop();
    var sequence = app.project.activeSequence;
    var removed = 0;
    var skipped = 0;

    var _hasUndoGroup = (typeof app.beginUndoGroup === 'function' && typeof app.endUndoGroup === 'function');
    if (_hasUndoGroup) app.beginUndoGroup('OpenCurve undo bake');
    try {
      for (var i = 0; i < batch.length; i++) {
        var info = batch[i];
        try {
          var track = sequence.videoTracks[info.trackIdx];
          var clip = track.clips[info.clipIdx];
          var comp = clip.components[info.compIdx];
          var prop = comp.properties[info.propIdx];

          // Verify the indices still resolve to the SAME clip/component we
          // baked into. If the timeline changed (clip moved/reordered, effect
          // added/removed), skip rather than deleting keyframes off whatever
          // property now sits at those indices.
          var curName = '';  try { curName = clip.name; } catch(e) {}
          var curStart = 0;  try { curStart = clip.start.seconds; } catch(e) {}
          var curMatch = ''; try { curMatch = comp.matchName; } catch(e) {}
          var okName  = (!info.clipName)  || curName === info.clipName;
          var okStart = (info.clipStart === undefined) || Math.abs(curStart - info.clipStart) < 0.0005;
          var okMatch = (!info.matchName) || curMatch === info.matchName;
          if (!okName || !okStart || !okMatch) { skipped++; continue; }

          for (var t = 0; t < info.times.length; t++) {
            try {
              prop.removeKey(info.times[t]);
              removed++;
            } catch(e) {}
          }
        } catch(e) { skipped++; }
      }
    } finally {
      if (_hasUndoGroup) app.endUndoGroup();
    }

    // The clip's keyframes changed — force a fresh detection scan next poll.
    _ocCacheKey = null;

    if (removed === 0) {
      // Removed nothing — most likely the clip moved/changed since baking.
      // Put the batch back so the user can retry after reselecting the clip.
      _undoStack.push(batch);
      return _jsonStringify({ success: false, error: 'Could not undo — the original clip may have moved or changed. Select it and try again.', remaining: _undoStack.length });
    }

    return _jsonStringify({ success: true, removed: removed, skipped: skipped, remaining: _undoStack.length });
  } catch(err) {
    return _jsonStringify({ success: false, error: err.message || String(err) });
  }
}

// ─── Bezier math (duplicated from plugin-ui.js for ExtendScript) ─────────

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

function _sampleBezier(x, curve) {
  var cx = Math.max(0, Math.min(1, x));
  if (cx === 0) return 0;
  if (cx === 1) return 1;
  var t = _tForX(cx, curve.p1x, curve.p2x);
  return _by(t, curve.p1y, curve.p2y);
}
