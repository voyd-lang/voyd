import { Expr } from "./expr.js";
import { Float } from "./float.js";
import { getIdStr } from "./lib/get-id-str.js";
import { Id, Identifier } from "./identifier.js";
import { Int } from "./int.js";
import { SourceLocation, Syntax, SyntaxMetadata } from "./syntax.js";
import { ChildList } from "./lib/child-list.js";

type ListOpts =
  | ListValue[]
  | (SyntaxMetadata & {
      value?: ListValue[] | List | ChildList<Expr>;
      dynamicLocation?: boolean;
    });

export class List extends Syntax {
  readonly syntaxType = "list";
  #store = new ChildList(undefined, this);
  dynamicLocation?: boolean;

  constructor(opts: ListOpts) {
    opts = Array.isArray(opts) ? { value: opts } : opts;
    super(opts);
    const value = opts.value;
    this.dynamicLocation = opts.dynamicLocation;

    if (value instanceof Array) {
      value.forEach((v) => this.push(v));
    } else if (value instanceof List) {
      value.toArray().forEach((v) => this.push(v));
    }
  }

  get children() {
    return this.toArray();
  }

  get hasChildren() {
    return !!this.#store.length;
  }

  get length() {
    return this.#store.length;
  }

  at(index: number): Expr | undefined {
    return this.#store.at(index);
  }

  exprAt(index: number): Expr {
    const expr = this.#store.at(index);
    if (!expr) {
      throw new Error(`No expr at ${index}`);
    }
    return expr;
  }

  identifierAt(index: number): Identifier {
    const id = this.at(index);
    if (!id?.isIdentifier()) {
      throw new Error(`No identifier at index ${index}`);
    }
    return id;
  }

  optionalIdentifierAt(index: number): Identifier | undefined {
    const id = this.at(index);
    if (id?.isIdentifier()) return id;
  }

  listAt(index: number): List {
    const id = this.at(index);
    if (!id?.isList()) {
      throw new Error(`No list at index ${index}`);
    }
    return id;
  }

  set(index: number, expr: Expr | string) {
    const result = typeof expr === "string" ? Identifier.from(expr) : expr;
    this.#store.set(index, result);
    return this;
  }

  calls(fnId: Id, atIndex = 0) {
    return this.getIdStrAt(atIndex) === getIdStr(fnId);
  }

  getIdStrAt(index: number): string | undefined {
    const v = this.at(index);
    return v?.isIdentifier() ? v.value : undefined;
  }

  consume(): Expr {
    return this.#store.consume();
  }

  first(): Expr | undefined {
    return this.#store.at(0);
  }

  last(): Expr | undefined {
    return this.#store.at(-1);
  }

  /** Returns all but the first element in an array */
  argsArray(): Expr[] {
    return this.#store.toArray().slice(1);
  }

  pop(): Expr | undefined {
    return this.#store.pop();
  }

  push(...expr: ListValue[]) {
    expr.forEach((ex) => {
      if (typeof ex === "string") {
        this.#store.push(new Identifier({ value: ex, parent: this }));
        return;
      }

      if (typeof ex === "number" && Number.isInteger(ex)) {
        this.#store.push(new Int({ value: ex, parent: this }));
        return;
      }

      if (typeof ex === "number") {
        this.#store.push(new Float({ value: ex, parent: this }));
        return;
      }

      if (ex instanceof Array) {
        this.push(new List({ value: ex, parent: this }));
        return;
      }

      if (ex.syntaxType === "nop") {
        return;
      }

      if (this.dynamicLocation) {
        this.updateLocationFrom(ex);
      }

      this.#store.push(ex);
    });

    return this;
  }

  private updateLocationFrom(ex: Expr) {
    if (!ex.location) return;

    if (!this.location) {
      this.location = ex.location.clone();
    }

    if (this.location.startIndex > ex.location.startIndex) {
      const nl = ex.location.clone();
      nl.setEndToEndOf(this.location);
      this.location = nl;
    }

    if (
      !this.location.endColumn ||
      this.location.endIndex < ex.location.endIndex
    ) {
      this.location?.setEndToEndOf(ex.location);
    }
  }

