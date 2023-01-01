import { Syntax, SyntaxOpts } from "./syntax.mjs";

export class Comment extends Syntax {
  readonly __type = "comment";
  value: string;

  constructor(opts: SyntaxOpts & { value: string }) {
    super(opts);
    this.value = opts.value;
  }
}
