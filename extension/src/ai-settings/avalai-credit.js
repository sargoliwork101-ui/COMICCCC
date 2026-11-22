// Experimental read-only account inquiry. Never treats account credit as a key budget.
(() => {
  'use strict';
  const endpoint = 'https://api.avalai.ir/user/v1/credit';
  function mount(row, keyInput) {
    const box = document.createElement('div'); box.className = 'credit-inquiry';
    const button = document.createElement('button'); button.type = 'button';
    button.className = 'btn secondary credit-check'; button.textContent = 'استعلام اعتبار AvalAI';
    const report = document.createElement('div'); report.className = 'credit-report';
    report.setAttribute('role', 'status'); report.setAttribute('aria-live', 'polite');
    const usageButton = document.createElement('button'); usageButton.type = 'button';
    usageButton.className = 'btn secondary usage-check'; usageButton.textContent = 'آزمایش مصرف کلیدها (۲۴ ساعت)';
    const idLabel = document.createElement('label'); idLabel.textContent = 'شناسهٔ عددی کلید (اختیاری؛ نه خود کلید API)';
    const keyId = document.createElement('input'); keyId.type = 'text'; keyId.inputMode = 'numeric';
    keyId.className = 'credit-key-id'; keyId.placeholder = 'مثلاً 123؛ خالی = گزارش گروه‌بندی‌شده';
    idLabel.append(keyId);
    const raw = document.createElement('div'); raw.className = 'credit-raw';
    const field = (label, className, value) => {
      const wrap = document.createElement('label'); wrap.textContent = label;
      const input = document.createElement('input'); input.type = 'text'; input.className = className; input.value = value;
      wrap.append(input); return { wrap, input };
    };
    const hours = field('بازهٔ فهرست تراکنش‌ها (۱ تا ۷۲۰ ساعت)', 'credit-hours', '720');
    const page = field('صفحهٔ تراکنش‌ها (۱ تا ۱۰۰۰۰؛ هر صفحه ۱۰۰ رکورد)', 'credit-page', '1');
    const requests = field('شناسهٔ درخواست‌ها برای lookup؛ با فاصله یا ویرگول جدا کنید (نه کلید API)', 'credit-request-ids', '');
    const makeButton = (text, cls) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn secondary ' + cls; b.textContent = text; return b; };
    const transactionsButton = makeButton('فهرست تراکنش‌ها', 'transactions-check');
    const lookupButton = makeButton('هزینهٔ درخواست‌های مشخص', 'lookup-check');
    const allButton = makeButton('استعلام همهٔ روش‌های مستند', 'all-credit-check');
    const buttons = [button, usageButton, transactionsButton, lookupButton, allButton];
    box.append(button, idLabel, usageButton, hours.wrap, page.wrap, transactionsButton, requests.wrap, lookupButton, allButton, report, raw); row.append(box);
    let generation = 0, controller;
    const invalidate = () => {
      generation++; controller?.abort(); report.replaceChildren(); raw.replaceChildren(); buttons.forEach(b => { b.disabled = false; });
    };
    keyInput.addEventListener('input', invalidate);
    keyId.addEventListener('input', invalidate);
    for (const control of [hours.input, page.input, requests.input]) control.addEventListener('input', invalidate);
    const line = (label, value) => {
      const p = document.createElement('p'); p.textContent = label + ': ' + value; report.append(p);
    };
    const number = (value, digits = 2) => {
      if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return 'اعلام نشده';
      const n = Number(value); return Number.isFinite(n) ? n.toLocaleString('fa-IR', { maximumFractionDigits: digits }) : 'نامعتبر';
    };
    const inquire = async (mode = 'credit', append = false) => {
      const usage = mode === 'summary';
      if (button.disabled) return;
      const apiKey = keyInput.value.trim();
      if (!append) { report.replaceChildren(); raw.replaceChildren(); }
      if (!apiKey) { line('خطا', 'ابتدا کلید API را وارد کنید.'); keyInput.focus(); return; }
      const id = keyId.value.trim();
      if (mode !== 'credit' && id && !/^[1-9][0-9]*$/.test(id)) { line('خطا', 'شناسه باید عدد صحیح مثبت با رقم انگلیسی باشد؛ خود کلید API را اینجا ننویسید.'); return; }
      const ids = requests.input.value.trim().split(/[\s,،]+/).filter(Boolean);
      if (mode === 'transactions' && (!/^[0-9]+$/.test(hours.input.value) || +hours.input.value < 1 || +hours.input.value > 720 || !/^[0-9]+$/.test(page.input.value) || +page.input.value < 1 || +page.input.value > 10000)) { line('خطا', 'بازه یا شمارهٔ صفحه معتبر نیست.'); return; }
      if (mode === 'lookup' && (!ids.length || ids.length > 100 || ids.some(value => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)))) { line('lookup اجرا نشد', '۱ تا ۱۰۰ شناسهٔ درخواست UUID لازم است؛ کلید API وارد نکنید.'); return; }
      const current = ++generation;
      controller = new AbortController();
      const requestController = controller;
      const timer = setTimeout(() => requestController.abort(), 15000);
      buttons.forEach(b => { b.disabled = true; }); line('وضعیت', 'در حال دریافت اطلاعات از AvalAI…');
      let rawBody = null, httpStatus = null;
      let url = endpoint;
      try {
        url = usage ? 'https://api.avalai.ir/user/v1/transactions/summary?group_by=api_key&hours_ago=24' + (id ? '&api_key_id=' + encodeURIComponent(id) : '') : endpoint;
        if (mode === 'transactions') url = 'https://api.avalai.ir/user/v1/transactions?hours_ago=' + hours.input.value + '&page=' + page.input.value + '&page_size=100' + (id ? '&api_key_id=' + id : '');
        if (mode === 'lookup') url = 'https://api.avalai.ir/user/v1/transactions/lookup';
        const response = await fetch(url, {
          method: mode === 'lookup' ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + apiKey, ...(mode === 'lookup' ? { 'Content-Type': 'application/json' } : {}) },
          ...(mode === 'lookup' ? { body: JSON.stringify({ transaction_ids: ids }) } : {}),
          signal: requestController.signal, credentials: 'omit', cache: 'no-store', redirect: 'error'
        });
        httpStatus = response.status;
        rawBody = await response.text();
        if (!response.ok) {
          const messages = { 401: 'کلید معتبر نیست یا منقضی شده است.', 403: 'دسترسی مجاز نیست یا حساب غیرفعال است.', 429: 'تعداد استعلام‌ها زیاد است؛ کمی بعد دوباره امتحان کنید.' };
          throw new Error(messages[response.status] || 'استعلام ناموفق بود (HTTP ' + response.status + ').');
        }
        let data;
        try { data = JSON.parse(rawBody); } catch { throw new Error('پاسخ سرویس JSON معتبر نیست.'); }
        if (mode === 'transactions' || mode === 'lookup') {
          if (current !== generation || !row.isConnected || keyInput.value.trim() !== apiKey) return;
          if (!append) report.replaceChildren();
          line('روش', mode === 'lookup' ? 'هزینهٔ درخواست‌های مشخص' : 'فهرست تراکنش‌ها');
          if (!data || !Array.isArray(data.transactions)) throw new Error('ساختار پاسخ تراکنش‌ها شناخته نشد.');
          line('تعداد تراکنش در پاسخ', data.transactions.length);
          line('محدودیت', 'این داده مانده یا انقضای کلید نیست. بدون شناسهٔ کلید ممکن است تراکنش‌های دیگر حساب برگردد.');
          if (mode === 'transactions') line('صفحه‌بندی', 'فقط صفحهٔ ' + page.input.value + ' دریافت شد؛ برای ادامه شمارهٔ صفحه را افزایش دهید. مصرف کل عمر محاسبه نمی‌شود.');
          return;
        }
        if (usage) {
          if (!data || typeof data !== 'object' || !data.totals || !Object.hasOwn(data, 'by_api_key') || (data.by_api_key !== null && !Array.isArray(data.by_api_key))) throw new Error('ساختار پاسخ مصرف شناخته نشد.');
          if (current !== generation || !row.isConnected || keyInput.value.trim() !== apiKey) return;
          if (!append) report.replaceChildren();
          line('گزارش آزمایشی', 'مصرف حداکثر ۲۴ ساعت است، نه مصرف کل عمر یا ماندهٔ اعتبار. پاسخ ممکن است تا ۲ دقیقه کش باشد.');
          line('فیلتر شناسه', id || 'اعمال نشده؛ ممکن است اطلاعات کلیدهای دیگر همین حساب هم برگردد.');
          for (const field of ['start', 'end']) {
            const date = typeof data.period?.[field] === 'string' ? new Date(data.period[field]) : null;
            line(field === 'start' ? 'شروع بازهٔ سرویس' : 'پایان بازهٔ سرویس', date && Number.isFinite(date.getTime()) ? date.toLocaleString('fa-IR') : 'اعلام نشده');
          }
          const groups = Array.isArray(data.by_api_key) ? data.by_api_key : [];
          line('تعداد گروه‌های برگشتی', groups.length);
          line('تعداد درخواست کل پاسخ', number(data.totals.transactions));
          line('هزینهٔ کل پاسخ (UNIT؛ نه تومان)', number(data.totals.cost?.unit, 8));
          if (!groups.length) line('نتیجه', 'گروه کلیدی در این بازه برنگشت؛ این به معنی مصرف کل عمر صفر نیست.');
          let candidates = 0;
          groups.slice(0, 100).forEach(group => {
            if (!group || typeof group !== 'object') return;
            const groupId = /^[0-9]+$/.test(String(group.api_key_id)) ? String(group.api_key_id) : 'اعلام نشده';
            const suffix = typeof group.api_key_suffix === 'string' ? group.api_key_suffix.slice(-4) : '';
            const match = suffix.length === 4 && suffix === apiKey.slice(-4);
            if (match) candidates++;
            line('شناسهٔ گروه', groupId);
            line('چهار نویسهٔ آخر کلید گروه', suffix || 'اعلام نشده');
            line('تطبیق با کلید واردشده', match ? 'فقط تطبیق احتمالی چهار نویسه؛ اثبات هویت کلید نیست.' : 'تأیید نشد');
            line('درخواست‌های گروه', number(group.transactions));
            line('توکن‌های گروه', number(group.tokens));
            if (id && groupId !== id) line('هشدار', 'شناسهٔ برگشتی با فیلتر شما متفاوت است؛ فیلتر را معتبر فرض نکنید.');
          });
          if (groups.length > 100) line('هشدار', 'فقط ۱۰۰ گروه اول نمایش داده شد؛ برای بررسی دقیق شناسه را وارد کنید.');
          line('گروه‌های دارای پسوند مشابه در بخش نمایش‌داده‌شده', candidates);
          line('مانده و انقضای کلید', 'از گزارش مصرف قابل تعیین نیست؛ اطلاعات بودجه و انقضا در این پاسخ وجود ندارد.');
          line('آخرین بررسی موفق', new Date().toLocaleString('fa-IR'));
          return;
        }
        if (!data || typeof data !== 'object' || Array.isArray(data) || !Object.hasOwn(data, 'remaining_irt')) throw new Error('ساختار پاسخ اعتبار شناخته نشد.');
        if (current !== generation || !row.isConnected || keyInput.value.trim() !== apiKey) return;
        if (!append) report.replaceChildren();
        line('اطلاعات حساب برگشتی از سرویس', 'این پاسخ لزوماً بودجهٔ اختصاصی همین کلید نیست.');
        line('اعتبار باقی‌ماندهٔ حساب (تومان)', number(data.remaining_irt));
        line('سقف اعتبار حساب (تومان)', number(data.limit));
        line('انقضای اختصاصی کلید', 'از این پاسخ قابل تعیین نیست.');
        for (const [field, title] of [['packages', 'بسته'], ['grants', 'اعتبار تشویقی']]) {
          const sources = data.credit_sources?.[field];
          if (!Array.isArray(sources)) continue;
          sources.slice(0, 50).forEach((source, index) => {
            if (!source || typeof source !== 'object') return;
            line(title + ' ' + (index + 1) + '؛ مانده (تومان)', number(source.remaining_irt));
            const date = typeof source.end_date === 'string' ? new Date(source.end_date) : null;
            line('پایان ' + title, date && Number.isFinite(date.getTime()) ? date.toLocaleString('fa-IR') : 'اعلام نشده');
          });
        }
        line('آخرین بررسی موفق', new Date().toLocaleString('fa-IR'));
      } catch (error) {
        if (current !== generation || !row.isConnected) return;
        if (!append) report.replaceChildren();
        // Keep interpreted errors generic; the separately labelled raw body is secret-redacted.
        const allowed = /^(کلید معتبر|دسترسی مجاز|تعداد استعلام|استعلام ناموفق|پاسخ سرویس|ساختار پاسخ)/;
        line('خطا', error.name === 'AbortError' ? 'مهلت استعلام تمام شد؛ دوباره امتحان کنید.' : allowed.test(error.message) ? error.message : 'اتصال به AvalAI برقرار نشد؛ اینترنت یا VPN را بررسی کنید.');
      } finally {
        if (current === generation && row.isConnected && keyInput.value.trim() === apiKey && rawBody !== null) {
          const title = document.createElement('p');
          title.textContent = (mode === 'lookup' ? 'POST ' : 'GET ') + url + ' — پاسخ خام سرویس — HTTP ' + httpStatus + ' (کلید واردشده در صورت تکرار مخفی می‌شود)';
          const pre = document.createElement('pre'); pre.tabIndex = 0;
          let safe = rawBody;
          for (const secret of new Set([apiKey, JSON.stringify(apiKey).slice(1, -1), encodeURIComponent(apiKey)])) {
            if (secret) safe = safe.split(secret).join('[API KEY HIDDEN]');
          }
          const limit = 200000;
          pre.textContent = safe.length ? safe.slice(0, limit) : '(بدنهٔ پاسخ خالی است)';
          if (!append) raw.replaceChildren();
          raw.append(title, pre);
          if (safe.length > limit) {
            const note = document.createElement('p'); note.textContent = 'پاسخ طولانی است؛ فقط ۲۰۰ هزار نویسهٔ اول نمایش داده شد.'; raw.append(note);
          }
        }
        clearTimeout(timer);
        if (current === generation) { buttons.forEach(b => { b.disabled = false; }); }
      }
    };
    button.addEventListener('click', () => inquire('credit'));
    usageButton.addEventListener('click', () => inquire('summary'));
    transactionsButton.addEventListener('click', () => inquire('transactions'));
    lookupButton.addEventListener('click', () => inquire('lookup'));
    let batch = false;
    allButton.addEventListener('click', async () => {
      if (batch) return;
      batch = true;
      report.replaceChildren(); raw.replaceChildren();
      try {
        for (const mode of ['credit', 'summary', 'transactions', 'lookup']) {
          const before = generation;
          await inquire(mode, true);
          if (!row.isConnected || generation > before + 1) break;
        }
      } finally { batch = false; }
    });
  }
  window.AvalaiCredit = { mount };
})();
