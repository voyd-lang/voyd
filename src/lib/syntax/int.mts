import { Syntax, SyntaxOpts } from "./syntax.mjs";

export class Int extends Syntax {
  readonly __type = "int";
  value: number;

  constructor(opts: SyntaxOpts & { value: number }) {
    super(opts);
    this.value = opts.value;
  }
}
