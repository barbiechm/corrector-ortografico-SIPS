const DRIVE_API_ORIGIN = 'https://www.googleapis.com';
const DRIVE_FOLDER_ID = /^[A-Za-z0-9_-]{10,200}$/;
const HTML_FILE_NAME = /\.html?$/i;

const MAX_REQUEST_BYTES = 4 * 1024;
const MAX_LISTED_ENTRIES = 100;
const MAX_HTML_FILES = 25;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;

function getCorsHeaders(request, env) {
  const origins = env.ALLOWED_ORIGINS?.split(',').map((origin) => origin.trim()).filter(Boolean) ?? [];
  const origin = request.headers.get('Origin');
  const allowedOrigin = origins.length === 0
    ? '*'
    : origin && origins.includes(origin)
      ? origin
      : null;

  const headers = new Headers({
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  });

  if (allowedOrigin) {
    headers.set('Access-Control-Allow-Origin', allowedOrigin);
    if (allowedOrigin !== '*') headers.set('Vary', 'Origin');
  }

  return headers;
}

function json(request, env, status, body) {
  const headers = getCorsHeaders(request, env);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(body), { status, headers });
}

function error(request, env, status, code, message) {
  return json(request, env, status, { error: { code, message } });
}

export function extractDriveFolderId(folderUrl) {
  if (typeof folderUrl !== 'string' || folderUrl.length > 2048) return null;

  let url;
  try {
    url = new URL(folderUrl);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' || url.hostname !== 'drive.google.com') return null;

  const match = url.pathname.match(/^\/drive(?:\/u\/\d+)?\/folders\/([A-Za-z0-9_-]{10,200})\/?$/);
  return match?.[1] && DRIVE_FOLDER_ID.test(match[1]) ? match[1] : null;
}

async function readLimitedBytes(body, limit) {
  if (!body) return new Uint8Array();

  const reader = body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new RangeError('limit exceeded');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function parseRequest(request) {
  const contentLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new RangeError('request too large');
  }

  const bytes = await readLimitedBytes(request.body, MAX_REQUEST_BYTES);
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes));
    return extractDriveFolderId(body?.folderUrl);
  } catch (cause) {
    if (cause instanceof RangeError) throw cause;
    return null;
  }
}

function driveUrl(pathname, params, apiKey) {
  const url = new URL(pathname, DRIVE_API_ORIGIN);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set('key', apiKey);
  return url.toString();
}

function driveError(code, status, message) {
  return Object.assign(new Error(message), { code, status });
}

async function fetchDrive(url) {
  let response;
  try {
    response = await fetch(url, { redirect: 'manual' });
  } catch {
    throw driveError('DRIVE_NETWORK_ERROR', 503, 'Drive could not be reached.');
  }
  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    throw driveError('DRIVE_REDIRECT_BLOCKED', 502, 'Drive returned an unexpected redirect.');
  }
  return response;
}

function classifyDriveHttpFailure(response, operation) {
  if (response.status === 401 || response.status === 403) {
    return driveError('DRIVE_ACCESS_DENIED', 422, 'Drive denied access to the requested resource.');
  }
  if (response.status === 404) {
    return driveError('DRIVE_RESOURCE_NOT_FOUND', 422, 'The requested Drive resource was not found.');
  }
  if (response.status === 429) {
    return driveError('DRIVE_RATE_LIMITED', 503, 'Drive is temporarily rate-limiting requests.');
  }
  if (response.status >= 500) {
    return driveError('DRIVE_UPSTREAM_UNAVAILABLE', 503, 'Drive is temporarily unavailable.');
  }
  return driveError(`DRIVE_${operation}_HTTP_ERROR`, 502, 'Drive rejected the request.');
}

async function listFolderFiles(folderId, apiKey) {
  const url = driveUrl('/drive/v3/files', {
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'nextPageToken,files(id,name,size)',
    orderBy: 'name',
    pageSize: String(MAX_LISTED_ENTRIES),
    spaces: 'drive',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  }, apiKey);
  const response = await fetchDrive(url);

  if (!response.ok) {
    throw classifyDriveHttpFailure(response, 'LIST');
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw Object.assign(new Error('Drive returned an invalid listing'), { code: 'DRIVE_LIST_FAILED', status: 502 });
  }

  if (!Array.isArray(data.files) || data.nextPageToken) {
    throw Object.assign(new Error(`Folders may contain at most ${MAX_LISTED_ENTRIES} immediate entries`), {
      code: 'FOLDER_TOO_LARGE', status: 422,
    });
  }

  const files = data.files.filter((file) => (
    typeof file?.id === 'string'
    && DRIVE_FOLDER_ID.test(file.id)
    && typeof file?.name === 'string'
    && HTML_FILE_NAME.test(file.name)
  ));

  if (files.length > MAX_HTML_FILES) {
    throw Object.assign(new Error(`Folders may contain at most ${MAX_HTML_FILES} HTML files`), {
      code: 'TOO_MANY_HTML_FILES', status: 422,
    });
  }

  return files;
}

