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
  check('Gemini defaults to Google’s current Flash alias and migrates the previous default',
    AiTranslateTools.DEFAULT_MODEL === 'gemini-flash-latest' &&
    AiTranslateTools.normalizeModel('gemini-2.5-flash', 'gemini') === 'gemini-flash-latest');

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
    let request = null;
    await AiTranslateTools.translateBatch({
      context: 'webpage', provider: 'gemini', apiKey: 'webpage-private-key', model: 'gemini-flash-latest',
      entries: [{ id: 'p000001', page: 1, text: 'A short article paragraph.' }],
      fetchFn: async (url, options) => {
        request = { url, options };
        return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify([
          { id: 'p000001', translation: 'یک بند کوتاه از مقاله.' }
        ]) }] } }] }) };
      }
    });
    const body = JSON.parse(request.options.body);
    const prompt = body.systemInstruction.parts[0].text;
    check('webpage translation uses a general-purpose prompt rather than comic-dialogue instructions',
      /webpage|web page/i.test(prompt) && /Persian/.test(prompt) &&
      !/OCR comic dialogue/.test(prompt) && !/حباب/.test(prompt), prompt);
  }

  {
    const calls = [];
    const signal = new AbortController().signal;
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
    check('custom Gemini model is sent verbatim instead of the default model',
      request.url.includes('/models/gemini-3.8-flash:generateContent') &&
      AiTranslateTools.DEFAULT_MODEL !== 'gemini-3.8-flash', request.url);
    const body = JSON.parse(request.options.body);
    check('API key is sent in the header, never in URL or text payload',
      request.options.headers['x-goog-api-key'] === 'secret-test-key' &&
      !request.url.includes('secret-test-key') && !request.options.body.includes('secret-test-key'));
    const payloadLines = body.contents[0].parts[0].text.split('\n');
    const sourceRows = JSON.parse(payloadLines.slice(2).join('\n'));
    check('request sends every comic entry as ordered JSON with stable IDs and the custom Skill',
      payloadLines[0] === 'COMIC_TXT' && payloadLines[1] === 'Expected entry count: 3' && sourceRows.length === 3 &&
      sourceRows[0].id === 'p0001-b001' && sourceRows[0].text === 'I trusted you.' &&
      sourceRows[2].text === 'Please listen.' && body.systemInstruction.parts[0].text.includes('لحن صمیمی'));
    check('request requires structured JSON and forwards cancellation signal',
      body.generationConfig.responseMimeType === 'application/json' &&
      request.options.signal instanceof AbortSignal && request.options.signal !== signal);
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
    let firstRequestAborted = false;
    const fetchFn = async (url, options) => {
      const key = options.headers['x-goog-api-key'];
      calls.push(key);
      if (key === 'hung-key') {
        options.signal.addEventListener('abort', () => { firstRequestAborted = true; }, { once: true });
        return new Promise(() => {}); // Simulate an upstream/VPN request that never returns or honors abort.
      }
      const text = JSON.stringify([{ id: entries[0].id, translation: 'رسید' }]);
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) };
    };
    let failoverError = null;
    await AiTranslateTools.translateWithFailover({
      entries: [entries[0]], timeoutMs: 10,
      profiles: [
        { name: 'پاسخ‌نداده', apiKey: 'hung-key' },
        { name: 'پاسخ‌گو', apiKey: 'working-key' }
      ], fetchFn
    }).catch((error) => { failoverError = error; });
    check('a stalled Gemini request times out, aborts its network request, and does not waste time on the next key',
      firstRequestAborted && calls.join(',') === 'hung-key' && failoverError &&
      failoverError.attempts && failoverError.attempts.length === 1 &&
      failoverError.attempts[0].error && failoverError.attempts[0].error.name === 'TimeoutError',
      { firstRequestAborted, calls, attempts: failoverError && failoverError.attempts });
  }
  {
    let caught = null;
    await AiTranslateTools.translateBatch({
      entries: [entries[0]], apiKey: 'hung-key', timeoutMs: 10,
      fetchFn: async () => new Promise(() => {})
    }).catch((error) => { caught = error; });
    check('a single stalled AI request returns a readable timeout error instead of hanging the UI',
      caught && caught.name === 'TimeoutError' && /۶۰ ثانیه|پاسخ .* پس از/.test(AiTranslateTools.safeError(caught)),
      caught && caught.message);
  }
  {
    const calls = [];
    const fetchFn = async (url, options) => {
      const key = options.headers['x-goog-api-key'];
      calls.push(key);
      if (key === 'hung-key') {
        options.signal.addEventListener('abort', () => { firstRequestAborted = true; }, { once: true });
        return new Promise(() => {}); // Simulate an upstream/VPN request that never returns or honors abort.
      }
      const text = JSON.stringify([{ id: entries[0].id, translation: 'رسید' }]);
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) };
    };
    let caught = null;
    await AiTranslateTools.translateWithFailover({
      entries: [entries[0]], timeoutMs: 10,
      profiles: [
        { name: 'پاسخ‌نداده', apiKey: 'hung-key' },
        { name: 'کلیدِ بعدی', apiKey: 'working-key' }
      ], fetchFn
    }).catch((error) => { caught = error; });
    check('a timeout aborts the request and does not waste another minute trying the next key',
      firstRequestAborted && calls.join(',') === 'hung-key' && caught && caught.attempts.length === 1 &&
      caught.attempts[0].error.kind === 'timeout',
      { firstRequestAborted, calls, attempts: caught && caught.attempts.length });
  }
  {
    let caught = null;
    await AiTranslateTools.translateBatch({
      entries: [entries[0]], apiKey: 'hung-key', timeoutMs: 10,
      fetchFn: async () => new Promise(() => {})
    }).catch((error) => { caught = error; });
    check('a single stalled AI request returns a readable timeout error instead of hanging the UI',
      caught && caught.name === 'TimeoutError' && /۶۰ ثانیه|پاسخ .* پس از/.test(AiTranslateTools.safeError(caught)),
      caught && caught.message);
  }
  {
    const calls = [];
    const goodText = JSON.stringify([{ id: entries[0].id, translation: 'ترجمه شد.' }]);
    const result = await AiTranslateTools.translateWithFailover({
      entries: [entries[0]],
      profiles: [
        { id: 'quota', name: 'سهمیهٔ اول تمام‌شده', apiKey: 'quota-key' },
        { id: 'good', name: 'کلید دوم', apiKey: 'good-key' }
      ],
      fetchFn: async (url, options) => {
        const key = options.headers['x-goog-api-key'];
        calls.push(key);
        if (key === 'quota-key') return { ok: false, status: 429, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: goodText }] } }] }) };
      }
    });
    check('quota errors still try the next key because a different account may have quota',
      calls.join(',') === 'quota-key,good-key' && result.profileId === 'good' && result.translations.size === 1, calls);
  }
  {
    const calls = [];
    let caught = null;
    await AiTranslateTools.translateWithFailover({
      entries: [entries[0]],
      profiles: [
        { name: 'قطع ارتباط', apiKey: 'offline-key' },
        { name: 'کلید بعدی نباید امتحان شود', apiKey: 'unused-key' }
      ],
      fetchFn: async () => { calls.push('network'); throw new Error('opaque browser network failure'); }
    }).catch((error) => { caught = error; });
    const message = caught ? AiTranslateTools.safeError(caught) : '';
    check('a network failure stops after one key instead of repeating the same broken route',
      calls.length === 1 && caught && caught.attempts.length === 1 && caught.attempts[0].error.kind === 'network');
    check('network diagnostics mention VPN/proxy without exposing either API key',
      /VPN\/پراکسی/.test(message) && !message.includes('offline-key') && !message.includes('unused-key'), message);
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
    const calls = [];
    const result = await AiTranslateTools.translateBatch({
      provider: 'openai', apiKey: 'openai-private-key', model: 'gpt-4.1-mini', sourceLang: 'en', skill: 'لحن صمیمی', entries,
      fetchFn: async (url, options) => {
        calls.push({ url, options });
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({
          translations: entries.map((entry) => ({ id: entry.id, translation: 'OpenAI ' + entry.id }))
        }) } }] }) };
      }
    });
    const request = calls[0], body = JSON.parse(request.options.body);
    check('OpenAI provider uses the selected custom model and its own endpoint',
      calls.length === 1 && request.url === 'https://api.openai.com/v1/chat/completions' &&
      body.model === 'gpt-4.1-mini' && body.messages[1].content.includes('COMIC_TXT'));
    check('OpenAI key uses Bearer auth and never enters URL or payload',
      request.options.headers.Authorization === 'Bearer openai-private-key' &&
      !request.options.headers['x-goog-api-key'] && !request.url.includes('openai-private-key') &&
      !request.options.body.includes('openai-private-key'));
    check('OpenAI JSON object maps back to stable bubble IDs',
      result.size === 3 && result.get(entries[1].id) === 'OpenAI ' + entries[1].id);
  }
  {
    let request = null;
    const result = await AiTranslateTools.translateBatch({
      provider: 'openrouter', apiKey: 'openrouter-private-key', model: 'anthropic/claude-3.5-haiku', entries: [entries[0]],
      fetchFn: async (url, options) => {
        request = { url, options };
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: [
          { type: 'text', text: JSON.stringify({ translations: [{ id: entries[0].id, translation: 'ترجمهٔ OpenRouter' }] }) }
        ] } }] }) };
      }
    });
    const body = JSON.parse(request.options.body);
    check('OpenRouter accepts its slash-separated model ID and uses the OpenRouter endpoint',
      request.url === 'https://openrouter.ai/api/v1/chat/completions' && body.model === 'anthropic/claude-3.5-haiku' &&
      request.options.headers.Authorization === 'Bearer openrouter-private-key');
    check('OpenRouter content parts are parsed correctly', result.get(entries[0].id) === 'ترجمهٔ OpenRouter');
  }
  {
    const connectionPayload = () => ({
      translations: [{ id: 'connection-test', translation: 'سلام. این یک آزمون ترجمه است.' }]
    });
    let translationRequest = null, connectionRequest = null;
    const connection = await AiTranslateTools.testConnection({
      provider: 'avalai', apiKey: 'avalai-private-key', model: 'gpt-6-luna',
      fetchFn: async (url, options) => {
        connectionRequest = { url, options };
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(connectionPayload()) } }] }) };
      }
    });
    const body = JSON.parse(connectionRequest.options.body);
    check('connection test performs a real fixed-sample translation through the configured model',
      connection.model === 'gpt-6-luna' && connection.sampleTranslation === 'سلام. این یک آزمون ترجمه است.' &&
      connectionRequest.url === 'https://api.avalai.ir/v1/chat/completions' && body.model === 'gpt-6-luna' &&
      connectionRequest.options.method === 'POST' && body.messages[1].content.includes('Hello. This is a translation test.') &&
      connectionRequest.options.headers.Authorization === 'Bearer avalai-private-key');
    check('sample translation sends no page/comic text and keeps the key out of the URL and body',
      !body.messages[1].content.includes('Private webpage') && !connectionRequest.url.includes('avalai-private-key') &&
      !connectionRequest.options.body.includes('avalai-private-key') && connectionRequest.options.credentials === 'omit' &&
      connectionRequest.options.referrerPolicy === 'no-referrer');
  }
  {
    const calls = [];
    const openAi = await AiTranslateTools.testConnection({
      provider: 'openai', apiKey: 'openai-test-key', model: 'gpt-4.1-mini',
      fetchFn: async (url, options) => {
        calls.push({ provider: 'openai', url, options });
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({
          translations: [{ id: 'connection-test', translation: 'سلام از OpenAI' }]
        }) } }] }) };
      }
    });
    const openRouter = await AiTranslateTools.testConnection({
      provider: 'openrouter', apiKey: 'openrouter-test-key', model: 'anthropic/claude-3.5-haiku',
      fetchFn: async (url, options) => {
        calls.push({ provider: 'openrouter', url, options });
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({
          translations: [{ id: 'connection-test', translation: 'سلام از OpenRouter' }]
        }) } }] }) };
      }
    });
    check('OpenAI and OpenRouter sample tests call their own generation endpoints with selected models',
      openAi.model === 'gpt-4.1-mini' && openRouter.model === 'anthropic/claude-3.5-haiku' &&
      calls[0].url === 'https://api.openai.com/v1/chat/completions' &&
      calls[1].url === 'https://openrouter.ai/api/v1/chat/completions' &&
      calls.every((call) => call.options.method === 'POST' &&
        JSON.parse(call.options.body).messages[1].content.includes('Hello. This is a translation test.')));
    check('OpenAI providers keep their own Bearer keys private',
      calls[0].options.headers.Authorization === 'Bearer openai-test-key' &&
      calls[1].options.headers.Authorization === 'Bearer openrouter-test-key' &&
      calls.every((call) => !call.options.body.includes('test-key')));
  }
  {
    const calls = [], signal = new AbortController().signal;
    const result = await AiTranslateTools.testConnection({
      apiKey: 'connection-private-key', model: 'models/gemini-3.8-flash', signal,
      fetchFn: async (url, options) => {
        calls.push({ url, options });
        return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify([
          { id: 'connection-test', translation: 'سلام. آزمون ترجمه موفق بود.' }
        ]) }] } }] }) };
      }
    });
    const request = calls[0], requestBody = JSON.parse(request.options.body);
    check('Gemini connection test actually runs generateContent and parses its structured Persian response',
      calls.length === 1 && request.options.method === 'POST' &&
      request.url === 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent' &&
      requestBody.generationConfig.responseMimeType === 'application/json' &&
      requestBody.contents[0].parts[0].text.includes('Hello. This is a translation test.') &&
      result.model === 'gemini-3.8-flash' && /آزمون ترجمه/.test(result.sampleTranslation));
    check('Gemini sample test keeps its key in headers and forwards privacy/cancel options',
      request.options.headers['x-goog-api-key'] === 'connection-private-key' &&
      !request.url.includes('connection-private-key') && !request.options.body.includes('connection-private-key') &&
      request.options.credentials === 'omit' && request.options.referrerPolicy === 'no-referrer' &&
      request.options.signal instanceof AbortSignal && request.options.signal !== signal);
  }
  {
    let caught = null;
    await AiTranslateTools.testConnection({
      apiKey: 'hung-key', timeoutMs: 10, fetchFn: async () => new Promise(() => {})
    }).catch((error) => { caught = error; });
    check('connection test also times out when Gemini never responds',
      caught && caught.name === 'TimeoutError' && /پاسخ .* پس از/.test(caught.message));
  }
  {
    let calls = 0, blankError = null, modelError = null, emptyError = null;
    const fetchFn = async () => {
      calls++;
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '[]' }] } }] }) };
    };
    await AiTranslateTools.testConnection({ apiKey: ' ', fetchFn }).catch((error) => { blankError = error; });
    await AiTranslateTools.testConnection({ apiKey: 'x', model: '../bad', fetchFn }).catch((error) => { modelError = error; });
    await AiTranslateTools.testConnection({ apiKey: 'x', fetchFn }).catch((error) => { emptyError = error; });
    check('sample test rejects blank keys and invalid models before making requests',
      calls === 1 && blankError && /کلید/.test(blankError.message) && modelError && /مدل/.test(modelError.message));
    check('sample test rejects a successful HTTP response that contains no translated text',
      emptyError && /پاسخ قابل‌استفاده|برنگرداند/.test(emptyError.message));
  }
  {
    let denied = null, offline = null;
    await AiTranslateTools.testConnection({
      apiKey: 'denied-private-key', fetchFn: async () => ({ ok: false, status: 401, json: async () => ({}) })
    }).catch((error) => { denied = error; });
    await AiTranslateTools.testConnection({
      apiKey: 'x', fetchFn: async () => { throw new Error('socket failed'); }
    }).catch((error) => { offline = error; });
    check('generation test reports denied keys without exposing the secret',
      denied && /کلید API/.test(AiTranslateTools.safeError(denied)) &&
      !AiTranslateTools.safeError(denied).includes('denied-private-key'));
    check('generation test labels network failures safely and explains Chrome cannot identify the exact cause',
      offline && offline.name === 'NetworkError' && offline.kind === 'network' &&
      /علت دقیق/.test(AiTranslateTools.safeError(offline)) && !AiTranslateTools.safeError(offline).includes('denied-private-key'));
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL AI TRANSLATION TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((error) => { console.error('TEST CRASH:', error); process.exit(2); });
