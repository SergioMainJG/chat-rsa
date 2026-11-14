/**
 * Read receipts (S7): a message is read only once its element is visible in the viewport. One
 * receipt names the newest visible message; the server keeps a per-member watermark, so it covers
 * every older message too, and the page never sends a receipt at or below the last one sent.
 */

/** The id to send as read, or null. UUIDv7 ids compare as strings in server creation order. */
export function pickReadReceipt(
  visibleIds: Iterable<string>,
  lastSent: null | string,
): null | string {
  let newest: null | string = null;
  for (const id of visibleIds) {
    if (newest === null || id > newest) {
      newest = id;
    }
  }
  if (newest === null || (lastSent !== null && newest <= lastSent)) {
    return null;
  }
  return newest;
}

/** Visible other-member messages and the last read receipt sent, per room. */
export class ReadReceiptTracker {
  readonly #lastSent = new Map<string, string>();
  readonly #visible = new Map<string, Set<string>>();

  hide(roomId: string, messageId: string): void {
    this.#visible.get(roomId)?.delete(messageId);
  }

  /** Records the watermark the server already has (from GET receipts); it only moves forward. */
  seed(roomId: string, read: null | string): void {
    const current = this.#lastSent.get(roomId);
    if (read !== null && (current === undefined || read > current)) {
      this.#lastSent.set(roomId, read);
    }
  }

  show(roomId: string, messageId: string): void {
    const visible = this.#visible.get(roomId) ?? new Set<string>();
    visible.add(messageId);
    this.#visible.set(roomId, visible);
  }

  /** The id to send now, recorded as sent; null when there is nothing new to report. */
  take(roomId: string): null | string {
    const id = pickReadReceipt(this.#visible.get(roomId) ?? [], this.#lastSent.get(roomId) ?? null);
    if (id !== null) {
      this.#lastSent.set(roomId, id);
    }
    return id;
  }
}
