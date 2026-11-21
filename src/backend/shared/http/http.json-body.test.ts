import { describe, expect, test } from 'bun:test';

import { BadRequestError, UnsupportedMediaTypeError, ValidationError } from '../domain/app.error.ts';
import { MAX_JSON_BODY_BYTES, PayloadTooLargeError, readJsonObject, readQuery } from './http.json-body.ts';

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

function post(body: BodyInit, contentType = 'application/json'): Request {
  return new Request('http://localhost/api/x', {
    body,
    headers: { 'content-type': contentType },
    method: 'POST',
  });
}

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

describe('readJsonObject', () => {
  test('returns the object when every key is allowed', async () => {
    expect(
      await readJsonObject(post('{"name":"a"}', 'Application/JSON; charset=utf-8'), ['memberIds', 'name']),
    ).toEqual({
      name: 'a',
    });
  });

  test('rejects a media type other than application/json with 415', async () => {
    const error = await failureOf(readJsonObject(post('{}', 'text/plain'), []));
    expect(error).toBeInstanceOf(UnsupportedMediaTypeError);
    expect(error).toMatchObject({ message: 'Content-Type must be application/json', statusCode: 415 });
  });

  test('rejects a body over 64 KiB with 413', async () => {
    const big = JSON.stringify({ name: 'x'.repeat(MAX_JSON_BODY_BYTES) });
    const error = await failureOf(readJsonObject(post(big), ['name']));
    expect(MAX_JSON_BODY_BYTES).toBe(64 * 1024);
    expect(error).toBeInstanceOf(PayloadTooLargeError);
    expect(error).toMatchObject({ message: 'Request body must be at most 65536 bytes', statusCode: 413 });
  });

  test('rejects a declared Content-Length over 64 KiB before reading the body', async () => {
    const request = new Request('http://localhost/api/x', {
      body: '{}',
      headers: { 'content-length': String(MAX_JSON_BODY_BYTES + 1), 'content-type': 'application/json' },
      method: 'POST',
    });
    const error = await failureOf(readJsonObject(request, []));
    expect(error).toBeInstanceOf(PayloadTooLargeError);
    expect(error).toMatchObject({ message: 'Request body must be at most 65536 bytes', statusCode: 413 });
  });

  test('accepts a body of exactly 64 KiB that declares its length', async () => {
    const name = 'x'.repeat(MAX_JSON_BODY_BYTES - '{"name":""}'.length);
    const body = JSON.stringify({ name });
    expect(body.length).toBe(MAX_JSON_BODY_BYTES);
    const request = new Request('http://localhost/api/x', {
      body,
      headers: { 'content-length': String(body.length), 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(await readJsonObject(request, ['name'])).toEqual({ name });
  });

  test('rejects a streamed body over 64 KiB that declares no length', async () => {
    const chunk = new Uint8Array(MAX_JSON_BODY_BYTES / 2);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
    });
    const error = await failureOf(readJsonObject(post(stream), []));
    expect(error).toBeInstanceOf(PayloadTooLargeError);
  });

  test.each([['[1]'], ['null'], ['"text"'], ['3']])('rejects the non-object body %p with 400', async (raw) => {
    const error = await failureOf(readJsonObject(post(raw), []));
    expect(error).toBeInstanceOf(BadRequestError);
    expect(error).toMatchObject({ message: 'Request body must be a JSON object', statusCode: 400 });
  });

  test('rejects malformed JSON with 400', async () => {
    const error = await failureOf(readJsonObject(post('{oops'), []));
    expect(error).toMatchObject({ message: 'Request body must be valid JSON', statusCode: 400 });
  });

  test('rejects unknown keys, listing each one', async () => {
    const error = await failureOf(readJsonObject(post('{"name":"a","admin":true,"__proto__":{}}'), ['name']));
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({
      errors: [
        { field: 'admin', message: 'Unknown field' },
        { field: '__proto__', message: 'Unknown field' },
      ],
      statusCode: 400,
    });
  });
});

describe('readQuery', () => {
  test('returns the allowed parameters', () => {
    expect(readQuery(new URL('http://localhost/x?limit=5&before=b'), ['before', 'limit'])).toEqual({
      before: 'b',
      limit: '5',
    });
  });

  test('rejects unknown parameters', () => {
    const error = thrownBy(() => readQuery(new URL('http://localhost/x?limit=5&debug=1'), ['limit']));
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({ errors: [{ field: 'debug', message: 'Unknown field' }] });
  });

  test('rejects repeated parameters', () => {
    const error = thrownBy(() => readQuery(new URL('http://localhost/x?limit=5&limit=6'), ['limit']));
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({ errors: [{ field: 'limit', message: 'Repeated field' }] });
  });
});
