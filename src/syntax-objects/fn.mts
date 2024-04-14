import type { Expr } from "./expr.mjs";
import { ScopedNamedEntity, ScopedNamedEntityOpts } from "./named-entity.mjs";
import { Parameter } from "./parameter.mjs";
import { FnType, Type } from "./types.mjs";
import { Variable } from "./variable.mjs";

export class Fn extends ScopedNamedEntity {
  readonly syntaxType = "fn";
  variables: Variable[] = [];
  parameters: Parameter[] = [];
  returnType?: Type;
  returnTypeExpr?: Expr;
  private _body?: Expr;

  constructor(
    opts: ScopedNamedEntityOpts & {
      returnType?: Type;
      returnTypeExpr?: Expr;
      variables?: Variable[];
      parameters: Parameter[];
      body?: Expr;
    }
  ) {
    super(opts);
    this.returnType = opts.returnType;
    this.parameters = opts.parameters ?? [];
    this.variables = opts.variables ?? [];
    this.returnTypeExpr = opts.returnTypeExpr;
    this.body = opts.body;
  }

  get body() {
    return this._body;
  }

  set body(body: Expr | undefined) {
    if (body) {
      body.parent = this;
    }

    this._body = body;
  }

  getNameStr(): string {
    return this.name.value;
  }

  getType(): FnType {
    return new FnType({
      ...super.getCloneOpts(this.parent),
      parameters: this.parameters,
      returnType: this.getReturnType(),
    });
  }

  getIndexOfParameter(parameter: Parameter) {
    const index = this.parameters.findIndex(
      (p) => p.syntaxId === parameter.syntaxId
    );
    if (index < 0) {
      throw new Error(`Parameter ${parameter} not registered with fn ${this}`);
    }
    return index;
  }

  getIndexOfVariable(variable: Variable) {
    const index = this.variables.findIndex(
      (v) => v.syntaxId === variable.syntaxId
    );
    if (index < 0) {
      throw new Error(`Variable ${variable} not registered with fn ${this}`);
    }
    return index + this.parameters.length;
  }

  getReturnType(): Type {
    if (this.returnType) {
      return this.returnType;
    }

    throw new Error(`Return type not yet resolved for fn ${this}`);
  }

  registerLocal(local: Variable | Parameter) {
    if (local.syntaxType === "variable") {
      this.variables.push(local);
      return;
    }

    this.parameters.push(local);
  }

  toString() {
    return this.id;
  }

  clone(parent?: Expr | undefined): Fn {
    return new Fn({
      ...super.getCloneOpts(parent),
      variables: this.variables,
      parameters: this.parameters,
      returnType: this.returnType,
      body: this.body,
    });
  }

  toJSON() {
    return [
      "fn",
      this.id,
      ["parameters", ...this.parameters],
      ["return-type", this.returnType],
      this.body,
    ];
  }
}
