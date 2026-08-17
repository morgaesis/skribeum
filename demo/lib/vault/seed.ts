import about from "./about.md?raw";
import demoCanvas from "./demo.canvas?raw";
import communityEventPlan from "./Examples/Community/event-plan.md?raw";
import homeKitchenNotes from "./Examples/Home/kitchen-notes.md?raw";
import homeMaintenanceLog from "./Examples/Home/maintenance-log.md?raw";
import personalGardenBeds from "./Examples/Personal/garden-beds.svg?raw";
import personalGardenLog from "./Examples/Personal/garden-log.md?raw";
import harborSketchDataUrl from "./Examples/Personal/harbor-sketch.png?inline";
import personalTravelPlan from "./Examples/Personal/travel-plan.md?raw";
import personalWeeklyReview from "./Examples/Personal/weekly-review.md?raw";
import researchInterviewNotes from "./Examples/Research/interview-notes.md?raw";
import researchLiteratureReview from "./Examples/Research/literature-review.md?raw";
import researchReadingNotes from "./Examples/Research/reading-notes.md?raw";
import workDecisionLog from "./Examples/Work/decision-log.md?raw";
import workMeetingNotes from "./Examples/Work/meeting-notes.md?raw";
import printedHandoutDataUrl from "./Examples/Work/printed-handout.pdf?inline";
import workProjectIdeas from "./Examples/Work/project-ideas.md?raw";
import blockMath from "./Features/block-math.md?raw";
import callouts from "./Features/callouts.md?raw";
import codeBlocks from "./Features/code-blocks.md?raw";
import deployPipeline from "./Features/deploy.yml?raw";
import embeds from "./Features/embeds.md?raw";
import frontmatter from "./Features/frontmatter.md?raw";
import images from "./Features/images.md?raw";
import inlineMath from "./Features/inline-math.md?raw";
import mermaidDiagram from "./Features/mermaid-diagram.md?raw";
import showcase from "./Features/showcase.md?raw";
import skribeumMark from "./Features/skribeum-mark.svg?raw";
import tables from "./Features/tables.md?raw";
import tags from "./Features/tags.md?raw";
import tasks from "./Features/tasks.md?raw";
import wikilinks from "./Features/wikilinks.md?raw";
import index from "./index.md?raw";
import quickstart from "./quickstart.md?raw";

export const DEMO_FILES: Readonly<Record<string, string>> = Object.freeze({
  ".obsidian/app.json": JSON.stringify(
    {
      newLinkFormat: "shortest",
      useMarkdownLinks: false,
    },
    null,
    2,
  ),
  ".obsidian/types.json": JSON.stringify(
    {
      types: {
        aliases: "aliases",
        date: "date",
        rating: "number",
        reviewed: "checkbox",
        status: "text",
        tags: "tags",
      },
    },
    null,
    2,
  ),
  // A vault holds files that are not notes, and every one of them opens.
  ".gitignore": [
    "# Local scratch space, never synced.",
    ".cache/",
    "drafts/*.tmp",
    "",
    "# Exported bundles.",
    "public/",
    "",
  ].join("\n"),
  "about.md": about,
  "demo.canvas": demoCanvas,
  "Examples/Community/event-plan.md": communityEventPlan,
  "Examples/Home/kitchen-notes.md": homeKitchenNotes,
  "Examples/Home/maintenance-log.md": homeMaintenanceLog,
  "Examples/Personal/garden-beds.svg": personalGardenBeds,
  "Examples/Personal/garden-log.md": personalGardenLog,
  "Examples/Personal/travel-plan.md": personalTravelPlan,
  "Examples/Personal/weekly-review.md": personalWeeklyReview,
  "Examples/Research/interview-notes.md": researchInterviewNotes,
  "Examples/Research/literature-review.md": researchLiteratureReview,
  "Examples/Research/reading-notes.md": researchReadingNotes,
  "Examples/Work/decision-log.md": workDecisionLog,
  "Examples/Work/meeting-notes.md": workMeetingNotes,
  "Examples/Work/project-ideas.md": workProjectIdeas,
  "Features/block-math.md": blockMath,
  "Features/callouts.md": callouts,
  "Features/code-blocks.md": codeBlocks,
  "Features/deploy.yml": deployPipeline,
  "Features/embeds.md": embeds,
  "Features/frontmatter.md": frontmatter,
  "Features/images.md": images,
  "Features/inline-math.md": inlineMath,
  "Features/skribeum-mark.svg": skribeumMark,
  "Features/mermaid-diagram.md": mermaidDiagram,
  "Features/showcase.md": showcase,
  "Features/tables.md": tables,
  "Features/tags.md": tags,
  "Features/tasks.md": tasks,
  "Features/wikilinks.md": wikilinks,
  "index.md": index,
  "quickstart.md": quickstart,
});

/** Decodes a `data:` URL produced by Vite's `?inline` import into raw bytes. */
function decodeInlinedAsset(dataUrl: string): Uint8Array<ArrayBuffer> {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Non-text sample assets, keyed the same way as `DEMO_FILES`. A raster image
 * cannot survive `DEMO_FILES`' UTF-8 text pipeline intact, so its bytes come
 * in through an inlined `data:` URL and are decoded once here instead. The
 * document is a file that is neither an image nor text: it opens read-only,
 * so no editing pass can write a lossy re-encoding over it.
 */
export const DEMO_BINARY_FILES: Readonly<
  Record<string, Uint8Array<ArrayBuffer>>
> = Object.freeze({
  "Examples/Personal/harbor-sketch.png":
    decodeInlinedAsset(harborSketchDataUrl),
  "Examples/Work/printed-handout.pdf": decodeInlinedAsset(
    printedHandoutDataUrl,
  ),
});

export const DEMO_INITIAL_NOTE = "quickstart.md";
