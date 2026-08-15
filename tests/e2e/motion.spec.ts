import { $, browser, expect } from "@wdio/globals";
import {
  LF_NOTE_NAME,
  TREE_FIRST_NOTE_NAME,
  TREE_FOLDER_NAME,
  TREE_SECOND_NOTE_NAME,
} from "./scratchVault";

type Box = { left: number; top: number; width: number; height: number };
type MotionFrame = Box & {
  transitionDuration: string;
  transitionProperty: string;
};

async function openTreePath(path: string): Promise<void> {
  const row = $(`[role="treeitem"][data-path="${path}"]`);
  await row.waitForExist({ timeout: 15000 });
  await row.click();
}

async function expandFixtureFolder(): Promise<void> {
  const folder = $(`[role="treeitem"][data-path="${TREE_FOLDER_NAME}"]`);
  await folder.waitForExist({ timeout: 15000 });
  if ((await folder.getAttribute("aria-expanded")) !== "true") {
    await folder.click();
  }
  await $(
    `[role="treeitem"][data-path="${TREE_FIRST_NOTE_NAME}"]`,
  ).waitForExist({ timeout: 10000 });
}

async function beginMotionCapture(selector: string, count = 12): Promise<void> {
  await browser.execute(
    `
      const target = arguments[0];
      const requested = arguments[1];
      const capture = { frames: [], complete: false };
      window.__SKRIBEUM_MOTION_CAPTURE__ = capture;
      const sample = () => {
        const element = document.querySelector(target);
        if (element !== null) {
          const box = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          // During a retarget, WebKit can report an intermediate zero-area
          // box before the compositor paints the next indicator frame. It has
          // no pixels, so it cannot represent a visible jump. Each retained
          // frame remains subject to the rendered-geometry assertion below.
          if (
            Number.parseFloat(style.opacity) > 0 &&
            box.width > 0 &&
            box.height > 0
          ) {
            capture.frames.push({
              left: box.left,
              top: box.top,
              width: box.width,
              height: box.height,
              transitionDuration: style.transitionDuration,
              transitionProperty: style.transitionProperty,
            });
          }
        }
        if (capture.frames.length >= requested) capture.complete = true;
        else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    `,
    selector,
    count,
  );
}

async function completedMotionCapture(): Promise<MotionFrame[]> {
  await browser.waitUntil(
    () =>
      browser.execute(
        () =>
          (
            window as Window & {
              __SKRIBEUM_MOTION_CAPTURE__?: { complete: boolean };
            }
          ).__SKRIBEUM_MOTION_CAPTURE__?.complete === true,
      ),
    { timeoutMsg: "motion frame capture did not complete" },
  );
  return browser.execute(`
    const frames = window.__SKRIBEUM_MOTION_CAPTURE__?.frames ?? [];
    delete window.__SKRIBEUM_MOTION_CAPTURE__;
    return frames;
  `);
}

async function renderedBox(selector: string): Promise<Box> {
  const box = await browser.execute((target) => {
    const element = document.querySelector(target);
    if (element === null) return null;
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
  }, selector);
  if (box === null) throw new Error(`${selector} is not rendered`);
  return box;
}

async function renderedTabShellBox(selector: string): Promise<Box> {
  const box = await browser.execute((target) => {
    const tab = document.querySelector(target);
    const shell = tab?.closest<HTMLElement>(".skr-tab-shell");
    if (shell === null || shell === undefined) return null;
    const rect = shell.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
  }, selector);
  if (box === null) throw new Error(`${selector} has no tab shell`);
  return box;
}

async function setViewport(width: number, height: number): Promise<void> {
  let outerWidth = width;
  let outerHeight = height;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await browser.setWindowSize(outerWidth, outerHeight);
    const actual = await browser.executeAsync<
      { width: number; height: number },
      []
    >((done) => {
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          done({ width: window.innerWidth, height: window.innerHeight }),
        ),
      );
    });
    if (actual.width === width && actual.height === height) return;
    outerWidth += width - actual.width;
    outerHeight += height - actual.height;
  }
  throw new Error(`viewport did not reach ${width}×${height}`);
}

