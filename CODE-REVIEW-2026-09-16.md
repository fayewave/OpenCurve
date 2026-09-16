# OpenCurve full code review — 2026-09-16

Reviewed at commit `692aa21` on `v2-dev` (version 2.0.0). Scope: `src/plugin.js` (7413 lines), `cep/js/plugin-ui.js` (5201), `cep/js/cep-bridge.js`, `cep/jsx/host.jsx`, both stylesheets, both HTML files, both manifests, `src/loader.js` (read only), plus a cross-edition drift check of every block CLAUDE.md says must be identical.

## Status — worked through on 2026-09-16

**69 findings fixed and one partly fixed, out of 76**, committed on `v2-dev` in
17 commits, each naming the findings it closes. ✅ marks a finding as done, ⏸️ one
left for you to decide, ❌ one deliberately not applied.

| | |
|---|---|
| Fixed | 69 |
| Partly applied (✅) | F12 |
| Left for you (⏸️) | B8, D8, E9, H2, H3 |
| Declined, with a reason (❌) | C9 |

Each ⏸️ / ❌ finding carries a note under its heading saying why. In short: two
are pure refactors with no user-visible change that I would rather not do blind
(D8, E9), two touch things I cannot verify without opening Premiere (H3) or that
are yours to decide (H2, B8), and one has a cure worse than the disease (C9).

**How it was verified.** There is no test harness in this repo and the panel only
runs inside Premiere, so behaviour was pinned down by extracting the pure
functions and exercising them in node. Six suites were written and all pass:
curve text round trips and clamping, tween cancellation, multi-point sampling
equivalence, preset storage validation, the host's JSON fallback, and the bake
fingerprint check (4012 cases against the original implementation). Where a fix
claimed to repair a bug, the suite was first run against the pre-fix file to
confirm it failed there. All four JS files parse, no stray invisible characters
were introduced, and line endings are unchanged (`src/plugin.js` LF, the three
CEP files CRLF).

**Cross-edition drift is now zero.** A checker compares every function CLAUDE.md
says must be identical: 78 of them match apart from comments. It caught one real
bug mid-way — the CEP edition had no `_statusMsg`, so a fix ported from UXP would
have thrown on every timeline hover — which is why both editions now share that
helper.

**Not in the original review, found while fixing:** `_clipStart` became unused
once `_clipInfo` replaced it, and `_ocElReset` would have been dead the moment I
wrote it, so neither was left behind.

**CLAUDE.md was updated** (it is gitignored, so those edits are local only) for
everything a future session would otherwise get wrong: the release checklist is
five steps now rather than six, the new `opencurve-cep-version` key, the loader's
actual state, the render-path rules that must stay change-gated, the poll and
undo changes, and what Reset All Settings now does.

**Worth a look in Premiere before release**, since none of it can be exercised
here: a bake and a per-property undo in both editions, Reset All Settings, the
preset export/import round trip (the HIGH fix), and a drag on the preset list in
grid view.

## How to use this document

- Findings are grouped by area and numbered (`A1`, `B2`, ...) so they can be referred to individually. Severity, confidence and a concrete fix are given for each.
- **Every finding respects CLAUDE.md.** None of the documented UXP workarounds (inline layout styles, change-only writes, `_refreshScroller`, the key sink, `_centerIcons`, sync transactions, etc.) are reported as problems. Do not "simplify" those while fixing.
- **Most shared-UI findings apply to both editions.** Each finding says whether the same code exists in `cep/js/plugin-ui.js` (or `host.jsx`). Fix both, keep the blocks identical, as CLAUDE.md requires.
- Lines are as of `692aa21`. They will shift as fixes land; search by function name.
- Suggested order: the HIGH items first (three user-visible bugs), then the MEDIUM correctness items, then the MEDIUM performance items on the poll/pointermove hot paths, then LOW cleanups. Commit after each completed change (user preference).
- Do **not** modify `src/loader.js` (H2 explains its state; the decision there is documentation/config, not code).

## Summary

| Severity | Count | Headline items |
|---|---|---|
| HIGH | 3 | Preset import drops every plain preset (A1); a running curve tween overwrites direct edits and can commit phantom anchors (A2); CEP starts blue instead of green (F1) |
| MEDIUM | 22 | Undo-next-to-Go deletes records it couldn't undo (B1, G1); clip-at-cut test is end-inclusive in both editions (B3); Settings modal stacks (E1); update tile un-dismisses on every panel show (E2); Reset All depends on `location.reload()` (E3); key auto-repeat drives transport/presets (C1); hot-path DOM writes in `renderUI`, `_tlRender`, hover readout, drag-sort, graph hover (C2–C4, F2, D4, A5); idle poll IPC redundancy (B2, B3); CEP host quadratic fingerprint check (G4); CEP JSON fallback invalid (G2); CEP import duplicates records (G5/F3); unclamped pasted curves (A3/D3); corrupt preset storage kills the panel (D2) |
| LOW | ~30 | dead code (`_dumpComponents`, `_kfCount`, `new-preset-btn` guards, dead CSS, unused exports), small races, missing validation, duplication |

---

## A. Curves, bezier math, graph editor (`src/plugin.js` 1–1290)

### ✅ [HIGH] A1. `_curveFromText` only parses `opencurve(...)`, so Import Presets skips every plain preset and Numeric Entry's "As text" refuses `cubic-bezier()`
- **File:** src/plugin.js:542-556; callers 5468 (import round trip), 6898 (numeric panel `applyText`), 5394 (`_parseCubicBezier`)
- **Category:** correctness · **Confidence:** high
- **What:** `_curveFromText` matches `/opencurve\(/` only. `_curveToText` (533) emits `cubic-bezier(...)` for every curve without `pts`, so the import validator `_curveFromText(_curveToText(raw))` returns null for every plain preset. The `typeof raw === 'string'` branch has the same gap. The numeric panel's text field calls `_curveFromText` directly, not `_parseCubicBezier`. Verified in node: `_curveFromText(_curveToText({p1x:0.42,p1y:0,p2x:0.58,p2y:1}))` → `null`.
- **Failure / impact:** Export Presets then Import the same file: every Ease/Cubic/Quint/Expo/Back preset is "skipped", toast says "Nothing new to import"; only multi-point Bounce survives. Typing `cubic-bezier(0.42, 0, 0.58, 1)` into Numeric Entry > As text is rejected with a message promising that exact format.
- **Suggested fix:** Move the `cubic-bezier` regex from `_parseCubicBezier` (5394-5403) into `_curveFromText` as the fallback branch (returning `_normalizeCurve({p1x,p1y,p2x,p2y})`), and make `_parseCubicBezier` simply call `_curveFromText`. Combine with A3 so the fallback clamps. **Same code in cep/js/plugin-ui.js:432 (callers 3431, 3501, 4672).**

### ✅ [HIGH] A2. A running 150 ms curve tween is never cancelled by a direct edit, so the tween overwrites the edit and can commit padded phantom anchors
- **File:** src/plugin.js:150-177 (`_animateToCurve`), 407-412 (`_commitCurve`), 1088-1147 (graph pointerdown/move), 1240-1253 (`endDrag`)
- **Category:** correctness · **Confidence:** high
- **What:** `_curveAnimRaf` is only cancelled by the next `_animateToCurve`. `_commitCurve` (Add Point, arrow nudge, numeric fields, Delete/Smooth point) and the graph press/drag call `setState` without cancelling it, so the RAF keeps writing intermediates and its last frame writes the old target. Multi-point intermediates carry `_matchCurves` padding anchors; a press inside the window clones them into `liveCurve` and `endDrag` commits them.
- **Failure / impact:** Press `3` then an arrow key within 150 ms: nudge lost. Preset then Add Point immediately: point vanishes. Bounce preset then grab a handle within 150 ms: on release the curve keeps de Casteljau padding anchors the user never added (visible as points, in `_curveToText`, and in the bake).
- **Suggested fix:** Add `_cancelCurveAnim()` (cancel the RAF, null `_curveAnimRaf` and `_animVis`); call it at the top of `_animateToCurve`, `_commitCurve`, and the graph `pointerdown` before cloning state. **Same in cep/js/plugin-ui.js:40-67 and its `_commitCurve` / pointerdown.**

