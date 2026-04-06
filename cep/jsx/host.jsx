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
    var fps = _detectFps(sequence);

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

    if (selectedClips.length === 0 && otherClips.length === 0) {
      return _jsonStringify({ status: 'no-clip', availableParams: [], hint: 'No video clip found at playhead position', ph: ph });
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
      return _jsonStringify({
        status: 'no-keyframes',
        availableParams: [],
        hint: 'No property with 2+ keyframes found on clips at playhead.',
        ph: ph,
      });
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
      return _jsonStringify({
        status: 'outside',
        availableParams: paramList,
        validParamKeys: [],
        hint: 'Move playhead between keyframes (' + first.kf0Time.toFixed(2) + 's \u2013 ' + first.kf1Time.toFixed(2) + 's)',
        ph: ph,
      });
    }

    var firstCtx = paramContexts[validParamKeys[0]];
    var hintFrames = firstCtx ? firstCtx.frameCount + ' frames' : '';

    return _jsonStringify({
      status: 'valid',
      availableParams: paramList,
      validParamKeys: validParamKeys,
      paramContexts: paramContexts,
      hint: hintFrames,
      ph: ph,
    });

  } catch(err) {
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

    var undoInfo = [];

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

      if (totalFrames < 2) continue;

      var addedTimes = [];

      for (var f = 1; f < totalFrames; f++) {
        var t = f / totalFrames;
        var easedT = _sampleBezier(t, curve);
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

        try {
          prop.addKey(timeSec);
          prop.setValueAtKey(timeSec, value);
          addedTimes.push(timeSec);
          totalActions++;
        } catch(e) {}
      }

      undoInfo.push({
        trackIdx: ref.trackIdx,
        clipIdx: ref.clipIdx,
        compIdx: ref.compIdx,
        propIdx: ref.propIdx,
        times: addedTimes,
      });
    }

    _undoStack.push(undoInfo);

    return _jsonStringify({ success: true, actions: totalActions });
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

    for (var i = 0; i < batch.length; i++) {
      var info = batch[i];
      try {
        var track = sequence.videoTracks[info.trackIdx];
        var clip = track.clips[info.clipIdx];
        var comp = clip.components[info.compIdx];
        var prop = comp.properties[info.propIdx];

        for (var t = 0; t < info.times.length; t++) {
          try {
            prop.removeKey(info.times[t]);
            removed++;
          } catch(e) {}
        }
      } catch(e) {}
    }

    return _jsonStringify({ success: true, removed: removed, remaining: _undoStack.length });
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
