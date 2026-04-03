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
          return file.read({ format: storage.formats.utf8 });
        });
    })
    .then(function(content) {
      console.log('[OC] Loading downloaded update');
      var script = document.createElement('script');
      script.textContent = content;
      document.body.appendChild(script);
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
