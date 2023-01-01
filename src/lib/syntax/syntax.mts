import { Bool } from "./bool.mjs";
import { Expr } from "./expr.mjs";
import { Float } from "./float.mjs";
import { Identifier } from "./identifier.mjs";
import { LexicalContext } from "./lexical-context.mjs";
import { List } from "./list.mjs";
import { StringLiteral } from "./string-literal.mjs";
import { Type } from "./types.mjs";
import { Whitespace } from "./whitespace.mjs";

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
  abstract value: any;

  constructor({ location, context, parent }: SyntaxOpts) {
    this.location = location ?? context?.location;
    this.context = context?.context ?? new LexicalContext(parent?.context);
  }

  setFn(fn: Identifier) {
    this.context.setFn(fn);
  }

  getFns(fn: Identifier | string) {
    return this.context.getFns(fn);
  }

  setId(identifier: Identifier) {
    this.context.setId(identifier);
  }

  getId(identifier: Identifier | string) {
    return this.context.getId(identifier);
  }

  getType(): Type | undefined {
    return this.type;
  }

  setType(type: Type) {
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
