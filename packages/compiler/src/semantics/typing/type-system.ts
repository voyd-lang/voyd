import type {
  HirObjectTypeExpr,
  HirTypeExpr,
  HirNamedTypeExpr,
  HirTupleTypeExpr,
  HirUnionTypeExpr,
  HirIntersectionTypeExpr,
  HirFunctionTypeExpr,
  HirVisibility,
} from "../hir/index.js";
import { resolveImportedTypeExpr } from "./imports.js";
import type { SourceSpan, SymbolId, TypeId, TypeParamId } from "../ids.js";
import {
  type UnificationContext,
  type UnificationResult,
  typeDescriptorToUserString,
  type StructuralField,
  type TypeDescriptor,
} from "./type-arena.js";
import { freshOpenEffectRow, resolveEffectAnnotation } from "./effects.js";
import {
  BASE_OBJECT_NAME,
  type TypingContext,
  type ObjectTemplate,
  type ObjectTypeInfo,
  type TypingState,
  type TraitImplInstance,
} from "./types.js";
import {
  normalizeTypeArgs,
  shouldCacheInstantiation,
} from "../../types/instantiation.js";
import { filterAccessibleFields } from "./visibility.js";
import {
  getOptionalInfo,
  optionalResolverContextForTypingContext,
} from "./optionals.js";
import {
  canonicalSymbolRefForTypingContext,
  localSymbolForSymbolRef,
} from "./symbol-ref-utils.js";
import { symbolRefEquals } from "./symbol-ref.js";
import { emitDiagnostic } from "../../diagnostics/index.js";
import { hydrateImportedTraitMetadataForNominal } from "./import-trait-impl-hydration.js";

type UnifyWithBudgetOptions = Omit<UnificationContext, "stepBudget">;

export const unifyWithBudget = ({
  actual,
  expected,
  options,
  ctx,
  span,
}: {
  actual: TypeId;
  expected: TypeId;
  options: UnifyWithBudgetOptions;
  ctx: TypingContext;
  span?: SourceSpan;
}): UnificationResult => {
  const compatibility = ctx.arena.unify(actual, expected, {
    ...options,
    stepBudget: {
      maxSteps: ctx.typeCheckBudget.maxUnifySteps,
      stepsUsed: ctx.typeCheckBudget.unifyStepsUsed,
    },
  });
  const exhaustedBudget =
    ctx.typeCheckBudget.unifyStepsUsed.value > ctx.typeCheckBudget.maxUnifySteps;
  if (!compatibility.ok && exhaustedBudget) {
    emitDiagnostic({
      ctx,
      code: "TY0040",
      params: {
        kind: "typecheck-unify-budget-exceeded",
        maxSteps: ctx.typeCheckBudget.maxUnifySteps,
        observedSteps: ctx.typeCheckBudget.unifyStepsUsed.value,
      },
      span: span ?? ctx.hir.module.span,
    });
  }
  return compatibility;
};

const isFixedArrayReference = (
  name: string,
  symbol: SymbolId | undefined,
  ctx: TypingContext,
): boolean => {
  if (name === "FixedArray") {
    return true;
  }
  if (typeof symbol !== "number") {
    return false;
  }
  const metadata = (ctx.symbolTable.getSymbol(symbol).metadata ?? {}) as {
    intrinsicType?: string;
  };
  return metadata.intrinsicType === "fixed-array";
};

const resolveFixedArrayType = ({
  typeArgs,
  ctx,
  state,
}: {
  typeArgs: readonly TypeId[];
  ctx: TypingContext;
  state: TypingState;
}): TypeId => {
  const normalized = normalizeDeclarationTypeArgs({
    typeArgs,
    paramCount: 1,
    ctx,
    state,
    context: "FixedArray",
  });

  return ctx.arena.internFixedArray(normalized.applied[0]!);
};

const paramsReferencedInType = (
  type: TypeId,
  allowed: ReadonlySet<TypeParamId>,
  ctx: TypingContext,
  seen: Set<TypeId> = new Set(),
): Set<TypeParamId> => {
  if (seen.has(type)) {
    return new Set();
  }
  seen.add(type);

  const desc = ctx.arena.get(type);
  switch (desc.kind) {
    case "type-param-ref":
      return allowed.has(desc.param) ? new Set([desc.param]) : new Set();
    case "trait":
    case "nominal-object": {
      return desc.typeArgs.reduce((acc, arg) => {
        paramsReferencedInType(arg, allowed, ctx, seen).forEach((entry) =>
          acc.add(entry),
        );
        return acc;
      }, new Set<TypeParamId>());
    }
    case "structural-object":
      return desc.fields.reduce((acc, field) => {
        paramsReferencedInType(field.type, allowed, ctx, seen).forEach(
          (entry) => acc.add(entry),
        );
        return acc;
      }, new Set<TypeParamId>());
    case "function": {
      const acc = new Set<TypeParamId>();
      desc.parameters.forEach((param) =>
        paramsReferencedInType(param.type, allowed, ctx, seen).forEach(
          (entry) => acc.add(entry),
        ),
      );
      paramsReferencedInType(desc.returnType, allowed, ctx, seen).forEach(
        (entry) => acc.add(entry),
      );
      return acc;
    }
    case "union":
      return desc.members.reduce((acc, member) => {
        paramsReferencedInType(member, allowed, ctx, seen).forEach((entry) =>
          acc.add(entry),
        );
        return acc;
      }, new Set<TypeParamId>());
    case "intersection": {
      const acc = new Set<TypeParamId>();
      if (typeof desc.nominal === "number") {
        paramsReferencedInType(desc.nominal, allowed, ctx, seen).forEach(
          (entry) => acc.add(entry),
        );
      }
      if (typeof desc.structural === "number") {
        paramsReferencedInType(desc.structural, allowed, ctx, seen).forEach(
          (entry) => acc.add(entry),
        );
      }
      return acc;
    }
    case "fixed-array":
      return paramsReferencedInType(desc.element, allowed, ctx, seen);
    default:
      return new Set();
  }
};

const declaringParamsForField = (
  type: TypeId,
  allowed: ReadonlySet<TypeParamId>,
  ctx: TypingContext,
): readonly TypeParamId[] | undefined => {
  const referenced = paramsReferencedInType(type, allowed, ctx);
  return referenced.size > 0
    ? Array.from(referenced).sort((a, b) => a - b)
    : undefined;
};

const paramIdSetFrom = (
  params: ReadonlyMap<SymbolId, TypeId> | undefined,
  ctx: TypingContext,
): ReadonlySet<TypeParamId> | undefined => {
  if (!params) {
    return undefined;
  }
  const ids = Array.from(params.values())
    .map((type) => {
      const desc = ctx.arena.get(type);
      return desc.kind === "type-param-ref" ? desc.param : undefined;
    })
    .filter((entry): entry is TypeParamId => typeof entry === "number");
  return ids.length > 0 ? new Set(ids) : undefined;
};

const containsUnknownType = (
  type: TypeId,
  ctx: TypingContext,
  seen: Set<TypeId> = new Set(),
): boolean => {
  if (type === ctx.primitives.unknown) {
    return true;
  }
  if (seen.has(type)) {
    return false;
  }
  seen.add(type);

  const desc = ctx.arena.get(type);
  switch (desc.kind) {
    case "primitive":
    case "type-param-ref":
      return false;
    case "recursive":
      return containsUnknownType(desc.body, ctx, seen);
    case "trait":
    case "nominal-object":
      return desc.typeArgs.some((arg) => containsUnknownType(arg, ctx, seen));
    case "structural-object":
      return desc.fields.some((field) =>
        containsUnknownType(field.type, ctx, seen),
      );
    case "function":
      return (
        desc.parameters.some((param) =>
          containsUnknownType(param.type, ctx, seen),
        ) || containsUnknownType(desc.returnType, ctx, seen)
      );
    case "union":
      return desc.members.some((member) =>
        containsUnknownType(member, ctx, seen),
      );
    case "intersection":
      return (
        (typeof desc.nominal === "number" &&
          containsUnknownType(desc.nominal, ctx, seen)) ||
        (typeof desc.structural === "number" &&
          containsUnknownType(desc.structural, ctx, seen))
      );
    case "fixed-array":
      return containsUnknownType(desc.element, ctx, seen);
    default:
      return false;
  }
};

const containsTypeParam = (
  type: TypeId,
  param: TypeParamId,
  ctx: TypingContext,
  seen: Set<TypeId> = new Set(),
): boolean => {
  if (seen.has(type)) {
    return false;
  }
  seen.add(type);

  const desc = ctx.arena.get(type);
  switch (desc.kind) {
    case "type-param-ref":
      return desc.param === param;
    case "recursive":
      return containsTypeParam(desc.body, param, ctx, seen);
    case "trait":
    case "nominal-object":
      return desc.typeArgs.some((arg) =>
        containsTypeParam(arg, param, ctx, seen),
      );
    case "structural-object":
      return desc.fields.some((field) =>
        containsTypeParam(field.type, param, ctx, seen),
      );
    case "function":
      return (
        desc.parameters.some((paramDesc) =>
          containsTypeParam(paramDesc.type, param, ctx, seen),
        ) || containsTypeParam(desc.returnType, param, ctx, seen)
      );
    case "union":
      return desc.members.some((member) =>
        containsTypeParam(member, param, ctx, seen),
      );
    case "intersection":
      return (
        (typeof desc.nominal === "number" &&
          containsTypeParam(desc.nominal, param, ctx, seen)) ||
        (typeof desc.structural === "number" &&
          containsTypeParam(desc.structural, param, ctx, seen))
      );
    case "fixed-array":
      return containsTypeParam(desc.element, param, ctx, seen);
    default:
      return false;
  }
};

const containsAnyTypeParam = (
  type: TypeId,
  ctx: TypingContext,
  seen: Set<TypeId> = new Set(),
): boolean => {
  if (seen.has(type)) {
    return false;
  }
  seen.add(type);

  const desc = ctx.arena.get(type);
  switch (desc.kind) {
    case "type-param-ref":
      return true;
    case "recursive":
      return containsAnyTypeParam(desc.body, ctx, seen);
    case "trait":
    case "nominal-object":
      return desc.typeArgs.some((arg) => containsAnyTypeParam(arg, ctx, seen));
    case "structural-object":
      return desc.fields.some((field) =>
        containsAnyTypeParam(field.type, ctx, seen),
      );
    case "function":
      return (
        desc.parameters.some((paramDesc) =>
          containsAnyTypeParam(paramDesc.type, ctx, seen),
        ) || containsAnyTypeParam(desc.returnType, ctx, seen)
      );
    case "union":
      return desc.members.some((member) => containsAnyTypeParam(member, ctx, seen));
    case "intersection":
      return (
        (typeof desc.nominal === "number" &&
          containsAnyTypeParam(desc.nominal, ctx, seen)) ||
        (typeof desc.structural === "number" &&
          containsAnyTypeParam(desc.structural, ctx, seen))
      );
    case "fixed-array":
      return containsAnyTypeParam(desc.element, ctx, seen);
    default:
      return false;
  }
};

