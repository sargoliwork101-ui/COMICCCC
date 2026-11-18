// Regression tests for extracting visible webpage text and applying translations without replacing page markup.
const { JSDOM } = require('jsdom');
const PageTranslationTools = require('../src/core/page-translation.js');

let failures = 0;
function check(name, condition, extra) {
  if (condition) console.log('PASS:', name);
  else { failures++; console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

const dom = new JSDOM(`<!doctype html><html><head><style>
  #first { direction: ltr !important; }
  #first strong { direction: ltr !important; }
</style></head><body>
  <main>
    <p id="first" dir="ltr">Hello <strong>world</strong> from this page.</p>
    <p id="second">Another paragraph.</p>
    <p id="empty">   </p>
    <p id="number">2026-11-01</p>
    <p hidden>Hidden message.</p>
    <p aria-hidden="true">Accessible-hidden message.</p>
    <div contenteditable="true">User draft text.</div>
    <button>Button label</button>
    <input value="Input value">
    <pre><code>const secret = 1;</code></pre>
    <script>const text = 'script text';</script>
    <style>.secret::after { content: 'style text'; }</style>
  </main>
</body></html>`, { pretendToBeVisual: true });
const { document } = dom.window;

const records = PageTranslationTools.collectTextNodes(document.querySelector('main'), document);
check('extracts eligible text nodes, including inline markup, but skips controls and hidden/code/script text',
  records.map((record) => record.original).join('|') === 'Hello |world| from this page.|Another paragraph.', records.map((record) => record.original));
check('assigns stable IDs to extracted text nodes',
  records.length === 4 && records.every((record, index) => record.id === `p${String(index + 1).padStart(6, '0')}`),
  records.map((record) => record.id));

{
  const source = '  This is a longer sentence with enough words to split cleanly. '.repeat(20);
  const pieces = PageTranslationTools.splitText(source, 'long-node', 80);
  check('long text becomes bounded, uniquely identified segments without losing original characters',
    pieces.length > 1 && pieces.every((piece) => piece.text.length <= 80) &&
    new Set(pieces.map((piece) => piece.id)).size === pieces.length &&
    pieces.map((piece) => piece.text + piece.after).join('') === source,
    { count: pieces.length, max: Math.max(...pieces.map((piece) => piece.text.length)) });
}

{
  const entries = [
    { id: 'one', text: 'a'.repeat(9) }, { id: 'two', text: 'b'.repeat(9) },
    { id: 'three', text: 'c'.repeat(9) }, { id: 'four', text: 'd'.repeat(9) }
  ];
  const batches = PageTranslationTools.splitBatches(entries, { maxItems: 2, maxChars: 20 });
  check('request batches honor both item and text-size limits while preserving order',
    batches.length === 2 && batches.every((batch) => batch.length <= 2 && batch.reduce((n, row) => n + row.text.length, 0) <= 20) &&
    batches.flat().map((row) => row.id).join(',') === 'one,two,three,four', batches);
}

{
  const originals = records.map((record) => record.original);
  const translations = new Map(records.map((record, index) => [record.id, ['سلام ', 'دنیا', ' از این صفحه.', 'یک بند دیگر.'][index]]));
  PageTranslationTools.applyTranslations(records, translations);
  check('replaces eligible text nodes without changing inline markup structure',
    document.querySelector('#first').textContent === 'سلام دنیا از این صفحه.' &&
    document.querySelector('#first strong') !== null &&
    document.querySelector('#first strong').textContent === 'دنیا');
  check('Persian translations set RTL direction on their text blocks',
    document.querySelector('#first').getAttribute('dir') === 'rtl' &&
    document.querySelector('#second').getAttribute('dir') === 'rtl');
  check('RTL overrides site CSS forcing LTR on both blocks and inline text wrappers',
    dom.window.getComputedStyle(document.querySelector('#first')).direction === 'rtl' &&
    dom.window.getComputedStyle(document.querySelector('#first strong')).direction === 'rtl' &&
    document.querySelector('#first strong').style.getPropertyPriority('direction') === 'important');
  PageTranslationTools.showOriginal(records);
  check('original-text toggle restores every captured node and the site’s original direction styles',
    records.map((record) => record.node.nodeValue).join('|') === originals.join('|') &&
    document.querySelector('#first').getAttribute('dir') === 'ltr' &&
    !document.querySelector('#first').style.getPropertyValue('direction') &&
    !document.querySelector('#first').hasAttribute('style') &&
    !document.querySelector('#first strong').hasAttribute('dir') &&
    !document.querySelector('#first strong').hasAttribute('style') &&
    dom.window.getComputedStyle(document.querySelector('#first')).direction === 'ltr' &&
    !document.querySelector('#second').hasAttribute('dir'));
  PageTranslationTools.showTranslations(records);
  check('translated-text toggle reapplies RTL direction', document.querySelector('#first').getAttribute('dir') === 'rtl');
  PageTranslationTools.restoreOriginal(records);
  check('restore returns text and original direction attributes',
    document.querySelector('#first').innerHTML === 'Hello <strong>world</strong> from this page.' &&
    document.querySelector('#first').getAttribute('dir') === 'ltr' && !document.querySelector('#second').hasAttribute('dir'));
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PAGE TRANSLATION TESTS PASSED');
process.exit(failures ? 1 : 0);
