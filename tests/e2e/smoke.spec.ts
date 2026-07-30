import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { $, browser, expect } from "@wdio/globals";
import { M0_FIXTURE } from "../../src/lib/fixture";

const specDirectory = path.dirname(fileURLToPath(import.meta.url));
const screenshotDirectory = path.join(specDirectory, "screenshots");

describe("skribeum shell", () => {
  it("launches_and_renders_fixture", async () => {
    expect(await browser.getTitle()).toBe("Skribeum");

    const editorContent = $(".cm-content");
    await editorContent.waitForExist({ timeout: 15000 });

    // CodeMirror renders one div per line; getText joins them with newlines.
    // Compare against the fixture line by line so webview-specific whitespace
    // handling of empty lines cannot cause false failures.
    const renderedText = await editorContent.getText();
    for (const line of M0_FIXTURE.split("\n")) {
      if (line.trim() !== "") {
        expect(renderedText).toContain(line);
      }
    }

    mkdirSync(screenshotDirectory, { recursive: true });
    await browser.saveScreenshot(path.join(screenshotDirectory, "smoke.png"));
  });
});
