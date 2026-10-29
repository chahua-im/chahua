import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createServer as createViteServer } from 'vite';

const hash = (text) => createHash('sha256').update(text).digest('hex');
const hmac = (key, text) => createHmac('sha256', key).update(text).digest();
const encode = (value) =>
  encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// Verify SigV4 against the actual method, raw path, query and headers received by storage.
function signature(path, headers) {
  const url = new URL(path, 'http://storage.invalid');
  const query = [...url.searchParams]
    .filter(([key]) => key !== 'X-Amz-Signature')
    .map(([key, value]) => `${encode(key)}=${encode(value)}`)
    .sort()
    .join('&');
  const signedHeaders = url.searchParams.get('X-Amz-SignedHeaders');
  const canonicalHeaders = signedHeaders
    .split(';')
    .map((name) => `${name}:${headers[name]}\n`)
    .join('');
  const canonical = ['PUT', url.pathname, query, canonicalHeaders, signedHeaders, 'UNSIGNED-PAYLOAD'].join('\n');
  const date = url.searchParams.get('X-Amz-Date');
  const scope = `${date.slice(0, 8)}/us-west-2/s3/aws4_request`;
  const key = ['us-west-2', 's3', 'aws4_request'].reduce(hmac, hmac('AWS4test-secret', date.slice(0, 8)));
  return hmac(key, `AWS4-HMAC-SHA256\n${date}\n${scope}\n${hash(canonical)}`).toString('hex');
}

test('storage proxy preserves signed PUTs and media reads through either browser host', async (t) => {
  const requests = [];
  const storage = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      method: request.method,
      path: request.url,
      headers: request.headers,
      body: Buffer.concat(chunks).toString(),
    });
    if (request.method === 'PUT') {
      const valid =
        new URL(request.url, 'http://storage.invalid').searchParams.get('X-Amz-Signature') ===
        signature(request.url, request.headers);
      response.writeHead(valid ? 200 : 403).end();
    } else {
      response.writeHead(206, { 'Content-Range': 'bytes 0-3/10', ETag: '"test-etag"' }).end('test');
    }
  });
  storage.listen(0, '127.0.0.1');
  await once(storage, 'listening');
  t.after(() => new Promise((done) => storage.close(done)));
  const endpoint = `http://127.0.0.1:${storage.address().port}`;
  const oldEnv = {
    API_PROXY_TARGET: process.env.API_PROXY_TARGET,
    STORAGE_PROXY_TARGET: process.env.STORAGE_PROXY_TARGET,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.API_PROXY_TARGET = endpoint;
  process.env.STORAGE_PROXY_TARGET = endpoint;
  const { default: proxy } = await import('../proxy.conf.dev.mjs?local');
  const root = mkdtempSync(join(tmpdir(), 'chahua-storage-proxy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const vite = await createViteServer({
    configFile: false,
    root,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, proxy, ws: false },
  });
  t.after(() => vite.close());
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  const body = 'test-image';
  const headers = {
    host: new URL(endpoint).host,
    'cache-control': 'public,max-age=31536000,immutable',
    'content-length': String(Buffer.byteLength(body)),
    'content-type': 'image/webp',
    'x-amz-acl': 'public-read',
  };
  const query = new URLSearchParams({
    'x-id': 'PutObject',
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': 'test-access/20261029/us-west-2/s3/aws4_request',
    'X-Amz-Date': '20261029T032445Z',
    'X-Amz-Expires': '900',
    'X-Amz-SignedHeaders': Object.keys(headers).sort().join(';'),
  });
  const path = `/local-bucket/attachments/a%20b%2B%25.webp?${query}`;
  const signedPath = `${path}&X-Amz-Signature=${signature(path, headers)}`;
  for (const host of ['192.0.2.10:14443', '198.51.100.20:14443']) {
    const upload = await fetch(`${origin}/_storage${signedPath}`, {
      method: 'PUT',
      body,
      headers: { ...headers, host, cookie: 'token=private', authorization: 'Bearer private' },
    });
    assert.equal(upload.status, 200);
    assert.equal(requests.at(-1).path, signedPath);
    assert.equal(requests.at(-1).headers.host, headers.host);
    assert.equal(requests.at(-1).headers.cookie, undefined);
    assert.equal(requests.at(-1).headers.authorization, undefined);
    assert.equal(requests.at(-1).body, body);
    const download = await fetch(`${origin}/_storage/local-bucket/attachments/photo.webp`, {
      headers: { host, range: 'bytes=0-3' },
    });
    assert.equal(download.status, 206);
    assert.equal(download.headers.get('content-range'), 'bytes 0-3/10');
    assert.equal(download.headers.get('etag'), '"test-etag"');
    assert.equal(await download.text(), 'test');
    assert.equal(requests.at(-1).headers.range, 'bytes=0-3');
  }
  process.env.STORAGE_PROXY_TARGET = '';
  const { default: online } = await import('../proxy.conf.dev.mjs?online');
  assert.equal(online['^/_storage/'], undefined);
});
