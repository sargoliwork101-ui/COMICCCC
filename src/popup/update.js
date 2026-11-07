// ---------- به‌روزرسانی از مخزن GitHub ----------
// افزونهٔ unpacked نمی‌تواند فایل‌های خودش را بازنویسی کند؛ پس از دانلود، جایگزینی ZIP و Reload دستی است.
(function () {
  const REPO = 'sargoliwork101-ui/COMICCCC';
  // شاخه به‌صورت خودکار از build تنظیم می‌شود؛ کاربر نیازی به انتخاب شاخه ندارد.
  const BRANCH = window.PIC_TO_PDF_UPDATE_BRANCH || 'main';
  const btn = document.getElementById('updateBtn');
  const statusEl = document.getElementById('updateStatus');
  if (!btn || !statusEl || typeof chrome === 'undefined' || !chrome.runtime) return;

  const currentVersion = chrome.runtime.getManifest().version;
  const setStatus = (text, kind) => {
    statusEl.textContent = text;
    statusEl.classList.remove('hidden', 'ok', 'warn', 'err');
    if (kind) statusEl.classList.add(kind);
  };
  const setBusy = (busy) => {
    btn.disabled = busy;
    btn.classList.toggle('spinning', busy);
  };

  // مقایسهٔ نسخه‌های چندبخشی مثل 2.50 با 2.51.1
  function compareVersions(a, b) {
    const pa = String(a).split('.').map((n) => Number.parseInt(n, 10) || 0);
    const pb = String(b).split('.').map((n) => Number.parseInt(n, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d;
    }
    return 0;
  }

  async function fetchLatestVersion() {
    const url = `https://api.github.com/repos/${REPO}/contents/manifest.json?ref=${encodeURIComponent(BRANCH)}&_=${Date.now()}`;
    const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } });
    if (res.status === 403 || res.status === 429) {
      throw new Error('محدودیت درخواست گیت‌هاب؛ چند دقیقهٔ دیگر دوباره تلاش کن');
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data || !data.content) throw new Error('پاسخ گیت‌هاب معتبر نیست');
    const binary = atob(data.content.replace(/\s/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i) & 0xff;
    const text = typeof globalThis.TextDecoder === 'function'
      ? new globalThis.TextDecoder('utf-8').decode(bytes)
      : decodeURIComponent(Array.from(bytes, (b) => `%${b.toString(16).padStart(2, '0')}`).join(''));
    const json = JSON.parse(text);
    if (!json.version) throw new Error('نسخه در manifest شاخه پیدا نشد');
    return json.version;
  }

  async function downloadLatest() {
    const branchPath = BRANCH.split('/').map(encodeURIComponent).join('/');
    const zipUrl = `https://codeload.github.com/${REPO}/zip/refs/heads/${branchPath}`;
    if (chrome.downloads && typeof chrome.downloads.download === 'function') {
      await chrome.downloads.download({ url: zipUrl, filename: 'PIC-TO-PDF-latest.zip', saveAs: false });
    } else {
      window.open(zipUrl, '_blank', 'noopener');
    }
  }

  function confirmUpdateModal(message) {
    if (typeof window.extConfirm === 'function') {
      return window.extConfirm(message, { title: 'به‌روزرسانی افزونه', okText: 'دانلود نسخهٔ جدید', cancelText: 'انصراف' });
    }
    if (!window.__forceExtModal && typeof window.confirm === 'function' && !/\[native code\]/.test(String(window.confirm))) {
      return Promise.resolve(Boolean(window.confirm(message)));
    }
    let root = document.getElementById('extModal');
    if (!root) {
      root = document.createElement('div');
      root.id = 'extModal';
      root.className = 'ext-modal hidden';
      root.setAttribute('role', 'dialog');
      root.setAttribute('aria-modal', 'true');
      root.innerHTML = '<div class="ext-modal-card"><h3 id="extModalTitle" class="ext-modal-title">به‌روزرسانی افزونه</h3>' +
        '<p id="extModalMsg" class="ext-modal-msg"></p>' +
        '<div class="ext-modal-actions"><button type="button" id="extModalCancel" class="btn ghost">انصراف</button>' +
        '<button type="button" id="extModalOk" class="btn">دانلود نسخهٔ جدید</button></div></div>';
      document.body.appendChild(root);
    }
    const titleEl = document.getElementById('extModalTitle');
    const msgEl = document.getElementById('extModalMsg');
    const okBtn = document.getElementById('extModalOk');
    const cancelBtn = document.getElementById('extModalCancel');
    if (titleEl) titleEl.textContent = 'به‌روزرسانی افزونه';
    if (msgEl) msgEl.textContent = message;
    if (okBtn) okBtn.textContent = 'دانلود نسخهٔ جدید';
    if (cancelBtn) { cancelBtn.textContent = 'انصراف'; cancelBtn.classList.remove('hidden'); }
    root.classList.remove('hidden');
    return new Promise((resolve) => {
      const done = (val) => {
        document.removeEventListener('keydown', onKey, true);
        root.classList.add('hidden');
        resolve(val);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
        else if (e.key === 'Tab' && okBtn && cancelBtn) {
          const active = document.activeElement;
          if (e.shiftKey && active === cancelBtn) { e.preventDefault(); okBtn.focus(); }
          else if (!e.shiftKey && active === okBtn) { e.preventDefault(); cancelBtn.focus(); }
        }
      };
      document.addEventListener('keydown', onKey, true);
      if (okBtn) okBtn.onclick = () => done(true);
      if (cancelBtn) cancelBtn.onclick = () => done(false);
      root.onmousedown = (e) => { if (e.target === root) { e.preventDefault(); done(false); } };
      if (okBtn) okBtn.focus();
    });
  }

  btn.addEventListener('click', async () => {
    setBusy(true);
    setStatus('در حال بررسی نسخهٔ جدید...');
    try {
      const latest = await fetchLatestVersion();
      const cmp = compareVersions(latest, currentVersion);
      if (cmp === 0) {
        setStatus(`نسخهٔ شما (v${currentVersion}) به‌روز است ✓`, 'ok');
        return;
      }
      if (cmp < 0) {
        setStatus(`نسخهٔ نصب‌شدهٔ شما (v${currentVersion}) جدیدتر از نسخهٔ منتشرشده است؛ دانگرید انجام نشد.`, 'ok');
        return;
      }

      const approved = await confirmUpdateModal(
        `نسخهٔ جدید v${latest} پیدا شد. مایل به دانلود به‌روزرسانی هستید؟\n\n` +
        'پس از دانلود باید فایل‌ها را دستی جایگزین و افزونه را Reload کنید.'
      );
      if (!approved) {
        setStatus('به‌روزرسانی به درخواست شما لغو شد؛ فایلی دانلود نشد.', 'warn');
        return;
      }

      setStatus(`تأیید شد؛ در حال دانلود نسخهٔ v${latest}...`, 'warn');
      await downloadLatest();
      setStatus(
        `نسخهٔ v${latest} دانلود شد. فایل ZIP را روی پوشهٔ فعلی اکستنشن استخراج (جایگزین) کن، ` +
        'بعد در chrome://extensions دکمهٔ Reload را بزن.',
        'ok'
      );
    } catch (error) {
      setStatus('بررسی به‌روزرسانی ناموفق بود: ' + (error && error.message ? error.message : 'خطای شبکه'), 'err');
    } finally {
      setBusy(false);
    }
  });
})();
