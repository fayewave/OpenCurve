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
          return { file: file };
        });
    })
    .then(function(result) {
      console.log('[OC] Loading downloaded update');
      try {
        var nativePath = result.file.nativePath;
        console.log('[OC] nativePath:', nativePath);
        if (!nativePath) throw new Error('no nativePath');
        var fileUrl = 'file:///' + nativePath.replace(/\\/g, '/');
        console.log('[OC] loading via file URL:', fileUrl);
        var script = document.createElement('script');
        script.src = fileUrl;
        script.onerror = function(e) {
          console.error('[OC] file URL load failed, falling back to inline:', e);
          result.file.read({ format: storage.formats.utf8 }).then(function(content) {
            localStorage.setItem('opencurve-post-update', '1');
            var s2 = document.createElement('script');
            s2.textContent = content;
            document.body.appendChild(s2);
          }).catch(function() { loadBundled(); });
        };
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
