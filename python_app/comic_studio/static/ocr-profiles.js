/* Named OCR settings only; never store images, text or credentials. */
(function (root) {
  'use strict';
  root.OcrProfiles = {
    mount(options) {
      const $ = id => document.getElementById(id);
      let profiles = []; let busy = false;
      const status = text => { $('ocrProfileStatus').textContent = text; };
      const selected = () => profiles.find(profile => profile.id === $('ocrProfileSelect').value);
      function controls() {
        for (const id of ['ocrProfileApply', 'ocrProfileUpdate', 'ocrProfileDelete']) $(id).disabled = busy || !selected();
        for (const id of ['ocrProfileCreate', 'ocrProfileExport', 'ocrProfileImport', 'ocrProfileName', 'ocrProfileSelect']) $(id).disabled = busy;
      }
      async function refresh(id = $('ocrProfileSelect').value) {
        profiles = await options.api('/api/ocr-profiles');
        $('ocrProfileSelect').replaceChildren(new Option('انتخاب پروفایل…', ''));
        profiles.forEach(profile => $('ocrProfileSelect').append(new Option(profile.name, profile.id)));
        if (profiles.some(profile => profile.id === id)) $('ocrProfileSelect').value = id;
        controls();
      }
      function payload() {
        return { format: 'hasaya-ocr-profile', version: 1, name: $('ocrProfileName').value.trim() || 'تنظیمات OCR', settings: options.collect() };
      }
      async function action(task) {
        if (busy) return;
        busy = true; controls(); status('در حال انجام…');
        try { await task(); }
        catch (error) { status(`انجام نشد: ${error.message || error}`); }
        finally { busy = false; controls(); }
      }
      $('ocrProfilesPanel').addEventListener('toggle', () => {
        if ($('ocrProfilesPanel').open && !busy) action(async () => { await refresh(); status('پروفایل را انتخاب کنید یا تنظیمات فعلی را با نام جدید ذخیره کنید.'); });
      });
      $('ocrProfileSelect').addEventListener('change', () => { const profile = selected(); if (profile) $('ocrProfileName').value = profile.name; controls(); });
      $('ocrProfileCreate').addEventListener('click', () => action(async () => {
        const profile = payload(); if (!$('ocrProfileName').value.trim()) throw new Error('نام پروفایل را وارد کنید.');
        const result = await options.api('/api/ocr-profiles', options.json('POST', profile));
        await refresh(result.id); status('پروفایل ذخیره شد و در پروژه‌های دیگر هم در دسترس است.');
      }));
      $('ocrProfileUpdate').addEventListener('click', () => action(async () => {
        const profile = selected(); if (!profile) return;
        if (!await options.confirm(`تنظیمات ذخیره‌شدهٔ «${profile.name}» با تنظیمات فعلی جایگزین شود؟`)) { status('به‌روزرسانی لغو شد.'); return; }
        const result = await options.api(`/api/ocr-profiles/${profile.id}`, options.json('PUT', payload()));
        await refresh(result.id); status('پروفایل به‌روزرسانی شد.');
      }));
      $('ocrProfileApply').addEventListener('click', () => action(async () => {
        const profile = selected(); if (!profile) return;
        if (!await options.confirm(`تنظیمات فعلی OCR با پروفایل «${profile.name}» جایگزین شود؟`)) { status('اعمال لغو شد.'); return; }
        await options.apply(profile.settings); status('پروفایل اعمال و تنظیمات پروژه ذخیره شد؛ OCR اجرا نشده است.');
      }));
      $('ocrProfileDelete').addEventListener('click', () => action(async () => {
        const profile = selected(); if (!profile) return;
        if (!await options.confirm(`پروفایل «${profile.name}» حذف شود؟ تنظیمات فعلی پروژه تغییر نمی‌کند.`)) { status('حذف لغو شد.'); return; }
        await options.api(`/api/ocr-profiles/${profile.id}`, { method: 'DELETE' });
        await refresh(''); status('پروفایل حذف شد؛ تنظیمات پروژه دست‌نخورده است.');
      }));
      $('ocrProfileExport').addEventListener('click', () => action(async () => {
        const profile = payload();
        const blob = new Blob([JSON.stringify(profile, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob); const link = document.createElement('a');
        link.href = url; link.download = 'hasaya-ocr-profile.json'; document.body.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        status('فایل تنظیمات فعلی برای دانلود آماده شد؛ پوشهٔ دانلود مرورگر را بررسی کنید.');
      }));
      $('ocrProfileImport').addEventListener('change', event => action(async () => {
        const file = event.target.files[0]; if (!file) return;
        try {
          if (file.size > 1024 * 1024) throw new Error('حداکثر اندازهٔ فایل پروفایل ۱ مگابایت است.');
          const profile = JSON.parse(await file.text());
          if (profile?.format !== 'hasaya-ocr-profile' || profile.version !== 1) throw new Error('نوع یا نسخهٔ فایل پروفایل پشتیبانی نمی‌شود.');
          const result = await options.api('/api/ocr-profiles', options.json('POST', profile));
          await refresh(result.id); $('ocrProfileName').value = result.name;
          status('فایل اعتبارسنجی و به‌عنوان پروفایل ذخیره شد؛ برای استفاده «اعمال پروفایل» را بزنید.');
        } finally { event.target.value = ''; }
      }));
      controls();
      return { refresh };
    },
  };
})(typeof window === 'undefined' ? globalThis : window);
