export type PaneSwitchKind = "note" | "history" | "tab";

function cssTimeMilliseconds(value: string): number {
  const trimmed = value.trim();
  if (trimmed.endsWith("ms")) {
    return Number.parseFloat(trimmed);
  }
  if (trimmed.endsWith("s")) {
    return Number.parseFloat(trimmed) * 1000;
  }
  return 0;
}

/** Reads the shared pointer-rest delay from the active theme. */
export function hoverIntentDelay(
  root: Element = document.documentElement,
): number {
  return cssTimeMilliseconds(
    getComputedStyle(root).getPropertyValue("--skr-hover-intent-delay"),
  );
}

/** Resolves a motion-class duration custom property to milliseconds. */
export function motionDurationMilliseconds(
  property:
    | "--skr-motion-state-duration"
    | "--skr-motion-surface-duration"
    | "--skr-motion-panel-duration",
  element: Element = document.documentElement,
): number {
  return cssTimeMilliseconds(
    getComputedStyle(element).getPropertyValue(property),
  );
}

/**
 * The compositor hint a surface carries while it moves. `will-change:
 * transform` promotes its element to the containing block for every
 * fixed-position descendant, so a surface holding the hint while idle
 * reparents the menus and popovers rendered inside it: a permanently mounted
 * pane would silently offset every one of them by its own origin. The hint is
 * therefore held only for the length of the motion, and names only the
 * properties the surface actually animates, so an opacity-only surface never
 * asks for a transform layer at all.
 */
const motionGenerations = new WeakMap<HTMLElement, number>();

function holdMotionHint(element: HTMLElement): number {
  const generation = (motionGenerations.get(element) ?? 0) + 1;
  motionGenerations.set(element, generation);
  const variant = element.dataset.motionSurface;
  element.style.willChange =
    variant === "fade" || variant === "scrim"
      ? "opacity"
      : "opacity, transform";
  return generation;
}

function releaseMotionHint(element: HTMLElement, generation: number): void {
  if (motionGenerations.get(element) !== generation) return;
  element.style.removeProperty("will-change");
}

/** Resolves a motion-class easing custom property to its cubic function. */
export function motionEasing(
  property:
    | "--skr-motion-state-easing"
    | "--skr-motion-surface-easing"
    | "--skr-motion-panel-easing",
  element: Element = document.documentElement,
): string {
  const value = getComputedStyle(element).getPropertyValue(property).trim();
  return value === "" ? "linear" : value;
}

/** Starts an entrance after the initial compositor state has been resolved. */
export function enterMotionSurface(
  element: HTMLElement | null | undefined,
): void {
  if (element == null) return;
  delete element.dataset.motionExiting;
  element.dataset.motionEntered = "false";
  if (!element.isConnected) {
    requestAnimationFrame(() => {
      if (element.isConnected) enterMotionSurface(element);
    });
    return;
  }
  const generation = holdMotionHint(element);
  void element.offsetWidth;
  element.dataset.motionEntered = "true";
  void awaitTransition(element).then(() =>
    releaseMotionHint(element, generation),
  );
}

function longestTransitionMilliseconds(element: HTMLElement): number {
  const style = getComputedStyle(element);
  const durations = style.transitionDuration.split(",");
  const delays = style.transitionDelay.split(",");
  return Math.max(
    0,
    ...durations.map(
      (duration, index) =>
        cssTimeMilliseconds(duration) +
        cssTimeMilliseconds(delays[index % delays.length] ?? "0s"),
    ),
  );
}

/** Settles when the element's own opacity transition has finished. */
function awaitTransition(element: HTMLElement): Promise<void> {
  const duration = longestTransitionMilliseconds(element);
  if (duration === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      element.removeEventListener("transitionend", onTransitionEnd);
      element.removeEventListener("transitioncancel", onTransitionEnd);
      resolve();
    };
    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.target === element && event.propertyName === "opacity") {
        finish();
      }
    };
    const timer = setTimeout(finish, duration);
    element.addEventListener("transitionend", onTransitionEnd);
    element.addEventListener("transitioncancel", onTransitionEnd);
  });
}

/** Runs the state-class opacity exit before its owner removes the surface. */
export async function exitMotionSurface(
  element: HTMLElement,
  complete?: () => void,
): Promise<void> {
  element.dataset.motionExiting = "true";
  if (longestTransitionMilliseconds(element) === 0) {
    complete?.();
    return;
  }
  const generation = holdMotionHint(element);
  await awaitTransition(element);
  releaseMotionHint(element, generation);
  complete?.();
}

/** Completes a coordinated surface exit synchronously when motion is zero. */
export function exitMotionSurfaces(
  elements: readonly HTMLElement[],
  complete: () => void,
): void {
  if (elements.length === 0) {
    complete();
    return;
  }
  let remaining = elements.length;
  const finishOne = () => {
    remaining -= 1;
    if (remaining === 0) complete();
  };
  for (const element of elements) {
    void exitMotionSurface(element, finishOne);
  }
}
