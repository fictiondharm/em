export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(message: string, details?: unknown): ApiError {
    return new ApiError(400, 'BAD_REQUEST', message, details);
  }

  /** The caller is known but not allowed to do this, e.g. a driver outside the ask list. */
  static forbidden(message: string, details?: unknown): ApiError {
    return new ApiError(403, 'FORBIDDEN', message, details);
  }

  static notFound(message: string): ApiError {
    return new ApiError(404, 'NOT_FOUND', message);
  }

  static conflict(message: string, details?: unknown): ApiError {
    return new ApiError(409, 'CONFLICT', message, details);
  }

  static unprocessable(message: string, details?: unknown): ApiError {
    return new ApiError(422, 'UNPROCESSABLE', message, details);
  }

  /**
   * A capability the PRD requires but this build has not implemented.
   *
   * Used for external integrations that are deliberately deferred. It exists so
   * the API fails loudly and honestly instead of 404-ing (looks like a typo) or
   * returning a fabricated success.
   */
  static notImplemented(message: string, details?: unknown): ApiError {
    return new ApiError(501, 'NOT_IMPLEMENTED', message, details);
  }
}
