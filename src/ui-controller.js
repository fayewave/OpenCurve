/**
 * ui-controller.js
 *
 * ⚠️  DEPRECATED — This file is part of the unused ES modules version.
 *     The active implementation is src/plugin.js. See main.js for details.
 *
 * Wires DOM elements to plugin state.
 * Called from main.js once the panel DOM is ready.
 *
 * Exports:
 *   init()  — set up all DOM bindings and subscribe to state changes
 */

import {
  getState, setState, subscribe,
} from './state.js';

import {
  init as initGraphEditor,
  drawGraph,
  resizeCanvas,
} from './graph-editor.js';

import { bakeKeyframes } from './ppro-bridge.js';

// ─── DOM refs ─────────────────────────────────────────────────────────────
let elPropertySelect;
let elStatusStrip;
let elStatusText;
let elDetectBtn;
let elGoBtn;
let elGoLabel;
let elGoArrow;
let elGoSpinner;
let elCanvas;
let elPresetBtns;

// ─── Preset curves ────────────────────────────────────────────────────────
const PRESETS = {
  'ease-in':  { p1x: 0.42, p1y: 0.00, p2x: 1.00, p2y: 1.00 },
  'ease-out': { p1x: 0.00, p1y: 0.00, p2x: 0.58, p2y: 1.00 },
  's-curve':  { p1x: 0.42, p1y: 0.00, p2x: 0.58, p2y: 1.00 },
  'linear':   { p1x: 0.00, p1y: 0.00, p2x: 1.00, p2y: 1.00 },
};

// ─── Init ──────────────────────────────────────────────────────────────────
export function init() {
  // Cache DOM refs
  elPropertySelect = document.getElementById('property-select');
  elStatusStrip    = document.getElementById('status-strip');
  elStatusText     = document.getElementById('status-text');
  elDetectBtn      = document.getElementById('detect-btn');
  elGoBtn          = document.getElementById('go-btn');
  elGoLabel        = document.getElementById('go-label');
  elGoArrow        = document.getElementById('go-arrow');
  elGoSpinner      = document.getElementById('go-spinner');
  elCanvas         = document.getElementById('bezier-canvas');
  elPresetBtns     = document.querySelectorAll('.preset-btn');

  // Initial canvas size
  resizeCanvas(elCanvas);
  drawGraph(elCanvas, getState().curve);

  // Resize observer (panel can be resized by user)
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      resizeCanvas(elCanvas);
      drawGraph(elCanvas, getState().curve);
    });
    ro.observe(elCanvas.parentElement);
  }

  // Graph editor interaction
  initGraphEditor(
    elCanvas,
    () => getState().curve,
    (partial) => {
      const cur = getState().curve;
      setState({ curve: { ...cur, ...partial } });
      drawGraph(elCanvas, getState().curve);
      _clearPresetActive();
    }
  );

  // Property dropdown change
  elPropertySelect.addEventListener('change', () => {
    setState({ selectedParamKey: elPropertySelect.value || null });
  });

  // Preset buttons
  elPresetBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = PRESETS[btn.dataset.preset];
      if (!preset) return;
      setState({ curve: { ...preset } });
      drawGraph(elCanvas, getState().curve);
      _setPresetActive(btn.dataset.preset);
    });
  });

  // Detect button — triggers an immediate re-poll
  elDetectBtn.addEventListener('click', () => {
    // main.js exposes a manual poll trigger on the window
    if (typeof window.__smoothifyPoll === 'function') {
      window.__smoothifyPoll();
    }
  });

  // Go button
  elGoBtn.addEventListener('click', _handleGo);

  // Subscribe to state changes → update UI
  subscribe(_onStateChange);

  // Apply initial state
  _onStateChange(getState());

  // Mark s-curve as active initially (default preset)
  _setPresetActive('s-curve');
}

// ─── State → UI binding ────────────────────────────────────────────────────
function _onStateChange(state) {
  _updatePropertyDropdown(state);
  _updateStatusStrip(state);
  _updateGoButton(state);
}

