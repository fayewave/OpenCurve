// Builds the release packages. Run from anywhere:
//   node scripts/build.js            all three
//   node scripts/build.js github     packages/OpenCurve-<ver>.ccx      (GitHub release, UXP)
//   node scripts/build.js zxp        dist/OpenCurve-<ver>.zxp          (GitHub release, CEP, signed)
//   node scripts/build.js exchange   packages/OpenCurve-UXP-<ver>.ccx  (Adobe Exchange submission)
//
// Each target stages into its own folder under packages/ (wiped every run)
// and ships only what the panel loads: no legacy src/ files, no loader.js, no
// README GIFs, no cep/.debug (it opens a remote-debug port on the user's machine).
//
// The Exchange variant installs updates through Creative Cloud, so it has no
// GitHub update checker and no network or launchProcess permission. The code
// to leave out is marked in src/plugin.js:
//   // [exchange-strip] ... // [/exchange-strip]   whole lines between, markers included
//   ... // [exchange-strip-line]                   that one line
// Links fall back to copying (see _openUrl).
//
// The .zxp signing password is read from dist/opencurve-cert.password (gitignored)
// or the OPENCURVE_ZXP_PASS environment variable; never put it in this file.
// Zips need PowerShell 7 (pwsh): 5.1's Compress-Archive writes backslash entry
// names, which unpack as flat "src\plugin.js" files on a Mac.
'use strict';
var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var ROOT = path.resolve(__dirname, '..');
var EXCHANGE_ID = '3ecc7304';
var EXCHANGE_MIN_HOST = '25.6'; // what the 1.2.3 Exchange build shipped with
var IMAGES = ['OpenCurve2_Wordmark_small.png', 'OpenCurve2_Wordmark_small@2x.png', 'OpenCurve2_Wordmark_small@3x.png'];
var SIGNER = path.join(ROOT, 'tools', 'zxp-sign-cmd-master', 'node_modules', 'zxp-provider', 'bin', '3.0.30', 'win64', 'ZXPSignCmd.exe');
var CERT = path.join(ROOT, 'dist', 'opencurve-cert.p12');

function fail(msg) { console.error('build: ' + msg); process.exit(1); }
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function kb(p) { return Math.round(fs.statSync(p).size / 1024) + ' KB'; }
function copyDir(from, to, skip) {
  fs.mkdirSync(to, { recursive: true });
  fs.readdirSync(from, { withFileTypes: true }).forEach(function(e) {
    var a = path.join(from, e.name), b = path.join(to, e.name);
    if (skip && skip(a, e)) return;
    if (e.isDirectory()) copyDir(a, b, skip); else fs.copyFileSync(a, b);
  });
}
function zip(dir, out) {
  if (fs.existsSync(out)) fs.unlinkSync(out);
  cp.execFileSync('pwsh', ['-NoProfile', '-Command',
    "Compress-Archive -Path '" + dir.replace(/'/g, "''") + "\\*' -DestinationPath '" + out.replace(/'/g, "''") + "' -Force"],
    { stdio: 'inherit' });
}

