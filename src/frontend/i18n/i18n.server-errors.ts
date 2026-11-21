// The API answers errors with English text only (no codes), so the pages translate the messages a
// user can meet. A message must match whole; anything unknown is shown as the server sent it.
import type { Locale } from '../../shared/i18n/i18n.locale.ts';

import { activeLocale } from './i18n.messages.ts';

type Groups = Readonly<Partial<Record<string, string>>>;

type Rule = readonly [pattern: RegExp, translate: (groups: Groups) => string];

const SESSION_INVALID = 'Tu sesión no es válida o expiró. Vuelve a iniciar sesión.';

const SPANISH: readonly Rule[] = [
  [/^Invalid credentials$/u, () => 'Nombre o contraseña incorrectos.'],
  [/^User already exists$/u, () => 'Ese nombre ya está en uso.'],
  [/^Name is required$/u, () => 'El nombre es obligatorio.'],
  [
    /^Name must be at most (?<max>\d+) characters$/u,
    ({ max }) => `El nombre puede tener como máximo ${max} caracteres.`,
  ],
  [
    /^Name must contain only letters and numbers, without spaces$/u,
    () => 'El nombre solo puede tener letras y números, sin espacios.',
  ],
  [/^Password is required$/u, () => 'La contraseña es obligatoria.'],
  [/^Password is too weak$/u, () => 'La contraseña es demasiado débil.'],
  [
    /^Password must be at most (?<max>\d+) characters$/u,
    ({ max }) => `La contraseña puede tener como máximo ${max} caracteres.`,
  ],
  [/^Validation failed$/u, () => 'Revisa los campos marcados.'],
  [
    /^Too many sign-in attempts$/u,
    () => 'Demasiados intentos de inicio de sesión. Espera un momento.',
  ],
  [/^Too many requests$/u, () => 'Demasiadas solicitudes. Espera un momento.'],
  [/^User not found$/u, () => 'No se encontró el usuario.'],
  [/^You are not a member of this room$/u, () => 'No eres miembro de esta sala.'],
  [/^User is already a member of this room$/u, () => 'Ese usuario ya es miembro de esta sala.'],
  [
    /^A room holds at most (?<max>\d+) members$/u,
    ({ max }) => `Una sala puede tener como máximo ${max} miembros.`,
  ],
  [
    /^A room needs at least (?<min>\d+) members$/u,
    ({ min }) => `Una sala necesita al menos ${min} miembros.`,
  ],
  [
    /^A room needs (?<min>\d+) to (?<max>\d+) members$/u,
    ({ max, min }) => `Una sala necesita de ${min} a ${max} miembros.`,
  ],
  [
    /^Room name must be (?<min>\d+) to (?<max>\d+) characters$/u,
    ({ max, min }) => `El nombre de la sala debe tener de ${min} a ${max} caracteres.`,
  ],
  [/^Missing or invalid token$/u, () => SESSION_INVALID],
  [/^Invalid or expired token$/u, () => SESSION_INVALID],
  [/^Origin not allowed$/u, () => 'Origen no permitido.'],
];

/** English needs no rules: the server already speaks it. */
const RULES: Readonly<Record<Locale, readonly Rule[]>> = { en: [], es: SPANISH };

/** `message` from the server in the page's language, or as it came when it is not a known one. */
export function translateServerMessage(message: string): string {
  for (const [pattern, translate] of RULES[activeLocale()]) {
    const match = pattern.exec(message);
    if (match) {
      return translate(match.groups ?? {});
    }
  }
  return message;
}
