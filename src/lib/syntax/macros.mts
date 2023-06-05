import type { Expr } from "./expr.mjs";
import { Identifier } from "./identifier.mjs";
import { MacroVariable } from "./macro-variable.mjs";
import { Parameter } from "./parameter.mjs";
import { Syntax, SyntaxOpts } from "./syntax.mjs";
import { FnType, Type } from "./types.mjs";

export type Macro = RegularMacro;

export class RegularMacro extends Syntax {
  readonly syntaxType = "macro";
  /** A unique, human readable id to be used as the absolute id of the function (helps with function overloading) */
  readonly id: string;
  readonly identifier: Identifier;
  readonly variables: MacroVariable[] = [];
  readonly parameters: Parameter[] = [];
  readonly body: Expr;

  constructor(
    opts: SyntaxOpts & {
      identifier: Identifier;
      returnType?: Type;
      variables?: MacroVariable[];
      parameters?: Parameter[];
      body: Expr;
      isExternal?: boolean;
      externalNamespace?: string;
      /** Internal to Fn only, do not set here unless this is the clone implementation */
      id?: string;
    }
  ) {
    super(opts);
    this.identifier = opts.identifier;
    this.id = opts.id ?? this.generateId();
    this.parameters = opts.parameters ?? [];
    this.variables = opts.variables ?? [];
    this.body = opts.body;
  }

  private generateId() {
    return `${this.location?.filePath ?? "unknown"}/${this.identifier}#${
      this.syntaxId
    }`;
  }

  newEvaluationContext() {}

  getIdentifierName(): string {
    return this.identifier.value;
  }

  getType(): FnType {
    return new FnType({
      fnId: this.id,
      identifier: this.identifier,
      parameters: this.parameters,
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

  clone(parent?: Expr | undefined): RegularMacro {
    return new RegularMacro({
      id: this.id,
      identifier: this.identifier,
      variables: this.variables,
      parameters: this.parameters,
      inherit: this,
      body: this.body,
      parent,
    });
  }

  toJSON() {
    return [
      "regular-macro",
      this.id,
      ["parameters", ...this.parameters],
      this.body,
    ];
  }
}
