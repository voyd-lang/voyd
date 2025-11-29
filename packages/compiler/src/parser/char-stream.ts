import { SourceLocation } from "../syntax-objects/syntax.js";

export class CharStream {
  readonly filePath: string;
  readonly value: string;
  readonly length: number;
  readonly location = {
    index: 0,
    line: 1,
    column: 0,
  };

  constructor(contents: string, filePath: string) {
    this.value = contents;
    this.length = contents.length;
    this.filePath = filePath;
  }

  /** Current index the file is on */
  get position() {
    return this.location.index;
  }

  get line() {
    return this.location.line;
  }

  get column() {
    return this.location.column;
  }

  get hasCharacters() {
    return this.position < this.length;
  }

  get next() {
    return this.value[this.position];
  }

  currentSourceLocation() {
    return new SourceLocation({
      startIndex: this.position,
      endIndex: this.position,
      line: this.line,
      column: this.column,
      filePath: this.filePath,
    });
  }

  at(index: number): string | undefined {
    return this.value[this.position + index];
  }

  /** Returns the next character and advances the stream */
  consumeChar(): string {
    const char = this.next;
    if (char === undefined) {
      throw new Error("Out of characters");
    }

    this.location.index += 1;
    this.location.column += 1;
    if (char === "\n") {
      this.location.line += 1;
      this.location.column = 0;
    }

    return char;
  }
}
