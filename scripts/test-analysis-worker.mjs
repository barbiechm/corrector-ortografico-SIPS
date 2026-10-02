import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import worker from '../src/analysis-worker.mjs';

const env = {
  ANALYSIS_ACCESS_TOKEN: 'test-access-token', OPENROUTER_API_KEY: 'test-provider-key',
  ALLOWED_ORIGINS: 'https://corrector-ortografico-sips.pages.dev',
};
const MiB = 1024 * 1024;
const clean = { issues: [], extractedText: '', unreadableText: false };
const input = (text = 'Hello world.') => ({ text, media: { images: [], videos: [] } });
const media = (mimeType, bytes) => ({ mimeType, data: Buffer.from(bytes).toString('base64') });
const png = media('image/png', [137, 80, 78, 71, 13, 10, 26, 10]);
const mp4 = media('video/mp4', [0, 0, 0, 12, 102, 116, 121, 112, 105, 115, 111, 109]);

function request(body = input(), headers = {}, path = '/analyze') {
  return new Request(`https://analysis.example${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json',
      Authorization: `Bearer ${env.ANALYSIS_ACCESS_TOKEN}`, ...headers },
    body: JSON.stringify(body),
  });
}

function completion(result = clean, extra = {}) {
  return Response.json({ choices: [{ finish_reason: 'stop',
    message: { content: JSON.stringify(result) }, ...extra }] });
}

async function mocked(t, handler, run) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (...args) => {
    calls.push(args);
    return handler(...args);
  });
  await run(calls);
}

async function expectError(response, status, code) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(body.error.code, code);
  assert.ok(body.error.message.length > 0);
  assert.doesNotMatch(JSON.stringify(body), /test-provider-key|test-access-token|sensitive-provider-detail/);
  assert.equal(Object.hasOwn(body, 'issues'), false);
}

test('bearer authentication fails closed without calling a paid service', async (t) => {
  await mocked(t, () => { throw new Error('must not fetch'); }, async (calls) => {
    for (const authorization of ['', 'Bearer wrong', 'Basic test-access-token', 'Bearer test-access-token-extra']) {
      await expectError(await worker.fetch(request(input(), { Authorization: authorization }), env), 401, 'UNAUTHORIZED');
    }
    for (const config of [{ ...env, ANALYSIS_ACCESS_TOKEN: '' }, { ...env, ANALYSIS_ACCESS_TOKEN: undefined },
      { ...env, OPENROUTER_API_KEY: '' }]) {
      await expectError(await worker.fetch(request(), config), 503, 'SERVER_MISCONFIGURED');
    }
    assert.equal(calls.length, 0);
  });
});

test('explicit origin policy, authenticated no-Origin clients, and browser preflight', async (t) => {
  await mocked(t, () => completion(), async (calls) => {
    for (const origin of ['https://evil.example', 'null', '*', '']) {
      const response = await worker.fetch(request(input(), { Origin: origin }), env);
      await expectError(response, 403, 'ORIGIN_NOT_ALLOWED');
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
    }
    await expectError(await worker.fetch(request(input(), { Origin: env.ALLOWED_ORIGINS }),
      { ...env, ALLOWED_ORIGINS: undefined }), 403, 'ORIGIN_NOT_ALLOWED');
    assert.equal(calls.length, 0);
    const preflight = await worker.fetch(new Request('https://analysis.example/analyze', {
      method: 'OPTIONS', headers: { Origin: env.ALLOWED_ORIGINS },
    }), env);
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), env.ALLOWED_ORIGINS);
    assert.match(preflight.headers.get('Access-Control-Allow-Headers'), /Authorization/);
    assert.equal(calls.length, 0);
    const browser = await worker.fetch(request(input(), { Origin: env.ALLOWED_ORIGINS }), env);
    assert.equal(browser.status, 200);
    assert.equal(browser.headers.get('Vary'), 'Origin');
    const cli = await worker.fetch(request(), env);
    assert.equal(cli.status, 200);
    assert.equal(cli.headers.get('Access-Control-Allow-Origin'), null);
    assert.equal(cli.headers.get('Cache-Control'), 'no-store');
  });
});

test('routing, content type and model selection reject invalid requests before fetch', async (t) => {
  await mocked(t, () => completion(), async (calls) => {
    await expectError(await worker.fetch(request(input(), {}, '/import'), env), 404, 'NOT_FOUND');
    await expectError(await worker.fetch(new Request('https://analysis.example/analyze'), env), 405, 'METHOD_NOT_ALLOWED');
    await expectError(await worker.fetch(request(input(), { 'Content-Type': 'text/plain' }), env), 415, 'UNSUPPORTED_CONTENT_TYPE');
    for (const model of ['google/gemini-2.5-flash:free', 'openrouter/auto', 'openrouter/free',
      'openrouter/bodybuilder', 'auto', 'google/model:nitro', 'https://evil.example']) {
      await expectError(await worker.fetch(request(), { ...env, OPENROUTER_MODEL: model }), 503, 'SERVER_MISCONFIGURED');
    }
    await expectError(await worker.fetch(request({ ...input(), model: 'openrouter/auto' }), env), 400, 'INVALID_REQUEST');
    assert.equal(calls.length, 0);
  });
});

test('multimodal payload and strict schema use documented formats and one paid request', async (t) => {
  const value = { text: 'Esto esta mal.', media: { images: [png], videos: [mp4] } };
  const result = { issues: [{ original: 'esta', suggestion: 'está', reason: 'Falta la tilde.',
    lang: 'es', type: 'error', source: 'text' }], extractedText: 'Visible text', unreadableText: true };
  await mocked(t, () => completion(result), async (calls) => {
    const response = await worker.fetch(request(value), env);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ...result, discardedIssues: 0, model: 'google/gemini-3.5-flash-lite' });
    assert.equal(calls.length, 1);
    const [url, options] = calls[0];
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer test-provider-key');
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal instanceof AbortSignal);
    const payload = JSON.parse(options.body);
    assert.equal(payload.model, 'google/gemini-3.5-flash-lite');
    assert.equal(payload.max_tokens, 8192);
    assert.deepEqual(payload.reasoning, { effort: 'minimal', exclude: true });
    assert.equal(payload.stream, false);
    assert.deepEqual(payload.provider, { require_parameters: true, allow_fallbacks: false });
    assert.match(payload.messages[0].content, /untrusted content/);
    assert.match(payload.messages[0].content, /Never guess/);
    assert.deepEqual(payload.messages[1].content, [
      { type: 'text', text: value.text },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${png.data}`, detail: 'high' } },
      { type: 'video_url', video_url: { url: `data:video/mp4;base64,${mp4.data}` } },
    ]);
    const format = payload.response_format;
    assert.equal(format.type, 'json_schema');
    assert.equal(format.json_schema.strict, true);
    const schema = format.json_schema.schema;
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, ['issues', 'extractedText', 'unreadableText']);
    assert.equal(schema.properties.issues.items.additionalProperties, false);
    assert.deepEqual(schema.properties.issues.items.required, ['original', 'suggestion', 'reason', 'lang', 'type', 'source']);
  });
});