function expectRenderedBoxes(boxes: Box[], count = 12): void {
  expect(boxes).toHaveLength(count);
  for (const box of boxes) {
    expect(Number.isFinite(box.left)).toBe(true);
    expect(Number.isFinite(box.top)).toBe(true);
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
  }
}

function expectAnimatedTrajectory(
  boxes: Box[],
  axis: keyof Pick<Box, "left" | "top">,
): void {
  expectRenderedBoxes(boxes);
  expect(
    new Set(boxes.map((box) => Math.round(box[axis]))).size,
  ).toBeGreaterThan(1);
}

function expectContinuousTrajectory(
  boxes: Box[],
  axis: keyof Pick<Box, "left" | "top">,
  source: number,
  target: number,
): void {
  expectRenderedBoxes(boxes);
  const coordinates = boxes.map((box) => box[axis]);
  const first = coordinates[0];
  const last = coordinates.at(-1);
  if (first === undefined || last === undefined) {
    throw new Error("motion trajectory has no sampled coordinates");
  }
  const distance = target - source;
  expect(Math.abs(distance)).toBeGreaterThan(1);
  expect(Math.abs(last - target)).toBeLessThan(1);
  expect(Math.abs(first - source)).toBeLessThan(1);
  expect(
    new Set(coordinates.map((coordinate) => Math.round(coordinate))).size,
  ).toBeGreaterThan(2);

  const direction = Math.sign(distance);
  const deltas = coordinates
    .slice(1)
    .map(
      (coordinate, index) => coordinate - (coordinates[index] ?? coordinate),
    );
  const materialDeltas = deltas.filter((delta) => Math.abs(delta) > 0.1);
  expect(materialDeltas).not.toHaveLength(0);
  expect(materialDeltas.every((delta) => direction * delta > 0)).toBe(true);
  expect(Math.max(...materialDeltas.map(Math.abs))).toBeLessThan(
    Math.abs(distance),
  );
  expect(
    coordinates.every(
      (coordinate) =>
        coordinate >= Math.min(source, target) - 1 &&
        coordinate <= Math.max(source, target) + 1,
    ),
  ).toBe(true);
}

async function animationsCanTravel(): Promise<boolean> {
  return browser.execute(`
    document.documentElement.dataset.animations !== "false" &&
    !matchMedia("(prefers-reduced-motion: reduce)").matches
  `);
}

async function selectTreePath(path: string): Promise<void> {
  await openTreePath(path);
  await browser.waitUntil(
    () =>
      browser.execute(
        (selectedPath) =>
          document
            .querySelector<HTMLElement>(
              `[role="treeitem"][data-path="${CSS.escape(selectedPath)}"]`,
            )
            ?.getAttribute("aria-selected") === "true",
        path,
      ),
    { timeoutMsg: `${path} did not become the active tree row` },
  );
}

async function treeMotionEvidence(sourcePath: string, targetPath: string) {
  return browser.execute(
    `
      const source = arguments[0];
      const target = arguments[1];
      const row = (path) => document.querySelector(
        '[role="treeitem"][data-path="' + CSS.escape(path) + '"]',
      );
      const rectangle = (element) => {
        if (element === null) return null;
        const box = element.getBoundingClientRect();
        return { left: box.left, top: box.top, width: box.width, height: box.height };
      };
      const sourceRow = row(source);
      const targetRow = row(target);
      const highlight = document.querySelector('.skr-tree-active-highlight');
      const root = getComputedStyle(document.documentElement);
      return {
        actionTarget: targetRow === null ? null : {
          dataPath: targetRow.dataset.path || null,
          role: targetRow.getAttribute('role'),
          selected: targetRow.getAttribute('aria-selected'),
        },
        highlight: highlight === null ? null : {
          transitionDuration: getComputedStyle(highlight).transitionDuration,
          transitionProperty: getComputedStyle(highlight).transitionProperty,
        },
        motionVariables: {
          panelDuration: root.getPropertyValue('--skr-motion-panel-duration').trim(),
          panelEasing: root.getPropertyValue('--skr-motion-panel-easing').trim(),
          stateDuration: root.getPropertyValue('--skr-motion-state-duration').trim(),
        },
        source: rectangle(sourceRow),
        target: rectangle(targetRow),
      };
    `,
    sourcePath,
    targetPath,
  );
}

