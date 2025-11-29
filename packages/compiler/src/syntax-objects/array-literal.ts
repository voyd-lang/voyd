import { Expr } from "./expr.js";
import { Syntax, SyntaxMetadata } from "./syntax.js";

export class ArrayLiteral extends Syntax {
  readonly syntaxType = "array-literal";
  elements: Expr[];

  constructor(opts: SyntaxMetadata & { elements: Expr[] }) {
    super(opts);
    this.elements = opts.elements;
    this.elements.forEach((e) => (e.parent = this));
  }

  clone(parent?: Expr): ArrayLiteral {
    return new ArrayLiteral({
      ...super.getCloneOpts(parent),
      elements: this.elements.map((e) => e.clone()),
    });
  }

  toJSON(): object {
    return [
      "array",
      `ArrayLiteral-${this.syntaxId}`,
      this.elements.map((e) => e.toJSON()),
    ];
  }
}
