import type {
  EffectRowId,
  NodeId,
  SymbolId,
  TypeId,
  TypeParamId,
  TypeSchemeId,
} from "../ids.js";
import type { HirVisibility } from "../hir/index.js";
import { symbolRefEquals, type SymbolRef } from "./symbol-ref.js";

export type Substitution = ReadonlyMap<TypeParamId, TypeId>;

export type TypeDescriptor =
  | PrimitiveType
  | RecursiveType
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

export interface RecursiveType {
  kind: "recursive";
  binder: TypeParamId;
  body: TypeId;
}

export interface TraitType {
  kind: "trait";
  owner: SymbolRef;
  name?: string;
  typeArgs: readonly TypeId[];
}

export interface NominalObjectType {
  kind: "nominal-object";
  owner: SymbolRef;
  name?: string;
  typeArgs: readonly TypeId[];
}

export interface StructuralField {
  name: string;
  type: TypeId;
  optional?: boolean;
  declaringParams?: readonly TypeParamId[];
  visibility?: HirVisibility;
  owner?: SymbolId;
  packageId?: string;
}

export interface StructuralObjectType {
  kind: "structural-object";
  fields: readonly StructuralField[];
}

export interface FunctionParameter {
  type: TypeId;
  label?: string;
  optional?: boolean;
}

export interface FunctionType {
  kind: "function";
  parameters: readonly FunctionParameter[];
  returnType: TypeId;
  effectRow: EffectRowId;
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

export type Variance = "invariant" | "covariant" | "contravariant";

export interface UnificationContext {
  location: NodeId;
  reason: string;
  variance?: Variance;
  constraints?: ReadonlyMap<TypeParamId, ConstraintSet>;
  // When true, the "unknown" primitive is treated as compatible with any type during unification.
  allowUnknown?: boolean;
  // Optional projector to normalize types (e.g. to structural components) before comparison.
  structuralResolver?: (type: TypeId) => TypeId | undefined;
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
  getScheme(id: TypeSchemeId): Readonly<TypeScheme>;
  internPrimitive(name: string): TypeId;
  createRecursiveType(
    build: (self: TypeId, placeholderParam: TypeParamId) => TypeDescriptor
  ): TypeId;
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
  const recursiveUnfoldCache = new Map<TypeId, TypeId>();

  const jsonStringKey = (value: string): string => JSON.stringify(value);

  const symbolRefKeyForCache = (ref: SymbolRef): string =>
    `${jsonStringKey(ref.moduleId)}:${ref.symbol}`;

  const keyFor = (desc: TypeDescriptor): string => {
    switch (desc.kind) {
      case "primitive":
        return `primitive:${jsonStringKey(desc.name)}`;
      case "type-param-ref":
        return `type-param-ref:${desc.param}`;
      case "recursive":
        return `recursive:${desc.binder}:${desc.body}`;
      case "fixed-array":
        return `fixed-array:${desc.element}`;
      case "union":
        return `union:[${desc.members.join(",")}]`;
      case "intersection":
        return `intersection:${desc.nominal ?? "u"}:${desc.structural ?? "u"}`;
      case "trait":
        return `trait:${symbolRefKeyForCache(desc.owner)}:${desc.name === undefined ? "u" : jsonStringKey(desc.name)}:[${desc.typeArgs.join(",")}]`;
      case "nominal-object":
        return `nominal-object:${symbolRefKeyForCache(desc.owner)}:${desc.name === undefined ? "u" : jsonStringKey(desc.name)}:[${desc.typeArgs.join(",")}]`;
      case "structural-object": {
        const fieldsKey = desc.fields
          .map((field) => {
            const declaringParamsKey =
              field.declaringParams && field.declaringParams.length > 0
                ? field.declaringParams.join(",")
                : "u";
            const optionalKey = field.optional ? "1" : "0";
            return `${jsonStringKey(field.name)}:${field.type}:${optionalKey}:${declaringParamsKey}`;
          })
          .join("|");
        return `structural-object:{${fieldsKey}}`;
      }
      case "function": {
        const paramsKey = desc.parameters
          .map((param) => {
            const labelKey = param.label === undefined ? "u" : jsonStringKey(param.label);
            const optionalKey = param.optional ? "1" : "0";
            return `${param.type}:${labelKey}:${optionalKey}`;
          })
          .join("|");
        return `function:(${paramsKey})->${desc.returnType}@${desc.effectRow}`;
      }
      default: {
        const exhaustive: never = desc;
        return exhaustive;
      }
    }
  };

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

  const internRecursive = (desc: Omit<RecursiveType, "kind">): TypeId =>
    storeDescriptor({ kind: "recursive", binder: desc.binder, body: desc.body });