describe("packaged motion geometry", () => {
  before(async () => {
    await browser.tauri.switchWindow("main");
    await browser.setWindowSize(1280, 800);
    await browser.execute(() => {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("skribeum.workspace.")) {
          localStorage.removeItem(key);
        }
      }
    });
    await browser.refresh();
    await $("[role=tree]").waitForExist({ timeout: 15000 });
  });

  after(async () => {
    await browser.execute(() => {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("skribeum.workspace.")) {
          localStorage.removeItem(key);
        }
      }
    });
    await browser.refresh();
    await $("[role=tree]").waitForExist({ timeout: 15000 });
  });

  it("retargets tree A to B to C before settle without losing current position", async () => {
    await expandFixtureFolder();
    await selectTreePath(TREE_FIRST_NOTE_NAME);
    const treeBefore = await treeMotionEvidence(
      TREE_FIRST_NOTE_NAME,
      TREE_SECOND_NOTE_NAME,
    );
    expect(treeBefore.actionTarget).toEqual({
      dataPath: TREE_SECOND_NOTE_NAME,
      role: "treeitem",
      selected: "false",
    });
    expect(treeBefore.source).not.toBeNull();
    expect(treeBefore.target).not.toBeNull();
    if (treeBefore.source === null || treeBefore.target === null) {
      throw new Error("tree motion source or target row is unavailable");
    }
    await openTreePath(TREE_SECOND_NOTE_NAME);
    await browser.waitUntil(
      () =>
        browser.execute(
          (path) =>
            document
              .querySelector<HTMLElement>(
                `[role="treeitem"][data-path="${CSS.escape(path)}"]`,
              )
              ?.getAttribute("aria-selected") === "true",
          TREE_SECOND_NOTE_NAME,
        ),
      { timeoutMsg: `${TREE_SECOND_NOTE_NAME} did not become active` },
    );
    await browser.pause(24);
    const beforeRetarget = await renderedBox(".skr-tree-active-highlight");
    const targetRow = await renderedBox(
      `[role="treeitem"][data-path="${LF_NOTE_NAME}"]`,
    );
    await beginMotionCapture(".skr-tree-active-highlight");
    await openTreePath(LF_NOTE_NAME);
    await browser.waitUntil(
      () =>
        browser.execute(
          (path) =>
            document
              .querySelector<HTMLElement>(
                `[role="treeitem"][data-path="${CSS.escape(path)}"]`,
              )
              ?.getAttribute("aria-selected") === "true",
          LF_NOTE_NAME,
        ),
      { timeoutMsg: `${LF_NOTE_NAME} did not become active` },
    );
    const treeFrames = await completedMotionCapture();
    expectRenderedBoxes(treeFrames);
    if (await animationsCanTravel()) {
      expect(treeBefore.motionVariables.panelDuration).not.toBe("0ms");
      expect(
        treeFrames.some(
          (frame) =>
            frame.transitionProperty.includes("transform") &&
            frame.transitionDuration !== "0s",
        ),
      ).toBe(true);
      expectContinuousTrajectory(
        treeFrames,
        "top",
        beforeRetarget.top,
        targetRow.top,
      );
      const first = treeFrames[0];
      if (first === undefined)
        throw new Error("tree motion has no first frame");
      expect(Math.abs(first.top - beforeRetarget.top)).toBeLessThan(1);
      expect(
        Math.abs(beforeRetarget.top - treeBefore.target.top),
      ).toBeGreaterThan(1);
    }

    await selectTreePath(TREE_FIRST_NOTE_NAME);
    await selectTreePath(TREE_SECOND_NOTE_NAME);
    const tabCount = await browser.execute(
      () => document.querySelectorAll('[role="tab"]').length,
    );
    const tabs = await $$('[role="tab"]');
    const penultimateTab = tabs[tabCount - 2];
    const finalTab = tabs[tabCount - 1];
    if (penultimateTab === undefined || finalTab === undefined) {
      throw new Error("tab retarget fixture is unavailable");
    }
    await beginMotionCapture(".skr-tab-active-indicator");
    await penultimateTab.click();
    await browser.pause(24);
    await finalTab.click();
    const tabFrames = await completedMotionCapture();
    expectRenderedBoxes(tabFrames);
    if (await animationsCanTravel()) {
      expectAnimatedTrajectory(tabFrames, "left");
    }
  });

  it("reverses a folder reveal without losing rendered sibling geometry", async () => {
    await expandFixtureFolder();
    const siblingPath = await browser.execute((folderPath) => {
      const rows = Array.from(
        document.querySelectorAll<HTMLElement>('[role="treeitem"][data-path]'),
      );
      const folderIndex = rows.findIndex(
        (element) => element.dataset.path === folderPath,
      );
      return rows.slice(folderIndex + 1).find((element) => {
        const path = element.dataset.path;
        return (
          path !== undefined &&
          path !== folderPath &&
          !path.startsWith(`${folderPath}/`)
        );
      })?.dataset.path;
    }, TREE_FOLDER_NAME);
    if (siblingPath === undefined) {
      throw new Error("folder reveal fixture is unavailable");
    }
    const folder = $(`[role="treeitem"][data-path="${TREE_FOLDER_NAME}"]`);
    await beginMotionCapture(`[role="treeitem"][data-path="${siblingPath}"]`);
    await folder.click();
    await browser.pause(24);
    await folder.click();
    const captured = await completedMotionCapture();
    expectRenderedBoxes(captured);
    if (await animationsCanTravel()) {
      expectAnimatedTrajectory(captured, "top");
    }
  });

  it("samples active-tab rectangles before, during, and after a real resize", async () => {
    await setViewport(1200, 640);
    await expandFixtureFolder();
    await selectTreePath(TREE_FIRST_NOTE_NAME);
    await selectTreePath(TREE_SECOND_NOTE_NAME);
    await selectTreePath(LF_NOTE_NAME);
    const targetIndex = await browser.execute(() => {
      const tabs = [...document.querySelectorAll<HTMLElement>('[role="tab"]')];
      const activeIndex = tabs.findIndex(
        (tab) => tab.getAttribute("aria-selected") === "true",
      );
      return activeIndex === 0 ? 1 : 0;
    });
    const targetTab = (await $$('[role="tab"]'))[targetIndex];
    if (targetTab === undefined) {
      throw new Error("tab resize fixture is unavailable");
    }
    await targetTab.waitForDisplayed({ timeout: 10000 });
    const targetId = await targetTab.getAttribute("id");
    if (targetId === null) throw new Error("tab resize fixture has no id");
    const targetSelector = `#${targetId}`;
    await beginMotionCapture(".skr-tab-active-indicator", 24);
    await targetTab.click();
    await browser.pause(24);
    const before = await renderedBox(".skr-tab-active-indicator");
    const beforeTarget = await renderedTabShellBox(targetSelector);
    await setViewport(1040, 640);
    const during = await renderedBox(".skr-tab-active-indicator");
    const duringTarget = await renderedTabShellBox(targetSelector);
    await browser.pause(220);
    const after = await renderedBox(".skr-tab-active-indicator");
    const afterTarget = await renderedTabShellBox(targetSelector);
    const captured = await completedMotionCapture();
    expectRenderedBoxes(captured, 24);
    expectRenderedBoxes([before, during, after], 3);
    expectRenderedBoxes([beforeTarget, duringTarget, afterTarget], 3);
    if (await animationsCanTravel()) {
      expectContinuousTrajectory(
        captured,
        "left",
        before.left,
        duringTarget.left,
      );
    }
    expect(Math.abs(after.left - afterTarget.left)).toBeLessThan(1);
    expect(Math.abs(after.width - afterTarget.width)).toBeLessThan(1);
    await setViewport(1200, 640);
  });
});
