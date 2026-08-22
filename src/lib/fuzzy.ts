// Matching for the command surface, the slash menu and the tag surfaces.
//
// Two matchers live here because they answer different questions. Fuzzy
// subsequence matching serves multi-word titles, where a reader abbreviates
// words they already know: case-insensitive, scoring word-boundary and
// consecutive hits, returning matched positions so views can highlight
// without markup injection. Tag matching serves short single tokens, where
// skipping characters buys noise instead of tolerance, so it is anchored at
// path-segment boundaries and places every result in one of four ordered
// bands.

/** A successful match: higher scores rank first. */
export type FuzzyMatch = {
  score: number;
  /** Indices into the candidate string that matched, ascending. */
  positions: readonly number[];
};

const WORD_BOUNDARIES = new Set([" ", "/", "-", "_", ".", "(", "["]);

function isBoundary(candidate: string, index: number): boolean {
  if (index === 0) {
    return true;
  }
  const previous = candidate[index - 1] ?? "";
  return WORD_BOUNDARIES.has(previous);
}

function matchWith(
  lowerQuery: string,
  candidate: string,
  lowerCandidate: string,
  preferBoundary: boolean,
): FuzzyMatch | null {
  const positions: number[] = [];
  let score = 0;
  let candidateIndex = 0;
  for (let queryIndex = 0; queryIndex < lowerQuery.length; queryIndex += 1) {
    const character = lowerQuery[queryIndex] ?? "";
    let found = -1;
    for (let scan = candidateIndex; scan < lowerCandidate.length; scan += 1) {
      if (lowerCandidate[scan] === character) {
        if (found === -1) {
          found = scan;
        }
        if (!preferBoundary || isBoundary(candidate, scan)) {
          found = scan;
          break;
        }
      }
    }
    if (found === -1) {
      return null;
    }
    const previous = positions[positions.length - 1];
    if (previous !== undefined && found === previous + 1) {
      // Runs of adjacent hits outrank scattered word-boundary hits.
      score += 12;
    }
    if (isBoundary(candidate, found)) {
      score += 10;
    }
    score -= Math.min(found - candidateIndex, 10);
    positions.push(found);
    candidateIndex = found + 1;
  }
  // Shorter candidates rank above longer ones at equal hit quality.
  score -= Math.floor(candidate.length / 10);
  return { score, positions };
}

/**
 * Matches `query` as a subsequence of `candidate`, greedily preferring
 * word-boundary starts. The boundary preference can overshoot (jumping
 * ahead to a later word and starving the rest of the query, as in
 * matching `toggle outline` against `Toggle outline`), so a plain
 * first-occurrence pass backs it up: first-fit is complete for
 * subsequence testing, which makes the combination reject a candidate
 * only when the query is truly not a subsequence. Of the passes that
 * succeed, the better-scoring one wins. An empty query matches
 * everything with score 0.
 */
export function fuzzyMatch(
  query: string,
  candidate: string,
): FuzzyMatch | null {
  if (query.length === 0) {
    return { score: 0, positions: [] };
  }
  const lowerQuery = query.toLowerCase();
  const lowerCandidate = candidate.toLowerCase();
  const boundary = matchWith(lowerQuery, candidate, lowerCandidate, true);
  const plain = matchWith(lowerQuery, candidate, lowerCandidate, false);
  if (boundary === null) {
    return plain;
  }
  if (plain === null || boundary.score >= plain.score) {
    return boundary;
  }
  return plain;
}

/** A segment of text, marked when it belongs to a match highlight. */
export type TextSegment = { text: string; highlighted: boolean };

/**
 * Splits `text` into plain and highlighted segments from matched
 * character positions. Views render segments as text nodes, never HTML.
 */
export function segmentByPositions(
  text: string,
  positions: readonly number[],
): TextSegment[] {
  const matched = new Set(positions);
  const segments: TextSegment[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const highlighted = matched.has(index);
    const last = segments[segments.length - 1];
    if (last !== undefined && last.highlighted === highlighted) {
      last.text += text[index] ?? "";
    } else {
      segments.push({ text: text[index] ?? "", highlighted });
    }
  }
  return segments;
}

