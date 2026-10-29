/* exported openEditor */ // viewer.js این تابع سراسری را برای بازکردن ادیتور صدا می‌زند.
// ---------- ترجمهٔ متن تصاویر + ویرایشگر ترجمه + خروجی متنی ----------
// این فایل بعد از viewer.js بارگذاری می‌شود و از متغیرهای آن (items، building، ...) استفاده می‌کند.
const TR = { worker: null, lang: null, cancel: false, aiController: null };
const AI_SETTINGS_KEY = 'gemini_translation_settings_v1';
const AI_PROVIDER_IDS = Object.keys(AiTranslateTools.PROVIDERS);
let aiProvider = 'gemini', aiProviderSettings = {}, aiProfiles = [], aiProfileSerial = 0;

function makeAiProfile(name = '', apiKey = '', id = '') {
  aiProfileSerial++;
  return {
    id: String(id || `api-${Date.now().toString(36)}-${aiProfileSerial}`),
    name: String(name || ''), apiKey: String(apiKey || '')
  };
}
function captureAiProvider() {
  const data = aiProviderSettings[aiProvider];
  if (!data) return;
  data.model = $('trAiModel').value.trim() || AiTranslateTools.DEFAULT_MODELS[aiProvider];
  data.profiles = aiProfiles;
}
function updateAiProviderUi() {
  const info = AiTranslateTools.PROVIDERS[aiProvider];
  $('trAiProvider').value = aiProvider;
  $('trAiModel').placeholder = info.defaultModel;
  $('trAiKeyHelp').href = info.keyUrl;
  $('trAiKeyHelp').textContent = info.keyLabel;
  $('trAiPrivacy').textContent = aiProvider === 'gemini'
    ? 'متن‌ها برای ترجمه به Google ارسال می‌شوند. محتوای پلن رایگان Gemini برای بهبود محصولات Google استفاده می‌شود؛ متن حساس نفرستید.'
    : `متن‌ها برای ترجمه به ${info.label} ارسال می‌شوند؛ شرایط حریم خصوصی همان سرویس را بررسی کنید و متن حساس نفرستید.`;
}
function showAiProvider(provider) {
  aiProvider = AiTranslateTools.normalizeProvider(provider);
  if (!aiProviderSettings[aiProvider]) {
    aiProviderSettings[aiProvider] = { model: AiTranslateTools.DEFAULT_MODELS[aiProvider], profiles: [] };
  }
  const data = aiProviderSettings[aiProvider];
  aiProfiles = Array.isArray(data.profiles) ? data.profiles : [];
  if (!aiProfiles.length) aiProfiles.push(makeAiProfile('کلید اول'));
  data.profiles = aiProfiles;
  $('trAiModel').value = data.model || AiTranslateTools.DEFAULT_MODELS[aiProvider];
  updateAiProviderUi();
  renderAiProfiles();
}
function renderAiProfiles() {
  const container = $('aiProfileList');
  container.textContent = '';
  aiProfiles.forEach((profile, index) => {
    const row = document.createElement('div');
    row.className = 'ai-profile-row';
    const status = document.createElement('span');
    status.className = 'ai-profile-status'; status.setAttribute('role', 'status');
    const showStatus = (message, type = '') => {
      status.textContent = message;
      status.className = 'ai-profile-status' + (type ? ` ${type}` : '');
    };
    const nameInput = document.createElement('input');
    nameInput.type = 'text'; nameInput.className = 'ai-profile-name';
    nameInput.value = profile.name; nameInput.placeholder = `API ${index + 1}`;
    nameInput.setAttribute('aria-label', `نام دلخواه API ${index + 1}`);
    nameInput.addEventListener('input', () => { profile.name = nameInput.value; });
    nameInput.addEventListener('change', saveAiSettings);
    const keyInput = document.createElement('input');
    keyInput.type = 'password'; keyInput.autocomplete = 'off'; keyInput.spellcheck = false;
    keyInput.value = profile.apiKey; keyInput.placeholder = 'کلید API';
    keyInput.setAttribute('aria-label', `کلید API ${index + 1}`);
    keyInput.addEventListener('input', () => { profile.apiKey = keyInput.value; showStatus(''); });
    keyInput.addEventListener('change', saveAiSettings);
    const test = document.createElement('button');
    test.type = 'button'; test.className = 'mini ai-profile-test'; test.textContent = 'تست';
    test.title = 'تست اتصال این کلید با مدل انتخاب‌شده؛ بدون ارسال متن کمیک';
    test.setAttribute('aria-label', `تست اتصال API ${index + 1}`);
    test.onclick = async () => {
      const apiKey = profile.apiKey.trim();
      const provider = aiProvider;
      const model = $('trAiModel').value.trim() || AiTranslateTools.DEFAULT_MODELS[provider];
      if (!apiKey) { showStatus('ابتدا کلید API را وارد کنید.', 'bad'); keyInput.focus(); return; }
      const unchanged = () => aiProvider === provider && profile.apiKey.trim() === apiKey &&
        ($('trAiModel').value.trim() || AiTranslateTools.DEFAULT_MODELS[provider]) === model;
      test.disabled = true; test.textContent = '…'; showStatus('در حال بررسی ارتباط...');
      try {
        await AiTranslateTools.testConnection({ provider, apiKey, model });
        showStatus(unchanged() ? 'اتصال برقرار است ✓' : 'کلید یا مدل تغییر کرد؛ دوباره تست کنید.', unchanged() ? 'ok' : '');
      } catch (error) {
        showStatus(unchanged() ? AiTranslateTools.safeError(error) : 'کلید یا مدل تغییر کرد؛ دوباره تست کنید.', unchanged() ? 'bad' : '');
      } finally {
        test.disabled = false; test.textContent = 'تست';
      }
    };
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'mini warn ai-profile-remove'; remove.textContent = '×';
    remove.title = 'حذف این API'; remove.setAttribute('aria-label', `حذف API ${index + 1}`);
    remove.disabled = aiProfiles.length === 1;
    remove.onclick = () => {
      aiProfiles.splice(index, 1);
      if (!aiProfiles.length) aiProfiles.push(makeAiProfile('کلید اول'));
      renderAiProfiles(); saveAiSettings();
    };
    row.append(nameInput, keyInput, test, remove, status);
    container.appendChild(row);
  });
}
async function loadAiSettings() {
  try {
    const stored = await chrome.storage.local.get(AI_SETTINGS_KEY);
    const settings = stored[AI_SETTINGS_KEY] || {};
    $('trAiEnabled').checked = settings.enabled === true;
    const providerStore = settings.providers && typeof settings.providers === 'object' ? settings.providers : null;
    AI_PROVIDER_IDS.forEach((id) => {
      const raw = providerStore && providerStore[id] && typeof providerStore[id] === 'object' ? providerStore[id] : {};
      const legacy = id === 'gemini' && !providerStore;
      const rawProfiles = legacy ? settings.profiles : raw.profiles;
      let profiles = Array.isArray(rawProfiles)
        ? rawProfiles.map((profile) => makeAiProfile(profile && profile.name, profile && profile.apiKey, profile && profile.id)) : [];
      // انتقال تنظیمات نسخه‌های قبلی به فضای مستقل Gemini، بدون حذف کلید یا مدل قبلی.
      if (legacy && !profiles.length && typeof settings.apiKey === 'string' && settings.apiKey.trim()) {
        profiles = [makeAiProfile('کلید اصلی', settings.apiKey)];
      }
      const rawModel = legacy ? settings.model : raw.model;
      aiProviderSettings[id] = {
        model: typeof rawModel === 'string' && rawModel.trim() ? rawModel.trim() : AiTranslateTools.DEFAULT_MODELS[id],
        profiles
      };
    });
    $('trAiSkill').value = typeof settings.skill === 'string' && settings.skill.trim()
      ? settings.skill : AiTranslateTools.DEFAULT_SKILL;
    showAiProvider(AI_PROVIDER_IDS.includes(settings.provider) ? settings.provider : 'gemini');
  } catch (error) {
    console.warn('خواندن تنظیمات ترجمهٔ هوش مصنوعی ناموفق بود', error);
    aiProviderSettings = {};
    $('trAiSkill').value = AiTranslateTools.DEFAULT_SKILL;
    showAiProvider('gemini');
  }
}
async function saveAiSettings() {
  try {
    captureAiProvider();
    const providers = {};
    AI_PROVIDER_IDS.forEach((id) => {
      const data = aiProviderSettings[id] || { model: AiTranslateTools.DEFAULT_MODELS[id], profiles: [] };
      providers[id] = {
        model: data.model || AiTranslateTools.DEFAULT_MODELS[id],
        profiles: (Array.isArray(data.profiles) ? data.profiles : []).map((profile) => ({
          id: profile.id, name: profile.name.trim(), apiKey: profile.apiKey.trim()
        }))
      };
    });
    await chrome.storage.local.set({ [AI_SETTINGS_KEY]: {
      enabled: $('trAiEnabled').checked,
      provider: aiProvider,
      providers,
      skill: $('trAiSkill').value.trim() || AiTranslateTools.DEFAULT_SKILL
    } });
    return true;
  } catch (error) {
    console.warn('ذخیرهٔ تنظیمات ترجمهٔ هوش مصنوعی ناموفق بود', error);
    return false;
  }
}
const aiSettingsReady = loadAiSettings();

