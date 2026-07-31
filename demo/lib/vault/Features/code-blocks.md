# Code blocks

Fenced code blocks preserve indentation and provide a language hint for syntax highlighting.

## TypeScript example

```ts
type NoteSummary = {
  path: string;
  title: string;
};

function displayTitle(note: NoteSummary): string {
  return note.title.trim() || note.path;
}
```

## Shell example

```sh
bun run check
bun run test:web
```

Inline code works well for short identifiers such as `displayTitle`, while a fenced block is clearer for a complete snippet. Code inside a fence stays literal, so text such as `[[not-a-link]]` is displayed as source rather than treated as a wikilink.

> [!note]
> The commands are examples of repository checks. This browser vault does not provide a terminal.

#feature/code #demo
