/**
 * HTTP error with the stable wire shape documented in
 * docs/frontend-backend-integration.md §10. The error handler never leaks
 * stack traces, local paths or CLI stderr into responses.
 */
export class ApiError extends Error {
  constructor(status, code, message, { details = null, retryable = false } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryable = retryable;
  }
}

export function validationError(message, details = null) {
  return new ApiError(400, 'VALIDATION_ERROR', message, { details, retryable: false });
}

export function notFoundError(code, message) {
  return new ApiError(404, code, message, { retryable: false });
}

export function conflictError(code, message, details = null) {
  return new ApiError(409, code, message, { details, retryable: false });
}

export function internalError(message = '服务器内部错误，请稍后重试。') {
  return new ApiError(500, 'INTERNAL_ERROR', message, { retryable: false });
}

const STATUS_TO_CODE = {
  INVALID_STATE_TRANSITION: 409,
  REVISION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  REMINDER_NOT_DUE: 409,
  REMINDER_LIMIT_REACHED: 409,
  CONTACT_NOT_CONFIGURED: 422,
  AUTO_CONTACT_DISABLED: 422,
  GROUP_NOT_TRUSTED: 422
};

/** Map runtime errors (already tagged with .code) onto the HTTP contract. */
export function toApiError(error) {
  if (error instanceof ApiError) return error;
  if (error?.code && STATUS_TO_CODE[error.code]) {
    return new ApiError(STATUS_TO_CODE[error.code], error.code, error.message, {
      details: error.details ?? null,
      retryable: false
    });
  }
  if (error?.code === 'ENOTFOUND' || error?.code === 'EACCES') {
    return new ApiError(500, 'INTERNAL_ERROR', '服务器内部错误，请稍后重试。');
  }
  return internalError();
}