const containsAliasSelfUnguarded = (
  type: TypeId,
  aliasSymbol: SymbolId,
  aliasRoot: TypeId,
  ctx: TypingContext,
  guarded: boolean,
  seen: Set<string> = new Set(),
  isRoot = false,
): boolean => {
  const isAliasInstance = (): boolean => {
    if (type === aliasRoot) {
      return true;
    }
    const activeKey = ctx.typeAliases.getResolutionKey(type);
    if (typeof activeKey === "string") {
      const separator = activeKey.indexOf("<");
      const activeSymbol =
        separator === -1 ? Number.NaN : Number(activeKey.slice(0, separator));
      if (activeSymbol === aliasSymbol) {
        return true;
      }
    }
    const symbols = ctx.typeAliases.getInstanceSymbols(type);
    return symbols?.has(aliasSymbol) ?? false;
  };

  const seenKey = `${type}:${guarded ? "g" : "u"}`;
  if (seen.has(seenKey)) {
    return false;
  }
  seen.add(seenKey);

  if (isAliasInstance() && !isRoot) {
    return !guarded;
  }

  const desc = ctx.arena.get(type);
  switch (desc.kind) {
    case "primitive":
    case "type-param-ref":
      return false;
    case "recursive":
      return containsAliasSelfUnguarded(
        desc.body,
        aliasSymbol,
        aliasRoot,
        ctx,
        guarded,
        seen,
      );
    case "trait":
      return desc.typeArgs.some((arg) =>
        containsAliasSelfUnguarded(
          arg,
          aliasSymbol,
          aliasRoot,
          ctx,
          true,
          seen,
        ),
      );
    case "nominal-object":
      return desc.typeArgs.some((arg) =>
        containsAliasSelfUnguarded(
          arg,
          aliasSymbol,
          aliasRoot,
          ctx,
          true,
          seen,
        ),
      );
    case "structural-object":
      return desc.fields.some((field) =>
        containsAliasSelfUnguarded(
          field.type,
          aliasSymbol,
          aliasRoot,
          ctx,
          true,
          seen,
        ),
      );
    case "function":
      return (
        desc.parameters.some((paramDesc) =>
          containsAliasSelfUnguarded(
            paramDesc.type,
            aliasSymbol,
            aliasRoot,
            ctx,
            guarded,
            seen,
          ),
        ) ||
        containsAliasSelfUnguarded(
          desc.returnType,
          aliasSymbol,
          aliasRoot,
          ctx,
          guarded,
          seen,
        )
      );
    case "union":
      return desc.members.some((member) =>
        containsAliasSelfUnguarded(
          member,
          aliasSymbol,
          aliasRoot,
          ctx,
          guarded,
          seen,
        ),
      );
    case "intersection":
      return (
        (typeof desc.nominal === "number" &&
          containsAliasSelfUnguarded(
            desc.nominal,
            aliasSymbol,
            aliasRoot,
            ctx,
            guarded,
            seen,
          )) ||
        (typeof desc.structural === "number" &&
          containsAliasSelfUnguarded(
            desc.structural,
            aliasSymbol,
            aliasRoot,
            ctx,
            guarded,
            seen,
          ))
      );
    case "fixed-array":
      return containsAliasSelfUnguarded(
        desc.element,
        aliasSymbol,
        aliasRoot,
        ctx,
        true,
        seen,
      );
    default:
      return false;
  }
};

const recordAliasInstanceSymbol = (
  type: TypeId,
  symbol: SymbolId,
  ctx: TypingContext,
): void => {
  ctx.typeAliases.recordInstanceSymbol(type, symbol);
};

const assertAliasContractive = ({
  type,
  aliasSymbol,
  aliasName,
  ctx,
}: {
  type: TypeId;
  aliasSymbol: SymbolId;
  aliasName: string;
  ctx: TypingContext;
}): void => {
  recordAliasInstanceSymbol(type, aliasSymbol, ctx);

  const rootDesc = ctx.arena.get(type);
  if (rootDesc.kind === "recursive") {
    const containsBinderUnguarded = (
      current: TypeId,
      binder: TypeParamId,
      guarded: boolean,
      seen: Set<TypeId> = new Set(),
    ): boolean => {
      if (seen.has(current)) {
        return false;
      }
      seen.add(current);

      const desc = ctx.arena.get(current);
      switch (desc.kind) {
        case "primitive":
          return false;
        case "type-param-ref":
          return desc.param === binder ? !guarded : false;
        case "recursive":
          return containsBinderUnguarded(desc.body, binder, guarded, seen);
        case "trait":
        case "nominal-object":
          return desc.typeArgs.some((arg) =>
            containsBinderUnguarded(arg, binder, true, seen),
          );
        case "structural-object":
          return desc.fields.some((field) =>
            containsBinderUnguarded(field.type, binder, true, seen),
          );
        case "function":
          return (
            desc.parameters.some((param) =>
              containsBinderUnguarded(param.type, binder, guarded, seen),
            ) || containsBinderUnguarded(desc.returnType, binder, guarded, seen)
          );
        case "union":
          return desc.members.some((member) =>
            containsBinderUnguarded(member, binder, guarded, seen),
          );
        case "intersection":
          return (
            (typeof desc.nominal === "number" &&
              containsBinderUnguarded(desc.nominal, binder, guarded, seen)) ||
            (typeof desc.structural === "number" &&
              containsBinderUnguarded(desc.structural, binder, guarded, seen))
          );
        case "fixed-array":
          return containsBinderUnguarded(desc.element, binder, true, seen);
        default:
          return false;
      }
    };

    if (containsBinderUnguarded(rootDesc.body, rootDesc.binder, false)) {
      throw new Error(`type alias ${aliasName} is not contractive`);
    }
    return;
  }

  if (
    containsAliasSelfUnguarded(
      type,
      aliasSymbol,
      type,
      ctx,
      false,
      undefined,
      true,
    )
  ) {
    throw new Error(`type alias ${aliasName} is not contractive`);
  }
};

const ensureFieldsSubstituted = (
  fields: readonly StructuralField[],
  ctx: TypingContext,
  context: string,
): void => {
  fields.forEach((field) => {
    if (!field.declaringParams?.length) {
      return;
    }
    const remaining = paramsReferencedInType(
      field.type,
      new Set(field.declaringParams),
      ctx,
    );
    if (remaining.size > 0) {
      throw new Error(
        `${context} is missing substitutions for field ${field.name}`,
      );
    }
  });
};

const normalizeDeclarationTypeArgs = ({
  typeArgs,
  paramCount,
  ctx,
  state,
  context,
  requireAllTypeArgs,
}: {
  typeArgs: readonly TypeId[];
  paramCount: number;
  ctx: TypingContext;
  state: TypingState;
  context: string;
  requireAllTypeArgs?: boolean;
}) => {
  const normalized = normalizeTypeArgs({
    typeArgs,
    paramCount,
    unknownType: ctx.primitives.unknown,
    context,
  });

  if (
    normalized.missingCount > 0 &&
    (requireAllTypeArgs === true || state.mode === "strict")
  ) {
    throw new Error(
      `${context} is missing ${normalized.missingCount} type argument(s)`,
    );
  }

  return normalized;
};

const enforceExprTypeParameterConstraints = ({
  params,
  appliedArgs,
  ctx,
  state,
  context,
}: {
  params: readonly { symbol: SymbolId; constraint?: HirTypeExpr }[];
  appliedArgs: readonly TypeId[];
  ctx: TypingContext;
  state: TypingState;
  context: string;
}): ReadonlyMap<SymbolId, TypeId> => {
  const typeParamMap = new Map<SymbolId, TypeId>();
  params.forEach((param, index) =>
    typeParamMap.set(param.symbol, appliedArgs[index] ?? ctx.primitives.unknown),
  );

  params.forEach((param, index) => {
    if (!param.constraint) {
      return;
    }
    const applied = appliedArgs[index] ?? ctx.primitives.unknown;
    if (applied === ctx.primitives.unknown) {
      return;
    }
    const resolvedConstraint = resolveTypeExpr(
      param.constraint,
      ctx,
      state,
      ctx.primitives.unknown,
      typeParamMap,
    );
    if (!typeSatisfies(applied, resolvedConstraint, ctx, state)) {
      throw new Error(
        `type argument for ${getSymbolName(
          param.symbol,
          ctx,
        )} does not satisfy constraint for ${context}`,
      );
    }
  });

  return typeParamMap;
};

const enforceResolvedTypeParameterConstraints = ({
  params,
  appliedArgs,
  ctx,
  state,
  context,
}: {
  params: readonly {
    symbol: SymbolId;
    typeParam: TypeParamId;
    constraint?: TypeId;
  }[];
  appliedArgs: readonly TypeId[];
  ctx: TypingContext;
  state: TypingState;
  context: string;
}): ReadonlyMap<TypeParamId, TypeId> => {
  const substitution = new Map<TypeParamId, TypeId>();
  params.forEach((param, index) =>
    substitution.set(
      param.typeParam,
      appliedArgs[index] ?? ctx.primitives.unknown,
    ),
  );

  params.forEach((param, index) => {
    if (!param.constraint) {
      return;
    }
    const applied = appliedArgs[index] ?? ctx.primitives.unknown;
    if (applied === ctx.primitives.unknown) {
      return;
    }
    const constraintType = ctx.arena.substitute(param.constraint, substitution);
    if (!typeSatisfies(applied, constraintType, ctx, state)) {
      throw new Error(
        `type argument for ${getSymbolName(
          param.symbol,
          ctx,
        )} does not satisfy constraint for ${context}`,
      );
    }
  });

  return substitution;
};

export const registerPrimitive = (
  ctx: TypingContext,
  canonical: string,
  ...aliases: string[]
): TypeId => {
  let id = ctx.primitives.cache.get(canonical);
  if (typeof id !== "number") {
    id = ctx.arena.internPrimitive(canonical);
  }
  ctx.primitives.cache.set(canonical, id);
  aliases.forEach((alias) => ctx.primitives.cache.set(alias, id));
  return id;
};

export const getPrimitiveType = (ctx: TypingContext, name: string): TypeId => {
  const cached = ctx.primitives.cache.get(name);
  if (typeof cached === "number") {
    return cached;
  }
  return registerPrimitive(ctx, name);
};

export const unfoldRecursiveType = (
  type: TypeId,
  ctx: TypingContext,
): TypeId => {
  let current = type;
  const seen = new Set<TypeId>();

  while (!seen.has(current)) {
    seen.add(current);
    const desc = ctx.arena.get(current);
    if (desc.kind !== "recursive") {
      return current;
    }
    current = ctx.arena.substitute(
      desc.body,
      new Map([[desc.binder, current]]),
    );
  }

  return current;
};

