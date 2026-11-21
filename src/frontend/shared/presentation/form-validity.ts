/**
 * The `aria-describedby` value of a field once its error message (`errorId`) is shown or hidden:
 * the other ids keep their order, and the error id is listed last, once, only while it is shown.
 * Null means the attribute should be removed.
 */
export function describedByWith(
  current: null | string,
  errorId: string,
  shown: boolean,
): null | string {
  const ids = (current ?? '').split(/\s+/u).filter((id) => id !== '' && id !== errorId);
  if (shown) {
    ids.push(errorId);
  }
  return ids.length === 0 ? null : ids.join(' ');
}