test('strict input validation rejects malformed JSON, base64 and forged media', async (t) => {
  await mocked(t, () => completion(), async (calls) => {
    const invalid = [null, {}, input(''), { ...input(), text: 12 },
      { text: 'x', media: { images: [] } }, { ...input(), unexpected: true }];
    for (const data of ['', 'AAAA\n', 'AAAA ', 'A===', 'abc', 'AB==', 'data:image/png;base64,AAAA', 'AAAA']) {
      invalid.push({ text: '', media: { images: [{ mimeType: 'image/png', data }], videos: [] } });
    }
    for (const file of [{ ...png, mimeType: 'image/svg+xml' }, { ...png, mimeType: 'image/jpeg' },
      { ...png, extra: true }, media('image/png', Buffer.from('<html>fake</html>'))]) {
      invalid.push({ text: '', media: { images: [file], videos: [] } });
    }
    invalid.push({ text: '', media: { images: [], videos: [{ ...png, mimeType: 'video/mp4' }] } });
    for (const value of invalid) await expectError(await worker.fetch(request(value), env), 400, 'INVALID_REQUEST');
    const malformed = new Request('https://analysis.example/analyze', {
      method: 'POST', headers: request().headers, body: '{',
    });
    await expectError(await worker.fetch(malformed, env), 400, 'INVALID_REQUEST');
    assert.equal(calls.length, 0);
  });
});

