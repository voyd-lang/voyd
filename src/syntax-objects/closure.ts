import type { Expr } from "./expr.js";
import { ScopedSyntax, ScopedSyntaxMetadata } from "./scoped-entity.js";
import { Parameter } from "./parameter.js";
import { FnType, Type } from "./types.js";
import { Variable } from "./variable.js";
import { Identifier } from "./identifier.js";
import { Child } from "./lib/child.js";
import { ChildList } from "./lib/child-list.js";

export class Closure extends ScopedSyntax {
  readonly syntaxType = "closure";
  readonly #parameters = new ChildList<Parameter>([], this);
  readonly #body: Child<Expr>;
  readonly #returnTypeExpr = new Child<Expr | undefined>(undefined, this);
  returnType?: Type;
  inferredReturnType?: Type;
  annotatedReturnType?: Type;
  typesResolved?: boolean;
  variables: Variable[] = [];
  captures: (Variable | Parameter)[] = [];

  constructor(
    opts: ScopedSyntaxMetadata & {
      parameters?: Parameter[];
      body: Expr;
      returnTypeExpr?: Expr;
      captures?: (Variable | Parameter)[];
    }
  ) {
    super(opts);
    this.#parameters.push(...(opts.parameters ?? []));
    this.parameters.forEach((p) => (p.parent = this));
    this.#body = new Child<Expr>(opts.body, this);
    this.returnTypeExpr = opts.returnTypeExpr;
    if (this.returnTypeExpr) this.returnTypeExpr.parent = this;
    this.captures = opts.captures ?? [];
  }

  get body() {
    return this.#body.value;
  }

  set body(body: Expr) {
    this.#body.value = body;
  }

  get parameters() {
    return this.#parameters.toArray();
  }

  get returnTypeExpr() {
    return this.#returnTypeExpr.value;
  }

  set returnTypeExpr(returnTypeExpr: Expr | undefined) {
    this.#returnTypeExpr.value = returnTypeExpr;
  }

  getType(): FnType {
    return new FnType({
      ...super.getCloneOpts(this.parent),
      name: Identifier.from(`closure#${this.syntaxId}`),
      parameters: this.parameters,
      returnType: this.getReturnType(),
    });
  }

  getIndexOfParameter(parameter: Parameter) {
    const index = this.parameters.findIndex((p) => p.id === parameter.id);
    if (index < 0) {
      throw new Error(`Parameter ${parameter} not registered with closure`);
    }
    return index;
  }

  getIndexOfVariable(variable: Variable) {
    const index = this.variables.findIndex((v) => v.id === variable.id);

    if (index < 0) {
      const newIndex = this.variables.push(variable) - 1;
      return newIndex + this.parameters.length;
    }

    return index + this.parameters.length;
  }

  getReturnType(): Type {
    if (this.returnType) {
      return this.returnType;
    }

    throw new Error(
      `Return type not yet resolved for closure at ${this.location}`
    );
  }

  clone(parent?: Expr): Closure {
    return new Closure({
      ...super.getCloneOpts(parent),
      parameters: this.parameters.map((p) => p.clone()),
      body: this.body.clone(),
      returnTypeExpr: this.returnTypeExpr?.clone(),
      captures: [...this.captures],
    });
  }

  toJSON(): unknown {
    return [
      "closure",
      ["parameters", ...this.parameters],
      ["return-type", this.returnTypeExpr?.toJSON() ?? null],
      this.body,
    ];
  }
}
