// jsdom performs no layout, but CodeMirror's view layer expects the DOM
// measurement surfaces to exist. The stubs below return empty geometry,
// which is enough for component-level tests that assert on documents,
// selections and history rather than pixels.

const emptyRect: DOMRect = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  width: 0,
  height: 0,
  toJSON: () => ({}),
};

Range.prototype.getBoundingClientRect = () => emptyRect;
Range.prototype.getClientRects = () => {
  const rects = [] as unknown as DOMRectList;
  (rects as unknown as { item: (index: number) => DOMRect | null }).item = () =>
    null;
  return rects;
};

if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver =
    ResizeObserverStub as unknown as typeof ResizeObserver;
}