export const resolveTypeExpr = (
  expr: HirTypeExpr | undefined,
  ctx: TypingContext,
  state: TypingState,
  fallback: TypeId,
  typeParams?: ReadonlyMap<SymbolId, TypeId>,
): TypeId => {
  const activeTypeParams = typeParams ?? state.currentFunction?.typeParams;
  if (!expr) {
    return fallback;
  }

  let resolved: TypeId;
  switch (expr.typeKind) {
    case "named":
      resolved = resolveNamedTypeExpr(expr, ctx, state, activeTypeParams);
      break;
    case "object":
      resolved = resolveObjectTypeExpr(expr, ctx, state, activeTypeParams);
      break;
    case "tuple":
      resolved = resolveTupleTypeExpr(expr, ctx, state, activeTypeParams);
      break;
    case "function":
      resolved = resolveFunctionTypeExpr(expr, ctx, state, activeTypeParams);
      break;
    case "union":
      resolved = resolveUnionTypeExpr(expr, ctx, state, activeTypeParams);
      break;
    case "intersection":
      resolved = resolveIntersectionTypeExpr(
        expr,
        ctx,
        state,
        activeTypeParams,
      );
      break;
    default:
      throw new Error(`unsupported type expression kind: ${expr.typeKind}`);
  }
  expr.typeId = resolved;
  return resolved;
};

const makeTypeAliasInstanceKey = (
  symbol: SymbolId,
  typeArgs: readonly TypeId[],
): string => `${symbol}<${typeArgs.join(",")}>`;

export const resolveTypeAlias = (
  symbol: SymbolId,
  ctx: TypingContext,
  state: TypingState,
  typeArgs: readonly TypeId[] = [],
): TypeId => {
  const aliasName = getSymbolName(symbol, ctx);
  const template = ctx.typeAliases.getTemplate(symbol);

  if (!template) {
    throw new Error(`missing type alias target for ${aliasName}`);
  }

  const normalized = normalizeDeclarationTypeArgs({
    typeArgs,
    paramCount: template.params.length,
    ctx,
    state,
    context: `type alias ${aliasName}`,
    requireAllTypeArgs: true,
  });

  const key = makeTypeAliasInstanceKey(symbol, normalized.applied);
  const cacheable = shouldCacheInstantiation(normalized);

  if (ctx.typeAliases.hasFailed(key)) {
    throw new Error(`type alias ${aliasName} instantiation previously failed`);
  }

  const cached = cacheable ? ctx.typeAliases.getCachedInstance(key) : undefined;
  if (typeof cached === "number") {
    if (!ctx.typeAliases.isValidated(key)) {
      assertAliasContractive({
        type: cached,
        aliasSymbol: symbol,
        aliasName,
        ctx,
      });
      ctx.typeAliases.markValidated(key);
    } else {
      recordAliasInstanceSymbol(cached, symbol, ctx);
    }
    return cached;
  }

  const active = ctx.typeAliases.getActiveResolution(key);
  if (typeof active === "number") {
    return active;
  }

  let resolved: TypeId;
  try {
    resolved = ctx.arena.createRecursiveType((self, placeholder) => {
      void placeholder;
      ctx.typeAliases.beginResolution(key, self);

      const paramMap = enforceExprTypeParameterConstraints({
        params: template.params,
        appliedArgs: normalized.applied,
        ctx,
        state,
        context: `type alias ${aliasName}`,
      });

      const targetType = resolveTypeExpr(
        template.target,
        ctx,
        state,
        ctx.primitives.unknown,
        paramMap,
      );
      if (targetType === self) {
        throw new Error(
          `cyclic type alias instantiation: type alias ${aliasName} cannot resolve to itself`,
        );
      }
      if (containsUnknownType(targetType, ctx)) {
        throw new Error(`type alias ${aliasName} could not be fully resolved`);
      }
      return ctx.arena.get(targetType);
    });

    const allowedParams = (() => {
      const collected = new Set<TypeParamId>();
      const seen = new Set<TypeId>();

      const collect = (
        type: TypeId,
        boundRecursive: ReadonlySet<TypeParamId> = new Set(),
      ): void => {
        if (seen.has(type)) {
          return;
        }
        seen.add(type);

        const desc = ctx.arena.get(type);
        switch (desc.kind) {
          case "type-param-ref":
            if (!boundRecursive.has(desc.param)) {
              collected.add(desc.param);
            }
            return;
          case "recursive": {
            const nextBound = new Set(boundRecursive);
            nextBound.add(desc.binder);
            collect(desc.body, nextBound);
            return;
          }
          case "trait":
          case "nominal-object":
            desc.typeArgs.forEach((arg) => collect(arg, boundRecursive));
            return;
          case "structural-object":
            desc.fields.forEach((field) => collect(field.type, boundRecursive));
            return;
          case "function":
            desc.parameters.forEach((param) =>
              collect(param.type, boundRecursive),
            );
            collect(desc.returnType, boundRecursive);
            return;
          case "union":
            desc.members.forEach((member) => collect(member, boundRecursive));
            return;
          case "intersection":
            if (typeof desc.nominal === "number") {
              collect(desc.nominal, boundRecursive);
            }
            if (typeof desc.structural === "number") {
              collect(desc.structural, boundRecursive);
            }
            return;
          case "fixed-array":
            collect(desc.element, boundRecursive);
            return;
          default:
            return;
        }
      };

      normalized.applied.forEach((arg) => collect(arg));
      return collected;
    })();

    const containsUnboundTypeParam = (
      type: TypeId,
      boundRecursive: ReadonlySet<TypeParamId> = new Set(),
      seen: Set<TypeId> = new Set(),
    ): boolean => {
      if (seen.has(type)) {
        return false;
      }
      seen.add(type);

      const desc = ctx.arena.get(type);
      switch (desc.kind) {
        case "type-param-ref":
          return (
            !allowedParams.has(desc.param) && !boundRecursive.has(desc.param)
          );
        case "recursive": {
          const nextBound = new Set(boundRecursive);
          nextBound.add(desc.binder);
          return containsUnboundTypeParam(desc.body, nextBound, seen);
        }
        case "trait":
        case "nominal-object":
          return desc.typeArgs.some((arg) =>
            containsUnboundTypeParam(arg, boundRecursive, seen),
          );
        case "structural-object":
          return desc.fields.some((field) =>
            containsUnboundTypeParam(field.type, boundRecursive, seen),
          );
        case "function":
          return (
            desc.parameters.some((param) =>
              containsUnboundTypeParam(param.type, boundRecursive, seen),
            ) || containsUnboundTypeParam(desc.returnType, boundRecursive, seen)
          );
        case "union":
          return desc.members.some((member) =>
            containsUnboundTypeParam(member, boundRecursive, seen),
          );
        case "intersection":
          return (
            (typeof desc.nominal === "number" &&
              containsUnboundTypeParam(desc.nominal, boundRecursive, seen)) ||
            (typeof desc.structural === "number" &&
              containsUnboundTypeParam(desc.structural, boundRecursive, seen))
          );
        case "fixed-array":
          return containsUnboundTypeParam(desc.element, boundRecursive, seen);
        default:
          return false;
      }
    };

    const hasUnboundTypeParam = containsUnboundTypeParam(resolved);

    if (hasUnboundTypeParam && ctx.typeAliases.resolutionDepth() === 1) {
      const formatType = (type: TypeId): string => {
        try {
          return JSON.stringify({ id: type, desc: ctx.arena.get(type) });
        } catch {
          return String(type);
        }
      };
      const resolvedDesc = ctx.arena.get(resolved);
      const describeType = (type: TypeId): string => {
        const desc = ctx.arena.get(type);
        if (desc.kind === "intersection" && typeof desc.nominal === "number") {
          const nominal = ctx.arena.get(desc.nominal);
          if (nominal.kind === "nominal-object") {
            const args = nominal.typeArgs.map(formatType).join(", ");
            return `${nominal.name}${args.length > 0 ? `<${args}>` : ""}`;
          }
        }
        return formatType(type);
      };
      const detail =
        resolvedDesc.kind === "union"
          ? (() => {
              const memberDetails = resolvedDesc.members
                .map((member) => ({
                  member,
                  unbound: containsUnboundTypeParam(member),
                }))
                .map(
                  ({ member, unbound }) =>
                    `${describeType(member)}${unbound ? " (unbound)" : ""}`,
                )
                .join(", ");
              return `\nunion members: ${memberDetails}`;
            })()
          : "";
      throw new Error(
        `cyclic type alias instantiation for ${aliasName} (unbound type param)\nresolved: ${formatType(
          resolved,
        )}${detail}`,
      );
    }

    assertAliasContractive({
      type: resolved,
      aliasSymbol: symbol,
      aliasName,
      ctx,
    });

    const canCacheNow = cacheable && !hasUnboundTypeParam;
    if (canCacheNow) {
      ctx.typeAliases.cacheInstance(key, resolved);
      ctx.typeAliases.markValidated(key);
    }
    return resolved;
  } catch (error) {
    ctx.typeAliases.markFailed(key);
    throw error;
  } finally {
    ctx.typeAliases.endResolution(key);
  }
};

const resolveNamedTypeExpr = (
  expr: HirNamedTypeExpr,
  ctx: TypingContext,
  state: TypingState,
  typeParams?: ReadonlyMap<SymbolId, TypeId>,
): TypeId => {
  const name = expr.path.at(-1)!;
  const resolvedTypeArgs =
    expr.typeArguments?.map((arg) =>
      resolveTypeExpr(arg, ctx, state, ctx.primitives.unknown, typeParams),
    ) ?? [];
  const importedType = resolveImportedTypeExpr({
    expr,
    typeArgs: resolvedTypeArgs,
    ctx,
    state,
  });
  if (typeof importedType === "number") {
    return importedType;
  }

  const typeParamMap = typeParams ?? state.currentFunction?.typeParams;
  const aliasSymbol =
    (typeof expr.symbol === "number" && ctx.typeAliases.hasTemplate(expr.symbol)
      ? expr.symbol
      : undefined) ?? ctx.typeAliases.resolveName(name);
  const normalizeAliasArgs =
    aliasSymbol !== undefined &&
    (typeof expr.symbol !== "number" || expr.symbol === aliasSymbol);
  const aliasTemplate =
    normalizeAliasArgs && aliasSymbol !== undefined
      ? ctx.typeAliases.getTemplate(aliasSymbol)
      : undefined;
  const normalizedAliasArgs =
    normalizeAliasArgs && aliasTemplate
      ? normalizeTypeArgs({
          typeArgs: resolvedTypeArgs,
          paramCount: aliasTemplate.params.length,
          unknownType: ctx.primitives.unknown,
          context: `type alias ${getSymbolName(aliasSymbol, ctx)}`,
        })
      : undefined;
  const aliasInstanceKey =
    normalizeAliasArgs &&
    normalizedAliasArgs &&
    normalizedAliasArgs.missingCount === 0 &&
    aliasSymbol !== undefined
      ? makeTypeAliasInstanceKey(aliasSymbol, normalizedAliasArgs.applied)
      : undefined;
  const activeAlias =
    typeof aliasInstanceKey === "string"
      ? ctx.typeAliases.getActiveResolution(aliasInstanceKey)
      : undefined;
  const activeAliasKey =
    typeof activeAlias === "number"
      ? ctx.typeAliases.getResolutionKey(activeAlias)
      : undefined;
  const typeParam =
    (typeof expr.symbol === "number"
      ? typeParamMap?.get(expr.symbol)
      : findTypeParamByName(name, typeParamMap, ctx)) ?? undefined;
  const isAliasSelfReference =
    typeof activeAlias === "number" && typeParam === activeAlias;
  if (typeof typeParam === "number" && !isAliasSelfReference) {
    if (resolvedTypeArgs.length > 0) {
      throw new Error("type parameters do not accept type arguments");
    }
    return typeParam;
  }

  if (isFixedArrayReference(name, expr.symbol, ctx)) {
    return resolveFixedArrayType({
      typeArgs: resolvedTypeArgs,
      ctx,
      state,
    });
  }

  if (
    typeof activeAlias === "number" &&
    typeof aliasInstanceKey === "string" &&
    activeAliasKey !== undefined &&
    activeAliasKey !== aliasInstanceKey
  ) {
    const activeDesc = ctx.arena.get(activeAlias);
    if (activeDesc.kind === "type-param-ref") {
      throw new Error(
        `cyclic type alias instantiation for ${name} (resolution mismatch)`,
      );
    }
  }

  if (name === BASE_OBJECT_NAME) {
    return ctx.objects.base.type;
  }
  if (aliasSymbol !== undefined) {
    const aliasArgs =
      isAliasSelfReference && normalizedAliasArgs
        ? normalizedAliasArgs.applied
        : resolvedTypeArgs;
    return resolveTypeAlias(aliasSymbol, ctx, state, aliasArgs);
  }

  const objectSymbol =
    (typeof expr.symbol === "number" && ctx.objects.hasDecl(expr.symbol)
      ? expr.symbol
      : undefined) ?? ctx.objects.resolveName(name);
  if (objectSymbol !== undefined) {
    const info = ensureObjectType(objectSymbol, ctx, state, resolvedTypeArgs);
    return info?.type ?? ctx.primitives.unknown;
  }

  const traitSymbol =
    (typeof expr.symbol === "number" && ctx.traits.getDecl(expr.symbol)
      ? expr.symbol
      : undefined) ?? ctx.traits.resolveName(name);
  if (traitSymbol !== undefined) {
    const traitType = ensureTraitType(
      traitSymbol,
      ctx,
      state,
      resolvedTypeArgs,
    );
    if (typeof traitType === "number") {
      return traitType;
    }
  }

  const resolved = ctx.primitives.cache.get(name);
  if (typeof resolved === "number") {
    return resolved;
  }

  return emitDiagnostic({
    ctx,
    code: "TY0026",
    params: { kind: "undefined-type", name },
    span: expr.span,
  });
};

