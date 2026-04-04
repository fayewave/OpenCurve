/**
 * ppro-bridge.js  —  All Premiere Pro UXP API interactions.
 *
 * ⚠️  DEPRECATED — This file is part of the unused ES modules version.
 *     The active implementation is src/plugin.js. See main.js for details.
 *
 * Detection strategy:
 *   1. Get playhead position from active sequence.
 *   2. Iterate every video track to find a clip that spans the playhead.
 *      (Does NOT require the clip to be selected in the timeline.)
 *   3. Walk that clip's component chain, find every scalar param with exactly
 *      2 keyframes, populate the property dropdown.
 *   4. If the currently-selected param's two keyframes bracket the playhead →
 *      status is 'valid' and the Go button enables.
 *
 * Exports:  detectContext(selectedParamKey) → DetectResult
 *           bakeKeyframes(context, curve)   → void
 */

import { sampleBezierCurve } from './graph-editor.js';

const ppro = require('premierepro');

// ─── detectContext ─────────────────────────────────────────────────────────

export async function detectContext(selectedParamKey) {
  try {
    // ── Project ──
    const project = await ppro.Project.getActiveProject();
    if (!project) {
      _dbg('no project');
      return _r('no-project');
    }

    // ── Sequence ──
    const sequence = await project.getActiveSequence();
    if (!sequence) {
      _dbg('no sequence');
      return _r('no-sequence');
    }

    // ── Playhead ──
    const playerPos = await sequence.getPlayerPosition();
    const ph = playerPos.seconds;
    _dbg('playhead seconds:', ph);

    // ── Find clip at playhead by iterating video tracks ──
    const found = await _clipAtPlayhead(sequence, ph);
    if (!found) {
      _dbg('no clip found at playhead');
      return _r('no-clip', [], null, 'No video clip found at the current playhead position');
    }

    const { clip, chain } = found;
    _dbg('found clip, walking component chain');

    // ── Walk component chain for scalar params with exactly 2 KFs ──
    const qualifiedParams = await _findQualifiedParams(chain);
    _dbg('qualified params:', qualifiedParams.map(p => p.displayName));

    if (qualifiedParams.length === 0) {
      return _r('no-keyframes', [],  null,
        'No scalar property on this clip has exactly 2 keyframes. ' +
        'Set the stopwatch on a property (Opacity, Scale, Rotation) ' +
        'and add exactly 2 keyframes.');
    }

    // ── Resolve which param is the active selection ──
    let sel = qualifiedParams.find(p => p.key === selectedParamKey)
           ?? qualifiedParams[0];

    const { param, kf0, kf1 } = sel;

    // ── Check playhead is strictly between the two KFs ──
    if (ph <= kf0.seconds || ph >= kf1.seconds) {
      return _r('outside', qualifiedParams.map(_info), sel.key,
        `Move the playhead between the two keyframes on "${sel.displayName}"`);
    }

    // ── Read values ──
    const val0 = await _scalarValue(param, kf0);
    const val1 = await _scalarValue(param, kf1);
    _dbg(`${sel.displayName}: val0=${val0} val1=${val1}`);

    // ── FPS ──
    const fps = await _fps(sequence);
    _dbg('fps:', fps);

    return {
      status:          'valid',
      availableParams: qualifiedParams.map(_info),
      selectedKey:     sel.key,
      hint:            `${sel.displayName} · ${Math.round((kf1.seconds - kf0.seconds) * fps)} frames`,
      project, sequence, clip, param, kf0, kf1, val0, val1, fps,
    };

  } catch (err) {
    console.error('[FayeSmoothify] detectContext threw:', err);
    return _r('error', [], null, err && err.message ? err.message : String(err));
  }
}

// ─── bakeKeyframes ─────────────────────────────────────────────────────────

