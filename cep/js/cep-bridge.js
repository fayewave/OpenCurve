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

  // ─── Bridge object ──────────────────────────────────────────────────────
  var bridge = {
    // Called when user clicks a property's pin: move the playhead to its keyframes
    onJump: function(sec) {
      cs.evalScript('jumpPlayhead(' + Number(sec) + ')', function(result) {
        if (result !== 'true') { OpenCurve.showCopyToast('Could not move playhead'); return; }
        _lastPh = null; _skipPollUntil = 0;
      });
    },

    // Called when user clicks Go
    onGo: function(state, bakedKeys) {
      var contexts = bakedKeys.map(function(k) { return state.paramContexts[k]; });
      if (contexts.length === 0) return;

      OpenCurve.setState({ isBaking: true, status: 'baking' });

      var args = JSON.stringify({
        params: contexts,
        curve: state.curve,
        step: OpenCurve.bakeDensity || 1, // keyframe spacing from Settings
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
            // The baked pairs are one frame apart now, so those properties are
            // no longer bakeable; drop them from the valid set straight away
            // rather than waiting for the next poll (polling pauses while
            // "Done" shows).
            var ctxLeft = {};
            Object.keys(state.paramContexts || {}).forEach(function(k) { if (bakedKeys.indexOf(k) < 0) ctxLeft[k] = state.paramContexts[k]; });
            OpenCurve.setState({
              isBaking: false,
              status: 'done',
              bakedParamKeys: newBaked,
              availableParams: OpenCurve.tlSpansAfterBake(state, bakedKeys), // green bar on the timeline right away
              validParamKeys: (state.validParamKeys || []).filter(function(k) { return bakedKeys.indexOf(k) < 0; }),
              paramContexts: ctxLeft,
              selectedParamKeys: (state.selectedParamKeys || []).filter(function(k) {
                return bakedKeys.indexOf(k) < 0;
              }),
            });
            // Show undo button
            _showUndoBtn(true);
            _saveBakeRecords();
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

    // Row undo button: remove the keyframes our bake(s) added to one property.
    // `ids` are host bake record ids from detectContext.
    onUndoParam: function(ids, name) {
      cs.evalScript("undoBakeParam('" + ids.join(',') + "')", function(result) {
        try {
          var res = JSON.parse(result);
          _lastStatus = '';
          _skipPollUntil = 0;
          if (res.success) {
            if (!res.remaining) _showUndoBtn(false);
            _saveBakeRecords();
            OpenCurve.showCopyToast('Undone: ' + res.removed + ' keyframes removed from ' + (name || 'property'), '#f0a030');
          } else {
            OpenCurve.showCopyToast(res.error || 'Undo failed', '#ff9090');
          }
        } catch(e) {
          OpenCurve.showCopyToast('Undo failed', '#ff9090');
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

  // ─── Bake record persistence ─────────────────────────────────────────
  // The host keeps the bake records (its _undoStack). Mirror them into
  // localStorage after every change and hand them back on init, so a row can
  // still show green, load its curve and be undone after the panel or
  // Premiere was closed. Only bakes made this session feed the Undo button.
  var _BAKE_RECORDS_KEY = 'opencurve-bake-records';
  function _saveBakeRecords() {
    cs.evalScript('exportBakeRecords()', function(r) {
      try { if (r && r.charAt(0) === '[') localStorage.setItem(_BAKE_RECORDS_KEY, r); } catch(e) {}
    });
  }
  function _loadBakeRecords() {
    var json = '';
    try { json = localStorage.getItem(_BAKE_RECORDS_KEY) || ''; } catch(e) {}
    if (!json) return;
    var escaped = json.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    cs.evalScript("importBakeRecords('" + escaped + "')", function(r) {
      console.log('[OC-CEP] bake records restored: ' + r);
    });
  }

  // ─── Undo button ──────────────────────────────────────────────────────
  // The button always stays in place; with nothing to undo it is grey and inert
  function _showUndoBtn(show) {
    var btn = document.getElementById('undo-btn');
    if (btn) {
      btn.classList.toggle('btn-dim', !show);
      btn.style.background = show ? '' : 'rgba(255,255,255,0.06)';
      btn.style.color      = show ? '' : '#666';
      btn.style.cursor     = show ? '' : 'default';
    }
    if (OpenCurve.fitGoForUndo) OpenCurve.fitGoForUndo();
  }

  document.addEventListener('click', function(e) {
    var btn = e.target.closest('#undo-btn');
    if (!btn || btn.classList.contains('btn-dim')) return;

    cs.evalScript('undoBake()', function(result) {
      try {
        var res = JSON.parse(result);
        if (res.success) {
          if (!res.remaining) _showUndoBtn(false);
          _saveBakeRecords();
          _lastStatus = '';
          _skipPollUntil = 0;
          OpenCurve.setState({ bakedParamKeys: [], status: 'idle' });
          OpenCurve.showCopyToast('Undone (' + res.removed + ' keyframes removed)', '#f0a030');
        } else {
          OpenCurve.showCopyToast(res.error || 'Undo failed', '#ff9090');
        }
      } catch(e2) {
        OpenCurve.showCopyToast('Undo failed', '#ff9090');
      }
    });
  });

  // ─── Poll loop ──────────────────────────────────────��───────────────────
  // ─── Debug: poll timing ──────────────────────────────────────────────────
  // Toggle from the flyout menu (or set localStorage 'opencurve-debug-timing' to 'on').
  // Logs every poll to the console with what it did and how long it took, and
  // prints a summary when turned off. Costs one boolean check per poll when off.
  var _DEBUG_TIMING_KEY = 'opencurve-debug-timing';
  var _debugTiming = localStorage.getItem(_DEBUG_TIMING_KEY) === 'on';
  var _dbgKind   = '';   // what the last detect did: cache | full | playing | early | error
  var _dbgFullMs = 0;    // time spent inside the full scan itself (UXP only)
  var _dbgStats  = null;
  function _dbgReset() {
    _dbgStats = { since: Date.now(), polls: 0, dropped: 0, kinds: {}, full: [], fast: [], cache: [], slowest: 0, slowestKind: '',
                  lastAt: 0, gaps: [], render: [], phChanges: 0, lastPh: null };
  }
  // kind/ms: what the host did and the evalScript round trip. t0: when this poll
  // started (gives the wall-clock gap to the previous poll, i.e. whether the
  // timer really fires every POLL_MS). renderMs: time spent in setState/render.
  // ph: the playhead seconds this poll saw; a trailing * marks a change.
  function _dbgRecord(kind, ms, result, t0, renderMs, ph) {
    if (!_dbgStats) _dbgReset();
    var st = _dbgStats;
    st.polls++;
    st.kinds[kind] = (st.kinds[kind] || 0) + 1;
    if (kind === 'full') st.full.push(ms); else if (kind === 'fast') st.fast.push(ms); else if (kind === 'cache') st.cache.push(ms);
    if (ms > st.slowest) { st.slowest = ms; st.slowestKind = kind; }
    var gap = (t0 && st.lastAt) ? t0 - st.lastAt : 0;
    if (t0) st.lastAt = t0;
    if (gap) st.gaps.push(gap);
    if (typeof renderMs === 'number') st.render.push(renderMs);
    var phMoved = (typeof ph === 'number' && st.lastPh !== null && ph !== st.lastPh);
    if (phMoved) st.phChanges++;
    if (typeof ph === 'number') st.lastPh = ph;
    var budget = POLL_MS;
    var over = ms > budget ? '  OVER BUDGET (' + budget + 'ms poll interval)' : '';
    var scan = ((kind === 'full' || kind === 'fast') && _dbgFullMs) ? '  host=' + _dbgFullMs + 'ms' : '';
    console.log('[OC-TIMING] ' + (kind + '       ').slice(0, 7) + ' ' + ('    ' + ms).slice(-4) + 'ms' + scan +
      '  gap=' + ('   ' + gap).slice(-3) + 'ms' +
      '  render=' + ('  ' + (renderMs || 0)).slice(-2) + 'ms' +
      (typeof ph === 'number' ? '  ph=' + ph.toFixed(3) + (phMoved ? '*' : ' ') : '') +
      '  status=' + (result && result.status) +
      '  params=' + ((result && result.availableParams) ? result.availableParams.length : 0) +
      (result && result.hint ? '  hint="' + result.hint + '"' : '') + over);
  }
  function _dbgSummary() {
    var st = _dbgStats; if (!st) return 'No polls recorded';
    function avg(a){ return a.length ? Math.round(a.reduce(function(x,y){ return x+y; }, 0) / a.length) : 0; }
    function max(a){ return a.length ? Math.max.apply(null, a) : 0; }
    var secs = Math.round((Date.now() - st.since) / 1000);
    console.log('[OC-TIMING] summary over ' + secs + 's\n' +
      '  polls      : ' + st.polls + ' (' + st.dropped + ' dropped because the previous poll was still running)\n' +
      '  full scans : ' + st.full.length + '  avg ' + avg(st.full) + 'ms  max ' + max(st.full) + 'ms\n' +
      '  fast path  : ' + st.fast.length + '  avg ' + avg(st.fast) + 'ms  max ' + max(st.fast) + 'ms\n' +
      '  cache hits : ' + st.cache.length + '  avg ' + avg(st.cache) + 'ms  max ' + max(st.cache) + 'ms\n' +
      '  interval   : avg ' + avg(st.gaps) + 'ms between polls (timer set to ' + POLL_MS + 'ms)  max ' + max(st.gaps) + 'ms\n' +
      '  render     : avg ' + avg(st.render) + 'ms  max ' + max(st.render) + 'ms\n' +
      '  playhead   : moved on ' + st.phChanges + ' of ' + st.polls + ' polls\n' +
      '  by kind    : ' + JSON.stringify(st.kinds) + '\n' +
      '  slowest    : ' + st.slowest + 'ms (' + st.slowestKind + ')');
    return 'full avg ' + avg(st.full) + 'ms / max ' + max(st.full) + 'ms, cache avg ' + avg(st.cache) + 'ms, interval avg ' + avg(st.gaps) + 'ms, render avg ' + avg(st.render) + 'ms, ' + st.dropped + ' dropped';
  }
  function _toggleDebugTiming() {
    _debugTiming = !_debugTiming;
    localStorage.setItem(_DEBUG_TIMING_KEY, _debugTiming ? 'on' : 'off');
    if (_debugTiming) { _dbgReset(); OpenCurve.showCopyToast('Poll timing ON: watch the debug console'); }
    else { OpenCurve.showCopyToast('Poll timing OFF: ' + _dbgSummary()); }
  }

  // Rows with a bake to undo: the host attaches its bake record ids to each
  // availableParams entry (and drops records it can see were undone with Ctrl+Z).
  function _bakedKeys(avail) {
    return (avail || []).filter(function(p) { return p.bakeIds && p.bakeIds.length; })
                        .map(function(p) { return p.key; });
  }

  function poll() {
    if (_pollRunning) { if (_debugTiming && _dbgStats) _dbgStats.dropped++; return; }
    if (OpenCurve.isDragging) return;
    var s = OpenCurve.getState();
    if (s.isBaking) return;
    if (Date.now() < _skipPollUntil) return;

    _pollRunning = true;

    var _t0 = _debugTiming ? Date.now() : 0;
    cs.evalScript('detectContext()', function(resultStr) {
      _pollRunning = false;
      // Go was pressed while this scan was out: its result predates the bake
      // and would restore the pre-bake selection. Discard it.
      if (OpenCurve.getState().isBaking || Date.now() < _skipPollUntil) return;

      var result;
      try {
        result = JSON.parse(resultStr);
      } catch(e) {
        console.error('[OC-CEP] Failed to parse detectContext result:', resultStr);
        return;
      }
      // Round trip through evalScript; 'unchanged' means the host skipped the scan
      var _tDet = _debugTiming ? Date.now() - _t0 : 0;
      var _dbgK = result.status === 'unchanged' ? 'cache' : (result.scanKind === 'fast' ? 'fast' : 'full');
      if (_debugTiming) _dbgFullMs = result.scanMs || 0;

      // Nothing changed since the last poll — the host skipped the full scan.
      // Keep the current UI state untouched (no setState, no re-render).
      if (result.status === 'unchanged') {
        if (result.ph !== undefined) _lastPh = result.ph;
        if (_debugTiming) _dbgRecord(_dbgK, _tDet, result, _t0, 0, result.ph);
        return;
      }

      // Scanning continues during playback (the 1.x pause option was removed in 2.0.0)
      var ph = result.ph;
      _lastPh = ph;

      var s = OpenCurve.getState();
      var updates = {
        status:          result.status,
        availableParams: result.availableParams || [],
        hint:            result.hint || '',
        clipName:        result.clipName || '',
        errorMessage:    result.hint || '',
        tl:              result.tl || null, // mini timeline: clip extent + playhead
      };

      if (result.status === 'valid') {
        var avail      = result.availableParams || [];
        var validKeys  = result.validParamKeys  || [];

        // Keep selected keys that are still in availableParams
        var currentSel = (s.selectedParamKeys || []).filter(function(k) {
          return avail.some(function(p) { return p.key === k; });
        });

        // Auto-select all valid params whenever the available set changes —
        // including switching directly from one keyframed clip to another
        // (previously only fired when availableParams was empty, so moving
        // between two clips with params left nothing selected).
        var prevKeys = (s.availableParams || []).map(function(p) { return p.key; }).join(',');
        var newKeys  = avail.map(function(p) { return p.key; }).join(',');
        var availChanged = prevKeys !== newKeys;
        if (currentSel.length === 0 && validKeys.length > 0 && availChanged) {
          currentSel = validKeys.slice();
        }

        updates.selectedParamKeys = currentSel;
        updates.validParamKeys    = validKeys;
        updates.paramContexts     = result.paramContexts || {};
        updates.bakedParamKeys    = _bakedKeys(avail);
        // A green (baked) row can't stay selected unless the playhead is over an unbaked pair of it
        updates.selectedParamKeys = updates.selectedParamKeys.filter(function(k) {
          return updates.bakedParamKeys.indexOf(k) < 0 || validKeys.indexOf(k) >= 0;
        });

        // Downgrade status if no selected param is actually valid
        var activeCount = currentSel.filter(function(k) { return validKeys.indexOf(k) >= 0; }).length;
        if (activeCount === 0) updates.status = 'no-selection';
      } else if (result.status === 'outside') {
        // Same clip, playhead outside every keyframe pair: keep any selection the
        // user made (shown orange) so it turns blue once the playhead reaches it.
        var availOut = result.availableParams || [];
        updates.selectedParamKeys = (s.selectedParamKeys || []).filter(function(k) {
          return availOut.some(function(p) { return p.key === k; });
        });
        updates.validParamKeys    = [];
        updates.paramContexts     = {};
        updates.bakedParamKeys    = _bakedKeys(availOut);
        updates.selectedParamKeys = updates.selectedParamKeys.filter(function(k) { return updates.bakedParamKeys.indexOf(k) < 0; });
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

      var _tR = _debugTiming ? Date.now() : 0;
      OpenCurve.setState(updates);
      if (_debugTiming) _dbgRecord(_dbgK, _tDet, result, _t0, Date.now() - _tR, result.ph);
    });
  }

  // ─── Flyout menu ─────────────────────────────────────────────────────────
  var flyoutXML = '<Menu>'
    + '<MenuItem Id="settings" Label="Settings" Enabled="true" Checked="false"/>'
    + '<MenuItem Id="check-updates" Label="Check for Updates" Enabled="true" Checked="false"/>'
    + '<MenuItem Id="poll-timing" Label="Poll Timing (Debug)" Enabled="true" Checked="false"/>'
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
      if (menuId === 'poll-timing')    _toggleDebugTiming();
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
    logo.src = 'img/OpenCurve_Logo14_small.png';
    logo.style.cssText = 'height:30px;margin-bottom:20px;opacity:0.9;';
    card.appendChild(logo);

    var text = document.createElement('div');
    text.style.cssText = 'color:#ccc;font-size:12.5px;line-height:1.65;margin-bottom:22px;';
    text.innerHTML =
      'You have installed the <strong style="color:#e4e4e4">.zxp</strong> version of OpenCurve.<br><br>' +
      'This version has limitations:' +
      '<ul style="text-align:left;margin:8px 0 0;padding-left:20px;">' +
      '<li>Slower scanning speed.</li>' +
      '<li>Dedicated Undo button instead of shortcuts.</li>' +
      '<li>Keyframes won\u2019t appear until the effects panel is selected.</li>' +
      '</ul><br>' +
      'Install the <strong style="color:#e4e4e4">.ccx</strong> version of OpenCurve for the full featureset.';
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
    _loadBakeRecords();
    var undoBtn = document.getElementById('undo-btn');
    if (undoBtn && OpenCurve.attachTooltip) {
      undoBtn.removeAttribute('title');
      OpenCurve.attachTooltip(undoBtn, function() { return undoBtn.classList.contains('btn-dim') ? 'Nothing to undo' : 'Undo last bake'; });
    }
    OpenCurve.applyCurveColor(localStorage.getItem('opencurve-line-color') || '#4a9eff');

    // Show first-launch splash
    showSplash();

    // Check for post-update toast
    if (localStorage.getItem('opencurve-post-update') === '1') {
      localStorage.removeItem('opencurve-post-update');
      setTimeout(function() {
        OpenCurve.showCopyToast('Updated to v' + '2.0.0', '#3ddc84');
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
