// A `$state` proxy needs Svelte compilation, which plain `.test.ts` files do
// not get. This module file (`.svelte.ts`) does, so tests that need to
// mutate a mounted component's props after the fact (simulating a parent
// re-render) build their props object here and mutate it from ordinary test
// code afterward; the returned proxy stays reactive regardless of which
// file reads or writes it.
export function reactiveState<T extends Record<string, unknown>>(
  initial: T,
): T {
  let state = $state(initial);
  return state;
}
