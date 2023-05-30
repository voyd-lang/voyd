import { Syntax, SyntaxOpts } from "./syntax.mjs";
import type { Id } from "./identifier.mjs";
import { getIdStr } from "./get-id-str.mjs";
import { Expr } from "./expr.mjs";

export type Type =
  | PrimitiveType
  | UnionType
  | IntersectionType
  | StructType
  | TupleType
  | ArrayType
  | FnType;

export abstract class BaseType extends Syntax {
  /** Size in bytes */
  abstract readonly size: number;
}

export class PrimitiveType extends BaseType {
  readonly __type = "primitive-type";
  value: WasmStackType;

  constructor(opts: SyntaxOpts & { value: WasmStackType }) {
    super(opts);
    this.value = opts.value;
  }

  get size() {
    if (this.value === "i32") return 4;
    if (this.value === "f32") return 4;
    if (this.value === "i64") return 8;
    if (this.value === "f64") return 8;
    return 0;
  }

  static isPrimitive(val: string): val is WasmStackType {
    return primitives.has(val);
  }

  static from(id: Id) {
    const str = getIdStr(id) as WasmStackType; // TODO: Check this
    return new PrimitiveType({ value: str });
  }

  clone(parent?: Expr): PrimitiveType {
    return new PrimitiveType({ parent, value: this.value, inherit: this });
  }
}

export class UnionType extends BaseType {
  readonly __type = "union-type";
  value: Type[];

  constructor(opts: SyntaxOpts & { value: Type[] }) {
    super(opts);
    this.value = opts.value;
  }

  get size() {
    let max = 0;
    for (const type of this.value) {
      if (type.size > max) max = type.size;
    }
    return max;
  }

  clone(parent?: Expr): UnionType {
    return new UnionType({ parent, value: this.value, inherit: this });
  }
}

export class IntersectionType extends BaseType {
  readonly __type = "intersection-type";
  value: Type[];

  constructor(opts: SyntaxOpts & { value: Type[] }) {
    super(opts);
    this.value = opts.value;
  }

  get size() {
    let total = 0;
    for (const type of this.value) {
      total += type.size;
    }
    return total;
  }

  clone(parent?: Expr): IntersectionType {
    return new IntersectionType({ parent, value: this.value, inherit: this });
  }
}

export class TupleType extends BaseType {
  readonly __type = "tuple-type";
  value: Type[];

  constructor(opts: SyntaxOpts & { value: Type[] }) {
    super(opts);
    this.value = opts.value;
  }

  get size() {
    let total = 0;
    for (const type of this.value) {
      total += type.size;
    }
    return total;
  }

  clone(parent?: Expr): TupleType {
    return new TupleType({ parent, value: this.value, inherit: this });
  }
}

export class StructType extends BaseType {
  readonly __type = "struct-type";
  value: { name: string; type: Type }[];

  constructor(opts: SyntaxOpts & { value: { name: string; type: Type }[] }) {
    super(opts);
    this.value = opts.value;
  }

  get size() {
    let total = 0;
    for (const field of this.value) {
      total += field.type.size;
    }
    return total;
  }

  toJSON() {
    return ["struct", ...this.value.map(({ name, type }) => [name, type])];
  }

  clone(parent?: Expr): StructType {
    return new StructType({ parent, value: this.value, inherit: this });
  }
}

export class ArrayType extends BaseType {
  readonly __type = "array-type";
  readonly size = Infinity;
  value: Type;

  constructor(opts: SyntaxOpts & { value: Type }) {
    super(opts);
    this.value = opts.value;
  }

  clone(parent?: Expr): ArrayType {
    return new ArrayType({ parent, value: this.value, inherit: this });
  }
}

export type FnTypeValue = {
  params: Param[];
  returns?: Type;
};

export type Param = { label?: string; name?: string; type: Type };

export class FnType extends BaseType {
  readonly __type = "fn-type";
  readonly size = 0;
  binaryenId = "";
  value: FnTypeValue;

  constructor(opts: SyntaxOpts & { value: FnTypeValue }) {
    super(opts);
    this.value = opts.value;
  }

  getParam(index: number): Param | undefined {
    return this.value.params[index];
  }

  get returns() {
    return this.value.returns;
  }

  set returns(type: Type | undefined) {
    this.value.returns = type;
  }

  clone(parent?: Expr): FnType {
    return new FnType({ parent, value: this.value, inherit: this });
  }
}

export type WasmStackType = NumericType | ReferenceType;
export type NumericType = "i32" | "f32" | "i64" | "f64";
export type ReferenceType = "funcref" | "externref";

const primitives = new Set([
  "f64",
  "f32",
  "i64",
  "i32",
  "void",
  "funcref",
  "externref",
]);

export const i32 = PrimitiveType.from("i32");
export const f32 = PrimitiveType.from("f32");
export const i64 = PrimitiveType.from("i64");
export const f64 = PrimitiveType.from("f64");
export const bool = PrimitiveType.from("i32");
export const dVoid = PrimitiveType.from("void");
export const CDT_ADDRESS_TYPE = i32;
