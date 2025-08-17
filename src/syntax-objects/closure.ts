import type { Expr } from "./expr.js";
import { ScopedSyntax, ScopedSyntaxMetadata } from "./scoped-entity.js";
import { Parameter } from "./parameter.js";
import { FnType, Type } from "./types.js";
import { Variable } from "./variable.js";
import { Identifier } from "./identifier.js";

export class Closure extends ScopedSyntax {
  readonly syntaxType = "closure";
  readonly parameters: Parameter[] = [];
  body: Expr;
  returnTypeExpr?: Expr;
  returnType?: Type;
  inferredReturnType?: Type;
  annotatedReturnType?: Type;
  typesResolved?: boolean;
  variables: Variable[] = [];
  captures: (Variable | Parameter)[] = [];
  private fnType?: FnType;

  constructor(
    opts: ScopedSyntaxMetadata & {
      parameters?: Parameter[];
      body: Expr;
      returnTypeExpr?: Expr;
      captures?: (Variable | Parameter)[];
    }
  ) {
    super(opts);
    this.parameters = opts.parameters ?? [];
    this.parameters.forEach((p) => {
      p.parent = this;
      this.registerEntity(p);
    });
    this.body = opts.body;
    this.body.parent = this;
    this.returnTypeExpr = opts.returnTypeExpr;
    if (this.returnTypeExpr) this.returnTypeExpr.parent = this;
    this.captures = opts.captures ?? [];
  }

  getType(): FnType {
    if (this.fnType) return this.fnType;
    this.fnType = new FnType({
      ...super.getCloneOpts(this.parent),
      name: Identifier.from(`closure#${this.syntaxId}`),
      parameters: this.parameters,
      returnType: this.getReturnType(),
    });
    return this.fnType;
  }

  getIndexOfParameter(parameter: Parameter) {
    const index = this.parameters.findIndex((p) => p.id === parameter.id);
    if (index < 0) {
      throw new Error(`Parameter ${parameter} not registered with closure`);
    }
    // account for env parameter at index 0
    return index + 1;
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
