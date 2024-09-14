import { Expr } from "./expr.js";
import { Fn } from "./fn.js";
import { Identifier } from "./identifier.js";
import { ChildList } from "./lib/child-list.js";
import { Child } from "./lib/child.js";
import { ScopedSyntax } from "./scoped-entity.js";
import { SyntaxMetadata } from "./syntax.js";
import { Type } from "./types.js";

export type ImplementationOpts = SyntaxMetadata & {
  typeParams: Identifier[];
  targetTypeExpr: Expr;
  body: Expr;
  traitExpr?: Expr;
};

export class Implementation extends ScopedSyntax {
  readonly syntaxType = "implementation";
  readonly typeParams: ChildList<Identifier>;
  readonly targetTypeExpr: Child<Expr>;
  readonly exports = new ChildList<Fn>([], this);
  readonly body: Child<Expr>;
  readonly traitExpr: Child<Expr | undefined>;
  targetType?: Type;
  trait?: Type;

  constructor(opts: ImplementationOpts) {
    super(opts);
    this.typeParams = new ChildList(opts.typeParams, this);
    this.targetTypeExpr = new Child(opts.targetTypeExpr, this);
    this.body = new Child(opts.body, this);
    this.traitExpr = new Child(opts.traitExpr, this);
  }

  clone(parent?: Expr) {
    return new Implementation({
      ...super.getCloneOpts(parent),
      typeParams: this.typeParams.clone(),
      targetTypeExpr: this.targetTypeExpr.clone(),
      body: this.body.clone(),
      traitExpr: this.traitExpr.clone(),
    });
  }

  toJSON(): unknown {
    return [
      "impl",
      ["type-params", this.typeParams.toArray()],
      ["target", this.targetTypeExpr.toJSON()],
      ["body", this.body.toJSON()],
    ];
  }
}
