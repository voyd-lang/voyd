import { Expr } from "./expr.mjs";
import { Identifier } from "./identifier.mjs";
import { List } from "./list.mjs";
import { Syntax, SyntaxOpts } from "./syntax.mjs";

export class MacroLambda extends Syntax {
  readonly syntaxType = "macro-lambda";
  readonly parameters: Identifier[] = [];
  readonly body: List;

  constructor(
    opts: SyntaxOpts & {
      parameters?: Identifier[];
      body: List;
    }
  ) {
    super(opts);
    this.parameters = opts.parameters ?? [];
    this.body = opts.body;
  }

  toString() {
    return JSON.stringify(this.toJSON());
  }

  clone(parent?: Expr | undefined): MacroLambda {
    return new MacroLambda({
      parameters: this.parameters,
      inherit: this,
      body: this.body,
      parent,
    });
  }

  toJSON() {
    return ["macro-lambda", ["parameters", ...this.parameters], this.body];
  }
}