const findTypeParamByName = (
  name: string,
  typeParams: ReadonlyMap<SymbolId, TypeId> | undefined,
  ctx: TypingContext,
): TypeId | undefined => {
  if (!typeParams) {
    return undefined;
  }

  for (const [symbol, type] of typeParams.entries()) {
    if (getSymbolName(symbol, ctx) === name) {
      return type;
    }
  }

  return undefined;
};

const resolveObjectTypeExpr = (
  expr: HirObjectTypeExpr,
  ctx: TypingContext,
  state: TypingState,
  typeParams?: ReadonlyMap<SymbolId, TypeId>,
): TypeId => {
  const allowedParams = paramIdSetFrom(typeParams, ctx);
  const fields = expr.fields.map((field) => {
    const type = resolveTypeExpr(
      field.type,
      ctx,
      state,
      ctx.primitives.unknown,
      typeParams,
    );
    return {
      name: field.name,
      type,
      declaringParams: allowedParams
        ? declaringParamsForField(type, allowedParams, ctx)
        : undefined,
    };
  });
  return ctx.arena.internStructuralObject({ fields });
};

const resolveFunctionTypeExpr = (
  expr: HirFunctionTypeExpr,
  ctx: TypingContext,
  state: TypingState,
  typeParams?: ReadonlyMap<SymbolId, TypeId>,
): TypeId => {
  if (expr.typeParameters && expr.typeParameters.length > 0) {
    throw new Error("function type parameters are not supported yet");
  }
  const parameters = expr.parameters.map((param) => ({
    type: resolveTypeExpr(
      param.type,
      ctx,
      state,
      ctx.primitives.unknown,
      typeParams,
    ),
    optional: param.optional ?? false,
  }));
  const returnType = resolveTypeExpr(
    expr.returnType,
    ctx,
    state,
    ctx.primitives.unknown,
    typeParams,
  );
  const effectRow =
    resolveEffectAnnotation(expr.effectType, ctx, state) ??
    freshOpenEffectRow(ctx.effects);
  return ctx.arena.internFunction({
    parameters,
    returnType,
    effectRow,
  });
};

const resolveTupleTypeExpr = (
  expr: HirTupleTypeExpr,
  ctx: TypingContext,
  state: TypingState,
  typeParams?: ReadonlyMap<SymbolId, TypeId>,
): TypeId => {
  const fields = expr.elements.map((element, index) => {
    const type = resolveTypeExpr(
      element,
      ctx,
      state,
      ctx.primitives.unknown,
      typeParams,
    );
    return {
      name: `${index}`,
      type,
    };
  });
  return ctx.arena.internStructuralObject({ fields });
};

const resolveUnionTypeExpr = (
  expr: HirUnionTypeExpr,
  ctx: TypingContext,
  state: TypingState,
  typeParams?: ReadonlyMap<SymbolId, TypeId>,
): TypeId => {
  const members = expr.members.map((member) =>
    resolveTypeExpr(member, ctx, state, ctx.primitives.unknown, typeParams),
  );
  return ctx.arena.internUnion(members);
};

const resolveIntersectionTypeExpr = (
  expr: HirIntersectionTypeExpr,
  ctx: TypingContext,
  state: TypingState,
  typeParams?: ReadonlyMap<SymbolId, TypeId>,
): TypeId => {
  const members = expr.members.map((member) =>
    resolveTypeExpr(member, ctx, state, ctx.primitives.unknown, typeParams),
  );

  const mergedFields = new Map<string, StructuralField>();
  const traits: TypeId[] = [];
  let nominal: TypeId | undefined;

  const mergeField = (field: StructuralField): void => {
    const existing = mergedFields.get(field.name);
    if (!existing) {
      mergedFields.set(field.name, field);
      return;
    }

    const requiredOptional =
      existing.optional === true && field.optional === true ? true : undefined;
    const compatible = unifyWithBudget({
      actual: existing.type,
      expected: field.type,
      options: {
        location: ctx.hir.module.ast,
        reason: `intersection field ${field.name} compatibility`,
        variance: "invariant",
        allowUnknown: state.mode === "relaxed",
      },
      ctx,
      span: expr.span,
    });
    if (!compatible.ok) {
      emitDiagnostic({
        ctx,
        code: "TY0029",
        params: {
          kind: "intersection-field-conflict",
          field: field.name,
          left: typeDescriptorToUserString(
            ctx.arena.get(existing.type),
            ctx.arena,
          ),
          right: typeDescriptorToUserString(
            ctx.arena.get(field.type),
            ctx.arena,
          ),
        },
        span: expr.span,
      });
      return;
    }

    const visibilityCandidate = existing.visibility ?? field.visibility;
    const mergedVisibility: HirVisibility | undefined = visibilityCandidate
      ? {
          level:
            existing.visibility?.level === "object" ||
            field.visibility?.level === "object"
              ? "object"
              : (existing.visibility?.level ??
                field.visibility?.level ??
                "module"),
          api:
            (existing.visibility?.api ?? true) &&
            (field.visibility?.api ?? true),
        }
      : undefined;

    mergedFields.set(field.name, {
      ...existing,
      type: existing.type,
      optional: requiredOptional,
      visibility: mergedVisibility,
      owner: existing.owner ?? field.owner,
      packageId: existing.packageId ?? field.packageId,
    });
  };

  const mergeNominal = (candidate: TypeId): void => {
    if (candidate === ctx.objects.base.nominal) {
      nominal ??= candidate;
      return;
    }
    if (!nominal) {
      nominal = candidate;
      return;
    }
    if (nominalSatisfies(candidate, nominal, ctx, state)) {
      nominal = candidate;
      return;
    }
    if (nominalSatisfies(nominal, candidate, ctx, state)) {
      return;
    }
    emitDiagnostic({
      ctx,
      code: "TY0028",
      params: {
        kind: "intersection-nominal-conflict",
        left: typeDescriptorToUserString(ctx.arena.get(nominal), ctx.arena),
        right: typeDescriptorToUserString(ctx.arena.get(candidate), ctx.arena),
      },
      span: expr.span,
    });
  };

  const structuralTypeOf = (type: TypeId): TypeId | undefined => {
    if (type === ctx.primitives.unknown) {
      return undefined;
    }

    const unfolded = unfoldRecursiveType(type, ctx);
    const desc = ctx.arena.get(unfolded);
    if (desc.kind === "structural-object") {
      ensureFieldsSubstituted(desc.fields, ctx, "intersection fields");
      return unfolded;
    }
    if (desc.kind === "nominal-object") {
      const owner = localSymbolForSymbolRef(desc.owner, ctx);
      const info =
        typeof owner === "number"
          ? ensureObjectType(owner, ctx, state, desc.typeArgs)
          : undefined;
      return info?.structural;
    }
    if (desc.kind === "intersection") {
      if (desc.traits && desc.traits.length > 0) {
        traits.push(...desc.traits);
      }
      if (typeof desc.structural === "number") {
        return structuralTypeOf(desc.structural);
      }
      if (typeof desc.nominal === "number") {
        return structuralTypeOf(desc.nominal);
      }
      return undefined;
    }
    if (desc.kind === "trait") {
      traits.push(unfolded);
      return undefined;
    }

    emitDiagnostic({
      ctx,
      code: "TY0027",
      params: {
        kind: "type-mismatch",
        actual: typeDescriptorToUserString(desc, ctx.arena),
        expected: "an object or trait type",
      },
      span: expr.span,
    });
    return undefined;
  };

  members.forEach((member) => {
    const memberDesc = ctx.arena.get(member);
    if (memberDesc.kind === "trait") {
      traits.push(member);
      return;
    }
    if (memberDesc.kind === "intersection" && memberDesc.traits) {
      traits.push(...memberDesc.traits);
    }

    const memberNominal = getNominalComponent(member, ctx);
    if (typeof memberNominal === "number") {
      mergeNominal(memberNominal);
    }

    const structural = structuralTypeOf(member);
    if (typeof structural !== "number") {
      return;
    }
    const structuralDesc = ctx.arena.get(structural);
    if (structuralDesc.kind !== "structural-object") {
      return;
    }
    structuralDesc.fields.forEach((field) => mergeField(field));
  });

  const canonicalTraits =
    traits.length > 0 ? [...new Set(traits)].sort((a, b) => a - b) : undefined;

  const structural =
    mergedFields.size > 0
      ? ctx.arena.internStructuralObject({
          fields: Array.from(mergedFields.values()),
        })
      : undefined;

  const finalNominal =
    nominal ??
    (typeof structural === "number" ? ctx.objects.base.nominal : undefined);

  return ctx.arena.internIntersection({
    nominal: finalNominal,
    structural,
    traits: canonicalTraits,
  });
};

export const getSymbolName = (symbol: SymbolId, ctx: TypingContext): string =>
  ctx.symbolTable.getSymbol(symbol).name;

const makeObjectInstanceKey = (
  symbol: SymbolId,
  typeArgs: readonly TypeId[],
): string => `${symbol}<${typeArgs.join(",")}>`;

