import { Syntax, SyntaxOpts } from "./syntax.mjs";

export class StringLiteral extends Syntax {
  // Typescript can't discriminate between StringLiteral and Identifier without this for some reason
  readonly __type = "string-literal";
  value: string;

  constructor(opts: SyntaxOpts & { value: string }) {
    super(opts);
    this.value = opts.value;
  }
}
