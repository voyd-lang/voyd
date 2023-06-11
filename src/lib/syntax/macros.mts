import type { Expr } from "./expr.mjs";
import { Identifier } from "./identifier.mjs";
import { List } from "./list.mjs";
import { Syntax, SyntaxOpts } from "./syntax.mjs";

export type Macro = RegularMacro;

export class RegularMacro extends Syntax {
  readonly syntaxType = "macro";
  readonly macroType = "regular";
  /** A unique, human readable id to be used as the absolute id of the function (helps with function overloading) */
  readonly id: string;
  readonly identifier: Identifier;
  readonly parameters: Identifier[] = [];
  readonly body: List;

  constructor(
    opts: SyntaxOpts & {
      identifier: Identifier;
      parameters?: Identifier[];
      body: List;
      /** Internal to Macro only, do not set here unless this is the clone implementation */
      id?: string;
    }
  ) {
    super(opts);
    this.identifier = opts.identifier;
    this.id = opts.id ?? this.generateId();
    this.parameters = opts.parameters ?? [];
    this.body = opts.body;
  }

  private generateId() {
    return `${this.location?.filePath ?? "unknown"}/${this.identifier}#${
      this.syntaxId
    }`;
  }

  getName(): string {
    return this.identifier.value;
  }

  toString() {
    return this.id;
  }

  clone(parent?: Expr | undefined): RegularMacro {
    return new RegularMacro({
      id: this.id,
      identifier: this.identifier,
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
