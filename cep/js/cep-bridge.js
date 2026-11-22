/**
 * OpenCurve CEP — bridge between plugin-ui.js and ExtendScript host.jsx.
 *
 * Handles:
 *   - CSInterface initialization
 *   - Panel lifecycle (replaces UXP entrypoints.setup)
 *   - Poll loop via evalScript('detectContext(needFull)')
 *   - Go button handler via evalScript('bakeKeyframes(...)')
 *   - Flyout menu
 */

(function() {
  console.log('[OC-CEP] cep-bridge.js loading');

  var cs = new CSInterface();

  // Chromium's own right-click menu (Back, Forward, Print..., View page source)
  // must never show in the panel. Capture phase on window, so it covers every
  // element; it only cancels the browser's default, so the panel's own menus
  // (preset tiles, graph, timeline, rows) still open from their listeners.
  // Text fields keep the native menu for Cut / Copy / Paste.
  window.addEventListener('contextmenu', function(e) {
    var t = e.target, tag = t && t.tagName ? String(t.tagName).toUpperCase() : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) return;
    e.preventDefault();
  }, true);

  // ─── Poll state ────────────────────────────────────────────────────────
  var POLL_MS        = 300; // slightly slower than UXP (200ms) due to evalScript overhead
  var pollTimer      = null;
  var _pollRunning   = false;
  var _pollStartedAt = 0;     // when the running scan began, for the stuck-scan guard
  var _pollToken     = 0;     // identifies the scan that owns _pollRunning
  var _POLL_STUCK_MS = 5000;  // a scan still running after this is abandoned
  // True until a full result has been applied, and again after a scan is
  // abandoned: the host then answers with its cached full result instead of
  // 'unchanged'. Without it, a first scan slower than _POLL_STUCK_MS (a big
  // timeline, 2026-11-22) left the panel on "Open a project and select a clip"
  // for good, since every later poll said nothing had changed since a result
  // the panel never received.
  var _needFull = true;
  var _lastStatus    = '';
  var _skipPollUntil = 0;
  var _lastPh        = null; // last playhead position (seconds)
  var _phMovedAt     = 0;    // when the playhead was last seen moving (transport toggle: playing or not)

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
            // Some selected properties changed since the scan and were left alone:
            // only the ones the host wrote turn green
            if (res.warning) OpenCurve.showCopyToast(res.warning);
            if (res.baked && res.baked.length) bakedKeys = bakedKeys.filter(function(k) { return res.baked.indexOf(k) >= 0; });
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
              availableParams: OpenCurve.tlSpansAfterBake(state, bakedKeys, res.bakedIds, state.curve), // green bar, row Undo / Load Curve right away
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
    // done (optional) runs when Premiere has answered: the row button's spinner goes
    onUndoParam: function(ids, name, done) {
      cs.evalScript("undoBakeParam('" + ids.join(',') + "')", function(result) {
        if (done) done();
        try {
          var res = JSON.parse(result);
          _lastStatus = '';
          _skipPollUntil = 0;
          if (res.success) {
            if (!res.remaining) _showUndoBtn(false);
            _saveBakeRecords();
            _undoToast(res, name);
            poll(); // a restored bake keeps the row green: let a scan repaint it
          } else {
            OpenCurve.showCopyToast(res.error || 'Undo failed', '#ff9090');
          }
        } catch(e) {
          OpenCurve.showCopyToast('Undo failed', '#ff9090');
        }
      });
    },

    // Row Replace button: the host removes those bakes and writes `curve` on
    // the same keyframe pairs, at the current Keyframe Spacing.
    onReplaceParam: function(ids, curve, name, done) {
      OpenCurve.setState({ isBaking: true, status: 'baking' });
      var args = JSON.stringify({ ids: ids, curve: curve, step: OpenCurve.bakeDensity || 1 });
      var escaped = args.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      cs.evalScript("replaceBake('" + escaped + "')", function(result) {
        if (done) done();
        var res = null;
        try { res = JSON.parse(result); } catch(e) {}
        _lastStatus = '';
        if (res && res.success) {
          _showUndoBtn(true);
          _saveBakeRecords();
          _skipPollUntil = Date.now() + OpenCurve.DONE_DISPLAY_MS;
          OpenCurve.setState({ isBaking: false, status: 'done' });
          OpenCurve.showCopyToast(res.warning || ('Replaced the curve on ' + (name || 'property')), res.warning ? '#f0a030' : undefined);
          setTimeout(function() { _lastStatus = ''; OpenCurve.setState({ status: 'idle' }); }, OpenCurve.DONE_DISPLAY_MS);
        } else {
          if (res) _saveBakeRecords(); // the old bake may have been put back as a new record
          _skipPollUntil = Date.now() + OpenCurve.ERROR_DISPLAY_MS;
          OpenCurve.setState({ isBaking: false, status: 'error', hint: 'Replace failed: ' + ((res && res.error) || 'no answer from Premiere') });
        }
      });
    },

    // Open external URL
    // Transport keys (Space, J, K, L): QE plays the active sequence. 'noqe'
    // means the panel's preview engine should step the playhead instead.
    transport: function(cmd) {
      var moving = (Date.now() - _phMovedAt) < 700 ? 'moving' : 'still';
      return new Promise(function(resolve) {
        cs.evalScript("ocTransport('" + String(cmd).replace(/[^a-z]/g, '') + "', '" + moving + "')", function(r) {
          if (r === 'noqe') { resolve(false); return; }
          if (String(r).indexOf('err:') === 0) { console.log('[OC-CEP] transport:', r); resolve(false); return; }
          _skipPollUntil = 0; // keep _lastPh: the next polls tell whether the playhead is moving
          resolve(true);
        });
      });
    },
    // Preview engine: sequence position/end/fps, and a playhead move without the pin's toast
    seqInfo: function() {
      return new Promise(function(resolve) {
        cs.evalScript('ocSeqInfo()', function(r) {
          var v = null; try { v = JSON.parse(r); } catch(_) {}
          resolve(v && v.ok ? v : null);
        });
      });
    },
    setPlayhead: function(sec) {
      return new Promise(function(resolve, reject) {
        cs.evalScript('jumpPlayhead(' + Number(sec) + ')', function(r) {
          if (r === 'true') { _lastPh = null; _skipPollUntil = 0; resolve(); } else reject(new Error('jump failed'));
        });
      });
    },
    // Mini timeline hover: the property's value at a media time
    valueAt: function(key, sec) {
      return new Promise(function(resolve) {
        cs.evalScript("ocValueAt('" + String(key).replace(/[^0-9_]/g, '') + "', " + Number(sec) + ")", function(r) {
          var v = null; try { v = JSON.parse(r); } catch(_) {}
          resolve(v);
        });
      });
    },
    // Preset files: Export / Import Presets in the preset list's context menu
    saveTextFile: function(name, text) {
      return new Promise(function(resolve, reject) {
        try {
          var r = window.cep.fs.showSaveDialogEx('Export Presets', '', ['json'], name);
          if (!r || r.err !== 0 || !r.data) { resolve(false); return; } // cancelled
          var path = String(r.data);
          if (path.toLowerCase().slice(-5) !== '.json') path += '.json';
          var w = window.cep.fs.writeFile(path, text);
          if (w && w.err === 0) resolve(true); else reject(new Error('writeFile error ' + (w && w.err)));
        } catch(e) { reject(e); }
      });
    },
    openTextFile: function() {
      return new Promise(function(resolve, reject) {
        try {
          var r = window.cep.fs.showOpenDialogEx(false, false, 'Import Presets', '', ['json']);
          if (!r || r.err !== 0 || !r.data || !r.data.length) { resolve(null); return; } // cancelled
          var rd = window.cep.fs.readFile(String(r.data[0]));
          if (rd && rd.err === 0) resolve(rd.data); else reject(new Error('readFile error ' + (rd && rd.err)));
        } catch(e) { reject(e); }
      });
    },
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

  // Toast after an undo. A bake made by Replace gets the bake it replaced
  // written back by the host (`restored`), so say that rather than a count.
  function _undoToast(res, name) {
    var where = name ? ' on ' + name : '';
    if (res.restoreFailed) OpenCurve.showCopyToast('Undone, but the previous curve could not be put back' + where, '#ff9090');
    else if (res.restored) OpenCurve.showCopyToast('Undone: the previous curve is back' + where, '#f0a030');
    else OpenCurve.showCopyToast('Undone: ' + res.removed + ' keyframes removed' + (name ? ' from ' + name : ''), '#f0a030');
  }

  // ─── Undo button ──────────────────────────────────────────────────────
  // The button always stays in place; with nothing to undo the whole button
  // (background and icon) is dimmed and inert
  function _showUndoBtn(show) {
    var btn = document.getElementById('undo-btn');
    if (btn) {
      btn.classList.toggle('btn-dim', !show);
      // Opaque grey, so a green Go doesn't show through (same as the UXP edition)
      btn.style.backgroundColor = show ? '' : '#2b2b2b';
      btn.style.backgroundImage = show ? '' : 'none';
      btn.style.color      = show ? '' : '#6f6f6f';
      btn.style.opacity    = '';
      btn.style.cursor     = show ? '' : 'default';
    }
    if (OpenCurve.fitGoForUndo) OpenCurve.fitGoForUndo();
  }

  document.addEventListener('click', function(e) {
    var btn = e.target.closest('#undo-btn');
    if (!btn || btn.classList.contains('btn-dim') || btn._ocSpin) return;
    if (OpenCurve.btnBusy) OpenCurve.btnBusy(btn, true);

    cs.evalScript('undoBake()', function(result) {
      if (OpenCurve.btnBusy) OpenCurve.btnBusy(btn, false);
      try {
        var res = JSON.parse(result);
        if (res.success) {
          if (!res.remaining) _showUndoBtn(false);
          _saveBakeRecords();
          _lastStatus = '';
          _skipPollUntil = 0;
          // Only the latest batch was popped: rows with other live records are
          // still baked. Clearing bakedParamKeys and forcing 'idle' greyed every
          // green row and showed "Open a project and select a clip" until the
          // next poll. The host dropped its cache, so a scan now repaints it.
          poll();
          _undoToast(res, null);
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
  // Poll Timing is hidden from the flyout since 2.1.0; set localStorage
  // 'opencurve-dev-menu' to 'on' and reopen the panel to get it back. While
  // hidden, a timing mode left on from before is ignored.
  var _DEV_MENU = (function() { try { return localStorage.getItem('opencurve-dev-menu') === 'on'; } catch(e) { return false; } })();
  var _debugTiming = _DEV_MENU && localStorage.getItem(_DEBUG_TIMING_KEY) === 'on';
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
    if (_pollRunning) {
      // If the ExtendScript engine is blocked (another extension's modal, a long
      // script elsewhere) the callback may never arrive, and the panel would then
      // poll nothing for the rest of the session with no sign of why.
      if (_pollStartedAt && Date.now() - _pollStartedAt > _POLL_STUCK_MS) {
        console.log('[OC-CEP] poll: abandoning a scan stuck for ' + (Date.now() - _pollStartedAt) + 'ms');
        _pollRunning = false;
        _needFull = true;
      } else {
        if (_debugTiming && _dbgStats) _dbgStats.dropped++;
        return;
      }
    }
    if (OpenCurve.isDragging) return;
    var s = OpenCurve.getState();
    if (s.isBaking) return;
    if (Date.now() < _skipPollUntil) return;

    _pollRunning = true;
    _pollStartedAt = Date.now();
    var _myPoll = ++_pollToken; // an abandoned scan must not clear the flag or apply its result

    var _t0 = _debugTiming ? Date.now() : 0;
    cs.evalScript('detectContext(' + (_needFull ? 'true' : 'false') + ')', function(resultStr) {
      if (_pollToken !== _myPoll) return; // abandoned; a newer scan owns the state
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

      if (result.status !== 'unchanged') _needFull = false;
      // Nothing changed since the last poll — the host skipped the full scan.
      // Keep the current UI state untouched (no setState, no re-render).
      if (result.status === 'unchanged') {
        if (typeof result.ph === 'number') { if (_lastPh !== null && result.ph !== _lastPh) _phMovedAt = Date.now(); _lastPh = result.ph; }
        if (_debugTiming) _dbgRecord(_dbgK, _tDet, result, _t0, 0, result.ph);
        return;
      }

      // Scanning continues during playback (the 1.x pause option was removed in 2.0.0)
      // The no-project / no-sequence / error results carry no ph; treating that
      // undefined as a move made _phMovedAt lie, and Space within 700ms of one
      // then told ocTransport the playhead was moving and inverted the QE toggle.
      var ph = result.ph;
      if (typeof ph === 'number') {
        if (_lastPh !== null && ph !== _lastPh) _phMovedAt = Date.now();
        _lastPh = ph;
      }

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
    + (_DEV_MENU ? '<MenuItem Id="poll-timing" Label="Poll Timing (Debug)" Enabled="true" Checked="false"/>' : '')
    + '<MenuItem Label="---"/>'
    + '<MenuItem Id="version" Label="OpenCurve 2 - v' + OpenCurve.CURRENT_VERSION + ' - ZXP" Enabled="false" Checked="false"/>'
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
      if (menuId === 'poll-timing' && _DEV_MENU) _toggleDebugTiming();
    } catch(e) {
      console.error('[OC-CEP] flyout menu error:', e);
    }
  });

  // ─── Init ────────────────────────────────────────────────────────────────
  function init() {
    console.log('[OC-CEP] Initializing panel');
    OpenCurve.initPanel();
    _loadBakeRecords();
    _showUndoBtn(false); // nothing from this session yet: start greyed out, inline like later
    var undoBtn = document.getElementById('undo-btn');
    if (undoBtn && OpenCurve.attachTooltip) {
      undoBtn.removeAttribute('title');
      OpenCurve.attachTooltip(undoBtn, function() { return undoBtn.classList.contains('btn-dim') ? 'Nothing to undo' : 'Undo last bake'; });
    }

    // First launch of a release with a What's new card (shared, in plugin-ui.js).
    // It replaced this edition's first-run warning about the .zxp's limits,
    // whose key is dropped here. The card stands in for the update toast.
    localStorage.removeItem('opencurve-cep-splash-seen');
    var _welcomed = OpenCurve.showWelcome();

    // Check for post-update toast
    // "Updated to vX" toast. Nothing in the CEP edition ever set the
    // opencurve-post-update flag this used to read (that key belongs to the UXP
    // updater), so the toast could never appear. It now compares the version it
    // last ran against, which also means no hardcoded version to bump here.
    localStorage.removeItem('opencurve-post-update'); // from an older build
    try {
      var _verKey = 'opencurve-cep-version';
      var _seen = localStorage.getItem(_verKey);
      var _now  = OpenCurve.CURRENT_VERSION;
      if (_seen && _now && _seen !== _now && !_welcomed) {
        setTimeout(function() {
          OpenCurve.showCopyToast('Updated to v' + _now, '#3ddc84');
        }, 500);
      }
      if (_now) localStorage.setItem(_verKey, _now);
    } catch(e) {}

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
