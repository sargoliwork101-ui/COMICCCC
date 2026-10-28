// ---------- به‌روزرسانی از مخزن GitHub ----------
// افزونهٔ unpacked نمی‌تواند فایل‌های خودش را بازنویسی کند؛ پس از دانلود، جایگزینی ZIP و Reload دستی است.
(function () {
  const REPO = 'sargoliwork101-ui/COMICCCC';
  const DEFAULT_BRANCH = window.PIC_TO_PDF_UPDATE_BRANCH || 'main';
  const BRANCH_STORAGE_KEY = 'pic_to_pdf_update_branch';
  const btn = document.getElementById('updateBtn');
  const statusEl = document.getElementById('updateStatus');
  const branchInput = document.getElementById('updateBranch');
  const saveBranchBtn = document.getElementById('saveUpdateBranch');
  if (!btn || !statusEl || typeof chrome === 'undefined' || !chrome.runtime) return;

  const currentVersion = chrome.runtime.getManifest().version;
  let updateBranch = DEFAULT_BRANCH;
  if (branchInput) branchInput.value = updateBranch;

  const setStatus = (text, kind) => {
    statusEl.textContent = text;
    statusEl.classList.remove('hidden', 'ok', 'warn', 'err');
    if (kind) statusEl.classList.add(kind);
  };
  const setBusy = (busy) => {
    btn.disabled = busy;
    btn.classList.toggle('spinning', busy);
  };
  function cleanBranch(value) {
    return String(value || '').trim().replace(/^\/+|\/+$/g, '');
  }
  async function storeBranch(branch) {
    updateBranch = branch;
    if (branchInput) branchInput.value = branch;
    if (chrome.storage && chrome.storage.local) {
      await chrome.storage.local.set({ [BRANCH_STORAGE_KEY]: branch });
    }
  }

  // Restore the user's selected channel; the source branch is the default on a fresh install.
  if (chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(BRANCH_STORAGE_KEY).then((stored) => {
      const saved = cleanBranch(stored && stored[BRANCH_STORAGE_KEY]);
      if (saved) {
        updateBranch = saved;
        if (branchInput) branchInput.value = saved;
      }
    }).catch(() => {});
  }

  if (saveBranchBtn) {
    saveBranchBtn.addEventListener('click', async () => {
      const branch = cleanBranch(branchInput && branchInput.value);
      if (!branch) { setStatus('نام شاخه را وارد کن؛ مثلاً main یا arena/نام-شاخه.', 'err'); return; }
      try {
        await storeBranch(branch);
        setStatus(`شاخهٔ به‌روزرسانی روی «${branch}» ذخیره شد.`, 'ok');
      } catch (error) {
        setStatus('ذخیرهٔ شاخه ناموفق بود: ' + (error && error.message ? error.message : error), 'err');
      }
    });
  }

  // مقایسهٔ نسخه‌های چندبخشی مثل 2.48 با 2.49.1
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

  async function fetchLatestVersion(branch) {
    const url = `https://api.github.com/repos/${REPO}/contents/manifest.json?ref=${encodeURIComponent(branch)}&_=${Date.now()}`;
    const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } });
    if (res.status === 403 || res.status === 429) {
      throw new Error('محدودیت درخواست گیت‌هاب؛ چند دقیقهٔ دیگر دوباره تلاش کن');
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data || !data.content) throw new Error('پاسخ گیت‌هاب معتبر نیست');
    const json = JSON.parse(atob(data.content.replace(/\s/g, '')));
    if (!json.version) throw new Error('نسخه در manifest شاخه پیدا نشد');
    return json.version;
  }

  async function downloadLatest(branch) {
    const branchPath = branch.split('/').map(encodeURIComponent).join('/');
    const zipUrl = `https://codeload.github.com/${REPO}/zip/refs/heads/${branchPath}`;
    if (chrome.downloads && typeof chrome.downloads.download === 'function') {
      await chrome.downloads.download({ url: zipUrl, filename: 'PIC-TO-PDF-latest.zip', saveAs: false });
    } else {
      window.open(zipUrl, '_blank', 'noopener');
    }
  }

  btn.addEventListener('click', async () => {
    setBusy(true);
    setStatus('در حال بررسی نسخهٔ روی گیت‌هاب...');
    try {
      const branch = cleanBranch(branchInput ? branchInput.value : updateBranch) || DEFAULT_BRANCH;
      await storeBranch(branch);
      const latest = await fetchLatestVersion(branch);
      const cmp = compareVersions(latest, currentVersion);
      if (cmp === 0) {
        setStatus(`نسخهٔ شما (v${currentVersion}) با آخرین نسخهٔ شاخهٔ «${branch}» برابر است ✓`, 'ok');
        return;
      }
      if (cmp < 0) {
        setStatus(`نسخهٔ نصب‌شدهٔ شما (v${currentVersion}) از نسخهٔ شاخهٔ «${branch}» جدیدتر است؛ دانگرید انجام نشد.`, 'ok');
        return;
      }

      const approved = window.confirm(
        `نسخهٔ جدید v${latest} در شاخهٔ «${branch}» پیدا شد. ZIP این شاخه دانلود شود؟\n\n` +
        'پس از دانلود باید فایل‌ها را دستی جایگزین و افزونه را Reload کنید.'
      );
      if (!approved) {
        setStatus('به‌روزرسانی به درخواست شما لغو شد؛ فایلی دانلود نشد.', 'warn');
        return;
      }

      setStatus(`تأیید شد؛ در حال دانلود نسخهٔ v${latest} از شاخهٔ «${branch}»...`, 'warn');
      await downloadLatest(branch);
      setStatus(
        `نسخهٔ v${latest} از شاخهٔ «${branch}» دانلود شد. فایل ZIP را روی پوشهٔ فعلی اکستنشن استخراج (جایگزین) کن، ` +
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
