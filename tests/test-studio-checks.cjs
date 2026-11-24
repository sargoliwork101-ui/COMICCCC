'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { VERSION, plan, execute, main } = require('../scripts/studio-checks.cjs');

assert.equal(VERSION, '1.1.0');
const options = { python: '/python with spaces/python', npmCli: '/npm with spaces/npm-cli.js' };
const base = plan(options);
assert.ok(base.some(suite => suite.id === 'python'));
assert.ok(!base.some(suite => suite.id.startsWith('browser')));
assert.ok(!base.some(suite => suite.env?.COMIC_STUDIO_REAL_OCR_MEMORY));
const full = plan({ ...options, browser: true, realOcr: true });
assert.equal(full.length, base.length + 5);
assert.equal(new Set(full.map(suite => suite.id)).size, full.length);
assert.ok(full.some(suite => suite.id === 'browser-editor-header'));
assert.ok(full.some(suite => suite.id === 'browser-grid-notices'));
assert.ok(full.some(suite => suite.id === 'browser-workflow'));
assert.equal(full.find(suite => suite.id === 'real-ocr-memory').env.COMIC_STUDIO_REAL_OCR_MEMORY, '1');
assert.equal(full.find(suite => suite.id === 'real-ocr-memory').env.COMIC_STUDIO_REAL_OCR, '1');
assert.equal(base.find(suite => suite.id === 'extension').command[1], options.npmCli);
assert.equal(base.find(suite => suite.id === 'python').command[0], options.python);
assert.equal(main(['--unknown']), 2);

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-tester-'));
try {
  let index = 0;
  const outcomes = [
    { status: 1, stdout: 'failure evidence' },
    { status: 0, stdout: 'next suite still ran' },
    { status: null, signal: 'SIGTERM', error: new Error('timeout') },
    { status: 0, error: new Error('spawn failed') },
  ];
  const results = execute(['first', 'second', 'timeout', 'spawn-error'].map(id => ({ id, command: ['node', 'fake'] })), temporary, () => outcomes[index++]);
  assert.equal(index, 4, 'a failed suite must not hide the remaining checks');
  assert.deepEqual(results.map(result => result.status), ['failed', 'passed', 'failed', 'failed']);
  assert.ok(fs.readFileSync(path.join(temporary, 'first.log'), 'utf8').includes('failure evidence'));
  assert.ok(fs.readFileSync(path.join(temporary, 'timeout.log'), 'utf8').includes('timeout'));
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
console.log('PASS: tester plans all suites, preserves spaced paths, logs failure/timeout, and continues after failures');
