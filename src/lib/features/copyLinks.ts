import { withoutNoteExtension } from "../noteTitles";
import type { CommandRegistry } from "../registry";
import { STRINGS } from "../strings";
import type { NoteAddress, WikilinkResolutionContext } from "./navigation";
import { urlForNoteAddress } from "./navigation";

function withoutMarkdownExtension(path: string): string {
  return withoutNoteExtension(path);
}

function directory(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function relativePath(fromDirectory: string, target: string): string {
  const from = fromDirectory.split("/").filter(Boolean);
  const to = target.split("/").filter(Boolean);
  let shared = 0;
  while (
    from[shared] === to[shared] &&
    shared < from.length &&
    shared < to.length
  ) {
    shared += 1;
  }
  const parts = [...from.slice(shared).map(() => ".."), ...to.slice(shared)];
  return parts.join("/") || to.at(-1) || target;
}

function shortestTarget(path: string, paths: readonly string[]): string {
  const target = withoutMarkdownExtension(path);
  const name = target.slice(target.lastIndexOf("/") + 1);
  const sameName = paths.filter((candidate) => {
    const normalized = withoutMarkdownExtension(candidate);
    return normalized.slice(normalized.lastIndexOf("/") + 1) === name;
  });
  return sameName.length <= 1 ? name : target;
}

function configuredTarget(
  address: NoteAddress,
  context: WikilinkResolutionContext,
): string {
  const path = withoutMarkdownExtension(address.path);
  switch (context.config.newLinkFormat) {
    case "absolute":
      return path;
    case "relative":
      return relativePath(directory(context.currentPath ?? ""), path);
    case "shortest":
      return shortestTarget(address.path, context.paths);
  }
}

function encodeMarkdownTarget(target: string): string {
  return target
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/** Produces a desktop note link using the vault's configured link format. */
export function desktopLinkForAddress(
  address: NoteAddress,
  context: WikilinkResolutionContext,
): string {
  const target = configuredTarget(address, context);
  const fragment = address.fragment === undefined ? "" : `#${address.fragment}`;
  if (context.config.useMarkdownLinks) {
    const label =
      address.fragment ??
      withoutMarkdownExtension(address.path).split("/").at(-1) ??
      address.path;
    return `[${label}](${encodeMarkdownTarget(target)}${fragment.length === 0 ? "" : `#${encodeURIComponent(address.fragment ?? "")}`})`;
  }
  return `[[${target}${fragment}]]`;
}

/** Produces the absolute browser-demo URL for a note address. */
export function browserLinkForAddress(
  address: NoteAddress,
  current: URL,
): string {
  return urlForNoteAddress(address, current).href;
}

export function registerCopyLinks(registry: CommandRegistry): void {
  registry.register({
    id: "link.copy-note",
    title: STRINGS.copyLinkToNote,
    pointer: ["action-menu", "command-palette"],
    run: (context) => context.copyNoteLink?.(),
  });
  registry.register({
    id: "link.copy-heading",
    title: STRINGS.copyLinkToCurrentHeading,
    pointer: ["command-palette", "outline"],
    run: (context) => context.copyHeadingLink?.(context.heading),
  });
  registry.register({
    id: "link.copy-permalink",
    title: STRINGS.copyPermalink,
    pointer: ["action-menu", "command-palette"],
    searchTerms: ["share", "public link"],
    run: (context) => context.copyPermalink?.(),
  });
}
