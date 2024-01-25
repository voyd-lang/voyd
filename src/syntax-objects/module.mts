import { Expr } from "./expr.mjs";
import { Id } from "./identifier.mjs";
import { List } from "./list.mjs";
import { NamedEntity, NamedEntityOpts } from "./named-entity.mjs";

export class VoidModule extends NamedEntity {
  readonly syntaxType = "module";
  readonly ast: List;
  macrosExpanded = false;

  constructor(
    opts: NamedEntityOpts & {
      ast: List;
      macrosExpanded?: boolean;
    }
  ) {
    super(opts);
    this.ast = opts.ast;
    this.macrosExpanded = opts.macrosExpanded ?? false;
  }

  map(fn: (expr: Expr, index: number, array: Expr[]) => Expr): VoidModule {
    return new VoidModule({
      ...super.getCloneOpts(),
      ast: this.ast.map(fn),
      macrosExpanded: this.macrosExpanded,
    });
  }

  toString() {
    return this.id;
  }

  clone(parent?: Expr | undefined): VoidModule {
    return new VoidModule({
      ...super.getCloneOpts(parent),
      ast: this.ast,
      macrosExpanded: this.macrosExpanded,
    });
  }

  toJSON() {
    return ["module", this.name, this.ast];
  }

  pushChildModule(module: VoidModule) {
    this.registerEntity(module);
    this.ast.push(module);
  }
}
