// Fuzzy subsequence matching for the palette, quick switcher and slash
// menu: case-insensitive, scoring word-boundary and consecutive hits,
// returning matched positions so views can highlight without markup
// injection.

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