/** One catalog tag with its aggregate usage across the vault. */
export type TagCandidate = {
  /** Tag text without the leading hash, in the vault's own spelling. */
  tag: string;
  /** Notes carrying the tag or a tag below it in the path, once each. */
  noteCount: number;
  /** Occurrences of the tag and of every tag below it, across the vault. */
  occurrenceCount: number;
};

/**
 * How well a tag answers the query. A tag belongs to exactly one band, the
 * highest it qualifies for, and bands never interleave: `exact` is the tag
 * itself, `descendant` is a tag below it in the path, `prefix` is a tag or a
 * path segment starting with it, and `near` is a tag that contains it or
 * differs from it by a typo.
 */
export type TagBand = "exact" | "descendant" | "prefix" | "near";

/** A matched tag, its band, and the span of its text the query matched. */
export type TagMatch = {
  entry: TagCandidate;
  band: TagBand;
  /**
   * `[from, to)` over the tag text, or null when no contiguous span honestly
   * corresponds to the query. Typo matches carry none: marking scattered
   * letters reads as spell-check underlining rather than as matching.
   */
  highlight: readonly [number, number] | null;
};

/** Rows a near-match band ever contributes. */
const NEAR_MATCH_LIMIT = 5;

/** What matching a query produced, split by whether it answers the query. */
export type TagMatches = {
  /** Bands 1 through 3, ordered, bounded by the caller's `limit`. */
  primary: TagMatch[];
  /** How many tags bands 1 through 3 hold, before that bound. */
  primaryCount: number;
  /** Band 4, ordered, never more than five rows. */
  near: TagMatch[];
};

/**
 * The query a tag search actually runs: `*` removed wherever it appears, any
 * leading hash dropped, and the rest lowercased for comparison.
 *
 * A character that cannot occur in a tag cannot be a literal in a tag query.
 * `*` is the one such character a reader types with intent, that intent is
 * "match more than what I typed", and prefix matching already grants it, so
 * `feat`, `feat*` and `*feat` are one query with one result list.
 */
export function tagQueryText(query: string): string {
  const stripped = query.replaceAll("*", "");
  return (stripped.startsWith("#") ? stripped.slice(1) : stripped)
    .trim()
    .toLowerCase();
}

/**
 * The typo tolerance a query of `length` characters earns. Short queries get
 * none, because at two characters almost every tag in a vault is within one
 * edit and the band becomes a random sample.
 */
function maxTypoDistance(length: number): number {
  if (length <= 2) {
    return 0;
  }
  return length <= 5 ? 1 : 2;
}

/**
 * Optimal string alignment distance (Damerau-Levenshtein restricted to
 * non-overlapping transpositions), abandoned as soon as every alignment
 * exceeds `max`. Returns null when the strings are further apart than that.
 */
function boundedEditDistance(
  left: string,
  right: string,
  max: number,
): number | null {
  if (Math.abs(left.length - right.length) > max) {
    return null;
  }
  let beforePrevious: number[] = [];
  let previous: number[] = Array.from(
    { length: right.length + 1 },
    (_value, index) => index,
  );
  for (let row = 1; row <= left.length; row += 1) {
    const current: number[] = new Array(right.length + 1);
    current[0] = row;
    let best = row;
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      let value = Math.min(
        (previous[column] ?? Number.MAX_SAFE_INTEGER) + 1,
        (current[column - 1] ?? Number.MAX_SAFE_INTEGER) + 1,
        (previous[column - 1] ?? Number.MAX_SAFE_INTEGER) + cost,
      );
      if (
        row > 1 &&
        column > 1 &&
        left[row - 1] === right[column - 2] &&
        left[row - 2] === right[column - 1]
      ) {
        value = Math.min(
          value,
          (beforePrevious[column - 2] ?? Number.MAX_SAFE_INTEGER) + 1,
        );
      }
      current[column] = value;
      best = Math.min(best, value);
    }
    if (best > max) {
      return null;
    }
    beforePrevious = previous;
    previous = current;
  }
  const distance = previous[right.length] ?? Number.MAX_SAFE_INTEGER;
  return distance <= max ? distance : null;
}

