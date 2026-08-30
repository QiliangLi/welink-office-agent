import crypto from 'node:crypto';
import { ApiError, validationError } from './error-handler.mjs';

export function makeRequestId() {
  return `REQ-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

export function makeCsrfToken() {
  return crypto.randomBytes(24).toString('base64url');
}

/**
 * Parse a JSON request body with a strict size limit. Empty bodies resolve
 * to an empty object so DELETE-like POSTs stay simple.
 */
export function readJsonBody(req, { limitBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new ApiError(413, 'VALIDATION_ERROR', '请求体过大。'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(validationError('请求体不是有效的 JSON。'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Local-first network boundary (docs §11.1): same-origin writes only, CSRF
 * token on every mutating request. Requests without an Origin header
 * (curl, tests, CLI tooling on the same machine) are still accepted because
 * the server only listens on 127.0.0.1.
 */
export function assertSameOriginAndCsrf(req, { csrfToken }) {
  const origin = req.headers.origin;
  if (origin) {
    const host = req.headers.host ?? '';
    let originHost = '';
    try {
      originHost = new URL(origin).host;
    } catch {
      throw new ApiError(403, 'VALIDATION_ERROR', '请求来源不合法。');
    }
    if (host && originHost !== host) {
      throw new ApiError(403, 'VALIDATION_ERROR', '请求来源与 API 地址不一致。');
    }
  }
  const token = req.headers['x-csrf-token'];
  if (!token || token !== csrfToken) {
    throw new ApiError(403, 'VALIDATION_ERROR', '缺少有效的 CSRF 令牌，请刷新页面后重试。');
  }
}
