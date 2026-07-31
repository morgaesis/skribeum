import { describe, expect, it } from "vitest";
import {
  canvasFilePaths,
  edgePoint,
  parseCanvas,
} from "../../src/lib/rendering/canvas";

const SOURCE = JSON.stringify({
  nodes: [
    {
      id: "text",
      type: "text",
      text: "Idea",
      x: -40,
      y: 25,
      width: 180,
      height: 90,
    },
    {
      id: "file",
      type: "file",
      file: "notes/source.md",
      x: 320,
      y: 180,
      width: 240,
      height: 140,
    },
  ],
  edges: [
    {
      id: "edge",
      fromNode: "text",
      fromSide: "right",
      toNode: "file",
      toSide: "left",
    },
  ],
});

describe("JSON Canvas rendering model", () => {
  it("preserves stored node geometry exactly", () => {
    const canvas = parseCanvas(SOURCE);
    expect(canvas.nodes[0]).toMatchObject({
      x: -40,
      y: 25,
      width: 180,
      height: 90,
    });
    expect(canvas.nodes[1]).toMatchObject({
      x: 320,
      y: 180,
      width: 240,
      height: 140,
    });
    expect(canvasFilePaths(canvas)).toEqual(["notes/source.md"]);
  });

  it("anchors edges to stored card rectangles", () => {
    const canvas = parseCanvas(SOURCE);
    const first = canvas.nodes[0];
    const second = canvas.nodes[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;
    expect(edgePoint(first, "right")).toEqual({ x: 140, y: 70 });
    expect(edgePoint(second, "left")).toEqual({ x: 320, y: 250 });
  });

  it("rejects malformed geometry and dangling edges", () => {
    expect(() => parseCanvas('{"nodes":[],"edges":"no"}')).toThrow(
      /node and edge arrays/,
    );
    expect(() =>
      parseCanvas(
        JSON.stringify({
          nodes: [
            {
              id: "x",
              type: "text",
              text: "x",
              x: 0,
              y: 0,
              width: 0,
              height: 1,
            },
          ],
          edges: [],
        }),
      ),
    ).toThrow(/invalid geometry/);
    expect(() =>
      parseCanvas(
        JSON.stringify({
          nodes: [],
          edges: [{ id: "e", fromNode: "a", toNode: "b" }],
        }),
      ),
    ).toThrow(/invalid endpoints/);
  });
});
