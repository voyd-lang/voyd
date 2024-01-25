import { Expr } from "./expr.mjs";
import { Id, Identifier } from "./identifier.mjs";
import { List, ListValue } from "./list.mjs";
import { NamedEntity, NamedEntityOpts } from "./named-entity.mjs";

export class VoidModule extends NamedEntity {
  readonly syntaxType = "module";
  readonly value: Expr[] = [];
  /** 0 = init, 1 = expanding regular macros, 2 = regular macros expanded */
  phase = 0;

  constructor(
    opts: NamedEntityOpts & {
      value?: ListValue[];
      phase?: number;
    }
  ) {
    super(opts);
    if (opts.value) this.push(...opts.value);
    this.phase = opts.phase ?? 0;
  }

  map(fn: (expr: Expr, index: number, array: Expr[]) => Expr): VoidModule {
    return new VoidModule({
      ...super.getCloneOpts(),
      value: this.value.map(fn),
      phase: this.phase,
    });
  }

  toString() {
    return this.id;
  }

  clone(parent?: Expr | undefined): VoidModule {
    return new VoidModule({
      ...super.getCloneOpts(parent),
      value: this.value,
      phase: this.phase,
    });
  }

  toJSON() {
    return ["module", this.name, this.value];
  }

  push(...expr: ListValue[]) {
    expr.forEach((ex) => {
      if (typeof ex === "string") {
        this.value.push(new Identifier({ value: ex, parent: this }));
        return;
      }

      if (ex instanceof Array) {
        this.push(new List({ value: ex, parent: this }));
        return;
      }

      const cloned = ex.clone(this);

      if (cloned.isList() && cloned.calls("splice-quote")) {
        this.value.push(...cloned.rest());
        return;
      }

      this.value.push(cloned);
    });

    return this;
  }

  pushChildModule(module: VoidModule) {
    this.registerEntity(module);
    this.push(module);
  }
}
