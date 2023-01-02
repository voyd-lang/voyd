import type { Expr } from "./expr.mjs";
import type { Id } from "./identifier.mjs";
import { LexicalContext, Var } from "./lexical-context.mjs";
import type { FnType, Type } from "./types.mjs";

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

export type SyntaxComparable = Expr | string | number | boolean;

export type SyntaxOpts = {
  location?: SourceLocation;
  context?: Syntax;
  parent?: Syntax;
};

export abstract class Syntax {
  readonly id = getSyntaxId();
  readonly location?: SourceLocation;
  readonly context: LexicalContext;
  readonly props: Map<string, any> = new Map();
  readonly flags: Map<string, boolean> = new Map();
  protected type?: Type;
  // Typescript can't discriminate between types via instanceof without this for some reason
  abstract readonly __type: string;
  abstract value: any;

  constructor({ location, context, parent }: SyntaxOpts) {
    this.location = location ?? context?.location;
    this.context = context?.context ?? new LexicalContext(parent?.context);
  }

  setFn(id: Id, fn: FnType) {
    this.context.setFn(id, fn);
    return this;
  }

  getFns(id: Id) {
    return this.context.getFns(id);
  }

  setVar(id: Id, val: Omit<Var, "index">) {
    this.context.setVar(id, val);
    return this;
  }

  getVar(id: Id) {
    return this.context.getVar(id);
  }

  getAllFnVars() {
    return this.context.getAllFnVars();
  }

  getAllFnParams() {
    return this.context.getAllFnParams();
  }

  setType(id: Id, val: Type) {
    this.context.setType(id, val);
    return this;
  }

  getType(id: Id) {
    return this.context.getType(id);
  }

  getTypeOf(): Type | undefined {
    return this.type;
  }

  setTypeOf(type: Type) {
    this.type = type;
    return this;
  }

  is(val?: SyntaxComparable) {
    if (val instanceof Syntax) {
      return val.value === this.value;
    }

    return val === this.value;
  }

  setParent(parent: Syntax) {
    this.context.setParent(parent.context);
    return this;
  }

  toJSON() {
    return this.value;
  }
}

let currentSyntaxId = 0;
const getSyntaxId = () => {
  const current = currentSyntaxId;
  currentSyntaxId += 1;
  return current;
};
