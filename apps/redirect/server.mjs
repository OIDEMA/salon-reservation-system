import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export const EXPECTED_ORIGIN = 'https://salon-reserve-web-42401528382.asia-northeast1.run.app';

export function validateRedirectOrigin(value) {
  if (value !== EXPECTED_ORIGIN && value !== `${EXPECTED_ORIGIN}/`) {
    throw new Error('REDIRECT_ORIGIN must be the approved Tokyo Cloud Run origin');
  }
  return EXPECTED_ORIGIN;
}

// Never resolve an untrusted request target against the new origin: a target
// beginning with // would then be interpreted as a different hostname.
export function requestPath(target) {
  if (typeof target !== 'string' || /[\u0000-\u0020\u007f-\uffff#\\]/u.test(target)) {
    throw new Error('Invalid request target');
  }
  if (target.startsWith('/')) return target;
  if (/^https?:\/\//u.test(target)) {
    const parsed = new URL(target);
    return `${parsed.pathname}${parsed.search}`;
  }
  throw new Error('Invalid request target');
}

const commonHeaders = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
};

function json(response, status, value, head = false) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    ...commonHeaders,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  response.end(head ? undefined : body);
}

export function createRedirectServer({ redirectOrigin = process.env.REDIRECT_ORIGIN } = {}) {
  const origin = validateRedirectOrigin(redirectOrigin);
  return createServer((request, response) => {
    const head = request.method === 'HEAD';
    if (request.method !== 'GET' && !head) {
      json(response, 409, {
        code: 'SERVICE_MOVED',
        message: 'システムのURLが変更されました。新しいURLを開いて、もう一度操作してください。',
        newUrl: origin,
      });
      return;
    }

    let path;
    try {
      path = requestPath(request.url);
    } catch {
      json(response, 400, { code: 'INVALID_REQUEST_TARGET' }, head);
      return;
    }
    if (path.split('?', 1)[0] === '/healthz') {
      json(response, 200, { status: 'ok' }, head);
      return;
    }

    // Concatenation keeps even //example.com on the fixed destination host.
    // No fragment is supplied, so browsers retain fragments on existing links.
    response.writeHead(302, { ...commonHeaders, location: `${origin}${path}` });
    response.end();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? '8080');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  createRedirectServer().listen(port, '0.0.0.0', () => {
    console.log(`Redirect service listening on port ${port}`);
  });
}
