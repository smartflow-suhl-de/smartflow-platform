import type { ErrorBody } from '../shared/contract.ts';

/**
 * An error with a stable machine code and an English message. Routes throw these;
 * one handler turns them into the shared error shape.
 */
export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly fields: Record<string, string>;
  readonly reason?: string;

  constructor(
    code: string,
    message: string,
    status = 400,
    options: { fields?: Record<string, string>; reason?: string } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.fields = options.fields ?? {};
    this.reason = options.reason;
  }

  toBody(): ErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(Object.keys(this.fields).length > 0 ? { fields: this.fields } : {}),
        ...(this.reason ? { reason: this.reason } : {}),
      },
    };
  }
}

export const notFound = (message = 'Not found.') => new AppError('not_found', message, 404);

export const unauthorized = (message = 'Anmeldung erforderlich.') =>
  new AppError('unauthorized', message, 401);

export const forbidden = (message = 'Forbidden.') => new AppError('forbidden', message, 403);

export const invalidState = (message: string) => new AppError('invalid_state', message, 409);

export const validationFailed = (fields: Record<string, string>) =>
  new AppError('validation_failed', 'Please check the highlighted fields.', 422, { fields });
