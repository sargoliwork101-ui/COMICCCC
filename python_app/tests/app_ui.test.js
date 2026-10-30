const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..', 'comic_studio', 'static');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
const dom = new JSDOM(html, { url: 'http://127.0.0.1:8765/', pretendToBeVisual: true, runScripts: 'dangerously' });
const { window } = dom;
const context = dom.getInternalVMContext();
const project = {
  id: 'project-ui', name: 'آزمایش', updatedAt: '', images: [{
    id: 'image-ui', name: 'page.png', file: 'page.png', width: 320, height: 200,
    order: 0, selected: true, groupId: null, crop: null, blocks: [], edited: false,
  }], settings: { output: {} },
};
const summary = { id: project.id, name: project.name, updatedAt: '', images: 1 };
const engine = { id: 'rapidocr-v6', name: 'RapidOCR', selectable: true, runtimeInstalled: true, languages: ['eng'], readyLanguages: ['eng'], description: '', family: '' };
const beacons = [];
const jsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: () => 'application/json' },
  json: async () => payload,
});
window.fetch = async (url, options = {}) => {
  const parsed = new URL(url, 'http://127.0.0.1:8765');
  const pathname = parsed.pathname;
  if (pathname === '/api/projects' && (!options.method || options.method === 'GET')) return jsonResponse([summary]);
  if (pathname === '/api/projects' && options.method === 'POST') return jsonResponse(project, 201);
  if (pathname === `/api/projects/${project.id}`) return jsonResponse(project);
  if (pathname === '/api/engines') return jsonResponse([engine]);
  if (pathname === '/api/ai-settings') return jsonResponse({ provider: 'free', base_url: '', model: '', hasApiKey: false });
  if (pathname === '/api/activity') return jsonResponse({ entries: [], next: 0 });
  if (pathname === '/api/session/heartbeat') return jsonResponse({ ok: true, active: 1 });
  if (pathname === `/api/projects/${project.id}/state`) return jsonResponse(JSON.parse(options.body).state);
  if (pathname === `/api/projects/${project.id}/images/${project.images[0].id}/content`) return { ok: true, blob: async () => new window.Blob() };
  throw new Error(`Unmocked request: ${options.method || 'GET'} ${url}`);
};
window.navigator.sendBeacon = (url, body) => { beacons.push({ url, body }); return true; };
window.confirm = () => true;
window.requestAnimationFrame = (callback) => setTimeout(callback, 0);
window.cancelAnimationFrame = (id) => clearTimeout(id);
window.HTMLElement.prototype.scrollIntoView = () => {};
window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
window.HTMLDialogElement.prototype.close = function () { this.open = false; };
window.document.execCommand = () => true;
window.URL.createObjectURL = () => 'blob:ui-test';
window.URL.revokeObjectURL = () => {};

for (const file of ['groups.js', 'app.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
function check(name, condition) {
  if (condition) console.log(`PASS: ${name}`);
  else { failures += 1; console.error(`FAIL: ${name}`); }
}

(async () => {
  await sleep(60);
  const $ = (id) => window.document.getElementById(id);
  check('one image card is rendered', window.document.querySelectorAll('#grid .item').length === 1);
  check('image starts selected', $('grid').querySelector('.item').classList.contains('selected'));

  $('grid').querySelector('img').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('clicking the image deselects the card', !$('grid').querySelector('.item').classList.contains('selected'));
  check('selection summary follows image clicks', $('selectionSummary').textContent.includes('0 از 1'));

  $('grid').querySelector('img').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('clicking the image again selects the card', $('grid').querySelector('.item').classList.contains('selected'));

  $('grid').querySelector('.act button').click();
  check('eye button still opens preview instead of changing selection', $('previewDialog').open && $('grid').querySelector('.item').classList.contains('selected'));

  vm.runInContext("appendLocalActivity('در حال دانلود آزمایشی')", context);
  check('live activity is visible on the page', $('activityLog').textContent.includes('در حال دانلود آزمایشی'));
  check('live activity is mirrored in model dialog', $('modelActivityLog').textContent.includes('در حال دانلود آزمایشی'));

  window.dispatchEvent(new window.Event('pagehide'));
  check('closing a tab sends a close beacon', beacons.some((entry) => entry.url === '/api/session/close'));
  window.close();
  if (failures) process.exitCode = 1;
})().catch((error) => { console.error(error); window.close(); process.exitCode = 1; });
