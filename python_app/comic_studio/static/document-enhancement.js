/* Independent UI for the explicitly selected Books & Articles OCR path. */
(function (root) {
  'use strict';
  const names = { upscale: 'بزرگ‌نمایی', grayscale: 'خاکستری', clahe: 'کنتراست موضعی', denoise: 'کاهش نویز', unsharp: 'وضوح لبه', threshold: 'سیاه‌وسفید تطبیقی', contrast: 'کنتراست معمولی' };
  const technical = { upscale: 'Lanczos', grayscale: 'Grayscale', clahe: 'CLAHE', denoise: 'Bilateral', unsharp: 'Unsharp Mask', threshold: 'Adaptive Threshold', contrast: 'Contrast' };
  const defaults = () => ({ enabled: false, order: Object.keys(names),
    contrast: { enabled: false, strength: 1 },
    upscale: { enabled: false, factor: 2 }, grayscale: { enabled: false },
    clahe: { enabled: false, clip_limit: 2, tile_grid: 8 },
    denoise: { enabled: false, diameter: 5, sigma_color: 25, sigma_space: 25 },
    unsharp: { enabled: false, amount: 1, radius: 1 },
    threshold: { enabled: false, method: 'sauvola', window: 51, k: 0.2, r: 128, despeckle_area: 0 } });
  const fields = {
    contrast: [['strength', 'شدت کنتراست (۱ بدون تغییر)', 0.5, 3, 0.1]],
    upscale: [['factor', 'ضریب', [2, 3]]],
    grayscale: [],
    clahe: [['clip_limit', 'Clip Limit', 0.5, 8, 0.1], ['tile_grid', 'Tile Grid (N × N)', 2, 32, 1]],
    denoise: [['diameter', 'قطر همسایگی', 3, 9, 1], ['sigma_color', 'Sigma Color', 1, 100, 1], ['sigma_space', 'Sigma Space', 1, 100, 1]],
    unsharp: [['amount', 'Amount', 0, 3, 0.1], ['radius', 'Radius', 0.3, 4, 0.1]],
    threshold: [['method', 'روش', ['sauvola', 'adaptive_otsu']], ['window', 'Window / Otsu Tile — عدد فرد', 3, 201, 2], ['k', 'Sauvola k', 0.01, 0.5, 0.01], ['r', 'Sauvola R', 32, 255, 1], ['despeckle_area', 'حذف ذرات تا چند پیکسل؟ (۰ خاموش)', 0, 8, 1]],
  };
  let config = defaults(); let host; let changed = () => {}; let documentMode = false; let previewApi; let previewRevision = 0; let previewPage = ''; let workspace; let reorder = false;
  let previewTimer; let previewRunning = false; let previewPending = false; let refreshPreview;
  function requestAutoPreview() {
    clearTimeout(previewTimer); previewRevision += 1;
    const status = host?.querySelector('.enhancement-preview [role=status]');
    if (status) status.textContent = 'تنظیمات تغییر کرده؛ پیش‌نمایش خودکار در حال آماده‌سازی است…';
    previewTimer = setTimeout(() => {
      const dialog = host?.closest('dialog');
      if (!documentMode || (dialog && !dialog.open)) return;
      if (config.enabled && [...host.querySelectorAll('[data-param]')].some(input => !input.checkValidity())) return;
      if (previewRunning) { previewPending = true; return; }
      refreshPreview?.();
    }, 300);
  }
  // Mirrors document_enhancement.AFTER_THRESHOLD_POINTLESS. A stage that runs
  // after the binariser cannot change its output; say so instead of letting the
  // user wait for a filter that does nothing.
  const AFTER_THRESHOLD_POINTLESS = new Set(['contrast', 'clahe', 'grayscale']);
  function orderWarnings(cfg) {
    const enabled = cfg.order.filter(key => cfg[key] && cfg[key].enabled);
    if (!enabled.includes('threshold')) return [];
    const at = enabled.indexOf('threshold');
    return enabled.slice(at + 1)
      .filter(key => AFTER_THRESHOLD_POINTLESS.has(key) || key === 'unsharp')
      .map(key => AFTER_THRESHOLD_POINTLESS.has(key)
        ? `«${names[key]}» بعد از «سیاه‌وسفید تطبیقی» هیچ پیکسلی را عوض نمی‌کند؛ خروجی آن مرحله فقط سیاه و سفید است.`
        : '«وضوح لبه» بعد از «سیاه‌وسفید تطبیقی» فقط لبه‌ها را نرم می‌کند.');
  }
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
  function render(keepPreview = true) {
    if (!host) return;
    previewRevision += 1;
    const existingPreview = keepPreview ? host.querySelector('.enhancement-preview') : null;
    const heldViews = existingPreview ? [...existingPreview.querySelectorAll('.enhancement-image-viewport')].map(viewport => ({ viewport, left: viewport.scrollLeft, top: viewport.scrollTop })) : [];
    const openDetails = new Set([...host.querySelectorAll('[data-stage] details[open]')].map(node => node.closest('[data-stage]').dataset.stage));
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
      reorder = !reorder; controls.querySelectorAll('.enhancement-stage-head').forEach(head => { head.draggable = reorder; }); controls.classList.toggle('is-reordering', reorder); orderButton.setAttribute('aria-pressed', String(reorder));
    });
    orderButton.setAttribute('aria-pressed', String(reorder)); controls.classList.toggle('is-reordering', reorder);
    tools.append(orderButton);
    // The advisor sits on its own row under the filters heading, so it never
    // displaces the reorder toggle that sits beside the heading.
    tools.append(buildAdvisor(controls));
    controls.append(tools);
    const list = el('div', null, 'enhancement-stages'); controls.append(list);
    config.order.forEach((key, index) => {
      const row = el('section', null, 'enhancement-stage'); row.dataset.stage = key;
      row.addEventListener('dragover', event => { if (reorder) event.preventDefault(); });
      row.addEventListener('drop', event => {
        if (!reorder) return;
        event.preventDefault();
        const from = config.order.indexOf(event.dataTransfer.getData('text/plain'));
        if (from < 0 || from === index) return;
        collect(); const [moved] = config.order.splice(from, 1); config.order.splice(index, 0, moved);
        render(); changed(collect());
      });
      const head = el('div', null, 'enhancement-stage-head'); const onLabel = el('label', null, 'enhancement-switch');
      head.draggable = reorder; head.title = 'برای تغییر ترتیب، ردیف را بکشید یا از فلش‌ها استفاده کنید';
      head.addEventListener('dragstart', event => {
        if (!reorder || event.target.closest('input,button')) { event.preventDefault(); return; }
        event.dataTransfer.setData('text/plain', key); event.dataTransfer.effectAllowed = 'move';
      });
      const on = el('input'); on.type = 'checkbox'; on.dataset.on = ''; on.checked = config[key].enabled;
      const caption = el('span', null, 'enhancement-caption');
      caption.append(el('span', `${index + 1}. ${names[key]}`, 'enhancement-name'));
      const term = el('bdi', technical[key], 'enhancement-term'); term.dir = 'ltr'; caption.append(term);
      onLabel.append(on, caption); head.append(onLabel);
      const move = delta => { collect(); const next = index + delta; [config.order[index], config.order[next]] = [config.order[next], config.order[index]]; render(); changed(collect()); };
      const up = button('↑', () => move(-1)); up.disabled = index === 0; up.setAttribute('aria-label', `بالا بردن ${key}`); up.title = 'اجرای زودتر';
      const down = button('↓', () => move(1)); down.disabled = index === config.order.length - 1; down.setAttribute('aria-label', `پایین بردن ${key}`); down.title = 'اجرای دیرتر'; head.append(up, down); row.append(head);
      if (fields[key].length) {
        const details = el('details'); details.open = openDetails.has(key); details.append(el('summary', 'تنظیمات فیلتر'));
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
    const warnings = orderWarnings(config);
    if (warnings.length) {
      const warn = el('div', null, 'enhancement-order-warning');
      warn.setAttribute('role', 'status');
      warn.append(el('strong', 'چیدمان فعلی بخشی از کار را هدر می‌دهد'));
      warnings.forEach(text => warn.append(el('p', text)));
      const fix = button('درست کردن ترتیب', () => {
        collect();
        const rest = config.order.filter(key => key !== 'threshold');
        config.order = [...rest, 'threshold'];
        render(); changed(collect());
      });
      fix.dataset.fixOrder = '';
      warn.append(fix);
      controls.append(warn);
    }
    controls.append(note);
    host.append(button('بازگرداندن همه به پیش‌فرض (خاموش)', () => { config = defaults(); reorder = false; previewPage = ''; previewApi?.reset?.(); render(false); changed(collect()); }));
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
    if (existingPreview) {
      workspace.append(existingPreview);
      // Detaching a scroll container can reset scroll offsets even if its image
      // and zoom styles survive. Restore immediately after layout, not at fetch.
      for (const view of heldViews) { void view.viewport.offsetHeight; view.viewport.scrollLeft = view.left; view.viewport.scrollTop = view.top; }
    } else appendPreview();
    master.addEventListener('change', () => { collect(); render(); changed(collect()); });
    host.querySelectorAll('input[data-param]').forEach(input => input.addEventListener('input', () => {
      if (input.value === '' || !input.validity.valid) return;
      collect(); previewRevision += 1;
      const savedStatus = host.querySelector('[data-enhancement-save-status]');
      if (savedStatus) savedStatus.textContent = 'تغییرات جدید؛ ذخیرهٔ خودکار فعال است.';

      const update = host.querySelector('[data-preview-update]');
      if (update) update.disabled = !previewApi.pages().length;
      changed(collect());
    }));
    host.querySelectorAll('[data-on], [data-param]').forEach(input => input.addEventListener('change', () => {
      collect();
      previewRevision += 1;

      const update = host.querySelector('[data-preview-update]');
      if (update) update.disabled = !previewApi.pages().length;
      if (input.hasAttribute('data-on') || input.dataset.param === 'method') render();
      changed(collect());
    }));
  }
  // ---- Smart combination + ordering -------------------------------------
  // The analyser measures the page (contrast, noise, blur, uneven light) and
  // proposes which filters to enable and in what order. It never applies
  // anything by itself: the proposal is shown first so the user can accept it,
  // edit it, or start OCR straight from the accepted settings.
  function stageLine(label, value) {
    const row = el('span', null, 'advisor-why');
    row.append(el('b', label + ': '), document.createTextNode(value));
    return row;
  }
  function buildAdvisor(controls) {
    const box = el('div', null, 'enhancement-advisor');
    const state = { proposal: null, busy: false };
    const status = el('p', '', 'hint advisor-status');
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const result = el('div', null, 'advisor-result hidden');
    const goBtn = button('تشخیص بهترین ترکیب', async () => {
      if (state.busy) return;
      const pages = previewApi?.pages?.() || [];
      if (!pages.length) { status.textContent = 'ابتدا حداقل یک صفحه در پروژه انتخاب کنید.'; return; }
      if (!previewApi?.analyze) { status.textContent = 'تحلیل در این نسخه در دسترس نیست.'; return; }
      const select = host.querySelector('[data-preview-page]');
      const page = pages.find(item => item.id === select?.value) || pages[0];
      state.busy = true; goBtn.disabled = true;
      status.textContent = 'در حال بررسی صفحه…';
      result.classList.add('hidden');
      try {
        const data = await previewApi.analyze(page.id);
        state.proposal = data;
        renderProposal(data, page);
        status.textContent = '';
      } catch (error) {
        status.textContent = `تحلیل انجام نشد: ${error.message}`;
      } finally {
        state.busy = false; goBtn.disabled = false;
      }
    });
    goBtn.dataset.smartEnhance = '';
    goBtn.className = 'bt primary';
    goBtn.title = 'صفحه را بررسی می‌کند و بهترین ترکیب و ترتیب فیلترها را پیشنهاد می‌دهد؛ تا تأیید نکنید اعمال نمی‌شود.';

    function renderProposal(data, page) {
      result.replaceChildren();
      result.classList.remove('hidden');
      const proposed = data.proposed || {};
      const stages = (proposed.order || []).filter(key => proposed[key] && proposed[key].enabled);
      if (!stages.length) {
        result.append(el('p', 'برای این صفحه فیلتری لازم نیست؛ با همین تصویر اصلی ادامه دهید.', 'advisor-empty'));
        return;
      }
      result.append(el('p', `پیشنهاد برای صفحهٔ «${page.name}» — ترتیب از بالا به پایین:`, 'advisor-title'));
      const list = el('ol', null, 'advisor-stages');
      stages.forEach(key => {
        const li = el('li');
        li.append(el('b', names[key]));
        const why = (data.reasons || []).find(entry => entry.stage === key);
        if (why) li.append(document.createTextNode(` — ${why.why}`));
        list.append(li);
      });
      result.append(list);
      if ((data.reasons || []).length) {
        const whyBox = el('div', null, 'advisor-why-box');
        whyBox.append(el('strong', 'چرا این ترکیب؟'));
        (data.reasons || []).forEach(entry => whyBox.append(stageLine(names[entry.stage], entry.why)));
        result.append(whyBox);
      }
      const stats = data.stats || {};
      const measured = el('div', null, 'advisor-why-box advisor-stats');
      measured.append(el('strong', 'اندازه‌گیری صفحه (نه درصد دقت):'));
      measured.append(stageLine('کنتراست', `${stats.contrast}`));
      measured.append(stageLine('نویز', `${stats.noise}`));
      measured.append(stageLine('تاری لبه', `${Math.round((stats.blur || 0) * 100)}٪`));
      result.append(measured);
      (data.notes || []).forEach(note => result.append(el('p', note, 'hint advisor-note')));
      result.append(el('p', 'این پیشنهاد بر اساس ظاهر تصویر است، نه تضمین دقت OCR. اگر نپسندیدید، هیچ‌چیز عوض نشده است.', 'hint advisor-disclaimer'));
      const actions = el('div', null, 'advisor-actions');
      const accept = button('تأیید و پیش‌نمایش', () => applyProposal(data, false));
      accept.className = 'bt primary'; accept.dataset.acceptProposal = '';
      const acceptRun = button('تأیید و شروع OCR', () => applyProposal(data, true));
      acceptRun.dataset.acceptAndRun = '';
      const dismiss = button('رد کردن', () => { state.proposal = null; result.classList.add('hidden'); status.textContent = 'پیشنهاد رد شد؛ تنظیمات دست‌نخورده ماند.'; });
      actions.append(accept, acceptRun, dismiss);
      result.append(actions);
    }

    function applyProposal(data, runOcr) {
      // Merge onto the defaults so every stage keeps a complete parameter set,
      // then lift the proposal over it and re-render the normal controls.
      const next = defaults();
      next.enabled = true;
      const proposed = data.proposed || {};
      Object.keys(names).forEach(key => {
        if (proposed[key] && typeof proposed[key] === 'object') Object.assign(next[key], proposed[key]);
      });
      if (Array.isArray(proposed.order) && proposed.order.length === Object.keys(names).length) next.order = [...proposed.order];
      config = next; reorder = false;
      render(false);
      changed(collect());
      status.textContent = runOcr ? 'تنظیمات پیشنهادی اعمال شد و OCR شروع می‌شود…' : 'تنظیمات پیشنهادی اعمال شد؛ پیش‌نمایش ساخته می‌شود.';
      result.classList.add('hidden');
      if (runOcr && typeof root.__comicStartOcr === 'function') root.__comicStartOcr();
      else requestAutoPreview();
    }

    box.append(goBtn, status, result);
    return box;
  }

  function appendPreview() {
    if (!previewApi) return;
    const section = el('section', null, 'enhancement-preview');
    section.append(el('h4', 'پیش‌نمایش در همین صفحه'));
    const toolbar = el('div', null, 'enhancement-preview-toolbar');
    const label = el('label', 'صفحه'); const select = el('select'); select.dataset.previewPage = '';
    select.setAttribute('aria-label', 'صفحهٔ پیش‌نمایش'); label.append(select);
    const output = el('div'); output.dataset.previewOutput = '';
    const status = el('p', 'پیش‌نمایش با تغییر تنظیمات خودکار عوض می‌شود. OCR اجرا نمی‌شود.', 'hint'); status.setAttribute('role', 'status');
    const refreshPages = () => {
      const pages = previewApi.pages(); select.replaceChildren();
      pages.forEach(page => { const option = el('option', page.name); option.value = page.id; select.append(option); });
      if (pages.some(page => page.id === previewPage)) select.value = previewPage;
      previewPage = select.value;
      update.disabled = !pages.length;
      if (!pages.length) status.textContent = 'ابتدا حداقل یک صفحه در پروژه انتخاب کنید.';
    };
    const runPreview = async () => {
      clearTimeout(previewTimer);
      if (previewRunning) { previewPending = true; return; }
      if (!root.DocumentEnhancement.validate()) return;
      refreshPages();
      const page = previewApi.pages().find(item => item.id === select.value);
      if (!page) return;
      const revision = ++previewRevision;
      previewRunning = true; update.disabled = true; status.textContent = 'در حال ساخت پیش‌نمایش… تصویر قبلی تا آماده‌شدن نتیجه حفظ می‌شود.';
      try {
        const result = await previewApi.render(page.id, collect());
        // Decode offscreen first: replacing src before decoding can temporarily
        // collapse the image and clamp scrollTop/Left to zero in real browsers.
        if (typeof Image.prototype.decode === 'function') {
          const decoded = new Image(); decoded.src = result.image; await decoded.decode();
        }
        if (revision !== previewRevision || !section.isConnected) return;
        const previousImages = [...output.querySelectorAll('.enhancement-image-viewport')];
        if (previousImages.length === 2 && output.dataset.pageId === page.id && output.dataset.original === page.original) {
          const viewport = previousImages[1]; const image = viewport.querySelector('img');
          const left = viewport.scrollLeft; const top = viewport.scrollTop;
          const rect = image.getBoundingClientRect();
          const oldHeight = image.style.height;
          // Reserve current geometry through the src swap. Keep the current
          // visible region, including pans performed while processing ran.
          if (rect.height) image.style.height = `${rect.height}px`;
          image.onload = () => {
            image.style.height = oldHeight;
            viewport.scrollLeft = left; viewport.scrollTop = top; image.onload = null;
            syncNavigation(viewport);
          };
          image.src = result.image;
          viewport.scrollLeft = left; viewport.scrollTop = top;
        } else {
        output.replaceChildren(); output.dataset.pageId = page.id; output.dataset.original = page.original;
        const zoomLabel = el('label', null, 'enhancement-switch'); const zoom = el('input'); zoom.type = 'checkbox';
        zoomLabel.append(zoom, document.createTextNode('نمایش در اندازهٔ واقعی (با اسکرول)'));
        const comparison = el('div', null, 'enhancement-comparison');
        for (const [title, url] of [['تصویر اصلی', page.original], ['نتیجهٔ تنظیمات', result.image]]) {
          const figure = el('figure'); figure.append(el('figcaption', title));
          const viewport = el('div', null, 'enhancement-image-viewport'); const image = el('img'); image.alt = title; image.src = url;
          viewport.append(image); figure.append(viewport); comparison.append(figure); enableNavigation(viewport, image);
        }
        zoom.addEventListener('change', () => {
          comparison.classList.toggle('actual-size', zoom.checked);
          comparison.querySelector('.enhancement-image-viewport').dispatchEvent(new CustomEvent('preview-scale', { detail: zoom.checked ? 'actual' : 'fit' }));
        });
        output.append(el('p', 'زوم و جابه‌جایی دو تصویر همگام است · Ctrl + اسکرول: زوم · کشیدن: جابه‌جایی · دوبار کلیک: نمایش کامل', 'hint'));
        output.append(zoomLabel, comparison);
        }
        status.textContent = result.active
          ? `پیش‌نمایش فیلترها آماده است (${result.width} × ${result.height}). ظاهر بهتر، تضمین دقت OCR نیست.`
          : 'فیلتر فعالی وجود ندارد؛ نتیجه همان تصویر اصلی است، نه پیش‌پردازش قدیمی OCR.';
      } catch (error) {
        if (revision === previewRevision && section.isConnected) { output.replaceChildren(); status.textContent = `پیش‌نمایش ساخته نشد: ${error.message}`; }
      } finally {
        previewRunning = false;
        if (section.isConnected) update.disabled = false;
        if (previewPending) { previewPending = false; requestAutoPreview(); }
      }
    };
    refreshPreview = runPreview;
    const update = button('تلاش دوباره', runPreview);
    update.dataset.previewUpdate = '';
    select.addEventListener('change', () => { previewPage = select.value; output.replaceChildren(); update.disabled = false; requestAutoPreview(); });
    select.addEventListener('focus', refreshPages);
    toolbar.append(label, update); section.append(toolbar, status, output); workspace.append(section); refreshPages();
    output.append(el('p', 'پیش‌نمایش صفحهٔ انتخابی به‌صورت خودکار همین‌جا نمایش داده می‌شود.', 'enhancement-preview-empty'));
  }
  function syncNavigation(source) {
    const comparison = source.closest('.enhancement-comparison');
    if (!comparison || comparison._syncing) return;
    comparison._syncing = true;
    try {
      const image = source.querySelector('img');
      source._syncedScroll = [source.scrollLeft, source.scrollTop];
      for (const peer of comparison.querySelectorAll('.enhancement-image-viewport')) {
        if (peer === source) continue;
        const peerImage = peer.querySelector('img');
        // Match display/document scale, not natural pixel size: the result may
        // contain 2x/3x more pixels but represents exactly the same page region.
        peerImage.style.width = image.style.width;
        peerImage.style.maxWidth = image.style.maxWidth;
        if (Math.abs(peer.scrollLeft - source.scrollLeft) > 0.5) peer.scrollLeft = source.scrollLeft;
        if (Math.abs(peer.scrollTop - source.scrollTop) > 0.5) peer.scrollTop = source.scrollTop;
        peer._syncedScroll = [peer.scrollLeft, peer.scrollTop];
      }
    } finally { comparison._syncing = false; }
  }
  function enableNavigation(viewport, image) {
    let drag = null;
    image.draggable = false; viewport.tabIndex = 0;
    viewport.setAttribute('aria-label', 'پیش‌نمایش؛ کنترل و اسکرول برای زوم، کشیدن برای جابه‌جایی');
    const fit = () => {
      image.style.width = '100%'; image.style.maxWidth = '100%';
      viewport.scrollLeft = 0; viewport.scrollTop = 0;
      syncNavigation(viewport);
    };
    viewport.addEventListener('preview-scale', event => {
      if (event.detail === 'fit') fit();
      else { const original = viewport.closest('.enhancement-comparison').querySelector('img'); image.style.width = `${original.naturalWidth || image.naturalWidth || image.width}px`; image.style.maxWidth = 'none'; syncNavigation(viewport); }
    });
    viewport.addEventListener('dblclick', fit);
    viewport.addEventListener('wheel', event => {
      if (!event.ctrlKey || !image.naturalWidth) return;
      event.preventDefault();
      const bounds = viewport.getBoundingClientRect();
      const x = event.clientX - bounds.left; const y = event.clientY - bounds.top;
      const oldWidth = image.getBoundingClientRect().width;
      if (!oldWidth) return;
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1);
      const width = Math.max(32, Math.min((viewport.closest('.enhancement-comparison')?.querySelector('img').naturalWidth || image.naturalWidth) * 8, oldWidth * Math.exp(-Math.max(-200, Math.min(200, delta)) * 0.003)));
      const ratio = width / oldWidth;
      const left = (viewport.scrollLeft + x) * ratio - x;
      const top = (viewport.scrollTop + y) * ratio - y;
      image.style.width = `${width}px`; image.style.maxWidth = 'none';
      viewport.scrollLeft = left; viewport.scrollTop = top;
      syncNavigation(viewport);
    }, { passive: false });
    viewport.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
      viewport.setPointerCapture?.(event.pointerId); viewport.classList.add('is-panning'); event.preventDefault();
    });
    viewport.addEventListener('pointermove', event => {
      if (!drag || drag.id !== event.pointerId) return;
      viewport.scrollLeft = drag.left - (event.clientX - drag.x);
      viewport.scrollTop = drag.top - (event.clientY - drag.y);
      syncNavigation(viewport);
    });
    viewport.addEventListener('scroll', () => {
      const last = viewport._syncedScroll;
      if (last && Math.abs(last[0] - viewport.scrollLeft) < 0.5 && Math.abs(last[1] - viewport.scrollTop) < 0.5) return;
      syncNavigation(viewport);
    });
    const stop = () => { drag = null; viewport.classList.remove('is-panning'); };
    viewport.addEventListener('pointerup', stop); viewport.addEventListener('pointercancel', stop); viewport.addEventListener('lostpointercapture', stop);
  }
  function load(saved) {
    config = defaults();
    if (saved && typeof saved === 'object') {
      config.enabled = saved.enabled === true;
      if (Array.isArray(saved.order) && [6, 7].includes(saved.order.length) && new Set(saved.order).size === saved.order.length && saved.order.every(k => Object.hasOwn(names, k)) && (saved.order.length === 7 || !saved.order.includes('contrast'))) config.order = [...saved.order, ...(saved.order.length === 6 ? ['contrast'] : [])];
      Object.keys(names).forEach(key => { Object.keys(config[key]).forEach(param => { if (saved[key] && Object.hasOwn(saved[key], param)) config[key][param] = saved[key][param]; }); });
    }
    render(false); requestAutoPreview();
  }
  root.DocumentEnhancement = { defaults, collect, load,
    mount(node, onChange, preview) { host = node; changed = value => { onChange(value); requestAutoPreview(); }; previewApi = preview; render(false); },
    setDocumentMode(value) { documentMode = value; render(false); requestAutoPreview(); },
    // Read/override the host-provided transport (page list, preview, analyser).
    // Test harnesses and future callers need it; the UI itself never uses it.
    get previewApi() { return previewApi; },
    set previewApi(value) { previewApi = value; },
    validate() { return !documentMode || !config.enabled || [...host.querySelectorAll('[data-param]')].every(input => input.reportValidity()); },
  };
})(typeof window === 'undefined' ? globalThis : window);
