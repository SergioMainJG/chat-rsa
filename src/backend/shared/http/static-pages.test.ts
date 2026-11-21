import { describe, expect, test } from 'bun:test';

import { negotiateEncoding } from './static-pages.ts';

describe('negotiateEncoding', () => {
  test('prefers brotli over gzip', () => {
    expect(negotiateEncoding('gzip, deflate, br, zstd')).toBe('br');
  });

  test('falls back to gzip without brotli', () => {
    expect(negotiateEncoding('gzip, deflate')).toBe('gzip');
  });

  test('skips an encoding refused with q=0', () => {
    expect(negotiateEncoding('br;q=0, gzip;q=0.8')).toBe('gzip');
    expect(negotiateEncoding('br;q=0, gzip; q=0')).toBe('identity');
  });

  test('ignores case and spacing', () => {
    expect(negotiateEncoding(' GZIP ;q=1 ')).toBe('gzip');
  });

  test('answers identity without a header or a known encoding', () => {
    expect(negotiateEncoding(null)).toBe('identity');
    expect(negotiateEncoding('deflate')).toBe('identity');
  });
});
