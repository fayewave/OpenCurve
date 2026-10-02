// Pointer events for CEP on macOS (GitHub issue #8, October 2026).
//
// CEP 12 on macOS (Premiere 26.x, Chromium 99) never delivers pointerdown or
// pointerup to the panel. pointermove arrives but always with buttons = 0, and
// mousedown / mousemove / mouseup / click all work. Measured with a probe panel
// on a MacBook Air M2, with and without --enable-nodejs --mixed-context (no
// difference). Every drag in the panel (graph handles, dividers, preset
// reorder, timeline handles) is built on pointer events, so on a Mac none of
// them did anything while clicks still worked.
//
// This turns each mouse press that arrived without a real pointerdown into
// synthetic pointerdown / pointermove / pointerup events, and keeps pointer
// capture itself for that press (setPointerCapture only records the element;
// moves and the release are sent to it). Trusted pointermoves are swallowed
// during such a press so listeners see one move per mouse move, with the held
// button in `buttons`. A press that did get a real pointerdown (Windows, or a
// Mac that starts delivering them) is left completely alone. Loaded before
// plugin-ui.js so its window listeners run first.
(function() {
  if (typeof PointerEvent !== 'function') return;

  var PID = 1;            // Chromium's id for the mouse
  var _realDownAt = -1e9; // timeStamp of the last trusted pointerdown
  var press = null;       // { target, buttons, cap } while a shimmed press is live
  var _logged = false;

  var BITS = { 0: 1, 1: 4, 2: 2, 3: 8, 4: 16 }; // MouseEvent.button -> buttons bit

  function fire(type, target, src, button, buttons) {
    var ev = new PointerEvent(type, {
      bubbles: true, cancelable: type !== 'pointercancel', composed: true, view: window,
      clientX: src.clientX, clientY: src.clientY, screenX: src.screenX, screenY: src.screenY,
      ctrlKey: src.ctrlKey, shiftKey: src.shiftKey, altKey: src.altKey, metaKey: src.metaKey,
      button: button, buttons: buttons,
      pointerId: PID, pointerType: 'mouse', isPrimary: true,
      width: 1, height: 1, pressure: buttons ? 0.5 : 0,
    });
    return (target && target.dispatchEvent) ? target.dispatchEvent(ev) : true;
  }

  function end(type, src) {
    var p = press;
    if (!p) return;
    var to = p.cap && p.cap.isConnected ? p.cap : (src && src.target) || p.target;
    var btn = type === 'pointerup' && src ? src.button : -1;
    // Cleared after the dispatch: a pointerup listener may still release capture
    fire(type, to, src || p.last, btn, 0);
    press = null;
  }

  window.addEventListener('pointerdown', function(e) {
    if (e.isTrusted) _realDownAt = e.timeStamp;
  }, true);

  window.addEventListener('mousedown', function(e) {
    if (!e.isTrusted) return;
    if (Math.abs(e.timeStamp - _realDownAt) < 500) return; // a real pointerdown came with it
    if (press) end('pointercancel'); // a release we never saw (outside the panel)
    if (!_logged) { _logged = true; console.log('[OC-CEP] no native pointerdown: pointer shim active'); }
    var bits = BITS[e.button] || 0;
    press = { target: e.target, buttons: bits, cap: null, last: e };
    if (!fire('pointerdown', e.target, e, e.button, bits)) e.preventDefault();
  }, true);

  window.addEventListener('mousemove', function(e) {
    if (!press || !e.isTrusted) return;
    press.last = e;
    fire('pointermove', press.cap && press.cap.isConnected ? press.cap : e.target, e, -1, press.buttons);
  }, true);

  window.addEventListener('mouseup', function(e) {
    if (!press || !e.isTrusted) return;
    end('pointerup', e);
  }, true);

  // While a shimmed press is live, the real pointer events would double up
  // (and their buttons = 0 cancels the preset drag), so they go no further
  ['pointermove', 'pointerup', 'pointercancel'].forEach(function(t) {
    window.addEventListener(t, function(e) {
      if (press && e.isTrusted) e.stopImmediatePropagation();
    }, true);
  });

  window.addEventListener('blur', function() { if (press) end('pointercancel'); });

  // Capture for the shimmed press: remembered here instead of asked of
  // Chromium, which has no pressed pointer to capture
  var _set = Element.prototype.setPointerCapture;
  var _rel = Element.prototype.releasePointerCapture;
  var _has = Element.prototype.hasPointerCapture;
  Element.prototype.setPointerCapture = function(id) {
    if (press && id === PID) { press.cap = this; return; }
    return _set.call(this, id);
  };
  Element.prototype.releasePointerCapture = function(id) {
    if (press && id === PID) { if (press.cap === this) press.cap = null; return; }
    return _rel.call(this, id);
  };
  Element.prototype.hasPointerCapture = function(id) {
    if (press && id === PID) return press.cap === this;
    return _has.call(this, id);
  };
})();
