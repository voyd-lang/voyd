import type { Expr } from "./expr.mjs";
import type { Fn } from "./fn.mjs";
import type { Id } from "./identifier.mjs";
import { IdentifierEntity, LexicalContext } from "./lexical-context.mjs";
import { Parameter } from "./parameter.mjs";
import { Variable } from "./variable.mjs";

export type SourceLocation = {
  /** The exact character index the syntax starts */
  startIndex: number;
  /** The exact character index the syntax ends */
  endIndex: number;
  /** The line the syntax is located in */
  line: number;
  /** The column within the line the syntax begins */
  column: number;

  filePath: string;
};

export type SyntaxOpts = {
  location?: SourceLocation;
  inherit?: Syntax;
  parent?: Expr;
};

export abstract class Syntax {
  readonly id = getSyntaxId();
  readonly location?: SourceLocation;
  readonly context: LexicalContext;
  readonly props: Map<string, Expr> = new Map();
  readonly flags: Set<string> = new Set();
  protected parent?: Expr;
  /** For tagged unions */
  abstract readonly syntaxType: string;

  constructor({ location, inherit, parent }: SyntaxOpts) {
    this.location = location ?? inherit?.location;
    this.parent = parent ?? inherit?.getParent();
    this.context = inherit?.context ?? new LexicalContext();
  }

  get parentFn(): Fn | undefined {
    return this.parent?.syntaxType === "fn"
      ? this.parent
      : this.parent?.parentFn;
  }

  getFns(id: Id, start: Fn[] = []): Fn[] {
    start.push(...this.context.getFns(id));
    if (this.parent) return this.parent.getFns(id, start);
    return start;
  }

  registerEntity(id: Id, v: IdentifierEntity) {
    this.context.registerEntity(id, v);
    if (v.syntaxType === "parameter" || v.syntaxType === "variable") {
      this.registerLocalWithParentFn(v);
    }
  }

  resolveIdentifier(id: Id): IdentifierEntity | undefined {
    return (
      this.context.resolveIdentifier(id) ?? this.parent?.resolveIdentifier(id)
    );
  }

  getParent() {
    return this.parent;
  }

  setParent(parent?: Expr) {
    this.parent = parent;
    return this;
  }

  abstract clone(parent?: Expr): Expr;
  abstract toJSON(): any;

  private registerLocalWithParentFn(v: Variable | Parameter): void {
    if (!this.parent) {
      throw new Error(`Not in fn, cannot register ${v}`);
    }

    if (this.parent.syntaxType === "fn") {
      this.parent?.registerLocal(v);
      return;
    }

    return this.parent.registerLocalWithParentFn(v);
  }
}

let currentSyntaxId = 0;
const getSyntaxId = () => {
  const current = currentSyntaxId;
  currentSyntaxId += 1;
  return current;
};