test('all allowed media signatures and server-selected model are accepted', async (t) => {
  await mocked(t, () => completion(), async (calls) => {
    const images = [png, media('image/jpeg', [255, 216, 255]),
      media('image/webp', Buffer.from('RIFF0000WEBP')), media('image/gif', Buffer.from('GIF87a')),
      media('image/gif', Buffer.from('GIF89a'))];
    for (const video of [mp4, media('video/webm', [26, 69, 223, 163])]) {
      const response = await worker.fetch(request({ text: '', media: { images, videos: [video] } }),
        { ...env, OPENROUTER_MODEL: 'google/gemini-2.5-pro' });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).model, 'google/gemini-2.5-pro');
    }
    assert.equal(calls.length, 2);
  });
});

test('text, counts and aggregate decoded media boundaries', async (t) => {
  await mocked(t, () => completion(), async (calls) => {
    assert.equal((await worker.fetch(request(input('x'.repeat(60_000))), env)).status, 200);
    await expectError(await worker.fetch(request(input('x'.repeat(60_001))), env), 413, 'INPUT_LIMIT_EXCEEDED');
    assert.equal((await worker.fetch(request({ text: '', media: { images: Array(10).fill(png), videos: [mp4] } }), env)).status, 200);
    for (const value of [{ text: '', media: { images: Array(11).fill(png), videos: [] } },
      { text: '', media: { images: [], videos: [mp4, mp4] } }]) {
      await expectError(await worker.fetch(request(value), env), 413, 'INPUT_LIMIT_EXCEEDED');
    }
    const bytes = Buffer.alloc(14 * MiB);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    const big = media('image/png', bytes);
    assert.equal((await worker.fetch(request({ text: '', media: { images: [big], videos: [] } }), env)).status, 200);
    await expectError(await worker.fetch(request({ text: '', media: { images: [big, png], videos: [] } }), env), 413, 'MEDIA_TOO_LARGE');
    assert.equal(calls.length, 3);
  });
});

function streamedRequest(size, onCancel) {
  return new Request('https://analysis.example/analyze', {
    method: 'POST', headers: request().headers, duplex: 'half',
    body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(size)); }, cancel: onCancel }),
  });
}

test('request bytes are bounded by declared and actual streamed size with cancellation', async (t) => {
  await mocked(t, () => completion(), async (calls) => {
    await expectError(await worker.fetch(request(input(), { 'Content-Length': String(21 * MiB + 1) }), env), 413, 'REQUEST_TOO_LARGE');
    let cancelled = false;
    await expectError(await worker.fetch(streamedRequest(21 * MiB + 1, () => { cancelled = true; }), env), 413, 'REQUEST_TOO_LARGE');
    assert.equal(cancelled, true);
    assert.equal(calls.length, 0);
  });
});

