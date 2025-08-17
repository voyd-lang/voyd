import { Expr } from "../expr.js";
import { Fn } from "../fn.js";
import { ChildList } from "../lib/child-list.js";
import { ScopedNamedEntityOpts } from "../named-entity.js";
import { Implementation } from "../implementation.js";
import { BaseType } from "./base-type.js";
import { ScopedEntity } from "../scoped-entity.js";
import { LexicalContext } from "../lib/lexical-context.js";
import { Type, TypeJSON } from "../types.js";
import { Identifier } from "../identifier.js";

export type TraitOpts = ScopedNamedEntityOpts & {
  methods: Fn[];
  lexicon?: LexicalContext;
  typeParameters?: Identifier[];
  implementations?: Implementation[];
};

export class TraitType extends BaseType implements ScopedEntity {
  readonly kindOfType = "trait";
  readonly methods: ChildList<Fn>;
  readonly lexicon: LexicalContext;
  implementations: Implementation[] = [];
  typeParameters?: Identifier[];
  appliedTypeArgs?: Type[];
  genericInstances?: TraitType[];
  genericParent?: TraitType;
  typesResolved?: boolean;
  #iteration = 0;

  constructor(opts: TraitOpts) {
    super(opts);
    this.lexicon = opts.lexicon ?? new LexicalContext();
    this.methods = new ChildList(opts.methods, this);
    this.typeParameters = opts.typeParameters;
    this.implementations = opts.implementations ?? [];
  }

  clone(parent?: Expr): TraitType {
    return new TraitType({
      ...super.getCloneOpts(parent),
      id: `${this.id}#${this.#iteration++}`,
      methods: this.methods.clone(),
      typeParameters: this.typeParameters,
      implementations: [],
    });
  }

  toJSON(): TypeJSON {
    return ["type", ["trait", this.name, ["methods", this.methods.toJSON()]]];
  }

  registerGenericInstance(trait: TraitType) {
    if (!this.genericInstances) this.genericInstances = [];
    this.genericInstances.push(trait);
  }
}
