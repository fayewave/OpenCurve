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
      try {
        var script = document.createElement('script');
        script.textContent = result.content;
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
