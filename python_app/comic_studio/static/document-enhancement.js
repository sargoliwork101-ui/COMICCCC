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
    threshold: { enabled: false, method: 'sauvola', window: 51, k: 0.2, r: 128 } });
  const fields = {
    upscale: [['factor', 'ضریب', [2, 3]]],
    grayscale: [],
    clahe: [['clip_limit', 'Clip Limit', 0.5, 8, 0.1], ['tile_grid', 'Tile Grid (N × N)', 2, 32, 1]],
    denoise: [['diameter', 'قطر همسایگی', 3, 9, 1], ['sigma_color', 'Sigma Color', 1, 100, 1], ['sigma_space', 'Sigma Space', 1, 100, 1]],
    unsharp: [['amount', 'Amount', 0, 3, 0.1], ['radius', 'Radius', 0.3, 4, 0.1]],
    threshold: [['method', 'روش', ['sauvola', 'adaptive_otsu']], ['window', 'Window / Otsu Tile — عدد فرد', 3, 201, 2], ['k', 'Sauvola k', 0.01, 0.5, 0.01], ['r', 'Sauvola R', 32, 255, 1]],
  };
  let config = defaults(); let host; let changed = () => {}; let documentMode = false;
  const copy = value => JSON.parse(JSON.stringify(value));
  function collect() {
    if (!host) return copy(config);
    config.enabled = host.querySelector('[data-master]').checked;
    host.querySelectorAll('[data-stage]').forEach(row => {
      const key = row.dataset.stage;
      config[key].enabled = row.querySelector('[data-on]').checked;
      row.querySelectorAll('[data-param]').forEach(input => {
        config[key][input.dataset.param] = input.tagName === 'SELECT' && input.dataset.param === 'method' ? input.value : Number(input.value);
      });
    });
    return copy(config);
  }
  function el(tag, text, cls) { const node = document.createElement(tag); if (text) node.textContent = text; if (cls) node.className = cls; return node; }
  function button(text, action) { const b = el('button', text, 'bt'); b.type = 'button'; b.addEventListener('click', action); return b; }
  function render() {
    if (!host) return;
    host.replaceChildren(); host.classList.toggle('hidden', !documentMode);
    const heading = el('h3', 'بهبود تصویر برای OCR'); host.append(heading);
    const subtitle = el('p', 'ویژهٔ کتاب و مقاله · پردازش نسخهٔ موقت', 'enhancement-subtitle'); host.append(subtitle);
    const label = el('label', null, 'enhancement-switch'); const master = el('input'); master.type = 'checkbox'; master.dataset.master = ''; master.checked = config.enabled;
    label.append(master, document.createTextNode('فعال‌سازی بهبود تصویر')); host.append(label);
    host.append(el('p', 'همهٔ فیلترها پیش‌فرض خاموش‌اند. ترتیب اجرا از بالا به پایین است؛ سیاه‌وسفیدکردن معمولاً آخر باشد.', 'hint'));
    const note = el('details', null, 'enhancement-note');
    note.append(el('summary', 'نکتهٔ پیش‌پردازش'));
    note.append(el('p', 'با فعال‌بودن حداقل یک فیلتر، این مراحل جایگزین کنتراست، بزرگ‌نمایی، شارپ و پیش‌پردازش فارسی قبلی می‌شوند. با خاموش‌کردن، همان روش قبلی اجرا می‌شود. تصویر اصلی تغییر نمی‌کند.', 'hint'));
    host.append(note);
    const list = el('div', null, 'enhancement-stages'); host.append(list);
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
        const details = el('details'); details.open = config[key].enabled; details.append(el('summary', 'تنظیمات فیلتر'));
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
        details.append(params); row.append(details);
      }
      list.append(row);
    });
    host.append(button('بازگرداندن همه به پیش‌فرض (خاموش)', () => { config = defaults(); render(); changed(collect()); }));
    master.addEventListener('change', () => { collect(); render(); changed(collect()); });
    host.querySelectorAll('[data-on], [data-param]').forEach(input => input.addEventListener('change', () => {
      collect();
      if (input.hasAttribute('data-on') || input.dataset.param === 'method') render();
      changed(collect());
    }));
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
    mount(node, onChange) { host = node; changed = onChange; render(); },
    setDocumentMode(value) { documentMode = value; if (host) host.classList.toggle('hidden', !value); },
    validate() { return !documentMode || !config.enabled || [...host.querySelectorAll('[data-param]')].every(input => input.reportValidity()); },
  };
})(typeof window === 'undefined' ? globalThis : window);
