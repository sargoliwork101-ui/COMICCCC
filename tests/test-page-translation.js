// Regression tests for extracting visible webpage text and applying translations without replacing page markup.
const { JSDOM } = require('jsdom');
const PageTranslationTools = require('../extension/src/core/page-translation.js');

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

{
  // Sites commonly set text-align:left/justify; translated Persian text must be
  // right-aligned regardless, and the site alignment must come back for original text.
  const alignDom = new JSDOM(`<!doctype html><html dir="ltr"><head><style>
    #aligned { text-align: left; }
    #justified { text-align: justify; }
  </style></head><body>
    <p id="aligned">A left-aligned paragraph.</p>
    <p id="justified">A justified paragraph.</p>
  </body></html>`, { pretendToBeVisual: true });
  const alignDoc = alignDom.window.document;
  const alignRecords = PageTranslationTools.collectTextNodes(alignDoc.body, alignDoc);
  const alignTranslations = new Map(alignRecords.map((record) => [record.id, 'متن فارسی']));
  PageTranslationTools.applyTranslations(alignRecords, alignTranslations);
  check('translated paragraphs are right-aligned despite site text-align:left/justify',
    alignDom.window.getComputedStyle(alignDoc.querySelector('#aligned')).textAlign === 'right' &&
    alignDom.window.getComputedStyle(alignDoc.querySelector('#justified')).textAlign === 'right' &&
    alignDoc.querySelector('#aligned').style.getPropertyValue('text-align') === 'right');
  PageTranslationTools.showOriginal(alignRecords);
  check('showing original text restores the site alignment and removes inline styles',
    alignDom.window.getComputedStyle(alignDoc.querySelector('#aligned')).textAlign === 'left' &&
    alignDom.window.getComputedStyle(alignDoc.querySelector('#justified')).textAlign === 'justify' &&
    !alignDoc.querySelector('#aligned').hasAttribute('style') &&
    !alignDoc.querySelector('#justified').hasAttribute('style'));
  PageTranslationTools.showTranslations(alignRecords);
  check('re-showing the translation re-applies right alignment',
    alignDom.window.getComputedStyle(alignDoc.querySelector('#aligned')).textAlign === 'right');
}

{
  // Loose text nodes in one <article> share a single direction target; switching one
  // paragraph back to its original text must not strip RTL from the other translated one.
  const sharedDom = new JSDOM(`<!doctype html><html><body>
    <article id="shared"><span>First loose text</span><span>Second loose text</span></article>
  </body></html>`, { pretendToBeVisual: true });
  const sharedDoc = sharedDom.window.document;
  const sharedRecords = PageTranslationTools.collectTextNodes(sharedDoc.body, sharedDoc);
  const [first, second] = sharedRecords;
  const sharedTranslations = new Map(sharedRecords.map((record) => [record.id, 'ترجمه فارسی']));
  PageTranslationTools.applyTranslations([first], sharedTranslations);
  PageTranslationTools.applyTranslations([second], sharedTranslations);
  check('shared direction target carries RTL while both paragraphs are translated',
    sharedDoc.querySelector('#shared').getAttribute('dir') === 'rtl');
  PageTranslationTools.showVersion([first], new Map([[first.id, first.original]]), new Set());
  check('switching one paragraph to original keeps RTL for the still-translated paragraph',
    sharedDoc.querySelector('#shared').getAttribute('dir') === 'rtl' &&
    second.node.nodeValue === 'ترجمه فارسی');
  PageTranslationTools.showVersion([second], new Map([[second.id, second.original]]), new Set());
  check('target direction is restored once no paragraph needs RTL',
    sharedDoc.querySelector('#shared').getAttribute('dir') === null);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PAGE TRANSLATION TESTS PASSED');
process.exit(failures ? 1 : 0);
