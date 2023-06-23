import type { Expr } from "./expr.mjs";
import { Identifier } from "./identifier.mjs";
import { List } from "./list.mjs";
import { NamedEntity, NamedEntityOpts } from "./named-entity.mjs";

export type Macro = RegularMacro;

export class RegularMacro extends NamedEntity {
  readonly syntaxType = "macro";
  readonly macroType = "regular";
  readonly parameters: Identifier[] = [];
  readonly body: List;

  constructor(
    opts: NamedEntityOpts & {
      parameters?: Identifier[];
      body: List;
    }
  ) {
    super(opts);
    this.parameters = opts.parameters ?? [];
    this.body = opts.body;
  }

  getName(): string {
    return this.name.value;
  }

  toString() {
    return this.id;
  }

  clone(parent?: Expr | undefined): RegularMacro {
    return new RegularMacro({
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
