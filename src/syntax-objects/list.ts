import { Expr } from "./expr.js";
import { Float } from "./float.js";
import { getIdStr } from "./lib/get-id-str.js";
import { Id, Identifier } from "./identifier.js";
import { Int } from "./int.js";
import { Syntax, SyntaxMetadata } from "./syntax.js";
import { ChildList } from "./lib/child-list.js";

type ListOpts =
  | ListValue[]
  | (SyntaxMetadata & {
      value?: ListValue[] | List | ChildList<Expr>;
      isParentheticalList?: boolean;
    });

export class List extends Syntax {
  readonly syntaxType = "list";
  #store = new ChildList(undefined, this);

  constructor(opts: ListOpts) {
    opts = Array.isArray(opts) ? { value: opts } : opts;
    super(opts);
    const value = opts.value;

    if (!value || value instanceof Array) {
      this.push(...(value ?? []));
    } else if (value instanceof List) {
      this.push(...value.toArray());
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
    return v?.isIdentifier() || v?.isStringLiteral() ? v.value : undefined;
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

      this.#store.push(ex);
    });

    return this;
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
