import { Expr } from "./expr.mjs";
import { Syntax, SyntaxMetadata } from "./syntax.mjs";

export class Whitespace extends Syntax {
  readonly syntaxType = "whitespace";
  value: string;

  constructor(opts: SyntaxMetadata & { value: string }) {
    super(opts);
    this.value = opts.value;
  }

  get isNewline() {
    return this.value === "\n";
  }

  get isSpace() {
    return !this.isNewline && !this.isIndent;
  }

  get isIndent() {
    return this.value === "  ";
  }

  clone(parent?: Expr): Whitespace {
    return new Whitespace({ ...super.getCloneOpts(parent), value: this.value });
  }

  toJSON() {
    return this.value;
  }
}
