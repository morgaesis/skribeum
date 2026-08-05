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
  void element.offsetWidth;
  element.dataset.motionEntered = "true";
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

/** Runs the state-class opacity exit before its owner removes the surface. */
export async function exitMotionSurface(
  element: HTMLElement,
  complete?: () => void,
): Promise<void> {
  element.dataset.motionExiting = "true";
  const duration = longestTransitionMilliseconds(element);
  if (duration === 0) {
    complete?.();
    return;
  }
  await new Promise<void>((resolve) => {
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
