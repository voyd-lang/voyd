import type { Expr } from "./expr.js";
import { Identifier } from "./identifier.js";
import { ScopedNamedEntity, ScopedNamedEntityOpts } from "./named-entity.js";
import { Parameter } from "./parameter.js";
import { FnType, Type } from "./types.js";
import { Variable } from "./variable.js";

export class Fn extends ScopedNamedEntity {
  readonly syntaxType = "fn";
  variables: Variable[] = [];
  _parameters: Parameter[] = [];
  typeParameters?: Identifier[];
  appliedTypeArgs?: Type[] = [];
  /** When a function has generics, resolved versions of the functions go here */
  genericInstances?: Fn[] = [];
  returnType?: Type;
  _returnTypeExpr?: Expr;
  inferredReturnType?: Type;
  annotatedReturnType?: Type;
  resolved?: boolean;
  private _body?: Expr;

  constructor(
    opts: ScopedNamedEntityOpts & {
      returnType?: Type;
      returnTypeExpr?: Expr;
      variables?: Variable[];
      parameters: Parameter[];
      typeParameters?: Identifier[];
      genericInstances?: Fn[];
      body?: Expr;
    }
  ) {
    super(opts);
    this.returnType = opts.returnType;
    this.parameters = opts.parameters ?? [];
    this.variables = opts.variables ?? [];
    this.typeParameters = opts.typeParameters;
    this.genericInstances = opts.genericInstances;
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

  get parameters() {
    return this._parameters;
  }

  set parameters(parameters: Parameter[]) {
    this._parameters = parameters;
    parameters.forEach((p) => {
      p.parent = this;
      this.registerEntity(p);
    });
  }

  get returnTypeExpr() {
    return this._returnTypeExpr;
  }

  set returnTypeExpr(returnTypeExpr: Expr | undefined) {
    if (returnTypeExpr) {
      returnTypeExpr.parent = this;
    }

    this._returnTypeExpr = returnTypeExpr;
  }

  // Register a version of this function with resolved generics
  registerGenericInstance(fn: Fn) {
    if (!this.genericInstances) {
      this.genericInstances = [];
    }

    this.genericInstances.push(fn);
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
    const index = this.parameters.findIndex((p) => p.id === parameter.id);
    if (index < 0) {
      throw new Error(`Parameter ${parameter} not registered with fn ${this}`);
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
      `Return type not yet resolved for fn ${this.name} at ${this.location}`
    );
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
      parameters: this.parameters.map((p) => p.clone()),
      returnTypeExpr: this.returnTypeExpr?.clone(),
      returnType: this.returnType,
      body: this.body,
      typeParameters: this.typeParameters?.map((tp) => tp.clone()),
      genericInstances: this.genericInstances?.map((gi) => gi.clone()),
    });
  }

  toJSON() {
    return [
      "fn",
      this.id,
      ["parameters", ...this.parameters],
      ["type-parameters", ...(this.typeParameters ?? [])],
      ["return-type", this.returnType],
      this.body,
    ];
  }
}
