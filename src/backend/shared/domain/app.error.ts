import type { FieldError } from '../../../shared/contracts/error.contract.ts';

/** Base for every error the HTTP layer knows how to render. */
export abstract class AppError extends Error {
  readonly errors: readonly FieldError[] = [];
  abstract readonly statusCode: number;

  constructor(message: string) {
    super(message);
    this.name = 'AppError';
  }
}

export class BadRequestError extends AppError {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}

export class ConflictError extends AppError {
  readonly statusCode = 409;

  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

export class ForbiddenError extends AppError {
  readonly statusCode = 403;

  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export class InternalServerError extends AppError {
  readonly statusCode = 500;

  constructor(message = 'An unexpected error occurred') {
    super(message);
    this.name = 'InternalServerError';
  }
}

export class NotFoundError extends AppError {
  readonly statusCode = 404;

  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class TooManyRequestsError extends AppError {
  readonly statusCode = 429;

  constructor(
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super(message);
    this.name = 'TooManyRequestsError';
  }
}

export class UnauthorizedError extends AppError {
  readonly statusCode = 401;

  constructor(message: string) {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export class UnsupportedMediaTypeError extends AppError {
  readonly statusCode = 415;

  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedMediaTypeError';
  }
}

export class ValidationError extends AppError {
  override readonly errors: readonly FieldError[];
  readonly statusCode = 400;

  constructor(errors: readonly FieldError[], message = 'Validation failed') {
    super(message);
    this.name = 'ValidationError';
    this.errors = errors;
  }
}
