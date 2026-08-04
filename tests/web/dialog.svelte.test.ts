import { flushSync, mount, tick, unmount } from "svelte";
import { describe, expect, it, vi } from "vitest";
import Dialog from "../../src/lib/Dialog.svelte";
import { showConfirmDialog, showPromptDialog } from "../../src/lib/dialogs";

describe("application dialog surface", () => {
  it("traps focus, dismisses with Escape, and restores its opener", async () => {
    const opener = document.createElement("button");
    opener.textContent = "Open";
    document.body.append(opener);
    opener.focus();
    const onConfirm = vi.fn();
    // The real integration (dialogs.ts) unmounts the dialog from within its
    // own onCancel/onConfirm callback; focus restoration lives in Svelte's
    // onDestroy, so a faithful test triggers unmount the same way rather
    // than asserting restoration happens on the callback alone.
    const onCancel = vi.fn(() => void unmount(component));
    const component = mount(Dialog, {
      target: document.body,
      props: {
        kind: "confirm",
        title: "Delete this vault entry?",
        confirmLabel: "Delete",
        cancelLabel: "Cancel",
        destructive: true,
        onConfirm,
        onCancel,
      },
    });
    flushSync();
    await tick();

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    const cancel = document.querySelector<HTMLButtonElement>(
      '[data-testid="dialog-cancel"]',
    );
    const confirm = document.querySelector<HTMLButtonElement>(
      '[data-testid="dialog-confirm"]',
    );
    // The safe default: initial focus lands on Cancel, not the destructive
    // action, so an early Enter cannot execute it by accident.
    expect(document.activeElement).toBe(cancel);

    confirm?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      }),
    );
    // With two focusable elements, Tab from the last wraps to the first.
    cancel?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(document.activeElement).toBe(confirm);

    dialog?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(opener);

    opener.remove();
  });

  it("marks the destructive action with the destructive role and never renders two primary buttons", () => {
    const component = mount(Dialog, {
      target: document.body,
      props: {
        kind: "confirm",
        title: "Delete this vault entry?",
        confirmLabel: "Delete",
        cancelLabel: "Cancel",
        destructive: true,
        onConfirm: () => {},
        onCancel: () => {},
      },
    });
    flushSync();

    const confirm = document.querySelector<HTMLButtonElement>(
      '[data-testid="dialog-confirm"]',
    );
    const cancel = document.querySelector<HTMLButtonElement>(
      '[data-testid="dialog-cancel"]',
    );
    expect(confirm?.dataset.btnRole).toBe("destructive");
    expect(confirm?.className).toContain("skr-btn-destructive");
    expect(cancel?.dataset.btnRole).toBe("secondary");
    expect(document.querySelectorAll('[data-btn-role="primary"]')).toHaveLength(
      0,
    );

    void unmount(component);
  });

  it("focuses the input for a prompt and keeps the dialog open with an inline reason on an invalid value", async () => {
    const onConfirm = vi.fn();
    const component = mount(Dialog, {
      target: document.body,
      props: {
        kind: "prompt",
        title: "Rename",
        inputLabel: "New name",
        initialValue: "note.md",
        confirmLabel: "Rename",
        cancelLabel: "Cancel",
        validate: (value: string) =>
          value.endsWith(".md") ? null : "Notes must end in .md.",
        onConfirm,
        onCancel: () => {},
      },
    });
    flushSync();
    await tick();

    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="dialog-input"]',
    );
    expect(document.activeElement).toBe(input);
    expect(input?.value).toBe("note.md");

    if (input === null) throw new Error("input not found");
    input.value = "note";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
    flushSync();

    expect(onConfirm).not.toHaveBeenCalled();
    const error = document.querySelector('[data-testid="dialog-error"]');
    expect(error?.textContent).toContain("Notes must end in .md.");
    expect(input.getAttribute("aria-invalid")).toBe("true");

    input.value = "note.md";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(onConfirm).toHaveBeenCalledWith("note.md");

    void unmount(component);
  });
});

describe("imperative dialog helpers", () => {
  it("showConfirmDialog resolves true on confirm and removes its host afterward", async () => {
    const before = document.body.childElementCount;
    const pending = showConfirmDialog({
      title: "Clear edit history?",
      message: "This cannot be undone.",
      confirmLabel: "Clear history",
      destructive: true,
    });
    flushSync();
    await tick();
    expect(document.body.childElementCount).toBeGreaterThan(before);
    document
      .querySelector<HTMLButtonElement>('[data-testid="dialog-confirm"]')
      ?.click();
    expect(await pending).toBe(true);
    expect(document.body.childElementCount).toBe(before);
  });

  it("showPromptDialog resolves null on cancel", async () => {
    const pending = showPromptDialog({
      title: "Folder name",
      confirmLabel: "Create",
    });
    flushSync();
    await tick();
    document
      .querySelector<HTMLButtonElement>('[data-testid="dialog-cancel"]')
      ?.click();
    expect(await pending).toBeNull();
  });
});