function openTrDialog() {
  if (!$('ocrEnabled').checked) return;
  $('trAiError').textContent = '';
  $('trDialog').classList.remove('hidden');
}
function closeTrDialog() { $('trDialog').classList.add('hidden'); }
function cancelTranslation() {
  TR.cancel = true;
  if (TR.aiController) { try { TR.aiController.abort(); } catch { /* درخواست قبلاً تمام شده */ } }
}

async function ensureFont() {
  try { await document.fonts.load('700 24px Vazirmatn', 'ابپتثجچ'); } catch { /* ادامه */ }
}

// تصویر ترجمه‌شده را از روی بلوک‌ها (دوباره) می‌سازد
async function renderEdited(it) {
  const active = it.ocr && it.ocr.blocks.some((b) => b.enabled && b.tr && b.tr.trim());
  if (!active) { it.edited = null; return; }
  if (!canConvert(it.w, it.h)) throw new Error('ابعاد تصویر برای ترجمه بیش از حد بزرگ است');
  await ensureFont();
  const bmp = await createImageBitmap(it.blob, { imageOrientation: 'none' });
  const w = bmp.width, h = bmp.height;
  let cv;
  try { cv = Typeset.render(bmp, it.ocr.blocks); } finally { bmp.close(); }
  const blob = await canvasToBlob(cv, 'image/png');
  cv.width = cv.height = 0;
  const u8 = new Uint8Array(await blob.arrayBuffer());
  it.edited = { i: it.i, blob, info: sniff(u8), w, h };
}

