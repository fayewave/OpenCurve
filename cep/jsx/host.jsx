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

// ── Track structure cache ──
// Walking every track and reading start/end on every clip is what made the
// "nothing changed" poll cost ~15-30ms of ExtendScript time. We now walk once,
// keep plain-JS ranges, and only re-walk on the heartbeat, on sequence change,
// when the track count changes, or when a cached clip reference goes stale.
var _ocTracks      = null;  // [{ trackIdx, items: [{ clip, clipIdx, start, end, inPoint, name }] }], top track first
var _ocTracksSeq   = null;
var _ocTracksCount = -1;

// ── Property cache ──
// Keyframe lists and sampled values for the winning clip from the last full
// scan. A playhead move inside the same clip (same clips + selection) rebuilds
// brackets from these plain arrays instead of re-walking components and
// properties, which was the ~80ms part of a scan. Refreshed after
// _OC_PARAM_CACHE_MS, on any track re-walk, and dropped after bake/undo.
var _ocParamCache = null;  // { key, at, trackIdx, clipIdx, entries: [{ compIdx, propIdx, prop, displayName, kfTimes, isCompound, vals }] }
var _OC_PARAM_CACHE_MS = 1800;

function _ocCachedVal(e, t) {
  var k = String(t);
  if (e.vals.hasOwnProperty(k)) return e.vals[k];
  var v;
  try { v = e.prop.getValueAtKey(t); } catch(err) { return undefined; }
  if (e.isCompound) {
    if (!v || v.length !== 2) return undefined;
    v = [v[0], v[1]];
  } else if (typeof v !== 'number') {
    return undefined;
  }
  e.vals[k] = v;
  return v;
}

// Returns the qualified-param list for the cached clip at playhead `ph`, or
// null if the cached clip isn't under the playhead any more / a value read failed.
function _ocParamsFromCache(cache, clips, ph, fps) {
  var info = null;
  for (var i = 0; i < clips.length; i++) {
    if (clips[i].trackIdx === cache.trackIdx && clips[i].clipIdx === cache.clipIdx) { info = clips[i]; break; }
  }
  if (!info) return null;
  var phLocal = (ph - info.clipStart) + info.clipInPoint;
  var out = [];
  for (var ei = 0; ei < cache.entries.length; ei++) {
    var e = cache.entries[ei];
    var kfTimes = e.kfTimes;
    var kf0Time = null, kf1Time = null;
    for (var k = 0; k < kfTimes.length; k++) {
      var kt = kfTimes[k];
      if (kt <= phLocal) kf0Time = kt;
      else if (kf1Time === null) kf1Time = kt;
    }
    var isOutside = false;
    if (kf0Time === null || kf1Time === null) {
      kf0Time = kfTimes[0]; kf1Time = kfTimes[kfTimes.length - 1]; isOutside = true;
    }
    var val0 = _ocCachedVal(e, kf0Time);
    var val1 = _ocCachedVal(e, kf1Time);
    if (val0 === undefined || val1 === undefined) return null;
    out.push({
      key: e.compIdx + '_' + e.propIdx,
      displayName: e.displayName,
      trackIdx: info.trackIdx,
      clipIdx: info.clipIdx,
      compIdx: e.compIdx,
      propIdx: e.propIdx,
      kf0Time: kf0Time,
      kf1Time: kf1Time,
      val0: val0,
      val1: val1,
      frameCount: Math.round((kf1Time - kf0Time) * fps),
      isOutside: isOutside,
      isCompound: e.isCompound,
      fps: fps,
      totalKf: kfTimes.length,
      seqOffset: info.clipStart - info.clipInPoint,
      clipStart: info.clipStart,
      clipEnd: info.clipEnd,
      clipInPoint: info.clipInPoint,
      clipName: info.clipName || '',
      nodeId: info.nodeId || '',
      kfSecs: kfTimes,
    });
  }
  return out;
}

