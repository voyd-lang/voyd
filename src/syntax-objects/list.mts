import { Expr } from "./expr.mjs";
import { Float } from "./float.mjs";
import { getIdStr } from "./get-id-str.mjs";
import { Id, Identifier } from "./identifier.mjs";
import { Int } from "./int.mjs";
import { NamedEntity } from "./named-entity.mjs";
import { Syntax, SyntaxMetadata } from "./syntax.mjs";

export class List extends Syntax {
  readonly syntaxType = "list";
  /** True when the list was defined by the user using parenthesis i.e. (hey, there) */
  mayBeTuple?: boolean;
  value: Expr[] = [];

  constructor(
    opts: SyntaxMetadata & {
      value?: ListValue[] | List;
      isParentheticalList?: boolean;
    }
  ) {
    super(opts);
    const value = opts.value;
    this.mayBeTuple = opts.isParentheticalList;

    if (!value || value instanceof Array) {
      this.push(...(value ?? []));
    } else {
      this.push(...value.value);
    }
  }

  get hasChildren() {
    return !!this.value.length;
  }

  get length() {
    return this.value.length;
  }

  at(index: number): Expr | undefined {
    return this.value.at(index);
  }

  exprAt(index: number): Expr {
    const expr = this.value.at(index);
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

  listAt(index: number): List {
    const id = this.at(index);
    if (!id?.isList()) {
      throw new Error(`No list at index ${index}`);
    }
    return id;
  }

  set(index: number, expr: Expr | string) {
    const result = typeof expr === "string" ? Identifier.from(expr) : expr;
    result.parent = this;
    this.value[index] = result;
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
    const next = this.value.shift();
    if (!next) throw new Error("No remaining expressions");
    return next;
  }

  consumeRest(): List {
    const newVal = this.slice(0);
    this.value = [];
    return newVal;
  }

  first(): Expr | undefined {
    return this.value[0];
  }

  last(): Expr | undefined {
    return this.value.at(-1);
  }

  /** Returns all but the first element in an array */
  rest(): Expr[] {
    return this.value.slice(1);
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

      if (typeof ex === "number" && Number.isInteger(ex)) {
        this.value.push(new Int({ value: ex, parent: this }));
        return;
      }

      if (typeof ex === "number") {
        this.value.push(new Float({ value: ex, parent: this }));
        return;
      }

      if (ex instanceof Array) {
        this.push(new List({ value: ex, parent: this }));
        return;
      }

      ex.parent = this;

      if (ex instanceof NamedEntity) {
        this.registerEntity(ex);
      }

      if (ex.isList() && ex.calls("splice_quote")) {
        this.value.push(...ex.rest());
        return;
      }

      this.value.push(ex);
    });

    return this;
  }

  findIndex(cb: (expr: Expr) => boolean) {
    return this.value.findIndex(cb);
  }

  insert(expr: Expr | string, at = 0) {
    const result = typeof expr === "string" ? Identifier.from(expr) : expr;
    result.parent = this;
    this.value.splice(at, 0, result);
    return this;
  }

  remove(index: number, count = 1) {
    this.value.splice(index, count);
    return this;
  }

  filter(fn: (expr: Expr, index: number, array: Expr[]) => boolean): List {
    return new List({
      ...super.getCloneOpts(),
      value: this.value.filter(fn),
    });
  }

  each(fn: (expr: Expr, index: number, array: Expr[]) => void): List {
    this.value.forEach(fn);
    return this;
  }

  map(fn: (expr: Expr, index: number, array: Expr[]) => Expr): List {
    return new List({
      ...super.getCloneOpts(),
      value: this.value.map(fn),
    });
  }

  /** Like a regular map, but omits undefined values returned from the mapper */
  mapFilter(
    fn: (expr: Expr, index: number, array: Expr[]) => Expr | undefined
  ): List {
    const list = new List({ ...super.getCloneOpts() });
    return this.value.reduce((newList: List, expr, index, array) => {
      if (!expr) return newList;
      const result = fn(expr, index, array);
      if (!result) return newList;
      return newList.push(result);
    }, list);
  }

  slice(start?: number, end?: number): List {
    return new List({
      ...super.getCloneOpts(),
      value: this.value.slice(start, end),
    });
  }

  sliceAsArray(start?: number, end?: number) {
    return this.value.slice(start, end);
  }

  toArray(): Expr[] {
    return [...this.value];
  }

  toJSON() {
    return this.value;
  }

  clone(parent?: Expr): List {
    return new List({
      ...super.getCloneOpts(parent),
      value: this.value.map((v) => v.clone()),
      isParentheticalList: this.mayBeTuple,
    });
  }
}

export type ListValue = Expr | string | number | ListValue[];
