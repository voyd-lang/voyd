import type {
  HirObjectTypeExpr,
  HirTypeExpr,
  HirNamedTypeExpr,
  HirTupleTypeExpr,
  HirUnionTypeExpr,
} from "../hir/index.js";
import type { SymbolId, TypeId, TypeParamId } from "../ids.js";
import type { StructuralField } from "./type-arena.js";
import {
  BASE_OBJECT_NAME,
  type TypingContext,
  type ObjectTemplate,
  type ObjectTypeInfo,
  type TypingState,
} from "./types.js";
import {
  normalizeTypeArgs,
  shouldCacheInstantiation,
} from "../../types/instantiation.js";

const paramsReferencedInType = (
  type: TypeId,
  allowed: ReadonlySet<TypeParamId>,
  ctx: TypingContext,
  seen: Set<TypeId> = new Set()
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
          acc.add(entry)
        );
        return acc;
      }, new Set<TypeParamId>());
    }
    case "structural-object":
      return desc.fields.reduce((acc, field) => {
        paramsReferencedInType(field.type, allowed, ctx, seen).forEach(
          (entry) => acc.add(entry)
        );
        return acc;
      }, new Set<TypeParamId>());
    case "function": {
      const acc = new Set<TypeParamId>();
      desc.parameters.forEach((param) =>
        paramsReferencedInType(param.type, allowed, ctx, seen).forEach(
          (entry) => acc.add(entry)
        )
      );
      paramsReferencedInType(desc.returnType, allowed, ctx, seen).forEach(
        (entry) => acc.add(entry)
      );
      return acc;
    }
    case "union":
      return desc.members.reduce((acc, member) => {
        paramsReferencedInType(member, allowed, ctx, seen).forEach((entry) =>
          acc.add(entry)
        );
        return acc;
      }, new Set<TypeParamId>());
    case "intersection": {
      const acc = new Set<TypeParamId>();
      if (typeof desc.nominal === "number") {
        paramsReferencedInType(desc.nominal, allowed, ctx, seen).forEach(
          (entry) => acc.add(entry)
        );
      }
      if (typeof desc.structural === "number") {
        paramsReferencedInType(desc.structural, allowed, ctx, seen).forEach(
          (entry) => acc.add(entry)
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
  ctx: TypingContext
): readonly TypeParamId[] | undefined => {
  const referenced = paramsReferencedInType(type, allowed, ctx);
  return referenced.size > 0
    ? Array.from(referenced).sort((a, b) => a - b)
    : undefined;
};

const paramIdSetFrom = (
  params: ReadonlyMap<SymbolId, TypeId> | undefined,
  ctx: TypingContext
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
  seen: Set<TypeId> = new Set()
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
    case "trait":
    case "nominal-object":
      return desc.typeArgs.some((arg) => containsUnknownType(arg, ctx, seen));
    case "structural-object":
      return desc.fields.some((field) =>
        containsUnknownType(field.type, ctx, seen)
      );
    case "function":
      return (
        desc.parameters.some((param) =>
          containsUnknownType(param.type, ctx, seen)
        ) || containsUnknownType(desc.returnType, ctx, seen)
      );
    case "union":
      return desc.members.some((member) =>
        containsUnknownType(member, ctx, seen)
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
  seen: Set<TypeId> = new Set()
): boolean => {
  if (seen.has(type)) {
    return false;
  }
  seen.add(type);

  const desc = ctx.arena.get(type);
  switch (desc.kind) {
    case "type-param-ref":
      return desc.param === param;
    case "trait":
    case "nominal-object":
      return desc.typeArgs.some((arg) =>
        containsTypeParam(arg, param, ctx, seen)
      );
    case "structural-object":
      return desc.fields.some((field) =>
        containsTypeParam(field.type, param, ctx, seen)
      );
    case "function":
      return (
        desc.parameters.some((paramDesc) =>
          containsTypeParam(paramDesc.type, param, ctx, seen)
        ) || containsTypeParam(desc.returnType, param, ctx, seen)
      );
    case "union":
      return desc.members.some((member) =>
        containsTypeParam(member, param, ctx, seen)
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

const containsAliasSelfUnguarded = (
  type: TypeId,
  aliasSymbol: SymbolId,
  aliasRoot: TypeId,
  ctx: TypingContext,
  guarded: boolean,
  seen: Set<string> = new Set(),
  isRoot = false
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
    case "trait":
      return desc.typeArgs.some((arg) =>
        containsAliasSelfUnguarded(arg, aliasSymbol, aliasRoot, ctx, true, seen)
      );
    case "nominal-object":
      return desc.typeArgs.some((arg) =>
        containsAliasSelfUnguarded(arg, aliasSymbol, aliasRoot, ctx, true, seen)
      );
    case "structural-object":
      return desc.fields.some((field) =>
        containsAliasSelfUnguarded(
          field.type,
          aliasSymbol,
          aliasRoot,
          ctx,
          true,
          seen
        )
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
            seen
          )
        ) ||
        containsAliasSelfUnguarded(
          desc.returnType,
          aliasSymbol,
          aliasRoot,
          ctx,
          guarded,
          seen
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
          seen
        )
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
            seen
          )) ||
        (typeof desc.structural === "number" &&
          containsAliasSelfUnguarded(
            desc.structural,
            aliasSymbol,
            aliasRoot,
            ctx,
            guarded,
            seen
          ))
      );
    case "fixed-array":
      return containsAliasSelfUnguarded(
        desc.element,
        aliasSymbol,
        aliasRoot,
        ctx,
        true,
        seen
      );
    default:
      return false;
  }
};

const recordAliasInstanceSymbol = (
  type: TypeId,
  symbol: SymbolId,
  ctx: TypingContext
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
  if (
    containsAliasSelfUnguarded(
      type,
      aliasSymbol,
      type,
      ctx,
      false,
      undefined,
      true
    )
  ) {
    throw new Error(`type alias ${aliasName} is not contractive`);
  }
};

const ensureFieldsSubstituted = (
  fields: readonly StructuralField[],
  ctx: TypingContext,
  context: string
): void => {
  fields.forEach((field) => {
    if (!field.declaringParams?.length) {
      return;
    }
    const remaining = paramsReferencedInType(
      field.type,
      new Set(field.declaringParams),
      ctx
    );
    if (remaining.size > 0) {
      throw new Error(
        `${context} is missing substitutions for field ${field.name}`
      );
    }
  });
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

export const resolveTypeExpr = (
  expr: HirTypeExpr | undefined,
  ctx: TypingContext,
  state: TypingState,
  fallback: TypeId,
  typeParams?: ReadonlyMap<SymbolId, TypeId>
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
    case "union":
      resolved = resolveUnionTypeExpr(expr, ctx, state, activeTypeParams);
      break;
    default:
      throw new Error(`unsupported type expression kind: ${expr.typeKind}`);
  }
  expr.typeId = resolved;
  return resolved;
};

const makeTypeAliasInstanceKey = (
  symbol: SymbolId,
  typeArgs: readonly TypeId[]
): string => `${symbol}<${typeArgs.join(",")}>`;

export const resolveTypeAlias = (
  symbol: SymbolId,
  ctx: TypingContext,
  state: TypingState,
  typeArgs: readonly TypeId[] = []
): TypeId => {
  const aliasName = getSymbolName(symbol, ctx);
  const template = ctx.typeAliases.getTemplate(symbol);

  if (!template) {
    throw new Error(`missing type alias target for ${aliasName}`);
  }

  const normalized = normalizeTypeArgs({
    typeArgs,
    paramCount: template.params.length,
    unknownType: ctx.primitives.unknown,
    context: `type alias ${aliasName}`,
  });

  if (normalized.missingCount > 0) {
    throw new Error(
      `type alias ${aliasName} is missing ${normalized.missingCount} type argument(s)`
    );
  }

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
  let placeholderParam: TypeParamId | undefined;
  try {
    resolved = ctx.arena.createRecursiveType((self, placeholder) => {
      placeholderParam = placeholder;
      ctx.typeAliases.beginResolution(key, self);

      const paramMap = new Map<SymbolId, TypeId>();
      template.params.forEach((param, index) =>
        paramMap.set(
          param.symbol,
          normalized.applied[index] ?? ctx.primitives.unknown
        )
      );

      template.params.forEach((param, index) => {
        if (!param.constraint) {
          return;
        }
        const applied = normalized.applied[index] ?? ctx.primitives.unknown;
        if (applied === ctx.primitives.unknown) {
          return;
        }
        const resolvedConstraint = resolveTypeExpr(
          param.constraint,
          ctx,
          state,
          ctx.primitives.unknown,
          paramMap
        );
        if (!typeSatisfies(applied, resolvedConstraint, ctx, state)) {
          throw new Error(
            `type argument for ${getSymbolName(
              param.symbol,
              ctx
            )} does not satisfy constraint for type alias ${getSymbolName(
              symbol,
              ctx
            )}`
          );
        }
      });

      const targetType = resolveTypeExpr(
        template.target,
        ctx,
        state,
        ctx.primitives.unknown,
        paramMap
      );
      if (targetType === self) {
        throw new Error(`type alias ${aliasName} cannot resolve to itself`);
      }
      if (containsUnknownType(targetType, ctx)) {
        throw new Error(`type alias ${aliasName} could not be fully resolved`);
      }
      return ctx.arena.get(targetType);
    });

    if (
      typeof placeholderParam === "number" &&
      containsTypeParam(resolved, placeholderParam, ctx)
    ) {
      throw new Error("cyclic type alias instantiation");
    }

    assertAliasContractive({
      type: resolved,
      aliasSymbol: symbol,
      aliasName,
      ctx,
    });

    const canCacheNow = cacheable && ctx.typeAliases.resolutionDepth() === 1;
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
  typeParams?: ReadonlyMap<SymbolId, TypeId>
): TypeId => {
  if (expr.path.length !== 1) {
    throw new Error("qualified type paths are not supported yet");
  }

  const name = expr.path[0]!;
  const resolvedTypeArgs =
    expr.typeArguments?.map((arg) =>
      resolveTypeExpr(arg, ctx, state, ctx.primitives.unknown, typeParams)
    ) ?? [];

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

  if (
    typeof activeAlias === "number" &&
    typeof aliasInstanceKey === "string" &&
    activeAliasKey !== undefined &&
    activeAliasKey !== aliasInstanceKey
  ) {
    const activeDesc = ctx.arena.get(activeAlias);
    if (activeDesc.kind === "type-param-ref") {
      throw new Error("cyclic type alias instantiation");
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

  const resolved = ctx.primitives.cache.get(name);
  if (typeof resolved === "number") {
    return resolved;
  }

  return getPrimitiveType(ctx, name);
};

const findTypeParamByName = (
  name: string,
  typeParams: ReadonlyMap<SymbolId, TypeId> | undefined,
  ctx: TypingContext
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
  typeParams?: ReadonlyMap<SymbolId, TypeId>
): TypeId => {
  const allowedParams = paramIdSetFrom(typeParams, ctx);
  const fields = expr.fields.map((field) => {
    const type = resolveTypeExpr(
      field.type,
      ctx,
      state,
      ctx.primitives.unknown,
      typeParams
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

const resolveTupleTypeExpr = (
  expr: HirTupleTypeExpr,
  ctx: TypingContext,
  state: TypingState,
  typeParams?: ReadonlyMap<SymbolId, TypeId>
): TypeId => {
  const allowedParams = paramIdSetFrom(typeParams, ctx);
  const fields = expr.elements.map((element, index) => {
    const type = resolveTypeExpr(
      element,
      ctx,
      state,
      ctx.primitives.unknown,
      typeParams
    );
    return {
      name: `${index}`,
      type,
      declaringParams: allowedParams
        ? declaringParamsForField(type, allowedParams, ctx)
        : undefined,
    };
  });
  return ctx.arena.internStructuralObject({ fields });
};

const resolveUnionTypeExpr = (
  expr: HirUnionTypeExpr,
  ctx: TypingContext,
  state: TypingState,
  typeParams?: ReadonlyMap<SymbolId, TypeId>
): TypeId => {
  const members = expr.members.map((member) =>
    resolveTypeExpr(member, ctx, state, ctx.primitives.unknown, typeParams)
  );
  return ctx.arena.internUnion(members);
};

export const getSymbolName = (symbol: SymbolId, ctx: TypingContext): string =>
  ctx.symbolTable.getSymbol(symbol).name;

const makeObjectInstanceKey = (
  symbol: SymbolId,
  typeArgs: readonly TypeId[]
): string => `${symbol}<${typeArgs.join(",")}>`;

export const getObjectTemplate = (
  symbol: SymbolId,
  ctx: TypingContext,
  state: TypingState
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
          paramMap
        );
      }
    });

    const templateParams = new Set(params.map((param) => param.typeParam));

    const baseType = resolveTypeExpr(
      decl.base,
      ctx,
      state,
      ctx.objects.base.type,
      paramMap
    );
    const baseFields = (getStructuralFields(baseType, ctx, state) ?? []).map(
      (field) => ({
        ...field,
        declaringParams: declaringParamsForField(
          field.type,
          templateParams,
          ctx
        ),
      })
    );
    const baseNominal = getNominalComponent(baseType, ctx);

    const ownFields = decl.fields.map((field) => {
      const type = resolveTypeExpr(
        field.type,
        ctx,
        state,
        ctx.primitives.unknown,
        paramMap
      );
      return {
        name: field.name,
        type,
        declaringParams: declaringParamsForField(type, templateParams, ctx),
      };
    });

    if (baseFields.length > 0) {
      const declaredFields = new Map(
        ownFields.map((field) => [field.name, field])
      );
      baseFields.forEach((baseField) => {
        const declared = declaredFields.get(baseField.name);
        if (!declared) {
          throw new Error(
            `object ${getSymbolName(
              symbol,
              ctx
            )} must redeclare inherited field ${baseField.name}`
          );
        }
        const compatibility = ctx.arena.unify(declared.type, baseField.type, {
          location: ctx.hir.module.ast,
          reason: `field ${baseField.name} compatibility with base object`,
        });
        if (!compatibility.ok) {
          throw new Error(
            `field ${baseField.name} in object ${getSymbolName(
              symbol,
              ctx
            )} must match base object type`
          );
        }
      });
    }

    const fields = mergeDeclaredFields(baseFields, ownFields);
    const structural = ctx.arena.internStructuralObject({ fields });
    const nominal = ctx.arena.internNominalObject({
      owner: symbol,
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
  typeArgs: readonly TypeId[] = []
): ObjectTypeInfo | undefined => {
  if (ctx.objects.isResolving(symbol)) {
    return undefined;
  }

  const template = getObjectTemplate(symbol, ctx, state);
  if (!template) {
    return undefined;
  }
  const templateParamSet = new Set(
    template.params.map((param) => param.typeParam)
  );

  const normalized = normalizeTypeArgs({
    typeArgs,
    paramCount: template.params.length,
    unknownType: ctx.primitives.unknown,
    context: `object ${getSymbolName(symbol, ctx)}`,
  });

  if (normalized.missingCount > 0 && state.mode === "strict") {
    throw new Error(
      `object ${getSymbolName(symbol, ctx)} is missing ${
        normalized.missingCount
      } type argument(s)`
    );
  }

  const key = makeObjectInstanceKey(symbol, normalized.applied);
  const cacheable = shouldCacheInstantiation(normalized);
  if (cacheable) {
    const cached = ctx.objects.getInstance(key);
    if (cached) {
      return cached;
    }
  }

  const subst = new Map<TypeParamId, TypeId>();
  template.params.forEach((param, index) =>
    subst.set(param.typeParam, normalized.applied[index]!)
  );

  template.params.forEach((param, index) => {
    if (!param.constraint) {
      return;
    }
    const applied = normalized.applied[index] ?? ctx.primitives.unknown;
    if (applied === ctx.primitives.unknown) {
      return;
    }
    const constraintType = ctx.arena.substitute(param.constraint, subst);
    if (!typeSatisfies(applied, constraintType, ctx, state)) {
      throw new Error(
        `type argument for ${getSymbolName(
          param.symbol,
          ctx
        )} does not satisfy constraint for object ${getSymbolName(symbol, ctx)}`
      );
    }
  });

  const nominal = ctx.arena.substitute(template.nominal, subst);
  const structural = ctx.arena.substitute(template.structural, subst);
  const unresolvedStructuralParams = paramsReferencedInType(
    structural,
    templateParamSet,
    ctx
  );
  if (unresolvedStructuralParams.size > 0) {
    throw new Error(
      `object ${getSymbolName(
        symbol,
        ctx
      )} is missing substitutions for its structural fields`
    );
  }
  const type = ctx.arena.substitute(template.type, subst);
  const fields = template.fields.map((field) => ({
    name: field.name,
    type: ctx.arena.substitute(field.type, subst),
    declaringParams: field.declaringParams,
  }));
  ensureFieldsSubstituted(
    fields,
    ctx,
    `object ${getSymbolName(symbol, ctx)} instantiation`
  );
  const baseNominal = template.baseNominal
    ? ctx.arena.substitute(template.baseNominal, subst)
    : undefined;

  const info: ObjectTypeInfo = {
    nominal,
    structural,
    type,
    fields,
    baseNominal,
  };

  const cacheableInstance = cacheable && !containsUnknownType(type, ctx);
  if (cacheableInstance) {
    ctx.objects.addInstance(key, info);
    ctx.valueTypes.set(symbol, type);
  }
  return info;
};

const mergeDeclaredFields = (
  inherited: readonly StructuralField[],
  own: readonly StructuralField[]
): StructuralField[] => {
  const fields = new Map<string, StructuralField>();
  inherited.forEach((field) => fields.set(field.name, field));
  own.forEach((field) => fields.set(field.name, field));
  return Array.from(fields.values());
};

export const getObjectInfoForNominal = (
  nominal: TypeId,
  ctx: TypingContext,
  state: TypingState
): ObjectTypeInfo | undefined => {
  const cached = ctx.objects.getInstanceByNominal(nominal);
  if (cached) {
    return cached;
  }
  const desc = ctx.arena.get(nominal);
  if (desc.kind !== "nominal-object") {
    return undefined;
  }
  return ensureObjectType(desc.owner, ctx, state, desc.typeArgs);
};

export const getNominalComponent = (
  type: TypeId,
  ctx: TypingContext
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
  seen: Set<TypeId> = new Set()
): boolean => {
  if (actual === expected) {
    return true;
  }

  const actualDesc = ctx.arena.get(actual);
  const expectedDesc = ctx.arena.get(expected);
  if (
    actualDesc.kind === "nominal-object" &&
    expectedDesc.kind === "nominal-object" &&
    actualDesc.owner === expectedDesc.owner
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
      const result = ctx.arena.unify(actualDesc.typeArgs[index]!, expectedArg, {
        location: ctx.hir.module.ast,
        reason: "type argument compatibility",
        variance: "covariant",
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
        return typeSatisfies(actualDesc.typeArgs[index]!, expectedArg, ctx, state);
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
  state: TypingState
): readonly StructuralField[] | undefined => {
  if (type === ctx.primitives.unknown) {
    return undefined;
  }

  const desc = ctx.arena.get(type);
  if (desc.kind === "structural-object") {
    ensureFieldsSubstituted(desc.fields, ctx, "structural object access");
    return desc.fields;
  }

  if (desc.kind === "nominal-object") {
    const info = ensureObjectType(desc.owner, ctx, state, desc.typeArgs);
    if (info) {
      return getStructuralFields(info.structural, ctx, state);
    }
    return undefined;
  }

  if (desc.kind === "intersection") {
    const info =
      typeof desc.nominal === "number"
        ? getObjectInfoForNominal(desc.nominal, ctx, state)
        : undefined;
    if (info) {
      return getStructuralFields(info.structural, ctx, state);
    }
    if (typeof desc.structural === "number") {
      return getStructuralFields(desc.structural, ctx, state);
    }
  }

  return undefined;
};

const structuralComparableType = (
  type: TypeId,
  ctx: TypingContext,
  state: TypingState
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
      const info = ensureObjectType(desc.owner, ctx, state, desc.typeArgs);
      if (info) {
        ensureFieldsSubstituted(info.fields, ctx, "structural comparison");
      }
      return info?.structural;
    }
    case "intersection":
      if (typeof desc.structural === "number") {
        return structuralComparableType(desc.structural, ctx, state);
      }
      if (typeof desc.nominal === "number") {
        return structuralComparableType(desc.nominal, ctx, state);
      }
      return undefined;
    case "union": {
      const members: TypeId[] = [];
      for (const member of desc.members) {
        const structural = structuralComparableType(member, ctx, state);
        if (typeof structural !== "number") {
          return undefined;
        }
        members.push(structural);
      }
      return ctx.arena.internUnion(members);
    }
    default:
      return undefined;
  }
};

export const structuralTypeSatisfies = (
  actual: TypeId,
  expected: TypeId,
  ctx: TypingContext,
  state: TypingState
): boolean => {
  const comparableActual = structuralComparableType(actual, ctx, state);
  if (typeof comparableActual !== "number") {
    return false;
  }

  const comparableExpected = structuralComparableType(expected, ctx, state);
  if (typeof comparableExpected !== "number") {
    return false;
  }

  const comparison = ctx.arena.unify(comparableActual, comparableExpected, {
    location: ctx.hir.module.ast,
    reason: "structural type satisfaction",
    variance: "covariant",
  });
  return comparison.ok;
};

export const typeSatisfies = (
  actual: TypeId,
  expected: TypeId,
  ctx: TypingContext,
  state: TypingState
): boolean => {
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

  const actualDesc = ctx.arena.get(actual);
  if (actualDesc.kind === "union") {
    return actualDesc.members.every((member) =>
      typeSatisfies(member, expected, ctx, state)
    );
  }

  const expectedDesc = ctx.arena.get(expected);
  if (expectedDesc.kind === "union") {
    return expectedDesc.members.some((member) =>
      typeSatisfies(actual, member, ctx, state)
    );
  }

  const expectedNominal = getNominalComponent(expected, ctx);
  if (expectedNominal) {
    const actualNominal = getNominalComponent(actual, ctx);
    if (
      actualNominal &&
      nominalSatisfies(actualNominal, expectedNominal, ctx, state)
    ) {
      return true;
    }
    if (
      expectedNominal === ctx.objects.base.nominal &&
      structuralTypeSatisfies(actual, expected, ctx, state)
    ) {
      return true;
    }
    return false;
  }

  if (structuralTypeSatisfies(actual, expected, ctx, state)) {
    return true;
  }

  const compatibility = ctx.arena.unify(actual, expected, {
    location: ctx.hir.module.ast,
    reason: "type satisfaction",
    variance: "covariant",
  });
  return compatibility.ok;
};

export const ensureTypeMatches = (
  actual: TypeId,
  expected: TypeId,
  ctx: TypingContext,
  state: TypingState,
  reason: string
): void => {
  if (typeSatisfies(actual, expected, ctx, state)) {
    return;
  }

  throw new Error(`type mismatch for ${reason}`);
};

const nominalInstantiationMatches = (
  candidate: TypeId,
  expected: TypeId,
  ctx: TypingContext,
  state: TypingState
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
      currentDesc.owner === expectedDesc.owner &&
      currentDesc.typeArgs.length === expectedDesc.typeArgs.length &&
      !currentDesc.typeArgs.some((arg) => containsUnknownType(arg, ctx)) &&
      !expectedDesc.typeArgs.some((arg) => containsUnknownType(arg, ctx))
    ) {
      const compatibleArgs = currentDesc.typeArgs.every((arg, index) => {
        const comparison = ctx.arena.unify(arg, expectedDesc.typeArgs[index]!, {
          location: ctx.hir.module.ast,
          reason: "nominal instantiation comparison",
          variance: "invariant",
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
  state: TypingState
): boolean => {
  const patternNominal = getNominalComponent(patternType, ctx);
  const memberNominal = getNominalComponent(member, ctx);
  if (typeof patternNominal === "number" && typeof memberNominal === "number") {
    return nominalInstantiationMatches(memberNominal, patternNominal, ctx, state);
  }
  return typeSatisfies(member, patternType, ctx, state);
};

export const matchedUnionMembers = (
  patternType: TypeId,
  remaining: Set<TypeId>,
  ctx: TypingContext,
  state: TypingState
): TypeId[] => {
  if (patternType === ctx.primitives.unknown) {
    return [];
  }
  return Array.from(remaining).filter((member) =>
    unionMemberMatchesPattern(member, patternType, ctx, state)
  );
};

export const narrowTypeForPattern = (
  discriminantType: TypeId,
  patternType: TypeId,
  ctx: TypingContext,
  state: TypingState
): TypeId | undefined => {
  if (discriminantType === ctx.primitives.unknown) {
    return patternType;
  }
  const desc = ctx.arena.get(discriminantType);
  if (desc.kind === "union") {
    const matches = desc.members.filter((member) =>
      unionMemberMatchesPattern(member, patternType, ctx, state)
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

export const bindTypeParamsFromType = (
  expected: TypeId,
  actual: TypeId,
  bindings: Map<TypeParamId, TypeId>,
  ctx: TypingContext,
  state: TypingState
): void => {
  if (
    expected === ctx.primitives.unknown ||
    actual === ctx.primitives.unknown
  ) {
    return;
  }

  const expectedDesc = ctx.arena.get(expected);
  if (expectedDesc.kind === "type-param-ref") {
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
    return;
  }

  if (expectedDesc.kind === "structural-object") {
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
    return;
  }

  if (expectedDesc.kind === "intersection") {
    if (typeof expectedDesc.nominal === "number") {
      bindTypeParamsFromType(expectedDesc.nominal, actual, bindings, ctx, state);
    }
    if (typeof expectedDesc.structural === "number") {
      bindTypeParamsFromType(
        expectedDesc.structural,
        actual,
        bindings,
        ctx,
        state
      );
    }
  }
};
