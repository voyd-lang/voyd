export class Token {
  readonly line: number;
  readonly column: number;
  readonly startIndex: number;
  endIndex = 0;
  value = "";

  constructor(opts: { line: number; column: number; index: number }) {
    this.line = opts.line;
    this.column = opts.column;
    this.startIndex = opts.index;
  }

  get span() {
    return this.value.length;
  }

  get hasChars() {
    return !!this.value.length;
  }

  get isNumber() {
    return /^[0-9]+$/.test(this.value);
  }

  get first(): string | undefined {
    return this.value[0];
  }

  addChar(string: string) {
    this.value += string;
  }

  is(string?: string) {
    return this.value === string;
  }
}