  findIndex(cb: (expr: Expr) => boolean) {
    return this.toArray().findIndex(cb);
  }

  insert(expr: Expr | string, at = 0) {
    const result = typeof expr === "string" ? Identifier.from(expr) : expr;
    this.#store.insert(result, at);
    return this;
  }

  remove(index: number, count = 1) {
    this.#store.remove(index, count);
    return this;
  }

  each(fn: (expr: Expr, index: number, array: Expr[]) => void): List {
    this.toArray().forEach(fn);
    return this;
  }

  map(fn: (expr: Expr, index: number, array: Expr[]) => Expr): List {
    return new List({
      ...super.getCloneOpts(),
      value: this.toArray().map(fn),
    });
  }

  flatMap(
    fn: (expr: Expr, index: number, array: Expr[]) => Expr | Expr[]
  ): List {
    return new List({
      ...super.getCloneOpts(),
      value: this.toArray().flatMap(fn),
    });
  }

  reduce(
    fn: (acc: List, expr: Expr, index: number, array: Expr[]) => List
  ): List {
    return this.toArray().reduce(fn, new List({ ...super.getCloneOpts() }));
  }

  slice(start?: number, end?: number): List {
    return new List({
      ...super.getCloneOpts(),
      value: this.#store.slice(start, end),
    });
  }

  sliceAsArray(start?: number, end?: number) {
    return this.children.slice(start, end);
  }

  // TODO: Move this to call?
  private getArgIfLabel(expr: Expr, label: string) {
    if (!expr.isCall()) return;
    if (!expr.calls(":")) return;
    const labelId = expr.argAt(0);
    if (!labelId?.isIdentifier()) return;

    if (labelId.value === label) {
      return expr.argAt(1);
    }
  }

  /**
   * Returns the expression for a labeled argument, eg. for the list
   * `[hello, [:, world, 1]]` – which represents `hello(world: 1)` –
   * `labeledArg("world")` will return the expression `1`.
   *
   * If the label is not found, `undefined` is returned.
   */
  optionalLabeledArg(label: string): Expr | undefined {
    for (const expr of this.#store.toArray()) {
      const arg = this.getArgIfLabel(expr, label);
      if (arg) return arg;
    }

    return undefined;
  }

  /**
   * Returns all args with the same label, useful for functions like
   * if -- with multiple elif:
   */
  argsWithLabel(label: string): Expr[] {
    const args: Expr[] = [];
    for (const expr of this.#store.toArray()) {
      const arg = this.getArgIfLabel(expr, label);
      if (arg) args.push(arg);
    }

    return args;
  }

  /** Asserts that a labeled argument exists and returns its expression. */
  labeledArg(label: string): Expr {
    const expr = this.optionalLabeledArg(label);
    if (!expr) throw new Error(`Labeled argument '${label}' not found`);
    return expr;
  }

  /**
   * Returns `true` when the list contains a labeled argument with the provided
   * name.
   */
  hasLabeledArg(label: string): boolean {
    return this.optionalLabeledArg(label) !== undefined;
  }

  /**
   * Builds and returns a map of all labeled arguments contained in the list.
   */
  getLabeledArgs(): Map<string, Expr> {
    const map = new Map<string, Expr>();
    for (const expr of this.#store.toArray()) {
      if (!expr.isCall() || !expr.calls(":")) continue;
      const labelId = expr.argAt(0);
      if (!labelId?.isIdentifier()) continue;
      const valueExpr = expr.argAt(1);
      if (valueExpr) map.set(labelId.value, valueExpr);
    }
    return map;
  }

  toArray(): Expr[] {
    return this.#store.toArray();
  }

  toJSON() {
    return this.toArray();
  }

  /** Clones should return a deep copy of all expressions except for type expressions */
  clone(parent?: Expr): List {
    return new List({
      ...super.getCloneOpts(parent),
      value: this.#store.clone(),
    });
  }
}

export type ListValue = Expr | string | number | ListValue[];
