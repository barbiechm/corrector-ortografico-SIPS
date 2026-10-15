import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { randomFillSync } from 'node:crypto';

// Load checker.js (a classic script, not a module) into an isolated VM
// context and read back the global it attaches, exactly like index.html
// loading it via <script src="checker.js"> would.
const checkerSource = readFileSync(new URL('../checker.js', import.meta.url), 'utf8');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(checkerSource, sandbox, { filename: 'checker.js' });
const OC = sandbox.OrthographyChecker;

// checker.js runs in its own vm context/realm, so objects/arrays it builds
// have a different Array/Object prototype than this file's. Round-trip
// through JSON before deepEqual so structural comparisons don't fail on
// realm identity alone.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

// Minimal entity decoder standing in for the DOM <textarea> trick index.html
// uses in the browser (see decodeEntities() in index.html's inline script).
function decodeEntities(str) {
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function encodeEntities(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

test('OrthographyChecker is exposed as a plain global (classic script, not a module)', () => {
  assert.equal(typeof OC, 'object');
  assert.equal(typeof OC.extractText, 'function');
});

test('extraction keeps copy with apostrophes and quotes', () => {
  const source = `<div>Don't miss it</div><div>It's here</div><div>"Oferta" especial</div>`;
  const text = OC.extractText(source, decodeEntities);
  assert.match(text, /Don't miss it/);
  assert.match(text, /It's here/);
  assert.match(text, /"Oferta" especial/);
});

test('extraction keeps "Free returns" instead of matching the old substring blocklist', () => {
  const source = `<div>Free returns on all orders</div>`;
  const text = OC.extractText(source, decodeEntities);
  assert.match(text, /Free returns on all orders/);
});

test('extraction rejects code-shaped fragments', () => {
  const source = `<div>window.dataLayer.push(event)</div><div>translate(10px, 20px)</div><div>Título real</div>`;
  const text = OC.extractText(source, decodeEntities);
  assert.doesNotMatch(text, /window\.dataLayer/);
  assert.doesNotMatch(text, /translate\(/);
  assert.match(text, /Título real/);
});

test('inline <b> tags do not split a sentence into separate fragments', () => {
  const source = `<p>Compra <b>ya</b> antes de que se acabe</p>`;
  const text = OC.extractText(source, decodeEntities);
  assert.equal(text, 'Compra ya antes de que se acabe');
});

test('<br> becomes a space instead of merging words together', () => {
  const source = `<p>Primera línea<br>Segunda línea</p>`;
  const text = OC.extractText(source, decodeEntities);
  assert.equal(text, 'Primera línea Segunda línea');
});

test('keeps a long legal line under the raised 400-char cap', () => {
  const legal = 'Al participar en esta promocion aceptas los terminos y condiciones completos disponibles en el sitio web oficial, incluyendo restricciones de edad, disponibilidad limitada por region y la posibilidad de cambios sin previo aviso segun decision unilateral del organizador y sus socios comerciales autorizados.';
  assert.ok(legal.length > 120 && legal.length < 400, `fixture length ${legal.length} out of expected range`);
  const text = OC.extractText(`<p>${legal}</p>`, decodeEntities);
  assert.equal(text, legal);
});

test('extracts text from HTML escaped across several nested levels (nested srcdoc)', () => {
  const inner = '<div>Oferta increible para ti</div>';
  const level1 = encodeEntities(inner);
  const level2 = encodeEntities(level1);
  const outer = `<div>${level2}</div>`;
  const text = OC.extractText(outer, decodeEntities);
  assert.match(text, /Oferta increible para ti/);
});

test('extractEmbeddedMedia finds png+mp4, normalizes jpg, skips tiny images and svg, and dedupes', () => {
  const big = (ch) => ch.repeat(3000); // decodes to well over the 2 KB image floor
  const source = [
    `<img src="data:image/png;base64,${big('A')}">`,
    `<img src="data:image/png;base64,${big('A')}">`, // duplicate payload, deduped
    `<img src="data:image/jpg;base64,${big('B')}">`, // normalizes to image/jpeg
    `<img src="data:image/png;base64,AAAA">`, // too small, skipped
    `<img src="data:image/svg+xml;base64,${big('C')}">`, // svg not supported inline, skipped
    `<video src="data:video/mp4;base64,${big('D')}"></video>`,
  ].join('\n');

  const media = OC.extractEmbeddedMedia(source, source);
  assert.equal(media.images.length, 2);
  assert.deepEqual(plain(media.images.map((i) => i.mimeType).sort()), ['image/jpeg', 'image/png']);
  assert.equal(media.videos.length, 1);
  assert.equal(media.videos[0].mimeType, 'video/mp4');
  assert.ok(media.skipped >= 2, `expected at least 2 skipped, got ${media.skipped}`);
});

test('extractEmbeddedMedia keeps every image up to the per-file maximum and reports the rest', () => {
  assert.equal(OC.MAX_MEDIA_IMAGES, 60);
  const letters = 'ABCDEFGHIJ';
  // Sizes grow with the position, so the first two are the smallest.
  const images = [...letters].flatMap((a) => [...letters].map((b) => a + b)).slice(0, 62)
    .map((pair, index) => ({ data: pair.repeat(1500) + 'Z'.repeat(index * 4) }));
  const source = images.map(({ data }) => `<img src="data:image/png;base64,${data}">`).join('\n');
  const media = OC.extractEmbeddedMedia(source, '');
  assert.equal(media.images.length, 60);
  assert.equal(media.omitted, 2);
  // The two smallest are left out and the source order of the rest is kept.
  const kept = new Set(plain(media.images.map((image) => image.data)));
  assert.equal(kept.has(images[0].data), false);
  assert.equal(kept.has(images[1].data), false);
  assert.deepEqual(plain(media.images.map((image) => image.data)), images.slice(2).map((image) => image.data));
  // Twelve images are no longer cut at ten.
  const twelve = OC.extractEmbeddedMedia('ABCDEFGHIJKL'.split('').map((ch) => `<img src="data:image/png;base64,${ch.repeat(3000)}">`).join(''), '');
  assert.equal(twelve.images.length, 12);
  assert.equal(twelve.omitted, 0);
  assert.equal(OC.extractEmbeddedMedia('<img src="data:image/png;base64,' + 'A'.repeat(3000) + '"><img src="data:image/png;base64,AAAA">', '').omitted, 0);
});

test('extractEmbeddedMedia keeps videos largest first up to the per-file maximum', () => {
  assert.equal(OC.MAX_MEDIA_VIDEOS, 8);
  const video = (ch, length) => `<video src="data:video/mp4;base64,${ch.repeat(length)}"></video>`;
  const source = 'ABCDEFGHI'.split('').map((ch, index) => video(ch, 400 * (index + 1))).join('\n');
  const media = OC.extractEmbeddedMedia(source, '');
  assert.equal(media.videos.length, 8);
  assert.deepEqual(plain(media.videos.map((v) => v.data[0])), ['I', 'H', 'G', 'F', 'E', 'D', 'C', 'B']);
  assert.equal(media.omitted, 1);
});

test('extractEmbeddedMedia counts media omitted by the per-file byte budget', () => {
  const mib = 1024 * 1024;
  const video = (ch) => `<video src="data:video/mp4;base64,${ch.repeat(Math.ceil(30 * mib * 4 / 3))}"></video>`;
  const small = `<video src="data:video/mp4;base64,${'S'.repeat(1000)}"></video>`;
  const media = OC.extractEmbeddedMedia([video('A'), video('B'), video('C'), small].join('\n'), '');
  assert.equal(media.videos.length, 3);
  assert.deepEqual(plain(media.videos.map((v) => v.data[0])).sort(), ['A', 'B', 'S']);
  assert.equal(media.omitted, 1);
});

test('extractEmbeddedMedia accepts already-decoded extra media and dedupes it against the source', () => {
  const data = 'Q'.repeat(4000);
  const media = OC.extractEmbeddedMedia(`<img src="data:image/png;base64,${data}">`, '', [
    { mimeType: 'image/png', data }, { mimeType: 'image/webp', data: 'W'.repeat(4000) }, { mimeType: 'image/png', data: 'tiny' },
  ]);
  assert.deepEqual(plain(media.images.map((image) => image.mimeType)), ['image/png', 'image/webp']);
});

test('planAnalysisBatches splits media by count and bytes and sends the text with the first batch', () => {
  const image = (ch, bytes = 3000) => ({ mimeType: 'image/png', data: ch.repeat(Math.ceil(bytes * 4 / 3 / 4) * 4) });
  const images = 'ABCDEFGHIJKLMNOPQRSTUV'.split('').map((ch) => image(ch));
  const batches = plain(OC.planAnalysisBatches('Shop Now', { images, videos: [] }));
  assert.deepEqual(batches.map((batch) => batch.media.images.length), [10, 10, 2]);
  assert.deepEqual(batches.map((batch) => batch.text), ['Shop Now', '', '']);

  const mib = 1024 * 1024;
  const heavy = plain(OC.planAnalysisBatches('', { images: [image('A', 4 * mib), image('B', 4 * mib), image('C', 1 * mib)], videos: [] }));
  assert.deepEqual(heavy.map((batch) => batch.media.images.length), [1, 2]);

  const videos = 'ABC'.split('').map((ch) => ({ mimeType: 'video/mp4', data: ch.repeat(400) }));
  assert.deepEqual(plain(OC.planAnalysisBatches('', { images: [], videos })).map((batch) => batch.media.videos.length), [2, 1]);

  assert.deepEqual(plain(OC.planAnalysisBatches('solo texto', {})), [{ text: 'solo texto', media: { images: [], videos: [] } }]);
  assert.deepEqual(plain(OC.planAnalysisBatches('  ', {})), []);
  const longText = Array.from({ length: 300 }, (_, i) => `Línea ${i} `.padEnd(390, 'x')).join('\n');
  const textBatches = plain(OC.planAnalysisBatches(longText, { images: [image('A')], videos: [] }));
  assert.ok(textBatches.length >= 3);
  assert.ok(textBatches.every((batch) => batch.text.length <= OC.MAX_BATCH_TEXT_CHARS));
  assert.equal(textBatches.map((batch) => batch.text).filter(Boolean).join('\n'), longText);
  assert.equal(textBatches[0].media.images.length, 1);
});

test('mergeAnalysisResults combines batches, dedupes findings and drops cross-batch clipped layers', () => {
  const issue = (original, suggestion, source = 'image') => ({ original, suggestion, reason: 'r', lang: 'en', type: 'error', source });
  const merged = plain(OC.mergeAnalysisResults([
    { issues: [issue('Shpo', 'Shop'), issue('et 1 Month FREE.', 'Get 1 Month FREE.')], discardedIssues: 1, extractedText: 'Shpo now\net 1 Month FREE.', unreadableText: false, model: 'm' },
    { issues: [issue('Shpo', 'Shop')], discardedIssues: 0, extractedText: 'Get 1 Month FREE.', unreadableText: true, model: 'm' },
  ], 'Texto'));
  assert.deepEqual(merged.issues.map((item) => item.original), ['Shpo']);
  assert.equal(merged.discardedIssues, 1);
  assert.equal(merged.unreadableText, true);
  assert.equal(merged.extractedText, 'Shpo now\net 1 Month FREE.\nGet 1 Month FREE.');
  assert.equal(merged.model, 'm');
});

// Builds a ZIP (stored or deflated entries) the way Cocos "super-html" embeds its assets.
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, deflate } of entries) {
    const nameBytes = Buffer.from(name);
    const body = deflate ? zlib.deflateRawSync(data) : data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

function pngBytes(size, fill) {
  const bytes = Buffer.alloc(size, fill);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]).copy(bytes);
  return bytes;
}

// Inserts the junk digit the super-html packer adds at offset - key.length.
function obfuscate(base64, key, offset, digit = '7') {
  const pos = offset - key.length;
  return base64.slice(0, pos) + digit + base64.slice(pos);
}

test('extractPackedMedia reads images from an embedded Cocos ZIP and repairs obfuscated data URIs', async () => {
  const browserish = { atob, btoa, Blob, Response, DecompressionStream, TextDecoder };
  vm.createContext(browserish);
  vm.runInContext(checkerSource, browserish, { filename: 'checker.js' });
  const packed = browserish.OrthographyChecker;

  // Incompressible content keeps the embedded ZIP as long as a real one.
  const binary = pngBytes(5000, 1);
  randomFillSync(binary, 16);
  const resKeyA = 'assets/main/native/aa/aaaaaaaa-1111.png';
  const resKeyB = 'assets/main/native/bb/bbbbbbbb-22222.png';
  const textEntry = 'assets/main/native/cc/cccccccc-333.png';
  const webp = Buffer.alloc(6000, 3);
  Buffer.from('RIFF').copy(webp, 0);
  webp.writeUInt32LE(webp.length - 8, 4);
  Buffer.from('WEBPVP8 ').copy(webp, 8);
  const offset = resKeyA.length + 8;
  const res = {
    [resKeyA]: `data:image/png;base64,${obfuscate(pngBytes(4000, 2).toString('base64'), resKeyA, offset)}`,
    [resKeyB]: `data:image/png;base64,${obfuscate(pngBytes(4500, 4).toString('base64'), resKeyB, offset)}`,
    'assets/sound.mp3': 'data:audio/mpeg;base64,SUQzAAAA',
    'assets/main/native/dd/broken.webp': 'data:image/webp;base64,' + 'A'.repeat(5001),
    '@src/main.js': 'console.log(1)',
  };
  const zip = buildZip([
    { name: 'assets/', data: Buffer.alloc(0) },
    { name: 'assets/main/native/ee/binary.png', data: binary, deflate: true },
    { name: textEntry, data: Buffer.from(`data:image/webp;base64,${obfuscate(webp.toString('base64'), textEntry, offset)}`), deflate: true },
    { name: '__res', data: Buffer.from(JSON.stringify(res)), deflate: true },
    { name: 'cocos-js/cc.js', data: Buffer.from('x'.repeat(100)) },
  ]);
  const html = `<script>window.__zip = "${zip.toString('base64')}";</script>`;
  const result = await packed.extractPackedMedia(html);
  assert.equal(result.found, true);
  assert.equal(result.unrecoverable, 1);
  const decoded = plain(result.media).map(({ mimeType, data }) => [mimeType, Buffer.from(data, 'base64')]);
  assert.equal(decoded.length, 4);
  assert.deepEqual(decoded.map(([mimeType]) => mimeType).sort(), ['image/png', 'image/png', 'image/png', 'image/webp']);
  assert.ok(decoded.some(([, bytes]) => bytes.equals(binary)));
  assert.ok(decoded.some(([, bytes]) => bytes.equals(pngBytes(4000, 2))));
  assert.ok(decoded.some(([, bytes]) => bytes.equals(pngBytes(4500, 4))));
  assert.ok(decoded.some(([, bytes]) => bytes.equals(webp)));

  assert.deepEqual(plain(await packed.extractPackedMedia('<p>sin paquete</p>')), { media: [], unrecoverable: 0, found: false });
});

test('normalizeIssues drops incomplete entries and fills type/source defaults', () => {
  const result = OC.normalizeIssues([
    { original: 'ay', suggestion: 'hay' },
    { original: 'x' }, // missing suggestion, dropped
    { suggestion: 'y' }, // missing original, dropped
    { original: 'foo', suggestion: 'bar', type: 'bogus', source: 'bogus' },
    { original: 'baz', suggestion: 'qux', type: 'suggestion', source: 'image' },
    null,
  ]);
  assert.equal(result.length, 3);
  assert.equal(result[0].type, 'error');
  assert.equal(result[0].source, 'text');
  assert.equal(result[1].type, 'error');
  assert.equal(result[1].source, 'text');
  assert.equal(result[2].type, 'suggestion');
  assert.equal(result[2].source, 'image');
  assert.equal(OC.normalizeIssues('not an array').length, 0);
});

test('analysis requests contain only text and media, never models or provider prompts', () => {
  assert.deepEqual(plain(OC.buildAnalysisRequest('hola')), { text: 'hola', media: { images: [], videos: [] } });
  const media = { images: [{ mimeType: 'image/png', data: 'AAAA', byteLength: 3 }], videos: [{ mimeType: 'video/mp4', data: 'BBBB' }] };
  assert.deepEqual(plain(OC.buildAnalysisRequest('', media)), {
    text: '', media: { images: [{ mimeType: 'image/png', data: 'AAAA' }], videos: media.videos },
  });
});

test('analysis responses preserve visual metadata and reject malformed success/error payloads', () => {
  const payload = { issues: [{ original: 'ola', suggestion: 'hola', source: 'image' }], extractedText: 'ola', unreadableText: true, model: 'server/model' };
  const result = OC.parseAnalysisResponse(payload);
  assert.equal(result.extractedText, 'ola');
  assert.equal(result.unreadableText, true);
  assert.equal(result.model, 'server/model');
  assert.equal(result.issues[0].source, 'image');
  for (const invalid of [null, {}, { ...payload, issues: {} }, { ...payload, unreadableText: 'false' }]) {
    assert.throws(() => OC.parseAnalysisResponse(invalid), /respuesta inválida/);
  }
  assert.throws(() => OC.parseAnalysisResponse({ error: { code: 'UNAUTHORIZED', message: 'Clave inválida.' } }), /Clave inválida/);
});

test('uploads enforce size, extensions and matching declared MIME', () => {
  for (const [name, type] of [['A.PNG', 'image/png'], ['a.jpg', 'image/jpeg'], ['a.jpeg', ''], ['a.webp', 'image/webp']]) {
    assert.equal(OC.classifyUploadFile({ name, type, size: OC.MAX_UPLOAD_FILE_BYTES }).kind, 'image');
  }
  assert.equal(OC.classifyUploadFile({ name: 'a.htm', type: '', size: 4 }).kind, 'html');
  for (const file of [
    { name: 'a.png', type: 'image/jpeg', size: 4 },
    { name: 'a.jpg', type: 'image/jpg', size: 4 },
    { name: 'a.gif', type: 'image/gif', size: 4 },
    { name: 'a.png', type: 'image/png', size: OC.MAX_UPLOAD_FILE_BYTES + 1 },
    { name: 'a.html', size: OC.MAX_HTML_FILE_BYTES + 1 },
  ]) assert.throws(() => OC.classifyUploadFile(file));
  // HTML packs with embedded video or game bundles are accepted up to 25 MiB.
  assert.equal(OC.classifyUploadFile({ name: 'a.html', size: OC.MAX_HTML_FILE_BYTES }).kind, 'html');
  assert.throws(() => OC.classifyUploadFile({ name: 'a.html', size: 26 * 1024 * 1024 }), /26,0 MiB y supera el límite de 25 MiB/);
});

test('image data URLs are validated and empty browser MIME gets the computed MIME', () => {
  for (const mime of ['image/png', '', 'application/octet-stream']) {
    assert.deepEqual(plain(OC.parseImageDataUrl(`data:${mime};base64,AAAA`, 'image/png')), { mimeType: 'image/png', data: 'AAAA' });
  }
  for (const invalid of ['data:image/jpeg;base64,AAAA', 'data:image/png;base64,???', 'data:image/png;base64,A', 'data:image/png;base64,', 'not a data URL']) {
    assert.throws(() => OC.parseImageDataUrl(invalid, 'image/png'));
  }
});

test('describeDriveError maps known Worker codes to Spanish and falls back otherwise', () => {
  assert.equal(OC.describeDriveError('FILE_TOO_LARGE'), OC.DRIVE_ERROR_MESSAGES.FILE_TOO_LARGE);
  assert.equal(OC.describeDriveError('SOME_UNKNOWN_CODE', 'raw english message'), 'raw english message');
});

test('extraction ignores script assets, styles, title and comments at every nested level', () => {
  const inner = '<title>internal_project_name_03</title><p>Buy Now</p>'
    + '<script type="text/sprt-asset">/* => the document\'s own <html lang> */</script>'
    + '<style>.x{}</style><!-- Hidden note here -->';
  const outer = `<iframe srcdoc="${inner.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}"></iframe>`
    + '<title>outer_title_name</title>';
  const text = OC.extractText(outer, decodeEntities);
  assert.equal(text, 'Buy Now');
});

test('normalizeIssues drops findings whose suggestion equals the original', () => {
  const issues = OC.normalizeIssues([
    { original: "the document's own", suggestion: "the document's own ", type: 'suggestion' },
    { original: 'Ola', suggestion: 'Hola', type: 'error' },
  ]);
  assert.deepEqual(issues.map(issue => issue.original), ['Ola']);
});

test('parseAnalysisResponse counts server- and client-discarded findings', () => {
  const issue = { original: 'Ola', suggestion: 'Hola', reason: 'r', lang: 'es', type: 'error', source: 'text' };
  const parsed = OC.parseAnalysisResponse({
    issues: [issue, { ...issue, suggestion: 'Ola' }], discardedIssues: 2,
    extractedText: '', unreadableText: false, model: 'provider/model',
  });
  assert.equal(parsed.issues.length, 1);
  assert.equal(parsed.discardedIssues, 3);
  const legacy = OC.parseAnalysisResponse({ issues: [], extractedText: '', unreadableText: false, model: 'provider/model' });
  assert.equal(legacy.discardedIssues, 0);
});

test('block-styled spans separate lines while per-character inline-block spans stay joined', () => {
  const line = (text) => `<span style="display: block; white-space: pre-wrap;">${text}</span>`;
  const letter = (ch) => `<span style="display: inline-block; white-space: pre-wrap;">${ch}</span>`;
  const source = `<div>${line('right away and within')}${line('weeks, my energy became')}${line('steadier.')}</div>`
    + `<div>${'Feel it'.split('').map(letter).join('')}</div>`;
  const text = OC.extractText(source, decodeEntities);
  assert.equal(text, 'right away and within weeks, my energy became steadier.\nFeel it');
});

test('parseAnalysisResponse appends a safe diagnostic code to service errors', () => {
  assert.throws(() => OC.parseAnalysisResponse({ error: { message: 'Falló.', detail: 'issue_lang' } }),
    /Falló\. \(diagnóstico: issue_lang\)/);
  assert.throws(() => OC.parseAnalysisResponse({ error: { message: 'Falló.', detail: '<b>x</b>' } }), /^Error: Falló\.$/);
});
