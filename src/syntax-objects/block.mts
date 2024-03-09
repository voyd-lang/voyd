import { Expr } from "./expr.mjs";
import { ScopedSyntax, ScopedSyntaxMetadata } from "./scoped-entity.mjs";
import { Type } from "./types.mjs";

export class Block extends ScopedSyntax {
  readonly syntaxType = "block";
  readonly body: Expr[];
  returnType?: Type;

  constructor(
    opts: ScopedSyntaxMetadata & {
      body: Expr[];
      returnType?: Type;
    }
  ) {
    super(opts);
    this.body = opts.body;
    this.returnType = opts.returnType;
  }

  toJSON() {
    return ["block", ...this.body];
  }

  clone(parent?: Expr) {
    return new Block({
      ...this.getCloneOpts(parent),
      body: this.body,
      returnType: this.returnType,
    });
  }
}
