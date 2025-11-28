import { Expr } from "./expr.js";
import { Identifier } from "./identifier.js";
import { ChildList } from "./lib/child-list.js";
import { Child } from "./lib/child.js";
import { LexicalContext } from "./lib/lexical-context.js";
import { NamedEntityOpts } from "./named-entity.js";
import { Type, TypeJSON } from "./types.js";
import { BaseType } from "./types/base-type.js";

export class TypeAlias extends BaseType {
  readonly kindOfType = "type-alias";
  resolutionPhase = 0; // No clone
  lexicon: LexicalContext = new LexicalContext();
  #typeExpr: Child<Expr>;
  resolvedType?: Type;
  #typeParameters = new ChildList<Identifier>([], this);

  constructor(
    opts: NamedEntityOpts & { typeExpr: Expr; typeParameters?: Identifier[] }
  ) {
    super(opts);
    this.#typeExpr = new Child(opts.typeExpr, this);
    this.typeExpr.parent = this;
    this.typeParameters = opts.typeParameters;
  }

  get typeExpr() {
    return this.#typeExpr.value;
  }

  set typeExpr(v: Expr) {
    this.#typeExpr.value = v;
  }

  get typeParameters() {
    const params = this.#typeParameters.toArray();
    return !params.length ? undefined : params;
  }

  set typeParameters(params: Identifier[] | undefined) {
    this.#typeParameters = new ChildList(params ?? [], this);
  }

  toJSON(): TypeJSON {
    return ["type", ["type-alias", this.typeExpr]];
  }

  clone(parent?: Expr | undefined): TypeAlias {
    return new TypeAlias({
      ...super.getCloneOpts(parent),
      typeExpr: this.#typeExpr.clone(),
      typeParameters: this.#typeParameters.clone(),
    });
  }
}