test('exact request and response byte caps accept valid JSON, with chunked dishonest lengths rejected', async (t) => {
  const envelope = JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(clean) } }] });
  await mocked(t, () => new Response(envelope.padEnd(256 * 1024, ' ')), async (calls) => {
    const value = JSON.stringify(input()).padEnd(21 * MiB, ' ');
    const exact = new Request('https://analysis.example/analyze', {
      method: 'POST', headers: request().headers, body: value,
    });
    assert.equal((await worker.fetch(exact, env)).status, 200);
    let cancelled = false;
    const dishonest = new Request('https://analysis.example/analyze', {
      method: 'POST', headers: { ...Object.fromEntries(request().headers), 'Content-Length': '1' }, duplex: 'half',
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(10 * MiB));
          controller.enqueue(new Uint8Array(11 * MiB + 1));
        },
        cancel() { cancelled = true; },
      }),
    });
    await expectError(await worker.fetch(dishonest, env), 413, 'REQUEST_TOO_LARGE');
    assert.equal(cancelled, true);
    assert.equal(calls.length, 1);
  });
});

test('upstream HTTP failures are sanitized and never retried', async (t) => {
  let status;
  await mocked(t, () => new Response('sensitive-provider-detail test-provider-key', { status }), async (calls) => {
    for (const [http, expected, code] of [[401, 502, 'UPSTREAM_AUTH_ERROR'], [403, 502, 'UPSTREAM_AUTH_ERROR'],
      [402, 402, 'INSUFFICIENT_CREDITS'], [429, 429, 'UPSTREAM_RATE_LIMITED'],
      [500, 502, 'UPSTREAM_ERROR'], [302, 502, 'UPSTREAM_ERROR']]) {
      status = http;
      const before = calls.length;
      await expectError(await worker.fetch(request(), env), expected, code);
      assert.equal(calls.length, before + 1);
    }
  });
});

test('malformed, invalid schema, truncated, and refused results never become clean passes', async (t) => {
  let response;
  await mocked(t, () => response, async () => {
    const badResults = [null, {}, { ...clean, extra: 1 }, { ...clean, unreadableText: 'false' },
      { ...clean, extractedText: 'hallucinated' }, { ...clean, issues: {} }];
    const issue = { original: 'Hello', suggestion: 'Hi', reason: 'Optional', lang: 'en', type: 'suggestion', source: 'text' };
    for (const change of [{ source: 'audio' }, { original: ' ' }, { reason: '' }, { lang: 'fr' },
      { type: 'typo' }, { extra: true }, { suggestion: null }]) badResults.push({ ...clean, issues: [{ ...issue, ...change }] });
    for (const value of badResults) {
      response = completion(value);
      await expectError(await worker.fetch(request(), env), 502, 'UPSTREAM_INVALID_RESPONSE');
    }
    for (const [value, code] of [
      [new Response('{'), 'UPSTREAM_INVALID_RESPONSE'],
      [Response.json({ error: { message: 'sensitive-provider-detail' } }), 'UPSTREAM_INVALID_RESPONSE'],
      [completion(clean, { message: { content: '{' } }), 'UPSTREAM_INVALID_RESPONSE'],
      [completion(clean, { finish_reason: 'length' }), 'UPSTREAM_TRUNCATED'],
      [completion(clean, { finish_reason: 'content_filter' }), 'UPSTREAM_REFUSAL'],
      [completion(clean, { message: { content: JSON.stringify(clean), refusal: 'sensitive-provider-detail' } }), 'UPSTREAM_REFUSAL'],
      [completion(clean, { finish_reason: 'tool_calls' }), 'UPSTREAM_INVALID_RESPONSE'],
      [Response.json({ choices: [] }), 'UPSTREAM_INVALID_RESPONSE'],
    ]) {
      response = value;
      await expectError(await worker.fetch(request(), env), 502, code);
    }
  });
});

test('unverifiable or no-op findings are discarded and counted, never reported as a clean pass', async (t) => {
  const issue = { original: 'Hello', suggestion: 'Hi', reason: 'Optional', lang: 'en', type: 'suggestion', source: 'text' };
  const result = { ...clean, issues: [
    issue,
    { ...issue, original: 'not in input' },
    { ...issue, source: 'image' },
    { ...issue, suggestion: ' Hello ' },
  ] };
  await mocked(t, () => completion(result), async () => {
    const response = await worker.fetch(request(), env);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.issues, [issue]);
    assert.equal(body.discardedIssues, 3);
  });
});

