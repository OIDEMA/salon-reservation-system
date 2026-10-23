import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { pathToFileURL } from 'node:url';

export const EXPECTED_UPSTREAM = 'https://reservation-api-42401528382.asia-northeast1.run.app';
const upstreamHost = new URL(EXPECTED_UPSTREAM).hostname;
const hopByHop = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

export function relayConfig(env = process.env) {
  if (env.UPSTREAM_ORIGIN !== EXPECTED_UPSTREAM) {
    throw new Error('UPSTREAM_ORIGIN must be the approved Tokyo API origin');
  }
  if (env.MAINTENANCE_MODE !== undefined && !['true', 'false'].includes(env.MAINTENANCE_MODE)) {
    throw new Error('MAINTENANCE_MODE must be true or false');
  }
  return { maintenance: env.MAINTENANCE_MODE !== 'false' };
}

export function cleanHeaders(headers) {
  const connection = headers.connection;
  const named = new Set((Array.isArray(connection) ? connection.join(',') : connection ?? '')
    .split(',').map((name) => name.trim().toLowerCase()).filter(Boolean));
  return Object.fromEntries(Object.entries(headers).filter(([name, value]) =>
    value !== undefined && !hopByHop.has(name.toLowerCase()) && !named.has(name.toLowerCase())));
}

function validRequestTarget(target) {
  // Pass only origin-form paths to a hostname fixed independently below. In
  // particular, //foo remains a path and can never select a different upstream.
  return typeof target === 'string' && target.startsWith('/') && !/[\u0000-\u0020\u007f-\uffff#\\]/u.test(target);
}

function json(response, status, body, { head = false, headers = {} } = {}) {
  const content = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(content),
    'cache-control': 'private, no-store',
    pragma: 'no-cache',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  response.end(head ? undefined : content);
}

/** Transport injection is for local tests only; the CLI always uses HTTPS. */
export function createRelayServer(config, { requestUpstream = httpsRequest, timeoutMs = 60_000 } = {}) {
  if (typeof config?.maintenance !== 'boolean') throw new Error('A validated maintenance configuration is required');
  return createServer((incoming, outgoing) => {
    const head = incoming.method === 'HEAD';
    if (!validRequestTarget(incoming.url)) {
      json(outgoing, 400, { code: 'INVALID_REQUEST_TARGET' }, { head });
      return;
    }
    if (['GET', 'HEAD'].includes(incoming.method) && incoming.url.split('?', 1)[0] === '/health') {
      json(outgoing, 200, { ok: true, service: 'reservation-api-relay', maintenance: config.maintenance }, { head });
      return;
    }
    if (config.maintenance) {
      json(outgoing, 503, {
        code: 'MAINTENANCE',
        message: 'システムの切り替え作業中です。少し時間をおいて、もう一度お試しください。',
      }, { head, headers: { 'retry-after': '60' } });
      return;
    }
    if (incoming.headers['x-reservation-api-relay'] !== undefined) {
      json(outgoing, 502, { code: 'RELAY_LOOP_DETECTED' }, { head });
      return;
    }

    const headers = cleanHeaders(incoming.headers);
    // Host and routing headers from a client cannot influence the upstream URL.
    headers.host = upstreamHost;
    delete headers.forwarded;
    delete headers['x-forwarded-host'];
    delete headers['x-forwarded-proto'];
    delete headers['x-forwarded-port'];
    headers['x-reservation-api-relay'] = '1';

    let upstream;
    let timeout;
    let finished = false;
    function fail(status, code) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (!outgoing.headersSent) json(outgoing, status, { code, message: '予約サーバーに接続できません。結果を確認してから、もう一度お試しください。' }, { head });
      else outgoing.destroy();
      upstream?.destroy();
    }
    try {
      // Do not retry: a failed connection can have an unknown mutation outcome.
      upstream = requestUpstream({
        protocol: 'https:', hostname: upstreamHost, port: 443,
        method: incoming.method, path: incoming.url, headers,
      }, (response) => {
        if (finished) { response.destroy(); return; }
        const status = response.statusCode ?? 502;
        // The API contract is direct JSON/binary responses. Never follow or emit
        // an upstream redirect that could move credentials to another origin.
        if (status >= 300 && status < 400 && status !== 304) {
          response.destroy();
          fail(502, 'UPSTREAM_REDIRECT_REJECTED');
          return;
        }
        outgoing.writeHead(status, cleanHeaders(response.headers));
        response.on('error', () => fail(502, 'UPSTREAM_CONNECTION_FAILED'));
        response.on('aborted', () => fail(502, 'UPSTREAM_CONNECTION_FAILED'));
        response.on('end', () => { finished = true; clearTimeout(timeout); });
        response.pipe(outgoing);
      });
      upstream.on('error', () => fail(502, 'UPSTREAM_CONNECTION_FAILED'));
      timeout = setTimeout(() => fail(504, 'UPSTREAM_TIMEOUT'), timeoutMs);
      incoming.on('aborted', () => { finished = true; clearTimeout(timeout); upstream.destroy(); });
      incoming.on('error', () => fail(400, 'INCOMPLETE_REQUEST'));
      outgoing.on('close', () => {
        if (!outgoing.writableFinished) { finished = true; clearTimeout(timeout); upstream.destroy(); }
      });
      incoming.pipe(upstream);
    } catch {
      fail(502, 'UPSTREAM_CONNECTION_FAILED');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = relayConfig();
  const port = Number(process.env.PORT ?? '8080');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535');
  createRelayServer(config).listen(port, '0.0.0.0', () => {
    console.log(`API relay listening on port ${port}; maintenance=${config.maintenance}`);
  });
}
