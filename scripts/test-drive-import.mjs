import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/worker.mjs';

const folderId = '1FMef5uHhl-yLC7nIeD6aCxJI0185B9lh';
const fileId = '1A2b3C4d5E6f7G8h9I0j';
const env = { GOOGLE_DRIVE_API_KEY: 'test-drive-key' };

function importRequest() {
  return new Request('https://worker.example/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderUrl: `https://drive.google.com/drive/folders/${folderId}` }),
  });
}

async function responseBody(response) {
  return JSON.parse(await response.text());
}

test('lists a public folder with shared-drive parameters without exposing the API key', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: new URL(url), options });
    if (calls.length === 1) {
      return Response.json({ files: [{ id: fileId, name: 'pack.html', size: '17' }] });
    }
    return new Response('<p>safe content</p>');
  };

  try {
    const response = await worker.fetch(importRequest(), env);
    const body = await responseBody(response);
    assert.equal(response.status, 200);
    assert.deepEqual(body.files, [{ name: 'pack.html', content: '<p>safe content</p>' }]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url.origin, 'https://www.googleapis.com');
    assert.equal(calls[0].url.searchParams.get('q'), `'${folderId}' in parents and trashed = false`);
    assert.equal(calls[0].url.searchParams.get('supportsAllDrives'), 'true');
    assert.equal(calls[0].url.searchParams.get('includeItemsFromAllDrives'), 'true');
    assert.equal(calls[0].options.redirect, 'manual');
    assert.doesNotMatch(JSON.stringify(body), /test-drive-key/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('returns a safe classification for Drive HTTP failures', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('upstream diagnostic details', { status: 500 });

  try {
    const response = await worker.fetch(importRequest(), env);
    const body = await responseBody(response);
    assert.equal(response.status, 503);
    assert.deepEqual(body.error, {
      code: 'DRIVE_UPSTREAM_UNAVAILABLE',
      message: 'Drive is temporarily unavailable.',
    });
    assert.doesNotMatch(JSON.stringify(body), /upstream diagnostic details|test-drive-key/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('returns safe classifications for redirect and network failures', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async () => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example' } });
  let response = await worker.fetch(importRequest(), env);
  let body = await responseBody(response);
  assert.equal(response.status, 502);
  assert.deepEqual(body.error, {
    code: 'DRIVE_REDIRECT_BLOCKED',
    message: 'Drive returned an unexpected redirect.',
  });

  globalThis.fetch = async () => { throw new TypeError('network details'); };
  response = await worker.fetch(importRequest(), env);
  body = await responseBody(response);
  assert.equal(response.status, 503);
  assert.deepEqual(body.error, {
    code: 'DRIVE_NETWORK_ERROR',
    message: 'Drive could not be reached.',
  });
});
