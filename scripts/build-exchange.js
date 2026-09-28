// Builds the Adobe Exchange variant of the UXP edition:
//   packages/UXP/opencurve/          (staging copy, wiped and rebuilt every run)
//   packages/OpenCurve-UXP-<ver>.ccx (the file submitted to Exchange)
//
// Exchange installs update through Creative Cloud, so this variant has no
// GitHub update checker and no network or launchProcess permission. The code
// to leave out is marked in src/plugin.js:
//   // [exchange-strip] ... // [/exchange-strip]   whole lines between, markers included
//   ... // [exchange-strip-line]                   that one line
// Links fall back to copying (see _openUrl).
//
// Run from the repo root: node scripts/build-exchange.js
'use strict';
var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var ROOT = path.resolve(__dirname, '..');
var STAGE = path.join(ROOT, 'packages', 'UXP', 'opencurve');
var EXCHANGE_ID = '3ecc7304';
var EXCHANGE_MIN_HOST = '25.6'; // what the 1.2.3 Exchange build shipped with
var IMAGES = ['OpenCurve2_Wordmark_small.png', 'OpenCurve2_Wordmark_small@2x.png', 'OpenCurve2_Wordmark_small@3x.png'];

function fail(msg) { console.error('build-exchange: ' + msg); process.exit(1); }

// ─── Strip plugin.js ──────────────────────────────────────────────────────
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
  return { code: out.join('\n'), stripped: stripped.join('\n'), count: stripped.length };
}

var srcJs = fs.readFileSync(path.join(ROOT, 'src', 'plugin.js'), 'utf8');
var res = strip(srcJs);

// Nothing declared in a stripped region may still be referenced. Limited to
// names that are clearly update code or panel-level (leading underscore), so a
// local like `list` or `url` inside a stripped function doesn't count.
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

// ─── Manifest ─────────────────────────────────────────────────────────────
var man = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
var version = man.version;
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

var srcVer = (srcJs.match(/var CURRENT_VERSION\s*=\s*'([^']+)'/) || [])[1];
if (srcVer !== version) fail('manifest.json is ' + version + ' but plugin.js CURRENT_VERSION is ' + srcVer);

// ─── Stage ────────────────────────────────────────────────────────────────
fs.rmSync(STAGE, { recursive: true, force: true });
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  fs.readdirSync(from, { withFileTypes: true }).forEach(function(e) {
    var a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b); else fs.copyFileSync(a, b);
  });
}
fs.mkdirSync(path.join(STAGE, 'src'), { recursive: true });
fs.mkdirSync(path.join(STAGE, 'img'), { recursive: true });
fs.writeFileSync(path.join(STAGE, 'manifest.json'), JSON.stringify(man, null, 2) + '\n');
fs.copyFileSync(path.join(ROOT, 'index.html'), path.join(STAGE, 'index.html'));
fs.writeFileSync(path.join(STAGE, 'src', 'plugin.js'), res.code);
copyDir(path.join(ROOT, 'styles'), path.join(STAGE, 'styles'));
copyDir(path.join(ROOT, 'icons'), path.join(STAGE, 'icons'));
IMAGES.forEach(function(f) { fs.copyFileSync(path.join(ROOT, 'img', f), path.join(STAGE, 'img', f)); });

var html = fs.readFileSync(path.join(STAGE, 'index.html'), 'utf8');
(html.match(/<script[^>]+src="([^"]+)"/g) || []).forEach(function(tag) {
  var p = tag.match(/src="([^"]+)"/)[1];
  if (!fs.existsSync(path.join(STAGE, p))) fail('index.html loads ' + p + ', which is not in the package');
});

cp.execFileSync(process.execPath, ['--check', path.join(STAGE, 'src', 'plugin.js')], { stdio: 'inherit' });

// ─── Zip ──────────────────────────────────────────────────────────────────
// PowerShell 7's Compress-Archive writes forward-slash entry names (5.1 wrote
// backslashes, which unpack as flat "src\plugin.js" files on a Mac)
var out = path.join(ROOT, 'packages', 'OpenCurve-UXP-' + version + '.ccx');
cp.execFileSync('pwsh', ['-NoProfile', '-Command',
  "Compress-Archive -Path '" + STAGE.replace(/'/g, "''") + "\\*' -DestinationPath '" + out.replace(/'/g, "''") + "' -Force"],
  { stdio: 'inherit' });

console.log('stripped ' + res.count + ' lines from plugin.js');
console.log('built ' + path.relative(ROOT, out) + ' (' + Math.round(fs.statSync(out).size / 1024) + ' KB), id ' + man.id + ', v' + version);
