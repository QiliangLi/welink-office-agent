import { validate } from './schemas/common.mjs';
import { toApiError } from './middleware/error-handler.mjs';
import { readJsonBody, assertSameOriginAndCsrf } from './middleware/request-context.mjs';

/**
 * Route descriptors registered by the modules in routes/. The router owns
 * request ids, JSON body parsing, the local-first origin/CSRF boundary,
 * the unified idempotency layer and the stable error envelope; handlers
 * stay free of HTTP plumbing.
 */

export function createRouter(context) {
  const routes = [];
  const register = (method, pattern, handler, options = {}) => {
    routes.push({
      id: `${method} ${pattern}`,
      method,
      pattern,
      keys: patternKeys(pattern),
      regex: patternRegex(pattern),
      handler,
      options
    });
  };

  const registerAll = (module) => module.register(register, context);

  return {
    routes,
    register,
    registerAll,
    async handle(req, res) {
      const url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);
      const pathname = url.pathname;
      const requestId = context.makeRequestId();

      try {
        const matched = routes.find((route) => route.method === req.method && route.regex.test(pathname));
        if (!matched) {
          const error = toApiError(Object.assign(new Error('接口不存在。'), { status: 404, code: 'NOT_FOUND' }));
          sendJson(res, error.status, { error: errorBody(error), requestId }, requestId);
          return;
        }

        const params = extractParams(matched, pathname);
        const query = Object.fromEntries(url.searchParams.entries());
        const repeat = (name) => url.searchParams.getAll(name);

        if (matched.options.querySchema) {
          validate(matched.options.querySchema, query, 'query');
        }

        let body = {};
        if (req.method === 'POST') {
          body = await readJsonBody(req);
          if (matched.options.schema) validate(matched.options.schema, body, 'body');
          if (!matched.options.skipCsrf) assertSameOriginAndCsrf(req, context);
        }

        // Unified persistent idempotency: same key + same target/body
        // replays the first response; same key with different input is a
        // 409. The placeholder prevents concurrent duplicate execution and
        // distinguishes "never started" (safe takeover) from "outcome
        // unknown" (typed conflict, query the aggregate instead).
        let idempotencyKey = null;
        let idempotencyRecordKey = null;
        let idempotencyAttemptId = null;
        if (req.method === 'POST' && !matched.options.skipIdempotency) {
          const clientKey = req.headers['idempotency-key'];
          if (typeof clientKey !== 'string' || clientKey.length < 8) {
            throw toApiError(Object.assign(new Error('缺少 Idempotency-Key 请求头。'), { status: 400, code: 'VALIDATION_ERROR' }));
          }
          const { replay, key, attemptId } = await context.idempotencyService.begin({
            route: matched.id,
            key: clientKey,
            pathname,
            body
          });
          if (replay) {
            sendJson(res, replay.statusCode, replay.response, requestId);
            return;
          }
          idempotencyKey = clientKey;
          idempotencyRecordKey = key;
          idempotencyAttemptId = attemptId;
        }

        // Capture the response instead of sending it: the idempotency
        // record must be completed BEFORE the client can see the reply,
        // otherwise an immediate replay would race the record and be
        // misjudged as "outcome unknown" (review T-01).
        let captured = null;
        const reply = (status, data) => {
          captured = { status, data };
        };

        try {
          if (idempotencyRecordKey) {
            await context.idempotencyService.markRunning(idempotencyRecordKey, idempotencyAttemptId);
          }
          await matched.handler({ req, res, params, query, repeat, body, requestId, reply, context, idempotencyKey });
          if (!captured) {
            // Handler produced no reply — fail the idempotency attempt and
            // answer with a stable error instead of leaving the socket open.
            if (idempotencyRecordKey) await context.idempotencyService.fail(idempotencyRecordKey, idempotencyAttemptId);
            const noReply = toApiError(Object.assign(new Error('处理器未返回响应。'), { status: 500, code: 'INTERNAL_ERROR' }));
            sendJson(res, noReply.status, { error: errorBody(noReply), requestId }, requestId);
            return;
          }
          if (idempotencyRecordKey) {
            await context.idempotencyService.complete(idempotencyRecordKey, captured.status, captured.data ?? null);
          }
          sendJson(res, captured.status, captured.data, requestId);
        } catch (handlerError) {
          if (idempotencyRecordKey) await context.idempotencyService.fail(idempotencyRecordKey, idempotencyAttemptId);
          throw handlerError;
        }
      } catch (error) {
        const apiError = toApiError(error);
        if (apiError.status >= 500) {
          console.error(`[console-api] ${requestId}`, error);
        }
        sendJson(res, apiError.status, { error: errorBody(apiError), requestId }, requestId);
      }
    }
  };
}

export function sendJson(res, status, data, requestId) {
  const payload = requestId && data && typeof data === 'object' && data.requestId === undefined
    ? { ...data, requestId }
    : data;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function errorBody(error) {
  return {
    code: error.code ?? 'INTERNAL_ERROR',
    message: error.message ?? '服务器内部错误。',
    retryable: Boolean(error.retryable),
    details: error.details ?? null
  };
}

function patternKeys(pattern) {
  const keys = [];
  pattern.split('/').forEach((segment, index) => {
    if (segment.startsWith(':')) keys.push({ name: segment.slice(1), index });
  });
  return keys;
}

function patternRegex(pattern) {
  const source = pattern
    .split('/')
    .map((segment) => (segment.startsWith(':') ? `[^/]+` : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${source}$`);
}

function extractParams(matched, pathname) {
  const values = pathname.split('/');
  const params = {};
  for (const { name, index } of matched.keys) {
    params[name] = decodeURIComponent(values[index] ?? '');
  }
  return params;
}
