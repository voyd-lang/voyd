import { Expr } from "./expr.mjs";
import { getIdStr } from "./get-id-str.mjs";
import { Id, Identifier } from "./identifier.mjs";
import { Int } from "./int.mjs";
import { Syntax, SyntaxOpts } from "./syntax.mjs";

export class List extends Syntax {
  readonly syntaxType = "list";
  value: Expr[] = [];

  constructor(
    opts: SyntaxOpts & {
      value?: ListValue[] | List;
    }
  ) {
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

  set(index: number, value: Expr) {
    value.parent = this;
    this.value[index] = value; // Should this clone?
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

  first(): Expr | undefined {
    return this.value[0];
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

      if (ex instanceof Array) {
        this.push(new List({ value: ex, parent: this }));
        return;
      }

      const cloned = ex.clone(this);

      if (cloned.isList() && cloned.calls("splice-quote")) {
        this.value.push(...cloned.rest());
        return;
      }

      this.value.push(cloned);
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

  filter(fn: (expr: Expr, index: number, array: Expr[]) => boolean): List {
    return new List({
      ...super.getCloneOpts(),
      value: this.value.filter(fn),
    });
  }

  map(fn: (expr: Expr, index: number, array: Expr[]) => Expr): List {
    return new List({
      ...super.getCloneOpts(),
      value: this.value.map(fn),
    });
  }

  /** Returns a copy of this list where all the parameters mapped by the supplied function */
  mapArgs(fn: (expr: Expr, index: number, array: Expr[]) => Expr): List {
    const newList = new List({
      ...super.getCloneOpts(),
      value: this.rest().map(fn),
    });
    if (this.first()) newList.insert(this.first()!);
    return newList;
  }

  reduce(
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

  toJSON() {
    return this.value;
  }

  clone(parent?: Expr): List {
    return new List({ ...super.getCloneOpts(parent), value: this });
  }
}

export type ListValue = Expr | string | ListValue[];