function _updatePropertyDropdown(state) {
  const { availableParams, selectedParamKey } = state;

  // Rebuild options only if params list changed
  const existingKeys = Array.from(elPropertySelect.options).map(o => o.value);
  const newKeys = availableParams.map(p => p.key);
  const changed = JSON.stringify(existingKeys) !== JSON.stringify(newKeys);

  if (changed) {
    elPropertySelect.innerHTML = '';
    if (availableParams.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '— select a clip —';
      elPropertySelect.appendChild(opt);
      elPropertySelect.disabled = true;
    } else {
      for (const p of availableParams) {
        const opt = document.createElement('option');
        opt.value = p.key;
        opt.textContent = p.displayName;
        elPropertySelect.appendChild(opt);
      }
      elPropertySelect.disabled = false;
    }
  }

  // Set selected value
  if (selectedParamKey && elPropertySelect.querySelector(`option[value="${selectedParamKey}"]`)) {
    elPropertySelect.value = selectedParamKey;
  } else if (availableParams.length > 0) {
    elPropertySelect.value = availableParams[0].key;
  }
}

const STATUS_CONFIG = {
  'idle':          { cls: 'status-idle',  text: (s) => s.hint || 'Open a project and select a clip' },
  'no-project':    { cls: 'status-idle',  text: 'No project open' },
  'no-sequence':   { cls: 'status-idle',  text: 'No active sequence' },
  'no-clip':       { cls: 'status-idle',  text: (s) => s.hint || 'No clip found at playhead' },
  'no-keyframes':  { cls: 'status-warn',  text: (s) => s.hint || 'No property with exactly 2 keyframes found' },
  'outside':       { cls: 'status-warn',  text: (s) => s.hint || 'Move the playhead between the two keyframes' },
  'valid':         { cls: 'status-valid', text: (s) => `Ready \u2014 ${_selectedParamName(s)}${s.hint ? ' \u00b7 ' + s.hint.split('\u00b7')[1] || '' : ''}` },
  'error':         { cls: 'status-error', text: (s) => `Error: ${s.errorMessage || s.hint || 'unknown'}` },
  'baking':        { cls: 'status-idle',  text: 'Applying\u2026' },
  'done':          { cls: 'status-done',  text: 'Done! Keyframes baked.' },
};

function _selectedParamName(state) {
  const p = state.availableParams.find(p => p.key === state.selectedParamKey)
         ?? state.availableParams[0];
  return p ? p.displayName : 'property';
}

function _updateStatusStrip(state) {
  const cfg = STATUS_CONFIG[state.status] || STATUS_CONFIG['idle'];
  const text = typeof cfg.text === 'function' ? cfg.text(state) : cfg.text;

  // Remove all status classes
  elStatusStrip.className = `status-strip ${cfg.cls}`;
  elStatusText.textContent = text;
}

function _updateGoButton(state) {
  const enabled = state.status === 'valid' && !state.isBaking;
  elGoBtn.disabled = !enabled;

  if (state.isBaking) {
    elGoLabel.style.display   = 'none';
    elGoArrow.style.display   = 'none';
    elGoSpinner.style.display = 'inline-block';
  } else {
    elGoLabel.style.display   = 'inline';
    elGoArrow.style.display   = 'inline';
    elGoSpinner.style.display = 'none';
  }
}

// ─── Go handler ───────────────────────────────────────────────────────────
async function _handleGo() {
  const state = getState();
  if (state.status !== 'valid' || state.isBaking) return;

  setState({ isBaking: true, status: 'baking' });

  try {
    await bakeKeyframes(state.context, state.curve);
    setState({ isBaking: false, status: 'done' });

    // Reset back to 'valid' after a brief success moment
    setTimeout(() => {
      const s = getState();
      if (s.status === 'done') {
        setState({ status: 'valid' });
      }
    }, 2200);
  } catch (err) {
    console.error('[FayeSmoothify] bakeKeyframes error:', err);
    setState({
      isBaking: false,
      status: 'error',
      errorMessage: err && err.message ? err.message : String(err),
      _errorUntil: Date.now() + 3000, // keep error visible for 3 seconds
    });
  }
}

// ─── Preset helpers ───────────────────────────────────────────────────────
function _setPresetActive(presetKey) {
  elPresetBtns.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.preset === presetKey);
    btn.removeAttribute('data-active');
    if (btn.dataset.preset === presetKey) {
      btn.dataset.active = 'true';
    }
  });
}

function _clearPresetActive() {
  elPresetBtns.forEach((btn) => {
    btn.classList.remove('active');
    btn.removeAttribute('data-active');
  });
}
