import { Expr } from "./expr.js";
import { Identifier } from "./identifier.js";
import { List } from "./list.js";
import { NamedEntity } from "./named-entity.js";
import { Syntax, SyntaxMetadata } from "./syntax.js";

/** Defines a declared namespace for external function imports */
export class Use extends Syntax {
  readonly syntaxType = "use";
  entities: NamedEntity[];
  path: List | Identifier;

  constructor(
    opts: SyntaxMetadata & {
      entities: NamedEntity[];
      path: List | Identifier;
    }
  ) {
    super(opts);
    this.entities = opts.entities;
    this.path = opts.path;
  }

  toJSON() {
    return ["use", this.entities.map((e) => e.name)];
  }

  clone(parent?: Expr) {
    return new Use({
      ...this.getCloneOpts(parent),
      entities: this.entities,
      path: this.path,
    });
  }
}
