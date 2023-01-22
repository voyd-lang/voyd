import { Expr } from "./expr.mjs";
import { isList } from "./helpers.mjs";
import { Identifier } from "./identifier.mjs";
import { Int } from "./int.mjs";
import { Syntax, SyntaxOpts, SyntaxComparable } from "./syntax.mjs";

export class List extends Syntax {
  readonly __type = "list";
  value: Expr[] = [];

  constructor(opts: SyntaxOpts<ListValue[] | List>) {
    super(opts);
    const value = opts.value;

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
    return new Int({ value: this.value.length });
  }

  at(index: number): Expr | undefined {
    return this.value.at(index);
  }

  set(index: number, value: Expr) {
    value.setParent(this);
    this.value[index] = value; // Should this clone?
    return this;
  }

  calls(fnId: Expr | string) {
    return !!this.at(0)?.is(fnId);
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

  rest(): Expr[] {
    return this.value.slice(1);
  }

  pop(): Expr | undefined {
    return this.value.pop();
  }

  push(...expr: ListValue[]) {
    expr.forEach((ex) => this.pushOne(ex));
    return this;
  }

  private pushOne(ex: ListValue, checkForSpliceBlock = true) {
    if (typeof ex === "string") {
      this.value.push(new Identifier({ value: ex, parent: this }));
      return;
    }

    if (ex instanceof Array) {
      this.push(new List({ value: ex, parent: this }));
      return;
    }

    const cloned = ex.clone(this);

    // TODO: This should probably not be done here (thus the checkForSpliceBlock hack used by the constructor)
    if (checkForSpliceBlock && isList(cloned) && cloned.calls("splice-block")) {
      this.value.push(...cloned.rest());
      return;
    }

    this.value.push(cloned);
  }

  indexOf(expr: Expr) {
    return this.value.findIndex((v) => v.is(expr));
  }

  insert(expr: Expr | string, at = 0) {
    const result = typeof expr === "string" ? Identifier.from(expr) : expr;
    result.setParent(this);
    this.value.splice(at, 0, result);
    return this;
  }

  is(_?: SyntaxComparable): boolean {
    return false;
  }

  map(fn: (expr: Expr, index: number, array: Expr[]) => Expr): List {
    return new List({ value: this.value.map(fn), from: this });
  }

  /** Returns a copy of this list where all the parameters mapped by the supplied function */
  mapArgs(fn: (expr: Expr, index: number, array: Expr[]) => Expr): List {
    const newList = new List({ value: this.rest().map(fn), from: this });
    if (this.first()) newList.insert(this.first()!);
    return newList;
  }

  reduce(fn: (expr: Expr, index: number, array: Expr[]) => Expr): List {
    const list = new List({ from: this });
    return this.value.reduce((newList: List, expr, index, array) => {
      if (!expr) return newList;
      return newList.push(fn(expr, index, array));
    }, list);
  }

  slice(start?: number, end?: number): List {
    return new List({ from: this, value: this.value.slice(start, end) });
  }

  toJSON() {
    return this.value;
  }

  clone(parent?: Expr): List {
    return new List({ parent, value: this, from: this });
  }
}

/**
 * Passes a reference to itself rather than being copied on pushed.
 *
 * This was created due to an issue with the list.reduce function of
 * the macro expansion phase. The macro evaluator would clone the reduced
 * list when evaluating arguments to list.push. This prevented the list
 * from ever truly being updated as it was always pushing to a new list.
 *
 * Note: I've decided to use the normal list in a functional way, by chaining
 * the push operations and creating a new list on each push. This might
 * end up being too memory intensive, so I may use the BoxList in the future.
 */
export class BoxList extends List {
  clone() {
    return this;
  }
}

export type ListValue = Expr | string | ListValue[];
