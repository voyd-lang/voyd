import type { Expr } from "./expr.mjs";
import { NamedEntity, NamedEntityOpts } from "./named-entity.mjs";
import { Parameter } from "./parameter.mjs";
import { FnType, Type } from "./types.mjs";
import { Variable } from "./variable.mjs";

export class Fn extends NamedEntity {
  readonly syntaxType = "fn";
  /** A unique, human readable id to be used as the absolute id of the function (helps with function overloading) */
  readonly id: string;
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
      /** Internal to Fn only, do not set here unless this is the clone implementation */
      id?: string;
    }
  ) {
    super(opts);
    this.id = opts.id ?? this.generateId();
    this.returnType = opts.returnType;
    this.parameters = opts.parameters ?? [];
    this.variables = opts.variables ?? [];
    this.isExternal = opts.isExternal;
    this.externalNamespace = opts.externalNamespace;
    this.body = opts.body;
  }

  private generateId() {
    return `${this.location?.filePath ?? "unknown"}/${this.name}#${
      this.syntaxId
    }`;
  }

  getName(): string {
    return this.name.value;
  }

  getType(): FnType {
    return new FnType({
      fnId: this.id,
      name: this.name,
      parameters: this.parameters,
      returnType: this.getReturnType(),
      inherit: this,
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
      id: this.id,
      name: this.name,
      variables: this.variables,
      parameters: this.parameters,
      returnType: this.returnType,
      inherit: this,
      body: this.body,
      parent,
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
