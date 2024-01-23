import { Expr } from "./expr.mjs";
import { Id } from "./identifier.mjs";
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

  map(fn: (expr: Expr, index: number, array: Expr[]) => Expr): VoidModule {
    return new VoidModule({
      ...super.getCloneOpts(),
      ast: this.ast.map(fn),
    });
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
    return ["module", this.name, this.ast];
  }

  pushChildModule(module: VoidModule) {
    this.registerEntity(module);
    this.ast.push(module);
  }

  /** Must not be recursive / search parents. */
  resolveChildModule(name: Id): VoidModule | undefined {
    return this.lexicon.resolveModuleEntity(name);
  }

  resolveNestedModule(path: Id[]): VoidModule | undefined {
    const [id, ...rest] = path;
    if (!id) return;
    const module = this.resolveChildModule(id);
    if (!module) return;
    if (!rest.length) return module;
    return module.resolveNestedModule(rest);
  }
}
