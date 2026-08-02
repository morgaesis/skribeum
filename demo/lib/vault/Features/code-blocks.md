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
if [ -f package.json ]; then
  bun run check
fi
```

## Python example

```py
def note_title(path: str) -> str:
    return path.removesuffix(".md")
```

## YAML example

```yml
note:
  title: Field notes
  published: true
```

## Rust example

```rs
fn note_title(path: &str) -> &str {
    path.strip_suffix(".md").unwrap_or(path)
}
```

Inline code works well for short identifiers such as `displayTitle`, while a fenced block is clearer for a complete snippet. Code inside a fence stays literal, so text such as `[[not-a-link]]` is displayed as source rather than treated as a wikilink.

> [!note]
> The commands are examples of repository checks. This browser vault does not provide a terminal.

#feature/code #demo
