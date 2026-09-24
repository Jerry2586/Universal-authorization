export function securityHeaders(contentType = 'application/json; charset=utf-8') {
  return {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  };
}

export function createJsonResponder(requestId) {
  return function respondJson(response, status, body, headers = {}) {
    const encoded = Buffer.from(JSON.stringify(body));
    response.writeHead(status, {
      ...securityHeaders(),
      'content-length': encoded.length,
      'x-request-id': requestId,
      ...headers,
    });
    response.end(encoded);
  };
}
