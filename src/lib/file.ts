import { SourceLocation } from "../syntax-objects/syntax.js";

export class File {
  readonly filePath: string;
  readonly originalSize: number;
  readonly value: string[];
  readonly location = {
    index: 0,
    line: 1,
    column: 0,
  };

  constructor(contents: string, filePath: string) {
    this.value = contents.split("").reverse();
    this.originalSize = this.value.length;
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
    return !!this.value.length;
  }

  get next() {
    return this.value[this.value.length - 1];
  }

  currentSourceLocation() {
    return new SourceLocation({
      startIndex: this.position,
      endIndex: this.originalSize - this.value.length,
      line: this.line,
      column: this.column,
      filePath: this.filePath,
    });
  }

  at(index: number): string | undefined {
    return this.value.at(-index - 1);
  }

  /** Returns the next character and removes it from the queue */
  consumeChar(): string {
    const char = this.value.pop();
    if (!char) {
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