async function runTranslate() {
  if (building || loading || !$('ocrEnabled').checked) return;
  const lang = $('trLang').value;
  const L = OcrTools.LANGS[lang];
  const list = items.filter((it) => it.state === 'ok' && (!$('trOnlySel').checked || it.selected));
  closeTrDialog();
  if (!list.length) {
    setStatus('تصویری برای ترجمه پیدا نشد؛ ابتدا چند تصویر بارگذاری‌شده را انتخاب کنید.');
    return;
  }
  const aiMode = $('trAiEnabled').checked;
  const aiConfig = aiMode ? {
    provider: aiProvider,
    profiles: aiProfiles.map((profile) => ({
      id: profile.id, name: profile.name.trim(), apiKey: profile.apiKey.trim()
    })).filter((profile) => profile.apiKey),
    model: $('trAiModel').value,
    skill: $('trAiSkill').value
  } : null;
  if (aiMode) {
    try {
      if (!aiConfig.profiles.length) throw new Error('برای استفاده از ترجمهٔ هوش مصنوعی، حداقل یک کلید API را وارد کنید.');
      AiTranslateTools.normalizeModel(aiConfig.model, aiConfig.provider);
    } catch (error) {
      $('aiSettings').open = true;
      $('trAiError').textContent = error.message;
      $('trDialog').classList.remove('hidden');
      return;
    }
  }
  saveAiSettings();

  building = true; TR.cancel = false; TR.aiController = null; jobCancelRequested = false;
  setJobHint(true);
  refreshSummary();
  const result = $('result');
  result.classList.remove('hidden', 'done');
  $('downloadBtn').classList.add('hidden');
  $('btnStopTr').classList.remove('hidden');
  $('failed').innerText = '';
  $('sPages').innerText = '0';
  $('sSize').innerText = '0';
  $('lblPages').innerText = 'متن ترجمه‌شده';
  $('progressBar').style.width = '0';
  window.scrollTo({ top: 0, behavior: 'smooth' });

  let totalBlocks = 0, doneImgs = 0, trFail = 0, noText = 0, rawTotal = 0, keptTotal = 0;
  const passes = ['gray', ...($('trContrast').checked ? ['adaptive'] : []), 'bubbles', ...($('trPrecise').checked ? ['wmask'] : [])];
  const errs = [], aiItems = [];
  let aiNotice = '';
  try {
    setStatus('در حال بارگذاری موتور تشخیص متن... (بار اول کمی طول می‌کشد)');
    if (!TR.worker || TR.lang !== lang) {
      if (TR.worker) { try { await TR.worker.terminate(); } catch {} TR.worker = null; }
      TR.worker = await OcrTools.createOcrWorker(lang);
      TR.lang = lang;
    }

    for (let k = 0; k < list.length; k++) {
      if (TR.cancel) break;
      const it = list[k];
      const base = k / list.length, span = 1 / list.length;
      const prog = (f) => {
        const ratio = aiMode ? (k + f) / list.length * 0.55 : base + span * f;
        $('progressBar').style.width = Math.round(ratio * 100) + '%';
      };
      prog(0);
      setStatus(`در حال خواندن متن تصویر ${k + 1} از ${list.length}...`);
      try {
        const bmp = await createImageBitmap(it.blob, { imageOrientation: 'none' });
        let lines;
        const stats = { raw: 0, kept: 0 };
        try {
          lines = await OcrTools.ocrBitmap(bmp, TR.worker, { cjk: L.cjk, lang, passes, stats, onSlice: (f) => prog(f * 0.6) });
        } finally { bmp.close(); }
        if (!$('ocrEnabled').checked) {
          it.ocr = null; it.edited = null;
          refreshCard(it); drawThumb(it);
          break;
        }
        rawTotal += stats.raw; keptTotal += stats.kept;

        const blocks = OcrTools.groupLines(lines, L.cjk);
        const eraseOriginal = $('trErase').checked;
        blocks.forEach((block) => { block.bg = eraseOriginal ? 'auto' : 'none'; });
        it.ocr = { lang, blocks };
        if (!blocks.length) { noText++; it.edited = null; }
        else if (aiMode) {
          aiItems.push(it);
          prog(1);
        }
        else {
          setStatus(`در حال ترجمهٔ ${blocks.length} متن در تصویر ${k + 1} از ${list.length}...`);
          let next = 0, n = 0;
          await Promise.all(Array.from({ length: Math.min(3, blocks.length) }, async () => {
            while (next < blocks.length && !TR.cancel) {
              const b = blocks[next++];
              const r = await TranslateTools.translate(b.text, L.sl);
              b.tr = r.text;
              if (!r.ok) trFail++;
              n++;
              prog(0.6 + 0.35 * (n / blocks.length));
            }
          }));
          if (!$('ocrEnabled').checked) {
            it.ocr = null; it.edited = null;
            refreshCard(it); drawThumb(it);
            break;
          }
          await renderEdited(it);
          if (!$('ocrEnabled').checked) {
            it.ocr = null; it.edited = null;
            refreshCard(it); drawThumb(it);
            break;
          }
          totalBlocks += blocks.length;
          doneImgs++;
          $('sPages').innerText = totalBlocks;
        }
      } catch (e) {
        console.warn(e);
        errs.push(`تصویر ${it.i + 1}: ${e && e.message ? e.message : e}`);
      }
      refreshCard(it);
      drawThumb(it);
    }

    // در حالت اختیاری AI، همهٔ صفحه‌ها اول OCR می‌شوند و کل متن در یک بسته برای هر کلید لازم ارسال می‌شود.
    if (aiMode && aiItems.length && !TR.cancel && $('ocrEnabled').checked) {
      const entries = [];
      aiItems.forEach((it) => {
        const page = `${it.i + 1}${it.dupNo ? `-copy-${it.dupNo}` : ''}`;
        it.ocr.blocks.forEach((block, index) => {
          const id = `p${String(it.uid + 1).padStart(4, '0')}-b${String(index + 1).padStart(3, '0')}`;
          entries.push({ id, page, text: block.text, block });
        });
      });
      setStatus(`متن ${aiItems.length} تصویر خوانده شد؛ ${entries.length} حباب در یک بستهٔ متنی برای ترجمهٔ طبیعی ارسال می‌شود...`);
      $('progressBar').style.width = '60%';
      let translations = new Map(), aiError = null, aiProfileName = '';
      TR.aiController = new AbortController();
      try {
        const aiResult = await AiTranslateTools.translateWithFailover({
          ...aiConfig,
          sourceLang: L.sl,
          entries,
          signal: TR.aiController.signal
        });
        translations = aiResult.translations;
        aiProfileName = aiResult.profileName || '';
      } catch (error) {
        if (!TR.cancel) aiError = error;
      } finally {
        TR.aiController = null;
      }

      if (!TR.cancel && $('ocrEnabled').checked) {
        const missing = [];
        entries.forEach((entry) => {
          const translated = translations.get(entry.id);
          entry.block.tr = translated || '';
          if (!translated) missing.push(entry);
        });
        if (aiError) {
          errs.push('ترجمهٔ هوش مصنوعی: ' + AiTranslateTools.safeError(aiError));
          aiNotice = 'هوش مصنوعی پاسخ نداد؛ ترجمهٔ معمولی جایگزین شد';
        } else if (missing.length) {
          aiNotice = `${missing.length} متن برای تکمیل به ترجمهٔ معمولی فرستاده شد`;
        } else {
          aiNotice = 'همهٔ متن‌ها با هوش مصنوعی ترجمه شدند' + (aiProfileName ? ` (${aiProfileName})` : '');
        }

        // فقط موارد ناموفق/جاافتاده به روش قبلی می‌روند؛ پاسخ موفق AI برای صرفه‌جویی در سهمیه تکرار نمی‌شود.
        let next = 0, finished = 0;
        if (missing.length) setStatus(`${missing.length} متن با ترجمهٔ معمولی تکمیل می‌شود...`);
        await Promise.all(Array.from({ length: Math.min(3, missing.length) }, async () => {
          while (next < missing.length && !TR.cancel) {
            const entry = missing[next++];
            const r = await TranslateTools.translate(entry.block.text, L.sl);
            entry.block.tr = r.text;
            if (!r.ok) trFail++;
            finished++;
            $('progressBar').style.width = Math.round(60 + 15 * finished / missing.length) + '%';
          }
        }));

        for (let index = 0; index < aiItems.length && !TR.cancel && $('ocrEnabled').checked; index++) {
          const it = aiItems[index];
          try {
            await renderEdited(it);
            if (!$('ocrEnabled').checked) break;
            totalBlocks += it.ocr.blocks.length;
            doneImgs++;
            $('sPages').innerText = totalBlocks;
          } catch (error) {
            console.warn(error);
            errs.push(`تصویر ${it.i + 1}: ${error && error.message ? error.message : error}`);
          }
          refreshCard(it);
          drawThumb(it);
          $('progressBar').style.width = Math.round(75 + 25 * (index + 1) / aiItems.length) + '%';
        }
      }
    }

    result.classList.add('done');
    $('progressBar').style.width = '100%';
    if (errs.length && !doneImgs) {
      setStatus(aiMode ? 'ترجمه کامل نشد؛ جزئیات خطا در پایین آمده است.'
        : 'ترجمه انجام نشد. اگر خطا مربوط به موتور OCR است، اکستنشن را Reload کنید.');
    } else if (!totalBlocks && !TR.cancel) {
      setStatus(`متنی پیدا نشد. موتور OCR کار کرد (${rawTotal} خط خام، ${keptTotal} خط معتبر) ولی متن قابل‌قبولی نبود. ` +
        `مطمئن شوید زبان درست انتخاب شده (الان: ${L.name}) و گزینهٔ «دقت بالاتر» روشن است.`);
    } else if (totalBlocks && trFail >= totalBlocks) {
      setStatus('متن‌ها خوانده شد ولی ترجمه انجام نشد؛ اتصال اینترنت را بررسی کنید. (متن اصلی در ویرایشگر موجود است)');
    } else {
      setStatus(`${TR.cancel ? 'متوقف شد. ' : ''}${totalBlocks} متن در ${doneImgs} تصویر ترجمه شد` +
        (noText ? ` (${noText} تصویر بدون متن)` : '') +
        (trFail ? ` — ترجمهٔ ${trFail} متن ناموفق بود` : '') +
        (aiNotice && !TR.cancel ? ` — ${aiNotice}` : '') +
        '. روی دکمهٔ ✎ هر تصویر بزنید تا ترجمه‌ها را ویرایش کنید.');
    }
    if (errs.length) $('failed').innerText = errs.slice(0, 5).join('\n');
  } catch (e) {
    console.error(e);
    setStatus('خطا در راه‌اندازی تشخیص متن: ' + (e && e.message ? e.message : e));
  } finally {
    building = false;
    TR.aiController = null;
    setJobHint(false);
    setTaskTitle();
    $('btnStopTr').classList.add('hidden');
    refreshSummary();
  }
}

