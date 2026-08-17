// Image target resolution for standard Markdown images, kept separate from
// the decoration engine so the rules are testable without a DOM.
//
// Safety posture: a note never executes. Every resolved source is handed to
// an `<img>` element and nothing else, so SVG loads in the user agent's
// secure static mode, where scripts, external references, and interactivity
// are all disabled. Vault bytes become a blob whose media type comes from
// the extension allowlist below, never from the file's own content, so an
// extension outside that list has no rendered form at all and a text or
// markup payload can never be served to the webview as a document.

import type { WikilinkResolutionContext } from "../../features/navigation";
import { resolveWikilinkTarget } from "../../features/navigation";

/**
 * The renderable raster and vector image formats, by lowercase file
 * extension. Anything else is not an image this product renders.
 */
const IMAGE_MEDIA_TYPES: Readonly<Record<string, string>> = Object.freeze({
  apng: "image/apng",
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  ico: "image/vnd.microsoft.icon",
  jfif: "image/jpeg",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
});

/** The one allowed image format whose file contents are text. */
export const TEXT_IMAGE_MEDIA_TYPE = "image/svg+xml";

export type ImageSource =
  /** An absolute HTTPS or data URL used as the element source verbatim. */
  | { kind: "direct"; url: string }
  /** A vault-relative file read through the context's asset loader. */
  | { kind: "vault"; path: string; mediaType: string }
  /** An image target the open vault does not contain. */
  | { kind: "missing"; target: string };

/** The media type an extension grants, or null when it grants none. */
export function imageMediaType(path: string): string | null {
  const name = path.split(/[?#]/u, 1)[0] ?? path;
  const dot = name.lastIndexOf(".");
  if (dot === -1) {
    return null;
  }
  return IMAGE_MEDIA_TYPES[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** The display name for an image target: its last path segment. */
export function imageFileName(target: string): string {
  const path = target.split(/[?#]/u, 1)[0] ?? target;
  return path.split("/").at(-1) ?? path;
}

/** Strips the CommonMark pointy-bracket form from a target. */
function unwrapTarget(rawTarget: string): string {
  return rawTarget.startsWith("<") && rawTarget.endsWith(">")
    ? rawTarget.slice(1, -1)
    : rawTarget;
}

/**
 * Percent-decodes a vault path, where `%20` stands for a space in a file
 * name. An absolute URL keeps its exact encoding: the element source
 * resolves percent escapes itself, and decoding one would fold a `#` or a
 * `?` inside the payload into a fragment or a query.
 */
function decodeVaultPath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/**
 * Resolves an image target to the source the widget renders, or null when
 * the target names nothing this product renders as an image and the
 * construct keeps its link presentation instead. Remote images are limited
 * to HTTPS and to `data:` URLs that already declare an allowed image media
 * type; a cleartext HTTP target and every other scheme resolve to nothing
 * rather than silently downgrading a note's transport. A vault-relative
 * target carrying an image extension always resolves to a source, so a
 * file the vault does not contain reaches the widget's failure state
 * instead of disappearing into prose.
 */
export function resolveImageSource(
  rawTarget: string,
  context: WikilinkResolutionContext,
): ImageSource | null {
  const encoded = unwrapTarget(rawTarget).trim();
  if (encoded.length === 0) {
    return null;
  }
  if (/^https:\/\//iu.test(encoded)) {
    return { kind: "direct", url: encoded };
  }
  if (/^data:image\//iu.test(encoded)) {
    const declared = /^data:([^;,]+)/iu.exec(encoded)?.[1]?.toLowerCase() ?? "";
    return Object.values(IMAGE_MEDIA_TYPES).includes(declared)
      ? { kind: "direct", url: encoded }
      : null;
  }
  if (/^[a-z][a-z0-9+.-]*:/iu.test(encoded) || encoded.startsWith("//")) {
    return null;
  }
  const target = decodeVaultPath(encoded);
  const mediaType = imageMediaType(target);
  if (mediaType === null) {
    return null;
  }
  const resolution = resolveWikilinkTarget(
    target.startsWith("/") ? target.slice(1) : target,
    context,
  );
  return resolution.kind === "note"
    ? { kind: "vault", path: resolution.path, mediaType }
    : { kind: "missing", target };
}
