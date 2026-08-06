/** A `$state`-backed props object mount() can receive so a test can mutate
 * individual fields after the initial mount and have the component react,
 * the same way a parent component's own reactive props would update a
 * child. Runes only compile in `.svelte.js`/`.svelte.ts` modules, hence this
 * file living apart from the plain `.test.ts` files that use it. */
export function reactiveProps<T extends Record<string, unknown>>(
  initial: T,
): T {
  const state = $state(initial);
  return state;
}
