// Static integrity checks for extension entry points and every local resource reference.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const EXT_ROOT = path.join(ROOT, 'extension');
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
let checked = 0;
let failures = 0;

function check(name, condition, detail = '') {
  checked++;
  if (!condition) {
    failures++;
    console.error(`FAIL: ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

function cleanLocalReference(reference) {
  const value = reference.trim();
  if (!value || value.startsWith('#') || value.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(value)) return '';
  return value.split(/[?#]/, 1)[0];
}

function checkFile(name, relativePath) {
  check(name, fs.statSync(path.join(EXT_ROOT, relativePath), { throwIfNoEntry: false })?.isFile() === true, relativePath);
}

function checkRelativeReference(sourceFile, reference) {
  const clean = cleanLocalReference(reference);
  if (!clean) return;
  const target = path.resolve(path.dirname(sourceFile), clean);
  const relative = path.relative(EXT_ROOT, target);
  check(`local reference in ${path.relative(EXT_ROOT, sourceFile)}`,
    relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && fs.existsSync(target), reference);
}

function checkRuntimeReference(sourceFile, reference) {
  const clean = cleanLocalReference(reference);
  if (!clean) return;
  const target = path.resolve(EXT_ROOT, clean);
  const relative = path.relative(EXT_ROOT, target);
  check(`runtime URL in ${path.relative(EXT_ROOT, sourceFile)}`,
    relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && fs.existsSync(target), reference);
}

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}

const manifest = JSON.parse(fs.readFileSync(path.join(EXT_ROOT, 'manifest.json'), 'utf8'));
check('MV3 service worker entry point', manifest.background.service_worker === 'src/background.js');
check('popup entry point', manifest.action.default_popup === 'src/popup/popup.html');
checkFile('service worker exists', manifest.background.service_worker);
checkFile('popup HTML exists', manifest.action.default_popup);
for (const group of [manifest.icons, manifest.action.default_icon]) {
  for (const [size, reference] of Object.entries(group)) {
    check(`manifest ${size}px icon destination`, reference === `assets/icons/icon${size}.png`, reference);
    checkFile(`manifest ${size}px icon exists`, reference);
  }
}
check('manifest and package.json versions stay in sync', manifest.version === packageJson.version,
  `manifest=${manifest.version} package.json=${packageJson.version}`);

const sourceFiles = walk(path.join(EXT_ROOT, 'src'));
for (const file of sourceFiles) {
  const source = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.html')) {
    for (const match of source.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)) {
      checkRelativeReference(file, match[1]);
    }
  } else if (file.endsWith('.css')) {
    for (const match of source.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
      checkRelativeReference(file, match[1]);
    }
  } else if (file.endsWith('.js')) {
    for (const match of source.matchAll(/chrome\.runtime\.getURL\(\s*(['"`])([^'"`]+)\1/g)) {
      checkRuntimeReference(file, match[2]);
    }
  }
}

for (const resource of [
  'vendor/ocr/worker.min.js',
  'vendor/ocr/core/tesseract-core-lstm.wasm.js',
  'vendor/ocr/core/tesseract-core-simd-lstm.wasm.js',
  'vendor/ocr/lang/eng.traineddata.gz',
  'vendor/ocr/lang/kor.traineddata.gz',
  'vendor/ocr/lang/jpn.traineddata.gz',
  'vendor/ocr/lang/chi_sim.traineddata.gz',
  'vendor/pdfjs/pdf.min.mjs',
  'vendor/pdfjs/pdf.worker.min.mjs',
  'vendor/pdfjs/cmaps',
  'vendor/pdfjs/standard_fonts',
  'assets/fonts/Vazirmatn.woff2'
]) {
  check(`bundled runtime resource: ${resource}`, fs.existsSync(path.join(EXT_ROOT, resource)), resource);
}

check('npm package metadata identifies the extension as HASAYA', packageJson.name === 'hasaya-chrome-extension');

// Every test file in tests/ must be reachable from at least one npm script,
// otherwise it silently never runs (that is how regressions slip through).
const allScriptText = Object.values(packageJson.scripts).join(' ');
for (const entry of fs.readdirSync(path.join(ROOT, 'tests')).sort()) {
  if (!/^test-[\w-]+\.(?:js|cjs)$/.test(entry)) continue;
  check(`npm scripts can run ${entry}`, allScriptText.includes(`node tests/${entry}`), entry);
}

const channel = fs.readFileSync(path.join(EXT_ROOT, 'src/popup/update-channel.js'), 'utf8');
const updater = fs.readFileSync(path.join(EXT_ROOT, 'src/popup/update.js'), 'utf8');
check('updater targets this build branch', channel.includes("window.PIC_TO_PDF_UPDATE_BRANCH = 'main';"));
check('updater targets the correct repository', updater.includes("const REPO = 'sargoliwork101-ui/COMICCCC';"));
check('updater reads the extension manifest on main', updater.includes('/contents/extension/manifest.json?ref='));
check('updater downloads from GitHub codeload', updater.includes('https://codeload.github.com/${REPO}/zip/refs/heads/'));

// The popup version pill must match the shipped manifest version (no stale hardcoded labels).
const popupHtml = fs.readFileSync(path.join(EXT_ROOT, 'src/popup/popup.html'), 'utf8');
const versionPill = (popupHtml.match(/id="versionPill"[^>]*>v([\d.]+)</) || [])[1];
check('popup version pill matches manifest version', versionPill === manifest.version,
  `pill=v${versionPill} manifest=${manifest.version}`);
check('popup loads the runtime version pill script', popupHtml.includes('version-pill.js'));

if (failures) {
  console.error(`\n${failures} PATH FAILURE(S) across ${checked} checks`);
  process.exit(1);
}
console.log(`ALL PATH TESTS PASSED (${checked} local entry-point/resource/reference checks)`);
