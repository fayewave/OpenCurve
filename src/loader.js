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
        localStorage.setItem('opencurve-post-update', '1');
        var script = document.createElement('script');
        // Try blob URL first so it loads like an external script
        try {
          var blob = new Blob([result.content], { type: 'text/javascript' });
          var blobUrl = URL.createObjectURL(blob);
          script.src = blobUrl;
          script.onload = function() { URL.revokeObjectURL(blobUrl); };
          script.onerror = function() {
            // Blob URL failed, fall back to inline
            URL.revokeObjectURL(blobUrl);
            var s2 = document.createElement('script');
            s2.textContent = result.content;
            document.body.appendChild(s2);
          };
        } catch(blobErr) {
          script.textContent = result.content;
        }
        document.body.appendChild(script);
      } catch(e) {
        console.error('[OC] Update script failed, removing and falling back:', e);
        localStorage.removeItem('opencurve-post-update');
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
