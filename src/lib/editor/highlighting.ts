import { HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";

/** Syntax colours that follow Skribeum's light and dark theme tokens. */
export const noteHighlightStyle = HighlightStyle.define([
  { tag: tags.meta, color: "var(--skr-text-muted)" },
  { tag: tags.link, textDecoration: "underline" },
  { tag: tags.heading, textDecoration: "underline", fontWeight: "bold" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "bold" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.keyword, color: "var(--skr-callout-purple)" },
  {
    tag: [
      tags.atom,
      tags.bool,
      tags.url,
      tags.contentSeparator,
      tags.labelName,
    ],
    color: "var(--skr-link)",
  },
  { tag: [tags.literal, tags.inserted], color: "var(--skr-success)" },
  { tag: [tags.string, tags.deleted], color: "var(--skr-danger)" },
  {
    tag: [tags.regexp, tags.escape, tags.special(tags.string)],
    color: "var(--skr-warning)",
  },
  {
    tag: tags.definition(tags.variableName),
    color: "var(--skr-link)",
  },
  {
    tag: tags.local(tags.variableName),
    color: "var(--skr-callout-purple)",
  },
  {
    tag: [tags.typeName, tags.namespace],
    color: "var(--skr-success)",
  },
  { tag: tags.className, color: "var(--skr-callout-cyan)" },
  {
    tag: [tags.special(tags.variableName), tags.macroName],
    color: "var(--skr-callout-purple)",
  },
  {
    tag: tags.definition(tags.propertyName),
    color: "var(--skr-link)",
  },
  { tag: tags.comment, color: "var(--skr-text-muted)" },
  { tag: tags.invalid, color: "var(--skr-danger)", fontWeight: "bold" },
]);
