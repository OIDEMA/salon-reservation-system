import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { test } from 'node:test';
import { cleanHeaders, createRelayServer, EXPECTED_UPSTREAM, relayConfig } from './server.mjs';

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  return server.address().port;
}

function send(port, { method = 'GET', path = '/api/member/catalog', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = request({ hostname: '127.0.0.1', port, method, path, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on('error', reject);
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

async function fixture(t, handler, { maintenance = false, timeoutMs = 1_000 } = {}) {
  const calls = [];
  const backend = createServer((incoming, outgoing) => {
    const chunks = [];
    incoming.on('data', (chunk) => chunks.push(chunk));
    incoming.on('end', () => {
      const call = { method: incoming.method, path: incoming.url, headers: incoming.headers, body: Buffer.concat(chunks) };
      calls.push(call);
      handler(call, outgoing);
    });
  });
  const backendPort = await listen(t, backend);
  const optionsSeen = [];
  const relay = createRelayServer({ maintenance }, {
    timeoutMs,
    requestUpstream(options, callback) {
      optionsSeen.push(options);
      // Only the transport in this test points at loopback; production cannot
      // select this target through an environment variable or request header.
      return request({ ...options, protocol: 'http:', hostname: '127.0.0.1', port: backendPort }, callback);
    },
  });
  const port = await listen(t, relay);
  return { send: (options) => send(port, options), calls, optionsSeen };
}

test('configuration allows only the fixed HTTPS upstream and defaults to maintenance', () => {
  assert.deepEqual(relayConfig({ UPSTREAM_ORIGIN: EXPECTED_UPSTREAM }), { maintenance: true });
  assert.deepEqual(relayConfig({ UPSTREAM_ORIGIN: EXPECTED_UPSTREAM, MAINTENANCE_MODE: 'true' }), { maintenance: true });
  assert.deepEqual(relayConfig({ UPSTREAM_ORIGIN: EXPECTED_UPSTREAM, MAINTENANCE_MODE: 'false' }), { maintenance: false });
  for (const upstream of [undefined, '', 'http://127.0.0.1:8080', 'https://evil.example', `${EXPECTED_UPSTREAM}/`, `${EXPECTED_UPSTREAM}?target=evil`, `${EXPECTED_UPSTREAM}.evil.example`]) {
    assert.throws(() => relayConfig({ UPSTREAM_ORIGIN: upstream, MAINTENANCE_MODE: 'false' }));
  }
  for (const value of ['', '0', 'False', 'TRUE', 'disabled']) {
    assert.throws(() => relayConfig({ UPSTREAM_ORIGIN: EXPECTED_UPSTREAM, MAINTENANCE_MODE: value }));
  }
});

test('maintenance rejects every business method without making an upstream request', async (t) => {
  const api = await fixture(t, (_request, response) => response.end('must not be called'), { maintenance: true });
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    const response = await api.send({ method, path: '/api/member/reservations?view=current', body: ['POST', 'PUT', 'PATCH'].includes(method) ? '{"test":true}' : undefined });
    assert.equal(response.status, 503);
    assert.equal(response.headers['retry-after'], '60');
    assert.match(response.headers['cache-control'], /no-store/u);
    assert.equal(response.headers.location, undefined);
    if (method === 'HEAD') assert.equal(response.body.length, 0);
    else assert.equal(JSON.parse(response.body).code, 'MAINTENANCE');
  }
  assert.equal(api.calls.length, 0);
  assert.equal(api.optionsSeen.length, 0);
});

test('GET and HEAD local health remain available during maintenance', async (t) => {
  const api = await fixture(t, (_request, response) => response.end(), { maintenance: true });
  const get = await api.send({ path: '/health' });
  assert.equal(get.status, 200);
  assert.deepEqual(JSON.parse(get.body), { ok: true, service: 'reservation-api-relay', maintenance: true });
  const head = await api.send({ method: 'HEAD', path: '/health?probe=1' });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal((await api.send({ method: 'POST', path: '/health', body: '{}' })).status, 503);
  assert.equal((await api.send({ path: '/ready' })).status, 503);
  assert.equal(api.calls.length, 0);
});

test('forwarding preserves binary body, authorization, tenant headers, idempotency key, method and query', async (t) => {
  const binary = Buffer.from([0, 1, 2, 128, 255, 13, 10]);
  const api = await fixture(t, (call, response) => {
    response.writeHead(201, { 'content-type': 'application/octet-stream', 'x-request-id': 'test-response', 'set-cookie': ['a=1; HttpOnly', 'b=2; Secure'] });
    response.end(call.body);
  });
  const path = '/api/member/reservations?next=https%3A%2F%2Fevil.example&x=1&x=2&empty=';
  const response = await api.send({ method: 'POST', path, body: binary, headers: {
    authorization: 'Bearer synthetic-test-token', 'idempotency-key': '11111111-1111-4111-8111-111111111111',
    'x-tenant-slug': 'test-salon', 'x-salon-id': 'salon-1', 'content-type': 'application/octet-stream',
    'content-length': String(binary.length), host: 'attacker.example', 'x-forwarded-host': 'attacker.example',
  } });
  assert.equal(response.status, 201);
  assert.deepEqual(response.body, binary);
  assert.equal(response.headers['x-request-id'], 'test-response');
  assert.deepEqual(response.headers['set-cookie'], ['a=1; HttpOnly', 'b=2; Secure']);
  assert.equal(api.calls.length, 1);
  const call = api.calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.path, path);
  assert.deepEqual(call.body, binary);
  assert.equal(call.headers.authorization, 'Bearer synthetic-test-token');
  assert.equal(call.headers['idempotency-key'], '11111111-1111-4111-8111-111111111111');
  assert.equal(call.headers['x-tenant-slug'], 'test-salon');
  assert.equal(call.headers['x-salon-id'], 'salon-1');
  assert.equal(call.headers.host, new URL(EXPECTED_UPSTREAM).hostname);
  assert.equal(call.headers['x-forwarded-host'], undefined);
  assert.equal(call.headers['x-reservation-api-relay'], '1');
  assert.equal(api.optionsSeen[0].protocol, 'https:');
  assert.equal(api.optionsSeen[0].hostname, new URL(EXPECTED_UPSTREAM).hostname);
  assert.equal(api.optionsSeen[0].port, 443);
});

test('hop-by-hop and Connection-nominated headers are stripped in both directions', async (t) => {
  assert.deepEqual(cleanHeaders({ connection: 'X-Remove, KEEP-ALIVE', 'x-remove': 'secret', 'keep-alive': 'timeout=1', te: 'trailers', authorization: 'Bearer test', 'idempotency-key': 'key' }), {
    authorization: 'Bearer test', 'idempotency-key': 'key',
  });
  const api = await fixture(t, (_call, response) => {
    response.writeHead(200, { connection: 'X-Remove, close', 'x-remove': 'hidden', 'proxy-authenticate': 'Basic', 'x-retain': 'kept' });
    response.end('ok');
  });
  const response = await api.send({ headers: { connection: 'X-Remove, close', 'x-remove': 'hidden', te: 'trailers', 'proxy-authorization': 'Basic synthetic' } });
  assert.equal(api.calls[0].headers['x-remove'], undefined);
  assert.equal(api.calls[0].headers.te, undefined);
  assert.equal(api.calls[0].headers['proxy-authorization'], undefined);
  assert.equal(response.headers['x-remove'], undefined);
  assert.equal(response.headers['proxy-authenticate'], undefined);
  assert.equal(response.headers['x-retain'], 'kept');
});

test('leading double slash is a path on the fixed upstream and absolute-form targets are rejected', async (t) => {
  const api = await fixture(t, (_call, response) => response.end('ok'));
  const path = '//untrusted.example.invalid/api/member/catalog?x=a%2Fb';
  assert.equal((await api.send({ path })).status, 200);
  assert.equal(api.calls[0].path, path);
  assert.equal(api.optionsSeen[0].hostname, new URL(EXPECTED_UPSTREAM).hostname);
  for (const hostile of ['https://untrusted.example.invalid/api/member/catalog', '/\\untrusted.example.invalid/a', '/api/member/catalog#fragment']) {
    const response = await api.send({ path: hostile });
    assert.equal(response.status, 400);
  }
  assert.equal(api.calls.length, 1);
});

test('HEAD forwards upstream status and headers while returning no body', async (t) => {
  const api = await fixture(t, (_call, response) => {
    response.writeHead(200, { 'content-length': '123', 'content-type': 'application/json', 'x-upstream': 'yes' });
    response.end();
  });
  const response = await api.send({ method: 'HEAD', path: '/ready' });
  assert.equal(api.calls[0].method, 'HEAD');
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-length'], '123');
  assert.equal(response.headers['x-upstream'], 'yes');
  assert.equal(response.body.length, 0);
});

test('a request already relayed fails closed before another upstream hop', async (t) => {
  const api = await fixture(t, (_call, response) => response.end('must not be called'));
  const response = await api.send({ method: 'POST', headers: { 'x-reservation-api-relay': '1' }, body: '{}' });
  assert.equal(response.status, 502);
  assert.equal(JSON.parse(response.body).code, 'RELAY_LOOP_DETECTED');
  assert.equal(api.calls.length, 0);
  assert.equal(api.optionsSeen.length, 0);
});

test('API error responses are preserved without a retry', async (t) => {
  const api = await fixture(t, (_call, response) => {
    response.writeHead(409, { 'content-type': 'application/json', 'cache-control': 'private, no-store' });
    response.end('{"code":"IDEMPOTENCY_CONFLICT","message":"test"}');
  });
  const response = await api.send({ method: 'POST', body: '{}' });
  assert.equal(response.status, 409);
  assert.deepEqual(JSON.parse(response.body), { code: 'IDEMPOTENCY_CONFLICT', message: 'test' });
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.equal(api.calls.length, 1);
});

test('upstream redirects are rejected without forwarding Location or following them', async (t) => {
  const api = await fixture(t, (_call, response) => {
    response.writeHead(307, { location: 'https://untrusted.example.invalid/collect' });
    response.end();
  });
  const response = await api.send({ method: 'POST', headers: { authorization: 'Bearer synthetic-test-token' }, body: '{}' });
  assert.equal(response.status, 502);
  assert.equal(JSON.parse(response.body).code, 'UPSTREAM_REDIRECT_REJECTED');
  assert.equal(response.headers.location, undefined);
  assert.equal(api.calls.length, 1);
});

test('an upstream timeout returns 504 and never retries an uncertain mutation', async (t) => {
  const api = await fixture(t, () => {}, { timeoutMs: 30 });
  const response = await api.send({ method: 'POST', body: '{"test":true}' });
  assert.equal(response.status, 504);
  assert.equal(JSON.parse(response.body).code, 'UPSTREAM_TIMEOUT');
  assert.equal(api.calls.length, 1);
  assert.equal(api.optionsSeen.length, 1);
});

test('an upstream connection failure returns 502 without leaking diagnostics or retrying', async (t) => {
  const api = await fixture(t, (_call, response) => response.destroy());
  const response = await api.send({ method: 'POST', body: '{}' });
  assert.equal(response.status, 502);
  assert.equal(JSON.parse(response.body).code, 'UPSTREAM_CONNECTION_FAILED');
  assert.equal(api.calls.length, 1);
  assert.equal(api.optionsSeen.length, 1);
  assert.ok(!response.body.toString().includes('socket'));
});
