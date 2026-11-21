import { afterEach, describe, expect, test } from 'bun:test';

import { setLocaleFromLang } from './i18n.messages.ts';
import { translateServerMessage } from './i18n.server-errors.ts';

afterEach(() => {
  setLocaleFromLang('en');
});

describe('translateServerMessage', () => {
  test('keeps the server text on an English page', () => {
    expect(translateServerMessage('Invalid credentials')).toBe('Invalid credentials');
  });

  test.each([
    ['Invalid credentials', 'Nombre o contraseña incorrectos.'],
    ['User already exists', 'Ese nombre ya está en uso.'],
    ['Name is required', 'El nombre es obligatorio.'],
    ['Name must be at most 64 characters', 'El nombre puede tener como máximo 64 caracteres.'],
    [
      'Name must contain only letters and numbers, without spaces',
      'El nombre solo puede tener letras y números, sin espacios.',
    ],
    ['Password is required', 'La contraseña es obligatoria.'],
    ['Password is too weak', 'La contraseña es demasiado débil.'],
    ['Password must be at most 256 characters', 'La contraseña puede tener como máximo 256 caracteres.'],
    ['Validation failed', 'Revisa los campos marcados.'],
    ['Too many sign-in attempts', 'Demasiados intentos de inicio de sesión. Espera un momento.'],
    ['Too many requests', 'Demasiadas solicitudes. Espera un momento.'],
    ['User not found', 'No se encontró el usuario.'],
    ['You are not a member of this room', 'No eres miembro de esta sala.'],
    ['User is already a member of this room', 'Ese usuario ya es miembro de esta sala.'],
    ['A room holds at most 100 members', 'Una sala puede tener como máximo 100 miembros.'],
    ['A room needs at least 2 members', 'Una sala necesita al menos 2 miembros.'],
    ['A room needs 2 to 100 members', 'Una sala necesita de 2 a 100 miembros.'],
    ['Room name must be 1 to 100 characters', 'El nombre de la sala debe tener de 1 a 100 caracteres.'],
    ['Missing or invalid token', 'Tu sesión no es válida o expiró. Vuelve a iniciar sesión.'],
    ['Invalid or expired token', 'Tu sesión no es válida o expiró. Vuelve a iniciar sesión.'],
    ['Origin not allowed', 'Origen no permitido.'],
  ])('translates "%s" on a Spanish page', (message, spanish) => {
    setLocaleFromLang('es');
    expect(translateServerMessage(message)).toBe(spanish);
  });

  test('shows an unknown message as it came', () => {
    setLocaleFromLang('es');
    expect(translateServerMessage('Something new broke')).toBe('Something new broke');
  });

  test('matches whole messages only', () => {
    setLocaleFromLang('es');
    expect(translateServerMessage('Name is required, or else')).toBe('Name is required, or else');
  });
});
