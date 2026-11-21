// Every text the pages' scripts generate, per locale. A page fixes its locale once at startup
// from `<html lang>` (`setLocaleFromLang`); English is the default, so code that runs without a
// page (unit tests) reads English unless it picks a locale.
import type { ConnectionState } from '../messaging/connection/messaging.connection.ts';
import type { LocalMessageStatus } from '../messaging/connection/messaging.message-status.ts';

import { isLocale, type Locale, localePath, type Page } from '../../shared/i18n/i18n.locale.ts';

export type Messages = {
  readonly addAtLeastOneMember: string;
  readonly banner: Readonly<Record<ConnectionState, string>>;
  readonly couldNotStart: (reason: string) => string;
  readonly failedLabel: string;
  readonly genericError: string;
  readonly keyChanged: (name: string) => string;
  readonly networkError: string;
  readonly noUserNamed: (name: string) => string;
  readonly openRoomFirst: string;
  readonly roomUnavailable: string;
  readonly self: string;
  readonly status: Readonly<Record<LocalMessageStatus, string>>;
  readonly tooManyRequests: string;
  readonly tooManyRequestsReload: string;
  readonly typing: (names: readonly string[]) => string;
  readonly undecryptable: string;
  readonly unexpectedResponse: string;
  readonly unknownRoom: string;
  readonly userFallback: (id: number) => string;
};

const en: Messages = {
  addAtLeastOneMember: 'Add at least one other member.',
  banner: {
    closed: '',
    connecting: 'Connecting…',
    offline: 'You are offline. Messages you send are kept and sent when the connection returns.',
    open: '',
    reconnecting: 'Connection lost. Reconnecting…',
    unauthorized: 'Your session has ended. Sign in again.',
  },
  couldNotStart: (reason) => `Could not start the chat: ${reason}`,
  failedLabel: 'Not sent',
  genericError: 'Something went wrong. Please try again.',
  keyChanged: (name) =>
    `The security key of ${name} changed. Messages to this room are paused until you trust the new key.`,
  networkError: 'Network error. Check your connection.',
  noUserNamed: (name) => `No user named "${name}".`,
  openRoomFirst: 'Open a room first.',
  roomUnavailable: 'The room is no longer available.',
  self: 'You',
  status: { delivered: 'Delivered', pending: 'Pending', read: 'Read', sent: 'Sent' },
  tooManyRequests: 'Too many requests. Please wait a moment.',
  tooManyRequestsReload: 'Too many requests. Please wait a moment and reload.',
  typing: ([first, second, ...rest]) => {
    if (first === undefined) {
      return '';
    }
    if (second === undefined) {
      return `${first} is typing…`;
    }
    return rest.length === 0 ? `${first} and ${second} are typing…` : 'Several people are typing…';
  },
  undecryptable: 'Unable to decrypt',
  unexpectedResponse: 'Unexpected response from the server',
  unknownRoom: 'Unknown room',
  userFallback: (id) => `User ${id}`,
};

const es: Messages = {
  addAtLeastOneMember: 'Agrega al menos a otro miembro.',
  banner: {
    closed: '',
    connecting: 'Conectando…',
    offline:
      'Estás sin conexión. Los mensajes que envíes se guardan y se envían cuando vuelva la conexión.',
    open: '',
    reconnecting: 'Se perdió la conexión. Reconectando…',
    unauthorized: 'Tu sesión terminó. Vuelve a iniciar sesión.',
  },
  couldNotStart: (reason) => `No se pudo iniciar el chat: ${reason}`,
  failedLabel: 'No enviado',
  genericError: 'Algo salió mal. Inténtalo de nuevo.',
  keyChanged: (name) =>
    `La clave de seguridad de ${name} cambió. Los mensajes a esta sala están en pausa hasta que confíes en la nueva clave.`,
  networkError: 'Error de red. Revisa tu conexión.',
  noUserNamed: (name) => `No hay ningún usuario llamado "${name}".`,
  openRoomFirst: 'Primero abre una sala.',
  roomUnavailable: 'La sala ya no está disponible.',
  self: 'Tú',
  status: { delivered: 'Entregado', pending: 'Pendiente', read: 'Leído', sent: 'Enviado' },
  tooManyRequests: 'Demasiadas solicitudes. Espera un momento.',
  tooManyRequestsReload: 'Demasiadas solicitudes. Espera un momento y recarga la página.',
  typing: ([first, second, ...rest]) => {
    if (first === undefined) {
      return '';
    }
    if (second === undefined) {
      return `${first} está escribiendo…`;
    }
    return rest.length === 0
      ? `${first} y ${second} están escribiendo…`
      : 'Varias personas están escribiendo…';
  },
  undecryptable: 'No se pudo descifrar',
  unexpectedResponse: 'Respuesta inesperada del servidor',
  unknownRoom: 'Sala desconocida',
  userFallback: (id) => `Usuario ${id}`,
};

export const MESSAGES: Readonly<Record<Locale, Messages>> = { en, es };

let active: Locale = 'en';

/** Fixes the locale from a `lang` attribute (`es`, `en-GB`); an unsupported one keeps English. */
export function activeLocale(): Locale {
  return active;
}

export function messages(): Messages {
  return MESSAGES[active];
}

export function setLocaleFromLang(lang: string): void {
  const primary = lang.toLowerCase().split('-')[0];
  active = isLocale(primary) ? primary : 'en';
}

// In a page, its own language; unit tests run without a document and keep English.
if (typeof document !== 'undefined') {
  setLocaleFromLang(document.documentElement.lang);
}

/** `page`'s path in the active locale (`/es/chat`). */
export function pagePath(page: Page): string {
  return localePath(active, page);
}
