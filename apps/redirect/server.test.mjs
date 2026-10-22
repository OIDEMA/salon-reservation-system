import assert from 'node:assert/strict';
import { request } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createRedirectServer, EXPECTED_ORIGIN, requestPath, validateRedirectOrigin } from './server.mjs';

async function withServer(t) {
  const server = createRedirectServer({ redirectOrigin: EXPECTED_ORIGIN });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return ({ method = 'GET', path = '/', host = 'old.example' } = {}) => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, method, path, headers: { host } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

test('only the approved HTTPS origin can be configured', () => {
  assert.equal(validateRedirectOrigin(EXPECTED_ORIGIN), EXPECTED_ORIGIN);
  assert.equal(validateRedirectOrigin(`${EXPECTED_ORIGIN}/`), EXPECTED_ORIGIN);
  for (const value of [undefined, '', 'https://evil.example', EXPECTED_ORIGIN.replace('https:', 'http:'), `${EXPECTED_ORIGIN}.evil.example`, `${EXPECTED_ORIGIN}/login`, `${EXPECTED_ORIGIN}?q=1`, `${EXPECTED_ORIGIN}#token=1`]) {
    assert.throws(() => validateRedirectOrigin(value));
  }
});

test('GET preserves the encoded path, repeated query parameters and empty values', async (t) => {
  const send = await withServer(t);
  const path = '/mens-gentle/invitations/accept?token=a%2Fb%2Bc&x=1&x=2&empty=&next=https%3A%2F%2Fevil.example';
  const response = await send({ path });
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, `${EXPECTED_ORIGIN}${path}`);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.ok(!response.headers.location.includes('#'), 'Location must allow the browser to inherit the original fragment');
});

test('HEAD returns the same redirect without a response body', async (t) => {
  const send = await withServer(t);
  const response = await send({ method: 'HEAD', path: '/login?next=%2Fcalendar' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, `${EXPECTED_ORIGIN}/login?next=%2Fcalendar`);
  assert.equal(response.body, '');
});

test('hostile Host headers and network-path targets cannot change the destination origin', async (t) => {
  const send = await withServer(t);
  for (const path of ['//evil.example/steal?x=1', '///evil.example', '/%2f%2fevil.example', '/%5cevil.example', '/login?next=//evil.example', '/%0d%0aLocation:%20https://evil.example']) {
    const response = await send({ path, host: 'evil.example' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.location, `${EXPECTED_ORIGIN}${path}`);
    assert.equal(new URL(response.headers.location).origin, EXPECTED_ORIGIN);
  }
});

test('absolute-form HTTP requests use only their path and query', async (t) => {
  const send = await withServer(t);
  for (const path of ['https://evil.example/calendar?date=2026-10-22', 'http://evil.example/calendar?date=2026-10-22']) {
    const response = await send({ path });
    assert.equal(response.status, 302);
    assert.equal(response.headers.location, `${EXPECTED_ORIGIN}/calendar?date=2026-10-22`);
  }
});

test('invalid request targets are rejected instead of becoming Location headers', async (t) => {
  for (const path of ['*', 'calendar', '/a\r\nLocation: https://evil.example', '/a#fragment', '/\\evil.example', 'ftp://evil.example/calendar', 'https://']) {
    assert.throws(() => requestPath(path));
  }
  const send = await withServer(t);
  const response = await send({ path: '/a#fragment' });
  assert.equal(response.status, 400);
  assert.equal(response.headers.location, undefined);
});

test('mutations and other methods are never redirected or relayed', async (t) => {
  const send = await withServer(t);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const response = await send({ method, path: '/api/backend/reservations?next=//evil.example' });
    assert.equal(response.status, 409);
    assert.equal(response.headers.location, undefined);
    assert.equal(response.headers['cache-control'], 'no-store');
    const body = JSON.parse(response.body);
    assert.equal(body.code, 'SERVICE_MOVED');
    assert.equal(body.newUrl, EXPECTED_ORIGIN);
    assert.match(body.message, /新しいURL/u);
  }
});

test('health checks work for GET and HEAD while mutations remain rejected', async (t) => {
  const send = await withServer(t);
  const get = await send({ path: '/healthz' });
  assert.equal(get.status, 200);
  assert.deepEqual(JSON.parse(get.body), { status: 'ok' });
  assert.equal(get.headers.location, undefined);
  const head = await send({ method: 'HEAD', path: '/healthz?probe=1' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  const post = await send({ method: 'POST', path: '/healthz' });
  assert.equal(post.status, 409);
});
