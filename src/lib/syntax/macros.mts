import type { Expr } from "./expr.mjs";
import { Identifier } from "./identifier.mjs";
import { List } from "./list.mjs";
import { NamedEntity, NamedEntityOpts } from "./named-entity.mjs";

export type Macro = RegularMacro;

export class RegularMacro extends NamedEntity {
  readonly syntaxType = "macro";
  readonly macroType = "regular";
  /** A unique, human readable id to be used as the absolute id of the function (helps with function overloading) */
  readonly id: string;
  readonly parameters: Identifier[] = [];
  readonly body: List;

  constructor(
    opts: NamedEntityOpts & {
      parameters?: Identifier[];
      body: List;
      /** Internal to Macro only, do not set here unless this is the clone implementation */
      id?: string;
    }
  ) {
    super(opts);
    this.id = opts.id ?? this.generateId();
    this.parameters = opts.parameters ?? [];
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

  toString() {
    return this.id;
  }

  clone(parent?: Expr | undefined): RegularMacro {
    return new RegularMacro({
      id: this.id,
      name: this.name,
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
