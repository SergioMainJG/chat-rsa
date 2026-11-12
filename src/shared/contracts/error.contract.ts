export type ErrorResponse = {
  readonly correlationId: string;
  readonly error: string;
  readonly errors?: readonly FieldError[];
  readonly message: string;
  readonly path: string;
  readonly statusCode: number;
  readonly timestamp: string;
};

export type FieldError = {
  readonly field: string;
  readonly message: string;
};
