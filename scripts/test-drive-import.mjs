import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/worker.mjs';

const folderId = '1Zx9Yw8Vu7Ts6Rqp5OnM';
const fileId = '1A2b3C4d5E6f7G8h9I0j';
const otherFileId = '0J9i8H7g6F5e4D3c2B1a';
const env = { GOOGLE_DRIVE_API_KEY: 'test-drive-key' };
const fiveMiB = 5 * 1024 * 1024;

function importRequest(body) {
  return new Request('https://worker.example/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderUrl: `https://drive.google.com/drive/folders/${folderId}`, ...body }),
  });
}

async function responseBody(response) {
  return JSON.parse(await response.text());
}

function listing(files, nextPageToken) {
  return Response.json({ files, ...(nextPageToken ? { nextPageToken } : {}) });
}

test('lists public-folder HTML metadata without downloading content or exposing the API key', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: new URL(url), options });
    return listing([{ id: fileId, name: 'pack.html', size: '17' }]);
  };

  try {
    const response = await worker.fetch(importRequest({ action: 'list' }), env);
    const body = await responseBody(response);
    assert.equal(response.status, 200);
    assert.deepEqual(body.files, [{ id: fileId, name: 'pack.html', byteLength: 17 }]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.origin, 'https://www.googleapis.com');
    assert.equal(calls[0].url.searchParams.get('q'), `'${folderId}' in parents and trashed = false`);
    assert.equal(calls[0].url.searchParams.get('supportsAllDrives'), 'true');
    assert.equal(calls[0].url.searchParams.get('includeItemsFromAllDrives'), 'true');
    assert.equal(calls[0].options.redirect, 'manual');
    assert.doesNotMatch(JSON.stringify(body), /test-drive-key|safe content/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('follows every Drive listing page without an HTML count cap or content downloads', async () => {
  const secondPageFileId = '2B3c4D5e6F7g8H9i0J1k';
  const thirdPageFileId = '3C4d5E6f7G8h9I0j1K2l';
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    calls.push(parsed);
    switch (parsed.searchParams.get('pageToken')) {
      case null:
        return listing([{ id: fileId, name: 'first.html', size: '10' }], 'page-2');
      case 'page-2':
        return listing([{ id: secondPageFileId, name: 'ignored.txt', size: '20' }], 'page-3');
      case 'page-3':
        return listing([{ id: thirdPageFileId, name: 'last.htm', size: '30' }]);
      default:
        throw new Error(`Unexpected page token: ${parsed.searchParams.get('pageToken')}`);
    }
  };

  try {
    const response = await worker.fetch(importRequest({ action: 'list' }), env);
    const body = await responseBody(response);
    assert.equal(response.status, 200);
    assert.deepEqual(body.files, [
      { id: fileId, name: 'first.html', byteLength: 10 },
      { id: thirdPageFileId, name: 'last.htm', byteLength: 30 },
    ]);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map((call) => call.pathname), Array(3).fill('/drive/v3/files'));
    assert.deepEqual(calls.map((call) => call.searchParams.get('pageToken')), [null, 'page-2', 'page-3']);
    assert.doesNotMatch(JSON.stringify(body), /test-drive-key/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('downloads one authorized selected file after relisting the folder', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    calls.push(parsed);
    if (parsed.pathname === '/drive/v3/files') return listing([{ id: fileId, name: 'single.html', size: '12' }]);
    return new Response('<p>single</p>');
  };

  try {
    const response = await worker.fetch(importRequest({ action: 'download', fileIds: [fileId] }), env);
    assert.equal(response.status, 200);
    assert.deepEqual((await responseBody(response)).files, [{ name: 'single.html', content: '<p>single</p>' }]);
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('downloads authorized selected files in a bounded batch after relisting the folder', async () => {
  const secondFileId = '2B3c4D5e6F7g8H9i0J1k';
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    calls.push(parsed);
    if (parsed.pathname === '/drive/v3/files') {
      return listing([
        { id: fileId, name: 'one.html', size: '10' },
        { id: secondFileId, name: 'two.htm', size: '11' },
      ]);
    }
    return new Response(parsed.pathname.endsWith(fileId) ? '<p>one</p>' : '<p>two</p>');
  };

  try {
    const response = await worker.fetch(importRequest({ action: 'download', fileIds: [fileId, secondFileId] }), env);
    const body = await responseBody(response);
    assert.equal(response.status, 200);
    assert.deepEqual(body.files, [
      { name: 'one.html', content: '<p>one</p>' },
      { name: 'two.htm', content: '<p>two</p>' },
    ]);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].pathname, '/drive/v3/files');
    assert.equal(calls[1].searchParams.get('alt'), 'media');
    assert.equal(calls[2].searchParams.get('alt'), 'media');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rejects selection that is not a current member of the requested folder', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(new URL(url));
    return listing([{ id: fileId, name: 'allowed.html', size: '10' }]);
  };

  try {
    const response = await worker.fetch(importRequest({ action: 'download', fileIds: [otherFileId] }), env);
    const body = await responseBody(response);
    assert.equal(response.status, 422);
    assert.deepEqual(body.error, {
      code: 'FILE_NOT_IN_FOLDER',
      message: 'Each selected file must belong to the requested public folder.',
    });
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('validates selected files against every relisted page before downloading', async () => {
  const secondPageFileId = '2B3c4D5e6F7g8H9i0J1k';
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    calls.push(parsed);
    if (parsed.pathname === '/drive/v3/files' && !parsed.searchParams.get('pageToken')) {
      return listing([{ id: fileId, name: 'first.html', size: '10' }], 'page-2');
    }
    if (parsed.pathname === '/drive/v3/files' && parsed.searchParams.get('pageToken') === 'page-2') {
      return listing([{ id: secondPageFileId, name: 'selected.html', size: '15' }]);
    }
    return new Response('<p>selected</p>');
  };

  try {
    const response = await worker.fetch(importRequest({ action: 'download', fileIds: [secondPageFileId] }), env);
    assert.equal(response.status, 200);
    assert.deepEqual((await responseBody(response)).files, [{ name: 'selected.html', content: '<p>selected</p>' }]);
    assert.equal(calls.length, 3);
    assert.equal(calls[2].searchParams.get('alt'), 'media');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('accepts an HTML exactly at the 5 MiB boundary and rejects a larger declared file', async () => {
  const originalFetch = globalThis.fetch;
  const exactBytes = new Uint8Array(fiveMiB);
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/drive/v3/files') return listing([{ id: fileId, name: 'boundary.html', size: String(fiveMiB) }]);
    return new Response(exactBytes, { headers: { 'Content-Length': String(fiveMiB) } });
  };

  try {
    let response = await worker.fetch(importRequest({ action: 'download', fileIds: [fileId] }), env);
    assert.equal(response.status, 200);
    assert.equal((await responseBody(response)).files[0].content.length, fiveMiB);

    globalThis.fetch = async () => listing([{ id: fileId, name: 'too-large.html', size: String(fiveMiB + 1) }]);
    response = await worker.fetch(importRequest({ action: 'download', fileIds: [fileId] }), env);
    const body = await responseBody(response);
    assert.equal(response.status, 422);
    assert.equal(body.error.code, 'FILE_TOO_LARGE');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('does not apply an aggregate pack limit across an authorized bounded batch', async () => {
  const batchIds = [fileId, '2B3c4D5e6F7g8H9i0J1k', '3C4d5E6f7G8h9I0j1K2l'];
  const originalFetch = globalThis.fetch;
  const content = 'x'.repeat(4 * 1024 * 1024);
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/drive/v3/files') {
      return listing(batchIds.map((id, index) => ({ id, name: `pack-${index}.html`, size: String(content.length) })));
    }
    return new Response(content, { headers: { 'Content-Length': String(content.length) } });
  };

  try {
    const response = await worker.fetch(importRequest({ action: 'download', fileIds: batchIds }), env);
    const body = await responseBody(response);
    assert.equal(response.status, 200);
    assert.equal(body.files.length, 3);
    assert.equal(body.files.reduce((total, file) => total + file.content.length, 0), 12 * 1024 * 1024);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('returns safe classifications for Drive HTTP failures, redirects, and network failures', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async () => new Response('upstream diagnostic details', { status: 500 });
  let response = await worker.fetch(importRequest({ action: 'list' }), env);
  let body = await responseBody(response);
  assert.equal(response.status, 503);
  assert.deepEqual(body.error, { code: 'DRIVE_UPSTREAM_UNAVAILABLE', message: 'Drive is temporarily unavailable.' });
  assert.doesNotMatch(JSON.stringify(body), /upstream diagnostic details|test-drive-key/);

  globalThis.fetch = async () => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example' } });
  response = await worker.fetch(importRequest({ action: 'list' }), env);
  body = await responseBody(response);
  assert.equal(response.status, 502);
  assert.deepEqual(body.error, { code: 'DRIVE_REDIRECT_BLOCKED', message: 'Drive returned an unexpected redirect.' });

  globalThis.fetch = async () => { throw new TypeError('network details'); };
  response = await worker.fetch(importRequest({ action: 'list' }), env);
  body = await responseBody(response);
  assert.equal(response.status, 503);
  assert.deepEqual(body.error, { code: 'DRIVE_NETWORK_ERROR', message: 'Drive could not be reached.' });
});
