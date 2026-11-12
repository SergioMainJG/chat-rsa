// Browser entry of the auth pages: the only JS on them. Native validation runs first (the submit
// event fires only for a valid form); the API accepts JSON only, so the form is sent with fetch.
import { credentialsFrom, GENERIC_ERROR, outcomeOf } from './presentation/auth.view.ts';

const TOKEN_KEY = 'chat-rsa.token';
const REQUEST_TIMEOUT_MS = 15_000;

function clearMessages(form: HTMLFormElement): void {
  for (const field of fieldNames(form)) {
    showFieldError(form, field, '');
  }
  const formMessage = form.querySelector<HTMLElement>('[data-form-message]');
  if (formMessage) {
    formMessage.textContent = '';
  }
}

function fieldNames(form: HTMLFormElement): string[] {
  return [...form.querySelectorAll<HTMLElement>('[data-error-for]')].map(
    (element) => element.dataset.errorFor ?? '',
  );
}

function setBusy(form: HTMLFormElement, busy: boolean): void {
  form.setAttribute('aria-busy', String(busy));
  const fieldset = form.querySelector('fieldset');
  if (fieldset) {
    fieldset.disabled = busy;
  }
}

/**
 * Shows a server message under the field and marks it invalid through native validity, so CSS
 * styles it.
 */
function showFieldError(form: HTMLFormElement, field: string, message: string): void {
  const input = form.elements.namedItem(field);
  if (input instanceof HTMLInputElement) {
    input.setCustomValidity(message);
  }
  const output = form.querySelector<HTMLElement>(`[data-error-for="${field}"]`);
  if (output) {
    output.textContent = message;
  }
}

/**
 * Shows or hides the password the toggle controls; the toggle's label follows `aria-pressed` in
 * CSS.
 */
function setPasswordVisible(toggle: HTMLButtonElement, visible: boolean): void {
  const input = document.querySelector(`#${toggle.getAttribute('aria-controls') ?? ''}`);
  if (input instanceof HTMLInputElement) {
    input.type = visible ? 'text' : 'password';
    toggle.setAttribute('aria-pressed', String(visible));
  }
}

async function submit(form: HTMLFormElement): Promise<void> {
  // Hide the password again before sending, so it is not left on screen during the redirect.
  const toggle = form.querySelector<HTMLButtonElement>('[data-password-toggle]');
  if (toggle) {
    setPasswordVisible(toggle, false);
  }
  // Read the fields before disabling them: disabled controls are left out of FormData.
  const credentials = credentialsFrom(new FormData(form));
  clearMessages(form);
  setBusy(form, true);
  try {
    const response = await fetch(form.action, {
      body: JSON.stringify(credentials),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const outcome = await outcomeOf(response);
    if (outcome.kind === 'success') {
      sessionStorage.setItem(TOKEN_KEY, outcome.session.token);
      location.assign('/');
      return;
    }
    for (const [field, message] of Object.entries(outcome.fieldErrors)) {
      showFieldError(form, field, message);
    }
    const formMessage = form.querySelector<HTMLElement>('[data-form-message]');
    if (formMessage) {
      formMessage.textContent = outcome.message;
    }
  } catch {
    const formMessage = form.querySelector<HTMLElement>('[data-form-message]');
    if (formMessage) {
      formMessage.textContent = GENERIC_ERROR;
    }
  } finally {
    setBusy(form, false);
  }
}

const authForm = document.querySelector<HTMLFormElement>('[data-auth-form]');
if (authForm) {
  authForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void submit(authForm);
  });
  authForm
    .querySelector<HTMLButtonElement>('[data-password-toggle]')
    ?.addEventListener('click', (event) => {
      const toggle = event.currentTarget;
      if (toggle instanceof HTMLButtonElement) {
        setPasswordVisible(toggle, toggle.getAttribute('aria-pressed') !== 'true');
      }
    });
  // A server error stays on the field only until the user edits it again.
  authForm.addEventListener('input', (event) => {
    if (event.target instanceof HTMLInputElement && event.target.validationMessage !== '') {
      showFieldError(authForm, event.target.name, '');
    }
  });
}
