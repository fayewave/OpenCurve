/**
 * OpenCurve loader — loads a downloaded update if one exists,
 * otherwise falls back to the bundled plugin.js.
 * This file should never be updated itself.
 */
(function() {
  var uxp, storage;
  try {
    uxp     = require('uxp');
    storage = uxp.storage;
  } catch(e) {
    loadBundled();
    return;
  }

  storage.localFileSystem.getDataFolder()
    .then(function(folder) {
      return folder.getEntry('plugin-update.js')
        .then(function(file) {
          return file.read({ format: storage.formats.utf8 })
            .then(function(content) { return { file: file, content: content }; });
        });
    })
    .then(function(result) {
      console.log('[OC] Loading downloaded update');
      // Validate update script before executing
      var content = result.content;
      if (!content || typeof content !== 'string' || content.length < 100) {
        console.error('[OC] Update script too short or empty — rejecting');
        result.file.delete().catch(function(){});
        loadBundled();
        return;
      }
      // Must contain expected plugin markers (prevents executing arbitrary code)
      if (content.indexOf('FayeSmoothify') === -1 && content.indexOf('OpenCurve') === -1) {
        console.error('[OC] Update script missing expected plugin markers — rejecting');
        result.file.delete().catch(function(){});
        loadBundled();
        return;
      }
      // Reject if it contains suspicious patterns (basic sandboxing)
      var suspicious = ['eval(', 'Function(', 'importScripts(', 'document.cookie', 'XMLHttpRequest'];
      for (var i = 0; i < suspicious.length; i++) {
        if (content.indexOf(suspicious[i]) !== -1) {
          console.error('[OC] Update script contains suspicious pattern: ' + suspicious[i] + ' — rejecting');
          result.file.delete().catch(function(){});
          loadBundled();
          return;
        }
      }
      try {
        var script = document.createElement('script');
        script.textContent = content;
        document.body.appendChild(script);
      } catch(e) {
        console.error('[OC] Update script failed, removing and falling back:', e);
        result.file.delete().catch(function(){});
        loadBundled();
      }
    })
    .catch(function() {
      loadBundled();
    });

  function loadBundled() {
    var script = document.createElement('script');
    script.src = 'src/plugin.js';
    document.body.appendChild(script);
  }
})();