// کپی متن ساده در کلیپ‌بورد؛ در نبود Clipboard API (مجوز/پروتکل) از روش قدیمی textarea استفاده می‌کند
async function copyPlainText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}
async function retranslateBlock(item, block, originalField, editor, overlay, button) {
  const source = String(originalField.value || '');
  block.text = source;
  if (!source.trim()) { button.title = 'ابتدا متن OCR را اصلاح کنید'; return; }
  const lang = OcrTools.LANGS[item.ocr.lang] || OcrTools.LANGS.eng;
  const oldLabel = button.textContent;
  button.disabled = true; button.textContent = 'در حال ترجمه…';
  try {
    const result = await TranslateTools.translate(source.trim(), lang.sl);
    if (!result.ok || !result.text) throw new Error('ترجمه انجام نشد؛ اتصال اینترنت را بررسی کنید.');
    block.tr = result.text;
    block.richHtml = safeEditorHtml(escapeEditorText(result.text).replace(/\n/g, '<br>'));
    if (EDI === item) {
      editor.innerHTML = block.richHtml;
      overlay.innerHTML = block.richHtml;
      updatePreviewScale();
      edDirty = true;
      await applyEditor();
    } else {
      await renderEdited(item);
      refreshCard(item); drawThumb(item);
    }
    button.textContent = 'ترجمه شد ✓';
    button.title = `ترجمه از ${lang.name} به فارسی انجام شد`;
  } catch (error) {
    button.textContent = 'ترجمه ناموفق';
    button.title = error && error.message ? error.message : String(error);
  } finally {
    button.disabled = false;
    setTimeout(() => {
      if (!button.isConnected) return;
      button.textContent = oldLabel;
      button.title = 'ترجمهٔ دوبارهٔ متن اصلاح‌شده به فارسی';
    }, 1800);
  }
}

// ---------- ویرایشگر متن غنی ----------
let EDI = null, edUrl = null, edTimer = null, edDirty = false, edBusy = false, edPending = false;
let activeRichEditor = null, richSelectionRange = null;
const EDITOR_APPLY_DELAY = 900;
let edFieldFocused = false;
const editorFieldEl = (el) => el && el.closest && el.closest('#editor') &&
  (el.isContentEditable || el.getAttribute('contenteditable') === 'true' || ['INPUT', 'SELECT'].includes(el.tagName)) ? el : null;
function isEditorInputFocused() { return edFieldFocused; }

