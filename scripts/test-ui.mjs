import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const checker = readFileSync(new URL('../checker.js', import.meta.url), 'utf8');
const inline = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];

class Element {
  constructor() {
    this.value = ''; this.children = []; this.listeners = {}; this.disabled = false;
    const classes = new Set();
    this.classList = { add: c => classes.add(c), remove: c => classes.delete(c),
      contains: c => classes.has(c), toggle: c => classes.has(c) ? classes.delete(c) : classes.add(c) };
  }
  set textContent(value) { this.text = value; this.children = []; }
  get textContent() { return this.text || ''; }
  set innerHTML(value) {
    this.markup = value;
    this.value = value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.append(child); }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  focus() {}
  click() {}
}

function setup({ endpoint = 'https://analysis.example/analyze', storageThrows = false, fetchImpl } = {}) {
  const elements = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(m => [m[1], new Element()]));
  const calls = []; const reads = []; const removals = [];
  class Reader {
    read(file, mode) {
      reads.push([file.name, mode]);
      queueMicrotask(() => {
        if (file.fail) { this.onerror(); return; }
        this.result = file.content;
        this.onload();
      });
    }
    readAsText(file) { this.read(file, 'text'); }
    readAsDataURL(file) { this.read(file, 'data'); }
  }
  const context = {
    document: { getElementById: id => elements[id], createElement: () => new Element() },
    ORTHOGRAPHY_RUNTIME_CONFIG: { analysisEndpoint: endpoint, driveImportEndpoint: 'https://drive.example/import' },
    FileReader: Reader, setTimeout, localStorage: {
      getItem() { throw new Error('Credentials must never be read'); },
      setItem() { throw new Error('Credentials must never be stored'); },
      removeItem(key) { removals.push(key); if (storageThrows) throw new Error('Storage blocked'); },
    },
    fetch: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return fetchImpl ? fetchImpl(url, options) : { ok: true, json: async () => ({ issues: [], extractedText: 'Texto leído', unreadableText: true, model: 'server/model' }) };
    },
    addEventListener() {},
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(checker, context);
  vm.runInContext(inline, context);
  return { elements, calls, reads, removals };
}
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
const image = (name = 'a.png') => ({ name, type: '', size: 3, content: 'data:application/octet-stream;base64,AAAA' });
function textTree(element) { return [element.textContent, element.markup || '', ...element.children.map(textTree)].join(' '); }

test('image uploads use Bearer access tokens, bypass extraction, and show incomplete visual results', async () => {
  const { elements, calls, reads, removals } = setup({ storageThrows: true });
  elements.key.value = 'access-token';
  elements.picker.onchange({ target: { files: [image()] } });
  await flush();
  assert.deepEqual(removals, ['orthography.geminiKey']);
  assert.deepEqual(reads, [['a.png', 'data']]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://analysis.example/analyze');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer access-token');
  assert.deepEqual(calls[0].body, { text: '', media: { images: [{ mimeType: 'image/png', data: 'AAAA' }], videos: [] } });
  const rendered = textTree(elements.cards);
  assert.match(rendered, /lectura incompleta/);
  assert.match(rendered, /Texto leído/);
  assert.doesNotMatch(rendered, /sin errores/);
  elements.forgetKey.onclick();
  assert.equal(elements.key.value, '');
  assert.equal(elements.run.disabled, true);
});

test('missing endpoint disables analysis and keeps a useful visible status', async () => {
  const { elements, calls } = setup({ endpoint: '' });
  elements.key.value = 'access-token';
  elements.key.listeners.input();
  elements.picker.onchange({ target: { files: [image()] } });
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(elements.run.disabled, true);
  assert.match(elements.keyStatus.textContent, /no está configurado/);
});

test('invalid and unreadable files remain visible while valid HTML completes the queue', async () => {
  const { elements, calls, reads } = setup();
  elements.key.value = 'access-token';
  elements.picker.onchange({ target: { files: [
    { name: 'a.png', type: 'image/jpeg', size: 3 },
    { name: 'b.html', size: 5 * 1024 * 1024 + 1 },
    { name: 'c.html', size: 3, fail: true },
    { name: 'd.html', size: 20, content: '<p>Oferta especial</p>' },
  ] } });
  await flush();
  assert.deepEqual(reads, [['c.html', 'text'], ['d.html', 'text']]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.text, 'Oferta especial');
  const rendered = textTree(elements.cards);
  assert.match(rendered, /no coincide/);
  assert.match(rendered, /5 MiB/);
  assert.match(rendered, /No se pudo leer/);
});

test('requests stay sequential and forgetting the token stops later paid requests', async () => {
  let finish;
  const { elements, calls } = setup({ fetchImpl: () => new Promise(resolve => { finish = resolve; }) });
  elements.key.value = 'access-token';
  elements.picker.onchange({ target: { files: [image('a.png'), image('b.png')] } });
  await flush();
  assert.equal(calls.length, 1);
  elements.forgetKey.onclick();
  finish({ ok: true, json: async () => ({ issues: [], extractedText: '', unreadableText: false, model: 'server/model' }) });
  await flush();
  assert.equal(calls.length, 1);
  assert.match(textTree(elements.cards), /sin revisar/);
});

test('sanitized service errors are visible and never marked as clean', async () => {
  const { elements } = setup({ fetchImpl: async () => ({ ok: false, json: async () => ({ error: { code: 'UNAUTHORIZED', message: 'Clave de acceso inválida.' } }) }) });
  elements.key.value = 'wrong-token';
  elements.picker.onchange({ target: { files: [image()] } });
  await flush();
  assert.match(textTree(elements.cards), /Clave de acceso inválida/);
  assert.doesNotMatch(textTree(elements.cards), /sin errores/);
});

test('Drive import UI and workflow remain identical to the existing implementation', () => {
  const baseline = execFileSync('git', ['show', 'HEAD:index.html'], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8',
  });
  const section = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  for (const [start, end] of [
    ['  <div class="drive"', '  <div class="drop"'],
    ['  function setImportStatus(', '  // ---- extracción del copy'],
    ['  fetchDriveBtn.onclick', '\n})();'],
  ]) assert.equal(section(html, start, end), section(baseline, start, end));
});
