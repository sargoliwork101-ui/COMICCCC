/* Independent UI for the explicitly selected Books & Articles OCR path. */
(function (root) {
  'use strict';
  const names = { upscale: 'بزرگ‌نمایی', grayscale: 'خاکستری', clahe: 'کنتراست موضعی', denoise: 'کاهش نویز', unsharp: 'وضوح لبه', threshold: 'سیاه‌وسفید تطبیقی' };
  const technical = { upscale: 'Lanczos', grayscale: 'Grayscale', clahe: 'CLAHE', denoise: 'Bilateral', unsharp: 'Unsharp Mask', threshold: 'Adaptive Threshold' };
  const defaults = () => ({ enabled: false, order: Object.keys(names),
    upscale: { enabled: false, factor: 2 }, grayscale: { enabled: false },
    clahe: { enabled: false, clip_limit: 2, tile_grid: 8 },
    denoise: { enabled: false, diameter: 5, sigma_color: 25, sigma_space: 25 },
    unsharp: { enabled: false, amount: 1, radius: 1 },
    threshold: { enabled: false, method: 'sauvola', window: 51, k: 0.2, r: 128, despeckle_area: 0 } });
  const fields = {
    upscale: [['factor', 'ضریب', [2, 3]]],
    grayscale: [],
    clahe: [['clip_limit', 'Clip Limit', 0.5, 8, 0.1], ['tile_grid', 'Tile Grid (N × N)', 2, 32, 1]],
    denoise: [['diameter', 'قطر همسایگی', 3, 9, 1], ['sigma_color', 'Sigma Color', 1, 100, 1], ['sigma_space', 'Sigma Space', 1, 100, 1]],
    unsharp: [['amount', 'Amount', 0, 3, 0.1], ['radius', 'Radius', 0.3, 4, 0.1]],
    threshold: [['method', 'روش', ['sauvola', 'adaptive_otsu']], ['window', 'Window / Otsu Tile — عدد فرد', 3, 201, 2], ['k', 'Sauvola k', 0.01, 0.5, 0.01], ['r', 'Sauvola R', 32, 255, 1], ['despeckle_area', 'حذف ذرات تا چند پیکسل؟ (۰ خاموش)', 0, 8, 1]],
  };
  let config = defaults(); let host; let changed = () => {}; let documentMode = false; let previewApi; let previewRevision = 0; let previewPage = ''; let workspace; let reorder = false;
  const copy = value => JSON.parse(JSON.stringify(value));
  function collect() {
    if (!host) return copy(config);
    config.enabled = host.querySelector('[data-master]').checked;
    host.querySelectorAll('[data-stage]').forEach(row => {
      const key = row.dataset.stage;
      config[key].enabled = row.querySelector('[data-on]').checked;
      row.querySelectorAll('[data-param]').forEach(input => {
        if (input.value !== '' && input.validity.valid) config[key][input.dataset.param] = input.tagName === 'SELECT' && input.dataset.param === 'method' ? input.value : Number(input.value);
      });
    });
    return copy(config);
  }
  function el(tag, text, cls) { const node = document.createElement(tag); if (text) node.textContent = text; if (cls) node.className = cls; return node; }
  function button(text, action) { const b = el('button', text, 'bt'); b.type = 'button'; b.addEventListener('click', action); return b; }
  function render() {
    if (!host) return;
    previewRevision += 1;
    host.replaceChildren(); host.classList.toggle('hidden', !documentMode);
    const heading = el('h3', 'بهبود تصویر برای OCR'); host.append(heading);
    const subtitle = el('p', 'ویژهٔ کتاب و مقاله · پردازش نسخهٔ موقت', 'enhancement-subtitle'); host.append(subtitle);
    const label = el('label', null, 'enhancement-switch'); const master = el('input'); master.type = 'checkbox'; master.dataset.master = ''; master.checked = config.enabled;
    label.append(master, document.createTextNode('فعال‌سازی بهبود تصویر')); host.append(label);
    host.append(el('p', 'همهٔ فیلترها پیش‌فرض خاموش‌اند. ترتیب اجرا از بالا به پایین است؛ سیاه‌وسفیدکردن معمولاً آخر باشد.', 'hint'));
    const note = el('details', null, 'enhancement-note');
    note.append(el('summary', 'نکتهٔ پیش‌پردازش'));
    note.append(el('p', 'با فعال‌بودن حداقل یک فیلتر، این مراحل جایگزین کنتراست، بزرگ‌نمایی، شارپ و پیش‌پردازش فارسی قبلی می‌شوند. با خاموش‌کردن، همان روش قبلی اجرا می‌شود. تصویر اصلی تغییر نمی‌کند.', 'hint'));
    workspace = el('div', null, 'enhancement-workspace');
    const controls = el('div', null, 'enhancement-controls');
    workspace.append(controls); host.append(workspace);
    const tools = el('div', null, 'enhancement-controls-head');
    tools.append(el('h4', 'فیلترهای تصویر'));
    const orderButton = button('تغییر ترتیب', () => {
      reorder = !reorder; controls.classList.toggle('is-reordering', reorder); orderButton.setAttribute('aria-pressed', String(reorder));
    });
    orderButton.setAttribute('aria-pressed', String(reorder)); controls.classList.toggle('is-reordering', reorder);
    tools.append(orderButton); controls.append(tools);
    const list = el('div', null, 'enhancement-stages'); controls.append(list);
    config.order.forEach((key, index) => {
      const row = el('section', null, 'enhancement-stage'); row.dataset.stage = key;
      const head = el('div', null, 'enhancement-stage-head'); const onLabel = el('label', null, 'enhancement-switch');
      const on = el('input'); on.type = 'checkbox'; on.dataset.on = ''; on.checked = config[key].enabled;
      const caption = el('span', null, 'enhancement-caption');
      caption.append(el('span', `${index + 1}. ${names[key]}`, 'enhancement-name'));
      const term = el('bdi', technical[key], 'enhancement-term'); term.dir = 'ltr'; caption.append(term);
      onLabel.append(on, caption); head.append(onLabel);
      const move = delta => { collect(); const next = index + delta; [config.order[index], config.order[next]] = [config.order[next], config.order[index]]; render(); changed(collect()); };
      const up = button('↑', () => move(-1)); up.disabled = index === 0; up.setAttribute('aria-label', `بالا بردن ${key}`); up.title = 'اجرای زودتر';
      const down = button('↓', () => move(1)); down.disabled = index === config.order.length - 1; down.setAttribute('aria-label', `پایین بردن ${key}`); down.title = 'اجرای دیرتر'; head.append(up, down); row.append(head);
      if (fields[key].length) {
        const details = el('details'); details.append(el('summary', 'تنظیمات فیلتر'));
        const params = el('fieldset', null, 'enhancement-params'); params.disabled = !config[key].enabled || !config.enabled;
        fields[key].forEach(([param, title, min, max, step]) => {
          const wrap = el('label'); const fieldTitle = el('bdi', title); fieldTitle.dir = 'auto'; wrap.append(fieldTitle); let input;
          if (Array.isArray(min)) { input = el('select'); min.forEach(value => { const opt = el('option', value === 'sauvola' ? 'Sauvola' : value === 'adaptive_otsu' ? 'Otsu محلی' : `${value}×`); opt.value = value; input.append(opt); }); }
          else { input = el('input'); input.type = 'number'; input.min = min; input.max = max; input.step = step; input.required = true; }
          input.dataset.param = param; input.value = config[key][param]; input.dir = 'ltr';
          input.setAttribute('aria-label', `${names[key]} ${title}`);
          // k/R affect Sauvola only; window is shared with local Otsu.
          if (key === 'threshold' && ['k', 'r'].includes(param)) input.disabled = config.threshold.method !== 'sauvola';
          wrap.append(input); params.append(wrap);
        });
        details.append(params);
        if (key === 'threshold') details.append(el('p', 'حذف ذرات فقط اجزای سیاهِ جدا و بسیار کوچک را پاک می‌کند؛ از ۱ یا ۲ شروع کنید. مقدار زیاد ممکن است نقطهٔ حروف و علائم را حذف کند. مساحت در اندازهٔ خروجی سنجیده می‌شود؛ هیچ بهبود دقتی تضمین نیست.', 'hint'));
        row.append(details);
      }
      list.append(row);
    });
    controls.append(note);
    host.append(button('بازگرداندن همه به پیش‌فرض (خاموش)', () => { config = defaults(); render(); changed(collect()); }));
    if (previewApi?.save) {
      const saveStatus = el('span', '', 'hint'); saveStatus.dataset.enhancementSaveStatus = ''; saveStatus.setAttribute('role', 'status');
      const save = button('ذخیرهٔ تنظیمات', async () => {
        if (!root.DocumentEnhancement.validate()) return;
        collect(); save.disabled = true; saveStatus.textContent = 'در حال ذخیره…';
        try { await previewApi.save(); saveStatus.textContent = 'تنظیمات ذخیره شد'; }
        catch (error) { saveStatus.textContent = `ذخیره نشد: ${error.message}`; }
        finally { save.disabled = false; }
      });
      save.dataset.saveEnhancement = ''; host.append(save, saveStatus);
    }
    appendPreview();
    master.addEventListener('change', () => { collect(); render(); changed(collect()); });
    host.querySelectorAll('input[data-param]').forEach(input => input.addEventListener('input', () => {
      if (input.value === '' || !input.validity.valid) return;
      collect(); previewRevision += 1;
      const savedStatus = host.querySelector('[data-enhancement-save-status]');
      if (savedStatus) savedStatus.textContent = 'تغییرات جدید؛ ذخیرهٔ خودکار فعال است.';
      host.querySelector('[data-preview-output]')?.replaceChildren();
      const update = host.querySelector('[data-preview-update]');
      if (update) { update.disabled = !previewApi.pages().length; host.querySelector('.enhancement-preview [role=status]').textContent = 'تنظیمات تغییر کرده؛ پیش‌نمایش را به‌روز کنید.'; }
      changed(collect());
    }));
    host.querySelectorAll('[data-on], [data-param]').forEach(input => input.addEventListener('change', () => {
      collect();
      previewRevision += 1;
      host.querySelector('[data-preview-output]')?.replaceChildren();
      const update = host.querySelector('[data-preview-update]');
      if (update) { update.disabled = !previewApi.pages().length; host.querySelector('.enhancement-preview [role=status]').textContent = 'تنظیمات تغییر کرده؛ پیش‌نمایش را به‌روز کنید.'; }
      if (input.hasAttribute('data-on') || input.dataset.param === 'method') render();
      changed(collect());
    }));
  }
  function appendPreview() {
    if (!previewApi) return;
    const section = el('section', null, 'enhancement-preview');
    section.append(el('h4', 'پیش‌نمایش در همین صفحه'));
    const toolbar = el('div', null, 'enhancement-preview-toolbar');
    const label = el('label', 'صفحه'); const select = el('select'); select.dataset.previewPage = '';
    select.setAttribute('aria-label', 'صفحهٔ پیش‌نمایش'); label.append(select);
    const output = el('div'); output.dataset.previewOutput = '';
    const status = el('p', 'پس از تغییر تنظیمات، پیش‌نمایش را به‌روز کنید. OCR اجرا نمی‌شود.', 'hint'); status.setAttribute('role', 'status');
    const refreshPages = () => {
      const pages = previewApi.pages(); select.replaceChildren();
      pages.forEach(page => { const option = el('option', page.name); option.value = page.id; select.append(option); });
      if (pages.some(page => page.id === previewPage)) select.value = previewPage;
      previewPage = select.value;
      update.disabled = !pages.length;
      if (!pages.length) status.textContent = 'ابتدا حداقل یک صفحه در پروژه انتخاب کنید.';
    };
    const update = button('به‌روزرسانی پیش‌نمایش', async () => {
      if (!root.DocumentEnhancement.validate()) return;
      refreshPages();
      const page = previewApi.pages().find(item => item.id === select.value);
      if (!page) return;
      const revision = ++previewRevision;
      update.disabled = true; output.replaceChildren(); status.textContent = 'در حال ساخت پیش‌نمایش…';
      try {
        const result = await previewApi.render(page.id, collect());
        if (revision !== previewRevision || !section.isConnected) return;
        const zoomLabel = el('label', null, 'enhancement-switch'); const zoom = el('input'); zoom.type = 'checkbox';
        zoomLabel.append(zoom, document.createTextNode('نمایش در اندازهٔ واقعی (با اسکرول)'));
        const comparison = el('div', null, 'enhancement-comparison');
        for (const [title, url] of [['تصویر اصلی', page.original], ['نتیجهٔ تنظیمات', result.image]]) {
          const figure = el('figure'); figure.append(el('figcaption', title));
          const viewport = el('div', null, 'enhancement-image-viewport'); const image = el('img'); image.alt = title; image.src = url;
          viewport.append(image); figure.append(viewport); comparison.append(figure);
        }
        zoom.addEventListener('change', () => comparison.classList.toggle('actual-size', zoom.checked));
        output.append(zoomLabel, comparison);
        status.textContent = result.active
          ? `پیش‌نمایش فیلترها آماده است (${result.width} × ${result.height}). ظاهر بهتر، تضمین دقت OCR نیست.`
          : 'فیلتر فعالی وجود ندارد؛ نتیجه همان تصویر اصلی است، نه پیش‌پردازش قدیمی OCR.';
      } catch (error) {
        if (revision === previewRevision && section.isConnected) { output.replaceChildren(); status.textContent = `پیش‌نمایش ساخته نشد: ${error.message}`; }
      } finally {
        if (revision === previewRevision && section.isConnected) update.disabled = false;
      }
    });
    update.dataset.previewUpdate = '';
    select.addEventListener('change', () => { previewPage = select.value; previewRevision += 1; output.replaceChildren(); update.disabled = false; status.textContent = 'برای صفحهٔ جدید، پیش‌نمایش را به‌روز کنید.'; });
    select.addEventListener('focus', refreshPages);
    toolbar.append(label, update); section.append(toolbar, status, output); workspace.append(section); refreshPages();
    output.append(el('p', 'یک صفحه انتخاب کنید و «به‌روزرسانی پیش‌نمایش» را بزنید تا اصل و نتیجه همین‌جا نمایش داده شوند.', 'enhancement-preview-empty'));
  }
  function load(saved) {
    config = defaults();
    if (saved && typeof saved === 'object') {
      config.enabled = saved.enabled === true;
      if (Array.isArray(saved.order) && saved.order.length === 6 && new Set(saved.order).size === 6 && saved.order.every(k => Object.hasOwn(names, k))) config.order = [...saved.order];
      Object.keys(names).forEach(key => { Object.keys(config[key]).forEach(param => { if (saved[key] && Object.hasOwn(saved[key], param)) config[key][param] = saved[key][param]; }); });
    }
    render();
  }
  root.DocumentEnhancement = { defaults, collect, load,
    mount(node, onChange, preview) { host = node; changed = onChange; previewApi = preview; render(); },
    setDocumentMode(value) { documentMode = value; render(); },
    validate() { return !documentMode || !config.enabled || [...host.querySelectorAll('[data-param]')].every(input => input.reportValidity()); },
  };
})(typeof window === 'undefined' ? globalThis : window);
