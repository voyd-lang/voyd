import { Syntax, SyntaxOpts } from "./syntax.mjs";

export class Float extends Syntax {
  value: number;

  constructor(opts: SyntaxOpts & { value: number }) {
    super(opts);
    this.value = opts.value;
  }
}
