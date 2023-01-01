import { Syntax, SyntaxOpts } from "./syntax.mjs";

export class Bool extends Syntax {
  value: boolean;

  constructor(opts: SyntaxOpts & { value: boolean }) {
    super(opts);
    this.value = opts.value;
  }
}
