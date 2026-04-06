/**
 * OpenCurve CEP — bridge between plugin-ui.js and ExtendScript host.jsx.
 *
 * Handles:
 *   - CSInterface initialization
 *   - Panel lifecycle (replaces UXP entrypoints.setup)
 *   - Poll loop via evalScript('detectContext()')
 *   - Go button handler via evalScript('bakeKeyframes(...)')
 *   - Flyout menu
 */

(function() {
  console.log('[OC-CEP] cep-bridge.js loading');

  var cs = new CSInterface();

  // ─── Poll state ────────────────────────────────────────────────────────
  var POLL_MS        = 300; // slightly slower than UXP (200ms) due to evalScript overhead
  var pollTimer      = null;
  var _pollRunning   = false;
  var _lastStatus    = '';
  var _skipPollUntil = 0;
  var _lastPh        = null; // last playhead position (seconds)
  var _movingCount   = 0;    // consecutive polls where playhead moved

  // ─── Bridge object ──────────────────────────────────────────────────────
  var bridge = {
    // Called when user clicks Go
    onGo: function(state, bakedKeys) {
      var contexts = bakedKeys.map(function(k) { return state.paramContexts[k]; });
      if (contexts.length === 0) return;

      OpenCurve.setState({ isBaking: true, status: 'baking' });

      var args = JSON.stringify({
        params: contexts,
        curve: state.curve,
      });

      // Escape single quotes for evalScript
      var escaped = args.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

      cs.evalScript("bakeKeyframes('" + escaped + "')", function(result) {
        try {
          var res = JSON.parse(result);
          if (res.success) {
            _skipPollUntil = Date.now() + OpenCurve.DONE_DISPLAY_MS;
            var newBaked = (state.bakedParamKeys || []).concat(bakedKeys.filter(function(k) {
              return (state.bakedParamKeys || []).indexOf(k) < 0;
            }));
            OpenCurve.setState({
              isBaking: false,
              status: 'done',
              bakedParamKeys: newBaked,
              selectedParamKeys: (state.selectedParamKeys || []).filter(function(k) {
                return bakedKeys.indexOf(k) < 0;
              }),
            });
            // Show undo button
            _showUndoBtn(true);
            setTimeout(function() {
              _lastStatus = '';
              OpenCurve.setState({ status: 'idle' });
            }, OpenCurve.DONE_DISPLAY_MS);
          } else {
            _skipPollUntil = Date.now() + OpenCurve.ERROR_DISPLAY_MS;
            OpenCurve.setState({
              isBaking: false,
              status: 'error',
              hint: res.error || 'Unknown error',
            });
          }
        } catch(e) {
          _skipPollUntil = Date.now() + OpenCurve.ERROR_DISPLAY_MS;
          OpenCurve.setState({
            isBaking: false,
            status: 'error',
            hint: 'Failed to parse bake result',
          });
        }
      });
    },

    // Open external URL
    openExternal: function(url) {
      cs.openURLInDefaultBrowser(url);
      OpenCurve.showCopyToast('Opened link in browser', '#e6b800');
    },
  };

  OpenCurve.setBridge(bridge);

  // ─── Undo button ──────────────────────────────────────────────────────
  function _showUndoBtn(show) {
    var btn = document.getElementById('undo-btn');
    if (btn) btn.classList.toggle('btn-hidden', !show);
  }

  document.addEventListener('click', function(e) {
    var btn = e.target.closest('#undo-btn');
    if (!btn || btn.classList.contains('btn-hidden')) return;

    cs.evalScript('undoBake()', function(result) {
      try {
        var res = JSON.parse(result);
        if (res.success) {
          if (!res.remaining) _showUndoBtn(false);
          _lastStatus = '';
          _skipPollUntil = 0;
          OpenCurve.setState({ bakedParamKeys: [], status: 'idle' });
          OpenCurve.showCopyToast('Undone (' + res.removed + ' keyframes removed)', '#f0a030');
        } else {
          OpenCurve.showCopyToast(res.error || 'Undo failed', '#f06060');
        }
      } catch(e2) {
        OpenCurve.showCopyToast('Undo failed', '#f06060');
      }
    });
  });

  // ─── Poll loop ──────────────────────────────────────��───────────────────
  function poll() {
    if (_pollRunning) return;
    if (OpenCurve.isDragging) return;
    var s = OpenCurve.getState();
    if (s.isBaking) return;
    if (Date.now() < _skipPollUntil) return;

    _pollRunning = true;

    cs.evalScript('detectContext()', function(resultStr) {
      _pollRunning = false;

      var result;
      try {
        result = JSON.parse(resultStr);
      } catch(e) {
        console.error('[OC-CEP] Failed to parse detectContext result:', resultStr);
        return;
      }

      // Track sustained playhead movement — pause detection during playback
      var ph = result.ph;
      if (_lastPh !== null && ph !== undefined && ph !== _lastPh) {
        _movingCount++;
        _lastPh = ph;
        if (_movingCount >= 3) {
          OpenCurve.setState({
            status: 'playing',
            availableParams: [],
            hint: 'Keyframe detection paused while playing',
            selectedParamKeys: [],
            validParamKeys: [],
            paramContexts: {},
            bakedParamKeys: [],
          });
          if ('playing' !== _lastStatus) {
            _lastStatus = 'playing';
          }
          return;
        }
      } else {
        _movingCount = 0;
      }
      _lastPh = ph;

      var s = OpenCurve.getState();
      var updates = {
        status:          result.status,
        availableParams: result.availableParams || [],
        hint:            result.hint || '',
        errorMessage:    result.hint || '',
      };

      if (result.status === 'valid') {
        var avail      = result.availableParams || [];
        var validKeys  = result.validParamKeys  || [];

        // Keep selected keys that are still in availableParams
        var currentSel = (s.selectedParamKeys || []).filter(function(k) {
          return avail.some(function(p) { return p.key === k; });
        });

        // Auto-select all valid params on fresh detection
        var wasEmpty = (s.availableParams || []).length === 0;
        if (currentSel.length === 0 && validKeys.length > 0 && wasEmpty) {
          currentSel = validKeys.slice();
        }

        updates.selectedParamKeys = currentSel;
        updates.validParamKeys    = validKeys;
        updates.paramContexts     = result.paramContexts || {};
        updates.bakedParamKeys    = (s.bakedParamKeys || []).filter(function(k) {
          var inAvail = avail.some(function(p) { return p.key === k; });
          var inValid = validKeys.indexOf(k) >= 0;
          return inAvail && !inValid;
        });

        // Downgrade status if no selected param is actually valid
        var activeCount = currentSel.filter(function(k) { return validKeys.indexOf(k) >= 0; }).length;
        if (activeCount === 0) updates.status = 'no-selection';
      } else {
        updates.selectedParamKeys = [];
        updates.validParamKeys    = [];
        updates.paramContexts     = {};
        updates.bakedParamKeys    = [];
      }

      if (result.status !== _lastStatus) {
        console.log('[OC-CEP] status changed:', _lastStatus, '\u2192', result.status, result.hint || '');
        _lastStatus = result.status;
      }

      OpenCurve.setState(updates);
    });
  }

  // ─── Flyout menu ─────────────────────────────────────────────────────────
  var flyoutXML = '<Menu>'
    + '<MenuItem Id="settings" Label="Settings" Enabled="true" Checked="false"/>'
    + '<MenuItem Id="check-updates" Label="Check for Updates" Enabled="true" Checked="false"/>'
    + '<MenuItem Label="---"/>'
    + '<MenuItem Id="made-by" Label="made by faye" Enabled="false" Checked="false"/>'
    + '</Menu>';

  cs.setPanelFlyoutMenu(flyoutXML);

  cs.addEventListener('com.adobe.csxs.events.flyoutMenuClicked', function(event) {
    var data = event.data;
    try {
      var parsed = (typeof data === 'string') ? JSON.parse(data) : data;
      var menuId = parsed.menuId || '';
      if (menuId === 'settings')       OpenCurve.showSettingsModal();
      if (menuId === 'check-updates')  OpenCurve.checkForUpdates();
    } catch(e) {
      console.error('[OC-CEP] flyout menu error:', e);
    }
  });

  // ─── Splash screen (first launch only) ──────────────────────────────────
  var SPLASH_KEY = 'opencurve-cep-splash-seen';

  function showSplash() {
    if (localStorage.getItem(SPLASH_KEY)) return;

    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;';

    var card = document.createElement('div');
    card.style.cssText = 'background:#1c1c1c;border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:28px 32px 24px;max-width:340px;width:90%;text-align:center;font-family:system-ui,sans-serif;';

    var logo = document.createElement('img');
    logo.src = 'img/OpenCurve_Logo14.png';
    logo.style.cssText = 'height:30px;margin-bottom:20px;opacity:0.9;';
    card.appendChild(logo);

    var text = document.createElement('div');
    text.style.cssText = 'color:#ccc;font-size:12.5px;line-height:1.65;margin-bottom:22px;';
    text.innerHTML =
      'You have installed the <strong style="color:#e4e4e4">.zxp</strong> version of OpenCurve.<br><br>' +
      'This version supports older Premiere versions, but can\u2019t support Undo/Redo with shortcuts.<br><br>' +
      'Use the <strong style="color:#e4e4e4">Undo button</strong> next to the Go button to undo added keyframes.<br><br>' +
      'Undo and Redo are supported in the <strong style="color:#e4e4e4">.ccx</strong> version of OpenCurve for Premiere 2025 onwards.';
    card.appendChild(text);

    var btn = document.createElement('div');
    btn.textContent = 'Got it';
    btn.style.cssText = 'display:inline-block;padding:7px 28px;background:rgba(74,158,255,0.15);color:#6cb8ff;border-radius:5px;font-size:13px;font-weight:600;cursor:pointer;transition:background 0.15s;';
    btn.addEventListener('mouseenter', function() { btn.style.background = 'rgba(74,158,255,0.28)'; });
    btn.addEventListener('mouseleave', function() { btn.style.background = 'rgba(74,158,255,0.15)'; });
    btn.addEventListener('click', function() {
      localStorage.setItem(SPLASH_KEY, '1');
      overlay.remove();
    });
    card.appendChild(btn);

    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }

  // ─── Init ────────────────────────────────────────────────────────────────
  function init() {
    console.log('[OC-CEP] Initializing panel');
    OpenCurve.initPanel();
    OpenCurve.applyCurveColor(localStorage.getItem('opencurve-line-color') || '#4a9eff');

    // Show first-launch splash
    showSplash();

    // Check for post-update toast
    if (localStorage.getItem('opencurve-post-update') === '1') {
      localStorage.removeItem('opencurve-post-update');
      setTimeout(function() {
        OpenCurve.showCopyToast('Updated to v' + '1.2.2', '#3ddc84');
      }, 500);
    }

    // Start polling
    poll();
    pollTimer = setInterval(poll, POLL_MS);

    // Check for updates on load
    if (OpenCurve.updateNotifsOn) {
      OpenCurve.checkForUpdates(true);
    }
  }

  // Wait for DOM if needed
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Cleanup on panel close
  window.addEventListener('unload', function() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  });

  console.log('[OC-CEP] cep-bridge.js loaded');
})();