function _ocWalkTracks(sequence, numTracks, seqId) {
  var out = [];
  for (var t = numTracks - 1; t >= 0; t--) {
    var track = sequence.videoTracks[t];
    var clips = track.clips;
    var items = [];
    for (var c = 0; c < clips.numItems; c++) {
      var clip = clips[c];
      var nm = ''; try { nm = clip.name; } catch(e) {}
      var nid = ''; try { nid = String(clip.nodeId || ''); } catch(e) {}
      items.push({
        clip: clip, clipIdx: c,
        start: clip.start.seconds, end: clip.end.seconds,
        inPoint: clip.inPoint ? clip.inPoint.seconds : 0,
        name: nm,
        nodeId: nid,
      });
    }
    out.push({ trackIdx: t, items: items });
  }
  _ocTracks = out; _ocTracksSeq = seqId; _ocTracksCount = numTracks;
}

// Clips under the playhead from the cache. Touches ExtendScript only for the
// (usually 1-3) clips actually at the playhead: one start check to catch a
// moved/deleted clip, one isSelected(). Returns null if anything looks stale
// so the caller can re-walk.
function _ocClipsAt(ph) {
  if (!_ocTracks) return null;
  var found = [];
  for (var ti = 0; ti < _ocTracks.length; ti++) {
    var items = _ocTracks[ti].items;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (ph < it.start || ph > it.end) continue;
      var liveStart;
      try { liveStart = it.clip.start.seconds; } catch(e) { return null; }
      if (Math.abs(liveStart - it.start) > 0.0005) return null;
      var isSel = false;
      try { isSel = it.clip.isSelected(); } catch(e) { return null; }
      found.push({
        trackIdx: _ocTracks[ti].trackIdx, clipIdx: it.clipIdx, clip: it.clip,
        clipStart: it.start, clipEnd: it.end, clipInPoint: it.inPoint, clipName: it.name, nodeId: it.nodeId || '', isSel: isSel,
      });
    }
  }
  return found;
}