function escapeEditorText(value) {
  return String(value || '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function legacyMarksToHtml(value) {
  if (!value || typeof Typeset === 'undefined' || !Typeset.hasInlineMarks(value)) return escapeEditorText(value).replace(/\n/g, '<br>');
  return Typeset.tokenizeInline(value).map((run) => {
    let text = escapeEditorText(run.t).replace(/\n/g, '<br>');
    if (run.bold) text = `<strong>${text}</strong>`;
    if (run.italic) text = `<em>${text}</em>`;
    if (run.underline) text = `<u>${text}</u>`;
    const styles = [];
    if (run.size) styles.push(`font-size:${Math.max(8, Math.min(160, run.size))}px`);
    if (run.color) styles.push(`color:${run.color}`);
    if (styles.length) text = `<span style="${styles.join(';')}">${text}</span>`;
    return text;
  }).join('');
}
function safeEditorHtml(html) {
  const root = document.createElement('div');
  root.innerHTML = html || '';
  const walk = (node, isRoot = false) => {
    if (node.nodeType === 3) return escapeEditorText(node.nodeValue);
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase();
    if (tag === 'br') { return '<br>'; }
    let inner = [...node.childNodes].map((child) => walk(child)).join('');
    if (tag === 'div' || tag === 'p') { return inner + (isRoot ? '' : '<br>'); }
    if (tag === 'ul' || tag === 'ol') {
      return [...node.children].map((li, i) =>
        `${tag === 'ul' ? '•' : `${i + 1}.`} ${[...li.childNodes].map((child) => walk(child)).join('')}<br>`).join('');
    }
    if (tag === 'li') return inner;
    if (['b', 'strong'].includes(tag)) return `<strong>${inner}</strong>`;
    if (['i', 'em'].includes(tag)) return `<em>${inner}</em>`;
    if (tag === 'u') return `<u>${inner}</u>`;
    if (tag === 's' || tag === 'strike' || tag === 'del') return `<s>${inner}</s>`;
    if (tag === 'span') {
      const styles = [];
      const size = Number.parseFloat(node.style.fontSize);
      if (Number.isFinite(size)) styles.push(`font-size:${Math.max(8, Math.min(160, size))}px`);
      const weight = node.style.fontWeight;
      if (weight === 'bold' || Number(weight) >= 600) styles.push('font-weight:700');
      else if (weight === 'normal' || weight === '400') styles.push('font-weight:400');
      if (node.style.fontStyle === 'italic') styles.push('font-style:italic');
      else if (node.style.fontStyle === 'normal') styles.push('font-style:normal');
      const decoration = node.style.textDecorationLine || node.style.textDecoration;
      if (decoration && decoration.includes('underline')) styles.push('text-decoration:underline');
      if (decoration && decoration.includes('line-through')) styles.push('text-decoration:line-through');
      const color = node.style.color;
      if (/^#[\da-f]{3,8}$/i.test(color) || /^rgba?\([\d\s,.%]+\)$/i.test(color)) styles.push(`color:${color}`);
      return styles.length ? `<span style="${styles.join(';')}">${inner}</span>` : inner;
    }
    return inner;
  };
  return [...root.childNodes].map((node) => walk(node)).join('');
}
function plainTextFromHtml(html) {
  const root = document.createElement('div'); root.innerHTML = html || '';
  const walk = (node) => {
    if (node.nodeType === 3) return node.nodeValue;
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase();
    if (tag === 'br') return '\n';
    const text = [...node.childNodes].map(walk).join('');
    return ['div', 'p', 'li'].includes(tag) ? text + '\n' : text;
  };
  return [...root.childNodes].map(walk).join('').replace(/\n+$/g, '');
}
function normalizeLegacyBlock(block) {
  if (!block.richHtml && block.tr && typeof Typeset !== 'undefined' && Typeset.hasInlineMarks(block.tr)) {
    block.richHtml = legacyMarksToHtml(block.tr);
    block.tr = Typeset.stripInlineMarkers(block.tr);
  }
  block.richHtml = safeEditorHtml(block.richHtml || escapeEditorText(block.tr || '').replace(/\n/g, '<br>'));
  block.tr = plainTextFromHtml(block.richHtml);
}
function setActiveBlock(id, scroll) {
  document.querySelectorAll('.blk').forEach((r) => r.classList.toggle('active', String(r.dataset.id) === String(id)));
  document.querySelectorAll('.ed-box').forEach((r) => r.classList.toggle('active', String(r.dataset.id) === String(id)));
  if (scroll) {
    const row = document.querySelector(`.blk[data-id="${id}"]`);
    if (row) { row.scrollIntoView({ block: 'center', behavior: 'smooth' }); const field = row.querySelector('.blk-editor'); if (field) field.focus(); }
  }
}
function scheduleApply() {
  edDirty = true; clearTimeout(edTimer);
  edTimer = setTimeout(() => {
    if (isEditorInputFocused()) { scheduleApply(); return; }
    applyEditor();
  }, EDITOR_APPLY_DELAY);
}
function flushEditorOnBlur() { if (edDirty) applyEditor(); }
function updateRichBlock(blockId, source) {
  if (!EDI) return;
  const block = EDI.ocr.blocks.find((b) => String(b.id) === String(blockId));
  if (!block) return;
  block.richHtml = safeEditorHtml(source.innerHTML);
  block.tr = plainTextFromHtml(block.richHtml);
  document.querySelectorAll(`.blk-editor[data-id="${blockId}"], .ed-box-text[data-id="${blockId}"]`).forEach((field) => {
    if (field !== source) field.innerHTML = block.richHtml || '';
  });
  updatePreviewScale();
  scheduleApply();
}
function runRichCommand(command, value) {
  if (!activeRichEditor) return;
  activeRichEditor.focus();
  document.execCommand(command, false, value || null);
  updateRichBlock(activeRichEditor.dataset.id, activeRichEditor);
  syncRichToolbarState();
}
function applyRichStyle(property, value) {
  const editor = activeRichEditor;
  const selection = window.getSelection();
  let range = selection && selection.rangeCount && editor && editor.contains(selection.anchorNode)
    ? selection.getRangeAt(0).cloneRange() : null;
  if (!range && richSelectionRange && editor && editor.contains(richSelectionRange.startContainer)) range = richSelectionRange.cloneRange();
  if (!editor || !range || range.collapsed) return false;
  const span = document.createElement('span');
  if (property === 'fontSize') span.style.fontSize = `${Math.max(8, Math.min(160, Number(value) || 16))}px`;
  else if (property === 'color' && (/^#[\da-f]{3,8}$/i.test(value) || /^rgba?\([\d\s,.%]+\)$/i.test(value))) span.style.color = value;
  else return false;
  try {
    span.appendChild(range.extractContents()); range.insertNode(span);
    selection.removeAllRanges(); const next = document.createRange(); next.selectNodeContents(span); selection.addRange(next);
    richSelectionRange = next.cloneRange();
  } catch { return false; }
  updateRichBlock(editor.dataset.id, editor);
  return true;
}
function hasRichSelection(editor) {
  const selection = window.getSelection();
  const current = selection && selection.rangeCount && editor && editor.contains(selection.anchorNode)
    ? selection.getRangeAt(0) : null;
  const range = current || (richSelectionRange && editor && editor.contains(richSelectionRange.startContainer) ? richSelectionRange : null);
  return !!(range && !range.collapsed);
}
function insertPlainPaste(event, editor) {
  event.preventDefault();
  const text = event.clipboardData ? event.clipboardData.getData('text/plain') : '';
  editor.focus();
  document.execCommand('insertText', false, text);
  updateRichBlock(editor.dataset.id, editor);
}
function selectRichEditor(editor) {
  activeRichEditor = editor;
  setActiveBlock(editor.dataset.id, false);
}
function syncRichToolbarState() {
  if (!activeRichEditor || typeof document.queryCommandState !== 'function') return;
  const row = document.querySelector(`.blk[data-id="${activeRichEditor.dataset.id}"]`);
  if (!row) return;
  [['bold', '.blk-bold'], ['italic', '.blk-italic'], ['underline', '.blk-under'], ['strikeThrough', '.blk-strike']].forEach(([command, selector]) => {
    let active = false;
    try { active = document.queryCommandState(command); } catch { active = false; }
    const button = row.querySelector(selector);
    if (button) { button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); }
  });
}
function previewTextSize(block, boxWidth, boxHeight) {
  const style = Typeset.blockStyle(block);
  if (style.size) return style.size;
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return Math.max(10, Math.round((block.lineH || 16) * 1.1));
  const maxSize = Math.max(12, Math.min(64, Math.round((block.lineH || 16) * 1.1)));
  const fontPrefix = `${style.italic ? 'italic ' : ''}${style.bold ? '700' : '400'} `;
  const rich = !!block.richHtml || Typeset.hasInlineMarks(block.tr || '');
  if (rich) {
    const words = block.richHtml ? Typeset.richHtmlWords(block.richHtml) : Typeset.inlineWords(block.tr || '');
    return Typeset.fitInline(ctx, words, boxWidth * 0.96, boxHeight * 0.96, maxSize, 8, style).size;
  }
  return Typeset.fit(ctx, (block.tr || '').trim(), boxWidth * 0.96, boxHeight * 0.96, maxSize, 8, fontPrefix).size;
}
function syncBlockTextStyles(block, editor, overlay) {
  const baseSize = block.size || Math.max(10, Math.round((block.lineH || 16) * 1.1));
  [editor, overlay].forEach((field) => {
    field.setAttribute('dir', block.dir);
    field.style.textAlign = block.align;
    field.style.fontWeight = block.bold ? '700' : '400';
    field.style.fontStyle = block.italic ? 'italic' : 'normal';
    field.style.textDecoration = block.underline ? 'underline' : 'none';
    field.style.color = block.color || (field.classList.contains('ed-box-text') ? '#fff' : 'var(--text)');
    field.style.fontSize = `${baseSize}px`;
  });
  overlay.dataset.baseSize = String(baseSize);
  updatePreviewScale();
}
function updatePreviewScale() {
  if (!EDI) return;
  const stage = document.querySelector('.ed-stage');
  if (!stage || !EDI.w) return;
  const stageWidth = stage.getBoundingClientRect().width;
  if (!stageWidth) return;
  const scale = stageWidth / EDI.w;
  stage.querySelectorAll('.ed-box-text').forEach((field) => {
    const block = EDI.ocr.blocks.find((item) => String(item.id) === String(field.dataset.id));
    if (!block) return;
    const x0 = Number.isFinite(block.tx0) ? block.tx0 : block.x0;
    const y0 = Number.isFinite(block.ty0) ? block.ty0 : block.y0;
    const x1 = Number.isFinite(block.tx1) ? block.tx1 : block.x1;
    const y1 = Number.isFinite(block.ty1) ? block.ty1 : block.y1;
    field.style.transform = `scale(${scale})`;
    field.style.left = '2%'; field.style.top = '2%';
    field.style.right = 'auto'; field.style.bottom = 'auto';
    field.style.width = `${96 / scale}%`;
    field.style.height = `${96 / scale}%`;
    // Match Typeset.render's auto-fit and 2% inner margin before scaling logical image pixels down.
    field.style.fontSize = `${previewTextSize(block, x1 - x0, y1 - y0)}px`;
  });
}

async function applyEditor() {
  if (!EDI) return;
  if (edBusy) { edPending = true; return; }
  // آیتم را در همان ابتدا تثبیت کن؛ اگر حین رندر ناهمگام، ویرایشگر بسته یا به تصویر دیگری منتقل شد،
  // فراخوانی‌های بعدی به EDI تهی‌شده دست نزنند و رندر آیتم قبلی سالم کامل شود
  const item = EDI;
  edBusy = true; edDirty = false;
  clearTimeout(edTimer);
  try {
    await renderEdited(item);
    // پیش‌نمایش ویرایشگر با لایهٔ زندهٔ متن به‌روز می‌شود؛ تصویر اصلی زیر آن ثابت می‌ماند.
    refreshCard(item);
    drawThumb(item);
  } catch (e) {
    console.warn(e);
    alert('خطا در ساخت تصویر: ' + (e && e.message ? e.message : e));
  } finally {
    edBusy = false;
    if (edPending) { edPending = false; applyEditor(); }
  }
}

function buildEditor() {
  const it = EDI, blocks = it.ocr.blocks;
  const list = $('edList'), boxes = $('edBoxes');
  list.innerHTML = ''; boxes.innerHTML = '';
  activeRichEditor = null; edFieldFocused = false;
  if (!blocks.length) { list.innerHTML = '<div class="ed-empty">در این تصویر متنی پیدا نشد.</div>'; return; }

  const makeToolbar = (block) => `<div class="blk-format" role="toolbar" aria-label="قالب‌بندی متن">
    <div class="dir-group" title="جهت متن"><button type="button" class="fmt-btn blk-dir-rtl" title="راست‌به‌چپ">RTL</button><button type="button" class="fmt-btn blk-dir-ltr" title="چپ‌به‌راست">LTR</button></div>
    <select class="sel blk-align" title="تراز متن"><option value="right">راست‌چین</option><option value="center">وسط‌چین</option><option value="left">چپ‌چین</option></select>
    <button type="button" class="fmt-btn blk-bold" data-command="bold" title="پررنگ"><b>B</b></button>
    <button type="button" class="fmt-btn blk-italic" data-command="italic" title="کج"><i>I</i></button>
    <button type="button" class="fmt-btn blk-under" data-command="underline" title="زیرخط"><u>U</u></button>
    <button type="button" class="fmt-btn blk-strike" data-command="strikeThrough" title="خط‌خورده">S̶</button>
    <button type="button" class="fmt-btn blk-bullet" data-command="insertUnorderedList" title="فهرست نشانه‌دار">•≡</button>
    <button type="button" class="fmt-btn blk-numbered" data-command="insertOrderedList" title="فهرست شماره‌دار">1≡</button>
    <label class="size-field">اندازه <input type="number" class="blk-size" min="8" max="160" step="1" placeholder="خودکار" aria-label="اندازهٔ قلم"></label>
    <label class="color-field">رنگ <input type="color" class="blk-color" value="#0b0b0b" aria-label="رنگ قلم"></label>
    <button type="button" class="fmt-btn blk-undo" data-command="undo" title="واگرد">↶</button>
    <button type="button" class="fmt-btn blk-redo" data-command="redo" title="ازنو">↷</button>
    <button type="button" class="fmt-btn blk-clear" data-command="removeFormat" title="پاک‌کردن قالب‌بندی">Tx</button>
  </div>`;

  blocks.forEach((b) => {
    b.dir = b.dir === 'ltr' ? 'ltr' : 'rtl';
    b.align = ['center', 'left'].includes(b.align) ? b.align : 'right';
    b.bold = b.bold !== false; b.italic = !!b.italic; b.underline = !!b.underline;
    b.size = Number.isFinite(+b.size) && +b.size > 0 ? +b.size : null;
    b.color = /^#[\da-f]{6}$/i.test(b.color) ? b.color : null;
    normalizeLegacyBlock(b);

    const box = document.createElement('div');
    box.className = `ed-box${b.enabled ? '' : ' off'}`; box.dataset.id = b.id;
    boxes.appendChild(box);
    const overlay = document.createElement('div');
    overlay.className = 'ed-box-text'; overlay.dataset.id = b.id;
    overlay.contentEditable = 'true'; overlay.setAttribute('contenteditable', 'true'); overlay.setAttribute('role', 'textbox'); overlay.setAttribute('aria-label', `ویرایش مستقیم ترجمه ${b.id}`);
    overlay.setAttribute('dir', b.dir); overlay.spellcheck = true; overlay.innerHTML = b.richHtml || '';
    overlay.dataset.baseSize = String(b.size || Math.max(10, Math.round((b.lineH || 16) * 1.1)));
    box.appendChild(overlay);
    const moveHandle = document.createElement('button');
    moveHandle.type = 'button'; moveHandle.className = 'ed-move'; moveHandle.textContent = '⠿';
    moveHandle.setAttribute('aria-label', `جابجایی کادر متن ${b.id}`); moveHandle.title = 'برای جابجایی کادر بکشید';
    box.appendChild(moveHandle);
    ['n','ne','e','se','s','sw','w','nw'].forEach((dir) => {
      const handle = document.createElement('button'); handle.type = 'button'; handle.className = `ed-resize ed-resize-${dir}`;
      handle.dataset.dir = dir; handle.setAttribute('aria-label', `تغییر اندازهٔ کادر ${dir}`); box.appendChild(handle);
    });
    const setGeometry = () => {
      const x0 = Number.isFinite(b.tx0) ? b.tx0 : b.x0, y0 = Number.isFinite(b.ty0) ? b.ty0 : b.y0;
      const x1 = Number.isFinite(b.tx1) ? b.tx1 : b.x1, y1 = Number.isFinite(b.ty1) ? b.ty1 : b.y1;
      box.style.left = `${x0 / it.w * 100}%`; box.style.top = `${y0 / it.h * 100}%`;
      box.style.width = `${(x1 - x0) / it.w * 100}%`; box.style.height = `${(y1 - y0) / it.h * 100}%`;
      updatePreviewScale();
    };
    setGeometry();
    box.classList.toggle('off', !b.enabled);
    box.classList.toggle('active', false);
    const startBoxMove = (event, handle) => {
      event.preventDefault(); event.stopPropagation();
      selectRichEditor(overlay);
      const stageRect = document.querySelector('.ed-stage').getBoundingClientRect();
      if (!stageRect.width || !stageRect.height) return;
      const sx = it.w / stageRect.width, sy = it.h / stageRect.height;
      const x0 = Number.isFinite(b.tx0) ? b.tx0 : b.x0, y0 = Number.isFinite(b.ty0) ? b.ty0 : b.y0;
      const x1 = Number.isFinite(b.tx1) ? b.tx1 : b.x1, y1 = Number.isFinite(b.ty1) ? b.ty1 : b.y1;
      const origin = { x: event.clientX, y: event.clientY, x0, y0, x1, y1 };
      handle.setPointerCapture(event.pointerId);
      const move = (ev) => {
        const width = origin.x1 - origin.x0, height = origin.y1 - origin.y0;
        const nextX0 = Math.max(0, Math.min(it.w - width, origin.x0 + (ev.clientX - origin.x) * sx));
        const nextY0 = Math.max(0, Math.min(it.h - height, origin.y0 + (ev.clientY - origin.y) * sy));
        b.tx0 = nextX0; b.tx1 = nextX0 + width;
        b.ty0 = nextY0; b.ty1 = nextY0 + height;
        setGeometry(); scheduleApply();
      };
      const stop = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', stop);
        handle.removeEventListener('pointercancel', stop);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', stop);
      handle.addEventListener('pointercancel', stop);
    };
    moveHandle.addEventListener('pointerdown', (event) => startBoxMove(event, moveHandle));
    box.addEventListener('pointerdown', (event) => {
      if (event.target === box) startBoxMove(event, box);
    });
    overlay.addEventListener('focus', () => { selectRichEditor(overlay); edFieldFocused = true; });
    overlay.addEventListener('input', () => updateRichBlock(b.id, overlay));
    overlay.addEventListener('paste', (event) => insertPlainPaste(event, overlay));
    overlay.addEventListener('focusout', (event) => {
      if (editorFieldEl(event.relatedTarget)) return;
      edFieldFocused = false; flushEditorOnBlur();
    });
    box.querySelectorAll('.ed-resize').forEach((handle) => handle.addEventListener('pointerdown', (event) => {
      event.preventDefault(); event.stopPropagation();
      const stageRect = document.querySelector('.ed-stage').getBoundingClientRect();
      const sx = it.w / stageRect.width, sy = it.h / stageRect.height;
      const dir = handle.dataset.dir;
      let x0 = Number.isFinite(b.tx0) ? b.tx0 : b.x0, y0 = Number.isFinite(b.ty0) ? b.ty0 : b.y0;
      let x1 = Number.isFinite(b.tx1) ? b.tx1 : b.x1, y1 = Number.isFinite(b.ty1) ? b.ty1 : b.y1;
      const origin = { x: event.clientX, y: event.clientY, x0, y0, x1, y1 };
      handle.setPointerCapture(event.pointerId);
      const move = (ev) => {
        const dx = (ev.clientX - origin.x) * sx, dy = (ev.clientY - origin.y) * sy;
        const minW = Math.min(20, it.w), minH = Math.min(16, it.h);
        x0 = origin.x0; y0 = origin.y0; x1 = origin.x1; y1 = origin.y1;
        if (dir.includes('w')) x0 = Math.max(0, Math.min(origin.x1 - minW, origin.x0 + dx));
        if (dir.includes('e')) x1 = Math.min(it.w, Math.max(origin.x0 + minW, origin.x1 + dx));
        if (dir.includes('n')) y0 = Math.max(0, Math.min(origin.y1 - minH, origin.y0 + dy));
        if (dir.includes('s')) y1 = Math.min(it.h, Math.max(origin.y0 + minH, origin.y1 + dy));
        b.tx0 = x0; b.ty0 = y0; b.tx1 = x1; b.ty1 = y1;
        setGeometry(); scheduleApply();
      };
      const stop = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', stop); handle.removeEventListener('pointercancel', stop); };
      handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', stop); handle.addEventListener('pointercancel', stop);
    }));

    const row = document.createElement('div'); row.className = `blk${b.enabled ? '' : ' off'}`; row.dataset.id = b.id;
    row.innerHTML = `<div class="blk-top"><span class="blk-n">${b.id}</span>
      <label><input type="checkbox" ${b.enabled ? 'checked' : ''}> جایگزین شود</label>
      <select class="sel blk-bg"><option value="auto">پس‌زمینه: خودکار</option><option value="white">پس‌زمینه: سفید</option>
      <option value="black">پس‌زمینه: مشکی</option><option value="none">بدون پاک‌کردن</option></select>
      <button type="button" class="fmt-btn blk-copy-orig" title="کپی متن OCR">کپی متن اصلی</button></div>
      ${makeToolbar(b)}
      <div class="blk-orig"><label class="blk-orig-label">متن OCR (قابل اصلاح)</label>
        <textarea class="blk-orig-text" rows="2" aria-label="اصلاح متن تشخیص‌داده‌شده"></textarea>
        <div class="blk-actions">
          <button type="button" class="fmt-btn blk-retranslate" title="ترجمهٔ دوبارهٔ متن اصلاح‌شده به فارسی">ترجمهٔ دوباره</button>
          <button type="button" class="fmt-btn blk-clear-translation" title="پاک‌کردن فقط ترجمهٔ این متن؛ متن OCR و بقیهٔ ترجمه‌ها باقی می‌مانند">پاک‌کردن ترجمه</button>
        </div>
      </div>
      <div class="blk-editor" data-id="${escapeEditorText(b.id)}" contenteditable="true" role="textbox" aria-label="ترجمهٔ قابل ویرایش" spellcheck="true"></div>
      <div class="blk-help">متن را همین‌جا اصلاح کنید؛ برای ویرایش روی تصویر، دستگیرهٔ بالای کادر را بکشید تا جابه‌جا شود و دستگیره‌های دور کادر را برای تغییر اندازه بکشید.</div>`;
    const originalField = row.querySelector('.blk-orig-text');
    originalField.dir = 'auto';
    originalField.value = b.text || '';
    originalField.addEventListener('input', () => { b.text = originalField.value; });
    const editor = row.querySelector('.blk-editor'); editor.setAttribute('dir', b.dir); editor.innerHTML = b.richHtml || '';
    syncBlockTextStyles(b, editor, overlay);
    row.querySelector('.blk-bg').value = b.bg || 'auto';
    row.querySelector('.blk-editor').addEventListener('focus', () => { selectRichEditor(editor); edFieldFocused = true; });
    editor.addEventListener('input', () => updateRichBlock(b.id, editor));
    editor.addEventListener('paste', (event) => insertPlainPaste(event, editor));
    editor.addEventListener('focusout', (event) => {
      if (editorFieldEl(event.relatedTarget)) return;
      edFieldFocused = false; flushEditorOnBlur();
    });
    row.querySelector('.blk-top input').addEventListener('change', (event) => {
      b.enabled = event.target.checked; row.classList.toggle('off', !b.enabled); box.classList.toggle('off', !b.enabled); scheduleApply();
    });
    row.querySelector('.blk-bg').addEventListener('change', (event) => { b.bg = event.target.value; scheduleApply(); });
    row.querySelector('.blk-copy-orig').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const ok = await copyPlainText(b.text || '');
      button.classList.toggle('copied', ok);
      button.title = ok ? 'کپی شد ✓' : 'کپی ناموفق بود';
      setTimeout(() => { button.classList.remove('copied'); button.title = 'کپی متن OCR'; }, 1400);
    });
    row.querySelector('.blk-retranslate').addEventListener('click', (event) =>
      retranslateBlock(it, b, originalField, editor, overlay, event.currentTarget));
    row.querySelector('.blk-clear-translation').addEventListener('click', (event) => {
      b.tr = '';
      b.richHtml = '';
      editor.innerHTML = '';
      overlay.innerHTML = '';
      updatePreviewScale();
      scheduleApply();
      const button = event.currentTarget;
      button.textContent = 'پاک شد ✓';
      button.disabled = true;
      setTimeout(() => {
        if (!button.isConnected) return;
        button.textContent = 'پاک‌کردن ترجمه';
        button.disabled = false;
      }, 1400);
    });
    row.querySelectorAll('.blk-format button').forEach((button) => {
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', () => {
        if (button.classList.contains('blk-dir-rtl') || button.classList.contains('blk-dir-ltr')) {
          b.dir = button.classList.contains('blk-dir-rtl') ? 'rtl' : 'ltr';
          syncBlockTextStyles(b, editor, overlay); scheduleApply(); return;
        }
        const command = button.dataset.command;
        if (command) runRichCommand(command);
      });
    });
    row.querySelector('.blk-align').value = b.align;
    row.querySelector('.blk-align').addEventListener('change', (event) => { b.align = event.target.value; syncBlockTextStyles(b, editor, overlay); scheduleApply(); });
    row.querySelector('.blk-size').value = b.size || '';
    row.querySelector('.blk-size').addEventListener('change', (event) => {
      const size = Number(event.target.value);
      const selection = activeRichEditor && String(activeRichEditor.dataset.id) === String(b.id) && hasRichSelection(activeRichEditor);
      if (selection && applyRichStyle('fontSize', size)) return;
      b.size = size >= 8 ? Math.min(160, size) : null;
      syncBlockTextStyles(b, editor, overlay);
      scheduleApply();
    });
    row.querySelector('.blk-color').addEventListener('input', (event) => {
      const selection = activeRichEditor && String(activeRichEditor.dataset.id) === String(b.id) && hasRichSelection(activeRichEditor);
      if (selection && applyRichStyle('color', event.target.value)) return;
      b.color = event.target.value; syncBlockTextStyles(b, editor, overlay); scheduleApply();
    });
    list.appendChild(row);
  });
  updatePreviewScale();
  if (!window.__editorResizeBound) {
    window.addEventListener('resize', updatePreviewScale); window.__editorResizeBound = true;
  }
}

