import { Syntax, SyntaxOpts } from "./syntax.mjs";

export class Whitespace extends Syntax {
  readonly __type = "whitespace";
  value: string;

  constructor(opts: SyntaxOpts & { value: string }) {
    super(opts);
    this.value = opts.value;
  }

  get isNewline() {
    return this.value === "\n";
  }

  get isSpace() {
    return this.value === " ";
  }

  get isTab() {
    return this.value === "\t";
  }
}
