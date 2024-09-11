import { Expr } from "./expr.js";
import { NamedEntity, NamedEntityOpts } from "./named-entity.js";
import { Type } from "./types.js";

export class Global extends NamedEntity {
  readonly isMutable: boolean;
  readonly type: Type;
  readonly syntaxType = "global";
  readonly initializer: Expr;

  constructor(
    opts: NamedEntityOpts & {
      isMutable: boolean;
      initializer: Expr;
      type: Type;
    }
  ) {
    super(opts);
    this.isMutable = opts.isMutable;
    this.type = opts.type;
    this.initializer = opts.initializer;
  }

  toString() {
    return this.name.toString();
  }

  toJSON() {
    return [
      "define-global",
      this.name,
      this.type,
      ["is-mutable", this.isMutable],
      this.initializer,
    ];
  }

  clone(parent?: Expr | undefined): Global {
    return new Global({
      ...super.getCloneOpts(parent),
      isMutable: this.isMutable,
      initializer: this.initializer,
      type: this.type,
    });
  }
}