// ─── Versions: all five places must agree ─────────────────────────────────
var uxpMan = JSON.parse(read('manifest.json'));
var VERSION = uxpMan.version;
var cepXml = read('cep/CSXS/manifest.xml');
var found = {
  'src/plugin.js': (read('src/plugin.js').match(/var CURRENT_VERSION\s*=\s*'([^']+)'/) || [])[1],
  'cep/js/plugin-ui.js': (read('cep/js/plugin-ui.js').match(/var CURRENT_VERSION\s*=\s*'([^']+)'/) || [])[1],
  'cep manifest ExtensionBundleVersion': (cepXml.match(/ExtensionBundleVersion="([^"]+)"/) || [])[1],
  'cep manifest Extension Version': (cepXml.match(/<Extension Id="[^"]+" Version="([^"]+)"/) || [])[1],
  'README badge': (read('README.md').match(/badge\/version-([0-9.]+)-/) || [])[1],
};
Object.keys(found).forEach(function(k) {
  if (found[k] !== VERSION) fail('manifest.json is ' + VERSION + ' but ' + k + ' is ' + found[k]);
});

// ─── UXP staging (shared by github and exchange) ──────────────────────────
function stageUxp(dir, pluginJs, manifest) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'img'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.copyFileSync(path.join(ROOT, 'index.html'), path.join(dir, 'index.html'));
  fs.writeFileSync(path.join(dir, 'src', 'plugin.js'), pluginJs);
  copyDir(path.join(ROOT, 'styles'), path.join(dir, 'styles'));
  copyDir(path.join(ROOT, 'icons'), path.join(dir, 'icons'));
  IMAGES.forEach(function(f) { fs.copyFileSync(path.join(ROOT, 'img', f), path.join(dir, 'img', f)); });
  var html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  (html.match(/<script[^>]+src="([^"]+)"/g) || []).forEach(function(tag) {
    var p = tag.match(/src="([^"]+)"/)[1];
    if (!fs.existsSync(path.join(dir, p))) fail('index.html loads ' + p + ', which is not in the package');
  });
  cp.execFileSync(process.execPath, ['--check', path.join(dir, 'src', 'plugin.js')], { stdio: 'inherit' });
}

// ─── Strip plugin.js for Exchange ─────────────────────────────────────────
function strip(src) {
  var lines = src.split('\n'), out = [], stripped = [], open = 0, openAt = 0;
  lines.forEach(function(line, i) {
    var t = line.trim();
    if (t === '// [exchange-strip]') {
      if (open) fail('nested [exchange-strip] at line ' + (i + 1) + ' (open since ' + openAt + ')');
      open = 1; openAt = i + 1; return;
    }
    if (t === '// [/exchange-strip]') {
      if (!open) fail('[/exchange-strip] without an opening marker at line ' + (i + 1));
      open = 0; return;
    }
    if (open || /\/\/ \[exchange-strip-line\]\s*$/.test(line)) { stripped.push(line); return; }
    if (line.indexOf('exchange-strip') !== -1) fail('malformed marker at line ' + (i + 1) + ': ' + t);
    out.push(line);
  });
  if (open) fail('[exchange-strip] at line ' + openAt + ' is never closed');
  var res = { code: out.join('\n'), stripped: stripped.join('\n'), count: stripped.length };

  // Nothing declared in a stripped region may still be referenced. Limited to
  // names that are clearly update code or panel-level (leading underscore), so
  // a local like `list` or `url` inside a stripped function doesn't count.
  var declared = {};
  res.stripped.replace(/\b(?:var|function)\s+([A-Za-z_$][\w$]*)/g, function(_, name) {
    if (name[0] === '_' || /update|notif/i.test(name)) declared[name] = 1;
  });
  // Strings and comments are blanked first ('_update-notif' is not a use of `notif`)
  var codeOnly = res.code
    .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, "''")
    .replace(/\/\/[^\n]*/g, '');
  Object.keys(declared).forEach(function(name) {
    if (new RegExp('(^|[^\\w$])' + name.replace(/\$/g, '\\$') + '(?![\\w$])').test(codeOnly)) {
      fail('`' + name + '` is declared in a stripped region but still used');
    }
  });
  [/\bfetch\s*\(/, /openExternal/, /api\.github\.com/, /opencurve-post-update/, /check-updates/].forEach(function(re) {
    if (re.test(res.code)) fail('stripped plugin.js still matches ' + re);
  });
  return res;
}

