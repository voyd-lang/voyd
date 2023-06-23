import type { Expr } from "./expr.mjs";
import { NamedEntity, NamedEntityOpts } from "./named-entity.mjs";
import { Parameter } from "./parameter.mjs";
import { FnType, Type } from "./types.mjs";
import { Variable } from "./variable.mjs";

export class Fn extends NamedEntity {
  readonly syntaxType = "fn";
  readonly variables: Variable[] = [];
  readonly parameters: Parameter[] = [];
  // I'm too lazy do define an ExternFn Syntax object
  readonly isExternal?: boolean;
  readonly externalNamespace?: string;
  private returnType?: Type;
  readonly body: Expr;

  constructor(
    opts: NamedEntityOpts & {
      returnType?: Type;
      variables?: Variable[];
      parameters?: Parameter[];
      body: Expr;
      isExternal?: boolean;
      externalNamespace?: string;
    }
  ) {
    super(opts);
    this.returnType = opts.returnType;
    this.parameters = opts.parameters ?? [];
    this.variables = opts.variables ?? [];
    this.isExternal = opts.isExternal;
    this.externalNamespace = opts.externalNamespace;
    this.body = opts.body;
  }

  getName(): string {
    return this.name.value;
  }

  getType(): FnType {
    return new FnType({
      ...this.getCloneOpts(this.parent),
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

  setReturnType(type: Type) {
    this.returnType = type;
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
      ...this.getCloneOpts(parent),
      variables: this.variables,
      parameters: this.parameters,
      returnType: this.returnType,
      body: this.body,
      isExternal: this.isExternal,
      externalNamespace: this.externalNamespace,
    });
  }

  toJSON() {
    if (this.isExternal) {
      return [
        "extern-fn",
        this.id,
        ["parameters", ...this.parameters],
        ["return-type", this.returnType],
      ];
    }

    return [
      "fn",
      this.id,
      ["parameters", ...this.parameters],
      ["return-type", this.returnType],
      this.body,
    ];
  }
}
