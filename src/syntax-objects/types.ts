import { Expr } from "./expr.js";
import { Parameter } from "./parameter.js";
import { NamedEntityOpts } from "./named-entity.js";
import { Id, Identifier } from "./identifier.js";
import { getIdStr } from "./lib/get-id-str.js";
import { LexicalContext } from "./lib/lexical-context.js";
import { Implementation } from "./implementation.js";
import { ScopedEntity } from "./scoped-entity.js";
import { ChildList } from "./lib/child-list.js";
import { Child } from "./lib/child.js";
import { TraitType } from "./types/trait.js";
import { BaseType } from "./types/base-type.js";

export type Type =
  | PrimitiveType
  | UnionType
  | IntersectionType
  | TraitType
  | ObjectType
  | TupleType
  | FixedArrayType
  | FnType
  | TypeAlias;

export type TypeJSON = ["type", [string, ...any[]]];
export class TypeAlias extends BaseType {
  readonly kindOfType = "type-alias";
  lexicon: LexicalContext = new LexicalContext();
  typeExpr: Expr;
  type?: Type;
  typeParameters?: Identifier[];

  constructor(
    opts: NamedEntityOpts & { typeExpr: Expr; typeParameters?: Identifier[] }
  ) {
    super(opts);
    this.typeExpr = opts.typeExpr;
    this.typeExpr.parent = this;
    this.typeParameters = opts.typeParameters;
  }

  toJSON(): TypeJSON {
    return ["type", ["type-alias", this.typeExpr]];
  }

  clone(parent?: Expr | undefined): TypeAlias {
    return new TypeAlias({
      ...super.getCloneOpts(parent),
      typeExpr: this.typeExpr.clone(),
      typeParameters: this.typeParameters,
    });
  }
}

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

export class UnionType extends BaseType {
  readonly kindOfType = "union";
  childTypeExprs: ChildList<Expr>;
  types: (ObjectType | IntersectionType | UnionType)[] = [];

  constructor(opts: NamedEntityOpts & { childTypeExprs?: Expr[] }) {
    super(opts);
    this.childTypeExprs = new ChildList(opts.childTypeExprs ?? [], this);
  }

  clone(parent?: Expr): UnionType {
    return new UnionType({
      ...super.getCloneOpts(parent),
      childTypeExprs: this.childTypeExprs.clone(),
    });
  }

  toJSON(): TypeJSON {
    return ["type", ["union", ...this.childTypeExprs.toArray()]];
  }
}

export class IntersectionType extends BaseType {
  readonly kindOfType = "intersection";
  nominalTypeExpr: Child<Expr>;
  structuralTypeExpr: Child<Expr>;
  nominalType?: ObjectType;
  structuralType?: ObjectType;

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
  value: Type[];

  constructor(opts: NamedEntityOpts & { value: Type[] }) {
    super(opts);
    this.value = opts.value;
  }

  clone(parent?: Expr): TupleType {
    return new TupleType({ ...super.getCloneOpts(parent), value: this.value });
  }

  toJSON(): TypeJSON {
    return ["type", ["tuple", ...this.value]];
  }
}

export type ObjectField = {
  name: string;
  typeExpr: Expr;
  type?: Type;
  binaryenGetterType?: number;
  binaryenSetterType?: number;
};

export class ObjectType extends BaseType implements ScopedEntity {
  readonly kindOfType = "object";
  lexicon: LexicalContext = new LexicalContext();
  typeParameters?: Identifier[];
  appliedTypeArgs?: Type[];
  genericInstances?: ObjectType[];
  /** If this is a genericInstance of an object, this is the generic version itself that it was generated from */
  genericParent?: ObjectType;
  fields: ObjectField[];
  parentObjExpr?: Expr;
  parentObjType?: ObjectType;
  /** Type used for locals, globals, function return type */
  binaryenType?: number;
  typesResolved?: boolean; // Don't set if type parameters are present
  implementations: Implementation[];
  isStructural = false;
  #iteration = 0;

  constructor(
    opts: NamedEntityOpts & {
      value: ObjectField[];
      parentObjExpr?: Expr;
      parentObj?: ObjectType;
      typeParameters?: Identifier[];
      implementations?: Implementation[];
      isStructural?: boolean;
    }
  ) {
    super(opts);
    this.fields = opts.value;
    this.fields.forEach((field) => {
      field.typeExpr.parent = this;
    });
    this.parentObjType = opts.parentObj;
    this.parentObjExpr = opts.parentObjExpr;
    this.typeParameters = opts.typeParameters;
    this.implementations = opts.implementations ?? [];
    this.isStructural = opts.isStructural ?? false;
  }

  get size() {
    return 4;
  }

  toJSON(): TypeJSON {
    return [
      "type",
      [
        "object",
        this.id,
        ...this.fields.map(({ name, typeExpr }) => [name, typeExpr]),
      ],
    ];
  }

  clone(parent?: Expr): ObjectType {
    return new ObjectType({
      ...super.getCloneOpts(parent),
      id: `${this.id}#${this.#iteration++}`,
      value: this.fields.map((field) => ({
        ...field,
        typeExpr: field.typeExpr.clone(),
        type: field.type?.clone(),
      })),
      parentObjExpr: this.parentObjExpr?.clone(),
      typeParameters: this.typeParameters,
      implementations: this.implementations.map((impl) => impl.clone()),
      isStructural: this.isStructural,
    });
  }

  extends(ancestor: ObjectType): boolean {
    if (this === ancestor) {
      return true;
    }

    if (this.parentObjType) {
      return this.parentObjType.extends(ancestor);
    }

    return false;
  }

  // Register a version of this function with resolved generics
  registerGenericInstance(obj: ObjectType) {
    if (!this.genericInstances) {
      this.genericInstances = [];
    }

    this.genericInstances.push(obj);
  }

  getAncestorIds(start: number[] = []): number[] {
    start.push(this.idNum);
    if (this.parentObjType) {
      return this.parentObjType.getAncestorIds(start);
    }
    return start;
  }

  hasField(name: Id) {
    return this.fields.some((field) => field.name === getIdStr(name));
  }

  getField(name: Id) {
    return this.fields.find((field) => field.name === getIdStr(name));
  }

  getFieldIndex(name: Id) {
    return this.fields.findIndex((field) => field.name === getIdStr(name));
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
  readonly returnType: Type;

  constructor(
    opts: NamedEntityOpts & {
      parameters: Parameter[];
      returnType: Type;
    }
  ) {
    super(opts);
    this.parameters = opts.parameters;
    this.returnType = opts.returnType;
  }

  clone(parent?: Expr): FnType {
    return new FnType({
      ...super.getCloneOpts(parent),
      returnType: this.returnType,
      parameters: this.parameters,
    });
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

export type Primitive =
  | NumericType
  | ReferenceType
  | "void"
  | "voyd"
  | "bool"
  | "string";

export type NumericType = "i32" | "f32" | "i64" | "f64";
export type ReferenceType = "funcref" | "externref";

export const i32 = PrimitiveType.from("i32");
export const f32 = PrimitiveType.from("f32");
export const i64 = PrimitiveType.from("i64");
export const f64 = PrimitiveType.from("f64");
export const bool = PrimitiveType.from("bool");
export const dVoid = PrimitiveType.from("void");
export const dVoyd = PrimitiveType.from("voyd");
export const voydString = PrimitiveType.from("string");
export const voydBaseObject = new ObjectType({
  name: "Object",
  value: [],
});
