// Regression checks for safe PDF.js page sizing in the dedicated converter.
const fs = require('fs');
const vm = require('vm');

let failures = 0;
function check(name, condition, extra) {
  if (condition) console.log('PASS:', name);
  else { failures++; console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

const elements = new Map();
function element(id) {
  if (elements.has(id)) return elements.get(id);
  const classes = new Set();
  const value = {
    id, disabled: false, textContent: '', value: '', files: [], style: {},
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle: (name, force) => { if (force) classes.add(name); else classes.delete(name); },
      contains: (name) => classes.has(name)
    },
    addEventListener() {}, click() {}
  };
  elements.set(id, value);
  return value;
}

const context = {
  console,
  location: { search: '?token=scale-test&returnTab=17' },
  URLSearchParams,
  document: { getElementById: element, createElement: () => element('canvas') },
  chrome: { runtime: { getURL: (path) => 'chrome-extension://ext/' + path } },
  PDFImportStore: {}
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(__dirname + '/../src/pdf-import/pdf-import.js', 'utf8'), context,
  { filename: 'pdf-import.js' });

function page(width, height) {
  return { getViewport: ({ scale }) => ({ width: width * scale, height: height * scale, scale }) };
}

const normal = context.viewportForPdfPage(page(600, 900));
check('ordinary PDF pages retain the established 2x rendering scale', normal.scale === 2, normal);

const huge = context.viewportForPdfPage(page(1000000, 1000000));
check('huge PDF pages do not hit the old 0.1 minimum-scale clamp', huge.scale < 0.1, huge);
check('huge PDF pages respect both canvas dimension limits',
  huge.width <= 16000 && huge.height <= 16000, huge);
check('huge PDF pages respect the canvas memory-area limit',
  huge.width * huge.height <= 48000000 * 1.000000001, huge.width * huge.height);

const extreme = context.viewportForPdfPage(page(1000000000, 100));
check('extreme page ratios still produce a positive finite viewport',
  Number.isFinite(extreme.scale) && extreme.scale > 0 && extreme.width <= 16000 && extreme.height <= 16000,
  extreme);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PDF IMPORT TESTS PASSED');
process.exit(failures ? 1 : 0);
