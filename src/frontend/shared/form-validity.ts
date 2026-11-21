// Keeps the accessible state of form fields in step with what CSS draws: `aria-invalid` and the
// error message in `aria-describedby` follow `:user-invalid`, so assistive technology hears an
// error exactly when it appears on screen, never on page load. A field links its error message by
// putting the message's id in `data-error`; markup never lists it in `aria-describedby`, because
// referenced text is announced even while it is hidden.
import { describedByWith } from './presentation/form-validity.ts';

type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/** Time for the screen reader to read the field that took focus before the error is spoken. */
const ANNOUNCE_DELAY_MS = 500;

function errorText(field: Field): string {
  const id = field.dataset.error;
  const error = id === undefined ? null : document.getElementById(id);
  return error?.textContent.replaceAll(/\s+/gu, ' ').trim() ?? '';
}

function isField(target: EventTarget | null): target is Field {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement
  );
}

function linkError(field: Field, shown: boolean): void {
  const errorId = field.dataset.error;
  if (errorId === undefined) {
    return;
  }
  const value = describedByWith(field.getAttribute('aria-describedby'), errorId, shown);
  if (value === null) {
    field.removeAttribute('aria-describedby');
  } else {
    field.setAttribute('aria-describedby', value);
  }
}

/** One polite live region for the page: errors that appear when a field is left are read here. */
function createAnnouncer(): (field: Field | null) => void {
  const region = document.createElement('div');
  region.setAttribute('aria-live', 'polite');
  region.className = 'visually-hidden';
  document.body.append(region);
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (field) => {
    clearTimeout(timer);
    region.textContent = '';
    const text = field === null ? '' : errorText(field);
    if (field === null || text === '') {
      return;
    }
    const label = field.labels?.[0]?.textContent.trim() ?? '';
    timer = setTimeout(() => {
      region.textContent = label === '' ? text : `${label}: ${text}`;
    }, ANNOUNCE_DELAY_MS);
  };
}

/** Fields the server refused; they stay invalid until their custom validity is cleared. */
const refused = new WeakSet<Field>();
/** Fields whose current error was announced, or read with focus after a failed submit. */
const announced = new WeakSet<Field>();
let announce: ((field: Field | null) => void) | null = null;

function sync(field: Field, shouldAnnounce = false): void {
  const invalid =
    field.matches(':user-invalid') || (refused.has(field) && field.validationMessage !== '');
  field.setAttribute('aria-invalid', String(invalid));
  linkError(field, invalid);
  if (!invalid) {
    refused.delete(field);
    announced.delete(field);
    return;
  }
  if (shouldAnnounce && !announced.has(field)) {
    announce?.(field);
  }
  announced.add(field);
}

/**
 * Starts every field under `root` at `aria-invalid="false"` and keeps it in sync from then on. Call
 * it once per page, after the forms are in the document.
 */
export function installFieldValidity(root: Document = document): void {
  announce = createAnnouncer();
  for (const field of root.querySelectorAll<Field>('input, select, textarea')) {
    sync(field);
  }
  root.addEventListener(
    'blur',
    (event) => {
      if (isField(event.target)) {
        sync(event.target, true);
      }
    },
    true,
  );
  root.addEventListener(
    'change',
    (event) => {
      if (isField(event.target)) {
        sync(event.target, true);
      }
    },
    true,
  );
  root.addEventListener('input', (event) => {
    if (isField(event.target)) {
      sync(event.target);
    }
  });
  // A failed submit flags every failing field, touched or not; focus reaches the first one and
  // reads its error, so these are not announced again.
  root.addEventListener(
    'invalid',
    (event) => {
      if (isField(event.target)) {
        announced.add(event.target);
        sync(event.target);
      }
    },
    true,
  );
  // `:user-invalid` is cleared only after the reset event, so look again once it has run.
  root.addEventListener(
    'reset',
    (event) => {
      if (event.target instanceof HTMLFormElement) {
        const { elements } = event.target;
        setTimeout(() => {
          for (const element of elements) {
            if (isField(element)) {
              sync(element);
            }
          }
        });
      }
    },
    true,
  );
}

/**
 * Syncs `field` after the server judged it (its custom validity is already set or cleared). A
 * refused field is invalid at once and counts as announced: focus is moved to the first one, which
 * reads its message.
 */
export function flagServerError(field: Field): void {
  if (field.validationMessage === '') {
    sync(field);
    return;
  }
  refused.add(field);
  announced.add(field);
  sync(field);
}
