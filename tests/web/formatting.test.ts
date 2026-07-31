// Inline marker toggling: declared-range mutations only, toggle
// round-trips to the original document, and containment (every changed
// character lies inside the declared marker ranges, never inside the
// selected text).

import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  MARKERS,
  type MarkerName,
  toggleInlineMarker,
} from "../../src/lib/features/formatting";

function stateWith(doc: string, anchor: number, head: number): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.single(anchor, head),
  });
}

function applyToggle(state: EditorState, marker: MarkerName): EditorState {
  return state.update(toggleInlineMarker(state, MARKERS[marker])).state;
}

describe("inline marker toggling", () => {
  const cases: readonly {
    marker: MarkerName;
    wrapped: string;
  }[] = [
    { marker: "bold", wrapped: "a **word** b" },
    { marker: "italic", wrapped: "a *word* b" },
    { marker: "code", wrapped: "a `word` b" },
    { marker: "strikethrough", wrapped: "a ~~word~~ b" },
    { marker: "wikilink", wrapped: "a [[word]] b" },
  ];

  it.each(cases.map((entry) => [entry.marker, entry] as const))(
    "%s adds markers around a selection and round-trips",
    (_name, entry) => {
      const original = "a word b";
      const state = stateWith(original, 2, 6);
      const toggled = applyToggle(state, entry.marker);
      expect(toggled.doc.toString()).toBe(entry.wrapped);
      // The selection still covers exactly the original word.
      const range = toggled.selection.main;
      expect(toggled.doc.sliceString(range.from, range.to)).toBe("word");
      const restored = applyToggle(toggled, entry.marker);
      expect(restored.doc.toString()).toBe(original);
    },
  );

  it("removes markers when the selection includes them", () => {
    const state = stateWith("a **word** b", 2, 10);
    expect(applyToggle(state, "bold").doc.toString()).toBe("a word b");
  });

  it("does not bite into surrounding bold when toggling italic", () => {
    // `**word**` with the inner word selected: italic must add, not strip.
    const state = stateWith("**word**", 2, 6);
    expect(applyToggle(state, "italic").doc.toString()).toBe("***word***");
  });

  it("inserts an empty pair at a cursor with the cursor inside", () => {
    const state = stateWith("ab", 1, 1);
    const toggled = applyToggle(state, "bold");
    expect(toggled.doc.toString()).toBe("a****b");
    expect(toggled.selection.main.head).toBe(3);
  });

  it("only changes bytes at the declared marker positions", () => {
    const original = "prefix word suffix";
    const state = stateWith(original, 7, 11);
    const spec = toggleInlineMarker(state, MARKERS.bold);
    const changeSet = state.changes(spec.changes);
    // Containment: iterate the declared ranges; each is an insertion of
    // exactly the marker text, never a replacement of selected content.
    const declared: { from: number; to: number; insert: string }[] = [];
    changeSet.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      declared.push({ from: fromA, to: toA, insert: inserted.toString() });
    });
    expect(declared).toEqual([
      { from: 7, to: 7, insert: "**" },
      { from: 11, to: 11, insert: "**" },
    ]);
  });

  it("handles multiple selection ranges independently", () => {
    const state = EditorState.create({
      doc: "one two",
      selection: EditorSelection.create([
        EditorSelection.range(0, 3),
        EditorSelection.range(4, 7),
      ]),
      extensions: EditorState.allowMultipleSelections.of(true),
    });
    const toggled = state.update(toggleInlineMarker(state, MARKERS.bold)).state;
    expect(toggled.doc.toString()).toBe("**one** **two**");
  });
});
