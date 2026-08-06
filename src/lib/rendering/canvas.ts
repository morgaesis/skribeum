export type CanvasSide = "top" | "right" | "bottom" | "left";

type CanvasNodeBase = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string | undefined;
};

export type CanvasNode = CanvasNodeBase &
  (
    | { type: "text"; text: string }
    | { type: "file"; file: string; subpath?: string | undefined }
  );

export type CanvasEdge = {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: CanvasSide | undefined;
  toSide?: CanvasSide | undefined;
  label?: string | undefined;
  color?: string | undefined;
};

export type CanvasDocument = {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(
  value: Record<string, unknown>,
  name: string,
): string | null {
  return typeof value[name] === "string" ? value[name] : null;
}

function numberField(
  value: Record<string, unknown>,
  name: string,
): number | null {
  const field = value[name];
  return typeof field === "number" && Number.isFinite(field) ? field : null;
}

function sideField(
  value: Record<string, unknown>,
  name: string,
): CanvasSide | undefined {
  const field = value[name];
  return field === "top" ||
    field === "right" ||
    field === "bottom" ||
    field === "left"
    ? field
    : undefined;
}

export function parseCanvas(source: string): CanvasDocument {
  const root = record(JSON.parse(source));
  if (
    root === null ||
    !Array.isArray(root.nodes) ||
    !Array.isArray(root.edges)
  ) {
    throw new Error("Canvas data must contain node and edge arrays");
  }
  const nodes: CanvasNode[] = root.nodes.map((raw, index) => {
    const value = record(raw);
    if (value === null) {
      throw new Error(`Canvas node ${index + 1} is not an object`);
    }
    const id = stringField(value, "id");
    const type = stringField(value, "type");
    const x = numberField(value, "x");
    const y = numberField(value, "y");
    const width = numberField(value, "width");
    const height = numberField(value, "height");
    if (
      id === null ||
      x === null ||
      y === null ||
      width === null ||
      height === null ||
      width <= 0 ||
      height <= 0
    ) {
      throw new Error(`Canvas node ${index + 1} has invalid geometry`);
    }
    const color = stringField(value, "color") ?? undefined;
    if (type === "text") {
      const text = stringField(value, "text");
      if (text === null) {
        throw new Error(`Canvas text node ${id} has no text`);
      }
      return { id, type, text, x, y, width, height, color };
    }
    if (type === "file") {
      const file = stringField(value, "file");
      if (file === null) {
        throw new Error(`Canvas file node ${id} has no file path`);
      }
      return {
        id,
        type,
        file,
        subpath: stringField(value, "subpath") ?? undefined,
        x,
        y,
        width,
        height,
        color,
      };
    }
    throw new Error(`Canvas node ${id} has unsupported type ${String(type)}`);
  });
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges: CanvasEdge[] = root.edges.map((raw, index) => {
    const value = record(raw);
    if (value === null) {
      throw new Error(`Canvas edge ${index + 1} is not an object`);
    }
    const id = stringField(value, "id");
    const fromNode = stringField(value, "fromNode");
    const toNode = stringField(value, "toNode");
    if (
      id === null ||
      fromNode === null ||
      toNode === null ||
      !nodeIds.has(fromNode) ||
      !nodeIds.has(toNode)
    ) {
      throw new Error(`Canvas edge ${index + 1} has invalid endpoints`);
    }
    return {
      id,
      fromNode,
      toNode,
      fromSide: sideField(value, "fromSide"),
      toSide: sideField(value, "toSide"),
      label: stringField(value, "label") ?? undefined,
      color: stringField(value, "color") ?? undefined,
    };
  });
  return { nodes, edges };
}

export function edgePoint(node: CanvasNode, side?: CanvasSide) {
  switch (side) {
    case "top":
      return { x: node.x + node.width / 2, y: node.y };
    case "right":
      return { x: node.x + node.width, y: node.y + node.height / 2 };
    case "bottom":
      return { x: node.x + node.width / 2, y: node.y + node.height };
    case "left":
      return { x: node.x, y: node.y + node.height / 2 };
    default:
      return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
  }
}

/** Serializes a canvas document back to its on-disk JSON form. */
export function serializeCanvas(canvas: CanvasDocument): string {
  return `${JSON.stringify(canvas, null, 2)}\n`;
}

/** The next unused node id, stable and readable rather than a random UUID. */
export function nextCanvasNodeId(canvas: CanvasDocument): string {
  const existing = new Set(canvas.nodes.map((node) => node.id));
  let index = canvas.nodes.length + 1;
  let id = `card-${index}`;
  while (existing.has(id)) {
    index += 1;
    id = `card-${index}`;
  }
  return id;
}

/**
 * A default position for a newly added card: to the right of the
 * rightmost existing card, aligned with the topmost one. An empty canvas
 * places the first card at the origin.
 */
export function nextCanvasNodePosition(canvas: CanvasDocument): {
  x: number;
  y: number;
} {
  if (canvas.nodes.length === 0) {
    return { x: 0, y: 0 };
  }
  const rightEdge = Math.max(
    ...canvas.nodes.map((node) => node.x + node.width),
  );
  const topEdge = Math.min(...canvas.nodes.map((node) => node.y));
  return { x: rightEdge + 40, y: topEdge };
}

export function canvasFilePaths(canvas: CanvasDocument): string[] {
  return [
    ...new Set(
      canvas.nodes
        .filter(
          (node): node is Extract<CanvasNode, { type: "file" }> =>
            node.type === "file",
        )
        .map((node) => node.file),
    ),
  ];
}
