import { Expr } from "./expr.mjs";
import { List } from "./list.mjs";
import { NamedEntity, NamedEntityOpts } from "./named-entity.mjs";

export class VoidModule extends NamedEntity {
  readonly syntaxType = "module";
  readonly ast: List;

  constructor(
    opts: NamedEntityOpts & {
      ast: List;
    }
  ) {
    super(opts);
    this.ast = opts.ast;
  }

  toString() {
    return this.id;
  }

  clone(parent?: Expr | undefined): VoidModule {
    return new VoidModule({
      ...super.getCloneOpts(parent),
      ast: this.ast,
    });
  }

  toJSON() {
    return ["module", this.id, this.ast];
  }
}
