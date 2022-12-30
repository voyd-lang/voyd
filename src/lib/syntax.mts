import { toIdentifier } from "./to-identifier.mjs";

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

export type Expr = Bool | Int | Float | StringLiteral | Identifier | List;

export type SyntaxOpts = {
  location?: SourceLocation;
  context?: LexicalContext;
};

export abstract class Syntax {
  readonly id = getSyntaxId();
  readonly location?: SourceLocation;
  readonly context: LexicalContext;
  readonly props: Map<string, any> = new Map();
  readonly flags: Map<string, boolean> = new Map();
  abstract value: any;

  constructor({ location, context }: SyntaxOpts) {
    this.location = location;
    this.context = new LexicalContext(context);
  }

  abstract is(val: Syntax): boolean;

  toJSON() {
    return this.value;
  }
}

export class Identifier extends Syntax {
  value: string;
  isMutable?: boolean;
  bind?: Syntax;

  constructor(
    opts: SyntaxOpts & {
      value: string;
      isMutable?: boolean;
    }
  ) {
    super(opts);
    this.value = toIdentifier(opts.value);
    this.isMutable;
  }

  is(identifier: Syntax) {
    return identifier instanceof Identifier && this.value === identifier.value;
  }
}

export class Int extends Syntax {
  value: number;

  constructor(opts: SyntaxOpts & { value: number }) {
    super(opts);
    this.value = opts.value;
  }

  is(int: Syntax) {
    return int instanceof Int && this.value === int.value;
  }
}

export class Float extends Syntax {
  value: number;

  constructor(opts: SyntaxOpts & { value: number }) {
    super(opts);
    this.value = opts.value;
  }

  is(float: Syntax) {
    return float instanceof Int && this.value === float.value;
  }
}

export class StringLiteral extends Syntax {
  value: string;

  constructor(opts: SyntaxOpts & { value: string }) {
    super(opts);
    this.value = opts.value;
  }

  is(float: Syntax) {
    return float instanceof StringLiteral && this.value === float.value;
  }
}

export class Bool extends Syntax {
  value: boolean;

  constructor(opts: SyntaxOpts & { value: boolean }) {
    super(opts);
    this.value = opts.value;
  }

  is(float: Syntax) {
    return float instanceof Bool && this.value === float.value;
  }
}

export class List extends Syntax {
  value: Expr[];

  constructor(opts: SyntaxOpts & { value?: Expr[] }) {
    super(opts);
    this.value = opts.value ?? [];
  }

  first(): Expr | undefined {
    return this.value[0];
  }

  rest(): Expr[] {
    return this.value.slice(1);
  }

  push(expr: Expr) {
    this.value.push(expr);
    return this;
  }

  insert(expr: Expr, at = 0) {
    this.value.splice(at, 0, expr);
    return this;
  }

  is(_: Syntax): boolean {
    return false;
  }

  toJSON() {
    return this.value;
  }
}

export class LexicalContext {
  private parent?: LexicalContext;
  private fns: Map<string, Syntax[]> = new Map();
  private vars: Map<string, Syntax> = new Map();

  constructor(parent?: LexicalContext) {
    this.parent = parent;
  }

  getFns(identifier: string): Syntax[] | undefined {
    return this.fns.get(identifier) ?? this.parent?.getFns(identifier);
  }

  getVar(identifier: string): Syntax | undefined {
    return this.vars.get(identifier) ?? this.parent?.getVar(identifier);
  }
}

let currentSyntaxId = 0;
const getSyntaxId = () => {
  const current = currentSyntaxId;
  currentSyntaxId += 1;
  return current;
};
