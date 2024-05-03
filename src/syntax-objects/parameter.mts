import { Expr } from "./expr.mjs";
import { Identifier } from "./identifier.mjs";
import { NamedEntity, NamedEntityOpts } from "./named-entity.mjs";
import { Type } from "./types.mjs";

export class Parameter extends NamedEntity {
  readonly syntaxType = "parameter";
  /** External label the parameter must be called with e.g. myFunc(label: value) */
  label?: Identifier;
  type?: Type;
  typeExpr?: Expr;

  constructor(
    opts: NamedEntityOpts & {
      label?: Identifier;
      type?: Type;
      typeExpr?: Expr;
    }
  ) {
    super(opts);
    this.label = opts.label;
    this.type = opts.type;
    this.typeExpr = opts.typeExpr;
  }

  getIndex(): number {
    const index = this.parentFn?.getIndexOfParameter(this) ?? -1;
    if (index < -1) {
      throw new Error(`Parameter ${this} is not registered with a function`);
    }
    return index;
  }

  toString() {
    return this.name.toString();
  }

  clone(parent?: Expr | undefined): Parameter {
    return new Parameter({
      ...super.getCloneOpts(parent),
      type: this.type,
      label: this.label,
    });
  }

  toJSON() {
    return ["define-parameter", this.name, ["label", this.label], this.type];
  }
}
