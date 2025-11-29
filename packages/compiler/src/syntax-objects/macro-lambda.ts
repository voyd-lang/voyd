import { Expr } from "./expr.js";
import { Identifier } from "./identifier.js";
import { List } from "./list.js";
import { ScopedSyntax, ScopedSyntaxMetadata } from "./scoped-entity.js";

export class MacroLambda extends ScopedSyntax {
  readonly syntaxType = "macro-lambda";
  readonly parameters: Identifier[] = [];
  readonly body: List;

  constructor(
    opts: ScopedSyntaxMetadata & {
      parameters?: Identifier[];
      body: List;
    }
  ) {
    super(opts);
    this.parameters = opts.parameters ?? [];
    this.body = opts.body;
    this.body.parent = this;
  }

  toString() {
    return JSON.stringify(this.toJSON());
  }

  clone(parent?: Expr | undefined): MacroLambda {
    return new MacroLambda({
      ...super.getCloneOpts(parent),
      parameters: this.parameters.map((p) => p.clone()),
      body: this.body.clone(),
    });
  }

  toJSON() {
    return ["macro-lambda", ["parameters", ...this.parameters], this.body];
  }
}