### ✅ [MEDIUM] A3. `_normalizeCurve` never clamps `p1y`/`p2y`, clamps nothing for a plain curve, and `_parseCubicBezier` doesn't clamp x
- **File:** src/plugin.js:311-334; also 542-556, 5394-5403
- **Category:** robustness · **Confidence:** high
- **What:** The `pts` branch clamps anchors/handles but leaves `p1y`/`p2y` as parsed; the no-`pts` branch returns immediately. `opencurve(0, 999, 1, 1, ...)` keeps `p1y: 999`. `_parseCubicBezier` accepts `cubic-bezier(5, 0, -3, 1)`, making x(t) non-monotonic so `_tForX` returns garbage. Graph handles are held to x 0..1 and y `Y_CLAMP_MIN..Y_CLAMP_MAX`; pasted/imported text bypasses that.
- **Failure / impact:** Paste `cubic-bezier(1.5, 0, -0.5, 1)`: the preset saves, clicking it puts a non-function curve on the graph; `y = 50` flattens the thumbnail via `_curveYBounds`; Go bakes values far outside the keyframe pair on Position/Scale (only Opacity is clamped in the bake).
- **Suggested fix:** In `_normalizeCurve`, before the early return, clamp `p1x`/`p2x` to 0..1 and `p1y`/`p2y` to `Y_CLAMP_MIN..Y_CLAMP_MAX`; route every text parse (A1) through `_normalizeCurve`. **Same in cep/js/plugin-ui.js (`_normalizeCurve` ends ~221, `_parseCubicBezier` 3429-3438, `_curveFromText` 432).**

### ✅ [MEDIUM] A4. The tween's per-frame `setState` fans out to a full `renderUI` plus an unconditional strip cursor write, though `renderUI` never reads the curve
- **File:** src/plugin.js:166-175, 141-146; listeners 5838-5845 (`_updateStripCursor`), 5903 (`renderUI`)
- **Category:** performance · **Confidence:** high
- **What:** ~9 frames each run `renderUI` (no `curve` access in 3942-4112) plus `_updateStripCursor`, which writes `statusStrip.style.cursor` without comparing (a UXP relayout per frame). The graph is already redrawn via `onUpdate`.
- **Failure / impact:** Every preset click / Flip / Invert / `_loadBakedCurve` costs ~9 extra renderUI passes and relayouts in the CCX.
- **Suggested fix:** Keep the tween visual-only and `setState` once on the last frame (safe once A2 is in); make `_updateStripCursor` compare before write (also D6). **Keep CEP 40-67 in sync.**

### ✅ [MEDIUM] A5. Graph hover path writes `svg.style.cursor` and measures the SVG twice on every pointermove
- **File:** src/plugin.js:1158-1183 (1162)
- **Category:** performance · **Confidence:** high
- **What:** Every non-drag move writes `svg.style.cursor` unconditionally, calls `getBoundingClientRect()` twice (in `hitTest` and for `rect2`) and clones state twice.
- **Failure / impact:** One relayout per mouse move over the graph in the CCX plus two layout reads.
- **Suggested fix:** A closure `setCursor(v)` that writes only on change (use in pointerdown/endDrag too); one rect per move passed to `hitTest(e, rect)`; reuse the state clone. **Same code in cep/js/plugin-ui.js:1042-1060.**

