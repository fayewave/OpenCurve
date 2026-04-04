/**
 * main.js — Plugin entry point (ES modules version)
 *
 * ⚠️  DEPRECATED — This file is NOT loaded by the plugin.
 *     The active implementation is src/plugin.js (monolithic, non-module).
 *     This modular version is kept for reference only. Do not modify
 *     unless you are migrating back to ES modules.
 *
 * Sets up UXP entrypoints and manages the polling loop that continuously
 * checks Premiere's state (playhead, selection, keyframes) while the panel
 * is visible.
 *
 * NOTE: Premiere Pro UXP has no playhead-move or selection-change events,
 * so we poll on a fixed interval instead.
 */

import { getState, setState } from './state.js';
import { init as initUI }     from './ui-controller.js';
import { detectContext }      from './ppro-bridge.js';

// UXP built-in — synchronous require is valid in UXP ES module context
const { entrypoints } = require('uxp');

const POLL_INTERVAL_MS = 600;
let pollTimer = null;

// ─── Polling ───────────────────────────────────────────────────────────────

async function poll() {
  const state = getState();
  // Don't interrupt an active bake
  if (state.isBaking) return;
  // Don't overwrite error status until the display timeout expires
  if (state._errorUntil && Date.now() < state._errorUntil) return;

  try {
    const result = await detectContext(state.selectedParamKey);

    const updates = {
      status:          result.status,
      availableParams: result.availableParams || [],
      errorMessage:    result.errorMessage || '',
      hint:            result.hint || '',
    };

    // Preserve the selectedParamKey when we get a valid result,
    // or fall back to the first available param
    if (result.status !== 'idle') {
      const available = result.availableParams || [];
      const currentKey = state.selectedParamKey;
      const keyExists  = available.some(p => p.key === currentKey);

      if (!keyExists && available.length > 0) {
        updates.selectedParamKey = available[0].key;
      } else if (result.selectedKey) {
        updates.selectedParamKey = result.selectedKey;
      }
    }

    // Attach the full context object for baking
    updates.context = (result.status === 'valid') ? result : null;

    setState(updates);
  } catch (err) {
    console.error('[FayeSmoothify] poll error:', err);
    // Don't update status if it's currently 'done' or 'baking'
    const s = getState();
    if (s.status !== 'done' && s.status !== 'baking') {
      setState({ status: 'error', errorMessage: err.message || String(err) });
    }
  }
}

// Expose for the Detect button to trigger a manual poll
window.__smoothifyPoll = poll;

// ─── UXP Entrypoints ───────────────────────────────────────────────────────

entrypoints.setup({
  plugin: {
    create() {
      // Plugin-level init — no DOM yet at this point
    },
    destroy() {
      _stopPolling();
    },
  },
  panels: {
    'fayesmoothify-panel': {
      create(rootNode) {
        // Panel DOM is ready — wire up UI
        // rootNode is the panel's root DOM element (the <body> in index.html)
        initUI();
      },
      show(rootNode) {
        // Panel became visible — start polling
        poll(); // Immediate first check
        pollTimer = setInterval(poll, POLL_INTERVAL_MS);
      },
      hide(rootNode) {
        // Panel hidden — stop polling to save resources
        _stopPolling();
      },
      destroy(rootNode) {
        _stopPolling();
      },
    },
  },
});

function _stopPolling() {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
