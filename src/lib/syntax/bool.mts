import { Syntax, SyntaxOpts } from "./syntax.mjs";

export class Bool extends Syntax {
  readonly __type = "bool";
  value: boolean;

  constructor(opts: SyntaxOpts & { value: boolean }) {
    super(opts);
    this.value = opts.value;
  }
}
