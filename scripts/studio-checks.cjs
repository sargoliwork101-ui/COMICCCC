'use strict';
// Test runner 1.1.0. This file never starts the user's installed Studio/project.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const VERSION = '1.1.0';

function plan({ browser = false, realOcr = false, python, npmCli }) {
  const node = process.execPath;
  const js = (id, file) => ({ id, command: [node, file] });
  const suites = [
    js('tester', 'tests/test-studio-checks.cjs'),
    { id: 'python', command: [python, '-m', 'pytest', 'python_app/tests'] },
    js('font-size-controls', 'python_app/tests/font_size_controls.test.cjs'),
    js('studio-ui', 'python_app/tests/app_ui.test.js'),
    js('groups', 'python_app/tests/groups.test.js'),
    js('inline-edit', 'python_app/tests/inline_edit_session.test.cjs'),
    js('rich-editor', 'python_app/tests/rich_editor.test.js'),
    js('typeset', 'python_app/tests/typeset_overlay.test.js'),
    js('lint', 'node_modules/eslint/bin/eslint.js'),
    { id: 'extension', command: [node, npmCli, 'test'] },
  ];
  if (browser) suites.push(
    js('browser-main-toolbar', 'python_app/tests/main_toolbar_browser.test.cjs'),
    js('browser-editor-header', 'python_app/tests/editor_header_browser.test.cjs'),
    js('browser-extension', 'tests/test-extension-browser.cjs'),
    js('browser-grid-notices', 'python_app/tests/grid_memory_browser.test.cjs'),
    js('browser-workflow', 'python_app/tests/app_browser.test.cjs'),
  );
  if (realOcr) suites.push({ id: 'real-ocr-memory', command: [python, '-m', 'pytest',
    'python_app/tests', '-m', 'real_ocr', '-s', '-rs'],
  env: { COMIC_STUDIO_REAL_OCR_MEMORY: '1', COMIC_STUDIO_REAL_OCR: '1' } });
  return suites;
}

function execute(suites, directory, run = spawnSync) {
  fs.mkdirSync(directory, { recursive: true });
  const results = [];
  for (const suite of suites) {
    console.log(`\nبررسی: ${suite.id}`);
    const started = Date.now();
    const result = run(suite.command[0], suite.command.slice(1), {
      cwd: ROOT, encoding: 'utf8', timeout: 30 * 60 * 1000, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, COMIC_STUDIO_REAL_OCR: '0', COMIC_STUDIO_REAL_OCR_MEMORY: '0', ...suite.env }, windowsHide: true,
    });
    const log = `${result.stdout || ''}\n${result.stderr || ''}\n${result.error?.message || ''}`;
    fs.writeFileSync(path.join(directory, `${suite.id}.log`), log);
    const passed = result.status === 0 && !result.error && !result.signal;
    results.push({ id: suite.id, status: passed ? 'passed' : 'failed', exitCode: result.status,
      signal: result.signal || null, seconds: (Date.now() - started) / 1000, log: `${suite.id}.log` });
    console.log(`${passed ? 'موفق' : 'ناموفق'}: ${suite.id}`);
    if (!passed) console.log(log.slice(-4000));
  }
  return results;
}

function main(args = process.argv.slice(2)) {
  const allowed = new Set(['--list', '--browser', '--real-ocr']);
  if (args.some(arg => !allowed.has(arg))) {
    console.error('گزینهٔ نامعتبر. گزینه‌ها: --list --browser --real-ocr');
    return 2;
  }
  const python = process.env.COMIC_STUDIO_PYTHON || path.join(ROOT, 'python_app', '.venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const npmCli = process.env.npm_execpath;
  if (!npmCli) {
    console.error('تستر را با npm run test:studio اجرا کنید.');
    return 2;
  }
  const suites = plan({ python, npmCli, browser: args.includes('--browser'), realOcr: args.includes('--real-ocr') });
  if (args.includes('--list')) {
    console.log(JSON.stringify({ testerVersion: VERSION, suites }, null, 2));
    return 0;
  }
  const directory = path.join(ROOT, '.cache', 'test-reports', new Date().toISOString().replace(/[:.]/g, '-'));
  const results = execute(suites.map(suite => ({ ...suite, env: { COMIC_STUDIO_PYTHON: python, ...suite.env } })), directory);
  const omitted = [!args.includes('--browser') && 'browser', !args.includes('--real-ocr') && 'real-ocr'].filter(Boolean);
  const appVersion = fs.readFileSync(path.join(ROOT, 'python_app/comic_studio/__init__.py'), 'utf8').match(/APP_VERSION = "([^"]+)"/)?.[1];
  const summary = { testerVersion: VERSION, appVersion, completedAt: new Date().toISOString(), results, omitted,
    note: 'خروج موفق pytest می‌تواند شامل skipped باشد؛ برای مدل واقعی و تعداد تست‌ها log را بخوانید.' };
  fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(`\nگزارش: ${path.relative(ROOT, directory)}/summary.json`);
  if (omitted.length) console.log(`اجرا نشده: ${omitted.join(', ')}`);
  return results.some(item => item.status === 'failed') ? 1 : 0;
}

module.exports = { VERSION, plan, execute, main };
if (require.main === module) process.exitCode = main();
