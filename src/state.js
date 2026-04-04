/**
 * Shared plugin state — simple pub/sub store.
 * Import { getState, setState, subscribe } wherever needed.
 *
 * ⚠️  DEPRECATED — This file is part of the unused ES modules version.
 *     The active implementation is src/plugin.js. See main.js for details.
 */

const _state = {
  // Detection status
  // 'idle' | 'no-project' | 'no-sequence' | 'no-clip' |
  // 'no-keyframes' | 'outside' | 'valid' | 'error' | 'baking' | 'done'
  status: 'idle',

  // Populated when a clip with qualifying params is selected
  availableParams: [],   // [{ key: string, displayName: string, paramLabel: string }]
  selectedParamKey: null, // key matching an entry in availableParams

  // Full detection result — set when status === 'valid'
  context: null,

  // Error / hint message — set by detection
  errorMessage: '',
  hint: '',

  // Is a bake operation running right now?
  isBaking: false,

  // Bezier curve control points. X is clamped [0,1], Y is free for overshoot.
  curve: { p1x: 0.42, p1y: 0.0, p2x: 0.58, p2y: 1.0 },
};

const _listeners = new Set();

export function getState() {
  return { ..._state, curve: { ..._state.curve } };
}

export function setState(updates) {
  Object.assign(_state, updates);
  if (updates.curve) {
    Object.assign(_state.curve, updates.curve);
  }
  _notify();
}

export function subscribe(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

function _notify() {
  const snapshot = getState();
  for (const fn of _listeners) {
    try { fn(snapshot); } catch (e) { /* don't let one listener crash others */ }
  }
}
