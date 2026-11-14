// Browser implementations of the connection's injected dependencies. Not unit-tested: each one
// forwards to a platform API, and the logic that uses them is tested with fakes.
import type { NetworkStatus, SocketLike, SocketListener, Timers } from './messaging.connection.ts';

/** Online status from `navigator.onLine` and the window's `online`/`offline` events. */
export const browserNetwork: NetworkStatus = {
  isOnline: () => navigator.onLine,
  onChange: (listener) => {
    const online = (): void => {
      listener(true);
    };
    const offline = (): void => {
      listener(false);
    };
    globalThis.addEventListener('online', online);
    globalThis.addEventListener('offline', offline);
    return () => {
      globalThis.removeEventListener('online', online);
      globalThis.removeEventListener('offline', offline);
    };
  },
};

export const browserTimers: Timers = {
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle);
  },
  setTimeout: (callback, ms) => window.setTimeout(callback, ms),
};

/** Opens a real WebSocket and reports its events to the listener. */
export function createBrowserSocket(
  url: string,
  protocols: string[],
  listener: SocketListener,
): SocketLike {
  const socket = new WebSocket(url, protocols);
  socket.addEventListener('open', () => {
    listener.onOpen();
  });
  socket.addEventListener('message', (event) => {
    if (typeof event.data === 'string') {
      listener.onMessage(event.data);
    }
  });
  socket.addEventListener('close', (event) => {
    listener.onClose(event.code);
  });
  return {
    close: (code) => {
      socket.close(code);
    },
    send: (data) => {
      socket.send(data);
    },
  };
}