/** How many `/`-separated segments `tag` has. */
function segmentCount(tag: string): number {
  let count = 1;
  for (
    let index = tag.indexOf("/");
    index >= 0;
    index = tag.indexOf("/", index + 1)
  ) {
    count += 1;
  }
  return count;
}

/**
 * Tag ordering, and the last tiebreak in every band. It exists so that no
 * comparison ends in "equal" and an identical query renders an identical
 * order, and it never decides anything a usage difference already decided.
 */
const TAG_COLLATOR = new Intl.Collator(undefined, { sensitivity: "variant" });

type RankedTag = {
  entry: TagCandidate;
  band: TagBand;
  highlight: readonly [number, number] | null;
  /** Ordering key inside the band: depth, then prefix kind, then distance. */
  rank: number;
};

/** Note count descending, then tag ascending, so the order is always total. */
function byUsage(left: RankedTag, right: RankedTag): number {
  const notes = right.entry.noteCount - left.entry.noteCount;
  return notes !== 0
    ? notes
    : TAG_COLLATOR.compare(left.entry.tag, right.entry.tag);
}

function byRankThenUsage(left: RankedTag, right: RankedTag): number {
  return left.rank !== right.rank
    ? left.rank - right.rank
    : byUsage(left, right);
}

/** Bands 1 through 3: the answer to the query. */
function primaryMatch(
  entry: TagCandidate,
  normalized: string,
  query: string,
): RankedTag | null {
  if (query.length === 0) {
    return { entry, band: "prefix", highlight: null, rank: 0 };
  }
  if (normalized === query) {
    return {
      entry,
      band: "exact",
      highlight: [0, query.length],
      rank: 0,
    };
  }
  if (normalized.startsWith(query)) {
    return normalized[query.length] === "/"
      ? {
          entry,
          band: "descendant",
          highlight: [0, query.length],
          rank: segmentCount(normalized),
        }
      : { entry, band: "prefix", highlight: [0, query.length], rank: 0 };
  }
  for (
    let slash = normalized.indexOf("/");
    slash >= 0;
    slash = normalized.indexOf("/", slash + 1)
  ) {
    if (normalized.startsWith(query, slash + 1)) {
      // A segment prefix is a weaker answer than a whole-tag prefix, so it
      // sits below every one of those inside the same band.
      return {
        entry,
        band: "prefix",
        highlight: [slash + 1, slash + 1 + query.length],
        rank: 1,
      };
    }
  }
  return null;
}

/**
 * Band 4: tags that contain what was typed, then tags a typo away from it.
 *
 * A typo candidate must share the query's first character, because a typo
 * there is rare while allowing one makes every short tag a candidate for
 * every short query. The typo comparison runs against the whole tag and
 * against its last path segment, and against nothing else: the last segment
 * is the tag's own name and the ones before it are its namespace, so a query
 * a typo away from a namespace has not named the tag. Admitting those would
 * return `feature/long-document` for `featrue`, which no reader can place
 * under "differs from what I typed by a typo".
 */
function nearMatch(
  entry: TagCandidate,
  normalized: string,
  query: string,
): RankedTag | null {
  const contained = normalized.indexOf(query);
  if (contained >= 0) {
    return {
      entry,
      band: "near",
      highlight: [contained, contained + query.length],
      rank: 0,
    };
  }
  const max = maxTypoDistance(query.length);
  if (max === 0) {
    return null;
  }
  const leaf = normalized.slice(normalized.lastIndexOf("/") + 1);
  let best: number | null = null;
  if (leaf[0] === query[0]) {
    best = boundedEditDistance(query, leaf, max);
  }
  if (normalized[0] === query[0]) {
    const whole = boundedEditDistance(query, normalized, max);
    if (whole !== null && (best === null || whole < best)) {
      best = whole;
    }
  }
  return best === null
    ? null
    : { entry, band: "near", highlight: null, rank: 1 + best };
}

const BAND_ORDER: Record<TagBand, number> = {
  exact: 0,
  descendant: 1,
  prefix: 2,
  near: 3,
};

