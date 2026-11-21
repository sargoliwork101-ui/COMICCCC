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
    box.append(button, idLabel, usageButton, report); row.append(box);
    let generation = 0, controller;
    const invalidate = () => {
      generation++; controller?.abort(); report.replaceChildren(); button.disabled = false; usageButton.disabled = false;
    };
    keyInput.addEventListener('input', invalidate);
    keyId.addEventListener('input', invalidate);
    const line = (label, value) => {
      const p = document.createElement('p'); p.textContent = label + ': ' + value; report.append(p);
    };
    const number = (value, digits = 2) => {
      if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return 'اعلام نشده';
      const n = Number(value); return Number.isFinite(n) ? n.toLocaleString('fa-IR', { maximumFractionDigits: digits }) : 'نامعتبر';
    };
    const inquire = async (usage = false) => {
      if (button.disabled) return;
      const apiKey = keyInput.value.trim();
      report.replaceChildren();
      if (!apiKey) { line('خطا', 'ابتدا کلید API را وارد کنید.'); keyInput.focus(); return; }
      const id = keyId.value.trim();
      if (usage && id && !/^[1-9][0-9]*$/.test(id)) { line('خطا', 'شناسه باید عدد صحیح مثبت با رقم انگلیسی باشد؛ خود کلید API را اینجا ننویسید.'); return; }
      const current = ++generation;
      controller = new AbortController();
      const requestController = controller;
      const timer = setTimeout(() => requestController.abort(), 15000);
      button.disabled = true; usageButton.disabled = true; line('وضعیت', 'در حال دریافت اطلاعات از AvalAI…');
      try {
        const url = usage ? 'https://api.avalai.ir/user/v1/transactions/summary?group_by=api_key&hours_ago=24' + (id ? '&api_key_id=' + encodeURIComponent(id) : '') : endpoint;
        const response = await fetch(url, {
          method: 'GET', headers: { Authorization: 'Bearer ' + apiKey },
          signal: requestController.signal, credentials: 'omit', cache: 'no-store', redirect: 'error'
        });
        if (!response.ok) {
          const messages = { 401: 'کلید معتبر نیست یا منقضی شده است.', 403: 'دسترسی مجاز نیست یا حساب غیرفعال است.', 429: 'تعداد استعلام‌ها زیاد است؛ کمی بعد دوباره امتحان کنید.' };
          throw new Error(messages[response.status] || 'استعلام ناموفق بود (HTTP ' + response.status + ').');
        }
        let data;
        try { data = await response.json(); } catch { throw new Error('پاسخ سرویس JSON معتبر نیست.'); }
        if (usage) {
          if (!data || typeof data !== 'object' || !data.totals || !Object.hasOwn(data, 'by_api_key') || (data.by_api_key !== null && !Array.isArray(data.by_api_key))) throw new Error('ساختار پاسخ مصرف شناخته نشد.');
          if (current !== generation || !row.isConnected || keyInput.value.trim() !== apiKey) return;
          report.replaceChildren();
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
        report.replaceChildren();
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
        report.replaceChildren();
        // Never display server bodies, URLs or arbitrary error messages that might contain a key.
        const allowed = /^(کلید معتبر|دسترسی مجاز|تعداد استعلام|استعلام ناموفق|پاسخ سرویس|ساختار پاسخ)/;
        line('خطا', error.name === 'AbortError' ? 'مهلت استعلام تمام شد؛ دوباره امتحان کنید.' : allowed.test(error.message) ? error.message : 'اتصال به AvalAI برقرار نشد؛ اینترنت یا VPN را بررسی کنید.');
      } finally {
        clearTimeout(timer);
        if (current === generation) { button.disabled = false; usageButton.disabled = false; }
      }
    };
    button.addEventListener('click', () => inquire(false));
    usageButton.addEventListener('click', () => inquire(true));
  }
  window.AvalaiCredit = { mount };
})();
