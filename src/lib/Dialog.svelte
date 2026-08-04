<script module lang="ts">
let nextDialogId = 0;
</script>

<script lang="ts">
import { onDestroy, onMount, tick, untrack } from "svelte";
import { enterMotionSurface, exitMotionSurfaces } from "./motion";

let {
  kind,
  title,
  message,
  confirmLabel,
  cancelLabel,
  destructive = false,
  initialValue = "",
  inputLabel,
  validate,
  onConfirm,
  onCancel,
}: {
  kind: "confirm" | "prompt";
  title: string;
  message?: string | undefined;
  confirmLabel: string;
  cancelLabel: string;
  destructive?: boolean | undefined;
  initialValue?: string | undefined;
  inputLabel?: string | undefined;
  validate?: ((value: string) => string | null) | undefined;
  onConfirm: (value: string) => void;
  onCancel: () => void;
} = $props();

nextDialogId += 1;
const titleId = `skr-dialog-title-${nextDialogId}`;
const errorId = `skr-dialog-error-${nextDialogId}`;

// A snapshot: the field is uncontrolled after the dialog opens, so this
// deliberately does not resync if the prop changes later.
let value = $state(untrack(() => initialValue));
let error = $state<string | null>(null);
let backdrop = $state<HTMLElement>();
let dialog = $state<HTMLElement>();
let inputElement = $state<HTMLInputElement>();
let cancelElement = $state<HTMLButtonElement>();
let confirmElement = $state<HTMLButtonElement>();
let returnFocus: HTMLElement | null = null;
let closing = false;

const focusableSelector =
  'a[href], button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])';

function focusableElements(): HTMLElement[] {
  return dialog === undefined
    ? []
    : [...dialog.querySelectorAll<HTMLElement>(focusableSelector)];
}

function finish(action: () => void) {
  if (closing) return;
  closing = true;
  exitMotionSurfaces(
    [backdrop, dialog].filter(
      (element): element is HTMLElement => element !== undefined,
    ),
    action,
  );
}

function requestCancel() {
  finish(onCancel);
}

function requestConfirm() {
  if (kind === "prompt") {
    const reason = validate?.(value) ?? null;
    if (reason !== null) {
      error = reason;
      inputElement?.focus();
      return;
    }
  }
  finish(() => onConfirm(value));
}

// registry-exempt keydown: ARIA modal dialog focus trapping and Escape
// dismissal are internal to this surface, matching the pattern already
// established by the settings dialog and the sheet primitive.
function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    requestCancel();
    return;
  }
  if (event.key !== "Tab") {
    return;
  }
  const focusable = focusableElements();
  const first = focusable[0];
  const last = focusable.at(-1);
  if (first === undefined || last === undefined) {
    event.preventDefault();
    dialog?.focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function onInputKeydown(event: KeyboardEvent) {
  if (event.key === "Enter") {
    event.preventDefault();
    requestConfirm();
  }
}

onMount(() => {
  returnFocus =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  void tick().then(() => {
    (kind === "prompt" ? inputElement : cancelElement)?.focus();
    inputElement?.select();
  });
  if (backdrop !== undefined) enterMotionSurface(backdrop);
  if (dialog !== undefined) enterMotionSurface(dialog);
});

onDestroy(() => {
  if (returnFocus?.isConnected === true) {
    returnFocus.focus();
  }
});
</script>

<div
  bind:this={backdrop}
  class="skr-overlay skr-dialog-backdrop"
  role="presentation"
  data-motion-surface="scrim"
  data-testid="dialog-backdrop"
  onclick={(event) =>
    event.target === event.currentTarget && requestCancel()}
>
  <div
    bind:this={dialog}
    class="skr-dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby={titleId}
    aria-describedby={message === undefined ? undefined : `${titleId}-message`}
    tabindex="-1"
    data-motion-surface="centered"
    data-testid="dialog"
    onkeydown={onKeydown}
  >
    <h2 id={titleId} class="skr-dialog-title">{title}</h2>
    {#if message !== undefined}
      <p id={`${titleId}-message`} class="skr-dialog-message">{message}</p>
    {/if}
    {#if kind === "prompt"}
      <label class="skr-dialog-field">
        <span class="sr-only">{inputLabel ?? title}</span>
        <input
          bind:this={inputElement}
          bind:value
          type="text"
          class="skr-dialog-input"
          aria-label={inputLabel ?? title}
          aria-invalid={error === null ? undefined : "true"}
          aria-describedby={error === null ? undefined : errorId}
          data-testid="dialog-input"
          onkeydown={onInputKeydown}
        />
      </label>
      {#if error !== null}
        <p id={errorId} class="skr-dialog-error" role="alert" data-testid="dialog-error">
          {error}
        </p>
      {/if}
    {/if}
    <div class="skr-dialog-actions">
      <button
        bind:this={cancelElement}
        type="button"
        class="skr-btn-secondary"
        data-btn-role="secondary"
        data-testid="dialog-cancel"
        onclick={requestCancel}
      >
        {cancelLabel}
      </button>
      <button
        bind:this={confirmElement}
        type="button"
        class={destructive ? "skr-btn-destructive" : "skr-btn-primary"}
        data-btn-role={destructive ? "destructive" : "primary"}
        data-testid="dialog-confirm"
        onclick={requestConfirm}
      >
        {confirmLabel}
      </button>
    </div>
  </div>
</div>

<style>
  .skr-dialog-backdrop {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
  }

  .skr-dialog {
    display: flex;
    width: 24rem;
    max-width: 100%;
    max-height: calc(100vh - 2rem);
    flex-direction: column;
    overflow-y: auto;
    box-sizing: border-box;
    border: 1px solid var(--skr-border);
    border-radius: var(--skr-radius-dialog);
    padding: 1.25rem;
    background: var(--skr-surface-raised);
    box-shadow: var(--skr-shadow);
    outline: none;
  }

  .skr-dialog-title {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
  }

  .skr-dialog-message {
    margin: 0.5rem 0 0;
    color: var(--skr-text-muted);
    font-size: 0.875rem;
  }

  .skr-dialog-field {
    display: block;
    margin-top: 0.75rem;
  }

  .skr-dialog-input {
    /* De-boxed per design system section 5.12: a flat field with a bottom
       rule only, never a boxed outline. */
    box-sizing: border-box;
    width: 100%;
    border: 0;
    border-bottom: 1px solid var(--skr-border);
    border-radius: 0;
    padding: 0.5rem 0.625rem;
    background: var(--skr-surface);
    color: var(--skr-text);
    font: inherit;
  }

  .skr-dialog-input:focus-visible {
    border-bottom-color: var(--skr-border-strong);
    outline: 2px solid var(--skr-focus);
    outline-offset: 1px;
  }

  .skr-dialog-error {
    margin: 0.5rem 0 0;
    color: var(--skr-danger);
    font-size: 0.8125rem;
  }

  .skr-dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1.25rem;
  }
</style>
