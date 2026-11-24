'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../comic_studio/static/app.js'), 'utf8');
const code = source.slice(source.indexOf('function inlineBaseFontSize()'), source.indexOf('function applyStylePatchToElement'));
const elements = {};
const element = id => elements[id] ||= { value: '', classList: { add() {}, remove() {} } };
const field = element('inlineEditorField'); field.textContent = 'سلام دنیا'; field.querySelector = () => null;
const node = { nodeType: 1, style: {} };
let inherited = null; let selected = false; let liveSize = 27;
const block = { tr: 'سلام', size: null };
const draft = { block, initialAutoSize: true, sizeTouched: false, range: { startContainer: node, toString: () => 'سلام' } };
const context = vm.createContext({
  $: element, inlineDraft: draft, document: { activeElement: null }, Node: { ELEMENT_NODE: 1 },
  updateInlineSelectionHighlight() {}, hasInlineWordSelection: () => selected,
  inlineSelectionSpan: () => node, inlineInheritedLogicalSize: () => inherited,
  inlineInheritedStyle: () => '', inlineParagraphFrom: () => node, logicalFontSizeOf: () => null,
  canonicalFontOption: () => 'Vazirmatn', normalizeHexColor: () => '', effectiveInlineColor: () => '', classicEditor: null,
  draftBlockForPreview: () => ({ ...block, tr: field.textContent }), overlayBlock: b => b,
  clampedBoxOf: () => ({ x0: 0, y0: 0, x1: 100, y1: 100 }),
  overlaySize: () => liveSize,
});
vm.runInContext(code, context);
const sync = () => vm.runInContext('syncInlineLineControls()', context);
sync(); assert.equal(element('inlineLineSize').value, '27', 'plain Persian inherits live automatic size');
selected = true; sync(); assert.equal(element('inlineLineSize').value, '27', 'unstyled selection inherits size');
inherited = 38; sync(); assert.equal(element('inlineLineSize').value, '38', 'explicit word size wins');
selected = false; sync(); assert.equal(element('inlineLineSize').value, '38', 'caret in styled word inherits word size');
inherited = null; field.textContent = ''; sync(); assert.equal(element('inlineLineSize').value, '27', 'empty box shows its starting size');
field.textContent = 'متن تازه و طولانی'; liveSize = 19; sync(); assert.equal(element('inlineLineSize').value, '19', 'typing refreshes automatic size');
context.document.activeElement = element('inlineLineSize'); element('inlineLineSize').value = '4'; sync();
assert.equal(element('inlineLineSize').value, '4', 'sync never overwrites in-progress input');
assert.equal(block.size, null); assert.equal(draft.sizeTouched, false); assert.equal(draft.initialAutoSize, true);
console.log('Font size controls: passed');
