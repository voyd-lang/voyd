import type {
  EffectRowId,
  NodeId,
  SymbolId,
  TypeId,
  TypeParamId,
  TypeSchemeId,
} from "../ids.js";

export type Substitution = ReadonlyMap<TypeParamId, TypeId>;

export type TypeDescriptor =
  | PrimitiveType
  | TraitType
  | NominalObjectType
  | StructuralObjectType
  | FunctionType
  | UnionType
  | IntersectionType
  | FixedArrayType
  | TypeParamRef;

export interface PrimitiveType {
  kind: "primitive";
  name: string;
}

export interface TraitType {
  kind: "trait";
  owner: SymbolId;
  name?: string;
  typeArgs: readonly TypeId[];
}

export interface NominalObjectType {
  kind: "nominal-object";
  owner: SymbolId;
  name?: string;
  typeArgs: readonly TypeId[];
}

export interface StructuralObjectType {
  kind: "structural-object";
  fields: readonly { name: string; type: TypeId }[];
}

export interface FunctionParameter {
  type: TypeId;
  optional?: boolean;
}

export interface FunctionType {
  kind: "function";
  parameters: readonly FunctionParameter[];
  returnType: TypeId;
  effects: EffectRowId;
}

export interface UnionType {
  kind: "union";
  members: readonly TypeId[];
}

export interface IntersectionType {
  kind: "intersection";
  nominal?: TypeId;
  structural?: TypeId;
}

export interface FixedArrayType {
  kind: "fixed-array";
  element: TypeId;
}

export interface TypeParamRef {
  kind: "type-param-ref";
  param: TypeParamId;
}

export interface ConstraintSet {
  traits?: readonly TypeId[];
  structural?: readonly StructuralPredicate[];
}

export interface StructuralPredicate {
  field: string;
  type: TypeId;
}

export interface TypeScheme {
  id: TypeSchemeId;
  params: readonly TypeParamId[];
  body: TypeId;
  constraints?: ConstraintSet;
}

export interface UnificationContext {
  location: NodeId;
  reason: string;
}

export type UnificationResult =
  | { ok: true; substitution: Substitution }
  | { ok: false; conflict: UnificationConflict };

export interface UnificationConflict {
  left: TypeId;
  right: TypeId;
  message: string;
}

export interface TypeArena {
  get(id: TypeId): Readonly<TypeDescriptor>;
  internPrimitive(name: string): TypeId;
  internTrait(desc: Omit<TraitType, "kind">): TypeId;
  internNominalObject(desc: Omit<NominalObjectType, "kind">): TypeId;
  internStructuralObject(desc: Omit<StructuralObjectType, "kind">): TypeId;
  internFunction(desc: Omit<FunctionType, "kind">): TypeId;
  internUnion(members: readonly TypeId[]): TypeId;
  internIntersection(desc: Omit<IntersectionType, "kind">): TypeId;
  internFixedArray(element: TypeId): TypeId;
  internTypeParamRef(param: TypeParamId): TypeId;
  freshTypeParam(): TypeParamId;
  newScheme(
    params: readonly TypeParamId[],
    body: TypeId,
    constraints?: ConstraintSet
  ): TypeSchemeId;
  instantiate(
    scheme: TypeSchemeId,
    args: readonly TypeId[],
    ctx?: UnificationContext
  ): TypeId;
  unify(a: TypeId, b: TypeId, ctx: UnificationContext): UnificationResult;
  substitute(type: TypeId, subst: Substitution): TypeId;
  widen(type: TypeId, constraint: ConstraintSet): TypeId;
}

