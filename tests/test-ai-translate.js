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

  {
    const calls = [];
    const fetchFn = async (url, options) => {
      const key = options.headers['x-goog-api-key'];
      calls.push(key);
      if (key === 'key-quota') return { ok: false, status: 429, json: async () => ({}) };
      if (key === 'key-offline') throw new Error('ارتباط برقرار نشد');
      const text = key === 'key-empty' ? '[]' : JSON.stringify(entries.map((entry) => ({
        id: entry.id, translation: 'ترجمهٔ ' + entry.id
      })));
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) };
    };
    const result = await AiTranslateTools.translateWithFailover({
      entries,
      profiles: [
        { id: 'a', name: 'سهمیهٔ تمام‌شده', apiKey: 'key-quota' },
        { id: 'b', name: 'قطع ارتباط', apiKey: 'key-offline' },
        { id: 'c', name: 'پاسخ خالی', apiKey: 'key-empty' },
        { id: 'd', name: 'کلید سالم', apiKey: 'key-good' }
      ],
      fetchFn
    });
    check('failover tries named keys once in their displayed order',
      calls.join(',') === 'key-quota,key-offline,key-empty,key-good', calls);
    check('quota, network, and unusable responses all advance to the next key',
      result.profileId === 'd' && result.profileName === 'کلید سالم' && result.translations.size === 3 &&
      result.attempts.length === 4);
  }
  {
    let calls = 0;
    const result = await AiTranslateTools.translateWithFailover({
      entries,
      profiles: [{ name: 'پاسخ ناقص', apiKey: 'partial-key' }, { name: 'مصرف نشود', apiKey: 'unused-key' }],
      fetchFn: async () => {
        calls++;
        return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify([
          { id: entries[0].id, translation: 'فقط ترجمهٔ اول' }
        ]) }] } }] }) };
      }
    });
    check('a usable partial response does not spend every remaining key',
      calls === 1 && result.profileName === 'پاسخ ناقص' && result.translations.size === 1, calls);
  }
  {
    let calls = 0, caught = null;
    await AiTranslateTools.translateWithFailover({
      entries: [entries[0]],
      profiles: [{ name: 'حساب اول', apiKey: 'private-one' }, { name: 'حساب دوم', apiKey: 'private-two' }],
      fetchFn: async () => { calls++; return { ok: false, status: 429, json: async () => ({}) }; }
    }).catch((error) => { caught = error; });
    const message = caught ? AiTranslateTools.safeError(caught) : '';
    check('all exhausted keys stop after one attempt each', calls === 2 && caught && caught.attempts.length === 2, calls);
    check('combined error names profiles without exposing either secret',
      /حساب اول/.test(message) && /حساب دوم/.test(message) &&
      !message.includes('private-one') && !message.includes('private-two'), message);
  }
  {
    const controller = new AbortController();
    let calls = 0;
    const running = AiTranslateTools.translateWithFailover({
      entries: [entries[0]],
      profiles: [{ name: 'در حال انتظار', apiKey: 'waiting-key' }, { name: 'بعد از لغو ممنوع', apiKey: 'after-abort-key' }],
      signal: controller.signal,
      fetchFn: async (url, options) => {
        calls++;
        return new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            const error = new Error('aborted'); error.name = 'AbortError'; reject(error);
          });
        });
      }
    }).catch((error) => error);
    await Promise.resolve();
    controller.abort();
    const caught = await running;
    check('abort stops failover instead of starting the next key',
      calls === 1 && caught && caught.name === 'AbortError', { calls, name: caught && caught.name });
  }
  {
    let calls = 0, caught = null;
    await AiTranslateTools.translateWithFailover({
      entries: [entries[0]], profiles: [{ name: 'خالی', apiKey: '   ' }],
      fetchFn: async () => { calls++; }
    }).catch((error) => { caught = error; });
    check('blank key profiles are rejected without a request', calls === 0 && caught && /کلید/.test(caught.message));
    const empty = await AiTranslateTools.translateWithFailover({ entries: [], fetchFn: async () => { calls++; } });
    check('empty text selection still spends no request even with no profiles', calls === 0 && empty.translations.size === 0);
  }

  {
    const calls = [], signal = { marker: 'connection-signal' };
    const result = await AiTranslateTools.testConnection({
      apiKey: 'connection-private-key', model: 'models/gemini-3.8-flash', signal,
      fetchFn: async (url, options) => {
        calls.push({ url, options });
        return { ok: true, status: 200, json: async () => ({ name: 'models/gemini-3.8-flash' }) };
      }
    });
    const request = calls[0];
    check('connection test uses one lightweight model GET, never generateContent',
      calls.length === 1 && request.options.method === 'GET' &&
      request.url === 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash' &&
      !request.url.includes('generateContent') && request.options.body === undefined);
    check('connection test keeps the key in headers and preserves privacy options',
      request.options.headers['x-goog-api-key'] === 'connection-private-key' &&
      !request.url.includes('connection-private-key') && request.options.credentials === 'omit' &&
      request.options.referrerPolicy === 'no-referrer' && request.options.signal === signal);
    check('connection test validates the selected model response', result.model === 'gemini-3.8-flash');
  }
  {
    let calls = 0, blankError = null, modelError = null;
    const fetchFn = async () => { calls++; };
    await AiTranslateTools.testConnection({ apiKey: ' ', fetchFn }).catch((error) => { blankError = error; });
    await AiTranslateTools.testConnection({ apiKey: 'x', model: '../bad', fetchFn }).catch((error) => { modelError = error; });
    check('connection test rejects blank keys and invalid models before a request',
      calls === 0 && blankError && /کلید/.test(blankError.message) && modelError && /مدل/.test(modelError.message));
  }
  {
    let denied = null, offline = null;
    await AiTranslateTools.testConnection({
      apiKey: 'denied-private-key', fetchFn: async () => ({ ok: false, status: 401, json: async () => ({}) })
    }).catch((error) => { denied = error; });
    await AiTranslateTools.testConnection({
      apiKey: 'x', fetchFn: async () => { throw new Error('socket failed'); }
    }).catch((error) => { offline = error; });
    check('connection test reports denied keys without exposing the secret',
      denied && /کلید API/.test(AiTranslateTools.safeError(denied)) &&
      !AiTranslateTools.safeError(denied).includes('denied-private-key'));
    check('connection test turns network failure into a clear Persian message', offline && /ارتباط با Gemini/.test(offline.message));
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL AI TRANSLATION TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((error) => { console.error('TEST CRASH:', error); process.exit(2); });