export const getObjectTemplate = (
  symbol: SymbolId,
  ctx: TypingContext,
  state: TypingState,
): ObjectTemplate | undefined => {
  const cached = ctx.objects.getTemplate(symbol);
  if (cached) {
    return cached;
  }

  if (ctx.objects.isResolving(symbol)) {
    return undefined;
  }

  const decl = ctx.objects.getDecl(symbol);
  if (!decl) {
    return undefined;
  }

  ctx.objects.beginResolving(symbol);
  try {
    const params =
      decl.typeParameters?.map((param) => ({
        symbol: param.symbol,
        typeParam: ctx.arena.freshTypeParam(),
        constraint: undefined as TypeId | undefined,
      })) ?? [];
    const paramMap = new Map<SymbolId, TypeId>();
    params.forEach(({ symbol, typeParam }, index) => {
      const ref = ctx.arena.internTypeParamRef(typeParam);
      paramMap.set(symbol, ref);
      const constraintExpr = decl.typeParameters?.[index]?.constraint;
      if (constraintExpr) {
        params[index]!.constraint = resolveTypeExpr(
          constraintExpr,
          ctx,
          state,
          ctx.primitives.unknown,
          paramMap,
        );
      }
    });

    const templateParams = new Set(params.map((param) => param.typeParam));

    const baseType = resolveTypeExpr(
      decl.base,
      ctx,
      state,
      ctx.objects.base.type,
      paramMap,
    );
    const baseFields = (
      getStructuralFields(baseType, ctx, state, {
        includeInaccessible: true,
        allowOwnerPrivate: true,
      }) ?? []
    ).map((field) => ({
      ...field,
      declaringParams: declaringParamsForField(field.type, templateParams, ctx),
      packageId: field.packageId ?? ctx.packageId,
    }));
    const baseNominal = getNominalComponent(baseType, ctx);

    const ownFields = decl.fields.map((field) => {
      const type = resolveTypeExpr(
        field.type,
        ctx,
        state,
        ctx.primitives.unknown,
        paramMap,
      );
      return {
        name: field.name,
        type,
        optional: field.optional,
        declaringParams: declaringParamsForField(type, templateParams, ctx),
        visibility: field.visibility,
        owner: decl.symbol,
        packageId: ctx.packageId,
      };
    });

    if (baseFields.length > 0) {
      const declaredFields = new Map(
        ownFields.map((field) => [field.name, field]),
      );
      baseFields.forEach((baseField) => {
        const declared = declaredFields.get(baseField.name);
        if (!declared) {
          throw new Error(
            `object ${getSymbolName(
              symbol,
              ctx,
            )} must redeclare inherited field ${baseField.name}`,
          );
        }
        const compatibility = unifyWithBudget({
          actual: declared.type,
          expected: baseField.type,
          options: {
            location: ctx.hir.module.ast,
            reason: `field ${baseField.name} compatibility with base object`,
          },
          ctx,
          span: decl.span,
        });
        if (!compatibility.ok) {
          throw new Error(
            `field ${baseField.name} in object ${getSymbolName(
              symbol,
              ctx,
            )} must match base object type`,
          );
        }
      });
    }

    const fields = mergeDeclaredFields(baseFields, ownFields);
    const structural = ctx.arena.internStructuralObject({ fields });
    const nominal = ctx.arena.internNominalObject({
      owner: canonicalSymbolRefForTypingContext(symbol, ctx),
      name: getSymbolName(symbol, ctx),
      typeArgs: params.map((param) => paramMap.get(param.symbol)!),
    });
    const type = ctx.arena.internIntersection({
      nominal,
      structural,
    });

    const template: ObjectTemplate = {
      symbol,
      params,
      nominal,
      structural,
      type,
      fields,
      visibility: decl.visibility,
      baseNominal,
    };
    ctx.objects.registerTemplate(template);
    return template;
  } finally {
    ctx.objects.endResolving(symbol);
  }
};

export const ensureObjectType = (
  symbol: SymbolId,
  ctx: TypingContext,
  state: TypingState,
  typeArgs: readonly TypeId[] = [],
): ObjectTypeInfo | undefined => {
  if (ctx.objects.isResolving(symbol)) {
    return undefined;
  }

  const template = getObjectTemplate(symbol, ctx, state);
  if (!template) {
    return undefined;
  }
  const templateParamSet = new Set(
    template.params.map((param) => param.typeParam),
  );
  const objectName = getSymbolName(symbol, ctx);

  const normalized = normalizeDeclarationTypeArgs({
    typeArgs,
    paramCount: template.params.length,
    ctx,
    state,
    context: `object ${objectName}`,
  });

  const key = makeObjectInstanceKey(symbol, normalized.applied);
  const cacheable = shouldCacheInstantiation(normalized);
  if (cacheable) {
    const cached = ctx.objects.getInstance(key);
    if (cached) {
      return cached;
    }
  }

  const subst = enforceResolvedTypeParameterConstraints({
    params: template.params,
    appliedArgs: normalized.applied,
    ctx,
    state,
    context: `object ${objectName}`,
  });

  const nominal = ctx.arena.substitute(template.nominal, subst);
  const structural = ctx.arena.substitute(template.structural, subst);
  const unresolvedStructuralParams = paramsReferencedInType(
    structural,
    templateParamSet,
    ctx,
  );
  if (unresolvedStructuralParams.size > 0) {
    throw new Error(
      `object ${objectName} is missing substitutions for its structural fields`,
    );
  }
  const type = ctx.arena.substitute(template.type, subst);
  const fields = template.fields.map((field) => ({
    name: field.name,
    type: ctx.arena.substitute(field.type, subst),
    optional: field.optional,
    declaringParams: field.declaringParams,
    visibility: field.visibility,
    owner: field.owner,
    packageId: field.packageId ?? ctx.packageId,
  }));
  ensureFieldsSubstituted(
    fields,
    ctx,
    `object ${objectName} instantiation`,
  );
  const baseNominal = template.baseNominal
    ? ctx.arena.substitute(template.baseNominal, subst)
    : undefined;

  const info: ObjectTypeInfo = {
    nominal,
    structural,
    type,
    fields,
    visibility: template.visibility,
    baseNominal,
  };
  const traitImpls = instantiateTraitImplsFor({
    nominal,
    ctx,
    state,
  });
  if (traitImpls.length > 0) {
    info.traitImpls = traitImpls;
  }

  const cacheableInstance = cacheable && !containsUnknownType(type, ctx);
  if (cacheableInstance) {
    ctx.objects.addInstance(key, info);
    ctx.valueTypes.set(symbol, type);
  }
  return info;
};

export const ensureTraitType = (
  symbol: SymbolId,
  ctx: TypingContext,
  state: TypingState,
  typeArgs: readonly TypeId[] = [],
): TypeId | undefined => {
  const hirDecl = ctx.traits.getDecl(symbol);
  const decl = hirDecl ?? ctx.decls.getTrait(symbol);
  if (!decl) {
    return undefined;
  }

  const traitName = getSymbolName(symbol, ctx);
  const paramCount =
    hirDecl?.typeParameters?.length ?? decl.typeParameters?.length ?? 0;
  const normalized = normalizeDeclarationTypeArgs({
    typeArgs,
    paramCount,
    ctx,
    state,
    context: `trait ${traitName}`,
  });

  if (hirDecl?.typeParameters && hirDecl.typeParameters.length > 0) {
    enforceExprTypeParameterConstraints({
      params: hirDecl.typeParameters,
      appliedArgs: normalized.applied,
      ctx,
      state,
      context: `trait ${traitName}`,
    });
  }

  const type = ctx.arena.internTrait({
    owner: canonicalSymbolRefForTypingContext(symbol, ctx),
    name: traitName,
    typeArgs: normalized.applied,
  });
  ctx.valueTypes.set(symbol, type);
  return type;
};

const instantiateTraitImplsFor = ({
  nominal,
  ctx,
  state,
}: {
  nominal: TypeId;
  ctx: TypingContext;
  state: TypingState;
}): readonly TraitImplInstance[] => {
  const cached = ctx.traitImplsByNominal.get(nominal);
  if (cached && cached.length > 0) {
    return cached;
  }

  const implementations: TraitImplInstance[] = [];
  const allowUnknown = state.mode === "relaxed";
  ctx.traits.getImplTemplates().forEach((template) => {
    const match = unifyWithBudget({
      actual: nominal,
      expected: template.target,
      options: {
        location: ctx.hir.module.ast,
        reason: "trait impl instantiation",
        variance: "invariant",
        allowUnknown,
      },
      ctx,
    });
    const fallbackMatch =
      !match.ok && template.typeParams.length === 0
        ? (() => {
            const templateNominal = getNominalComponent(template.target, ctx);
            if (typeof templateNominal !== "number") {
              return undefined;
            }
            return nominal === templateNominal
              ? new Map<TypeParamId, TypeId>()
              : undefined;
          })()
        : undefined;
    if (!match.ok && !fallbackMatch) {
      return;
    }

    const implTypeArgSubstitution = new Map<TypeParamId, TypeId>();
    template.typeParams.forEach((param) =>
      implTypeArgSubstitution.set(
        param.typeParam,
        (match.ok
          ? match.substitution.get(param.typeParam)
          : fallbackMatch?.get(param.typeParam)) ?? ctx.primitives.unknown,
      ),
    );

    const constraintsSatisfied = template.typeParams.every((param) => {
      if (!param.constraint) {
        return true;
      }
      const applied =
        implTypeArgSubstitution.get(param.typeParam) ?? ctx.primitives.unknown;
      if (applied === ctx.primitives.unknown) {
        return true;
      }
      const constraint = ctx.arena.substitute(
        param.constraint,
        implTypeArgSubstitution,
      );
      return typeSatisfies(applied, constraint, ctx, state);
    });
    if (!constraintsSatisfied) {
      return;
    }

    const substitution = match.ok ? match.substitution : fallbackMatch!;
    const appliedTrait = ctx.arena.substitute(template.trait, substitution);
    const traitDesc = ctx.arena.get(appliedTrait);
    if (traitDesc.kind !== "trait") {
      return;
    }
    const appliedTarget = ctx.arena.substitute(template.target, substitution);
    implementations.push({
      trait: appliedTrait,
      traitSymbol: template.traitSymbol,
      target: appliedTarget,
      methods: template.methods,
      implSymbol: template.implSymbol,
    });
  });

  ctx.traitImplsByNominal.set(nominal, implementations);
  implementations.forEach((impl) => {
    const existing = ctx.traitImplsByTrait.get(impl.traitSymbol);
    const next = existing ? [...existing, impl] : [impl];
    ctx.traitImplsByTrait.set(impl.traitSymbol, next);
  });

  return implementations;
};

const mergeDeclaredFields = (
  inherited: readonly StructuralField[],
  own: readonly StructuralField[],
): StructuralField[] => {
  const fields = new Map<string, StructuralField>();
  inherited.forEach((field) => fields.set(field.name, field));
  own.forEach((field) => fields.set(field.name, field));
  return Array.from(fields.values());
};

