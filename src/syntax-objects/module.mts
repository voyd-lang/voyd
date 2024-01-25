import { Expr } from "./expr.mjs";
import { Id } from "./identifier.mjs";
import { List } from "./list.mjs";
import { NamedEntity, NamedEntityOpts } from "./named-entity.mjs";

export class VoidModule extends NamedEntity {
  readonly syntaxType = "module";
  readonly ast: List;
  /** 0 = init, 1 = expanding regular macros, 2 = regular macros expanded */
  phase = 0;

  constructor(
    opts: NamedEntityOpts & {
      ast: List;
      phase?: number;
    }
  ) {
    super(opts);
    this.ast = opts.ast;
    this.ast.parent = this;
    this.phase = opts.phase ?? 0;
  }

  map(fn: (expr: Expr, index: number, array: Expr[]) => Expr): VoidModule {
    return new VoidModule({
      ...super.getCloneOpts(),
      ast: this.ast.map(fn),
      phase: this.phase,
    });
  }

  toString() {
    return this.id;
  }

  clone(parent?: Expr | undefined): VoidModule {
    return new VoidModule({
      ...super.getCloneOpts(parent),
      ast: this.ast,
      phase: this.phase,
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
