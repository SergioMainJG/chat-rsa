import { describe, expect, test } from 'bun:test';

import { DEFAULT_LOCALE, isLocale, localeOfPath, localePath, negotiateLocale } from './i18n.locale.ts';

describe('localePath', () => {
  test('puts the locale before the page path', () => {
    expect(localePath('es', 'home')).toBe('/es');
    expect(localePath('en', 'sign-in')).toBe('/en/sign-in');
    expect(localePath('es', 'sign-up')).toBe('/es/sign-up');
    expect(localePath('en', 'chat')).toBe('/en/chat');
  });
});

describe('localeOfPath', () => {
  test('reads the locale prefix of a page path', () => {
    expect(localeOfPath('/en/chat')).toBe('en');
    expect(localeOfPath('/es')).toBe('es');
  });

  test('is null without a known prefix', () => {
    expect(localeOfPath('/chat')).toBeNull();
    expect(localeOfPath('/fr/chat')).toBeNull();
    expect(localeOfPath('/english')).toBeNull();
  });
});

describe('negotiateLocale', () => {
  test('the lang cookie wins over the browser', () => {
    expect(negotiateLocale('en', 'es-MX,es;q=0.9')).toBe('en');
  });

  test('an unknown cookie falls back to Accept-Language', () => {
    expect(negotiateLocale('fr', 'en-US,en;q=0.9')).toBe('en');
  });

  test('takes the best-ranked supported language, by its primary subtag', () => {
    expect(negotiateLocale(null, 'fr-FR,fr;q=0.9,en-GB;q=0.8,es;q=0.7')).toBe('en');
    expect(negotiateLocale(null, 'en;q=0.4, ES-mx;q=0.8')).toBe('es');
  });

  test('skips a language refused with q=0', () => {
    expect(negotiateLocale(null, 'en;q=0, es;q=0.1')).toBe('es');
  });

  test('defaults to Spanish', () => {
    expect(DEFAULT_LOCALE).toBe('es');
    expect(negotiateLocale(null, null)).toBe('es');
    expect(negotiateLocale(null, 'fr, de;q=0.5, *;q=0.1')).toBe('es');
  });
});

test('isLocale accepts only the supported locales', () => {
  expect(isLocale('es')).toBe(true);
  expect(isLocale('en')).toBe(true);
  expect(isLocale('EN')).toBe(false);
  expect(isLocale(null)).toBe(false);
});
