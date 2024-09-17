import type { Expr } from "./expr.js";
import { Identifier } from "./identifier.js";
import { ChildList } from "./lib/child-list.js";
import { Child } from "./lib/child.js";
import { ScopedNamedEntity, ScopedNamedEntityOpts } from "./named-entity.js";
import { Parameter } from "./parameter.js";
import { FnType, Type } from "./types.js";
import { Variable } from "./variable.js";

export class Fn extends ScopedNamedEntity {
  readonly syntaxType = "fn";
  readonly #parameters = new ChildList<Parameter>([], this);
  readonly #body = new Child<Expr | undefined>(undefined, this);
  readonly #returnTypeExpr = new Child<Expr | undefined>(undefined, this);
  readonly #genericInstances = new ChildList<Fn>([], this);
  #typeParams = new ChildList<Identifier>([], this);
  variables: Variable[] = [];
  returnType?: Type; // When a function has generics, resolved versions of the functions go here
  inferredReturnType?: Type;
  annotatedReturnType?: Type;
  appliedTypeArgs?: Type[] = [];
  typesResolved?: boolean;
  #iteration = 0;

  constructor(
    opts: ScopedNamedEntityOpts & {
      returnTypeExpr?: Expr;
      variables?: Variable[];
      parameters?: Parameter[];
      typeParameters?: Identifier[];
      body?: Expr;
    }
  ) {
    super(opts);
    this.#parameters.push(...(opts.parameters ?? []));
    this.#typeParams.push(...(opts.typeParameters ?? []));
    this.returnTypeExpr = opts.returnTypeExpr;
    this.variables = opts.variables ?? [];
    this.body = opts.body;
  }

  get body() {
    return this.#body.value;
  }

  set body(body: Expr | undefined) {
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

  get genericInstances() {
    const instances = this.#genericInstances.toArray();
    return !instances.length ? undefined : instances;
  }

  get typeParameters() {
    const params = this.#typeParams.toArray();
    return !params.length ? undefined : params;
  }

  set typeParameters(params: Identifier[] | undefined) {
    this.#typeParams = new ChildList(params ?? [], this);
  }

  // Register a version of this function with resolved generics
  registerGenericInstance(fn: Fn) {
    this.#genericInstances.push(fn);
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

  toString() {
    return this.id;
  }

  clone(parent?: Expr | undefined): Fn {
    // Don't clone generic instances
    return new Fn({
      ...super.getCloneOpts(parent),
      id: `${this.id}#${this.#iteration++}`,
      returnTypeExpr: this.returnTypeExpr?.clone(),
      parameters: this.#parameters.clone(),
      typeParameters: this.#typeParams.clone(),
      body: this.body?.clone(),
    });
  }

  toJSON() {
    return [
      "fn",
      this.id,
      ["parameters", ...this.parameters],
      ["type-parameters", ...(this.#typeParams.toArray() ?? [])],
      ["return-type", this.returnType],
      this.body,
    ];
  }
}
