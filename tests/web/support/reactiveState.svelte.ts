/** Returns a `$state` proxy so plain `.test.ts` files can mutate mounted-component props reactively. */
export function reactiveState<T extends object>(initial: T): T {
  let state = $state(initial);
  return state;
}
