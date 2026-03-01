import type { SourceLocation } from "@voyd/compiler/parser/ast/syntax.js";
import type { SourceSpan } from "@voyd/compiler/diagnostics/index.js";
import type { Position, Range } from "vscode-languageserver/lib/node/main.js";
import type { SymbolOccurrence } from "./types.js";

export class LineIndex {
  readonly #starts: number[];

  constructor(private readonly text: string) {
    this.#starts = [0];
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] === "\n") {
        this.#starts.push(index + 1);
      }
    }
  }

  positionAt(offset: number): Position {
    const clamped = Math.max(0, Math.min(offset, this.text.length));
    let low = 0;
    let high = this.#starts.length - 1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const lineStart = this.#starts[mid]!;
      const nextLineStart =
        mid + 1 < this.#starts.length ? this.#starts[mid + 1]! : this.text.length + 1;

      if (clamped < lineStart) {
        high = mid - 1;
        continue;
      }

      if (clamped >= nextLineStart) {
        low = mid + 1;
        continue;
      }

      return { line: mid, character: clamped - lineStart };
    }

    const line = Math.max(0, this.#starts.length - 1);
    return { line, character: clamped - this.#starts[line]! };
  }

  range(start: number, end: number): Range {
    const clampedStart = Math.max(0, Math.min(start, this.text.length));
    const clampedEnd = Math.max(clampedStart + 1, Math.min(end, this.text.length));

    return {
      start: this.positionAt(clampedStart),
      end: this.positionAt(clampedEnd),
    };
  }
}

export const locationRange = ({
  location,
  lineIndex,
}: {
  location: SourceLocation | undefined;
  lineIndex: LineIndex | undefined;
}): Range | undefined => {
  if (!location || !lineIndex) {
    return undefined;
  }

  return lineIndex.range(location.startIndex, location.endIndex);
};

export const spanRange = ({
  span,
  lineIndex,
}: {
  span: SourceSpan;
  lineIndex: LineIndex | undefined;
}): Range | undefined => {
  if (!lineIndex) {
    return undefined;
  }

  return lineIndex.range(span.start, span.end);
};

export const isInRange = (position: Position, range: Range): boolean => {
  if (position.line < range.start.line || position.line > range.end.line) {
    return false;
  }

  if (position.line === range.start.line && position.character < range.start.character) {
    return false;
  }

  if (position.line === range.end.line && position.character >= range.end.character) {
    return false;
  }

  return true;
};

export const smallestRangeFirst = (left: SymbolOccurrence, right: SymbolOccurrence): number => {
  const leftWidth =
    (left.range.end.line - left.range.start.line) * 10000 +
    (left.range.end.character - left.range.start.character);
  const rightWidth =
    (right.range.end.line - right.range.start.line) * 10000 +
    (right.range.end.character - right.range.start.character);

  return leftWidth - rightWidth;
};