function setEdImage(item = EDI) {
  if (!item) return;
  // نمایش تصویر اصلی زیر لایهٔ قابل‌ویرایش؛ نمایش خروجیِ ازقبل‌رندرشده متن را دوبار نشان می‌داد.
  const blob = item.blob;
  if (edUrl) URL.revokeObjectURL(edUrl);
  edUrl = URL.createObjectURL(blob);
  $('edImg').onload = updatePreviewScale;
  $('edImg').src = edUrl;
}

function openEditor(it) {
  if (!it || !it.ocr) return;
  EDI = it; edDirty = false;
  $('edTitle').innerText = `ویرایش ترجمه — تصویر ${it.i + 1} (${it.ocr.blocks.length} متن)`;
  buildEditor();
  setEdImage();
  $('editor').classList.remove('hidden');
  requestAnimationFrame(updatePreviewScale);
  document.body.style.overflow = 'hidden';
}

async function closeEditor() {
  if (!EDI) return;
  clearTimeout(edTimer);
  edFieldFocused = false;
  if (edDirty) {
    if (edBusy) {
      // رندر جدید را صف کن و تا پایان آن EDI را نگه دار؛ وگرنه رندر صف‌گذاشته‌شده آیتم خودش را از دست می‌دهد.
      edPending = true;
      while (edBusy) await new Promise((resolve) => setTimeout(resolve, 10));
    } else {
      await applyEditor();
    }
  }
  $('editor').classList.add('hidden');
  document.body.style.overflow = '';
  if (edUrl) { URL.revokeObjectURL(edUrl); edUrl = null; }
  $('edImg').onload = null;
  $('edImg').removeAttribute('src');
  activeRichEditor = null;
  EDI = null;
  refreshAll();
}