export async function bakeKeyframes(context, curve) {
  if (!context || !context.project || !context.param || !context.kf0 || !context.kf1
      || typeof context.val0 === 'undefined' || typeof context.val1 === 'undefined' || !context.fps) {
    throw new Error('Invalid bake context — missing required fields.');
  }

  const { project, param, kf0, kf1, val0, val1, fps } = context;

  const startSec    = kf0.seconds;
  const endSec      = kf1.seconds;
  const totalFrames = Math.round((endSec - startSec) * fps);

  if (totalFrames < 2) {
    _dbg('Keyframes are less than 2 frames apart — skipping (already baked or too close).');
    return;
  }

  _dbg(`baking ${totalFrames - 1} keyframes at ${fps} fps`);

  // Build intermediate frames (excluding kf0 and kf1 which stay as-is)
  const toInsert = [];
  for (let f = 1; f < totalFrames; f++) {
    const t     = f / totalFrames;
    const eased = sampleBezierCurve(t, curve);           // may overshoot
    const value = val0 + (val1 - val0) * eased;
    const time  = ppro.TickTime.createWithSeconds(startSec + f / fps);
    toInsert.push({ time, value });
  }

  // Single compound transaction → one Ctrl+Z undo
  await project.lockedAccess(async () => {
    await project.executeTransaction((compound) => {
      for (const { time, value } of toInsert) {
        compound.addAction(param.createSetValueAtTimeAction(time, value));
      }
    }, 'FayeSmoothify: bake keyframes');
  });

  _dbg('bake complete');
}

// ─── Find clip at playhead (track iteration) ──────────────────────────────

async function _clipAtPlayhead(sequence, ph) {
  // We try multiple API shapes because Premiere Pro UXP has changed between
  // versions and documentation is inconsistent.

  // ── Approach A: getVideoTrackGroup + getTrackItemsInteractingWithRange ──
  try {
    const vg = await sequence.getVideoTrackGroup();
    const phTime   = ppro.TickTime.createWithSeconds(ph);
    const numTracks = await _call(vg, 'getTrackCount');
    _dbg('video track count:', numTracks);

    for (let t = 0; t < numTracks; t++) {
      const track = await _call(vg, 'getTrackAt', t);
      if (!track) continue;

      // Try range-based query first (most precise)
      let items = null;
      try {
        items = await track.getTrackItemsInteractingWithRange(
          phTime, phTime,
          ppro.Constants.TrackItemType.CLIP,
          false
        );
      } catch (_) {}

      // Fallback: get all clips on the track and filter by time
      if (!items || items.length === 0) {
        try {
          const all = await _call(track, 'getTrackItems',
            ppro.Constants.TrackItemType.CLIP, false);
          items = (all || []).filter(item => {
            try {
              const s = item.startTime?.seconds ?? item.getStartTime?.()?.seconds ?? -1;
              const e = item.endTime?.seconds   ?? item.getEndTime?.()?.seconds   ?? -1;
              return ph >= s && ph <= e;
            } catch (_) { return false; }
          });
        } catch (_) {}
      }

      for (const item of (items || [])) {
        try {
          const chain = await item.getComponentChain();
          if (chain) {
            _dbg('found clip via track iteration, track index:', t);
            return { clip: item, chain };
          }
        } catch (_) {}
      }
    }
  } catch (e) {
    _dbg('track iteration approach failed:', e.message);
  }

  // ── Approach B: Fall back to selection ──
  try {
    const selection = await sequence.getSelection();
    const items     = await _call(selection, 'getTrackItems',
      ppro.Constants?.TrackItemType?.CLIP, false);

    for (const item of (items || [])) {
      try {
        const s = (await item.getStartTime()).seconds;
        const e = (await item.getEndTime()).seconds;
        if (ph >= s && ph <= e) {
          const chain = await item.getComponentChain();
          if (chain) {
            _dbg('found clip via selection fallback (track scan found nothing at playhead)');
            return { clip: item, chain };
          }
        }
      } catch (_) {}
    }
  } catch (e) {
    _dbg('selection fallback failed:', e.message);
  }

  return null;
}

// ─── Walk component chain ─────────────────────────────────────────────────

