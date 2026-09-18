import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const files = {
  '/index.html': 'index.html',
  '/runtime-config.js': 'runtime-config.js',
};

const server = createServer(async (request, response) => {
  const file = files[new URL(request.url, 'http://localhost').pathname];
  if (!file) {
    response.writeHead(404).end();
    return;
  }

  response.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : 'text/html' });
  response.end(await readFile(new URL(`../${file}`, import.meta.url)));
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

try {
  const headers = await readFile(new URL('../_headers', import.meta.url), 'utf8');
  if (!/\/runtime-config\.js\s*\n\s+Cache-Control:\s*no-store/.test(headers)) {
    throw new Error('_headers must prevent browser caching for runtime-config.js');
  }

  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  const index = await (await fetch(`${origin}/index.html`)).text();
  const match = index.match(/<script\s+src="([^"]*runtime-config\.js[^"]*)"><\/script>/i);
  if (!match) throw new Error('index.html does not load runtime-config.js');

  const configSource = await (await fetch(new URL(match[1], `${origin}/index.html`))).text();
  const window = {};
  vm.runInNewContext(configSource, { window });
  const endpoint = window.ORTHOGRAPHY_RUNTIME_CONFIG?.driveImportEndpoint;
  const parsed = new URL(endpoint);
  if (parsed.protocol !== 'https:' || parsed.pathname !== '/import') {
    throw new Error('runtime-config.js does not expose a valid HTTPS /import endpoint');
  }

  console.log(`runtime config loaded: ${endpoint}`);
} finally {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
