/**
 * Opens a WebSocket with Bun's client options (headers such as `Cookie` and `Origin`, the way a
 * browser sends them); the DOM typings only know the protocols overload of the constructor.
 */
export function bunWebSocket(url: string, options: Bun.WebSocketOptions): WebSocket {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Bun's constructor overload
  const BunWebSocket = WebSocket as unknown as new (
    url: string,
    options: Bun.WebSocketOptions,
  ) => WebSocket;
  return new BunWebSocket(url, options);
}
