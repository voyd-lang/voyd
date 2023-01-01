export type Type =
  | PrimitiveType
  | UnionType
  | IntersectionType
  | StructType
  | TupleType
  | ArrayType
  | FnType;

export const CDT_ADDRESS_TYPE = "i32";

export abstract class BaseType {
  /** Size in bytes */
  abstract readonly size: number;
}

export class PrimitiveType extends BaseType {
  value: WasmStackType;

  constructor(opts: { value: WasmStackType }) {
    super();
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
}

export class UnionType extends BaseType {
  private readonly __type = "union-type";
  value: Type[];

  constructor(opts: { value: Type[] }) {
    super();
    this.value = opts.value;
  }

  get size() {
    let max = 0;
    for (const type of this.value) {
      if (type.size > max) max = type.size;
    }
    return max;
  }
}

export class IntersectionType extends BaseType {
  private readonly __type = "intersection-type";
  value: Type[];

  constructor(opts: { value: Type[] }) {
    super();
    this.value = opts.value;
  }

  get size() {
    let total = 0;
    for (const type of this.value) {
      total += type.size;
    }
    return total;
  }
}

export class TupleType extends BaseType {
  private readonly __type = "tuple-type";
  value: Type[];

  constructor(opts: { value: Type[] }) {
    super();
    this.value = opts.value;
  }

  get size() {
    let total = 0;
    for (const type of this.value) {
      total += type.size;
    }
    return total;
  }
}

export class StructType extends BaseType {
  private readonly __type = "struct-type";
  value: { name: string; type: Type }[];

  constructor(opts: { value: { name: string; type: Type }[] }) {
    super();
    this.value = opts.value;
  }

  get size() {
    let total = 0;
    for (const field of this.value) {
      total += field.type.size;
    }
    return total;
  }
}

export class ArrayType extends BaseType {
  private readonly __type = "array-type";
  readonly size = Infinity;
  value: Type;

  constructor(opts: { value: Type }) {
    super();
    this.value = opts.value;
  }
}

export type FnTypeValue = {
  params: { label?: string; name: string; type: Type }[];
  returns: Type;
};

export class FnType extends BaseType {
  private readonly __type = "array-type";
  readonly size = 0;
  value: FnTypeValue;

  constructor(opts: { value: FnTypeValue }) {
    super();
    this.value = opts.value;
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
