import { Expr } from "../expr.js";
import { Fn } from "../fn.js";
import { ChildList } from "../lib/child-list.js";
import { ScopedNamedEntityOpts } from "../named-entity.js";
import { Implementation } from "../implementation.js";
import { BaseType } from "./base-type.js";
import { ScopedEntity } from "../scoped-entity.js";
import { LexicalContext } from "../lib/lexical-context.js";
import { TypeJSON } from "../types.js";

export type TraitOpts = ScopedNamedEntityOpts & {
  methods: Fn[];
  lexicon?: LexicalContext;
};

export class TraitType extends BaseType implements ScopedEntity {
  readonly kindOfType = "trait";
  readonly methods: ChildList<Fn>;
  readonly lexicon: LexicalContext;
  implementations: Implementation[] = [];

  constructor(opts: TraitOpts) {
    super(opts);
    this.lexicon = opts.lexicon ?? new LexicalContext();
    this.methods = new ChildList(opts.methods, this);
  }

  clone(parent?: Expr): Expr {
    return new TraitType({
      ...super.getCloneOpts(parent),
      methods: this.methods.clone(),
    });
  }

  toJSON(): TypeJSON {
    return ["type", ["trait", this.name, ["methods", this.methods.toJSON()]]];
  }
}
