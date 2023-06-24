import { Expr } from "./expr.mjs";
import { Syntax, SyntaxOpts } from "./syntax.mjs";
import { Type } from "./types.mjs";

/** Defines a function call */
export class Call extends Syntax {
  readonly syntaxType = "call";
  readonly fnId: string;
  readonly args: Expr[];

  constructor(opts: SyntaxOpts & { fnId: string; args: Expr[] }) {
    super(opts);
    this.fnId = opts.fnId;
    this.args = opts.args;
  }

  get type(): Type {
    const type = this.resolveFnById(this.fnId)?.getReturnType();
    if (!type) {
      throw new Error(`Could not resolve return type of ${this.fnId}`);
    }
    return type;
  }

  calls(id: string) {
    return this.fnId === id;
  }

  toJSON() {
    return [this.fnId, ...this.args];
  }

  clone(parent?: Expr) {
    return new Call({
      ...this.getCloneOpts(parent),
      fnId: this.fnId,
      args: this.args,
    });
  }
}
