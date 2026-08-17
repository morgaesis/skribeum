import { afterEach, describe, expect, it } from "vitest";
import {
  focusExpandedSidebarTarget,
  focusTabCloseSuccessor,
} from "../../src/lib/shellFocus";

function button(label: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  return element;
}

describe("shell focus continuity", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("moves keyboard sidebar expansion to the tree's roving target", () => {
    const sidebar = document.createElement("aside");
    sidebar.className = "skr-desktop-sidebar";
    const create = button("Create note");
    create.dataset.commandId = "note.create";
    const treeItem = button("First note");
    treeItem.setAttribute("role", "treeitem");
    treeItem.tabIndex = 0;
    sidebar.append(create, treeItem);
    document.body.append(sidebar);

    expect(focusExpandedSidebarTarget()).toBe(true);
    expect(document.activeElement).toBe(treeItem);
  });

  it("falls back to the first sidebar control when the tree is empty", () => {
    const sidebar = document.createElement("aside");
    sidebar.className = "skr-desktop-sidebar";
    const create = button("Create note");
    create.dataset.commandId = "note.create";
    sidebar.append(create);
    document.body.append(sidebar);

    expect(focusExpandedSidebarTarget()).toBe(true);
    expect(document.activeElement).toBe(create);
  });

  it("hands keyboard tab closure to the selected successor or predecessor", () => {
    const pane = document.createElement("section");
    pane.dataset.paneId = "pane-1";
    const first = button("First");
    first.setAttribute("role", "tab");
    first.setAttribute("aria-selected", "false");
    first.tabIndex = -1;
    const second = button("Second");
    second.setAttribute("role", "tab");
    second.setAttribute("aria-selected", "true");
    second.tabIndex = 0;
    pane.append(first, second);
    document.body.append(pane);

    expect(focusTabCloseSuccessor(pane, null)).toBe(true);
    expect(document.activeElement).toBe(second);

    second.remove();
    first.setAttribute("aria-selected", "true");
    first.tabIndex = 0;
    expect(focusTabCloseSuccessor(pane, null)).toBe(true);
    expect(document.activeElement).toBe(first);
  });

  it("uses the editor surface when repeated closure leaves no tab", () => {
    const pane = document.createElement("section");
    const editor = document.createElement("div");
    editor.tabIndex = -1;
    pane.append(editor);
    document.body.append(pane);

    expect(focusTabCloseSuccessor(pane, editor)).toBe(true);
    expect(document.activeElement).toBe(editor);

    expect(focusTabCloseSuccessor(pane, editor)).toBe(true);
    expect(document.activeElement).toBe(editor);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("uses the final selected tab during rapid repeated closure", () => {
    const pane = document.createElement("section");
    const first = button("First");
    const second = button("Second");
    const third = button("Third");
    for (const tab of [first, second, third]) {
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", "false");
      tab.tabIndex = -1;
      pane.append(tab);
    }
    document.body.append(pane);

    first.remove();
    second.setAttribute("aria-selected", "true");
    second.tabIndex = 0;
    expect(focusTabCloseSuccessor(pane, null)).toBe(true);
    expect(document.activeElement).toBe(second);

    second.remove();
    third.setAttribute("aria-selected", "true");
    third.tabIndex = 0;
    expect(focusTabCloseSuccessor(pane, null)).toBe(true);
    expect(document.activeElement).toBe(third);
  });
});
