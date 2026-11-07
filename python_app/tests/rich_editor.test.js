const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><div id="one"></div><div id="two"></div>', { url: 'http://localhost/', pretendToBeVisual: true, runScripts: 'dangerously' });
const { window } = dom;
for (const file of ['rich-sanitize.js', 'rich-editor.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../comic_studio/static', file), 'utf8'), dom.getInternalVMContext());
window.confirm = () => true;
const sanitize = window.ComicSanitize.sanitize;
const safe = sanitize('<script>BAD</script><iframe>BAD2</iframe><p onclick="evil()" style="color:rgb(10, 20, 30);position:fixed">ok <a href="javascript:evil()">unsafe</a><a href="https://example.com" target="_blank">good</a><img src="javascript:evil()" onerror="evil()"></p>');
assert(!/BAD|iframe|script|onclick|position|javascript|onerror/.test(safe));
assert(safe.includes('color:#0a141e') && safe.includes('unsafe') && safe.includes('rel="noopener noreferrer"'));
assert(!sanitize('<img src="data:image/svg+xml;base64,PHN2Zy8+">').includes('<img'));
assert(sanitize('<table><tbody><tr><td>one</td><td>two</td></tr></tbody></table><hr data-readmore="true">').includes('<table>'));
let changes = 0;
const editor = window.createEditor('#one', { autosaveKey: 'test-draft', initialHTML: '<p>initial</p>', onChange: () => changes++ });
assert.equal(editor.getHTML(), '<p>initial</p>');
assert.equal(editor.element.querySelector('button[aria-label="نمایش ابزارهای پیشرفته"]'), null, 'more-tools toggle button is removed');
assert.ok(editor.element.querySelector('button[aria-label="درج جدول"]') && editor.element.querySelector('select[aria-label="قالب بند"]'), 'all toolbar tools are shown directly');
const unsub = editor.onChange(() => changes++);
editor.setHTML('<p>hello <b>world</b></p>');
assert.equal(changes, 2); assert(editor.getText().includes('hello world')); unsub();
editor.element.querySelectorAll('[role=tab]')[1].click();
const source = editor.element.querySelector('textarea'); source.value = '<h2>title</h2><script>unsafe</script><p>text</p>'; source.dispatchEvent(new window.Event('input', { bubbles: true }));
assert(!editor.getHTML().includes('script')); editor.element.querySelectorAll('[role=tab]')[0].click();
assert(editor.getHTML().includes('<h2>title</h2>'));
editor.saveDraft(); assert(window.localStorage.getItem('test-draft'));
const second = window.createEditor('#two', { autosaveKey: 'test-draft', initialHTML: '<p>initial</p>' });
assert(second.getHTML().includes('<h2>title</h2>'), 'a new editor restores the saved draft');
second.setHTML(''); second.saveDraft(); second.destroy();
const recoveredEmpty = window.createEditor('#two', { autosaveKey: 'test-draft', initialHTML: '<p>initial</p>' });
assert.equal(recoveredEmpty.getHTML(), '', 'a deliberately empty draft can be recovered');
recoveredEmpty.setHTML('<p>unwanted draft</p>'); recoveredEmpty.saveDraft();
assert(window.localStorage.getItem('test-draft'));
let confirmCount = 0;
window.confirm = () => { confirmCount += 1; return false; };
assert.equal(recoveredEmpty.setContext('test-draft', '<p>initial</p>', 'rev-1'), false);
assert.equal(confirmCount, 1);
assert.equal(recoveredEmpty.getHTML(), '<p>initial</p>', 'declined draft keeps current HTML');
assert.equal(window.localStorage.getItem('test-draft'), null, 'declined draft is removed from localStorage');
assert.equal(recoveredEmpty.setContext('test-draft', '<p>initial</p>', 'rev-1'), false);
assert.equal(confirmCount, 1, 'declined draft does not prompt again on next open');
window.confirm = () => true;
recoveredEmpty.clearDraft(); assert.equal(window.localStorage.getItem('test-draft'), null);
(async () => {
  let asyncPromptMsg = '';
  const asyncEditor = window.createEditor('#two', {
    confirmDraft: (msg) => { asyncPromptMsg = msg; return Promise.resolve(true); },
  });
  window.localStorage.setItem('async-draft', JSON.stringify({ html: '<p>از پیش‌نویس</p>', base: 'r1', time: 'now', meta: null }));
  const restored = await asyncEditor.setContext('async-draft', '<p>initial</p>', 'r1');
  assert.equal(restored, true, 'async confirmDraft resolves true when accepted');
  assert.ok(asyncPromptMsg.includes('پیش‌نویس'), 'confirmDraft receives Persian message');
  assert.equal(asyncEditor.getHTML(), '<p>از پیش‌نویس</p>', 'async confirmDraft restores saved HTML');
  asyncEditor.clearDraft();

  // v3.68: .classic-modal Escape capture priority, Tab focus trap, backdrop click, and lifecycle auto-close
  let docEscCount = 0;
  const docEscSpy = (ev) => { if (ev.key === 'Escape') docEscCount += 1; };
  window.document.addEventListener('keydown', docEscSpy);
  editor.element.querySelector('button[aria-label="درج پیوند (Ctrl+K)"]').click();
  assert.equal(editor.hasOpenModal(), true, 'link dialog opens .classic-modal');
  const modalEl = editor.element.querySelector('.classic-modal');
  assert.ok(modalEl, '.classic-modal exists in DOM');
  const focusables = [...modalEl.querySelectorAll('input,button')];
  assert.ok(focusables.length >= 4, 'link modal has inputs and buttons');
  assert.equal(window.document.activeElement, focusables[0], 'first input receives initial focus');
  // Shift+Tab from first wraps to last
  focusables[0].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
  assert.equal(window.document.activeElement, focusables[focusables.length - 1], 'Shift+Tab wraps from first to last');
  // Tab from last wraps to first
  focusables[focusables.length - 1].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  assert.equal(window.document.activeElement, focusables[0], 'Tab wraps from last to first');
  // Escape closes ONLY .classic-modal even when focus moved outside modal (capture-phase interception)
  window.document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(editor.hasOpenModal(), false, 'Escape closes .classic-modal');
  assert.equal(docEscCount, 0, 'Escape was intercepted before bubble listeners could close parent editor');
  window.document.removeEventListener('keydown', docEscSpy);

  // Backdrop click closes .classic-modal, clicking inside .classic-modal-box does not
  editor.element.querySelector('button[aria-label="درج جدول"]').click();
  assert.equal(editor.hasOpenModal(), true);
  const tableModal = editor.element.querySelector('.classic-modal');
  tableModal.querySelector('.classic-modal-box').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  assert.equal(editor.hasOpenModal(), true, 'clicking inside modal box keeps modal open');
  tableModal.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  assert.equal(editor.hasOpenModal(), false, 'clicking modal backdrop closes modal');

  // Auto-close on setContext, setPlainMode(true), and resetToolbar
  editor.element.querySelector('button[aria-label="درج تصویر"]').click();
  assert.equal(editor.hasOpenModal(), true);
  editor.setContext('other-block', '<p>next</p>', 'r2');
  assert.equal(editor.hasOpenModal(), false, 'setContext auto-closes open modal');
  editor.element.querySelector('button[aria-label="درج پیوند (Ctrl+K)"]').click();
  assert.equal(editor.hasOpenModal(), true);
  editor.setPlainMode(true);
  assert.equal(editor.hasOpenModal(), false, 'setPlainMode(true) auto-closes open modal');
  editor.setPlainMode(false);
  editor.element.querySelector('button[aria-label="درج پیوند (Ctrl+K)"]').click();
  assert.equal(editor.hasOpenModal(), true);
  editor.resetToolbar();
  assert.equal(editor.hasOpenModal(), false, 'resetToolbar auto-closes open modal');

  asyncEditor.destroy();
  editor.destroy(); recoveredEmpty.destroy(); dom.window.close();
  console.log('rich editor: safe HTML, API, tabs, autosave, async confirmDraft and empty-draft recovery passed');
})().catch((err) => { console.error(err); process.exitCode = 1; });