export const getObjectInfoForNominal = (
  nominal: TypeId,
  ctx: TypingContext,
  state: TypingState,
): ObjectTypeInfo | undefined => {
  const cached = ctx.objects.getInstanceByNominal(nominal);
  if (cached) {
    return cached;
  }
  const desc = ctx.arena.get(nominal);
  if (desc.kind !== "nominal-object") {
    return undefined;
  }
  const owner = localSymbolForSymbolRef(desc.owner, ctx);
  if (typeof owner !== "number") {
    return undefined;
  }
  return ensureObjectType(owner, ctx, state, desc.typeArgs);
};

export const getNominalComponent = (
  type: TypeId,
  ctx: TypingContext,
): TypeId | undefined => {
  if (type === ctx.primitives.unknown) {
    return undefined;
  }

  const desc = ctx.arena.get(type);
  switch (desc.kind) {
    case "nominal-object":
      return type;
    case "intersection":
      if (typeof desc.nominal === "number") {
        return desc.nominal;
      }
      if (typeof desc.structural === "number") {
        return getNominalComponent(desc.structural, ctx);
      }
      return undefined;
    default:
      return undefined;
  }
};

export const nominalSatisfies = (
  actual: TypeId,
  expected: TypeId,
  ctx: TypingContext,
  state: TypingState,
  seen: Set<TypeId> = new Set(),
): boolean => {
  if (actual === expected) {
    return true;
  }

  const actualDesc = ctx.arena.get(actual);
  const expectedDesc = ctx.arena.get(expected);
  if (
    actualDesc.kind === "nominal-object" &&
    expectedDesc.kind === "nominal-object" &&
    symbolRefEquals(actualDesc.owner, expectedDesc.owner)
  ) {
    if (expectedDesc.typeArgs.length === 0) {
      return true;
    }
    if (actualDesc.typeArgs.length !== expectedDesc.typeArgs.length) {
      return false;
    }
    return expectedDesc.typeArgs.every((expectedArg, index) => {
      if (expectedArg === ctx.primitives.unknown) {
        return true;
      }
      const result = unifyWithBudget({
        actual: actualDesc.typeArgs[index]!,
        expected: expectedArg,
        options: {
          location: ctx.hir.module.ast,
          reason: "type argument compatibility",
          variance: "covariant",
        },
        ctx,
      });
      if (result.ok) {
        return true;
      }
      if (
        state.mode === "relaxed" &&
        actualDesc.typeArgs[index] === ctx.primitives.unknown
      ) {
        return true;
      }
      if (state.mode === "relaxed") {
        return typeSatisfies(
          actualDesc.typeArgs[index]!,
          expectedArg,
          ctx,
          state,
        );
      }
      return false;
    });
  }

  if (seen.has(actual)) {
    return false;
  }
  seen.add(actual);

  const info = getObjectInfoForNominal(actual, ctx, state);
  if (info?.baseNominal) {
    return nominalSatisfies(info.baseNominal, expected, ctx, state, seen);
  }
  return false;
};

export const getStructuralFields = (
  type: TypeId,
  ctx: TypingContext,
  state: TypingState,
  options: { includeInaccessible?: boolean; allowOwnerPrivate?: boolean } = {},
): readonly StructuralField[] | undefined => {
  if (type === ctx.primitives.unknown) {
    return undefined;
  }

  const unfolded = unfoldRecursiveType(type, ctx);
  if (unfolded !== type) {
    return getStructuralFields(unfolded, ctx, state, options);
  }

  const desc = ctx.arena.get(unfolded);
  if (desc.kind === "structural-object") {
    ensureFieldsSubstituted(desc.fields, ctx, "structural object access");
    return options.includeInaccessible
      ? desc.fields
      : filterAccessibleFields(desc.fields, ctx, state, {
          allowOwnerPrivate: options.allowOwnerPrivate,
        });
  }

  if (desc.kind === "nominal-object") {
    const owner = localSymbolForSymbolRef(desc.owner, ctx);
    const info =
      typeof owner === "number"
        ? ensureObjectType(owner, ctx, state, desc.typeArgs)
        : undefined;
    if (info) {
      const fields = info.fields;
      return options.includeInaccessible
        ? fields
        : filterAccessibleFields(fields, ctx, state, {
            allowOwnerPrivate: options.allowOwnerPrivate,
          });
    }
    return undefined;
  }

  if (desc.kind === "intersection") {
    const merge = (
      base: readonly StructuralField[],
      extra: readonly StructuralField[],
    ): StructuralField[] => {
      if (extra.length === 0) {
        return [...base];
      }
      const byName = new Map<string, StructuralField>(
        base.map((field) => [field.name, field]),
      );
      extra.forEach((field) => {
        const existing = byName.get(field.name);
        if (!existing) {
          byName.set(field.name, field);
          return;
        }
        const optional =
          existing.optional === true && field.optional === true
            ? true
            : undefined;
        byName.set(field.name, {
          ...existing,
          optional,
          // preserve the base field's visibility/owner/packageId, so intersections never widen access.
          visibility: existing.visibility ?? field.visibility,
          owner: existing.owner ?? field.owner,
          packageId: existing.packageId ?? field.packageId,
        });
      });
      return Array.from(byName.values());
    };

    const structuralFields =
      typeof desc.structural === "number"
        ? getStructuralFields(desc.structural, ctx, state, {
            includeInaccessible: true,
            allowOwnerPrivate: true,
          })
        : undefined;

    const nominalInfo =
      typeof desc.nominal === "number"
        ? getObjectInfoForNominal(desc.nominal, ctx, state)
        : undefined;

    if (nominalInfo) {
      const fields = merge(nominalInfo.fields, structuralFields ?? []);
      return options.includeInaccessible
        ? fields
        : filterAccessibleFields(fields, ctx, state, {
            allowOwnerPrivate: options.allowOwnerPrivate,
          });
    }

    if (structuralFields) {
      return options.includeInaccessible
        ? structuralFields
        : filterAccessibleFields(structuralFields, ctx, state, {
            allowOwnerPrivate: options.allowOwnerPrivate,
          });
    }

    if (typeof desc.nominal === "number") {
      return getStructuralFields(desc.nominal, ctx, state, options);
    }
  }

  return undefined;
};

const structuralExpectationOf = (
  type: TypeId,
  ctx: TypingContext,
  state: TypingState,
): TypeId | undefined => {
  if (type === ctx.primitives.unknown) {
    return undefined;
  }

  const desc = ctx.arena.get(type);
  switch (desc.kind) {
    case "structural-object":
      ensureFieldsSubstituted(desc.fields, ctx, "structural comparison");
      return type;
    case "nominal-object": {
      const owner = localSymbolForSymbolRef(desc.owner, ctx);
      const info =
        typeof owner === "number"
          ? ensureObjectType(owner, ctx, state, desc.typeArgs)
          : undefined;
      if (info) {
        ensureFieldsSubstituted(info.fields, ctx, "structural comparison");
      }
      return info?.structural;
    }
    case "intersection":
      if (typeof desc.structural === "number") {
        return structuralExpectationOf(desc.structural, ctx, state);
      }
      if (typeof desc.nominal === "number") {
        return structuralExpectationOf(desc.nominal, ctx, state);
      }
      return undefined;
    default:
      return undefined;
  }
};

const functionTypeSatisfies = ({
  actual,
  expected,
  ctx,
  state,
}: {
  actual: TypeId;
  expected: TypeId;
  ctx: TypingContext;
  state: TypingState;
}): boolean => {
  const actualDesc = ctx.arena.get(actual);
  const expectedDesc = ctx.arena.get(expected);
  if (actualDesc.kind !== "function" || expectedDesc.kind !== "function") {
    return false;
  }

  if (actualDesc.parameters.length !== expectedDesc.parameters.length) {
    return false;
  }

  for (let index = 0; index < actualDesc.parameters.length; index += 1) {
    const actualParam = actualDesc.parameters[index]!;
    const expectedParam = expectedDesc.parameters[index]!;
    if (actualParam.optional !== expectedParam.optional) {
      return false;
    }
    if (!typeSatisfies(expectedParam.type, actualParam.type, ctx, state)) {
      return false;
    }
  }

  if (!typeSatisfies(actualDesc.returnType, expectedDesc.returnType, ctx, state)) {
    return false;
  }

  return ctx.effects.constrain(actualDesc.effectRow, expectedDesc.effectRow, {
    location: ctx.hir.module.ast,
    reason: "function type effect compatibility",
  }).ok;
};

// Satisfaction layers nominal gates over structural comparison and unification:
// unknown short-circuits according to mode, structural expectations normalize through the arena, and nominal expectations gate structural fallbacks.
export const typeSatisfies = (
  actual: TypeId,
  expected: TypeId,
  ctx: TypingContext,
  state: TypingState,
): boolean => {
  const activeConstraints = currentFunctionConstraintMap(ctx, state);
  if (actual === expected) {
    return true;
  }

  if (
    state.mode === "relaxed" &&
    (actual === ctx.primitives.unknown || expected === ctx.primitives.unknown)
  ) {
    return true;
  }

  if (
    state.mode === "strict" &&
    (actual === ctx.primitives.unknown || expected === ctx.primitives.unknown)
  ) {
    return false;
  }

  const expectedDesc = ctx.arena.get(expected);
  if (expectedDesc.kind === "function") {
    return functionTypeSatisfies({ actual, expected, ctx, state });
  }

  if (expectedDesc.kind === "trait") {
    const owner = localSymbolForSymbolRef(expectedDesc.owner, ctx);
    return traitSatisfies(
      actual,
      expected,
      owner,
      ctx,
      state,
      activeConstraints,
    );
  }
  if (
    expectedDesc.kind === "intersection" &&
    expectedDesc.traits &&
    expectedDesc.traits.length > 0
  ) {
    const ok = expectedDesc.traits.every((trait) => {
      const traitDesc = ctx.arena.get(trait);
      if (traitDesc.kind !== "trait") {
        return false;
      }
      const owner = localSymbolForSymbolRef(traitDesc.owner, ctx);
      return traitSatisfies(
        actual,
        trait,
        owner,
        ctx,
        state,
        activeConstraints,
      );
    });
    if (!ok) {
      return false;
    }
    const stripped = ctx.arena.internIntersection({
      nominal: expectedDesc.nominal,
      structural: expectedDesc.structural,
    });
    return typeSatisfies(actual, stripped, ctx, state);
  }

  const optionalInfo = getOptionalInfo(
    expected,
    optionalResolverContextForTypingContext(ctx),
  );
  if (
    optionalInfo &&
    typeSatisfies(actual, optionalInfo.innerType, ctx, state)
  ) {
    return true;
  }

  const forceNominalUnion =
    expectedDesc.kind === "union" &&
    expectedDesc.members.every(
      (member) => typeof getNominalComponent(member, ctx) === "number",
    );
  const expectedNominal = getNominalComponent(expected, ctx);
  let nominalMatches = false;
  if (expectedNominal) {
    const actualNominal = getNominalComponent(actual, ctx);
    nominalMatches =
      typeof actualNominal === "number" &&
      nominalSatisfies(actualNominal, expectedNominal, ctx, state);
    if (!nominalMatches && expectedNominal !== ctx.objects.base.nominal) {
      return false;
    }
  }

  const structuralComparisonEligible =
    !forceNominalUnion &&
    (!expectedNominal ||
      nominalMatches ||
      expectedNominal === ctx.objects.base.nominal);
  const allowUnknown = state.mode === "relaxed";
  const structuralResolver = structuralComparisonEligible
    ? (type: TypeId): TypeId | undefined =>
        structuralExpectationOf(type, ctx, state)
    : undefined;

  const compatibility = unifyWithBudget({
    actual,
    expected,
    options: {
      location: ctx.hir.module.ast,
      reason: "type satisfaction",
      variance: "covariant",
      structuralResolver,
      allowUnknown,
    },
    ctx,
  });
  return compatibility.ok;
};

