import { Expr } from "./expr.js";
import { Identifier } from "./identifier.js";
import { NamedEntity, NamedEntityOpts } from "./named-entity.js";
import { Type } from "./types.js";

export class Parameter extends NamedEntity {
  readonly syntaxType = "parameter";
  /** External label the parameter must be called with e.g. myFunc(label: value) */
  label?: Identifier;
  originalType?: Type;
  type?: Type;
  typeExpr?: Expr;
  requiresCast = false;

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
    if (this.typeExpr) {
      this.typeExpr.parent = this;
    }
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
      label: this.label,
      typeExpr: this.typeExpr?.clone(),
    });
  }

  toJSON() {
    return ["define-parameter", this.name, ["label", this.label], this.type];
  }
}
