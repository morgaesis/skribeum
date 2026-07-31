import type { MarkdownConfig } from "@lezer/markdown";
import katex from "katex";
import "katex/dist/katex.min.css";

const DOLLAR = 36;
const NEWLINE = 10;
const MATH_BLOCK_SCAN_LIMIT = 16_384;

function isEscaped(text: string, position: number): boolean {
  let slashes = 0;
  for (
    let index = position - 1;
    index >= 0 && text[index] === "\\";
    index -= 1
  ) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

export const mathMarkdownExtension: MarkdownConfig = {
  defineNodes: [
    "InlineMath",
    { name: "BlockMath", block: true },
    "MathMark",
    "MathContent",
  ],
  parseInline: [
    {
      name: "InlineMath",
      before: "InlineCode",
      parse(context, next, position) {
        if (
          next !== DOLLAR ||
          context.char(position + 1) === DOLLAR ||
          /\s/u.test(context.slice(position + 1, position + 2))
        ) {
          return -1;
        }
        for (let end = position + 1; end < context.end; end += 1) {
          const code = context.char(end);
          if (code === NEWLINE) {
            return -1;
          }
          if (
            code === DOLLAR &&
            context.char(end + 1) !== DOLLAR &&
            !isEscaped(
              context.slice(context.offset, context.end),
              end - context.offset,
            ) &&
            !/\s/u.test(context.slice(end - 1, end))
          ) {
            return context.addElement(
              context.elt("InlineMath", position, end + 1, [
                context.elt("MathMark", position, position + 1),
                context.elt("MathContent", position + 1, end),
                context.elt("MathMark", end, end + 1),
              ]),
            );
          }
        }
        return -1;
      },
    },
  ],
  parseBlock: [
    {
      name: "BlockMath",
      parse(context, line) {
        const opening = line.text.slice(line.pos);
        if (!opening.startsWith("$$")) {
          return false;
        }
        const start = context.lineStart + line.pos;
        const singleLine = /^\$\$(.*)\$\$[ \t]*$/.exec(opening);
        if (singleLine !== null) {
          const end = context.lineStart + line.text.trimEnd().length;
          context.addElement(
            context.elt("BlockMath", start, end, [
              context.elt("MathMark", start, start + 2),
              context.elt("MathContent", start + 2, end - 2),
              context.elt("MathMark", end - 2, end),
            ]),
          );
          context.nextLine();
          return true;
        }
        if (opening.trimEnd() !== "$$") {
          return false;
        }
        const contentStart = context.lineStart + line.text.length + 1;
        let contentEnd = contentStart;
        let end = start + 2;
        while (context.nextLine()) {
          const candidate = line.text.slice(line.pos).trimEnd();
          if (candidate === "$$") {
            const closing = context.lineStart + line.pos;
            end = closing + 2;
            contentEnd = closing > contentStart ? closing - 1 : closing;
            context.addElement(
              context.elt("BlockMath", start, end, [
                context.elt("MathMark", start, start + 2),
                context.elt("MathContent", contentStart, contentEnd),
                context.elt("MathMark", closing, end),
              ]),
            );
            context.nextLine();
            return true;
          }
          contentEnd = context.lineStart + line.text.length;
          end = contentEnd;
          if (end - start >= MATH_BLOCK_SCAN_LIMIT) {
            context.nextLine();
            break;
          }
        }
        context.addElement(
          context.elt("BlockMath", start, end, [
            context.elt("MathMark", start, start + 2),
            context.elt("MathContent", contentStart, contentEnd),
          ]),
        );
        return true;
      },
      before: "FencedCode",
    },
  ],
};

export function renderMath(
  host: HTMLElement,
  source: string,
  displayMode: boolean,
): boolean {
  try {
    katex.render(source, host, {
      displayMode,
      throwOnError: true,
      trust: false,
      output: "htmlAndMathml",
    });
    return true;
  } catch {
    host.textContent = source;
    host.classList.add("cm-skr-render-error");
    host.removeAttribute("aria-label");
    host.setAttribute("role", "alert");
    return false;
  }
}
