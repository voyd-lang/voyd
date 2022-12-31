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

export type Expr =
  | Comment
  | Bool
  | Int
  | Float
  | StringLiteral
  | Identifier
  | Whitespace
  | List;

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
  protected type?: Expr;
  abstract value: any;

  constructor({ location, context, parent }: SyntaxOpts) {
    this.location = location ?? context?.location;
    this.context = context?.context ?? new LexicalContext(parent?.context);
  }

  setFn(fn: Identifier) {
    this.context.setFn(fn);
  }

  setVar(identifier: Identifier) {
    this.context.setVar(identifier);
  }

  getFns(fn: Identifier | string) {
    return this.context.getFns(fn);
  }

  getVar(identifier: Identifier | string) {
    return this.context.getVar(identifier);
  }

  getType(): Expr | undefined {
    return this.type;
  }

  setType(type: Expr) {
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

export type IdentifierKind = "fn" | "var" | "param" | "global";

export class Identifier extends Syntax {
  private kind?: IdentifierKind;
  /** A place to store an value for the identifier during expansion time only. */
  private result?: Expr;
  /** The actual string ID of the identifier */
  value: string;
  isMutable?: boolean;
  /** The Expr the identifier is bound to. Can be a function, variable initializer, etc. */
  bind?: Expr;
  /** Used to identify a labeled parameter on function call */
  label?: string;

  constructor(
    opts: SyntaxOpts & {
      value: string;
      bind?: Expr;
      isMutable?: boolean;
      kind?: IdentifierKind;
      label?: string;
    }
  ) {
    super(opts);
    this.value = toIdentifier(opts.value);
    this.bind = opts.bind;
    this.isMutable = opts.isMutable;
    this.kind = opts.kind;
    this.label = opts.label;
  }

  get isDefined() {
    return !!this.bind;
  }

  static from(str: string) {
    return new Identifier({ value: str });
  }

  getKind(): IdentifierKind | undefined {
    return (
      this.kind ?? (isIdentifier(this.bind) ? this.bind.getKind() : undefined)
    );
  }

  setKind(kind: IdentifierKind) {
    isIdentifier(this.bind) ? this.bind.setKind(kind) : (this.kind = kind);
    return this;
  }

  getType(): Expr | undefined {
    return (
      this.type ?? (isIdentifier(this.bind) ? this.bind.getType() : undefined)
    );
  }

  setType(type: Expr) {
    isIdentifier(this.bind) ? this.bind.setType(type) : (this.type = type);
    return this;
  }

  /** Returns the result of the identifier */
  getResult(): Expr | undefined {
    if (this.result) return this.result;
    if (isIdentifier(this.bind)) return this.bind.getResult();
  }

  /** Like get result but throws if undefined */
  assertedResult(): Expr {
    if (this.result) return this.result;
    if (isIdentifier(this.bind)) return this.bind.assertedResult();
    throw new Error(`Identifier ${this.value} is not defined`);
  }

  setResult(val: Expr) {
    if (isIdentifier(this.bind)) {
      this.bind.setResult(val);
      return this;
    }

    this.result = val;
    return this;
  }
}

export class Int extends Syntax {
  value: number;

  constructor(opts: SyntaxOpts & { value: number }) {
    super(opts);
    this.value = opts.value;
  }
}

export class Float extends Syntax {
  value: number;

  constructor(opts: SyntaxOpts & { value: number }) {
    super(opts);
    this.value = opts.value;
  }
}

export class StringLiteral extends Syntax {
  // Typescript can't discriminate between StringLiteral and Identifier without this for some reason
  readonly __type = "string-literal";
  value: string;

  constructor(opts: SyntaxOpts & { value: string }) {
    super(opts);
    this.value = opts.value;
  }
}

export class Comment extends Syntax {
  readonly __type = "comment";
  value: string;

  constructor(opts: SyntaxOpts & { value: string }) {
    super(opts);
    this.value = opts.value;
  }
}

export class Bool extends Syntax {
  value: boolean;

  constructor(opts: SyntaxOpts & { value: boolean }) {
    super(opts);
    this.value = opts.value;
  }
}

export type ListValue = Expr | string | ListValue[];

export class List extends Syntax {
  value: Expr[] = [];

  constructor(opts: SyntaxOpts & { value?: ListValue[] }) {
    super(opts);
    this.push(...(opts.value ?? []));
  }

  get hasChildren() {
    return !!this.value.length;
  }

  get length() {
    return new Int({ value: this.value.length });
  }

  at(index: number): Expr | undefined {
    return this.value.at(index);
  }

  calls(fnId: Expr | string) {
    return this.at(0)?.is(fnId);
  }

  consume(): Expr {
    const next = this.value.shift();
    if (!next) {
      throw new Error("No remaining expressions");
    }
    return next;
  }

  first(): Expr | undefined {
    return this.value[0];
  }

  rest(): List {
    return new List({ value: this.value.slice(1), context: this });
  }

  pop(): Expr | undefined {
    return this.value.pop();
  }

  push(...expr: ListValue[]) {
    expr.forEach((ex) => {
      if (typeof ex === "string") {
        this.value.push(new Identifier({ value: ex, parent: this }));
        return;
      }

      if (ex instanceof Array) {
        this.push(new List({ value: ex, parent: this }));
        return;
      }

      ex.setParent(this);

      if (
        isList(ex) &&
        isIdentifier(ex.first()) &&
        ex.first()!.value === "splice-block"
      ) {
        this.value.push(...ex.rest().value);
        return;
      }

      this.value.push(ex);
    });

    return this;
  }

  indexOf(expr: Expr) {
    return this.value.findIndex((v) => v.is(expr));
  }

  insert(expr: Expr | string, at = 0) {
    const result = typeof expr === "string" ? Identifier.from(expr) : expr;
    this.value.splice(at, 0, result);
    return this;
  }

  is(_?: SyntaxComparable): boolean {
    return false;
  }

  map(fn: (expr: Expr, index: number, array: Expr[]) => Expr): List {
    return new List({ value: this.value.map(fn), context: this });
  }

  reduce(fn: (expr: Expr, index: number, array: Expr[]) => Expr): List {
    const list = new List({ value: [], context: this });
    return this.value.reduce((newList: List, expr, index, array) => {
      if (!expr) return newList;
      return newList.push(fn(expr, index, array));
    }, list);
  }

  slice(start?: number, end?: number): List {
    return new List({ context: this, value: this.value.slice(start, end) });
  }

  toJSON() {
    return this.value;
  }
}

export class Whitespace extends Syntax {
  private readonly __type = "whitespace";
  value: string;

  constructor(opts: SyntaxOpts & { value: string }) {
    super(opts);
    this.value = opts.value;
  }

  get isNewline() {
    return this.value === "\n";
  }

  get isSpace() {
    return this.value === " ";
  }

  get isTab() {
    return this.value === "\t";
  }
}

export class LexicalContext {
  private parent?: LexicalContext;
  private fns: Map<string, Identifier[]> = new Map();
  private vars: Map<string, Identifier> = new Map();

  constructor(parent?: LexicalContext) {
    this.parent = parent;
  }

  setFn(identifier: Identifier) {
    const fns = this.fns.get(identifier.value);
    if (!fns) {
      this.fns.set(identifier.value, [identifier]);
      return this;
    }
    fns.push(identifier);
    return this;
  }

  setVar(identifier: Identifier) {
    this.vars.set(identifier.value, identifier);
    return this;
  }

  setParent(parent: LexicalContext) {
    this.parent = parent;
  }

  getFns(identifier: Identifier | string): Identifier[] | undefined {
    const id = typeof identifier === "string" ? identifier : identifier.value;
    return this.fns.get(id) ?? this.parent?.getFns(id);
  }

  getVar(identifier: Identifier | string): Identifier | undefined {
    const id = typeof identifier === "string" ? identifier : identifier.value;
    return this.vars.get(id) ?? this.parent?.getVar(id);
  }
}

let currentSyntaxId = 0;
const getSyntaxId = () => {
  const current = currentSyntaxId;
  currentSyntaxId += 1;
  return current;
};

export const isStringLiteral = (expr: Expr): expr is StringLiteral =>
  expr instanceof StringLiteral;
export const isList = (expr?: Expr): expr is List => expr instanceof List;
export const isFloat = (expr?: Expr): expr is Float => expr instanceof Float;
export const isInt = (expr?: Expr): expr is Int => expr instanceof Int;
export const isBool = (expr?: Expr): expr is Bool => expr instanceof Bool;
export const isWhitespace = (expr?: Expr): expr is Whitespace =>
  expr instanceof Whitespace;
export const isIdentifier = (expr?: Expr): expr is Identifier =>
  expr instanceof Identifier;
export const newLine = () => new Whitespace({ value: "\n" });
