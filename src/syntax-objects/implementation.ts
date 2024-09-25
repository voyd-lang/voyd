import { Expr } from "./expr.js";
import { Fn } from "./fn.js";
import { nop } from "./helpers.js";
import { Identifier } from "./identifier.js";
import { ChildList } from "./lib/child-list.js";
import { Child } from "./lib/child.js";
import { ScopedSyntax, ScopedSyntaxMetadata } from "./scoped-entity.js";
import { Type } from "./types.js";

export type ImplementationOpts = ScopedSyntaxMetadata & {
  typeParams: Identifier[];
  targetTypeExpr: Expr;
  body: Expr;
  traitExpr?: Expr;
};

export class Implementation extends ScopedSyntax {
  readonly syntaxType = "implementation";
  readonly typeParams: ChildList<Identifier>;
  readonly targetTypeExpr: Child<Expr>;
  readonly body: Child<Expr>;
  readonly traitExpr: Child<Expr | undefined>;
  readonly #exports = new Map<string, Fn>(); // NO CLONE!
  readonly #methods = new Map<string, Fn>(); // NO CLONE!
  typesResolved?: boolean;
  targetType?: Type;
  trait?: Type;

  constructor(opts: ImplementationOpts) {
    super(opts);
    this.typeParams = new ChildList(opts.typeParams, this);
    this.targetTypeExpr = new Child(opts.targetTypeExpr, this);
    this.body = new Child(opts.body, this);
    this.traitExpr = new Child(opts.traitExpr, this);
  }

  get exports(): ReadonlyArray<Fn> {
    return [...this.#exports.values()];
  }

  get methods(): ReadonlyArray<Fn> {
    return [...this.#methods.values()];
  }

  registerExport(v: Fn): Implementation {
    this.#exports.set(v.id, v);
    this.registerEntity(v); // dirty way to make sure it's in the scope
    return this;
  }

  registerMethod(v: Fn): Implementation {
    this.#methods.set(v.id, v);
    return this;
  }

  clone(parent?: Expr) {
    const impl = new Implementation({
      ...super.getCloneOpts(parent),
      typeParams: this.typeParams.clone(),
      targetTypeExpr: this.targetTypeExpr.clone(),
      body: nop(),
      traitExpr: this.traitExpr.clone(),
    });
    impl.body.value = this.body.clone(impl);
    return impl;
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
