// The shared error format's status titles, as src/backend/shared/http/http.error-response.ts
// renders them. Lives in test/load because the k6 container only mounts this directory;
// test/load/auth.load.error-shape.sabotage.test.ts pins it to the server's real output.

export const STATUS_TEXT: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  409: 'Conflict',
  415: 'Unsupported Media Type',
  429: 'Too Many Requests',
};
