// Unit tests for optional, whole-context Gemini translation.
const AiTranslateTools = require('../src/core/ai-translate.js');

let failures = 0;
function check(name, condition, extra) {
  if (condition) console.log('PASS:', name);
  else { failures++; console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

(async () => {
  check('default Skill asks for whole-context, natural comic translation',
    /همهٔ متن/.test(AiTranslateTools.DEFAULT_SKILL) && /طبیعی/.test(AiTranslateTools.DEFAULT_SKILL) &&
    /لحن/.test(AiTranslateTools.DEFAULT_SKILL) && /یکسان/.test(AiTranslateTools.DEFAULT_SKILL));

  const entries = [
    { id: 'p0001-b001', page: 1, text: 'I trusted you.' },
    { id: 'p0001-b002', page: 1, text: 'You lied!' },
    { id: 'p0002-b001', page: 2, text: 'Please listen.' }
  ];
  const txt = AiTranslateTools.buildText(entries);
  check('TXT payload keeps every page and bubble ID in order',
    txt.includes('PAGE 1') && txt.includes('PAGE 2') && txt.includes('[p0002-b001]') &&
    txt.indexOf('I trusted you.') < txt.indexOf('You lied!') && txt.indexOf('You lied!') < txt.indexOf('Please listen.'), txt);
  check('TXT payload groups same-page entries under one page heading',
    (txt.match(/===== PAGE 1 =====/g) || []).length === 1, txt);

  {
    const calls = [];
    const signal = { marker: 'abort-signal' };
    const fetchFn = async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true, status: 200,
        json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify([
          { id: 'p0001-b001', translation: 'بهت اعتماد داشتم.' },
          { id: 'p0001-b002', translation: 'دروغ گفتی!' },
          { id: 'p0002-b001', translation: 'لطفاً گوش کن.' }
        ]) }] } }] })
      };
    };
    const result = await AiTranslateTools.translateBatch({
      apiKey: 'secret-test-key', model: 'gemini-3.8-flash', sourceLang: 'en', skill: 'لحن صمیمی', entries, fetchFn, signal
    });
    check('whole selection uses exactly one Gemini request', calls.length === 1, calls.length);
    check('all bubble translations map back to their own IDs', result.size === 3 &&
      result.get('p0001-b002') === 'دروغ گفتی!' && result.get('p0002-b001') === 'لطفاً گوش کن.');
    const request = calls[0];
    const body = JSON.parse(request.options.body);
    check('API key is sent in the header, never in URL or text payload',
      request.options.headers['x-goog-api-key'] === 'secret-test-key' &&
      !request.url.includes('secret-test-key') && !request.options.body.includes('secret-test-key'));
    check('request contains complete comic TXT and custom Skill',
      body.contents[0].parts[0].text.includes('COMIC_TXT') && body.contents[0].parts[0].text.includes('Please listen.') &&
      body.systemInstruction.parts[0].text.includes('لحن صمیمی'));
    check('request requires structured JSON and forwards cancellation signal',
      body.generationConfig.responseMimeType === 'application/json' && request.options.signal === signal);
    check('request omits cookies and referer',
      request.options.credentials === 'omit' && request.options.referrerPolicy === 'no-referrer');
  }

  {
    let calls = 0;
    const result = await AiTranslateTools.translateBatch({ entries: [], fetchFn: async () => { calls++; } });
    check('empty selection returns without spending an API request', result.size === 0 && calls === 0, calls);
  }
  {
    let calls = 0;
    let message = '';
    try {
      await AiTranslateTools.translateBatch({ entries, apiKey: 'x', model: '../bad-model', fetchFn: async () => { calls++; } });
    } catch (error) { message = error.message; }
    check('invalid model is rejected before any request', calls === 0 && /مدل/.test(message), { calls, message });
  }
  {
    const result = await AiTranslateTools.translationMap('```json\n' + JSON.stringify([
      { id: 'known', translation: 'سلام' }, { id: 'invented', translation: 'extra' }
    ]) + '\n```', new Set(['known']));
    check('parser accepts fenced JSON but ignores invented IDs', result.size === 1 && result.get('known') === 'سلام');
  }
  {
    let caught = null;
    await AiTranslateTools.translateBatch({
      entries, apiKey: 'private-key', fetchFn: async () => ({ ok: false, status: 429, json: async () => ({}) })
    }).catch((error) => { caught = error; });
    check('quota error remains available for a useful fallback message', caught && caught.status === 429 &&
      /سقف/.test(AiTranslateTools.safeError(caught)), caught && caught.message);
    check('safe quota message never exposes the API key', !AiTranslateTools.safeError(caught).includes('private-key'));
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL AI TRANSLATION TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((error) => { console.error('TEST CRASH:', error); process.exit(2); });
