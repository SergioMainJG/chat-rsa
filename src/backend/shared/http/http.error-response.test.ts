import { expect, test } from 'bun:test';

import { ConflictError, TooManyRequestsError } from '../domain/app.error.ts';
import { errorResponse } from './http.error-response.ts';
import { PayloadTooLargeError } from './http.json-body.ts';

const request = new Request('http://localhost/api/x');

test('a 429 carries Retry-After in whole seconds', async () => {
  const response = errorResponse(request, new TooManyRequestsError('Too many requests', 7));

  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBe('7');
  expect(await response.json()).toMatchObject({ error: 'Too Many Requests', statusCode: 429 });
});

test('other errors carry no Retry-After', () => {
  const response = errorResponse(request, new ConflictError('x'));

  expect(response.headers.get('retry-after')).toBeNull();
  expect([...response.headers.keys()].toSorted()).toEqual(['content-type', 'x-correlation-id']);
});

test('a 413 is labelled Payload Too Large', async () => {
  const response = errorResponse(request, new PayloadTooLargeError('too big'));

  expect(await response.json()).toMatchObject({ error: 'Payload Too Large', statusCode: 413 });
});