async function fetchHtmlFile(file, apiKey, totalBytes) {
  const declaredSize = Number(file.size);
  if (Number.isFinite(declaredSize) && declaredSize > MAX_FILE_BYTES) {
    throw Object.assign(new Error(`${file.name} exceeds the 1 MiB file limit`), { code: 'FILE_TOO_LARGE', status: 422 });
  }
  if (Number.isFinite(declaredSize) && totalBytes + declaredSize > MAX_TOTAL_BYTES) {
    throw Object.assign(new Error(`Imported HTML may not exceed ${MAX_TOTAL_BYTES / 1024 / 1024} MiB in total`), { code: 'PACK_TOO_LARGE', status: 422 });
  }

  const response = await fetchDrive(driveUrl(`/drive/v3/files/${file.id}`, { alt: 'media' }, apiKey));
  if (!response.ok) {
    throw classifyDriveHttpFailure(response, 'DOWNLOAD');
  }

  const contentLength = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_FILE_BYTES) {
    throw Object.assign(new Error(`${file.name} exceeds the 1 MiB file limit`), { code: 'FILE_TOO_LARGE', status: 422 });
  }
  if (Number.isFinite(contentLength) && totalBytes + contentLength > MAX_TOTAL_BYTES) {
    throw Object.assign(new Error(`Imported HTML may not exceed ${MAX_TOTAL_BYTES / 1024 / 1024} MiB in total`), { code: 'PACK_TOO_LARGE', status: 422 });
  }

  let bytes;
  try {
    bytes = await readLimitedBytes(response.body, Math.min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - totalBytes));
  } catch (cause) {
    if (cause instanceof RangeError) {
      throw Object.assign(new Error(`${file.name} exceeds the allowed import size`), { code: 'PACK_TOO_LARGE', status: 422 });
    }
    throw cause;
  }

  return { name: file.name, content: new TextDecoder().decode(bytes), byteLength: bytes.byteLength };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: getCorsHeaders(request, env) });
    if (request.method !== 'POST') return error(request, env, 405, 'METHOD_NOT_ALLOWED', 'Use POST /import with a Drive folder URL.');

    const url = new URL(request.url);
    if (url.pathname !== '/import') return error(request, env, 404, 'NOT_FOUND', 'Endpoint not found.');
    if (!env.GOOGLE_DRIVE_API_KEY) return error(request, env, 500, 'SERVER_MISCONFIGURED', 'Drive import is not configured.');

    let folderId;
    try {
      folderId = await parseRequest(request);
    } catch (cause) {
      if (cause instanceof RangeError) return error(request, env, 413, 'REQUEST_TOO_LARGE', 'Request body must not exceed 4 KiB.');
      return error(request, env, 400, 'INVALID_REQUEST', 'Request body must be valid JSON.');
    }
    if (!folderId) {
      return error(request, env, 400, 'INVALID_FOLDER_URL', 'Provide an HTTPS drive.google.com folder link.');
    }

    try {
      const listedFiles = await listFolderFiles(folderId, env.GOOGLE_DRIVE_API_KEY);
      const files = [];
      let totalBytes = 0;
      for (const file of listedFiles) {
        const imported = await fetchHtmlFile(file, env.GOOGLE_DRIVE_API_KEY, totalBytes);
        totalBytes += imported.byteLength;
        files.push({ name: imported.name, content: imported.content });
      }
      return json(request, env, 200, { files, limits: { maxFiles: MAX_HTML_FILES, maxFileBytes: MAX_FILE_BYTES, maxTotalBytes: MAX_TOTAL_BYTES } });
    } catch (cause) {
      const status = cause?.status ?? 502;
      const code = cause?.code ?? 'DRIVE_UNAVAILABLE';
      const message = cause?.message ?? 'Drive could not be reached.';
      return error(request, env, status, code, message);
    }
  },
};