### ✅ [LOW] A6. Pressing a handle without moving it clears the active preset
- **File:** src/plugin.js:1240-1253, 1131-1147
- **Category:** correctness · **Confidence:** medium
- **What:** `endDrag` always does `setState` + `clearPresetActive()` even when no `pointermove` happened.
- **Failure / impact:** Click a preset, click (don't drag) a handle: the tile un-highlights though the curve is unchanged.
- **Suggested fix:** Track a `moved` flag; skip the commit when `!moved`. **Same in cep/js/plugin-ui.js:1120-1131.**

### ✅ [LOW] A7. Peak-mode redraw samples the velocity three to seven times per pointer event
- **File:** src/plugin.js:782-808, 1214-1226, 1163-1167, 731-747
- **Category:** performance · **Confidence:** high
- **What:** `_updatePeakSVG` runs `_peakOf` + `_velSamples` + `_peakBellPath` (which resamples); `_applyPeakPointer` runs `_solvePeak` (4× `_peakOf`) then `_peakOf` again, then `_updatePeakSVG`.
- **Failure / impact:** ~1,000 `_velAt` calls per move for plain curves; ~1,500 `_segsOf` allocations per redraw for multi-point curves in A-curve mode.
- **Suggested fix:** Let `_peakBellPath` take/return samples and `vmax`; have `_solvePeak` return its last peak. **Same in cep/js/plugin-ui.js ~674.**

### ✅ [LOW] A8. `_sampleMulti` rebuilds the segment list on every sample
- **File:** src/plugin.js:304-308, 257-267
- **Category:** performance · **Confidence:** high
- **What:** `_segsOf(c)` is allocated per x in every sampling loop (`_curveYBounds`, `_velSamples`, bake loop, tile dot).
- **Suggested fix:** Optional `segs` argument computed once by loop callers. **Same in CEP; host.jsx unaffected.**

### ✅ [LOW] A9. `window` keydown/keyup Shift listeners are dead in the UXP edition
- **File:** src/plugin.js:1258-1263
- **Category:** dead-code · **Confidence:** high
- **What:** Per CLAUDE.md, window key listeners never fire in UXP; the drag hot path's `_setSnapBg(e.shiftKey)` already covers it.
- **Suggested fix:** Drop from the UXP file or route through `_onPanelKey`. CEP (1136-1141) does receive them and can keep them.

### ✅ [LOW] A10. `updateDynamicSVG` / `_updatePtsSVG` redo constant attribute writes and element lookups on every drag frame
- **File:** src/plugin.js:631-659, 1044-1060, 963-968
- **Category:** performance · **Confidence:** medium
- **What:** Eight `getElementById` per move plus four smooth/broken attribute writes per point that rarely change.
- **Suggested fix:** Cache the static element handles; store `broken` on each `_ptEls` record and write only on flip. **Same in CEP.**

**Clean:** bezier math and `_tForX` fallback, `_segTForX`, `_splitCurveAt`, `_matchCurves`/`_lerpCurve`/`_visOf`, `_setHandle`/`_mirrorHandle` (presets always cloned before mutation), Flip/Invert, `_solvePeak`/`_peakOf`, `_rangeBox`/`normToSVG`/`svgToNorm`, `_updatePtsSVG` pooling, `_setSnapBg` and `onResize` change gates.

---

## B. Premiere API, detection, bake, records, undo (`src/plugin.js` 1287–2712)

### ✅ [MEDIUM] B1. Undo-next-to-Go drops a whole batch when its stale param handles throw
- **File:** src/plugin.js:2640-2665 (`_undoRecords` phase 1); caller `_undoLastBake` 2609-2621
- **Category:** correctness · **Confidence:** medium
- **What:** For a record on a clip other than the one under the playhead, `_undoRecords` uses `rec.param`, the proxy kept from bake time. If `getKeyframeListAsTickTimes` throws on it (the documented staleness), `catch(_) { continue; }` at 2652 skips the record. When every record in the batch is skipped, `jobs.length === 0 && unreachable === 0`, so the "already gone" branch at 2662 runs `_dropBake` on all of them.
- **Failure / impact:** Bake on clip A, move to clip B, press Undo next to Go: keyframes stay on A, toast says they are gone, records are deleted from localStorage; the row's green state, row undo and curve button are lost. Only Ctrl+Z reverts.
- **Suggested fix:** `catch(_) { unreachable++; continue; }` so it takes the "Move the playhead over that clip" path and keeps the records; optionally re-resolve a live handle via `rec.clipId`. CEP host has a related but different bug, see G1.

### ✅ [MEDIUM] B2. Idle poll re-fetches the selection identity up to four times per tick
- **File:** src/plugin.js:2296-2340, 1447-1468, 2126-2140
- **Category:** performance · **Confidence:** high
- **What:** Every 100 ms the cache check does `getSelection` + `getTrackItems` + 3 sequential awaits per selected item. On a selection change the snapshot block at 2322 repeats the identical calls, then `_clipViaSelection` fetches the selection a third time and `_clipIdentity` again (plus `_clipStart`/`_clipEnd` re-reading values the identity just read).
- **Failure / impact:** ~2+3N sequential IPC round trips per idle tick, 3× that on a selection change (5 clips selected: ~17 idle, ~50 on change).
- **Suggested fix:** Fetch `selItems` once per `detectContext`, `Promise.all` the identities (and the three getters inside `_clipIdentity`), reuse for check + snapshot, pass into `_detectContextFull`; have `_clipIdentity` return `{id, name, start, end}`. UXP only.

### ✅ [MEDIUM] B3. Track scan reads start/end of every clip on every full scan, and the containment test is end-inclusive
- **File:** src/plugin.js:1409-1445 (1434), 1400-1406
- **Category:** performance + correctness · **Confidence:** high
- **What:** With nothing selected, every playhead move and each heartbeat awaits `getStartTime` then `getEndTime` sequentially for every track item on every track; hits then re-read start/end/name in `_clipIdentity`. Nothing is cached across polls. Separately, `ph >= s && ph <= e` treats Premiere's exclusive `end` as inside, so a playhead exactly on a cut reports the outgoing clip (and its `phLocal` equals its out-point, so the status is "outside" even when the incoming clip has a pair starting there).
- **Failure / impact:** 400+ sequential round trips per moved playhead on a 200-clip sequence, continuously during playback. Parking the playhead on the first frame of a keyframed clip that butts against a previous clip shows "Move playhead between keyframes" with the wrong clip's properties.
- **Suggested fix:** `Promise.all` per track; pass known `s`/`e` to `_clipIdentity`; cache `{item, s, e}` per track refreshed on the heartbeat, like the CEP host's `_ocTracks`. Change the test to `ph < e`. **Same end-inclusive test in cep/jsx/host.jsx:230 (`_ocClipsAt`), see G3.**

### ✅ [LOW] B4. Value at kf0 read twice per valid property; the component walk is fully sequential
- **File:** src/plugin.js:1540, 2222-2226, 2131/2151/2158
- **Category:** performance · **Confidence:** high
- **What:** `_findQualifiedParams` fetches `getValueAtTime(kf0)` and discards it; `_detectContextFull` refetches kf0 and kf1 one after another per valid property; `_clipInPoint` is awaited twice for the same clip.
- **Suggested fix:** Keep `val0` on the qualified entry, `Promise.all` for `val1`; batch `getParam`/keyframe lists per component; hoist `clipIn`.

### ✅ [LOW] B5. `_kfCount` is dead and would not work if called
- **File:** src/plugin.js:2705-2710
- **Category:** dead-code · **Confidence:** high
- **What:** No callers; calls the async proxy synchronously and `Array.from`s a promise, always 0.
- **Suggested fix:** Delete. Not in cep/.

### ✅ [LOW] B6. Unused cache fields and record field
- **File:** src/plugin.js:2148, 2170, 5914-5915, 5920, 5929; 2460, 2473, 2567
- **Category:** dead-code · **Confidence:** high
- **What:** `_cache.clipStartSec`, `_cache.clipStrategy`, `_cache.lastResultAt` are written but never read; bake records carry an unread `fps`.
- **Suggested fix:** Remove them (keep the `r.fps || 0` tolerance in `_loadBakeRecords` for old stored records).

### ✅ [LOW] B7. Compound params with more than two components are silently truncated
- **File:** src/plugin.js:1368-1375, 2395-2399
- **Category:** robustness · **Confidence:** medium
- **What:** `_extractValue` accepts any non-empty array, but the bake writes `new ppro.PointF(v[0], v[1])`, so a 3-component keyframed value shows as a bakeable row and would be written as a 2D point (or throw in the transaction).
- **Suggested fix:** Accept only length-2 arrays; check the CEP host's extraction for the same rule.

### ⏸️ [LOW] B8. `_dumpComponents` is ~540 lines of exploratory probe code whose question has been answered

> **Not applied — your call.** Deleting ~540 lines is easy to do and easy to regret. The probe still prints a full component/property listing, which is the fastest way to answer "what does Premiere expose on this clip" in a user bug report, and it costs nothing unless the flyout item is used. Say the word and it goes, or it can be trimmed to Section 1 only.
- **File:** src/plugin.js:1555-2094
- **Category:** dead-code · **Confidence:** high
- **What:** Reached only from the flyout's `dump-comps` item; its purpose (find Time Remapping) is settled. No runtime cost.
- **Suggested fix:** Delete with the flyout item, or trim to Section 1 (component/param listing), which is still useful for user bug reports. Ask the user before deleting if unsure.

**Clean:** `_fpsDetect`/`_fps`, `PARAM_NAMES`/`_paramName`, `_nearestPair`/`_jumpPair`, the bake loop (step clamp, `f < totalFrames`, opacity clamp, media-seconds time base), `_recordBakes` alignment, bake record load/save, `_recAlive`/`_recHere`/`_bakedKeysFor` matching rules, the Go handler's `isBaking`/`_skipPollUntil` error path. Not verifiable here: whether speed-changed clips need `getSpeed` folded into `phLocal` (the code never reads speed).

---

## C. Keyboard, preview engine, mini timeline, renderUI (`src/plugin.js` 2713–4431)

Context: `poll()` is diff-gated by `_pollSig`, but the signature includes `tl.ph`, so during playback or scrubbing `setState` → `renderUI` → `_tlRender` runs on every 100 ms poll. `_animateToCurve` and `endDrag` also call `setState` per tween frame / drag end.

### ✅ [MEDIUM] C1. Space / J / K / L / P / 1-9 act on key auto-repeat
- **File:** src/plugin.js:2898-2913 (`_panelShortcut`)
- **Category:** correctness · **Confidence:** high
- **What:** The transport keys, P and the digits are handled before `if (e.repeat) return false;`, so a held key fires them at the OS repeat rate. `_onPanelKey` (4601) only filters `e.repeat` for Enter.
- **Failure / impact:** Hold Space: `_transport('toggle')` starts and stops the preview ~30×/s, each start awaiting three host calls. Holding L doubles the shuttle rate per repeat (1→2→4→8); holding P restarts the pair preview; holding a digit restarts the preset tween.
- **Suggested fix:** Move `if (e.repeat) return false;` to the top (after `lk`), keeping only the arrow-key branch above it. **Same in cep/js/plugin-ui.js:1330-1345.**

### ✅ [MEDIUM] C2. `renderUI` writes ~8 + 8-per-row unchanged styles/attributes on every state change
- **File:** src/plugin.js:4017-4044 (rows), 4053-4082 (strip), 4090-4099 (Go)
- **Category:** performance · **Confidence:** high
- **What:** Per row: `undoEl.style.display`, `curveEl.style.display`, six `setAttribute`s via `_setMarker`, four `classList.toggle`s, four `querySelector`s. Strip: `clipEl.textContent`, `clipEl.style.display`, three `style.color`s, three marker attributes. Go: three `style.display`s. None compare before writing, unlike the `className`/`textContent` lines beside them.
- **Failure / impact:** With 6 rows, ~60 DOM writes and 24 querySelectors per call, at 10 Hz during playback/scrub and on every tween frame, for state where only `tl.ph` or `curve` changed.
- **Suggested fix:** Cache row children at build time (`btn._oc = {marker, pin, undo, curve}`); make every write change-only (`_setMarker` gets a `host._ocMode` cache); or skip the rows/strip/Go sections when a small key of `status|clipName|isBaking|selected|valid|baked` is unchanged, leaving `_tlRender` and `_centerIcons` to run. **Same in cep/js/plugin-ui.js:2423-2512.**

### ✅ [MEDIUM] C3. `_tlSetGoWidth` + `_tlUpdateFade` force six layouts on every `_tlRender`
- **File:** src/plugin.js:3245-3247
- **Category:** performance · **Confidence:** high
- **What:** Both run after the sig check, unconditionally: two + four `getBoundingClientRect` per call, including 10 Hz playback ticks and tween frames when only the playhead line moved. The scrollbar/fade only change on rebuild (row count, height, width), on scroll (already handled by the `scroll` listener in `_wireTlScroll`), or on handle drags (which call them directly).
- **Suggested fix:** Move both calls inside `if (force || sig !== _tlSig) { ... }`. The sig has `H` and `n`, and `measure()`/`_tlApplyHeight`/`_applyTimelineVisibility` all pass `force`. **Same in cep/js/plugin-ui.js:1679-1680.**

### ✅ [MEDIUM] C4. `_tlHighlightLane` rewrites every lane's fill on every pointer move
- **File:** src/plugin.js:3472-3474; caller 3707-3714
- **Category:** performance · **Confidence:** high
- **What:** Sets `fill` on all n lane rects each move even when the hovered lane is unchanged. `_tlRowHover` beside it has the `if (_tlHoverKey === key) return;` guard; the lane side doesn't.
- **Suggested fix:** Keep `_tlLitKey`, return early when equal, touch only the two rects involved; reset it in `_tlBuild` where `_tlLanes` is cleared. **Same in cep/js/plugin-ui.js:1887-1889.**

### ✅ [MEDIUM] C5. Timeline hover readout runs a full `renderUI` on almost every pointer move
- **File:** src/plugin.js:3494-3503 (`_tlComposeReadout`) via `_tlShowReadout` from the lanes' `pointermove`
- **Category:** performance · **Confidence:** high
- **What:** The readout carries `frame N`, so it changes nearly every pixel, and each change calls `renderUI(getState())`: the whole row sync pass, strip rewrite, then `_tlRender` (signature string over every keyframe of every property, plus the six rect reads of C3). About 6 forced-layout reads and dozens of DOM writes per mouse move, on top of the value request already sent per position.
- **Suggested fix:** Extract the status-text composition from `renderUI` into `_renderStatusText(s)` and have `_tlComposeReadout` call only that; full `renderUI` only when the readout is cleared. **Same in cep/js/plugin-ui.js:1911-1922.**

### ✅ [LOW] C6. Final preview tick can stop a newer preview and jump to its start
- **File:** src/plugin.js:2988-2997 (`_pvTick`)
- **Category:** correctness · **Confidence:** high
- **What:** The completion callbacks call `_pvStop(true)` / `_pvStop()` without checking `_pv === st`; `_pvStop` acts on whatever `_pv` currently is.
- **Failure / impact:** Pair preview on its last `_hostSetPlayhead` when the user presses L: the old tick's `.then` kills the new shuttle and sends the playhead to its `from`.
- **Suggested fix:** `if (done && _pv === st) _pvStop(true);` and `if (_pv === st) _pvStop();`. **Same in cep/js/plugin-ui.js:1420-1429.**

### ✅ [LOW] C7. Timeline signature omits `tl.clipStart` and `tl.fps`
- **File:** src/plugin.js:3235-3241
- **Category:** correctness · **Confidence:** medium
- **What:** In keyframe zoom the sig's range comes from keyframes only, but the second lines use `tl.clipStart` as origin (3300) and `_tlRuns` uses `tl.fps`; neither is in the sig.
- **Failure / impact:** With keyframe zoom on, trim the clip's head: `clipStart` and `clipIn` move together so the sig matches, and the second lines stay put while the hover readout shows new clip-relative times.
- **Suggested fix:** Append `Math.round(s.tl.clipStart * 1000)` and `s.tl.fps` to the sig. **Same in cep/js/plugin-ui.js:1667-1673.**

### ✅ [LOW] C8. `_tlPlaceGhost` / `_tlPlacePlayhead` write five attributes when the position hasn't changed
- **File:** src/plugin.js:3417-3432, 3403-3414
- **Category:** performance · **Confidence:** high
- **What:** The ghost time is snapped, so moves inside one frame's pixel span produce the same `x`; the playhead is re-placed on every renderUI call including tween frames.
- **Suggested fix:** Early-return in `_tlPlaceGhost` when `sec` equals the previous `_tlGhostSec`; store the last rounded `x` on `_tlPh` and skip when unchanged (the rebuild resets `_tlPh`). **Same in cep/js/plugin-ui.js:1831-1860.**

### ❌ [LOW] C9. Value readout shows the previous position's value under the new time

> **Not applied — the fix is worse than the defect.** Clearing the value on every move makes it blink out and back on each request, many times a second while the pointer travels. The stale value is at most one host read old (a single `getValueAtTime` in UXP), so it tracks the pointer closely and never misleads by more than a frame or two. Worth revisiting only if the host read ever gets slow.
- **File:** src/plugin.js:3486-3495, 3513-3532
- **Category:** correctness · **Confidence:** medium
- **What:** When the pointer moves while `_tlValBusy`, the new position is queued but `_tlValText` keeps the old value, which `_tlComposeReadout` prints beside the new time until the queued read answers.
- **Suggested fix:** In `_tlShowReadout`, clear `_tlValText = ''` when `moved` before `_tlRequestValue(info)`. **CEP shares this block.**

### ✅ [LOW] C10. Property rows are rebuilt only when the key list changes, so a swapped effect keeps the old label
- **File:** src/plugin.js:3947-3952
- **Category:** correctness · **Confidence:** high
- **What:** `renderUI` compares `propBtns.dataset.keys` (joined `compIdx_propIdx`) and sets `displayName` only at build; the lane signature does include the name, so lanes update but rows do not.
- **Failure / impact:** Delete one effect and add another so a component lands at the same index with a keyframed first property: the row still reads the old name while its lane, readout and bake go to the new one.
- **Suggested fix:** Include display names in the comparison, or set `.prop-label` text in the sync pass when it differs. **Same in cep/js/plugin-ui.js:2354-2359.**

### ✅ [LOW] C11. Redundant `if (_tlVisible)` inside `_tlSetGoWidth`; `_tlLaneH(n)` ignores its argument
- **File:** src/plugin.js:3620, 3192
- **Category:** dead-code · **Confidence:** high
- **Suggested fix:** Drop the inner `if`; optionally drop `_tlLaneH`'s parameter. **Same in cep/js/plugin-ui.js:2062.**

**Clean:** `_tlInit` after `_refreshScroller` (no stale closures); timer clearing (`_tipTimer`, `_pv.timer`); renderUI row listener lifecycle; division-by-zero guards in `_tlRange`/`_tlSecondXs`/`_tlSec`; time bases; modifier/focus handling in `_onPanelKey`; `_nudgeHandle` stale-handle guard. `_smoothWheel`, `_holdFixWatch`, `_refreshScroller`, `_centerIcons`, the scroll debug tooling and elimination switches are the documented workarounds and were left alone.

---

## D. `initPanel()`: presets, drag-sort, menus, zoom, toolbars (`src/plugin.js` 4432–5908)

### ✅ D1. (merged into A1) Import Presets drops every plain preset — fix at `_curveFromText`, and change src/plugin.js:5468 / cep/js/plugin-ui.js:3501 to validate through the combined parser.

### ✅ [MEDIUM] D2. Corrupt or non-array preset storage kills the whole panel at startup
- **File:** src/plugin.js:4997-5009 (`_loadPresetList`), 5001 (`_savePresetList`), 5361
- **Category:** robustness · **Confidence:** high
- **What:** `_loadPresetList` returns whatever JSON is in `opencurve-presets-v10` with no shape check. A truthy non-array or an entry without `curve` reaches `_renderPresets` → `_buildPresetBtn` → `_thumbPathD(preset.curve)` and throws inside `initPanel` before Go, Undo, the status strip and `stateListeners.push(renderUI)` are wired (5803-5904). `_savePresetList` has no try/catch, so a quota error escapes click handlers after the list/DOM were already changed.
- **Failure / impact:** A bad value in that key leaves a panel with no presets and a dead Go button, nothing explaining why. In CEP, `init()` never reaches `_loadBakeRecords`, `poll()` or the interval.
- **Suggested fix:** Accept only `Array.isArray(v)` with entries carrying string `id`/`name` and a curve with numeric `p1x..p2y` (drop bad entries), else return null for the defaults. Wrap `_savePresetList` in try/catch with a toast. **Same in cep/js/plugin-ui.js:3044-3055, 3394-3402.**

### ✅ D3. (merged into A3) Pasted `cubic-bezier()` control points stored unclamped — `_parseCubicBezier` src/plugin.js:5394-5403 / cep 3429-3438.

### ✅ [MEDIUM] D4. Drag-sort pointermove forces a layout and measures every tile on each move
- **File:** src/plugin.js:5286-5306 (also 5322-5325)
- **Category:** performance · **Confidence:** high
- **What:** Each pointermove writes the ghost's `left`/`top`, then reads `_dragGhost.offsetWidth/offsetHeight` and `getBoundingClientRect()` on every tile: a write-then-read forced layout plus N rect reads per move. The ghost's size never changes after creation.
- **Suggested fix:** Capture `gw`/`gh` at ghost creation; cache tile rects when `moved` becomes true and recompute only when `after` changes. **Same handler in cep/js/plugin-ui.js:3306-3371 (ghost read at 3329).**

### ✅ [LOW] D5. Drag-sort starts on any mouse button, re-applies layout on a plain click, and carries leftovers from the removed inline rename
- **File:** src/plugin.js:5241-5263, 5372-5388 (`endDragSort`)
- **Category:** correctness + performance · **Confidence:** high
- **What:** Pointerdown arms a drag and sets pointer capture for right/middle presses too; `endDragSort` calls `_applyPresetLayout(true)` when `_presetCols > 1` even with nothing moved (every tile's ~15 inline writes, `void list.offsetHeight`, the 200 ms timer). The 350 ms `_lastDownBtn/_lastDownTime` guard (5252-5259) and the `.preset-rename-input` check (5250) refer to a removed double-click rename.
- **Failure / impact:** Right-press a tile and drag a little before releasing: the tile moves and the context menu opens at once. A plain click on a preset in grid view rewrites the whole list's inline styles (each write relayouts in the CCX).
- **Suggested fix:** `if (e.button !== 0) return;` at the top; re-apply layout only when `moved`; delete the two leftovers. **Same in cep/js/plugin-ui.js:3281-3303, 3372-3388.** See also H5 on pointer-capture timing.

### ✅ [LOW] D6. `_updateStripCursor` writes `style.cursor` on every state change without comparing
- **File:** src/plugin.js:5838-5845
- **Category:** performance · **Confidence:** high
- **Suggested fix:** Compare before writing. **Same in cep/js/plugin-ui.js:3882.** (Also listed under A4.)

### ✅ [LOW] D7. Dead code left from removed features
- **File:** src/plugin.js:2935, 4460, 5248, 5250, 5294, 5327-5330, 5359-5362, 5417-5418, 5428-5432 (`new-preset-btn` lookups and "preserve the New tile" branches); 5250 (`preset-rename-input`); 5581, 5595-5596 (`showLayout` param, `_icGrid`, `_icList` in `_showMiniCtxMenu`); 4822-4827 (`opts.keepOpen`/`disabled`, never passed); 5252-5259 (double-click guard)
- **Category:** dead-code · **Confidence:** high
- **What:** `#new-preset-btn` no longer exists in either `index.html`, so every lookup is null and the branches are unreachable; no `.preset-rename-input` is created; `showLayout` and the two icons are unused since List/Grid left that menu; no caller passes `keepOpen`/`disabled`.
- **Suggested fix:** Remove them; simplify `_showMiniCtxMenu`'s signature and its call sites (4461, 5710, 5720-5721). **Same leftovers in cep/js/plugin-ui.js (1367, 3288-3290, 3336, 3366, 3397, 3451, 3461, 3612, 3626-3627, 3740).**

### ⏸️ [LOW] D8. Four menu builders and four copies of the placement / dismiss logic

> **Not applied — refactor with no user-visible change, and I cannot open the panel.** Four menu builders collapsing into one is a real maintenance win, but menu placement is exactly the code that depends on UXP's measuring quirks, and a mistake here is invisible until a menu opens in the wrong place in Premiere. Worth doing in a session where the panel can be loaded and each menu opened once. The Esc / resize dismissal from D9 is in already, wired through one `_closeMenus` hook, so the dismissal half is no longer duplicated.
- **File:** src/plugin.js:4803-4862, 4915-4983, 5019-5110, 5601-5699
- **Category:** duplication · **Confidence:** high
- **What:** The two toolbar `item()` builders are identical apart from the icon branch; `_ctxItem` and `_miniItem` differ only in the danger class and target menu. The "append at 0,0, measure, clamp, flip above, deferred pointerdown dismiss" block appears four times with inconsistent dismiss registration (window bubble vs the zoom slider's document capture).
- **Suggested fix:** One `_menuItem(menu, label, icon, onClick, opts)`, one `_placeMenu(menu, rectOrPoint)`, one `_armDismiss(menu, ignoreEls, hide)` on a capture-phase document listener. Keep the UXP placement rules (fixed sizes, anchor rect only). **Same in cep/js/plugin-ui.js.**

### ✅ [LOW] D9. Tile and mini context menus don't close on Esc or on layout changes
- **File:** src/plugin.js:5088-5110, 5693-5699
- **Category:** robustness · **Confidence:** medium
- **What:** `_ctxMenu` and `#_mini-ctx` close only on an outside pointerdown; a tile menu stays at its fixed position across a panel resize or `_refreshScroller` swap, and Esc only closes the zoom slider.
- **Suggested fix:** Have the Esc path also hide both, and call `_hideCtxMenu()` + remove `#_mini-ctx` from the `.main-row` ResizeObserver at 5785. **Same in cep/js/plugin-ui.js.**

**Clean:** preset aliasing (`setState`/`getState` deep-clone; New Preset and Overwrite clone; starter entries fresh; unique string ids). Zoom slider, key sink, `_tbLayout`/`_ptbLayout` (change-gated), column ResizeObserver, `_tileAnimHook`, Go handler. `_renderPresets` runs once at init and otherwise only from the debug-only `_SCROLL_KICK` 6 path, so `_initDragSort` listener stacking does not occur in shipped code.

---

## E. Poll, layout, updates, dialogs, Settings (`src/plugin.js` 5909–7413)

### ✅ [MEDIUM] E1. Settings modal can stack; the buried copy leaks its body ResizeObserver
- **File:** src/plugin.js:6953-6967, 7382-7405 (callers 106, 4637, 5639)
- **Category:** correctness · **Confidence:** high
- **What:** `_showSettingsModal` never checks for an existing `#settings-modal`. In-panel openers are covered by the modal, but the flyout menu item "Settings" (line 106) is Premiere's own menu and stays reachable, so a second modal is appended on top of the first.
- **Failure / impact:** Only the top one can be closed; the lower one stays in the DOM for the session and its `_settingsRO` keeps observing `document.body`. Repeat and the observers accumulate.
- **Suggested fix:** At the top: `var old = document.getElementById('settings-modal'); if (old) old.remove();` (the overridden `remove` disconnects the observer), or return if one is open. **Same in cep/js/plugin-ui.js:4721 (openers cep-bridge.js:453, plugin-ui.js:2684, 3670).**

### ✅ [MEDIUM] E2. Silent update check runs on every panel show, and each one un-dismisses the update tile
- **File:** src/plugin.js:6581-6583; caller: `show` entrypoint, line 87
- **Category:** correctness + performance · **Confidence:** high
- **What:** `_checkForUpdates(silent)` sets `_updateDismissed = false` unconditionally, and the UXP `show` entrypoint calls it every time the panel becomes visible (workspace/tab switch, dock/undock), not once per session like the CEP bridge (cep-bridge.js:537). No throttle, no fetch timeout/abort.
- **Failure / impact:** Dismiss the "Update Available" tile, switch workspace tab and back: it's back. Even when the fetch fails the flag is reset, so the tile returns at the next `_renderPresets` (5384 calls `_refreshUpdateNotification`), e.g. after saving a preset. Each show is an unauthenticated GitHub API call (60/hour limit).
- **Suggested fix:** `if (!silent) _updateDismissed = false;`; throttle the silent check with `_lastUpdateCheckAt` (skip within an hour) or a once-per-session flag matching CEP; optionally an `AbortController` 10 s timeout. **CEP `_checkForUpdates` (plugin-ui.js:4355-4356) has the same unconditional reset; only the per-show frequency is UXP-specific.**

### ✅ [MEDIUM] E3. Reset All Settings relies on `location.reload()`; if unavailable, memory and localStorage diverge
- **File:** src/plugin.js:6730-6760 (`_confirmReset`)
- **Category:** correctness · **Confidence:** medium
- **What:** The OK handler removes the keys, resets some globals, then `try { location.reload(); } catch(e) {}`. Nothing re-applies defaults: `_applyGraphVisibility`, `_applyTimelineVisibility`, `_setPeakMode(false)`, `_applyPresetLayout`, grid redraw and `_renderPresets` are not called; `_gridSize`, `_presetLayout`, `_tlPropsW`, sidebar width and the preset closure's `_presetList` (5006) are untouched. Nothing in the repo confirms `reload` works in UXP; the catch hides a failure.
- **Failure / impact:** If reload is a no-op: presets still listed, graph still hidden if it was off (while the flag says on, so the toggle needs two presses), and the next preset edit writes the old `_presetList` back to storage, undoing the reset.
- **Suggested fix:** Don't depend on reload: reset every in-memory value, call `_setPeakMode(false)`, `_setDragGhost(true)`, `_applyGraphVisibility()`, `_applyTimelineVisibility()`, `_tlApplyHeight()`, `_applyPresetLayout(true)`, redraw the grid, and expose a `_resetPresetList()` from the preset closure that rebuilds from built-ins + starters and calls `_renderPresets()`. Keep the reload attempt afterwards if desired. Decide (and comment) whether `opencurve-bake-records` belongs in "reset all" (see G5/F3: in CEP the reload re-imports them and duplicates the host's stack). **Same code in cep/js/plugin-ui.js:4503-4534 (reload works there; consistency only).**

### ✅ [LOW] E4. `poll()` has no watchdog: a `detectContext()` that never settles stops polling for good
- **File:** src/plugin.js:6009-6018, 6104-6106
- **Category:** robustness · **Confidence:** medium
- **What:** `_pollRunning` is cleared in `finally`, so throws are safe, but if an awaited proxy call never resolves the flag stays true forever and every later tick returns at 6010.
- **Suggested fix:** Record `_pollStartedAt`; at the top of `poll()` treat `_pollRunning && Date.now() - _pollStartedAt > 5000` as stale: log once, clear the flag, `_invalidateCache()`, continue. **Same guard for the CEP bridge poll (cep-bridge.js:325-336), where a blocked ExtendScript engine has the same effect.**

### ✅ [LOW] E5. `show` entrypoint starts a second poll interval if it fires without a matching `hide`
- **File:** src/plugin.js:82-88
- **Category:** robustness · **Confidence:** medium
- **Suggested fix:** `if (pollTimer) clearInterval(pollTimer);` before the `setInterval`.

### ✅ [LOW] E6. Stored grid size is not validated against its allowed values
- **File:** src/plugin.js:6142
- **Category:** robustness · **Confidence:** high
- **Suggested fix:** `if ([4, 8, 16].indexOf(_gridSize) < 0) _gridSize = 8;` (like `_bakeDensity` below it). **Same in cep/js/plugin-ui.js:3934.**

### ✅ [LOW] E7. `_openReleasesPage` clipboard fallback has no rejection handler
- **File:** src/plugin.js:6554-6565
- **Category:** robustness · **Confidence:** high
- **Suggested fix:** Add `.catch(function() { _showCopyToast('Could not open ' + url, '#ff9090'); })`. UXP only.

### ✅ [LOW] E8. Dead startup code: DOMContentLoaded colour hook and the `reset` flyout branch
- **File:** src/plugin.js:7409-7411; 111
- **Category:** dead-code · **Confidence:** high
- **What:** `create` (74) already calls `_applyCurveColor(_curveColor)` after `initPanel()`; the trailing `DOMContentLoaded` listener duplicates it. `invokeMenu` handles `id === 'reset'` but `menuItems` has no such entry.
- **Suggested fix:** Delete both.

### ⏸️ [LOW] E9. Five identical Settings toggle rows and three modal skeletons are copy-pasted

> **Not applied — same reason as D8.** Five Settings rows and three modal skeletons could share helpers, but every line of it is UI construction that only shows up when the modal is open in Premiere. One real difference is worth knowing either way: `_confirmDialog` has no Esc or overlay-press cancel, while `_renamePresetDialog` does.
- **File:** src/plugin.js:7114-7256 (notif/graph/timeline/ghost/hover rows), 6619-6728 and 6785-6934
- **Category:** duplication · **Confidence:** high
- **What:** Each toggle row is ~25 lines differing only in label, icon, tooltip, getter, setter. `_confirmDialog`, `_renamePresetDialog` and `_showNumericPanel` each rebuild the same overlay/box/button-row markup; only the rename dialog has overlay-press-to-cancel and Esc (`_confirmDialog` has neither).
- **Suggested fix:** A local `toggleRow(label, iconSvg, tooltip, get, set)` inside `_showSettingsModal`, and a shared `_modalShell(id, titleText)` returning `{ overlay, box, btnRow, close }` with overlay-press cancel and an Esc hook. **Same in cep/js/plugin-ui.js.**

**Clean:** `poll()` re-entrancy/error paths; `_pollSig` covers every field the renderers read; `_isNewerVersion` (1.10.0 > 1.9.0, leading `v`); `_applyPresetLayout` cache key; numeric panel validation and cancel restore; `_settingsRO` disconnect on in-modal close; `_loadPresetList` parse try/catch.

---

## F. CEP edition: `cep/js/plugin-ui.js` and `cep/js/cep-bridge.js`

### ✅ [HIGH] F1. Fresh CEP install gets a blue theme colour instead of the documented green default
- **File:** cep/js/cep-bridge.js:518; cf. cep/js/plugin-ui.js:3922 and 5157
- **Category:** correctness / drift · **Confidence:** high
- **What:** `init()` calls `OpenCurve.applyCurveColor(localStorage.getItem('opencurve-line-color') || '#4a9eff')`. plugin-ui.js already applied the colour on `DOMContentLoaded` with the real default `'#38fbb2'`; the bridge runs later (loaded last) and overrides it. The blue fallback dates from v1.2.1 and was never updated.
- **Failure / impact:** First run, or any launch after Reset All Settings: curve, endpoints, anchors, thumbnails and the active-preset tint are blue in CEP, green in UXP; the Settings hex field shows `#4A9EFF` and the blue swatch is outlined.
- **Suggested fix:** Delete bridge line 518 (plugin-ui.js already applies saved-or-default), or change the fallback to `'#38fbb2'`. CEP-only.

### ✅ F2. (merged into C5) Timeline hover readout runs full `renderUI` per pointer move — cep/js/plugin-ui.js:1911-1922.

### ✅ [MEDIUM] F3. `importBakeRecords` re-imports on `location.reload()` (and on any engine reuse) and duplicates the host's records
- **File:** cep/js/cep-bridge.js:205-213 (`_loadBakeRecords`), 512; cep/jsx/host.jsx:768-789; cep/js/plugin-ui.js:4503-4533 (`_confirmReset` → `location.reload()`)
- **Category:** correctness · **Confidence:** medium
- **What:** host.jsx is loaded via the manifest `ScriptPath` and keeps `_undoStack` as a top-level `var`. `location.reload()` reloads the page, not the ExtendScript engine, so the host still holds its batches while `init()` runs `_loadBakeRecords()` again with the same JSON (Reset does not remove `opencurve-bake-records`). `importBakeRecords` does `batches.concat(_undoStack)` with no dedupe by `id`, and `_ocSessionFloor = batches.length` then undercounts. The same happens if Premiere ever keeps the engine alive across a panel close/reopen.
- **Failure / impact:** Every restored record exists twice with the same id: `bakeIds` carries `id,id`, the row undo resolves the second copy and reports `skipped`, `remaining`/`_ocSessionFloor` are off so the Undo-next-to-Go can revert a previous session's batch, and the next export persists the duplicates.
- **Suggested fix:** In `importBakeRecords`, skip any record whose `id` already exists in `_undoStack` and raise `_ocSessionFloor` only by the batches actually added. Optionally have `_confirmReset` remove `opencurve-bake-records` before reloading if records are meant to reset (decision for E3). CEP-only; UXP loads records into a fresh context.

### ✅ [LOW] F4. Whole-batch undo blanks every green row and forces `status: 'idle'` until the next poll
- **File:** cep/js/cep-bridge.js:240
- **Category:** correctness · **Confidence:** high
- **What:** After a successful `undoBake()` the handler sets `bakedParamKeys: [], status: 'idle'`. The host only popped the latest batch; rows with other live records are still baked, and `idle` renders "Open a project and select a clip" with no clip name while a clip is under the playhead.
- **Failure / impact:** For up to one poll interval every green row goes grey and the strip shows idle text, then the forced full scan puts them back; visible flicker per Undo press.
- **Suggested fix:** Drop the `setState`; reset `_skipPollUntil = 0; _lastStatus = ''` and call `poll()` directly (the host already nulled `_ocCacheKey`). CEP-only.

### ✅ [LOW] F5. Post-update toast can never fire in the CEP edition
- **File:** cep/js/cep-bridge.js:523-529
- **Category:** dead-code · **Confidence:** high
- **What:** The bridge reads and clears `opencurve-post-update`, but nothing in `cep/` ever sets it (the key is written by the UXP updater, which CEP does not have). Yet CLAUDE.md lists this hardcoded version string as one of the six release-time bumps.
- **Suggested fix:** Either remove the block and the bump step from CLAUDE.md, or make it real: store the last-seen `CURRENT_VERSION` in localStorage and toast when it differs, which also removes the hardcoded string. CEP-only.

### ✅ F6. (merged into E4) CEP poll loop has no watchdog on the `evalScript` callback — cep-bridge.js:325-336.

### ✅ F7. (merged into C10) Property rows keep the old label when a component is swapped at the same index — cep/js/plugin-ui.js:2354-2359.

### ✅ F8. (merged into D5) Drag-sort starts on any button and re-applies layout on a plain click — cep/js/plugin-ui.js:3281-3302, 3372-3388.

### ✅ [LOW] F9. Import Presets rejects a UTF-8 file saved with a BOM
- **File:** cep/js/plugin-ui.js:3490-3495; cep/js/cep-bridge.js:176-185; src/plugin.js import path
- **Category:** robustness · **Confidence:** high
- **What:** `JSON.parse('﻿{...}')` throws, so a BOM-prefixed file lands in "Not an OpenCurve preset file".
- **Suggested fix:** Strip `^﻿` before `JSON.parse`. **No BOM handling in src/plugin.js either; apply in both.**

### ✅ F10. (merged into D2) Non-array `opencurve-presets-v10` throws inside `initPanel` — cep/js/plugin-ui.js:3044-3055.

### ✅ F11. (merged into E1) Settings modal can be opened on top of itself — cep/js/plugin-ui.js:4721.

### ✅ [LOW] F12. Dead code and unused exports in the CEP files

> **Applied in part.** `FALLBACK_FPS` is gone from the CEP file (it is still live in UXP), and `showLayout` / `_icGrid` / `_icList` went with D7. The three exports the bridge never calls (`stateListeners`, `sampleBezier`, `applyPresetLayout`) are kept on purpose: they cost three lines and are useful from the CEP DevTools console, which the UXP edition has no equivalent of.
- **File:** cep/js/plugin-ui.js:747 (`FALLBACK_FPS`, unused in CEP), 3612/3626-3627 (`showLayout`, `_icGrid`/`_icList`, see D7), 5166/5169/5178 (`stateListeners`, `sampleBezier`, `applyPresetLayout` exported but never used by the bridge)
- **Category:** dead-code · **Confidence:** high
- **Suggested fix:** Remove. `FALLBACK_FPS` is live in UXP, so that one is CEP-only.

**Clean:** `evalScript` result parsing (every host-result `JSON.parse` in try/catch, export gated on a leading `[`, payload escaping correct); stale-poll discard after Go; `valueAt` request ordering; transport plumbing and preview-engine fallbacks; CEF double events (guarded or idempotent, `_ocSeen` for the keydown pair); curve aliasing; timers/listeners (toast, tooltip, RAFs, menu/slider dismissers, Settings observer via the patched `remove`).

---

## G. CEP host: `cep/jsx/host.jsx`

### ✅ [MEDIUM] G1. `undoBake()` discards records it could not undo when the rest of the batch succeeded
- **File:** cep/jsx/host.jsx:996-1020
- **Category:** correctness · **Confidence:** high
- **What:** The panel-wide Undo pops the whole batch, then only puts it back when `removed === 0`. A record inside the batch that `_ocUndoInfo` skipped (`skipped: 1`: clip moved and no nodeId match, component matchName changed, index drift) is dropped with the batch even though its keyframes are still on the clip. `undoBakeParam` (948) handles the same case correctly by keeping skipped records.
- **Failure / impact:** Bake two properties with one Go press, move one clip (or add an effect above Motion so `compIdx` shifts on one row), press Undo: the movable one is undone, the other keeps its baked keyframes but loses its record, so its row stops showing green and can never be undone from the panel. The bridge then calls `exportBakeRecords()` and persists the loss.
- **Suggested fix:** In `undoBake()`, collect the records with `r.skipped === 1` into a `kept` array and, if non-empty, `_undoStack.push(kept)` (and re-run `_ocPruneBatches`) so they survive for a retry, matching `undoBakeParam`. UXP's equivalent bug is B1 (different mechanism).

### ✅ [MEDIUM] G2. Fallback `_jsonStringify` emits invalid JSON for control characters, NaN and Infinity
- **File:** cep/jsx/host.jsx:38-62; also the literal at 327
- **Category:** correctness · **Confidence:** high
- **What:** When the host has no native `JSON` (manifest host range `[0.0,99.9]`), strings only get `\`, `"` and `\n` escaped. `\r`, `\t`, other control chars and U+2028/2029 pass through raw, and `String(NaN)`/`String(Infinity)` produce tokens `JSON.parse` rejects. The `'{"status":"unchanged","ph":' + ph + '}'` literal has the same NaN hole.
- **Failure / impact:** On such a host, a clip named with a tab or carriage return makes every `detectContext()` result unparsable: cep-bridge.js:343 logs "Failed to parse detectContext result" and returns, so the panel freezes on its previous state while that clip is under the playhead.
- **Suggested fix:** In the string branch escape `[\x00-\x1f  ]` as `\uXXXX`; in the number branch return `'null'` when `!isFinite(obj)`. Or ship json2.js and drop the fallback. UXP has native JSON.

### ✅ [MEDIUM] G3. Clip-at-playhead test is end-inclusive, so at a cut the previous clip wins
- **File:** cep/jsx/host.jsx:230 (`_ocClipsAt`)
- **Category:** correctness · **Confidence:** high
- **What:** `if (ph < it.start || ph > it.end) continue;` treats `clip.end` (exclusive) as inside. With the playhead on the first frame of clip B directly after clip A, both are found, A comes first, and with no selection A is scanned first; its `phLocal` equals its out-point, so `kf1Time` stays null and the result is `status: 'outside'` for A even when B has a pair starting right there.
- **Failure / impact:** Park the playhead on the first frame of a keyframed clip that butts against a previous keyframed clip: strip says "Move playhead between keyframes" with A's properties; the user must nudge a frame or select B. Same when a lower-track clip ends exactly where the top-track clip starts.
- **Suggested fix:** Use `ph >= it.end`. **UXP has the same issue at src/plugin.js:1434 (B3).**

### ✅ [MEDIUM] G4. Bake-record fingerprint check is O(records × written × keyframes) on every full and fast scan
- **File:** cep/jsx/host.jsx:481-505, 894-905 (`_ocBakeAlive`, `_ocHasTime`)
- **Category:** performance · **Confidence:** high
- **What:** For every property, the loop walks the whole `_undoStack` (up to 300 records after import) and, per matching record, `_ocBakeAlive` calls `_ocHasTime` (linear scan of `kfSecs`) once per written time. Both arrays are sorted, but the check is quadratic and runs on every playhead move (the fast path goes through this loop too).
- **Failure / impact:** A 600-frame bake (25 s at 24 fps) costs ~360k float compares per record per poll in ExtendScript; a few such records on one clip is tens to hundreds of ms of host time on every playhead move, dwarfing the ~12 ms cache-hit poll. Long-clip bakes make scrubbing stutter in CEP.
- **Suggested fix:** Rewrite `_ocBakeAlive` as a single merge walk over the two sorted arrays (O(n + m), tolerance 1e-4) and index records per clip so the outer loop only touches the current clip's records. UXP `_recAlive` (src/plugin.js:2517) has the same quadratic shape via `kfSecs.some` but runs in V8; a merge walk there is a cheap follow-up.

### ✅ G5. (merged into F3) `importBakeRecords()` prepends unconditionally, so a second import duplicates every restored batch — cep/jsx/host.jsx:768-789.

### ✅ [LOW] G6. Whole-poll `try` turns a clip without `components` into a per-poll error and cache flush
- **File:** cep/jsx/host.jsx:355-360, 594-600
- **Category:** robustness · **Confidence:** medium
- **What:** `clip.components` / `comp.properties` / `.numItems` are read unguarded inside the property walk. If any throws for a track item type without a component chain, the outer catch returns `status: 'error'` and nulls all three caches, so the next poll re-walks every track and hits the same clip again.
- **Suggested fix:** Wrap those reads in `try { ... } catch(e) { continue; }` like `isTimeVarying`/`getKeys` already are, and leave the caches alone. UXP awaits `getComponentChain()` inside its own try; not affected.

### ✅ [LOW] G7. Error / no-sequence responses omit `ph`, which the bridge then treats as a playhead move
- **File:** cep/jsx/host.jsx:281-286, 596-600; cep/js/cep-bridge.js:362-364
- **Category:** correctness · **Confidence:** high
- **What:** `no-project`, `no-sequence` and `error` results carry no `ph`; the bridge does `if (_lastPh !== null && ph !== _lastPh) _phMovedAt = Date.now(); _lastPh = ph;`, so an undefined `ph` registers as "moved" on that poll and the next.
- **Failure / impact:** Space within 700 ms of an error poll passes `'moving'` to `ocTransport`, so the QE toggle is issued with the wrong assumption and `_ocPlayRate` ends up inverted.
- **Suggested fix:** Include `ph` in the error return (read it in a separate try before the walk) or have the bridge skip the moved check when `typeof result.ph !== 'number'`. CEP-only.

### ✅ [LOW] G8. Exported bake records are full-precision doubles; a big stack can approach the localStorage quota
- **File:** cep/jsx/host.jsx:722, 757-766
- **Category:** performance · **Confidence:** medium
- **What:** `times` are stored/exported with ~17 significant digits and up to 300 records are kept; the export runs through `evalScript` and `localStorage.setItem` after every bake and undo. 300 records of 600-frame bakes is ~3.4 MB of JSON; the bridge swallows the `setItem` exception, so persistence silently stops. UXP rounds to 1e-6 (src/plugin.js:2471).
- **Suggested fix:** Round `times`, `kf0Time`, `kf1Time`, `clipStart` to 1e-6 when building `undoInfo`, and cap by total written times rather than record count.

### ✅ [LOW] G9. `bakeKeyframes` dereferences `activeSequence` before checking it
- **File:** cep/jsx/host.jsx:616-640
- **Category:** robustness · **Confidence:** high
- **What:** `sequence` can be null; the verification try at 631 swallows the throw and returns "Clip changed since the last scan. Try again." (and flushes the caches), the wrong message.
- **Suggested fix:** `if (!sequence) return _jsonStringify({ success: false, error: 'No active sequence' });` after line 616. UXP re-reads the sequence and toasts on null.

### ✅ [LOW] G10. Duplicate `sequenceID` read per poll and never-read `_ocCacheResult`
- **File:** cep/jsx/host.jsx:259-266, 292, 102, 253, 325
- **Category:** dead-code · **Confidence:** high
- **What:** `_fpsCached` builds `seqId` and `detectContext` builds the identical string again: two host property reads per poll where one would do. `_ocCacheResult` is only ever compared to `null` at 325; its content is never returned, so it is a boolean holding the last full JSON string alive. `_hasUndoGroup` (644, 938, 1001) is always false in Premiere and could go.
- **Suggested fix:** Compute `seqId` once and pass it to `_fpsCached(sequence, seqId)`; replace `_ocCacheResult` with a boolean or drop it.

**Clean:** ES3 compatibility (no `let`/`const`/arrows/Array extras; trailing commas in object literals have shipped since 1.x so this engine accepts them); tick/time math (`jumpPlayhead`, `_detectFps`, `ocSeqInfo`) and media/sequence conversion; bake loop bounds, `doUpdate` on the true last iteration, step and opacity clamps match UXP; `_ocUndoInfo` removes only its own times; `ocTransport` guards; structure/param cache invalidation; bridge `evalScript` escaping.

---

## H. Static assets, manifests, loader, cross-edition drift

### ✅ H1. (merged into F1) CEP starts blue, not green — cep/js/cep-bridge.js:518.

### ⏸️ [MEDIUM] H2. `src/loader.js` is not loaded; the in-place update path and three manifest domains are dead (documentation/config decision, not a code fix)

> **Your decision, not applied.** Restoring the loader re-enables a download-and-run path that has been dormant since v1.0.3 and would need testing on a real update; dropping the three domains touches the manifest that ships to Adobe Exchange. CLAUDE.md now records the actual state so the next session is not misled: `index.html` loads `src/plugin.js` directly, only `api.github.com` is ever fetched, and `loader.js` itself was not touched.
- **File:** index.html:164; src/loader.js (must not be modified); manifest.json:26; packages/UXP/opencurve/index.html:83
- **Category:** config · **Confidence:** high
- **What:** `index.html` loads `src/plugin.js` directly (the loader tag was added in eb8d58c and replaced in 7cbe4c4 / v1.0.3). Nothing writes `plugin-update.js`. Only `api.github.com` is ever fetched; `objects.githubusercontent.com`, `codeload.github.com`, `releases.githubusercontent.com` are unused (github.com pages go through `shell.openExternal` under `launchProcess`). CLAUDE.md's "Update System" still describes the loader path.
- **Failure / impact:** No runtime failure; docs and the Exchange note describe a mechanism that only half exists, and the network permission is wider than needed. `loader.js`'s blocklist is not a real sandbox, but since nothing downloads to the data folder there is no reachable hole.
- **Suggested fix:** **Ask the user which they want:** either restore `<script src="src/loader.js">` in both `index.html` and the staging copy (re-enabling the update path), or drop the three domains from `manifest.json` and correct CLAUDE.md. Leave `loader.js` itself untouched either way.

### ⏸️ [LOW] H3. CEP manifest enables Node for a panel that never uses it

> **Not applied — needs a Premiere check I cannot run.** Nothing in the CEP JS uses Node, so the two `<Parameter>` lines look safe to drop, but they are in the manifest that ships in the signed ZXP, and if anything in the panel does depend on the mixed context the failure shows up only in Premiere. If you want it: remove both lines, reopen the panel, and check Import / Export Presets still open their file dialogs.
- **File:** cep/CSXS/manifest.xml:28-29
- **Category:** config · **Confidence:** high
- **What:** `--enable-nodejs` and `--mixed-context` are passed, but no `require(`, `cep_node`, `process` or `__dirname` exists in the CEP JS; file dialogs use `window.cep.fs`.
- **Suggested fix:** Remove both `<Parameter>` lines. Test the file dialogs and evalScript afterwards before release.

### ✅ [LOW] H4. Hover transitions dropped from the CEP stylesheet but kept in UXP
- **File:** styles/main.css:433, 497, 631, 808; cep/styles/main.css:441, 512, 636, 812
- **Category:** drift · **Confidence:** medium
- **What:** ea18862 removed `transition: color/background` from `.preset-btn`, `.preset-delete`, `.prop-btn`, `.prop-undo` in CEP while adding the same lines in UXP. Every other stylesheet difference is a documented edition one.
- **Suggested fix:** Copy the four lines into the CEP rules, or remove them from UXP (if either edition should skip them, it is the UXP one).

### ✅ [LOW] H5. Drag-sort pointer capture: UXP on press, CEP on first move
- **File:** src/plugin.js:5262; cep/js/plugin-ui.js:3301-3320 (`_pendingPointerId`)
- **Category:** drift · **Confidence:** medium
- **What:** `_initDragSort` is otherwise identical; CEP defers `setPointerCapture` until a real drag begins (Chromium retargets `click` to the capturing element), UXP captures immediately, with no comment on either side.
- **Suggested fix:** Adopt the `_pendingPointerId` form in `src/plugin.js` (test in the CCX), or comment the difference in both files. Do together with D5.

### ✅ [LOW] H6. Dead CSS rules present in both stylesheets
- **File:** styles/main.css:126-165, 413, 566, 952, 980-986, 989-995; cep/styles/main.css:141-180, 432, 572, 956, 984-990, 993-999
- **Category:** dead-code · **Confidence:** high
- **What:** `.select-wrapper`, `.styled-select` (+states), `.select-chevron`, `.preset-row`, `.action-row`, `.btn-secondary` match nothing in HTML or JS. `.preset-rename-input` is referenced only by the unreachable guard in `_initDragSort` (D7). `.btn-primary` and `.btn-primary:hover:not(.btn-disabled) { background: var(--accent-dim) }` are always beaten by the `#go-btn` id rules; that hover rule is the one sheen-element state rule using the `background` shorthand, a trap if the id rule ever goes.
- **Suggested fix:** Delete the listed rules and the two `preset-rename-input` guards. No `!important`, no layout-property transitions, and the repeated `.preset-btn`/`#go-btn` selectors are deliberate splits.

### ✅ H7. (merged into D7) `new-preset-btn` guards refer to a tile that no longer exists — eight guards per edition.

**Clean:** all six version strings plus the README badge agree at 2.0.0; `clipboard`, `localFileSystem` and `launchProcess` permissions are all used; the two HTML files differ only in documented ways and script order is correct; the legacy `src/` files are referenced by neither `index.html` nor `manifest.json` and are not in the `.ccx` staging folder; every CLAUDE.md-listed shared block (bezier/multi-point math, `_rangeBox`/`normToSVG`/`svgToNorm`, Flip/Invert, curve text, A-curve, the whole `_tl*` timeline block, `_panelShortcut`, `_pv*`, `_showNumericPanel`, `_showZoomSlider`, `_applyPresetLayout`, `_setHandle`/`_normalizeCurve`, `_solvePeak`, `_isNewerVersion`, `_tlSecondXs`) and all shared constants are identical between editions apart from comments, log prefixes and the documented UXP-only switches; the bridge's `onGo` matches the UXP inline Go handler field for field.

---

## Suggested fix order

1. **A1 + A3** (one change: `_curveFromText` gains the `cubic-bezier` fallback and clamps; `_parseCubicBezier` delegates; import validator uses it). Both editions.
2. **A2** (`_cancelCurveAnim`). Both editions. Then **A4** (tween commits once) becomes safe.
3. **F1** (delete bridge line 518).
4. **B1 + G1** (undo keeps records it couldn't reach). **B3/G3** (`ph < end`).
5. **E1, E2, C1, C6, C10** (small, high-confidence correctness).
6. **F3/G5** (import dedupe), **G2** (JSON fallback), **G7**, **F4**, **D2**.
7. **E3** (Reset All without relying on reload) — decide bake-record policy with the user.
8. Hot paths: **C2, C3, C4, C5, D4, A5, D6, B2, B3 (cache), G4**, then A7/A8/A10/C8.
9. Cleanups: **D7, H6, B5, B6, E8, F12, G10, C11, A9, H3, H4, H5**, then D8/E9 dedupe, then B8 (`_dumpComponents`, ask first).
10. **H2** is a decision for the user (restore the loader or trim manifest + docs).

After the shared-UI fixes, re-run a drift diff of the CLAUDE.md-listed blocks between `src/plugin.js` and `cep/js/plugin-ui.js` to confirm they are identical again. Update CLAUDE.md where a finding changes documented behaviour (F5, H2, E3).