// ---------- خروجی متنی قابل ویرایش ----------
function exportText() {
  const done = items.filter((it) => it.ocr && it.ocr.blocks.length);
  if (!done.length) { alert('هنوز متنی استخراج نشده است. ابتدا «ترجمهٔ متن تصاویر» را اجرا کنید.'); return; }
  const pad = Math.max(3, String(items.length).length);
  let out = '';
  done.forEach((it) => {
    out += `===== تصویر ${String(it.i + 1).padStart(pad, '0')} =====\n\n`;
    it.ocr.blocks.forEach((b) => {
      // خروجی متنی ساده مارکرهای استایل درون‌متنی را ندارد
      const tr = b.tr && b.tr.trim()
        ? (typeof Typeset !== 'undefined' ? Typeset.stripInlineMarkers(b.tr) : b.tr).trim()
        : '';
      out += `[${b.id}] ${b.text}\n    ← ${tr || '(بدون ترجمه)'}\n\n`;
    });
  });
  const blob = new Blob(['\ufeff' + out], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = ($('pdfName').value.trim() || 'comic').replace(/\.pdf$/i, '') + '-text.txt';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ---------- اتصال رویدادها ----------
$('ocrEnabled').addEventListener('change', async () => {
  if (!$('ocrEnabled').checked) {
    cancelTranslation();
    // خاموش‌کردن سراسری OCR، ترجمه‌های موقت را کنار می‌گذارد و تصویر اصلی را برمی‌گرداند.
    items.forEach((it) => { it.ocr = null; it.edited = null; });
    refreshAll();
    items.filter((it) => it.state === 'ok').forEach((it) => drawThumb(it));
    if (TR.worker) {
      try { await TR.worker.terminate(); } catch {}
      TR.worker = null;
      TR.lang = null;
    }
  }
  refreshSummary();
});
$('trAiProvider').addEventListener('change', () => {
  captureAiProvider();
  showAiProvider($('trAiProvider').value);
  $('trAiError').textContent = '';
  saveAiSettings();
});
['trAiEnabled', 'trAiModel', 'trAiSkill'].forEach((id) => {
  $(id).addEventListener('change', () => {
    $('trAiError').textContent = '';
    if (id === 'trAiModel') $('aiProfileList').querySelectorAll('.ai-profile-status').forEach((status) => { status.textContent = ''; });
    saveAiSettings();
  });
});
$('trAiAddProfile').onclick = async () => {
  await aiSettingsReady;
  aiProfiles.push(makeAiProfile(`API ${aiProfiles.length + 1}`));
  renderAiProfiles(); saveAiSettings();
  const rows = $('aiProfileList').querySelectorAll('.ai-profile-row');
  const keyInput = rows[rows.length - 1].querySelector('input[type="password"]');
  keyInput.focus();
};
$('trAiSkillReset').onclick = async () => {
  await aiSettingsReady;
  $('trAiSkill').value = AiTranslateTools.DEFAULT_SKILL;
  await saveAiSettings();
};
$('btnTranslate').onclick = openTrDialog;
$('trClose').onclick = closeTrDialog;
$('trStart').onclick = runTranslate;
$('trDialog').addEventListener('click', (e) => { if (e.target.id === 'trDialog') closeTrDialog(); });
$('btnStopTr').onclick = cancelTranslation;
$('edApply').onclick = applyEditor;
$('edClose').onclick = closeEditor;
$('edRevert').onclick = async () => {
  if (!EDI) return;
  EDI.ocr.blocks.forEach((b) => { b.enabled = false; });
  buildEditor();
  await applyEditor();
};
$('btnTxt').onclick = exportText;
document.addEventListener('selectionchange', () => {
  const selection = window.getSelection();
  if (activeRichEditor && selection && selection.rangeCount && activeRichEditor.contains(selection.anchorNode)) {
    richSelectionRange = selection.getRangeAt(0).cloneRange();
    syncRichToolbarState();
  }
});
// فوکوس در هر دو سطح (ویرایشگر کناری و کادر روی تصویر) حفظ می‌شود؛ رندر فقط پس از خروج از فیلد انجام می‌گیرد.
$('editor').addEventListener('focusin', (e) => {
  if (editorFieldEl(e.target)) edFieldFocused = true;
});
$('editor').addEventListener('focusout', (e) => {
  if (!editorFieldEl(e.target)) return;
  if (editorFieldEl(e.relatedTarget)) return;
  edFieldFocused = false;
  flushEditorOnBlur();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('editor').classList.contains('hidden')) closeEditor();
  else if (!$('trDialog').classList.contains('hidden')) closeTrDialog();
});
window.addEventListener('pagehide', () => { if (TR.worker) { try { TR.worker.terminate(); } catch {} } });
