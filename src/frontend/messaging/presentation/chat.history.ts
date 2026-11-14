import type { HistoryPage } from '../../../shared/contracts/messaging.contract.ts';

/**
 * Paging state of one room's REST history: pages go newest to oldest, each one requested `before`
 * the previous page's `nextBefore` cursor, until the server answers with a null cursor.
 */
export class HistoryCursor {
  get hasOlder(): boolean {
    return !this.#started || this.#nextBefore !== null;
  }

  #loading = false;
  #nextBefore: null | string = null;
  #started = false;

  apply(page: HistoryPage): void {
    this.#loading = false;
    this.#started = true;
    this.#nextBefore = page.nextBefore;
  }

  /**
   * Starts a page request and returns its cursor, or null when a request is in flight or there is
   * nothing older.
   */
  begin(): null | { readonly before?: string } {
    if (this.#loading || !this.hasOlder) {
      return null;
    }
    this.#loading = true;
    return this.#nextBefore === null ? {} : { before: this.#nextBefore };
  }

  /** The request failed: the same page can be requested again. */
  fail(): void {
    this.#loading = false;
  }
}