/**
 * Offers `candidate` to an ordered list holding at most `limit` entries, and
 * reports whether it earned a place. `keep` supplies the entry to store, so a
 * caller can drive the selection from one reused object and allocate only for
 * the rows that survive.
 *
 * Ordering a whole band and then discarding all but the first screen makes
 * every keystroke pay for rows nobody sees, and the comparison that ends in a
 * locale-aware collation is the expensive one. Selecting instead costs one
 * comparison per candidate in the common case, so a vault with thousands of
 * tags answers a keystroke in the time a vault with dozens does.
 */
function offerBounded<Item>(
  best: Item[],
  candidate: Item,
  limit: number,
  compare: (left: Item, right: Item) => number,
  keep: (item: Item) => Item,
): void {
  const last = best[best.length - 1];
  if (
    best.length >= limit &&
    last !== undefined &&
    compare(candidate, last) >= 0
  ) {
    return;
  }
  let index = best.length;
  while (index > 0 && compare(candidate, best[index - 1] as Item) < 0) {
    index -= 1;
  }
  best.splice(index, 0, keep(candidate));
  if (best.length > limit) {
    best.length = limit;
  }
}

/**
 * Places every catalog tag matching `query` into its band, ordered by band
 * and then by how much the vault uses the tag. Usage rather than alphabet:
 * inside a band structural relevance is equal by construction, so the
 * question left is which of these the reader is more likely to mean, and note
 * count answers it. Note count rather than occurrence count, because a tag
 * written eleven times in one note is not more important than one written
 * once in each of nine notes, and the next step is a list of notes.
 *
 * `query` may carry a leading hash and any number of `*` characters; both are
 * removed first. The near-match band is capped at five rows, and is omitted
 * entirely when `nearMatches` is false: search tolerates typos, authoring
 * must not propose them.
 */
export function matchTags(
  catalog: readonly TagCandidate[],
  query: string,
  {
    nearMatches = true,
    limit = Number.POSITIVE_INFINITY,
    recencyOf,
  }: {
    nearMatches?: boolean;
    limit?: number;
    /**
     * How recently the tag was used, lower being more recent. Applied among
     * tags a band ranks equally, ahead of note count: it separates answers
     * the query cannot separate, and never promotes a weaker answer over a
     * stronger one. A recent segment-prefix match reordered above a
     * whole-tag prefix match would move the row under Enter for a reason the
     * reader can neither see in the query nor predict. It has to be part of
     * the ordering rather than a pass over the result, or a bounded
     * selection would drop a recent tag before it could be promoted.
     */
    recencyOf?: (tag: string) => number;
  } = {},
): TagMatches {
  const normalizedQuery = tagQueryText(query);
  const withinBand =
    recencyOf === undefined
      ? byRankThenUsage
      : (left: RankedTag, right: RankedTag) => {
          if (left.rank !== right.rank) {
            return left.rank - right.rank;
          }
          const leftRecency = recencyOf(left.entry.tag);
          const rightRecency = recencyOf(right.entry.tag);
          if (leftRecency !== rightRecency) {
            return leftRecency < rightRecency ? -1 : 1;
          }
          return byUsage(left, right);
        };
  const ordered = (left: RankedTag, right: RankedTag) =>
    BAND_ORDER[left.band] - BAND_ORDER[right.band] || withinBand(left, right);
  const keep = (match: RankedTag): RankedTag => ({ ...match });
  const seen = new Set<string>();
  const primary: RankedTag[] = [];
  const near: RankedTag[] = [];
  let primaryCount = 0;
  for (const entry of catalog) {
    // The index normalizes tags with a locale-independent lowercasing, so
    // comparison here has to use the same one to reach the same tags.
    const normalized = entry.tag.toLowerCase();
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    const match = primaryMatch(entry, normalized, normalizedQuery);
    if (match !== null) {
      primaryCount += 1;
      offerBounded(primary, match, limit, ordered, keep);
      continue;
    }
    if (!nearMatches || normalizedQuery.length === 0) {
      continue;
    }
    const candidate = nearMatch(entry, normalized, normalizedQuery);
    if (candidate !== null) {
      offerBounded(near, candidate, NEAR_MATCH_LIMIT, withinBand, keep);
    }
  }
  const strip = ({ entry, band, highlight }: RankedTag): TagMatch => ({
    entry,
    band,
    highlight,
  });
  return {
    primary: primary.map(strip),
    primaryCount,
    near: near.map(strip),
  };
}
