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
    box.append(button, report); row.append(box);
    let generation = 0, controller;
    keyInput.addEventListener('input', () => {
      generation++; controller?.abort(); report.replaceChildren(); button.disabled = false;
    });
    const line = (label, value) => {
      const p = document.createElement('p'); p.textContent = label + ': ' + value; report.append(p);
    };
    const number = value => {
      if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return 'اعلام نشده';
      const n = Number(value); return Number.isFinite(n) ? n.toLocaleString('fa-IR', { maximumFractionDigits: 2 }) : 'نامعتبر';
    };
    button.addEventListener('click', async () => {
      if (button.disabled) return;
      const apiKey = keyInput.value.trim();
      report.replaceChildren();
      if (!apiKey) { line('خطا', 'ابتدا کلید API را وارد کنید.'); keyInput.focus(); return; }
      const current = ++generation;
      controller = new AbortController();
      const requestController = controller;
      const timer = setTimeout(() => requestController.abort(), 15000);
      button.disabled = true; line('وضعیت', 'در حال دریافت اطلاعات از AvalAI…');
      try {
        const response = await fetch(endpoint, {
          method: 'GET', headers: { Authorization: 'Bearer ' + apiKey },
          signal: requestController.signal, credentials: 'omit', cache: 'no-store', redirect: 'error'
        });
        if (!response.ok) {
          const messages = { 401: 'کلید معتبر نیست یا منقضی شده است.', 403: 'دسترسی مجاز نیست یا حساب غیرفعال است.', 429: 'تعداد استعلام‌ها زیاد است؛ کمی بعد دوباره امتحان کنید.' };
          throw new Error(messages[response.status] || 'استعلام ناموفق بود (HTTP ' + response.status + ').');
        }
        let data;
        try { data = await response.json(); } catch { throw new Error('پاسخ سرویس JSON معتبر نیست.'); }
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
        if (current === generation) button.disabled = false;
      }
    });
  }
  window.AvalaiCredit = { mount };
})();
