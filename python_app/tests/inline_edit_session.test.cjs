const assert = require('node:assert/strict');
const { createInlineEditSession } = require('../comic_studio/static/inline-edit-session.js');

function snapshot(block) {
  return JSON.stringify([block.text || '', block.tr || '', block.richHtml || '', block.dir || '', block.align || '', block.size ?? null, block.color || null, block.verticalAlign || '']);
}

let block = { id: 4, text: 'source', tr: 'translation', richHtml: '<p>translation</p>', dir: 'rtl', align: 'right', size: 18, color: null, verticalAlign: 'middle', tx0: 10 };
let baseline = snapshot(block); let saved = 0; let conflicts = 0;
const values = { text: 'live text', richHtml: '<p>live text</p>', dir: 'ltr', align: 'justify', verticalAlign: 'bottom', size: 27, color: '#112233' };
const session = createInlineEditSession({
  block, mode: 'translation', read: () => values, getBaseline: () => baseline, snapshot,
  onCommit: (updated, current) => { assert.equal(updated, block); baseline = current; saved += 1; },
  onConflict: () => { conflicts += 1; },
});

assert.equal(session.previewBlock().tr, 'live text');
assert.equal(block.tr, 'translation', 'preview reads the live input without mutating project state');
assert.equal(session.commit(), true);
assert.equal(block.tr, 'live text'); assert.equal(block.richHtml, '<p>live text</p>');
assert.equal(block.dir, 'ltr'); assert.equal(block.align, 'justify'); assert.equal(block.verticalAlign, 'bottom');
assert.equal(block.size, 27); assert.equal(block.color, '#112233'); assert.equal(block.tx0, 10, 'editing never overwrites geometry');
assert.equal(saved, 1);
assert.equal(session.commit(), true); assert.equal(saved, 1, 'no-op input events do not trigger duplicate saves');

values.text = 'new local text';
block.tr = 'external change';
assert.equal(session.commit(), false, 'external modifications are protected from auto-apply');
assert.equal(block.tr, 'external change'); assert.equal(conflicts, 1);
baseline = snapshot(block);
assert.equal(session.commit(), true, 'the editor can continue after the external change is reconciled');
assert.equal(block.tr, 'new local text'); assert.equal(saved, 2);

const sourceBlock = { text: 'recognized', tr: 'keep translation', richHtml: '<b>keep translation</b>', align: 'left' };
let sourceBaseline = snapshot(sourceBlock);
const sourceSession = createInlineEditSession({
  block: sourceBlock, mode: 'ocr', read: () => ({ ...values, text: 'corrected OCR' }), getBaseline: () => sourceBaseline, snapshot,
  onCommit: (updated, current) => { sourceBaseline = current; },
});
assert.equal(sourceSession.commit(), true);
assert.equal(sourceBlock.text, 'corrected OCR');
assert.equal(sourceBlock.tr, 'keep translation'); assert.equal(sourceBlock.richHtml, '<b>keep translation</b>');
assert.equal(sourceSession.close(), true); assert.equal(sourceSession.commit(), false, 'closed sessions cannot mutate project data');

console.log('PASS: inline edit sessions preview, auto-commit, preserve geometry, and protect concurrent edits');
