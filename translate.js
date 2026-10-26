// ترجمهٔ متن به فارسی (سرویس‌های آنلاین رایگان؛ نیاز به اینترنت)
(function (root) {
  async function viaGoogle(text, sl, fetchFn) {
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=' + encodeURIComponent(sl) +
      '&tl=fa&dt=t&q=' + encodeURIComponent(text);
    const res = await fetchFn(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    const out = (j[0] || []).map((p) => p[0] || '').join('').trim();
    if (!out) throw new Error('empty');
    return out;
  }
  async function viaMyMemory(text, sl, fetchFn) {
    const lp = sl.split('-')[0] + '|fa';
    const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text.slice(0, 480)) + '&langpair=' + encodeURIComponent(lp);
    const res = await fetchFn(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    const out = ((j.responseData && j.responseData.translatedText) || '').trim();
    if (!out || /MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(out)) throw new Error('mymemory');
    return out;
  }

  // برمی‌گرداند: { text, ok }
  async function translate(text, sl, fetchFn) {
    const f = fetchFn || ((u) => fetch(u));
    for (const fn of [viaGoogle, viaMyMemory]) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try { return { text: await fn(text, sl, f), ok: true }; }
        catch (e) { await new Promise((r) => setTimeout(r, 250 * (attempt + 1))); }
      }
    }
    return { text: '', ok: false };
  }

  const api = { translate, viaGoogle, viaMyMemory };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.TranslateTools = api;
})(typeof window !== 'undefined' ? window : globalThis);
