import { Expr } from "./expr.js";
import { Fn } from "./fn.js";
import { ChildList } from "./lib/child-list.js";
import { ScopedNamedEntity, ScopedNamedEntityOpts } from "./named-entity.js";

export type TraitOpts = ScopedNamedEntityOpts & {
  methods: Fn[];
};

export class Trait extends ScopedNamedEntity {
  readonly syntaxType = "trait";
  readonly methods: ChildList<Fn>;

  constructor(opts: TraitOpts) {
    super(opts);
    this.methods = new ChildList(opts.methods, this);
  }

  clone(parent?: Expr): Expr {
    return new Trait({
      ...super.getCloneOpts(parent),
      methods: this.methods.clone(),
    });
  }

  toJSON(): unknown {
    return ["trait", this.name, ["methods", this.methods.toJSON()]];
  }
}