async function _findQualifiedParams(chain) {
  const qualified = [];

  let compCount = 0;
  try { compCount = await _call(chain, 'getComponentCount'); } catch (_) {}
  _dbg('component count:', compCount);

  for (let i = 0; i < compCount; i++) {
    let comp;
    try { comp = await _call(chain, 'getComponentAtIndex', i); } catch (_) { continue; }
    if (!comp) continue;

    let matchName = '';
    try { matchName = await _call(comp, 'getMatchName'); } catch (_) {}

    let displayName = '';
    try { displayName = await _call(comp, 'getDisplayName'); } catch (_) {}

    let paramCount = 0;
    try { paramCount = await _call(comp, 'getParamCount'); } catch (_) {}

    _dbg(`  comp[${i}] matchName="${matchName}" displayName="${displayName}" params=${paramCount}`);

    for (let j = 0; j < paramCount; j++) {
      let param;
      try { param = await _call(comp, 'getParam', j); } catch (_) { continue; }
      if (!param) continue;

      let paramName = '';
      try { paramName = await _call(param, 'getDisplayName'); } catch (_) {}

      // Get keyframe list
      let kfTimes = null;
      try { kfTimes = await _call(param, 'getKeyframeListAsTickTimes'); } catch (_) {}

      const kfCount = Array.isArray(kfTimes) ? kfTimes.length : 0;
      _dbg(`    param[${j}] name="${paramName}" keyframes=${kfCount}`);

      // We only want params with exactly 2 keyframes
      if (kfCount !== 2) continue;

      // Verify value is a scalar number (not PointF / array)
      let testVal;
      try { testVal = await _scalarValue(param, kfTimes[0]); } catch (_) { continue; }
      if (typeof testVal !== 'number') {
        _dbg(`    skipping "${paramName}" — value is not a scalar:`, testVal);
        continue;
      }

      qualified.push({
        key:          `${i}_${j}`,
        displayName:  paramName || `${displayName || 'Comp'} / Param ${j}`,
        compMatchName: matchName,
        param,
        kf0: kfTimes[0],
        kf1: kfTimes[1],
      });
    }
  }

  return qualified;
}

// ─── Utilities ────────────────────────────────────────────────────────────

/**
 * Call a method that may be sync or async, with an optional argument.
 * Handles the inconsistency in Premiere Pro UXP API versioning.
 */
async function _call(obj, method, ...args) {
  if (!obj || typeof obj[method] !== 'function') {
    throw new Error(`${method} is not a function on ${obj}`);
  }
  const result = obj[method](...args);
  // If it returned a Promise, await it
  if (result && typeof result.then === 'function') return await result;
  return result;
}

async function _scalarValue(param, tickTime) {
  const v = await _call(param, 'getValueAtTime', tickTime);
  return v;
}

async function _fps(sequence) {
  const TICKS_PER_SEC = 254016000000; // Premiere Pro's internal tick rate

  // Primary: sequence.getTimebase() returns ticks-per-frame as a string
  try {
    if (typeof sequence.getTimebase === 'function') {
      const tb = await sequence.getTimebase();
      const ticksPerFrame = parseInt(tb, 10);
      if (ticksPerFrame > 0) {
        const fps = TICKS_PER_SEC / ticksPerFrame;
        _dbg('fps from getTimebase:', fps, '(' + tb + ' ticks/frame)');
        return fps;
      }
    }
  } catch (_) {}

  // Fallback: getSettings().videoFrameRate (TickTime with .seconds)
  try {
    const settings = await sequence.getSettings();
    const fd = settings.videoFrameRate;
    if (fd && fd.seconds > 0) return 1 / fd.seconds;
    if (fd && fd.ticks > 0) return TICKS_PER_SEC / fd.ticks;
  } catch (_) {}

  _dbg('WARNING: Could not detect sequence frame rate — defaulting to 30 fps');
  return 30;
}

function _r(status, availableParams = [], selectedKey = null, hint = '') {
  return { status, availableParams, selectedKey, hint };
}

function _info(p) {
  return { key: p.key, displayName: p.displayName };
}

// Debug logging — open UDT DevTools console to see these
function _dbg(...args) {
  console.log('[FayeSmoothify]', ...args);
}