// Debug stamps: which path produced this result and host-side ms. Read by the
// panel's Poll Timing (Debug) log so Premiere main-thread stalls can be told
// apart from plugin work.
var _ocScanKind = 'walk';
var _ocScanT0   = 0;
function _ocReturn(jsonStr) {
  var ms = _ocScanT0 ? (new Date().getTime() - _ocScanT0) : 0;
  jsonStr = jsonStr.substring(0, jsonStr.length - 1) + ',"scanKind":"' + _ocScanKind + '","scanMs":' + ms + '}';
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
  _ocScanT0 = new Date().getTime();
  _ocScanKind = 'walk';
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

    // Find clips at playhead across all video tracks (from the structure cache;
    // see _ocWalkTracks). Selected clip goes first so user can override which
    // clip is targeted.
    var seqId = '';
    try { seqId = String(sequence.sequenceID || sequence.name || ''); } catch(e) {}
    var numTracks = sequence.videoTracks.numTracks;
    if (!_ocTracks || _ocTracksSeq !== seqId || _ocTracksCount !== numTracks || _ocPollCount >= _OC_HEARTBEAT) {
      _ocWalkTracks(sequence, numTracks, seqId);
      _ocParamCache = null;
    }
    var found = _ocClipsAt(ph);
    if (found === null) {                 // a cached clip moved or vanished: rebuild once
      _ocWalkTracks(sequence, numTracks, seqId);
      found = _ocClipsAt(ph) || [];
    }
    var selectedClips = [];
    var otherClips = [];
    for (var fi = 0; fi < found.length; fi++) {
      if (found[fi].isSel) selectedClips.push(found[fi]); else otherClips.push(found[fi]);
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
      var _cn = _ce.clipName || '';
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

    // Fast path: same clips + selection as the last full scan and the property
    // cache is fresh, so only the playhead moved. Rebuild the brackets from the
    // cached keyframe times instead of walking components (see _ocParamCache).
    var clipsKey = _sig.substring(_sig.indexOf('|') + 1);
    var nowMs = new Date().getTime();
    if (_ocParamCache && _ocParamCache.key === clipsKey && (nowMs - _ocParamCache.at) < _OC_PARAM_CACHE_MS) {
      bestParams = _ocParamsFromCache(_ocParamCache, allClipResults, ph, fps);
      if (bestParams !== null && bestParams.length > 0) _ocScanKind = 'fast';
      if (bestParams !== null && bestParams.length === 0) bestParams = null;
    }
    if (bestParams === null) _ocParamCache = null;

    for (var ci = 0; bestParams === null && ci < allClipResults.length; ci++) {
      var clipInfo = allClipResults[ci];
      var clip = clipInfo.clip;
      var phLocal = (ph - clipInfo.clipStart) + clipInfo.clipInPoint;
      var components = clip.components;
      var qualifiedParams = [];
      var cacheEntries = [];

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
          var kfSecs = [];
          for (var kk = 0; kk < kfTimes.length; kk++) kfSecs.push(kfTimes[kk].seconds);
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
            seqOffset: clipInfo.clipStart - clipInfo.clipInPoint,
            clipStart: clipInfo.clipStart,
            clipEnd: clipInfo.clipEnd,
            clipInPoint: clipInfo.clipInPoint,
            clipName: clipInfo.clipName || '',
            nodeId: clipInfo.nodeId || '',
            kfSecs: kfSecs,
          });

          // Remember this property for the fast path
          var vals = {};
          vals[String(kf0Time)] = serVal0;
          vals[String(kf1Time)] = serVal1;
          cacheEntries.push({ compIdx: compIdx, propIdx: propIdx, prop: prop, displayName: displayName,
                              kfTimes: kfSecs, isCompound: isCompound, vals: vals });
        }
      }

      if (qualifiedParams.length > 0) {
        bestParams = qualifiedParams;
        _ocParamCache = { key: clipsKey, at: nowMs, trackIdx: clipInfo.trackIdx, clipIdx: clipInfo.clipIdx, entries: cacheEntries };
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
      // Bake records for this property (same clip, component and property as
      // when we baked). A 2+ frame pair inside a record's range means that
      // bake was undone outside the panel (Ctrl+Z), so the record is dropped.
      var bakeIds = [];
      var bakeCurve = null;
      var tlSpans = []; // every live record on this property, for the mini timeline
      for (var _bi = 0; _bi < _undoStack.length; _bi++) {
        var _bb = _undoStack[_bi];
        for (var _bj = _bb.length - 1; _bj >= 0; _bj--) {
          var _inf = _bb[_bj];
          if (_inf.compIdx !== p.compIdx || _inf.propIdx !== p.propIdx) continue;
          // Restored records carry their sequence id; never match another sequence's clips
          if (_inf.seqId && seqId && _inf.seqId !== seqId) continue;
          // Same clip? nodeId is stable when the clip is moved; fall back to name + start
          if (_inf.nodeId && p.nodeId) {
            if (_inf.nodeId !== p.nodeId) continue;
          } else if (_inf.clipName !== (p.clipName || '') || Math.abs(_inf.clipStart - p.clipStart) > 0.0005) {
            continue;
          }
          // Same property? Component indices shift when effects are added/removed
          if (_inf.displayName && p.displayName && _inf.displayName !== p.displayName) continue;
          // Record only counts while the bake's fingerprint is still on the
          // property: both original keyframes and at least half of ours. A pair
          // inside the span wider than the bake's keyframe spacing means the
          // bake was undone outside the panel (one of ours would be narrower).
          var _alive = (p.kfSecs && p.kfSecs.length) ? _ocBakeAlive(_inf, p.kfSecs) : true;
          if (!_alive || (!p.isOutside && p.frameCount > (_inf.step || 1) && p.kf0Time >= _inf.kf0Time - 0.0001 && p.kf1Time <= _inf.kf1Time + 0.0001)) {
            _bb.splice(_bj, 1);
            continue;
          }
          tlSpans.push([_r4(_inf.kf0Time + p.seqOffset), _r4(_inf.kf1Time + p.seqOffset)]);
          // The record stays, but it only colours the row (and feeds its undo button)
          // while the playhead's bracket sits inside the span it baked; elsewhere on
          // the clip the row is a normal row and another area can be baked.
          if (p.isOutside || p.kf0Time < _inf.kf0Time - 0.0001 || p.kf1Time > _inf.kf1Time + 0.0001) continue;
          bakeIds.push(_inf.id);
          if (!bakeCurve && _inf.curve) bakeCurve = _inf.curve;
        }
      }
      var _jp = (p.kfSecs && p.kfSecs.length) ? _ocJumpPair(p.kfSecs, ph - p.seqOffset, p.fps) : null;
      var _entry = { key: p.key, displayName: p.displayName, jumpSec: (_jp ? _jp.start : p.kf0Time) + p.seqOffset, bakeIds: bakeIds };
      // Mini timeline lane: keyframes and the bracket in sequence seconds (rounded to keep the JSON small)
      _entry.tlKf = [];
      for (var _tk = 0; _tk < (p.kfSecs || []).length; _tk++) _entry.tlKf.push(_r4(p.kfSecs[_tk] + p.seqOffset));
      _entry.tlKf0 = _r4(p.kf0Time + p.seqOffset);
      _entry.tlKf1 = _r4(p.kf1Time + p.seqOffset);
      _entry.tlOut = !!p.isOutside;
      _entry.tlSpans = tlSpans;
      if (bakeCurve) _entry.bakeCurve = bakeCurve;
      // Nearest 2+ frame pair, for the status strip's click-to-jump
      var _near = (p.kfSecs && p.kfSecs.length) ? _ocNearestPair(p.kfSecs, ph - p.seqOffset, p.fps) : null;
      if (_near) { _entry.nearSec = _near.start + p.seqOffset; _entry.nearDist = _near.dist; }
      paramList.push(_entry);

      // A pair inside a live bake record is that bake's own keyframes (they can be
      // 2+ frames apart with a wider spacing), so it isn't bakeable again
      if (!p.isOutside && p.frameCount >= 2 && bakeIds.length === 0) {
        validParamKeys.push(p.key);
        paramContexts[p.key] = {
          trackIdx: p.trackIdx,
          clipIdx: p.clipIdx,
          compIdx: p.compIdx,
          propIdx: p.propIdx,
          clipStart: p.clipStart,
          clipName: p.clipName,
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

    // Mini timeline: the clip's extent and the playhead, in sequence seconds
    var _tl = { clipStart: bestParams[0].clipStart, clipEnd: bestParams[0].clipEnd, clipIn: bestParams[0].clipInPoint, fps: fps, ph: ph };

    if (validParamKeys.length === 0) {
      // Two cases: the playhead is outside every pair (say where they are, using
      // a property with a real 2+ frame range so a baked property's one-frame
      // pairs don't produce a useless "302.35s - 302.36s"), or it's inside pairs
      // that are all one frame apart, i.e. already baked.
      var anyInside = false, hintP = null;
      for (var hi = 0; hi < bestParams.length; hi++) {
        if (!bestParams[hi].isOutside) anyInside = true;
        if (hintP === null && bestParams[hi].frameCount >= 2) hintP = bestParams[hi];
      }
      if (hintP === null) hintP = bestParams[0];
      var outHint = anyInside
        ? 'Already baked here. Move the playhead to an unbaked keyframe pair'
        : 'Move playhead between keyframes (' + hintP.kf0Time.toFixed(2) + 's \u2013 ' + hintP.kf1Time.toFixed(2) + 's)';
      return _ocReturn(_jsonStringify({
        status: 'outside',
        availableParams: paramList,
        validParamKeys: [],
        clipName: bestParams[0].clipName || '',
        tl: _tl,
        hint: outHint,
        ph: ph,
      }));
    }

    var firstCtx = paramContexts[validParamKeys[0]];
    var hintFrames = firstCtx ? firstCtx.frameCount + ' frames' : '';

    return _ocReturn(_jsonStringify({
      status: 'valid',
      availableParams: paramList,
      validParamKeys: validParamKeys,
      clipName: bestParams[0].clipName || '',
      tl: _tl,
      paramContexts: paramContexts,
      hint: hintFrames,
      ph: ph,
    }));

  } catch(err) {
    _ocCacheKey = null; _ocTracks = null; _ocParamCache = null; // don't let a transient error poison the caches
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
    // Keyframe spacing from the panel's Settings (1, 2 or 4 frames)
    var stepReq = Math.max(1, parseInt(args.step, 10) || 1);
    var bSeqId = '';

    var project = app.project;
    var sequence = project.activeSequence;
    var totalActions = 0;
    var firstErr = null;

    var undoInfo = [];

    // Premiere's ExtendScript `app` has no beginUndoGroup/endUndoGroup (that's
    // an After Effects API), so only use it if present. Undo is handled by the
    // panel's own undo button (_undoStack) regardless. The real apply speed-up
    // comes from passing updateUI=false on intermediate keys (see below).
    // Refuse to bake if any target clip is no longer where the scan saw it
    // (track/clip indices drift when clips are added, removed or moved).
    for (var vi = 0; vi < paramRefs.length; vi++) {
      var vref = paramRefs[vi];
      if (typeof vref.clipStart !== 'number') continue;
      var okClip = false;
      try {
        var vclip = sequence.videoTracks[vref.trackIdx].clips[vref.clipIdx];
        okClip = Math.abs(vclip.start.seconds - vref.clipStart) < 0.001
              && (!vref.clipName || vclip.name === vref.clipName);
      } catch(e) {}
      if (!okClip) {
        _ocCacheKey = null; _ocTracks = null; _ocParamCache = null;
        return _jsonStringify({ success: false, error: 'Clip changed since the last scan. Try again.' });
      }
    }

    try { bSeqId = String(sequence.sequenceID || sequence.name || ''); } catch(e) {}
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

        // Short pairs are always written densely enough to get at least two keyframes
        var step = Math.max(1, Math.min(stepReq, Math.floor((totalFrames - 1) / 2)));
        var addedTimes = [];

        for (var f = step; f < totalFrames; f += step) {
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
          var doUpdate = (f + step >= totalFrames);

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
        var bNodeId = '';    try { bNodeId = String(clip.nodeId || ''); } catch(e) {}

        undoInfo.push({
          id: ++_ocBakeSeq,          // referenced by the panel's per-row undo button
          kf0Time: ref.kf0Time,      // range the bake filled, for spotting an external undo
          kf1Time: ref.kf1Time,
          trackIdx: ref.trackIdx,
          clipIdx: ref.clipIdx,
          compIdx: ref.compIdx,
          propIdx: ref.propIdx,
          clipName: bClipName,
          clipStart: bClipStart,
          matchName: bMatchName,
          nodeId: bNodeId,
          displayName: label,
          times: addedTimes,
          step: step,                // keyframe spacing used, so a wider pair inside the span means an outside undo
          curve: curve,              // for the row's "load baked curve" button
          seqId: bSeqId,             // records are restored across sessions; never match another sequence's clips
        });
      }
    } finally {
      if (_hasUndoGroup) app.endUndoGroup();
    }

    // Detection caches by playhead+clip identity; the clip's keyframes just
    // changed, so force a fresh scan on the next poll.
    _ocCacheKey = null; _ocParamCache = null;

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

var _undoStack = [];   // batches (one per Go press) of bake records; see bakeKeyframes' undoInfo
var _ocBakeSeq = 0;    // record id counter
var _ocSessionFloor = 0; // batches below this index were restored from a previous session:
                         // they colour rows and feed the row undo, but not the panel-wide Undo button
var _OC_RECORDS_MAX = 300;

// Records as JSON for the panel to keep in localStorage (see cep-bridge.js).
// Newest batches are kept; the live ExtendScript objects are plain data already.
function exportBakeRecords() {
  try {
    _ocPruneBatches();
    var out = [], n = 0;
    for (var bi = _undoStack.length - 1; bi >= 0 && n < _OC_RECORDS_MAX; bi--) {
      out.unshift(_undoStack[bi]); n += _undoStack[bi].length;
    }
    return _jsonStringify(out);
  } catch(e) { return '[]'; }
}
// Restore records saved by exportBakeRecords (called once when the panel opens)
function importBakeRecords(json) {
  try {
    var arr = _jsonParse(json);
    if (!(arr instanceof Array)) return '0';
    var batches = [], count = 0;
    for (var i = 0; i < arr.length; i++) {
      var b = arr[i];
      if (!(b instanceof Array)) continue;
      var clean = [];
      for (var j = 0; j < b.length; j++) {
        var r = b[j];
        if (!r || typeof r.id !== 'number' || !(r.times instanceof Array)) continue;
        clean.push(r); count++;
        if (r.id > _ocBakeSeq) _ocBakeSeq = r.id;
      }
      if (clean.length) batches.push(clean);
    }
    _undoStack = batches.concat(_undoStack);
    _ocSessionFloor = batches.length;
    return String(count);
  } catch(e) { return '0'; }
}

// Remove the keyframes one bake record added, after checking the indices still
// point at the clip/component we baked into (the timeline may have changed).
function _ocUndoInfo(sequence, info) {
  var removed = 0;
  try {
    var clip = null;
    if (info.nodeId) {
      // The clip may have been moved since the bake: find it by its stable id
      clip = _ocClipByNodeId(sequence, info.nodeId);
    }
    if (!clip) {
      clip = sequence.videoTracks[info.trackIdx].clips[info.clipIdx];
      // Verify the indices still resolve to the SAME clip we baked into. If the
      // timeline changed (clip moved/reordered) skip rather than deleting
      // keyframes off whatever clip now sits at those indices.
      var curName = '';  try { curName = clip.name; } catch(e) {}
      var curStart = 0;  try { curStart = clip.start.seconds; } catch(e) {}
      var okName  = (!info.clipName)  || curName === info.clipName;
      var okStart = (info.clipStart === undefined) || Math.abs(curStart - info.clipStart) < 0.0005;
      if (!okName || !okStart) return { removed: 0, skipped: 1 };
    }
    var comp = clip.components[info.compIdx];
    var prop = comp.properties[info.propIdx];
    // Same component (effects may have been added or removed)?
    var curMatch = ''; try { curMatch = comp.matchName; } catch(e) {}
    if (info.matchName && curMatch !== info.matchName) return { removed: 0, skipped: 1 };
    // Same property name, and the bake's fingerprint must still be there;
    // otherwise leave the property alone (it was undone or edited already).
    if (info.displayName) {
      var curPName = _paramName(curMatch, info.propIdx);
      if (curPName !== info.displayName) return { removed: 0, skipped: 1 };
    }
    var liveSecs = [];
    try {
      var liveKeys = prop.getKeys();
      for (var lk = 0; liveKeys && lk < liveKeys.length; lk++) liveSecs.push(liveKeys[lk].seconds);
    } catch(e) { liveKeys = null; }
    if (liveKeys && !_ocBakeAlive(info, liveSecs)) return { removed: 0, skipped: 0 };

    for (var t = 0; t < info.times.length; t++) {
      try {
        prop.removeKey(info.times[t]);
        removed++;
      } catch(e) {}
    }
  } catch(e) { return { removed: removed, skipped: 1 }; }
  return { removed: removed, skipped: 0 };
}

// Locate a clip anywhere in the sequence by its stable nodeId (cached
// structure first, then a live walk in case the cache is behind).
function _ocClipByNodeId(sequence, nodeId) {
  if (_ocTracks) {
    for (var ti = 0; ti < _ocTracks.length; ti++) {
      var items = _ocTracks[ti].items;
      for (var i = 0; i < items.length; i++) {
        if (items[i].nodeId === nodeId) {
          try { if (String(items[i].clip.nodeId || '') === nodeId) return items[i].clip; } catch(e) {}
        }
      }
    }
  }
  try {
    var n = sequence.videoTracks.numTracks;
    for (var t = 0; t < n; t++) {
      var clips = sequence.videoTracks[t].clips;
      for (var c = 0; c < clips.numItems; c++) {
        try { if (String(clips[c].nodeId || '') === nodeId) return clips[c]; } catch(e) {}
      }
    }
  } catch(e) {}
  return null;
}

// Start of the keyframe pair with a real (2+ frame) span nearest the playhead,
// and the playhead's distance from it. Media seconds in and out.
// Pin button target (mirror of _jumpPair in plugin.js): nearest 2+ frame pair when
// outside every pair, otherwise the pair after the one the playhead is in, wrapping
function _ocJumpPair(kfSecs, phLocal, fps) {
  var pairs = [];
  for (var i = 0; i + 1 < kfSecs.length; i++) {
    if ((kfSecs[i + 1] - kfSecs[i]) * fps >= 1.5) pairs.push({ start: kfSecs[i], end: kfSecs[i + 1] });
  }
  if (!pairs.length) return null;
  for (var j = 0; j < pairs.length; j++) {
    if (phLocal >= pairs[j].start - 0.0001 && phLocal < pairs[j].end - 0.0001) return pairs[(j + 1) % pairs.length];
  }
  return _ocNearestPair(kfSecs, phLocal, fps);
}

function _ocNearestPair(kfSecs, phLocal, fps) {
  var best = null;
  for (var i = 0; i + 1 < kfSecs.length; i++) {
    var a = kfSecs[i], b = kfSecs[i + 1];
    if ((b - a) * fps < 1.5) continue; // one-frame pair (already baked)
    var d = phLocal < a ? a - phLocal : (phLocal > b ? phLocal - b : 0);
    if (best === null || d < best.dist) best = { start: a, dist: d };
  }
  return best;
}

function _r4(v) { return Math.round(v * 10000) / 10000; }

function _ocHasTime(kfSecs, t) {
  for (var i = 0; i < kfSecs.length; i++) if (Math.abs(kfSecs[i] - t) < 0.0001) return true;
  return false;
}
// Is this bake still on the property? Both original keyframes must be there
// plus at least half of the ones we wrote.
function _ocBakeAlive(info, kfSecs) {
  if (typeof info.kf0Time === 'number' && !_ocHasTime(kfSecs, info.kf0Time)) return false;
  if (typeof info.kf1Time === 'number' && !_ocHasTime(kfSecs, info.kf1Time)) return false;
  var n = 0;
  for (var i = 0; i < info.times.length; i++) if (_ocHasTime(kfSecs, info.times[i])) n++;
  return n > 0 && n * 2 >= info.times.length;
}

function _ocFindBake(id) {
  for (var bi = 0; bi < _undoStack.length; bi++) {
    for (var bj = 0; bj < _undoStack[bi].length; bj++) {
      if (_undoStack[bi][bj].id === id) return { batch: _undoStack[bi], index: bj };
    }
  }
  return null;
}

function _ocPruneBatches() {
  for (var bi = _undoStack.length - 1; bi >= 0; bi--) {
    if (_undoStack[bi].length === 0) {
      _undoStack.splice(bi, 1);
      if (bi < _ocSessionFloor) _ocSessionFloor--;
    }
  }
}
// Batches made this session (what the panel-wide Undo button can revert)
function _ocSessionBatches() {
  return Math.max(0, _undoStack.length - _ocSessionFloor);
}

// Per-row undo: remove the keyframes added by the given bake records
// (comma-separated ids from detectContext's bakeIds).
function undoBakeParam(idsStr) {
  try {
    var ids = String(idsStr).split(',');
    var sequence = app.project.activeSequence;
    var removed = 0, skipped = 0, found = 0;

    var _hasUndoGroup = (typeof app.beginUndoGroup === 'function' && typeof app.endUndoGroup === 'function');
    if (_hasUndoGroup) app.beginUndoGroup('OpenCurve undo bake');
    try {
      for (var i = 0; i < ids.length; i++) {
        var loc = _ocFindBake(parseInt(ids[i], 10));
        if (!loc) continue;
        found++;
        var r = _ocUndoInfo(sequence, loc.batch[loc.index]);
        removed += r.removed; skipped += r.skipped;
        // Keep the record if the clip moved, so the user can reselect and retry
        if (r.skipped === 0) loc.batch.splice(loc.index, 1);
      }
    } finally {
      if (_hasUndoGroup) app.endUndoGroup();
    }
    _ocPruneBatches();

    // The clip's keyframes changed: force a fresh detection scan next poll.
    _ocCacheKey = null; _ocParamCache = null;

    if (found === 0) {
      return _jsonStringify({ success: false, error: 'Nothing to undo on this property', remaining: _ocSessionBatches() });
    }
    if (removed === 0) {
      var why = skipped > 0
        ? 'Could not undo \u2014 the clip may have moved or changed. Select it and try again.'
        : 'Nothing to undo: those keyframes are already gone';
      return _jsonStringify({ success: false, error: why, remaining: _ocSessionBatches() });
    }
    return _jsonStringify({ success: true, removed: removed, skipped: skipped, remaining: _ocSessionBatches() });
  } catch(err) {
    return _jsonStringify({ success: false, error: err.message || String(err) });
  }
}

// Move the playhead to `sec` (sequence seconds). Called from the panel's pin buttons.
function jumpPlayhead(sec) {
  try {
    var sequence = app.project.activeSequence;
    if (!sequence) return 'false';
    var TICKS_PER_SECOND = 254016000000;
    // +254 ticks (1us) keeps the playhead at or after the keyframe despite rounding
    var ticks = Math.round(Math.max(0, parseFloat(sec)) * TICKS_PER_SECOND) + 254;
    sequence.setPlayerPosition(String(ticks));
    return 'true';
  } catch(e) {
    return 'false';
  }
}

function undoBake() {
  try {
    _ocPruneBatches(); // batches emptied by per-row undos
    if (_ocSessionBatches() === 0) {
      // Records restored from a previous session are undone from their row buttons
      return _jsonStringify({ success: false, error: 'Nothing to undo from this session' });
    }

    var batch = _undoStack.pop();
    var sequence = app.project.activeSequence;
    var removed = 0;
    var skipped = 0;

    var _hasUndoGroup = (typeof app.beginUndoGroup === 'function' && typeof app.endUndoGroup === 'function');
    if (_hasUndoGroup) app.beginUndoGroup('OpenCurve undo bake');
    try {
      for (var i = 0; i < batch.length; i++) {
        var r = _ocUndoInfo(sequence, batch[i]);
        removed += r.removed; skipped += r.skipped;
      }
    } finally {
      if (_hasUndoGroup) app.endUndoGroup();
    }

    // The clip's keyframes changed — force a fresh detection scan next poll.
    _ocCacheKey = null; _ocParamCache = null;

    if (removed === 0) {
      // Removed nothing — most likely the clip moved/changed since baking.
      // Put the batch back so the user can retry after reselecting the clip.
      _undoStack.push(batch);
      return _jsonStringify({ success: false, error: 'Could not undo — the original clip may have moved or changed. Select it and try again.', remaining: _ocSessionBatches() });
    }

    return _jsonStringify({ success: true, removed: removed, skipped: skipped, remaining: _ocSessionBatches() });
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
  if (curve.pts && curve.pts.length) return _ocSampleMulti(cx, curve);
  var t = _tForX(cx, curve.p1x, curve.p2x);
  return _by(t, curve.p1y, curve.p2y);
}

// Multi-point curves (mirror of _sampleMulti in plugin-ui.js): curve.pts are the
// interior anchors {x, y, ix, iy, ox, oy}; p1 is the handle out of (0,0), p2 the
// handle into (1,1). ES3-safe: no Array extras.
function _ocCub(t, a, b, c, d) {
  var mt = 1 - t;
  return mt*mt*mt*a + 3*mt*mt*t*b + 3*mt*t*t*c + t*t*t*d;
}
function _ocCubd(t, a, b, c, d) {
  var mt = 1 - t;
  return 3*mt*mt*(b - a) + 6*mt*t*(c - b) + 3*t*t*(d - c);
}
function _ocSampleMulti(x, c) {
  var pts = c.pts, px = 0, py = 0, hx = c.p1x, hy = c.p1y, s = null;
  for (var i = 0; i <= pts.length; i++) {
    var last = (i === pts.length);
    var ex = last ? 1 : pts[i].x, ey = last ? 1 : pts[i].y;
    var c2x = last ? c.p2x : pts[i].ix, c2y = last ? c.p2y : pts[i].iy;
    s = { x0: px, y0: py, c1x: hx, c1y: hy, c2x: c2x, c2y: c2y, x3: ex, y3: ey };
    if (last || x <= ex) break;
    px = ex; py = ey; hx = pts[i].ox; hy = pts[i].oy;
  }
  var span = s.x3 - s.x0;
  var t = span > 1e-9 ? (x - s.x0) / span : 0;
  for (var k = 0; k < 12; k++) {
    var err = _ocCub(t, s.x0, s.c1x, s.c2x, s.x3) - x;
    if (Math.abs(err) < 1e-8) break;
    var d = _ocCubd(t, s.x0, s.c1x, s.c2x, s.x3);
    if (Math.abs(d) < 1e-8) break;
    t = Math.max(0, Math.min(1, t - err / d));
  }
  if (Math.abs(_ocCub(t, s.x0, s.c1x, s.c2x, s.x3) - x) > 1e-6) {
    var lo = 0, hi = 1;
    for (var j = 0; j < 24; j++) {
      var mid = (lo + hi) / 2;
      if (_ocCub(mid, s.x0, s.c1x, s.c2x, s.x3) < x) lo = mid; else hi = mid;
    }
    t = (lo + hi) / 2;
  }
  return _ocCub(t, s.y0, s.c1y, s.c2y, s.y3);
}
