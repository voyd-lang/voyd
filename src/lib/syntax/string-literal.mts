import { Syntax, SyntaxOpts } from "./syntax.mjs";

export class StringLiteral extends Syntax {
  readonly __type = "string-literal";
  value: string;

  constructor(opts: SyntaxOpts & { value: string }) {
    super(opts);
    this.value = opts.value;
  }
}