  const createRecursiveType = (
    build: (self: TypeId, placeholderParam: TypeParamId) => TypeDescriptor
  ): TypeId => {
    const self = nextTypeId++;
    const placeholderParam = nextTypeParamId++;
    const placeholderDesc: TypeParamRef = {
    kind: "type-param-ref",
    param: placeholderParam,
  };
    descriptors[self] = placeholderDesc;
    descriptorCache.set(keyFor(placeholderDesc), self);

    const desc = build(self, placeholderParam);

    const bodyId = storeDescriptor(desc);

    const containsTypeId = (
      root: TypeId,
      needle: TypeId,
      seen: Set<TypeId> = new Set()
    ): boolean => {
      if (root === needle) {
        return true;
      }
      if (seen.has(root)) {
        return false;
      }
      seen.add(root);

      const rootDesc = getDescriptor(root);
      switch (rootDesc.kind) {
        case "primitive":
        case "type-param-ref":
          return false;
        case "recursive":
          return containsTypeId(rootDesc.body, needle, seen);
        case "fixed-array":
          return containsTypeId(rootDesc.element, needle, seen);
        case "union":
          return rootDesc.members.some((member) =>
            containsTypeId(member, needle, seen)
          );
        case "intersection":
          return (
            (typeof rootDesc.nominal === "number" &&
              containsTypeId(rootDesc.nominal, needle, seen)) ||
            (typeof rootDesc.structural === "number" &&
              containsTypeId(rootDesc.structural, needle, seen))
          );
        case "trait":
        case "nominal-object":
          return rootDesc.typeArgs.some((arg) =>
            containsTypeId(arg, needle, seen)
          );
        case "structural-object":
          return rootDesc.fields.some((field) =>
            containsTypeId(field.type, needle, seen)
          );
        case "function":
          return (
            rootDesc.parameters.some((param) =>
              containsTypeId(param.type, needle, seen)
            ) || containsTypeId(rootDesc.returnType, needle, seen)
          );
        default:
          return false;
      }
    };

    const needsRecursion = containsTypeId(bodyId, self);
    if (!needsRecursion) {
      // Preserve the previous behavior for non-recursive constructions:
      // return the canonical interned body type.
      descriptors[self] = desc;
      return bodyId;
    }

    const placeholderKey = keyFor(placeholderDesc);
    descriptorCache.delete(placeholderKey);
    const binderRef = internTypeParamRef(placeholderParam);

    const allocatePlaceholder = (): TypeId => {
      const placeholderType = nextTypeId++;
      const placeholderTypeParam = nextTypeParamId++;
      const placeholderTypeDesc: TypeParamRef = {
        kind: "type-param-ref",
        param: placeholderTypeParam,
      };
      descriptors[placeholderType] = placeholderTypeDesc;
      return placeholderType;
    };

    const resolved = new Map<TypeId, TypeId>();
    const inProgress = new Map<TypeId, TypeId | null>();

    const cloneReplacingSelf = (current: TypeId): TypeId => {
      if (current === self) {
        return binderRef;
      }

      const cached = resolved.get(current);
      if (typeof cached === "number") {
        return cached;
      }

      const active = inProgress.get(current);
      if (active !== undefined) {
        if (typeof active === "number") {
          return active;
        }
        const placeholder = allocatePlaceholder();
        inProgress.set(current, placeholder);
        return placeholder;
      }

      inProgress.set(current, null);

      const currentDesc = getDescriptor(current);
      const rebuilt = (() => {
        switch (currentDesc.kind) {
          case "primitive":
          case "type-param-ref":
            return current;
          case "recursive": {
            const body = cloneReplacingSelf(currentDesc.body);
            return body === currentDesc.body
              ? current
              : internRecursive({ binder: currentDesc.binder, body });
          }
          case "fixed-array": {
            const element = cloneReplacingSelf(currentDesc.element);
            return element === currentDesc.element
              ? current
              : internFixedArray(element);
          }
          case "union": {
            const members = currentDesc.members.map((member) =>
              cloneReplacingSelf(member)
            );
            const changed = members.some(
              (member, index) => member !== currentDesc.members[index]
            );
            return changed ? internUnion(members) : current;
          }
          case "intersection": {
            const nominal =
              typeof currentDesc.nominal === "number"
                ? cloneReplacingSelf(currentDesc.nominal)
                : undefined;
            const structural =
              typeof currentDesc.structural === "number"
                ? cloneReplacingSelf(currentDesc.structural)
                : undefined;
            const changed =
              nominal !== currentDesc.nominal || structural !== currentDesc.structural;
            return changed
              ? internIntersection({ nominal, structural })
              : current;
          }
          case "trait":
            return internTrait({
              owner: currentDesc.owner,
              name: currentDesc.name,
              typeArgs: currentDesc.typeArgs.map((arg) => cloneReplacingSelf(arg)),
            });
          case "nominal-object":
            return internNominalObject({
              owner: currentDesc.owner,
              name: currentDesc.name,
              typeArgs: currentDesc.typeArgs.map((arg) => cloneReplacingSelf(arg)),
            });
          case "structural-object":
            return internStructuralObject({
              fields: currentDesc.fields.map((field) => ({
                name: field.name,
                type: cloneReplacingSelf(field.type),
                optional: field.optional,
                declaringParams: field.declaringParams,
                visibility: field.visibility,
                owner: field.owner,
                packageId: field.packageId,
              })),
            });
          case "function":
            return internFunction({
              parameters: currentDesc.parameters.map((param) => ({
                type: cloneReplacingSelf(param.type),
                label: param.label,
                optional: param.optional,
              })),
              returnType: cloneReplacingSelf(currentDesc.returnType),
              effectRow: currentDesc.effectRow,
            });
          default:
            return current;
        }
      })();

      const placeholder = inProgress.get(current);
      if (typeof placeholder === "number" && rebuilt !== current) {
        descriptors[placeholder] = getDescriptor(rebuilt);
        resolved.set(current, placeholder);
        inProgress.delete(current);
        return placeholder;
      }

      resolved.set(current, rebuilt);
      inProgress.delete(current);
      return rebuilt;
    };

    const body = cloneReplacingSelf(bodyId);
    descriptors[self] = { kind: "recursive", binder: placeholderParam, body };
    // Cache the unfolded form (μ binder . body) => body[binder := self]
    recursiveUnfoldCache.delete(self);
    return self;
  };