const currentFunctionConstraintMap = (
  ctx: TypingContext,
  state: TypingState,
): ReadonlyMap<TypeParamId, TypeId> | undefined => {
  const current = state.currentFunction;
  const functionSymbol = current?.functionSymbol;
  if (typeof functionSymbol !== "number") {
    return undefined;
  }

  const signature = ctx.functions.getSignature(functionSymbol);
  const typeParams = signature?.typeParams;
  if (!typeParams || typeParams.length === 0) {
    return undefined;
  }

  const substitution = current?.substitution;
  const out = new Map<TypeParamId, TypeId>();
  typeParams.forEach((param) => {
    if (!param.constraint) {
      return;
    }
    const resolved = substitution
      ? ctx.arena.substitute(param.constraint, substitution)
      : param.constraint;
    out.set(param.typeParam, resolved);
  });

  return out.size > 0 ? out : undefined;
};

const traitSatisfies = (
  actual: TypeId,
  expected: TypeId,
  traitSymbol: SymbolId | undefined,
  ctx: TypingContext,
  state: TypingState,
  activeConstraints?: ReadonlyMap<TypeParamId, TypeId>,
): boolean => {
  const allowUnknown = state.mode === "relaxed";
  const expectedDesc = ctx.arena.get(expected);
  const actualDesc = ctx.arena.get(actual);
  if (actualDesc.kind === "type-param-ref") {
    const constraint = activeConstraints?.get(actualDesc.param);
    if (
      typeof constraint === "number" &&
      typeSatisfies(constraint, expected, ctx, state)
    ) {
      return true;
    }
  }
  if (actualDesc.kind === "intersection" && actualDesc.traits) {
    const allowUnknown = state.mode === "relaxed";
    const matches = actualDesc.traits.some(
      (trait) =>
        unifyWithBudget({
          actual: trait,
          expected,
          options: {
            location: ctx.hir.module.ast,
            reason: "trait compatibility",
            variance: "covariant",
            allowUnknown,
          },
          ctx,
        }).ok,
    );
    if (matches) {
      return true;
    }
  }
  if (actualDesc.kind === "trait" && expectedDesc.kind === "trait") {
    const match = unifyWithBudget({
      actual,
      expected,
      options: {
        location: ctx.hir.module.ast,
        reason: "trait compatibility",
        variance: "covariant",
        allowUnknown,
      },
      ctx,
    });
    return match.ok;
  }

  const actualNominal = getNominalComponent(actual, ctx);
  if (typeof actualNominal !== "number") {
    return false;
  }

  const info = getObjectInfoForNominal(actualNominal, ctx, state);
  let impls = ctx.traitImplsByNominal.get(actualNominal) ?? info?.traitImpls;
  if (!impls || impls.length === 0) {
    hydrateImportedTraitMetadataForNominal({ nominal: actualNominal, ctx });
    impls = instantiateTraitImplsFor({
      nominal: actualNominal,
      ctx,
      state,
    });
  }
  impls ??= [];
  return impls.some((impl) => {
    const traitMatches =
      typeof traitSymbol === "number"
        ? impl.traitSymbol === traitSymbol
        : (() => {
            const implTraitDesc = ctx.arena.get(impl.trait);
            return (
              implTraitDesc.kind === "trait" &&
              expectedDesc.kind === "trait" &&
              symbolRefEquals(implTraitDesc.owner, expectedDesc.owner)
            );
          })();
    if (!traitMatches) {
      return false;
    }
    const comparison = unifyWithBudget({
      actual: impl.trait,
      expected,
      options: {
        location: ctx.hir.module.ast,
        reason: "trait compatibility",
        variance: "covariant",
        allowUnknown,
      },
      ctx,
    });
    return comparison.ok;
  });
};

// TODO: Deprecate reason and convert args to object
export const ensureTypeMatches = (
  actual: TypeId,
  expected: TypeId,
  ctx: TypingContext,
  state: TypingState,
  _reason: string,
  span?: SourceSpan,
): void => {
  if (typeSatisfies(actual, expected, ctx, state)) {
    return;
  }

  emitDiagnostic({
    ctx,
    code: "TY0027",
    params: {
      kind: "type-mismatch",
      actual: typeDescriptorToUserString(ctx.arena.get(actual), ctx.arena),
      expected: typeDescriptorToUserString(ctx.arena.get(expected), ctx.arena),
    },
    span: span ?? ctx.hir.module.span,
  });
};

const nominalInstantiationMatches = (
  candidate: TypeId,
  expected: TypeId,
  ctx: TypingContext,
  state: TypingState,
): boolean => {
  const seen = new Set<TypeId>();
  let current: TypeId | undefined = candidate;
  while (typeof current === "number" && !seen.has(current)) {
    if (current === expected) {
      return true;
    }

    const currentDesc = ctx.arena.get(current);
    const expectedDesc = ctx.arena.get(expected);
    if (
      currentDesc.kind === "nominal-object" &&
      expectedDesc.kind === "nominal-object" &&
      symbolRefEquals(currentDesc.owner, expectedDesc.owner) &&
      currentDesc.typeArgs.length === expectedDesc.typeArgs.length &&
      !currentDesc.typeArgs.some((arg) => containsUnknownType(arg, ctx)) &&
      !expectedDesc.typeArgs.some((arg) => containsUnknownType(arg, ctx))
    ) {
      const compatibleArgs = currentDesc.typeArgs.every((arg, index) => {
        const comparison = unifyWithBudget({
          actual: arg,
          expected: expectedDesc.typeArgs[index]!,
          options: {
            location: ctx.hir.module.ast,
            reason: "nominal instantiation comparison",
            variance: "invariant",
          },
          ctx,
        });
        return comparison.ok;
      });
      if (compatibleArgs) {
        return true;
      }
    }

    seen.add(current);
    const info = getObjectInfoForNominal(current, ctx, state);
    current = info?.baseNominal;
  }
  return false;
};

const unionMemberMatchesPattern = (
  member: TypeId,
  patternType: TypeId,
  ctx: TypingContext,
  state: TypingState,
): boolean => {
  const patternNominal = getNominalComponent(patternType, ctx);
  const memberNominal = getNominalComponent(member, ctx);
  if (typeof patternNominal === "number" && typeof memberNominal === "number") {
    return nominalInstantiationMatches(
      memberNominal,
      patternNominal,
      ctx,
      state,
    );
  }
  return typeSatisfies(member, patternType, ctx, state);
};

export const matchedUnionMembers = (
  patternType: TypeId,
  remaining: Set<TypeId>,
  ctx: TypingContext,
  state: TypingState,
): TypeId[] => {
  if (patternType === ctx.primitives.unknown) {
    return [];
  }
  return Array.from(remaining).filter((member) =>
    unionMemberMatchesPattern(member, patternType, ctx, state),
  );
};

export const narrowTypeForPattern = (
  discriminantType: TypeId,
  patternType: TypeId,
  ctx: TypingContext,
  state: TypingState,
): TypeId | undefined => {
  if (discriminantType === ctx.primitives.unknown) {
    return patternType;
  }
  const desc = ctx.arena.get(discriminantType);
  if (desc.kind === "union") {
    const matches = desc.members.filter((member) =>
      unionMemberMatchesPattern(member, patternType, ctx, state),
    );
    if (matches.length === 0) {
      return undefined;
    }
    return matches.length === 1 ? matches[0] : ctx.arena.internUnion(matches);
  }
  return unionMemberMatchesPattern(discriminantType, patternType, ctx, state)
    ? discriminantType
    : undefined;
};

type BindTypeParamsArgs = {
  actual: TypeId;
  expectedDesc: TypeDescriptor;
  bindings: Map<TypeParamId, TypeId>;
  ctx: TypingContext;
  state: TypingState;
};

type BindTypeParamsHandler = (args: BindTypeParamsArgs) => void;

const applyBindingUpdates = ({
  bindings,
  nextBindings,
}: {
  bindings: Map<TypeParamId, TypeId>;
  nextBindings: ReadonlyMap<TypeParamId, TypeId>;
}): void => {
  bindings.clear();
  nextBindings.forEach((value, key) => {
    bindings.set(key, value);
  });
};

const bindTypeParamRef = ({
  actual,
  expectedDesc,
  bindings,
  ctx,
  state,
}: BindTypeParamsArgs): void => {
  if (expectedDesc.kind !== "type-param-ref") {
    return;
  }

  const existing = bindings.get(expectedDesc.param);
  if (!existing) {
    bindings.set(expectedDesc.param, actual);
    return;
  }
  if (typeSatisfies(actual, existing, ctx, state)) {
    return;
  }
  if (typeSatisfies(existing, actual, ctx, state)) {
    bindings.set(expectedDesc.param, actual);
  }
};

const bindNominalObject = ({
  actual,
  expectedDesc,
  bindings,
  ctx,
  state,
}: BindTypeParamsArgs): void => {
  if (expectedDesc.kind !== "nominal-object") {
    return;
  }

  const actualNominal = getNominalComponent(actual, ctx);
  if (typeof actualNominal !== "number") {
    return;
  }
  const actualDesc = ctx.arena.get(actualNominal);
  if (
    actualDesc.kind !== "nominal-object" ||
    !symbolRefEquals(actualDesc.owner, expectedDesc.owner)
  ) {
    return;
  }
  expectedDesc.typeArgs.forEach((typeArg, index) => {
    const actualArg = actualDesc.typeArgs[index];
    if (typeof actualArg === "number") {
      bindTypeParamsFromType(typeArg, actualArg, bindings, ctx, state);
    }
  });
};

const bindStructuralObject = ({
  actual,
  expectedDesc,
  bindings,
  ctx,
  state,
}: BindTypeParamsArgs): void => {
  if (expectedDesc.kind !== "structural-object") {
    return;
  }

  const actualFields = getStructuralFields(actual, ctx, state);
  if (!actualFields) {
    return;
  }
  expectedDesc.fields.forEach((field) => {
    const candidate = actualFields.find((entry) => entry.name === field.name);
    if (candidate) {
      bindTypeParamsFromType(field.type, candidate.type, bindings, ctx, state);
    }
  });
};

const bindFixedArray = ({
  actual,
  expectedDesc,
  bindings,
  ctx,
  state,
}: BindTypeParamsArgs): void => {
  if (expectedDesc.kind !== "fixed-array") {
    return;
  }

  const actualDesc = ctx.arena.get(actual);
  if (actualDesc.kind !== "fixed-array") {
    return;
  }
  bindTypeParamsFromType(
    expectedDesc.element,
    actualDesc.element,
    bindings,
    ctx,
    state,
  );
};

