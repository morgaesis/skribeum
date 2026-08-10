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
          capture.frames.push({
            left: box.left,
            top: box.top,
            width: box.width,
            height: box.height,
            transitionDuration: style.transitionDuration,
            transitionProperty: style.transitionProperty,
          });
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
        if (key.startsWith("skribeum.workspace.v1.")) {
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
        if (key.startsWith("skribeum.workspace.v1.")) {
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
    const penultimateTab = $(`[role="tab"]:nth-of-type(${tabCount - 1})`);
    const finalTab = $(`[role="tab"]:nth-of-type(${tabCount})`);
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
    const targetSelector = `[role="tab"]:nth-of-type(${targetIndex + 1})`;
    const targetTab = $(targetSelector);
    await targetTab.waitForDisplayed({ timeout: 10000 });
    await beginMotionCapture(".skr-tab-active-indicator", 24);
    await targetTab.click();
    await browser.pause(24);
    const before = await renderedBox(".skr-tab-active-indicator");
    const beforeTarget = await renderedBox(targetSelector);
    await browser.setWindowSize(1060, 800);
    const during = await renderedBox(".skr-tab-active-indicator");
    const duringTarget = await renderedBox(targetSelector);
    await browser.pause(220);
    const after = await renderedBox(".skr-tab-active-indicator");
    const afterTarget = await renderedBox(targetSelector);
    const captured = await completedMotionCapture();
    expectRenderedBoxes(captured, 24);
    expectRenderedBoxes([before, during, after], 3);
    expectRenderedBoxes([beforeTarget, duringTarget, afterTarget], 3);
    if (await animationsCanTravel()) {
      expect(Math.abs(before.left - during.left)).toBeLessThan(1);
    }
    expect(Math.abs(after.left - afterTarget.left)).toBeLessThan(1);
    expect(Math.abs(after.width - afterTarget.width)).toBeLessThan(1);
    await browser.setWindowSize(1280, 800);
  });
});
