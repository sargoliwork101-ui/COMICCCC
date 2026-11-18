// ترجمهٔ متن به فارسی (سرویس‌های آنلاین رایگان؛ نیاز به اینترنت)
(function (root) {
  const DEFAULT_REQUEST_TIMEOUT_MS = 20000;
  async function withTimeout(operation, timeoutMs) {
    const controller = new AbortController();
    let timedOut = false, timer;
    let rejectTimeout;
    const timeout = new Promise((_, reject) => { rejectTimeout = reject; });
    timer = setTimeout(() => {
      timedOut = true;
      try { controller.abort(); } catch { /* already aborted */ }
      rejectTimeout(new Error('زمان دریافت ترجمه به پایان رسید.'));
    }, timeoutMs);
    try {
      return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), timeout]);
    } catch (error) {
      if (timedOut) throw new Error('زمان دریافت ترجمه به پایان رسید.');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  async function viaGoogle(text, sl, fetchFn, timeoutMs) {
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=' + encodeURIComponent(sl) +
      '&tl=fa&dt=t&q=' + encodeURIComponent(text);
    return withTimeout(async (signal) => {
      const res = await fetchFn(url, { signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      const out = (j[0] || []).map((p) => p[0] || '').join('').trim();
      if (!out) throw new Error('empty');
      return out;
    }, timeoutMs);
  }
  async function viaMyMemory(text, sl, fetchFn, timeoutMs) {
    const lp = sl.split('-')[0] + '|fa';
    const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text.slice(0, 480)) + '&langpair=' + encodeURIComponent(lp);
    return withTimeout(async (signal) => {
      const res = await fetchFn(url, { signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      const out = ((j.responseData && j.responseData.translatedText) || '').trim();
      if (!out || /MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(out)) throw new Error('mymemory');
      return out;
    }, timeoutMs);
  }

  // برمی‌گرداند: { text, ok }
  async function translate(text, sl, fetchFn, engine = 'auto', timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    const f = fetchFn || ((u, options) => fetch(u, options));
    const requested = String(engine || 'auto').toLowerCase();
    const selected = ['google', 'mymemory', 'auto'].includes(requested) ? requested : 'auto';
    const engines = selected === 'google' ? [viaGoogle]
      : selected === 'mymemory' ? [viaMyMemory] : [viaGoogle, viaMyMemory];
    for (const fn of engines) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try { return { text: await fn(text, sl, f, timeoutMs), ok: true, engine: fn === viaGoogle ? 'google' : 'mymemory' }; }
        catch { await new Promise((r) => setTimeout(r, 250 * (attempt + 1))); }
      }
    }
    return { text: '', ok: false, engine: selected };
  }

  const api = { translate, viaGoogle, viaMyMemory, DEFAULT_REQUEST_TIMEOUT_MS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.TranslateTools = api;
})(typeof window !== 'undefined' ? window : globalThis);