const bindFunction = ({
  actual,
  expectedDesc,
  bindings,
  ctx,
  state,
}: BindTypeParamsArgs): void => {
  if (expectedDesc.kind !== "function") {
    return;
  }

  const actualDesc = ctx.arena.get(actual);
  if (actualDesc.kind !== "function") {
    return;
  }

  const count = Math.min(
    expectedDesc.parameters.length,
    actualDesc.parameters.length,
  );
  for (let index = 0; index < count; index += 1) {
    bindTypeParamsFromType(
      expectedDesc.parameters[index]!.type,
      actualDesc.parameters[index]!.type,
      bindings,
      ctx,
      state,
    );
  }

  bindTypeParamsFromType(
    expectedDesc.returnType,
    actualDesc.returnType,
    bindings,
    ctx,
    state,
  );
};

const bindUnion = ({
  actual,
  expectedDesc,
  bindings,
  ctx,
  state,
}: BindTypeParamsArgs): void => {
  if (expectedDesc.kind !== "union") {
    return;
  }
  if (!expectedDesc.members.some((member) => containsAnyTypeParam(member, ctx))) {
    return;
  }

  const nextBindings = bindTypeParamsFromUnion({
    expectedMembers: expectedDesc.members,
    actual,
    bindings,
    ctx,
    state,
  });
  if (!nextBindings) {
    return;
  }
  applyBindingUpdates({ bindings, nextBindings });
};

const bindIntersection = ({
  actual,
  expectedDesc,
  bindings,
  ctx,
  state,
}: BindTypeParamsArgs): void => {
  if (expectedDesc.kind !== "intersection") {
    return;
  }

  if (typeof expectedDesc.nominal === "number") {
    bindTypeParamsFromType(expectedDesc.nominal, actual, bindings, ctx, state);
  }
  if (typeof expectedDesc.structural === "number") {
    bindTypeParamsFromType(expectedDesc.structural, actual, bindings, ctx, state);
  }
};

const bindTypeParamsHandlers: Partial<
  Record<TypeDescriptor["kind"], BindTypeParamsHandler>
> = {
  "type-param-ref": bindTypeParamRef,
  "nominal-object": bindNominalObject,
  "structural-object": bindStructuralObject,
  "fixed-array": bindFixedArray,
  function: bindFunction,
  union: bindUnion,
  intersection: bindIntersection,
};

export const bindTypeParamsFromType = (
  expected: TypeId,
  actual: TypeId,
  bindings: Map<TypeParamId, TypeId>,
  ctx: TypingContext,
  state: TypingState,
): void => {
  if (
    expected === ctx.primitives.unknown ||
    actual === ctx.primitives.unknown
  ) {
    return;
  }

  const expectedDesc = ctx.arena.get(expected);
  const handler = bindTypeParamsHandlers[expectedDesc.kind];
  if (!handler) {
    return;
  }

  handler({ actual, expectedDesc, bindings, ctx, state });
};

const bindTypeParamsFromUnion = ({
  expectedMembers,
  actual,
  bindings,
  ctx,
  state,
}: {
  expectedMembers: readonly TypeId[];
  actual: TypeId;
  bindings: ReadonlyMap<TypeParamId, TypeId>;
  ctx: TypingContext;
  state: TypingState;
}): Map<TypeParamId, TypeId> | undefined => {
  const actualDesc = ctx.arena.get(actual);
  if (actualDesc.kind !== "union") {
    return undefined;
  }

  const bareTypeParamMembers = expectedMembers.filter((member) => {
    const desc = ctx.arena.get(member);
    return desc.kind === "type-param-ref";
  });
  if (bareTypeParamMembers.length > 1) {
    return undefined;
  }

  const remainderTarget = bareTypeParamMembers[0];
  const remainderParam =
    typeof remainderTarget === "number"
      ? (() => {
          const desc = ctx.arena.get(remainderTarget);
          return desc.kind === "type-param-ref" ? desc.param : undefined;
        })()
      : undefined;
  const subsetMembers =
    typeof remainderTarget === "number"
      ? expectedMembers.filter((member) => member !== remainderTarget)
      : expectedMembers;

  const candidates = findUnionBindingCandidates({
    expectedMembers: subsetMembers,
    actualMembers: actualDesc.members,
    bindings,
    ctx,
    state,
  });
  if (candidates.length === 0) {
    return undefined;
  }
  const maxCoverage = candidates.reduce((max, candidate) => {
    const coverage = actualDesc.members.length - candidate.remainingActualMembers.length;
    return coverage > max ? coverage : max;
  }, 0);
  const filteredCandidates = candidates.filter(
    (candidate) =>
      actualDesc.members.length - candidate.remainingActualMembers.length === maxCoverage,
  );

  const solutionsByKey = new Map<string, Map<TypeParamId, TypeId>>();
  filteredCandidates.forEach((candidate) => {
    const nextBindings = new Map(candidate.bindings);
    if (typeof remainderTarget === "number" && typeof remainderParam === "number") {
      const remainder = candidate.remainingActualMembers;
      if (remainder.length === 0) {
        return;
      }

      const existingBinding = nextBindings.get(remainderParam);
      if (typeof existingBinding === "number") {
        const hasCompatibleRemainder = remainder.some(
          (member) =>
            typeSatisfies(member, existingBinding, ctx, state) ||
            typeSatisfies(existingBinding, member, ctx, state),
        );
        if (!hasCompatibleRemainder) {
          return;
        }
      } else {
        const remainderType =
          remainder.length === 1 ? remainder[0]! : ctx.arena.internUnion(remainder);
        bindTypeParamsFromType(
          remainderTarget,
          remainderType,
          nextBindings,
          ctx,
          state,
        );
        const substitutedTarget = ctx.arena.substitute(remainderTarget, nextBindings);
        if (
          !typeSatisfies(remainderType, substitutedTarget, ctx, state) &&
          !typeSatisfies(substitutedTarget, remainderType, ctx, state)
        ) {
          return;
        }
      }
    } else if (typeof remainderTarget === "number") {
      // Should not happen: remainder target candidates are limited to bare type-param members.
      if (candidate.remainingActualMembers.length === 0) {
        return;
      }
    }
    solutionsByKey.set(serializeTypeParamBindings(nextBindings), nextBindings);
  });

  if (solutionsByKey.size !== 1) {
    return undefined;
  }

  return [...solutionsByKey.values()][0];
};

type UnionBindingCandidate = {
  bindings: Map<TypeParamId, TypeId>;
  remainingActualMembers: readonly TypeId[];
};

const MAX_UNION_BINDING_SEARCH_STATES = 4_096;

const findUnionBindingCandidates = ({
  expectedMembers,
  actualMembers,
  bindings,
  ctx,
  state,
}: {
  expectedMembers: readonly TypeId[];
  actualMembers: readonly TypeId[];
  bindings: ReadonlyMap<TypeParamId, TypeId>;
  ctx: TypingContext;
  state: TypingState;
}): UnionBindingCandidate[] => {
  const solutions: UnionBindingCandidate[] = [];
  const visitedStates = new Set<string>();
  let abortedForComplexity = false;
  const unresolvedExpected = [...expectedMembers];

  const search = ({
    expected,
    currentBindings,
    usedActualIndices,
  }: {
    expected: readonly TypeId[];
    currentBindings: ReadonlyMap<TypeParamId, TypeId>;
    usedActualIndices: ReadonlySet<number>;
  }): void => {
    if (abortedForComplexity) {
      return;
    }
    const stateKey = serializeUnionBindingSearchState({
      expected,
      usedActualIndices,
      bindings: currentBindings,
    });
    if (visitedStates.has(stateKey)) {
      return;
    }
    visitedStates.add(stateKey);
    if (visitedStates.size > MAX_UNION_BINDING_SEARCH_STATES) {
      abortedForComplexity = true;
      return;
    }

    if (expected.length === 0) {
      const snapshot = new Map(currentBindings);
      solutions.push({
        bindings: snapshot,
        remainingActualMembers: actualMembers.filter(
          (_, index) => !usedActualIndices.has(index),
        ),
      });
      return;
    }

    const options = expected
      .map((expectedMember, expectedIndex) => {
        if (typeof expectedMember !== "number") {
          return undefined;
        }
        const matches = actualMembers.flatMap((actualMember, actualIndex) => {
          const candidate = tryBindExpectedMember({
            expectedMember,
            actualMember,
            bindings: currentBindings,
            ctx,
            state,
          });
          return candidate ? [{ actualIndex, bindings: candidate }] : [];
        });
        return { expectedIndex, matches };
      })
      .filter(
        (
          option,
        ): option is {
          expectedIndex: number;
          matches: { actualIndex: number; bindings: Map<TypeParamId, TypeId> }[];
        } => Boolean(option),
      )
      .sort((left, right) => left.matches.length - right.matches.length);

    const next = options[0];
    if (!next) {
      return;
    }
    if (next.matches.length === 0) {
      return;
    }
    const nextExpected = expected.filter((_, index) => index !== next.expectedIndex);

    next.matches.forEach((match) => {
      const nextUsedActualIndices = new Set(usedActualIndices);
      nextUsedActualIndices.add(match.actualIndex);
      search({
        expected: nextExpected,
        currentBindings: match.bindings,
        usedActualIndices: nextUsedActualIndices,
      });
    });
  };

  search({
    expected: unresolvedExpected,
    currentBindings: bindings,
    usedActualIndices: new Set<number>(),
  });

  if (abortedForComplexity) {
    return [];
  }

  return solutions;
};

const serializeUnionBindingSearchState = ({
  expected,
  usedActualIndices,
  bindings,
}: {
  expected: readonly TypeId[];
  usedActualIndices: ReadonlySet<number>;
  bindings: ReadonlyMap<TypeParamId, TypeId>;
}): string =>
  [
    expected
      .slice()
      .sort((left, right) => left - right)
      .join(","),
    [...usedActualIndices]
      .sort((left, right) => left - right)
      .join(","),
    serializeTypeParamBindings(bindings),
  ].join("|");

const serializeTypeParamBindings = (
  bindings: ReadonlyMap<TypeParamId, TypeId>,
): string =>
  [...bindings.entries()]
    .sort(([left], [right]) => left - right)
    .map(([param, type]) => `${param}:${type}`)
    .join(",");

const tryBindExpectedMember = ({
  expectedMember,
  actualMember,
  bindings,
  ctx,
  state,
}: {
  expectedMember: TypeId;
  actualMember: TypeId;
  bindings: ReadonlyMap<TypeParamId, TypeId>;
  ctx: TypingContext;
  state: TypingState;
}): Map<TypeParamId, TypeId> | undefined => {
  const candidateBindings = new Map(bindings);
  bindTypeParamsFromType(
    expectedMember,
    actualMember,
    candidateBindings,
    ctx,
    state,
  );
  const substitutedExpected = ctx.arena.substitute(expectedMember, candidateBindings);
  if (
    !typeSatisfies(actualMember, substitutedExpected, ctx, state) &&
    !typeSatisfies(substitutedExpected, actualMember, ctx, state)
  ) {
    return undefined;
  }
  return candidateBindings;
};
