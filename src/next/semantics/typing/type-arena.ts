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
  label?: string;
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

export type Variance = "invariant" | "covariant" | "contravariant";

export interface UnificationContext {
  location: NodeId;
  reason: string;
  variance?: Variance;
  constraints?: ReadonlyMap<TypeParamId, ConstraintSet>;
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
        .map((field) => ({ ...field }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
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
      effects: desc.effects,
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
  ): readonly { name: string; type: TypeId }[] | undefined => {
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
    const constraintMap = ctx.constraints;
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
        const candidate = fields.find((field) => field.name === predicate.field);
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
          return conflict(
            left,
            right,
            `union arity mismatch (${ctx.reason})`
          );
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
          conflict(left, right, `intersection comparison failed (${ctx.reason})`)
        );
      }

      return conflict(left, right, `intersection comparison failed (${ctx.reason})`);
    };

    const unifyInternal = (
      left: TypeId,
      right: TypeId,
      currentVariance: Variance,
      subst: Substitution,
      localSeen: Set<string>
    ): UnificationResult => {
      const resolvedLeft = substitute(left, subst);
      const resolvedRight = substitute(right, subst);

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

      if (isUnknownPrimitive(resolvedLeft) || isUnknownPrimitive(resolvedRight)) {
        return success(subst);
      }

      const leftDesc = getDescriptor(resolvedLeft);
      const rightDesc = getDescriptor(resolvedRight);

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

      switch (leftDesc.kind) {
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
            leftDesc.owner === rightDesc.owner;
          if (!sameOwner || leftDesc.typeArgs.length !== rightDesc.typeArgs.length) {
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
        return changed ? internStructuralObject({ fields }) : type;
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
        return element === desc.element ? type : internFixedArray(element);
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