test('findings quoted across a layout line break are kept, and the prompt treats breaks as layout', async (t) => {
  const issue = { original: 'Trust is everyting', suggestion: 'Trust is everything', reason: 'Errata.',
    lang: 'en', type: 'error', source: 'text' };
  await mocked(t, () => completion({ ...clean, issues: [issue] }), async (calls) => {
    const response = await worker.fetch(request(input('"Trust is\neveryting"\nShop Now')), env);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.issues, [issue]);
    assert.equal(body.discardedIssues, 0);
    assert.match(JSON.parse(calls[0][1].body).messages[0].content, /Line breaks[\s\S]*are layout, not language/);
  });
});

test('invalid results name the failed check without exposing model output', async (t) => {
  const issue = { original: 'Hello', suggestion: 'Hi', reason: 'Optional', lang: 'en', type: 'suggestion', source: 'text' };
  const cases = [
    [completion({ ...clean, issues: [{ ...issue, reason: ' ' }] }), 'issue_reason_empty'],
    [completion({ ...clean, issues: [{ ...issue, lang: 'fr' }] }), 'issue_lang'],
    [completion({ ...clean, extra: 'secret model text' }), 'result_shape'],
    [completion(clean, { message: { content: 'secret model text {' } }), 'content_json'],
    [completion(clean, { finish_reason: 'tool_calls' }), 'finish_reason_tool_calls'],
    [completion(clean, { finish_reason: 'secret model text!' }), 'finish_reason_unknown'],
    [Response.json({ error: { message: 'sensitive-provider-detail' } }), 'envelope_error'],
  ];
  let response;
  await mocked(t, () => response, async () => {
    for (const [value, detail] of cases) {
      response = value;
      const result = await worker.fetch(request(), env);
      assert.equal(result.status, 502);
      const body = await result.json();
      assert.equal(body.error.code, 'UPSTREAM_INVALID_RESPONSE');
      assert.equal(body.error.detail, detail);
      assert.doesNotMatch(JSON.stringify(body), /secret model text|sensitive-provider-detail/);
    }
  });
});

test('image findings that another layer shows complete or corrected are covered, not reported', async (t) => {
  const base = { reason: 'Falta una letra.', lang: 'en', type: 'error', source: 'image' };
  const value = { text: 'Shop Now', media: { images: [png, png], videos: [] } };
  const extractedText = 'Buy 3 Months.\net 1 Month FREE.\nRecieve it today\nBuy 3 Months.\nGet 1 Month FREE.';
  const result = { issues: [
    { ...base, original: 'et 1 Month FREE.', suggestion: 'and 1 Month FREE.' },   // clipped: complete elsewhere
    { ...base, original: 'et 1 Month FREE.', suggestion: 'Get 1 Month FREE.' },   // corrected elsewhere
    { ...base, original: 'Recieve it today', suggestion: 'Receive it today' },    // genuine, visible error
  ], extractedText, unreadableText: false };
  await mocked(t, () => completion(result), async (calls) => {
    const body = await (await worker.fetch(request(value), env)).json();
    assert.deepEqual(body.issues.map((issue) => issue.original), ['Recieve it today']);
    assert.equal(body.issues[0].type, 'error');
    assert.equal(body.discardedIssues, 0);
    assert.match(body.extractedText, /et 1 Month FREE\.[\s\S]*Get 1 Month FREE\./);
    assert.match(JSON.parse(calls[0][1].body).messages[0].content, /transcribe it a single time/);
  });
});

test('media-only requests send no empty text part upstream', async (t) => {
  const value = { text: '  ', media: { images: [png], videos: [] } };
  await mocked(t, () => completion({ ...clean, extractedText: 'Visible' }), async (calls) => {
    const response = await worker.fetch(request(value), env);
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(calls[0][1].body).messages[1].content, [
      { type: 'image_url', image_url: { url: `data:image/png;base64,${png.data}`, detail: 'high' } },
    ]);
  });
});

