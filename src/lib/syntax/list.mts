import { Identifier } from "./identifier.mjs";
import {
  Syntax,
  Expr,
  SyntaxOpts,
  Int,
  isList,
  SyntaxComparable,
} from "./syntax.mjs";

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

      if (isList(ex) && ex.calls("splice-block")) {
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

export type ListValue = Expr | string | ListValue[];
