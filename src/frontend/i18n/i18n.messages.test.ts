import { afterEach, describe, expect, test } from 'bun:test';

import { activeLocale, MESSAGES, messages, pagePath, setLocaleFromLang } from './i18n.messages.ts';

afterEach(() => {
  setLocaleFromLang('en');
});

describe('setLocaleFromLang', () => {
  test('follows the page language', () => {
    setLocaleFromLang('es');
    expect(activeLocale()).toBe('es');
    expect(messages().genericError).toBe('Algo salió mal. Inténtalo de nuevo.');
  });

  test('reads only the primary subtag', () => {
    setLocaleFromLang('en-GB');
    expect(activeLocale()).toBe('en');
  });

  test('keeps English for an unsupported language', () => {
    setLocaleFromLang('fr');
    expect(activeLocale()).toBe('en');
  });
});

test('page paths carry the active locale', () => {
  expect(pagePath('chat')).toBe('/en/chat');
  setLocaleFromLang('es');
  expect(pagePath('sign-in')).toBe('/es/sign-in');
});

describe('dictionaries', () => {
  test('Spanish and English have the same texts', () => {
    expect(Object.keys(MESSAGES.es).toSorted()).toEqual(Object.keys(MESSAGES.en).toSorted());
    expect(Object.keys(MESSAGES.es.status).toSorted()).toEqual(Object.keys(MESSAGES.en.status).toSorted());
    expect(Object.keys(MESSAGES.es.banner).toSorted()).toEqual(Object.keys(MESSAGES.en.banner).toSorted());
  });

  test('no text is left empty, except the banners of a quiet connection', () => {
    for (const dictionary of Object.values(MESSAGES)) {
      for (const [key, value] of Object.entries(dictionary)) {
        if (typeof value === 'string') {
          expect(value, key).not.toBe('');
        }
      }
      expect(dictionary.banner.connecting).not.toBe('');
      expect(dictionary.banner.open).toBe('');
      expect(dictionary.banner.closed).toBe('');
    }
  });

  test('templated texts fill in their values', () => {
    const { es } = MESSAGES;
    expect(es.typing(['ana'])).toBe('ana está escribiendo…');
    expect(es.typing(['ana', 'bob'])).toBe('ana y bob están escribiendo…');
    expect(es.typing(['ana', 'bob', 'eva'])).toBe('Varias personas están escribiendo…');
    expect(es.typing([])).toBe('');
    expect(es.noUserNamed('zoe')).toBe('No hay ningún usuario llamado "zoe".');
    expect(es.userFallback(9)).toBe('Usuario 9');
    expect(es.couldNotStart('x')).toBe('No se pudo iniciar el chat: x');
    expect(es.keyChanged('bob')).toContain('bob');
  });
});
