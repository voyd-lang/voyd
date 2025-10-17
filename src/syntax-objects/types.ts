import { Expr } from "./expr.js";
import { Parameter } from "./parameter.js";
import { NamedEntityOpts } from "./named-entity.js";
import { ChildList } from "./lib/child-list.js";
import { Child } from "./lib/child.js";
import { TraitType } from "./trait.js";
import { BaseType } from "./types/base-type.js";
import { Obj } from "./obj.js";
import { TypeAlias } from "./type-alias.js";

export type Type =
  | PrimitiveType
  | UnionType
  | IntersectionType
  | TraitType
  | Obj
  | TupleType
  | FixedArrayType
  | FnType
  | SelfType
  | TypeAlias;

export type TypeJSON = ["type", [string, ...any[]]];

export class PrimitiveType extends BaseType {
  readonly kindOfType = "primitive";

  constructor(opts: NamedEntityOpts) {
    super(opts);
  }

  static from(name: Primitive) {
    return new PrimitiveType({ name });
  }

  clone(parent?: Expr): PrimitiveType {
    return new PrimitiveType({ ...super.getCloneOpts(parent) });
  }

  toJSON(): TypeJSON {
    return ["type", ["primitive", this.name]];
  }
}

export class SelfType extends BaseType {
  readonly kindOfType = "self";

  constructor(opts: NamedEntityOpts = { name: "Self" }) {
    super(opts);
  }

  clone(parent?: Expr): SelfType {
    return new SelfType({ ...super.getCloneOpts(parent) });
  }

  toJSON(): TypeJSON {
    return ["type", ["self"]];
  }
}

export class UnionType extends BaseType {
  readonly kindOfType = "union";
  resolutionPhase = 0; // No clone
  memberTypeExprs: ChildList<Expr>;
  resolvedMemberTypes: VoydRefType[] = [];

  constructor(opts: NamedEntityOpts & { childTypeExprs?: Expr[] }) {
    super(opts);
    this.memberTypeExprs = new ChildList(opts.childTypeExprs ?? [], this);
  }

  clone(parent?: Expr): UnionType {
    return new UnionType({
      ...super.getCloneOpts(parent),
      childTypeExprs: this.memberTypeExprs.clone(),
    });
  }

  toJSON(): TypeJSON {
    return ["type", ["union", ...this.memberTypeExprs.toArray()]];
  }
}

export class IntersectionType extends BaseType {
  readonly kindOfType = "intersection";
  nominalTypeExpr: Child<Expr>;
  structuralTypeExpr: Child<Expr>;
  nominalType?: Obj;
  structuralType?: Obj;

  constructor(
    opts: NamedEntityOpts & {
      nominalObjectExpr: Expr;
      structuralObjectExpr: Expr;
    }
  ) {
    super(opts);
    this.nominalTypeExpr = new Child(opts.nominalObjectExpr, this);
    this.structuralTypeExpr = new Child(opts.structuralObjectExpr, this);
  }

  clone(parent?: Expr): IntersectionType {
    return new IntersectionType({
      ...super.getCloneOpts(parent),
      nominalObjectExpr: this.nominalTypeExpr.clone(),
      structuralObjectExpr: this.structuralTypeExpr.clone(),
    });
  }

  toJSON(): TypeJSON {
    return [
      "type",
      [
        "intersection",
        this.nominalTypeExpr.value,
        this.structuralTypeExpr.value,
      ],
    ];
  }
}

export class TupleType extends BaseType {
  readonly kindOfType = "tuple";
  elementTypes: Type[];

  constructor(opts: NamedEntityOpts & { value: Type[] }) {
    super(opts);
    this.elementTypes = opts.value;
  }

  clone(parent?: Expr): TupleType {
    return new TupleType({
      ...super.getCloneOpts(parent),
      value: this.elementTypes,
    });
  }

  toJSON(): TypeJSON {
    return ["type", ["tuple", ...this.elementTypes]];
  }
}

/** Dynamically Sized Array (The raw gc array type) */
export class FixedArrayType extends BaseType {
  readonly kindOfType = "fixed-array";
  elemTypeExpr: Expr;
  elemType?: Type;
  /** Type used for locals, globals, function return type */
  binaryenType?: number;

  constructor(opts: NamedEntityOpts & { elemTypeExpr: Expr; elemType?: Type }) {
    super(opts);
    this.elemTypeExpr = opts.elemTypeExpr;
    this.elemTypeExpr.parent = this;
    this.elemType = opts.elemType;
  }

  clone(parent?: Expr): FixedArrayType {
    return new FixedArrayType({
      ...super.getCloneOpts(parent),
      elemTypeExpr: this.elemTypeExpr.clone(),
    });
  }

  toJSON(): TypeJSON {
    return ["type", ["FixedArray", this.elemType]];
  }
}

export class FnType extends BaseType {
  readonly kindOfType = "fn";
  readonly parameters: Parameter[];
  returnType?: Type;
  returnTypeExpr?: Expr;

  constructor(
    opts: NamedEntityOpts & {
      parameters: Parameter[];
      returnType?: Type;
      returnTypeExpr?: Expr;
    }
  ) {
    super(opts);
    this.parameters = opts.parameters;
    this.returnType = opts.returnType;
    this.returnTypeExpr = opts.returnTypeExpr;
    if (this.returnTypeExpr) {
      this.returnTypeExpr.parent = this;
    }
  }

  clone(parent?: Expr): FnType {
    const parameters = this.parameters.map((p) => p.clone());
    const returnTypeExpr = this.returnTypeExpr?.clone();
    const clone = new FnType({
      ...super.getCloneOpts(parent),
      returnType: this.returnType,
      parameters,
      returnTypeExpr,
    });
    parameters.forEach((p) => (p.parent = clone));
    return clone;
  }

  toJSON(): TypeJSON {
    return [
      "type",
      [
        "fn",
        this.id,
        ["parameters", this.parameters],
        ["return-type", this.returnType],
      ],
    ];
  }
}

export type Primitive = NumericType | ReferenceType | "void" | "voyd" | "bool";

export type NumericType = "i32" | "f32" | "i64" | "f64";
export type ReferenceType = "funcref" | "externref";

export const i32 = PrimitiveType.from("i32");
export const f32 = PrimitiveType.from("f32");
export const i64 = PrimitiveType.from("i64");
export const f64 = PrimitiveType.from("f64");
export const bool = PrimitiveType.from("bool");
export const dVoid = PrimitiveType.from("void");
export const dVoyd = PrimitiveType.from("voyd");
export const selfType = new SelfType();
export const voydBaseObject = new Obj({
  name: "Object",
  fields: [],
});

export type VoydRefType = Obj | UnionType | IntersectionType | TupleType;