test('large media is validated without decoding the whole payload', async (t) => {
  const bytes = new Uint8Array(4 * MiB);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const big = media('image/png', bytes);
  await mocked(t, () => completion({ ...clean, extractedText: 'Visible' }), async () => {
    const original = globalThis.atob;
    let longest = 0;
    t.mock.method(globalThis, 'atob', (value) => { longest = Math.max(longest, value.length); return original(value); });
    const response = await worker.fetch(request({ text: '', media: { images: [big], videos: [] } }), env);
    assert.equal(response.status, 200);
    assert.ok(longest <= 16, `decoded ${longest} base64 chars`);
    // Noncanonical padding bits in the final quantum are still rejected.
    const tampered = { ...big, data: big.data.slice(0, -4) + 'AB==' };
    await expectError(await worker.fetch(request({ text: '', media: { images: [tampered], videos: [] } }), env), 400, 'INVALID_REQUEST');
  });
});

test('upstream response cap is enforced on declared and actual streamed bytes', async (t) => {
  let response;
  await mocked(t, () => response, async () => {
    response = new Response('{}', { headers: { 'Content-Length': String(256 * 1024 + 1) } });
    await expectError(await worker.fetch(request(), env), 502, 'UPSTREAM_RESPONSE_TOO_LARGE');
    let cancelled = false;
    response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(256 * 1024 + 1)); },
      cancel() { cancelled = true; },
    }));
    await expectError(await worker.fetch(request(), env), 502, 'UPSTREAM_RESPONSE_TOO_LARGE');
    assert.equal(cancelled, true);
  });
});

test('90-second deadline covers fetch and body reading without retries', async (t) => {
  const nativeSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    assert.equal(delay, 90_000);
    return nativeSetTimeout(callback, 5);
  });
  let signal;
  await mocked(t, async (_url, options) => {
    signal = options.signal;
    return new Promise(() => {});
  }, async (calls) => {
    await expectError(await worker.fetch(request(), env), 504, 'UPSTREAM_TIMEOUT');
    assert.equal(signal.aborted, true);
    assert.equal(calls.length, 1);
  });
  // A separate mock verifies that receiving headers does not end the deadline.
  let bodyCancelled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start() {}, cancel() { bodyCancelled = true; },
  })));
  await expectError(await worker.fetch(request(), env), 504, 'UPSTREAM_TIMEOUT');
  assert.equal(bodyCancelled, true);
});

test('network failure is sanitized', async (t) => {
  await mocked(t, () => { throw new Error('sensitive-provider-detail test-provider-key'); }, async (calls) => {
    await expectError(await worker.fetch(request(), env), 502, 'UPSTREAM_UNAVAILABLE');
    assert.equal(calls.length, 1);
  });
});

test('analysis configuration and implementation remain isolated from Drive', async () => {
  const root = new URL('../', import.meta.url);
  const config = await readFile(new URL('wrangler.analysis.jsonc', root), 'utf8');
  assert.match(config, /"main": "src\/analysis-worker.mjs"/);
  assert.match(config, /"OPENROUTER_MODEL": "google\/gemini-3\.5-flash-lite"/);
  assert.match(config, /corrector-ortografico-sips\.pages\.dev/);
  const source = await readFile(new URL('src/analysis-worker.mjs', root), 'utf8');
  assert.doesNotMatch(source, /GOOGLE_DRIVE_API_KEY|www\.googleapis\.com|from ['"]\.\/worker/);
  for (const path of ['src/worker.mjs', 'wrangler.jsonc']) {
    const baseline = execFileSync('git', ['show', `HEAD:${path}`], { cwd: root });
    assert.deepEqual(await readFile(new URL(path, root)), baseline);
  }
});