// ─── Targets ──────────────────────────────────────────────────────────────
var targets = {
  github: function() {
    var src = read('src/plugin.js');
    strip(src); // markers must be well formed even though nothing is removed here
    var dir = path.join(ROOT, 'packages', 'UXP', 'opencurve-github');
    stageUxp(dir, src, uxpMan);
    var out = path.join(ROOT, 'packages', 'OpenCurve-' + VERSION + '.ccx');
    zip(dir, out);
    console.log('github:   ' + path.relative(ROOT, out) + ' (' + kb(out) + '), id ' + uxpMan.id);
  },

  exchange: function() {
    var res = strip(read('src/plugin.js'));
    var man = JSON.parse(JSON.stringify(uxpMan));
    man.id = EXCHANGE_ID;
    man.name = 'OpenCurve'; // the Exchange listing's name; the panel label stays as in the source
    man.host.minVersion = EXCHANGE_MIN_HOST;
    delete man.requiredPermissions.network;
    delete man.requiredPermissions.launchProcess;
    // Panel icon on the entrypoint, plugin-list icon at the top, as the 1.2.3
    // Exchange build had them
    var panelIcons = man.icons.filter(function(ic) { return !ic.species; });
    man.icons = man.icons.filter(function(ic) { return ic.species; });
    if (panelIcons.length) man.entrypoints[0].icons = panelIcons;
    var dir = path.join(ROOT, 'packages', 'UXP', 'opencurve');
    stageUxp(dir, res.code, man);
    var out = path.join(ROOT, 'packages', 'OpenCurve-UXP-' + VERSION + '.ccx');
    zip(dir, out);
    console.log('exchange: ' + path.relative(ROOT, out) + ' (' + kb(out) + '), id ' + man.id + ', stripped ' + res.count + ' lines');
  },

  zxp: function() {
    if (!fs.existsSync(SIGNER)) fail('signer not found: ' + SIGNER);
    if (!fs.existsSync(CERT)) fail('certificate not found: ' + CERT);
    var passFile = path.join(ROOT, 'dist', 'opencurve-cert.password');
    var pass = process.env.OPENCURVE_ZXP_PASS || (fs.existsSync(passFile) ? fs.readFileSync(passFile, 'utf8').trim() : '');
    if (!pass) fail('no signing password: set OPENCURVE_ZXP_PASS or write it to dist/opencurve-cert.password');
    ['cep/js/pointer-shim.js', 'cep/js/plugin-ui.js', 'cep/js/cep-bridge.js', 'cep/js/CSInterface.js'].forEach(function(f) {
      cp.execFileSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'inherit' });
    });

    var dir = path.join(ROOT, 'packages', 'CEP', 'opencurve');
    fs.rmSync(dir, { recursive: true, force: true });
    var cepRoot = path.join(ROOT, 'cep');
    copyDir(cepRoot, dir, function(a, e) {
      var rel = path.relative(cepRoot, a).split(path.sep).join('/');
      if (rel === '.debug' || rel === 'META-INF') return true; // the signer writes its own META-INF
      if (!e.isDirectory() && rel.indexOf('img/') === 0) return IMAGES.indexOf(e.name) === -1;
      return false;
    });

    var out = path.join(ROOT, 'dist', 'OpenCurve-' + VERSION + '.zxp');
    if (fs.existsSync(out)) fs.unlinkSync(out); // the signer refuses to overwrite
    cp.execFileSync(SIGNER, ['-sign', dir, out, CERT, pass], { stdio: 'inherit' });
    var info = cp.execFileSync(SIGNER, ['-verify', out, '-certInfo'], { encoding: 'utf8' });
    if (!/Signature verified successfully/i.test(info)) { console.error(info); fail('signature did not verify'); }
    console.log('zxp:      ' + path.relative(ROOT, out) + ' (' + kb(out) + '), signed and verified');
  },
};

var want = process.argv.slice(2);
if (!want.length) want = ['github', 'zxp', 'exchange'];
want.forEach(function(t) {
  if (!targets[t]) fail('unknown target "' + t + '" (github, zxp, exchange)');
});
console.log('OpenCurve v' + VERSION);
want.forEach(function(t) { targets[t](); });
