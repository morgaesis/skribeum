export type CalloutCanonicalType =
  | "note"
  | "abstract"
  | "info"
  | "todo"
  | "tip"
  | "success"
  | "question"
  | "warning"
  | "failure"
  | "danger"
  | "bug"
  | "example"
  | "quote";

export type CalloutAccentGroup =
  | "blue"
  | "cyan"
  | "green"
  | "yellow"
  | "orange"
  | "red"
  | "purple"
  | "gray";

type CalloutVisual = {
  accentGroup: CalloutAccentGroup;
  iconBody: string;
};

export type ResolvedCalloutType = {
  originalType: string;
  canonicalType: CalloutCanonicalType;
  accentGroup: CalloutAccentGroup;
  defaultTitle: string;
};

export type ParsedCallout = ResolvedCalloutType & {
  title: string;
  foldable: boolean;
  initiallyExpanded: boolean;
  bodyMarkdown: string;
  iconSvg: string;
};

export const CALLOUT_ALIASES: Readonly<Record<string, CalloutCanonicalType>> =
  Object.freeze({
    note: "note",
    abstract: "abstract",
    summary: "abstract",
    tldr: "abstract",
    info: "info",
    todo: "todo",
    tip: "tip",
    hint: "tip",
    important: "tip",
    success: "success",
    check: "success",
    done: "success",
    question: "question",
    help: "question",
    faq: "question",
    warning: "warning",
    caution: "warning",
    attention: "warning",
    failure: "failure",
    fail: "failure",
    missing: "failure",
    danger: "danger",
    error: "danger",
    bug: "bug",
    example: "example",
    quote: "quote",
    cite: "quote",
  });

const DEFAULT_TITLES: Readonly<Record<string, string>> = Object.freeze({
  note: "Note",
  abstract: "Abstract",
  summary: "Summary",
  tldr: "TLDR",
  info: "Info",
  todo: "Todo",
  tip: "Tip",
  hint: "Hint",
  important: "Important",
  success: "Success",
  check: "Check",
  done: "Done",
  question: "Question",
  help: "Help",
  faq: "FAQ",
  warning: "Warning",
  caution: "Caution",
  attention: "Attention",
  failure: "Failure",
  fail: "Fail",
  missing: "Missing",
  danger: "Danger",
  error: "Error",
  bug: "Bug",
  example: "Example",
  quote: "Quote",
  cite: "Cite",
});

const CALLOUT_VISUALS: Readonly<Record<CalloutCanonicalType, CalloutVisual>> =
  Object.freeze({
    note: {
      accentGroup: "blue",
      iconBody:
        '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/>',
    },
    abstract: {
      accentGroup: "cyan",
      iconBody:
        '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 7h6M9 11h6M9 15h4"/>',
    },
    info: {
      accentGroup: "blue",
      iconBody: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    },
    todo: {
      accentGroup: "blue",
      iconBody:
        '<rect x="3" y="5" width="6" height="6" rx="1"/><path d="M13 8h8M5 17l2 2 4-5M13 17h8"/>',
    },
    tip: {
      accentGroup: "cyan",
      iconBody:
        '<path d="M9 18h6M10 22h4M8.2 14.5A7 7 0 1 1 15.8 14.5C14.8 15.2 14.5 16 14.5 17h-5c0-1-.3-1.8-1.3-2.5Z"/>',
    },
    success: {
      accentGroup: "green",
      iconBody: '<circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/>',
    },
    question: {
      accentGroup: "yellow",
      iconBody:
        '<circle cx="12" cy="12" r="9"/><path d="M9.7 9a2.5 2.5 0 1 1 3.3 2.4c-.8.3-1 1-1 1.6M12 17h.01"/>',
    },
    warning: {
      accentGroup: "orange",
      iconBody:
        '<path d="M10.3 4.1 2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 4.1a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
    },
    failure: {
      accentGroup: "red",
      iconBody: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>',
    },
    danger: {
      accentGroup: "red",
      iconBody:
        '<path d="m8 2-6 6v8l6 6h8l6-6V8l-6-6Z"/><path d="M12 7v6M12 17h.01"/>',
    },
    bug: {
      accentGroup: "red",
      iconBody:
        '<path d="M8 2l1.5 2M16 2l-1.5 2M3 13h4M17 13h4M5 7l3 2M19 7l-3 2"/><rect x="7" y="4" width="10" height="16" rx="5"/><path d="M7 14h10M12 4v16"/>',
    },
    example: {
      accentGroup: "purple",
      iconBody:
        '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
    },
    quote: {
      accentGroup: "gray",
      iconBody:
        '<path d="M7 17H4a2 2 0 0 1-2-2v-3a6 6 0 0 1 6-6v3a3 3 0 0 0-3 3h2ZM19 17h-3a2 2 0 0 1-2-2v-3a6 6 0 0 1 6-6v3a3 3 0 0 0-3 3h2Z"/>',
    },
  });

const CALLOUT_HEADER =
  /^[ \t]{0,3}>[ \t]?\[!([A-Za-z0-9_-]+)\]([+-])?(?:[ \t]+(.*?))?[ \t]*$/;
const QUOTE_PREFIX = /(^|\r\n|\r|\n)[ \t]{0,3}>[ \t]?/g;

function humanizeType(type: string): string {
  const words = type
    .split(/[-_]+/)
    .filter((word) => word.length > 0)
    .map(
      (word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1).toLowerCase()}`,
    );
  return words.join(" ") || "Note";
}

function canonicalTypeOf(type: string): CalloutCanonicalType {
  return CALLOUT_ALIASES[type.toLowerCase()] ?? "note";
}

export function resolveCalloutType(originalType: string): ResolvedCalloutType {
  const normalizedType = originalType.toLowerCase();
  const canonicalType = canonicalTypeOf(normalizedType);
  return {
    originalType,
    canonicalType,
    accentGroup: CALLOUT_VISUALS[canonicalType].accentGroup,
    defaultTitle: DEFAULT_TITLES[normalizedType] ?? humanizeType(originalType),
  };
}

export function calloutIconSvg(type: string): string {
  const canonicalType = canonicalTypeOf(type);
  const iconBody = CALLOUT_VISUALS[canonicalType].iconBody;
  return `<svg class="cm-skr-callout-icon" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${iconBody}</svg>`;
}

export function parseCallout(source: string): ParsedCallout | null {
  const lineBreak = source.search(/\r\n|\r|\n/);
  const header = lineBreak === -1 ? source : source.slice(0, lineBreak);
  const match = CALLOUT_HEADER.exec(header);
  if (match === null || match[1] === undefined) {
    return null;
  }

  const originalType = match[1];
  const foldMarker = match[2];
  const customTitle = match[3]?.trim();
  const resolved = resolveCalloutType(originalType);
  const lineBreakLength =
    lineBreak !== -1 && source.startsWith("\r\n", lineBreak) ? 2 : 1;
  const bodySource =
    lineBreak === -1 ? "" : source.slice(lineBreak + lineBreakLength);

  return {
    ...resolved,
    title:
      customTitle === undefined || customTitle.length === 0
        ? resolved.defaultTitle
        : customTitle,
    foldable: foldMarker !== undefined,
    initiallyExpanded: foldMarker !== "-",
    bodyMarkdown: bodySource.replace(QUOTE_PREFIX, "$1"),
    iconSvg: calloutIconSvg(resolved.canonicalType),
  };
}
