import { Expr } from "../expr.js";
import { Fn } from "../fn.js";
import { ChildList } from "../lib/child-list.js";
import { ScopedNamedEntityOpts } from "../named-entity.js";
import { Implementation } from "../implementation.js";
import { BaseType } from "./base-type.js";
import { ScopedEntity } from "../scoped-entity.js";
import { LexicalContext } from "../lib/lexical-context.js";
import { Type, TypeAlias, TypeJSON } from "../types.js";
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

  registerGenericInstance(trait: TraitType): TraitType {
    if (!this.genericInstances) this.genericInstances = [];

    const existing =
      this.genericInstances.find((instance) => instance === trait) ??
      this.genericInstances.find((instance) =>
        traitInstanceArgsMatch(instance, trait)
      );
    if (existing) {
      if (existing.genericParent !== this) {
        existing.genericParent = this;
      }
      return existing;
    }

    trait.genericParent = this;
    this.genericInstances.push(trait);
    return trait;
  }
}

const resolveAppliedArg = (type: Type | undefined): Type | undefined => {
  if (!type) return undefined;
  if ((type as TypeAlias).isTypeAlias?.()) {
    const alias = type as TypeAlias;
    return alias.type ?? alias;
  }
  return type;
};

const traitInstanceArgsMatch = (
  left: TraitType,
  right: TraitType
): boolean => {
  const leftArgs = left.appliedTypeArgs ?? [];
  const rightArgs = right.appliedTypeArgs ?? [];
  if (leftArgs.length !== rightArgs.length) return false;
  return leftArgs.every((candidate, index) => {
    const leftResolved = resolveAppliedArg(candidate);
    const rightResolved = resolveAppliedArg(rightArgs[index]);
    if (!leftResolved || !rightResolved) {
      return leftResolved === rightResolved;
    }
    if (leftResolved === rightResolved) return true;
    if (leftResolved.id === rightResolved.id) return true;
    return leftResolved.idNum === rightResolved.idNum;
  });
};