  const getScheme = (id: TypeSchemeId): TypeScheme => {
    const scheme = schemes.get(id);
    if (!scheme) {
      throw new Error(`unknown TypeScheme ${id}`);
    }
    return scheme;
  };

  const internTrait = (desc: Omit<TraitType, "kind">): TypeId =>
    storeDescriptor({
      kind: "trait",
      owner: desc.owner,
      name: desc.name,
      typeArgs: [...desc.typeArgs],
    });

  const internNominalObject = (desc: Omit<NominalObjectType, "kind">): TypeId =>
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
        .map((field) => ({
          name: field.name,
          type: field.type,
          optional: field.optional ?? false,
          declaringParams:
            field.declaringParams && field.declaringParams.length > 0
              ? Array.from(new Set(field.declaringParams)).sort((a, b) => a - b)
              : undefined,
        }))
        .sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { numeric: true })
        ),
    });

  const internFunction = (desc: Omit<FunctionType, "kind">): TypeId =>
    storeDescriptor({
      kind: "function",
      parameters: desc.parameters.map((param) => ({
        type: param.type,
        label: param.label,
        optional: param.optional ?? false,
      })),
      returnType: desc.returnType,
      effectRow: desc.effectRow,
    });

  const internUnion = (members: readonly TypeId[]): TypeId => {
    const flattened: TypeId[] = [];
    members.forEach((member) => {
      const desc = getDescriptor(member);
      if (desc.kind === "union") {
        flattened.push(...desc.members);
        return;
      }
      flattened.push(member);
    });

    const canonical = [...new Set(flattened)].sort((a, b) => a - b);
    return storeDescriptor({ kind: "union", members: canonical });
  };

  const internIntersection = (desc: Omit<IntersectionType, "kind">): TypeId =>
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

  const structuralFieldsOf = (
    type: TypeId
  ): readonly StructuralField[] | undefined => {
    const desc = getDescriptor(type);
    if (desc.kind === "structural-object") {
      return desc.fields;
    }
    if (desc.kind === "intersection" && typeof desc.structural === "number") {
      return structuralFieldsOf(desc.structural);
    }
    return undefined;
  };

  const isUnknownPrimitive = (type: TypeId): boolean => {
    const desc = getDescriptor(type);
    return desc.kind === "primitive" && desc.name === "unknown";
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
    const variance: Variance = ctx.variance ?? "invariant";
    // unknown can be treated as a wildcard when explicitly allowed.
    const allowUnknown = ctx.allowUnknown ?? true;
    const constraintMap = ctx.constraints;
    // Used to project types (often nominal expectations) into a structural shape before inspection.
    const structuralResolver = ctx.structuralResolver;
    const seen = new Set<string>();

    const success = (substitution: Substitution): UnificationResult => ({
      ok: true,
      substitution,
    });

    const conflict = (
      left: TypeId,
      right: TypeId,
      message?: string
    ): UnificationResult => ({
      ok: false,
      conflict: {
        left,
        right,
        message: message ?? `cannot unify types (${ctx.reason})`,
      },
    });

    const satisfiesStructuralPredicates = (
      type: TypeId,
      predicates: readonly StructuralPredicate[],
      currentVariance: Variance,
      subst: Substitution,
      localSeen: Set<string>
    ): UnificationResult => {
      const desc = getDescriptor(type);
      if (desc.kind === "union") {
        let working = subst;
        for (const member of desc.members) {
          const result = satisfiesStructuralPredicates(
            member,
            predicates,
            currentVariance,
            working,
            localSeen
          );
          if (!result.ok) {
            return result;
          }
          working = result.substitution;
        }
        return success(working);
      }

      const fields = structuralFieldsOf(type);
      if (!fields) {
        return conflict(
          type,
          type,
          `type does not satisfy structural constraints (${ctx.reason})`
        );
      }

      let working = subst;
      for (const predicate of predicates) {
        const candidate = fields.find(
          (field) => field.name === predicate.field
        );
        if (!candidate) {
          return conflict(
            type,
            type,
            `missing field ${predicate.field} (${ctx.reason})`
          );
        }
        const varianceForField =
          currentVariance === "invariant" ? "invariant" : "covariant";
        const comparison = unifyInternal(
          candidate.type,
          predicate.type,
          varianceForField,
          working,
          localSeen
        );
        if (!comparison.ok) {
          return comparison;
        }
        working = comparison.substitution;
      }
      return success(working);
    };

    const satisfiesConstraint = (
      type: TypeId,
      constraint: ConstraintSet,
      currentVariance: Variance,
      subst: Substitution,
      localSeen: Set<string>
    ): UnificationResult => {
      let working = subst;
      if (constraint.traits) {
        for (const trait of constraint.traits) {
          const result = unifyInternal(
            type,
            trait,
            "covariant",
            working,
            localSeen
          );
          if (!result.ok) {
            return result;
          }
          working = result.substitution;
        }
      }
      if (constraint.structural) {
        const result = satisfiesStructuralPredicates(
          type,
          constraint.structural,
          currentVariance,
          working,
          localSeen
        );
        if (!result.ok) {
          return result;
        }
        working = result.substitution;
      }
      return success(working);
    };

    const bindParam = (
      param: TypeParamId,
      target: TypeId,
      currentVariance: Variance,
      subst: Substitution,
      localSeen: Set<string>
    ): UnificationResult => {
      const bound = subst.get(param);
      if (typeof bound === "number") {
        return unifyInternal(bound, target, currentVariance, subst, localSeen);
      }
      const constraint = constraintMap?.get(param);
      if (constraint) {
        const constrained = satisfiesConstraint(
          target,
          constraint,
          currentVariance,
          subst,
          localSeen
        );
        if (!constrained.ok) {
          return constrained;
        }
        subst = constrained.substitution;
      }
      const next = new Map(subst);
      next.set(param, target);
      return success(next);
    };

    const unifyStructural = (
      left: TypeId,
      right: TypeId,
      currentVariance: Variance,
      subst: Substitution,
      localSeen: Set<string>
    ): UnificationResult => {
      const leftFields = structuralFieldsOf(left);
      const rightFields = structuralFieldsOf(right);
      if (!leftFields || !rightFields) {
        return conflict(
          left,
          right,
          `structural comparison failed (${ctx.reason})`
        );
      }

      if (
        currentVariance === "invariant" &&
        leftFields.length !== rightFields.length
      ) {
        return conflict(
          left,
          right,
          `structural arity mismatch (${ctx.reason})`
        );
      }

      let working = subst;
      for (const expectedField of rightFields) {
        const candidate = leftFields.find(
          (field) => field.name === expectedField.name
        );
        if (!candidate) {
          return conflict(
            left,
            right,
            `missing field ${expectedField.name} (${ctx.reason})`
          );
        }
        const comparison = unifyInternal(
          candidate.type,
          expectedField.type,
          currentVariance === "invariant" ? "invariant" : "covariant",
          working,
          localSeen
        );
        if (!comparison.ok) {
          return comparison;
        }
        working = comparison.substitution;
      }

      if (currentVariance === "invariant") {
        for (const candidate of leftFields) {
          if (!rightFields.some((field) => field.name === candidate.name)) {
            return conflict(
              left,
              right,
              `unexpected field ${candidate.name} (${ctx.reason})`
            );
          }
        }
      }

      return success(working);
    };

    const unifyUnion = (
      left: TypeId,
      right: TypeId,
      currentVariance: Variance,
      subst: Substitution,
      localSeen: Set<string>
    ): UnificationResult => {
      const leftDesc = getDescriptor(left);
      const rightDesc = getDescriptor(right);
      if (currentVariance === "covariant") {
        if (leftDesc.kind === "union") {
          let working = subst;
          for (const member of leftDesc.members) {
            const result = unifyInternal(
              member,
              right,
              currentVariance,
              working,
              localSeen
            );
            if (!result.ok) {
              return result;
            }
            working = result.substitution;
          }
          return success(working);
        }
        if (rightDesc.kind === "union") {
          for (const member of rightDesc.members) {
            const result = unifyInternal(
              left,
              member,
              currentVariance,
              subst,
              localSeen
            );
            if (result.ok) {
              return result;
            }
          }
          return conflict(
            left,
            right,
            `no union member satisfied (${ctx.reason})`
          );
        }
      }

      if (leftDesc.kind === "union" && rightDesc.kind === "union") {
        if (leftDesc.members.length !== rightDesc.members.length) {
          return conflict(left, right, `union arity mismatch (${ctx.reason})`);
        }
        let working = subst;
        const remaining = new Set(rightDesc.members);
        for (const member of leftDesc.members) {
          let matched = false;
          for (const candidate of Array.from(remaining)) {
            const result = unifyInternal(
              member,
              candidate,
              currentVariance,
              working,
              localSeen
            );
            if (result.ok) {
              working = result.substitution;
              remaining.delete(candidate);
              matched = true;
              break;
            }
          }
          if (!matched) {
            return conflict(
              left,
              right,
              `union members incompatible (${ctx.reason})`
            );
          }
        }
        return success(working);
      }

      return conflict(left, right, `union comparison failed (${ctx.reason})`);
    };

    const unifyIntersection = (
      left: TypeId,
      right: TypeId,
      currentVariance: Variance,
      subst: Substitution,
      localSeen: Set<string>
    ): UnificationResult => {
      const leftDesc = getDescriptor(left);
      const rightDesc = getDescriptor(right);

      if (rightDesc.kind === "intersection") {
        let working = subst;
        if (typeof rightDesc.nominal === "number") {
          const nominalResult = unifyInternal(
            left,
            rightDesc.nominal,
            currentVariance,
            working,
            localSeen
          );
          if (!nominalResult.ok) {
            return nominalResult;
          }
          working = nominalResult.substitution;
        }
        if (typeof rightDesc.structural === "number") {
          const structuralResult = unifyInternal(
            left,
            rightDesc.structural,
            currentVariance,
            working,
            localSeen
          );
          if (!structuralResult.ok) {
            return structuralResult;
          }
          working = structuralResult.substitution;
        }
        return success(working);
      }

      if (leftDesc.kind === "intersection") {
        const attempts: UnificationResult[] = [];
        if (typeof leftDesc.nominal === "number") {
          attempts.push(
            unifyInternal(
              leftDesc.nominal,
              right,
              currentVariance,
              subst,
              localSeen
            )
          );
        }
        if (typeof leftDesc.structural === "number") {
          attempts.push(
            unifyInternal(
              leftDesc.structural,
              right,
              currentVariance,
              subst,
              localSeen
            )
          );
        }
        const successAttempt = attempts.find((candidate) => candidate.ok);
        return (
          successAttempt ??
          conflict(
            left,
            right,
            `intersection comparison failed (${ctx.reason})`
          )
        );
      }

      return conflict(
        left,
        right,
        `intersection comparison failed (${ctx.reason})`
      );
    };

    const normalizeStructural = (type: TypeId): TypeId => {
      if (!structuralResolver) {
        return type;
      }
      const resolved = structuralResolver(type);
      // Returning undefined means no projection; the original type is preserved.
      return typeof resolved === "number" ? resolved : type;
    };

    const unfoldRecursiveOnce = (type: TypeId): TypeId => {
      const desc = getDescriptor(type);
      if (desc.kind !== "recursive") {
        return type;
      }
      const cached = recursiveUnfoldCache.get(type);
      if (typeof cached === "number") {
        return cached;
      }
      const unfolded = substitute(desc.body, new Map([[desc.binder, type]]));
      recursiveUnfoldCache.set(type, unfolded);
      return unfolded;
    };

    const unifyInternal = (
      left: TypeId,
      right: TypeId,
      currentVariance: Variance,
      subst: Substitution,
      localSeen: Set<string>
    ): UnificationResult => {
      const substitutedLeft = substitute(left, subst);
      const substitutedRight = substitute(right, subst);
      const resolvedLeft = normalizeStructural(substitutedLeft);
      const resolvedRight = normalizeStructural(substitutedRight);

      const unfoldedLeft = unfoldRecursiveOnce(resolvedLeft);
      const unfoldedRight = unfoldRecursiveOnce(resolvedRight);
      if (unfoldedLeft !== resolvedLeft || unfoldedRight !== resolvedRight) {
        return unifyInternal(
          unfoldedLeft,
          unfoldedRight,
          currentVariance,
          subst,
          localSeen
        );
      }

      if (resolvedLeft === resolvedRight) {
        return success(subst);
      }

      const cacheKey = `${currentVariance}:${resolvedLeft}->${resolvedRight}`;
      if (localSeen.has(cacheKey)) {
        return success(subst);
      }
      localSeen.add(cacheKey);

      if (currentVariance === "contravariant") {
        return unifyInternal(
          resolvedRight,
          resolvedLeft,
          "covariant",
          subst,
          localSeen
        );
      }

      const leftUnknown = isUnknownPrimitive(resolvedLeft);
      const rightUnknown = isUnknownPrimitive(resolvedRight);
      if (leftUnknown || rightUnknown) {
        if (allowUnknown) {
          return success(subst);
        }
        return conflict(
          resolvedLeft,
          resolvedRight,
          `unknown types are not allowed (${ctx.reason})`
        );
      }

      const leftDesc = getDescriptor(resolvedLeft);
      const rightDesc = getDescriptor(resolvedRight);

      if (leftDesc.kind === "type-param-ref") {
        return bindParam(
          leftDesc.param,
          resolvedRight,
          currentVariance,
          subst,
          localSeen
        );
      }
      if (rightDesc.kind === "type-param-ref") {
        return bindParam(
          rightDesc.param,
          resolvedLeft,
          currentVariance,
          subst,
          localSeen
        );
      }

      if (leftDesc.kind === "union" || rightDesc.kind === "union") {
        return unifyUnion(
          resolvedLeft,
          resolvedRight,
          currentVariance,
          subst,
          localSeen
        );
      }

      if (
        leftDesc.kind === "intersection" ||
        rightDesc.kind === "intersection"
      ) {
        return unifyIntersection(
          resolvedLeft,
          resolvedRight,
          currentVariance,
          subst,
          localSeen
        );
      }

      switch (leftDesc.kind) {
        case "recursive":
          return conflict(resolvedLeft, resolvedRight);
        case "primitive": {
          if (
            rightDesc.kind === "primitive" &&
            leftDesc.name === rightDesc.name
          ) {
            return success(subst);
          }
          return conflict(resolvedLeft, resolvedRight);
        }
        case "trait":
        case "nominal-object": {
          if (leftDesc.kind !== rightDesc.kind) {
            return conflict(resolvedLeft, resolvedRight);
          }
          const sameOwner =
            "owner" in leftDesc &&
            "owner" in rightDesc &&
            symbolRefEquals(leftDesc.owner, rightDesc.owner);
          if (
            !sameOwner ||
            leftDesc.typeArgs.length !== rightDesc.typeArgs.length
          ) {
            return conflict(resolvedLeft, resolvedRight);
          }
          let working = subst;
          const argVariance =
            currentVariance === "invariant" ? "invariant" : "covariant";
          for (let index = 0; index < leftDesc.typeArgs.length; index += 1) {
            const unified = unifyInternal(
              leftDesc.typeArgs[index]!,
              rightDesc.typeArgs[index]!,
              argVariance,
              working,
              localSeen
            );
            if (!unified.ok) {
              return unified;
            }
            working = unified.substitution;
          }
          return success(working);
        }
        case "structural-object":
          if (rightDesc.kind !== "structural-object") {
            return conflict(resolvedLeft, resolvedRight);
          }
          return unifyStructural(
            resolvedLeft,
            resolvedRight,
            currentVariance,
            subst,
            localSeen
          );
        case "function": {
          if (rightDesc.kind !== "function") {
            return conflict(resolvedLeft, resolvedRight);
          }
          if (leftDesc.parameters.length !== rightDesc.parameters.length) {
            return conflict(
              resolvedLeft,
              resolvedRight,
              `function arity mismatch (${ctx.reason})`
            );
          }
          let working = subst;
          const argVariance =
            currentVariance === "invariant" ? "invariant" : "covariant";
          for (let index = 0; index < leftDesc.parameters.length; index += 1) {
            const leftParam = leftDesc.parameters[index]!;
            const rightParam = rightDesc.parameters[index]!;
            if (leftParam.optional !== rightParam.optional) {
              return conflict(
                resolvedLeft,
                resolvedRight,
                `parameter optionality mismatch (${ctx.reason})`
              );
            }
            const paramResult = unifyInternal(
              rightParam.type,
              leftParam.type,
              argVariance,
              working,
              localSeen
            );
            if (!paramResult.ok) {
              return paramResult;
            }
            working = paramResult.substitution;
          }
          const returnResult = unifyInternal(
            leftDesc.returnType,
            rightDesc.returnType,
            currentVariance,
            working,
            localSeen
          );
          if (!returnResult.ok) {
            return returnResult;
          }
          return success(returnResult.substitution);
        }
        case "fixed-array": {
          if (rightDesc.kind !== "fixed-array") {
            return conflict(resolvedLeft, resolvedRight);
          }
          return unifyInternal(
            leftDesc.element,
            rightDesc.element,
            currentVariance,
            subst,
            localSeen
          );
        }
        default:
          return conflict(resolvedLeft, resolvedRight);
      }
    };

    return unifyInternal(a, b, variance, new Map(), seen);
  };

	  const substitute = (type: TypeId, subst: Substitution): TypeId => {
	    if (subst.size === 0) {
	      return type;
	    }
	
	    const mappedParams = new Set(subst.keys());
	    const needsCache = new Map<TypeId, boolean>();
	
	    const needsSubstitution = (root: TypeId): boolean => {
	      const cachedRoot = needsCache.get(root);
	      if (typeof cachedRoot === "boolean") {
	        return cachedRoot;
	      }
	
	      const inProgress = new Set<TypeId>();
	      const stack: Array<{ id: TypeId; stage: 0 | 1 }> = [
	        { id: root, stage: 0 },
	      ];
	
	      while (stack.length > 0) {
	        const frame = stack.pop();
	        if (!frame) break;
	
	        const cached = needsCache.get(frame.id);
	        if (typeof cached === "boolean") {
	          continue;
	        }
	
	        if (frame.stage === 0) {
	          if (inProgress.has(frame.id)) {
	            continue;
	          }
	          inProgress.add(frame.id);
	          stack.push({ id: frame.id, stage: 1 });
	
	          const desc = getDescriptor(frame.id);
	          switch (desc.kind) {
	            case "recursive":
	              stack.push({ id: desc.body, stage: 0 });
	              break;
	            case "fixed-array":
	              stack.push({ id: desc.element, stage: 0 });
	              break;
	            case "union":
	              desc.members.forEach((member) => stack.push({ id: member, stage: 0 }));
	              break;
	            case "intersection":
	              if (typeof desc.nominal === "number") {
	                stack.push({ id: desc.nominal, stage: 0 });
	              }
	              if (typeof desc.structural === "number") {
	                stack.push({ id: desc.structural, stage: 0 });
	              }
	              break;
	            case "trait":
	            case "nominal-object":
	              desc.typeArgs.forEach((arg) => stack.push({ id: arg, stage: 0 }));
	              break;
	            case "structural-object":
	              desc.fields.forEach((field) =>
	                stack.push({ id: field.type, stage: 0 })
	              );
	              break;
	            case "function":
	              desc.parameters.forEach((param) =>
	                stack.push({ id: param.type, stage: 0 })
	              );
	              stack.push({ id: desc.returnType, stage: 0 });
	              break;
	            default:
	              break;
	          }
	          continue;
	        }
	
	        const desc = getDescriptor(frame.id);
	        const result = (() => {
	          switch (desc.kind) {
	            case "type-param-ref":
	              return mappedParams.has(desc.param);
	            case "recursive":
	              return needsCache.get(desc.body) ?? false;
	            case "fixed-array":
	              return needsCache.get(desc.element) ?? false;
	            case "union":
	              return desc.members.some((member) => needsCache.get(member) ?? false);
	            case "intersection":
	              return (
	                (typeof desc.nominal === "number" &&
	                  (needsCache.get(desc.nominal) ?? false)) ||
	                (typeof desc.structural === "number" &&
	                  (needsCache.get(desc.structural) ?? false))
	              );
	            case "trait":
	            case "nominal-object":
	              return desc.typeArgs.some((arg) => needsCache.get(arg) ?? false);
	            case "structural-object":
	              return desc.fields.some(
	                (field) => needsCache.get(field.type) ?? false
	              );
	            case "function":
	              return (
	                desc.parameters.some(
	                  (param) => needsCache.get(param.type) ?? false
	                ) || (needsCache.get(desc.returnType) ?? false)
	              );
	            default:
	              return false;
	          }
	        })();
	
	        inProgress.delete(frame.id);
	        needsCache.set(frame.id, result);
	      }
	
	      return needsCache.get(root) ?? false;
	    };

    if (!needsSubstitution(type)) {
      return type;
    }

	    const allocatePlaceholder = (): TypeId => {
	      const self = nextTypeId++;
	      const placeholderParam = nextTypeParamId++;
	      const placeholderDesc: TypeParamRef = {
	        kind: "type-param-ref",
	        param: placeholderParam,
	      };
	      descriptors[self] = placeholderDesc;
	      descriptorCache.set(keyFor(placeholderDesc), self);
	      return self;
	    };
	
	    const resolved = new Map<TypeId, TypeId>();
	    const inProgress = new Map<TypeId, TypeId | null>();
	
	    const substituteInternal = (root: TypeId): TypeId => {
	      type Frame = { id: TypeId; stage: 0 | 1 };
	
	      const getSubstituted = (id: TypeId): TypeId => {
	        const cached = resolved.get(id);
	        if (typeof cached === "number") {
	          return cached;
	        }
	
	        const active = inProgress.get(id);
	        if (typeof active === "number") {
	          return active;
	        }
	        if (active === null) {
	          const placeholder = allocatePlaceholder();
	          inProgress.set(id, placeholder);
	          return placeholder;
	        }
	
	        return id;
	      };
	
	      const stack: Frame[] = [{ id: root, stage: 0 }];
	      while (stack.length > 0) {
	        const frame = stack.pop();
	        if (!frame) break;
	
	        if (frame.stage === 0) {
	          if (!needsSubstitution(frame.id)) {
	            resolved.set(frame.id, frame.id);
	            continue;
	          }
	
	          const cached = resolved.get(frame.id);
	          if (typeof cached === "number") {
	            continue;
	          }
	
	          if (inProgress.has(frame.id)) {
	            continue;
	          }
	
	          inProgress.set(frame.id, null);
	          stack.push({ id: frame.id, stage: 1 });
	
	          const desc = getDescriptor(frame.id);
	          switch (desc.kind) {
	            case "recursive":
	              if (!subst.has(desc.binder)) {
	                stack.push({ id: desc.body, stage: 0 });
	              }
	              break;
	            case "fixed-array":
	              stack.push({ id: desc.element, stage: 0 });
	              break;
	            case "union":
	              desc.members.forEach((member) => stack.push({ id: member, stage: 0 }));
	              break;
	            case "intersection":
	              if (typeof desc.nominal === "number") {
	                stack.push({ id: desc.nominal, stage: 0 });
	              }
	              if (typeof desc.structural === "number") {
	                stack.push({ id: desc.structural, stage: 0 });
	              }
	              break;
	            case "trait":
	            case "nominal-object":
	              desc.typeArgs.forEach((arg) => stack.push({ id: arg, stage: 0 }));
	              break;
	            case "structural-object":
	              desc.fields.forEach((field) =>
	                stack.push({ id: field.type, stage: 0 })
	              );
	              break;
	            case "function":
	              desc.parameters.forEach((param) =>
	                stack.push({ id: param.type, stage: 0 })
	              );
	              stack.push({ id: desc.returnType, stage: 0 });
	              break;
	            default:
	              break;
	          }
	          continue;
	        }
	
	        const current = frame.id;
	        const desc = getDescriptor(current);
	        const rebuilt = (() => {
	          switch (desc.kind) {
	            case "primitive":
	              return { type: current, changed: false };
	            case "recursive": {
	              const filteredSubst =
	                subst.has(desc.binder) && subst.size > 1
	                  ? new Map(
	                      Array.from(subst.entries()).filter(
	                        ([param]) => param !== desc.binder
	                      )
	                    )
	                  : subst.has(desc.binder)
	                    ? new Map<TypeParamId, TypeId>()
	                    : subst;
	              const body =
	                filteredSubst === subst
	                  ? getSubstituted(desc.body)
	                  : substitute(desc.body, filteredSubst);
	              const changed = body !== desc.body;
	              return changed
	                ? {
	                    type: internRecursive({ binder: desc.binder, body }),
	                    changed: true,
	                  }
	                : { type: current, changed: false };
	            }
	            case "type-param-ref": {
	              const replacement = subst.get(desc.param);
	              return replacement === undefined
	                ? { type: current, changed: false }
	                : { type: replacement, changed: replacement !== current };
	            }
	            case "fixed-array": {
	              const element = getSubstituted(desc.element);
	              return element === desc.element
	                ? { type: current, changed: false }
	                : { type: internFixedArray(element), changed: true };
	            }
	            case "union": {
	              const members = desc.members.map((member) => getSubstituted(member));
	              const changed = members.some(
	                (member, idx) => member !== desc.members[idx]
	              );
	              return changed
	                ? { type: internUnion(members), changed: true }
	                : { type: current, changed: false };
	            }
	            case "intersection": {
	              const nominal =
	                typeof desc.nominal === "number"
	                  ? getSubstituted(desc.nominal)
	                  : undefined;
	              const structural =
	                typeof desc.structural === "number"
	                  ? getSubstituted(desc.structural)
	                  : undefined;
	              const changed =
	                nominal !== desc.nominal || structural !== desc.structural;
	              return changed
	                ? { type: internIntersection({ nominal, structural }), changed: true }
	                : { type: current, changed: false };
	            }
	            case "trait": {
	              const typeArgs = desc.typeArgs.map((arg) => getSubstituted(arg));
	              const changed = typeArgs.some(
	                (arg, idx) => arg !== desc.typeArgs[idx]
	              );
	              return changed
	                ? {
	                    type: internTrait({
	                      owner: desc.owner,
	                      name: desc.name,
	                      typeArgs,
	                    }),
	                    changed: true,
	                  }
	                : { type: current, changed: false };
	            }
	            case "nominal-object": {
	              const typeArgs = desc.typeArgs.map((arg) => getSubstituted(arg));
	              const changed = typeArgs.some(
	                (arg, idx) => arg !== desc.typeArgs[idx]
	              );
	              return changed
	                ? {
	                    type: internNominalObject({
	                      owner: desc.owner,
	                      name: desc.name,
	                      typeArgs,
	                    }),
	                    changed: true,
	                  }
	                : { type: current, changed: false };
	            }
	            case "structural-object": {
	              let changed = false;
	              const fields = desc.fields.map((field) => {
	                const substituted = getSubstituted(field.type);
	                changed ||= substituted !== field.type;
	                return substituted === field.type
	                  ? field
	                  : {
	                      name: field.name,
	                      type: substituted,
	                      optional: field.optional,
	                      declaringParams: field.declaringParams,
	                      visibility: field.visibility,
	                      owner: field.owner,
	                      packageId: field.packageId,
	                    };
	              });
	              return changed
	                ? { type: internStructuralObject({ fields }), changed: true }
	                : { type: current, changed: false };
	            }
	            case "function": {
	              let changed = false;
	              const parameters = desc.parameters.map((param) => {
	                const substituted = getSubstituted(param.type);
	                changed ||= substituted !== param.type;
	                return substituted === param.type
	                  ? param
	                  : {
	                      type: substituted,
	                      label: param.label,
	                      optional: param.optional,
	                    };
	              });
	              const returnType = getSubstituted(desc.returnType);
	              changed ||= returnType !== desc.returnType;
	              return changed
	                ? {
	                    type: internFunction({
	                      parameters,
	                      returnType,
	                      effectRow: desc.effectRow,
	                    }),
	                    changed: true,
	                  }
	                : { type: current, changed: false };
	            }
	            default:
	              return { type: current, changed: false };
	          }
	        })();
	
	        const placeholder = inProgress.get(current);
	        if (typeof placeholder === "number") {
	          const replacementDesc =
	            rebuilt.type === current ? desc : getDescriptor(rebuilt.type);
	          descriptors[placeholder] = replacementDesc;
	          descriptorCache.set(keyFor(replacementDesc), placeholder);
	          resolved.set(current, placeholder);
	          inProgress.delete(current);
	          continue;
	        }
	
	        resolved.set(current, rebuilt.type);
	        inProgress.delete(current);
	      }
	
	      return resolved.get(root) ?? root;
	    };
	
	    return substituteInternal(type);
	  };

  const widen = (type: TypeId, _constraint: ConstraintSet): TypeId => type;

  const get = (id: TypeId): Readonly<TypeDescriptor> => getDescriptor(id);

  return {
    get,
    getScheme,
    internPrimitive,
    createRecursiveType,
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