export const createTypeArena = (): TypeArena => {
  let nextTypeId: TypeId = 0;
  let nextSchemeId: TypeSchemeId = 0;
  let nextTypeParamId: TypeParamId = 0;

  const descriptors: TypeDescriptor[] = [];
  const descriptorCache = new Map<string, TypeId>();
  const schemes = new Map<TypeSchemeId, TypeScheme>();

  const keyFor = (desc: TypeDescriptor): string =>
    JSON.stringify(desc, (_, value) => {
      if (value instanceof Map) {
        return Array.from(value.entries()).sort();
      }

      return value;
    });

  const storeDescriptor = (desc: TypeDescriptor): TypeId => {
    const key = keyFor(desc);
    const cached = descriptorCache.get(key);
    if (typeof cached === "number") {
      return cached;
    }

    const id = nextTypeId++;
    descriptors[id] = desc;
    descriptorCache.set(key, id);
    return id;
  };

  const getDescriptor = (id: TypeId): TypeDescriptor => {
    const desc = descriptors[id];
    if (!desc) {
      throw new Error(`unknown TypeId ${id}`);
    }

    return desc;
  };

  const internPrimitive = (name: string): TypeId =>
    storeDescriptor({ kind: "primitive", name });

  const internTrait = (desc: Omit<TraitType, "kind">): TypeId =>
    storeDescriptor({
      kind: "trait",
      owner: desc.owner,
      name: desc.name,
      typeArgs: [...desc.typeArgs],
    });

  const internNominalObject = (
    desc: Omit<NominalObjectType, "kind">
  ): TypeId =>
    storeDescriptor({
      kind: "nominal-object",
      owner: desc.owner,
      name: desc.name,
      typeArgs: [...desc.typeArgs],
    });

  const internStructuralObject = (
    desc: Omit<StructuralObjectType, "kind">
  ): TypeId =>
    storeDescriptor({
      kind: "structural-object",
      fields: desc.fields
        .map((field) => ({ ...field }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    });

  const internFunction = (desc: Omit<FunctionType, "kind">): TypeId =>
    storeDescriptor({
      kind: "function",
      parameters: desc.parameters.map((param) => ({
        type: param.type,
        optional: param.optional ?? false,
      })),
      returnType: desc.returnType,
      effects: desc.effects,
    });

  const internUnion = (members: readonly TypeId[]): TypeId => {
    const canonical = [...new Set(members)].sort((a, b) => a - b);
    return storeDescriptor({ kind: "union", members: canonical });
  };

  const internIntersection = (
    desc: Omit<IntersectionType, "kind">
  ): TypeId =>
    storeDescriptor({
      kind: "intersection",
      nominal: desc.nominal,
      structural: desc.structural,
    });

  const internFixedArray = (element: TypeId): TypeId =>
    storeDescriptor({ kind: "fixed-array", element });

  const internTypeParamRef = (param: TypeParamId): TypeId =>
    storeDescriptor({ kind: "type-param-ref", param });

  const freshTypeParam = (): TypeParamId => nextTypeParamId++;

  const newScheme = (
    params: readonly TypeParamId[],
    body: TypeId,
    constraints?: ConstraintSet
  ): TypeSchemeId => {
    const id = nextSchemeId++;
    schemes.set(id, {
      id,
      params: [...params],
      body,
      constraints,
    });

    return id;
  };

  const instantiate = (
    schemeId: TypeSchemeId,
    args: readonly TypeId[],
    ctx?: UnificationContext
  ): TypeId => {
    const scheme = schemes.get(schemeId);

    if (!scheme) {
      throw new Error(`unknown TypeScheme ${schemeId}`);
    }

    if (scheme.params.length !== args.length) {
      const where = ctx ? ` at ${ctx.reason}` : "";
      throw new Error(
        `scheme parameter mismatch: expected ${scheme.params.length}, received ${args.length}${where}`
      );
    }

    const subst = new Map<TypeParamId, TypeId>();
    scheme.params.forEach((param, index) => subst.set(param, args[index]));
    return substitute(scheme.body, subst);
  };

  const unify = (
    a: TypeId,
    b: TypeId,
    ctx: UnificationContext
  ): UnificationResult => {
    if (a === b) {
      return { ok: true, substitution: new Map() };
    }

    return {
      ok: false,
      conflict: {
        left: a,
        right: b,
        message: `cannot unify types (${ctx.reason})`,
      },
    };
  };

  const substitute = (type: TypeId, subst: Substitution): TypeId => {
    if (subst.size === 0) {
      return type;
    }

    const desc = getDescriptor(type);
    switch (desc.kind) {
      case "primitive":
        return type;
      case "trait": {
        const mapped = desc.typeArgs.map((arg) => substitute(arg, subst));
        return mapped.every((arg, idx) => arg === desc.typeArgs[idx])
          ? type
          : internTrait({
              owner: desc.owner,
              name: desc.name,
              typeArgs: mapped,
            });
      }
      case "nominal-object": {
        const mapped = desc.typeArgs.map((arg) => substitute(arg, subst));
        return mapped.every((arg, idx) => arg === desc.typeArgs[idx])
          ? type
          : internNominalObject({
              owner: desc.owner,
              name: desc.name,
              typeArgs: mapped,
            });
      }
      case "structural-object": {
        let changed = false;
        const fields = desc.fields.map((field) => {
          const substituted = substitute(field.type, subst);
          changed ||= substituted !== field.type;
          return { name: field.name, type: substituted };
        });
        return changed
          ? internStructuralObject({ fields })
          : type;
      }
      case "function": {
        let changed = false;
        const parameters = desc.parameters.map((param) => {
          const substituted = substitute(param.type, subst);
          changed ||= substituted !== param.type;
          return { type: substituted, optional: param.optional };
        });
        const returnType = substitute(desc.returnType, subst);
        changed ||= returnType !== desc.returnType;
        return changed
          ? internFunction({
              parameters,
              returnType,
              effects: desc.effects,
            })
          : type;
      }
      case "union": {
        const members = desc.members.map((member) => substitute(member, subst));
        return members.every((member, idx) => member === desc.members[idx])
          ? type
          : internUnion(members);
      }
      case "intersection": {
        const nominal = desc.nominal
          ? substitute(desc.nominal, subst)
          : undefined;
        const structural = desc.structural
          ? substitute(desc.structural, subst)
          : undefined;
        if (nominal === desc.nominal && structural === desc.structural) {
          return type;
        }
        return internIntersection({ nominal, structural });
      }
      case "fixed-array": {
        const element = substitute(desc.element, subst);
        return element === desc.element
          ? type
          : internFixedArray(element);
      }
      case "type-param-ref": {
        const replacement = subst.get(desc.param);
        return replacement ?? type;
      }
      default:
        return type;
    }
  };

  const widen = (type: TypeId, _constraint: ConstraintSet): TypeId => type;

  const get = (id: TypeId): Readonly<TypeDescriptor> => getDescriptor(id);

  return {
    get,
    internPrimitive,
    internTrait,
    internNominalObject,
    internStructuralObject,
    internFunction,
    internUnion,
    internIntersection,
    internFixedArray,
    internTypeParamRef,
    freshTypeParam,
    newScheme,
    instantiate,
    unify,
    substitute,
    widen,
  };
};
