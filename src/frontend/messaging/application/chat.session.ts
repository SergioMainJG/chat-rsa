import type { PublicUser } from '../../../shared/contracts/auth.contract.ts';
import type { KeyStore } from '../crypto/messaging.crypto.key-store.ts';

import { SenderKeySession } from '../crypto/messaging.crypto.session.ts';
import { ChatApi, type FetchLike } from './chat.api.ts';

export type BootstrapDeps = {
  readonly fetch: FetchLike;
  /**
   * This user's key store. Keys are per user, not per browser: another account signed in on the
   * same browser must never see or reuse them.
   */
  readonly keyStoreFor: (userId: number) => KeyStore;
  /** The readable session hint cookie; the JWT itself lives in an HttpOnly cookie JS never sees. */
  readonly hint: SessionHint;
  readonly navigate: (path: string) => void;
};

export type BootstrapResult =
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'ready'; readonly session: ChatSession }
  | { readonly kind: 'redirected' };

/** A signed-in user with a published identity key, ready to open the socket. */
export type ChatSession = {
  readonly api: ChatApi;
  readonly crypto: SenderKeySession;
  /**
   * Renews the session cookies over REST; rejects when the session is over (for `SocketConnection`,
   * whose socket the server then sends `auth.refreshed`).
   */
  readonly refreshSession: () => Promise<void>;
  /**
   * Ends the session: the server revokes it and clears both cookies, and the hint cookie is deleted
   * here too, even when that call fails. This device keeps its E2EE keys and decrypted messages, so
   * signing in again shows the chat.
   */
  readonly signOut: () => Promise<void>;
  readonly user: PublicUser;
};

/**
 * The `chat_rsa_session_hint` cookie: the token's expiry, readable by JS. It is not a credential;
 * it only tells the page whether a session may still be live.
 */
export type SessionHint = {
  /** Deletes the hint cookie, so the route guard treats the visitor as signed out. */
  readonly clear: () => void;
  readonly isLive: () => boolean;
};

/** A 401 while starting: the page is already on its way to /sign-in. */
class SessionEndedError extends Error {
  constructor() {
    super('Session ended');
    this.name = 'SessionEndedError';
  }
}

export const SIGN_IN_PATH = '/sign-in';

/**
 * Starts the chat session: without a live session hint the user goes to /sign-in; otherwise the
 * session is refreshed (which also says who the user is), and this browser's identity key is
 * created and published the first time (S13, S15). Any 401 clears the hint and redirects.
 */
export async function bootstrapSession(deps: BootstrapDeps): Promise<BootstrapResult> {
  const { fetch, hint, keyStoreFor, navigate } = deps;
  if (!hint.isLive()) {
    navigate(SIGN_IN_PATH);
    return { kind: 'redirected' };
  }
  let redirected = false;
  const api = new ChatApi({
    fetch,
    onUnauthorized: () => {
      if (!redirected) {
        redirected = true;
        hint.clear();
        navigate(SIGN_IN_PATH);
      }
    },
  });
  const refreshed = await api.refresh();
  if (refreshed.kind === 'unauthorized') {
    return { kind: 'redirected' };
  }
  if (refreshed.kind !== 'ok') {
    return { kind: 'failed', message: failureMessage(refreshed) };
  }
  const crypto = new SenderKeySession(keyStoreFor(refreshed.value.user.id));
  try {
    await crypto.ensureIdentity(async (publicKey) => {
      const published = await api.publishIdentity(publicKey);
      if (published.kind === 'unauthorized') {
        throw new SessionEndedError();
      }
      if (published.kind !== 'ok') {
        throw new Error(failureMessage(published));
      }
    });
  } catch (error) {
    if (error instanceof SessionEndedError) {
      return { kind: 'redirected' };
    }
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
  const refreshSession = async (): Promise<void> => {
    const next = await api.refresh();
    if (next.kind !== 'ok') {
      throw new Error('Session expired');
    }
  };
  const signOut = async (): Promise<void> => {
    redirected = true;
    try {
      await api.signOut();
    } finally {
      hint.clear();
    }
  };
  return {
    kind: 'ready',
    session: { api, crypto, refreshSession, signOut, user: refreshed.value.user },
  };
}

function failureMessage(outcome: { readonly kind: string; readonly message?: string }): string {
  if (outcome.kind === 'rate-limited') {
    return 'Too many requests. Please wait a moment and reload.';
  }
  return outcome.message ?? 'Something went wrong. Please try again.';
}
