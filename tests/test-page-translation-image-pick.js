// Regression tests: clicking an image in pick mode selects the nearest text group
// (figure caption or nearest paragraph), because images have no text nodes of their own.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');
let failures = 0;
function check(name, condition, extra) {
  if (condition) console.log('PASS:', name);
  else { failures++; console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
const pause = () => new Promise((resolve) => setTimeout(resolve, 0));

(async () => {
  const dom = new JSDOM(`<!doctype html><html><body dir="ltr"><main>
    <p id="before">Intro paragraph text here.</p>
    <figure id="fig">
      <img id="photo" src="diagram.png" alt="diagram">
      <figcaption id="cap">Figure 1: the flyback circuit diagram.</figcaption>
    </figure>
    <p id="after">Closing paragraph text here.</p>
    <div id="bare"><img id="bareImg" src="x.png" alt="x"></div>
    <p id="tail">Tail paragraph text here.</p>
  </main></body></html>`, { url: 'https://example.test/doc', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  let listener = null;
  const coreSource = fs.readFileSync(path.join(__dirname, '../extension/src/core/page-translation.js'), 'utf8');
  vm.runInContext(coreSource, dom.getInternalVMContext(), { filename: 'page-translation.js' });
  window.chrome = {
    runtime: {
      onMessage: { addListener: (callback) => { listener = callback; } },
      sendMessage: async (message) => {
        if (message.type === 'WTPDF_TRANSLATE_PAGE_BATCH') {
          return { ok: true, provider: 'Google Translate', translations: message.entries.map((entry) => ({ id: entry.id, text: `FA(${entry.text.trim()})` })) };
        }
        return { ok: true };
      }
    }
  };
  const source = fs.readFileSync(path.join(__dirname, '../extension/src/page-translator/content.js'), 'utf8');
  vm.runInContext(source, dom.getInternalVMContext(), { filename: 'content.js' });
  listener({ type: 'WTPDF_PAGE_TRANSLATE_START', jobId: 'job-1', availableAiEngines: [] }, {}, () => {});
  await pause();
  const state = window.__wtpdfPageTranslation;
  check('page with a figure initializes pick mode', state && state.pickMode === true && state.groups.length >= 3,
    state && state.groups.length);

  const click = (element) => {
    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return event;
  };

  const imageEvent = click(window.document.getElementById('photo'));
  await pause();
  const captionGroup = state.groups.find((group) => group.block.id === 'cap');
  check('clicking the figure image selects the figure caption group',
    Boolean(captionGroup) && state.selectedGroups.has(captionGroup.id), [...state.selectedGroups]);
  check('image click is prevented so the site lightbox does not open', imageEvent.defaultPrevented === true);

  click(window.document.getElementById('bareImg'));
  await pause();
  check('clicking an image without a figure selects the nearest paragraph group',
    state.selectedGroups.size >= 2, [...state.selectedGroups]);

  const countBefore = state.selectedGroups.size;
  click(window.document.getElementById('before'));
  await pause();
  check('clicking a normal paragraph still toggles it', state.selectedGroups.size !== countBefore, [...state.selectedGroups]);

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL IMAGE PICK TESTS PASSED');
  process.exit(failures ? 1 : 0);
})();
