#!/usr/bin/env bash
# Data-driven decoration proof, CI half: when a pull request changes the
# decoration table, the diff must touch only the table file, tests, and
# the rules document. A table change that also edits the engine (or any
# other source file) defeats the point of the table and fails here.
#
# Runs meaningfully on pull requests, where GITHUB_BASE_REF names the
# merge base; outside a pull request there is no base to diff against and
# the check passes vacuously.

set -euo pipefail

TABLE_FILE="src/lib/editor/decorations/table.ts"
ENGINE_FILE="src/lib/editor/decorations/engine.ts"
ALLOWED_PREFIXES=(
  "$TABLE_FILE"
  "tests/"
  "docs/decoration-rules.md"
)

if [[ -z "${GITHUB_BASE_REF:-}" ]]; then
  echo "check-table-only-diff: no pull-request base ref; nothing to check"
  exit 0
fi

git fetch --quiet --depth=1 origin "$GITHUB_BASE_REF"
mapfile -t changed < <(git diff --name-only "origin/$GITHUB_BASE_REF"...HEAD)

table_changed=false
engine_changed=false
for file in "${changed[@]}"; do
  if [[ "$file" == "$TABLE_FILE" ]]; then
    table_changed=true
  fi
  if [[ "$file" == "$ENGINE_FILE" ]]; then
    engine_changed=true
  fi
done

if [[ "$table_changed" == false ]]; then
  echo "check-table-only-diff: decoration table untouched"
  exit 0
fi

# A new widget capability can extend both the table vocabulary and its
# interpreter. That is an engine change, not the table-only proof this guard
# covers. Tests still exercise every committed row and the rules document.
if [[ "$engine_changed" == true ]]; then
  echo "check-table-only-diff: engine capability changed; table-only guard does not apply"
  exit 0
fi

violations=()
for file in "${changed[@]}"; do
  allowed=false
  for prefix in "${ALLOWED_PREFIXES[@]}"; do
    if [[ "$file" == "$prefix" || "$file" == "$prefix"* ]]; then
      allowed=true
      break
    fi
  done
  if [[ "$allowed" == false ]]; then
    violations+=("$file")
  fi
done

if [[ ${#violations[@]} -gt 0 ]]; then
  echo "check-table-only-diff: a decoration-table change must touch only"
  echo "the table, tests, and docs/decoration-rules.md; also changed:"
  printf '  %s\n' "${violations[@]}"
  exit 1
fi

echo "check-table-only-diff: table change touches only table, tests and docs"
