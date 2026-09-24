import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

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

test('extractEmbeddedMedia caps at 6 images and keeps only the largest video', () => {
  const big = (ch) => ch.repeat(3000);
  const images = 'ABCDEFGH'.split('')
    .map((ch) => `<img src="data:image/png;base64,${big(ch)}">`)
    .join('\n');
  const videos = [
    `<video src="data:video/mp4;base64,${big('X')}"></video>`, // smaller
    `<video src="data:video/webm;base64,${big('Y') + big('Y')}"></video>`, // larger
  ].join('\n');

  const media = OC.extractEmbeddedMedia(images + videos, '');
  assert.equal(media.images.length, 6);
  assert.equal(media.videos.length, 1);
  assert.equal(media.videos[0].mimeType, 'video/webm');
  assert.ok(media.skipped >= 3, `expected at least 3 skipped, got ${media.skipped}`);
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

test('buildRequestBody includes responseSchema and only sets mediaResolution for visual requests', () => {
  const textBody = OC.buildRequestBody('hola', null);
  assert.equal(textBody.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(plain(textBody.generationConfig.responseSchema), plain(OC.RESPONSE_SCHEMA));
  assert.equal(textBody.generationConfig.maxOutputTokens, OC.MAX_OUTPUT_TOKENS);
  assert.equal(textBody.generationConfig.mediaResolution, undefined);
  assert.equal(textBody.contents[0].parts.length, 1);

  const media = { images: [{ mimeType: 'image/png', data: 'AAAA' }], videos: [] };
  const visualBody = OC.buildRequestBody('mira', media);
  assert.equal(visualBody.generationConfig.mediaResolution, OC.MEDIA_RESOLUTION);
  assert.equal(visualBody.contents[0].parts.length, 2);
  assert.deepEqual(plain(visualBody.contents[0].parts[1]), { inlineData: { mimeType: 'image/png', data: 'AAAA' } });
});

test('buildEndpointUrl encodes the model name into the URL', () => {
  const url = OC.buildEndpointUrl('gemini 3.5/flash');
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini%203.5%2Fflash:generateContent');
});

test('describeGeminiHttpError maps 429 to an actionable Spanish message', () => {
  assert.match(OC.describeGeminiHttpError(429, ''), /limitando las solicitudes/);
  assert.equal(OC.describeGeminiHttpError(500, 'boom'), 'Gemini 500: boom');
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
