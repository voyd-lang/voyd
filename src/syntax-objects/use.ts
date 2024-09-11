import { Expr } from "./expr.js";
import { Identifier } from "./identifier.js";
import { List } from "./list.js";
import { NamedEntity } from "./named-entity.js";
import { Syntax, SyntaxMetadata } from "./syntax.js";

export type UseEntities = { e: NamedEntity; alias?: string }[];

/** Defines a declared namespace for external function imports */
export class Use extends Syntax {
  readonly syntaxType = "use";
  entities: UseEntities;
  path: List | Identifier;

  constructor(
    opts: SyntaxMetadata & {
      entities: UseEntities;
      path: List | Identifier;
    }
  ) {
    super(opts);
    this.entities = opts.entities;
    this.path = opts.path;
  }

  toJSON() {
    return ["use", this.path.toJSON()];
  }

  clone(parent?: Expr) {
    return new Use({
      ...this.getCloneOpts(parent),
      entities: this.entities,
      path: this.path,
    });
  }
}
