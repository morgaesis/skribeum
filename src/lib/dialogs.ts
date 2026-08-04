// The application's own modal dialog surface, replacing every native
// `window.prompt`, `window.confirm`, and platform dialog-plugin call in the
// product. Both helpers mount `Dialog.svelte` into a detached host, resolve
// once the user confirms or cancels, and unmount the host afterward so no
// dialog instance outlives its own answer.

import type { ComponentProps } from "svelte";
import { mount, unmount } from "svelte";
import Dialog from "./Dialog.svelte";
import { STRINGS } from "./strings";

export type ConfirmDialogOptions = {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** Marks the confirm action with the destructive button role. */
  destructive?: boolean;
};

export type PromptDialogOptions = {
  title: string;
  message?: string;
  initialValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Accessible label for the text field; defaults to the title. */
  inputLabel?: string;
  /** Returns a reason the value is invalid, or null when it is acceptable. */
  validate?: (value: string) => string | null;
};

function mountDialog(props: ComponentProps<typeof Dialog>): () => void {
  const host = document.createElement("div");
  document.body.append(host);
  const component = mount(Dialog, { target: host, props });
  return () => {
    void unmount(component);
    host.remove();
  };
}

/** Shows the application confirm dialog and resolves with the user's choice. */
export function showConfirmDialog(
  options: ConfirmDialogOptions,
): Promise<boolean> {
  return new Promise((resolve) => {
    const dispose = mountDialog({
      kind: "confirm",
      title: options.title,
      message: options.message,
      confirmLabel: options.confirmLabel,
      cancelLabel: options.cancelLabel ?? STRINGS.cancelAction,
      destructive: options.destructive ?? false,
      onConfirm: () => {
        dispose();
        resolve(true);
      },
      onCancel: () => {
        dispose();
        resolve(false);
      },
    });
  });
}

/**
 * Shows the application prompt dialog and resolves with the entered value,
 * or null when the user cancels. A `validate` function keeps the dialog open
 * and shows its returned reason inline until the value passes.
 */
export function showPromptDialog(
  options: PromptDialogOptions,
): Promise<string | null> {
  return new Promise((resolve) => {
    const dispose = mountDialog({
      kind: "prompt",
      title: options.title,
      message: options.message,
      initialValue: options.initialValue ?? "",
      confirmLabel: options.confirmLabel ?? STRINGS.confirmAction,
      cancelLabel: options.cancelLabel ?? STRINGS.cancelAction,
      inputLabel: options.inputLabel ?? options.title,
      validate: options.validate,
      onConfirm: (value: string) => {
        dispose();
        resolve(value);
      },
      onCancel: () => {
        dispose();
        resolve(null);
      },
    });
  });
}
