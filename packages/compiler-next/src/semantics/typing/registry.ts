import {
  registerPrimitive,
  resolveTypeExpr,
  getSymbolName,
  getNominalComponent,
} from "./type-system.js";
import type { SymbolId, TypeId } from "../ids.js";
import {
  BASE_OBJECT_NAME,
  type TypingContext,
  type TypingState,
} from "./types.js";
import type {
  HirFunction,
  HirImplDecl,
  HirTraitMethod,
  HirTypeExpr,
} from "../hir/index.js";

export const seedPrimitiveTypes = (ctx: TypingContext): void => {
  ctx.primitives.void = registerPrimitive(ctx, "voyd", "void", "Voyd");
  ctx.primitives.bool = registerPrimitive(ctx, "bool", "boolean", "Bool");
  ctx.primitives.unknown = registerPrimitive(ctx, "unknown");

  registerPrimitive(ctx, "i32");
  registerPrimitive(ctx, "i64");
  registerPrimitive(ctx, "f32");
  registerPrimitive(ctx, "f64");
  registerPrimitive(ctx, "string", "String");
};

export const seedBaseObjectType = (ctx: TypingContext): void => {
  const symbol = ctx.symbolTable.declare({
    name: BASE_OBJECT_NAME,
    kind: "type",
    declaredAt: ctx.hir.module.ast,
    metadata: { intrinsic: true, entity: "object" },
  });

  const structural = ctx.arena.internStructuralObject({ fields: [] });
  const nominal = ctx.arena.internNominalObject({
    owner: symbol,
    name: BASE_OBJECT_NAME,
    typeArgs: [],
  });
  const type = ctx.arena.internIntersection({ nominal, structural });
  const info = {
    nominal,
    structural,
    type,
    fields: [],
    baseNominal: undefined,
  };
  const template = {
    symbol,
    params: [],
    nominal,
    structural,
    type,
    fields: [],
    baseNominal: undefined,
  };

  ctx.objects.setBase({
    symbol,
    nominal,
    structural,
    type,
  });

  ctx.objects.registerTemplate(template);
  ctx.objects.addInstance(`${symbol}<>`, info);
  if (!ctx.objects.hasName(BASE_OBJECT_NAME)) {
    ctx.objects.setName(BASE_OBJECT_NAME, symbol);
  }
  ctx.valueTypes.set(symbol, type);
};

export const registerTypeAliases = (
  ctx: TypingContext,
  state: TypingState
): void => {
  for (const item of ctx.hir.items.values()) {
    if (item.kind !== "type-alias") continue;
    const decl =
      (typeof item.decl === "number"
        ? ctx.decls.getTypeAliasById(item.decl)
        : ctx.decls.getTypeAlias(item.symbol)) ?? undefined;
    if (
      typeof item.decl === "number" &&
      (!decl || decl.symbol !== item.symbol)
    ) {
      throw new Error(
        `missing or mismatched decl for type alias symbol ${item.symbol}`
      );
    }
    const typeParams = item.typeParameters ?? decl?.typeParameters ?? [];
    const params = typeParams.map((param) => ({
      symbol: param.symbol,
      constraint: "constraint" in param ? param.constraint : undefined,
    }));
    ctx.typeAliases.registerTemplate({
      symbol: item.symbol,
      params,
      target: item.target,
    });
    ctx.typeAliases.setName(getSymbolName(item.symbol, ctx), item.symbol);
  }
};

export const registerObjectDecls = (ctx: TypingContext): void => {
  for (const item of ctx.hir.items.values()) {
    if (item.kind !== "object") continue;
    ctx.objects.registerDecl(item);
    const name = getSymbolName(item.symbol, ctx);
    if (!ctx.objects.hasName(name)) {
      ctx.objects.setName(name, item.symbol);
    }
  }
};

export const registerTraits = (ctx: TypingContext): void => {
  for (const item of ctx.hir.items.values()) {
    if (item.kind !== "trait") continue;
    ctx.traits.registerDecl(item);
    const name = getSymbolName(item.symbol, ctx);
    if (!ctx.traits.hasName(name)) {
      ctx.traits.setName(name, item.symbol);
    }
  }
};

export const registerFunctionSignatures = (
  ctx: TypingContext,
  state: TypingState
): void => {
  for (const item of ctx.hir.items.values()) {
    if (item.kind !== "function") continue;
    ctx.functions.register(item);
    const fnDecl =
      (typeof item.decl === "number"
        ? ctx.decls.getFunctionById(item.decl)
        : ctx.decls.getFunction(item.symbol)) ?? undefined;
    if (
      typeof item.decl === "number" &&
      (!fnDecl || fnDecl.symbol !== item.symbol)
    ) {
      throw new Error(
        `missing or mismatched decl for function symbol ${item.symbol}`
      );
    }

    if (fnDecl && fnDecl.params.length !== item.parameters.length) {
      throw new Error(
        `function parameter count mismatch for symbol ${item.symbol}: decl defines ${fnDecl.params.length}, HIR has ${item.parameters.length}`
      );
    }

    const implDecl =
      typeof fnDecl?.implId === "number"
        ? ctx.decls.getImplById(fnDecl.implId)
        : undefined;
    const fnTypeParameters =
      item.typeParameters ?? fnDecl?.typeParameters ?? [];
    const implTypeParameters = implDecl?.typeParameters ?? [];
    const typeParameterDecls = [...fnTypeParameters, ...implTypeParameters];
    const paramMap = new Map<SymbolId, TypeId>();
    const typeParams =
      typeParameterDecls.length === 0
        ? undefined
        : typeParameterDecls.map((param) => {
            const typeParam = ctx.arena.freshTypeParam();
            const typeRef = ctx.arena.internTypeParamRef(typeParam);
            paramMap.set(param.symbol, typeRef);
            const constraint =
              "constraint" in param && param.constraint
                ? resolveTypeExpr(
                    param.constraint,
                    ctx,
                    state,
                    ctx.primitives.unknown,
                    paramMap
                  )
                : undefined;
            return { symbol: param.symbol, typeParam, constraint, typeRef };
          });

    if (typeParams && typeParams.length > 0 && !item.returnType) {
      throw new Error(
        `generic function ${getSymbolName(
          item.symbol,
          ctx
        )} must declare a return type`
      );
    }

    const parameters = item.parameters.map((param, index) => {
      const resolved = resolveTypeExpr(
        param.type,
        ctx,
        state,
        ctx.primitives.unknown,
        paramMap
      );
      ctx.valueTypes.set(param.symbol, resolved);
      const declParam =
        (typeof param.decl === "number"
          ? ctx.decls.getParameterById(param.decl)
          : undefined) ?? ctx.decls.getParameter(param.symbol);
      if (
        typeof param.decl === "number" &&
        (!declParam || declParam.symbol !== param.symbol)
      ) {
        throw new Error(
          `missing or mismatched parameter decl for symbol ${
            param.symbol
          } in function ${getSymbolName(item.symbol, ctx)}`
        );
      }
      if (
        fnDecl?.params[index] &&
        fnDecl.params[index]!.symbol !== param.symbol
      ) {
        throw new Error(
          `parameter order mismatch for function ${getSymbolName(
            item.symbol,
            ctx
          )}`
        );
      }
      return {
        type: resolved,
        label: declParam?.label ?? param.label,
        bindingKind: param.pattern.bindingKind,
        span: param.span,
        name: getSymbolName(param.symbol, ctx),
        symbol: param.symbol,
      };
    });

    const hasExplicitReturn = Boolean(item.returnType);
    const declaredReturn =
      resolveTypeExpr(
        item.returnType,
        ctx,
        state,
        ctx.primitives.unknown,
        paramMap
      ) ?? ctx.primitives.unknown;

    const functionType = ctx.arena.internFunction({
      parameters: parameters.map(({ type, label }) => ({
        type,
        label,
        optional: false,
      })),
      returnType: declaredReturn,
      effects: ctx.primitives.defaultEffectRow,
    });

    const scheme = ctx.arena.newScheme(
      typeParams?.map((param) => param.typeParam) ?? [],
      functionType
    );

    ctx.functions.setSignature(item.symbol, {
      typeId: functionType,
      parameters,
      returnType: declaredReturn,
      hasExplicitReturn,
      typeParams,
      scheme,
      typeParamMap:
        typeParams && typeParams.length > 0
          ? new Map(
              typeParams.map((param) => [param.symbol, param.typeRef] as const)
            )
          : undefined,
    });
    ctx.valueTypes.set(item.symbol, functionType);

    ctx.table.setSymbolScheme(item.symbol, scheme);
  }
};

export const registerImpls = (ctx: TypingContext, state: TypingState): void => {
  for (const item of ctx.hir.items.values()) {
    if (item.kind !== "impl") continue;
    const decl =
      ctx.decls.getImpl(item.symbol) ??
      (typeof (item as any).decl === "number"
        ? ctx.decls.getImplById((item as any).decl)
        : undefined);
    const typeParameterDecls =
      item.typeParameters ?? decl?.typeParameters ?? [];
    const typeParamMap =
      typeParameterDecls.length === 0
        ? undefined
        : typeParameterDecls.reduce((acc, param) => {
            const typeParam = ctx.arena.freshTypeParam();
            const typeRef = ctx.arena.internTypeParamRef(typeParam);
            acc.set(param.symbol, typeRef);
            return acc;
          }, new Map<SymbolId, TypeId>());

    resolveTypeExpr(
      item.target,
      ctx,
      state,
      ctx.primitives.unknown,
      typeParamMap
    );
    const targetType = item.target.typeId as TypeId | undefined;
    if (typeof targetType !== "number") {
      throw new Error("impl target missing type");
    }
    const targetDesc = ctx.arena.get(targetType);
    const nominalTarget = getNominalComponent(targetType, ctx);
    const isTypeParamTarget = targetDesc.kind === "type-param-ref";
    if (!isTypeParamTarget && typeof nominalTarget !== "number") {
      throw new Error("impl target must be a nominal object type");
    }
    if (typeof nominalTarget === "number") {
      item.target.typeId = nominalTarget;
    }

    resolveTypeExpr(
      item.trait as HirTypeExpr | undefined,
      ctx,
      state,
      ctx.primitives.unknown,
      typeParamMap
    );
    validateImplTraitMethods({
      impl: item,
      implDecl: decl,
      ctx,
    });

    item.with?.forEach((entry) => {
      if (entry.kind === "member-import") {
        resolveTypeExpr(
          entry.source,
          ctx,
          state,
          ctx.primitives.unknown,
          typeParamMap
        );
        return;
      }
      resolveTypeExpr(
        entry.source,
        ctx,
        state,
        ctx.primitives.unknown,
        typeParamMap
      );
      resolveTypeExpr(
        entry.trait,
        ctx,
        state,
        ctx.primitives.unknown,
        typeParamMap
      );
    });
  }
};

const validateImplTraitMethods = ({
  impl,
  implDecl,
  ctx,
}: {
  impl: HirImplDecl;
  implDecl?: ReturnType<TypingContext["decls"]["getImpl"]>;
  ctx: TypingContext;
}): void => {
  const traitSymbol =
    impl.trait?.typeKind === "named" ? impl.trait.symbol : undefined;
  if (typeof traitSymbol !== "number" || !implDecl) {
    return;
  }

  const traitDecl = ctx.decls.getTrait(traitSymbol);
  const traitHirDecl = ctx.traits.getDecl(traitSymbol);
  if (!traitDecl) {
    return;
  }

  const implMethodsByName = new Map(
    implDecl.methods.map((method) => [
      getSymbolName(method.symbol, ctx),
      method,
    ])
  );
  const traitMethodsBySymbol = new Map(
    traitHirDecl?.methods.map((method) => [method.symbol, method]) ?? []
  );
  const implFunctionsBySymbol = new Map(
    implDecl.methods.map((method) => [
      method.symbol,
      ctx.functions.getFunction(method.symbol),
    ])
  );
  const traitTypeSubstitutions = buildTraitTypeSubstitutions({
    traitTypeParameters:
      traitHirDecl?.typeParameters ?? traitDecl.typeParameters,
    traitExpr: impl.trait,
  });
  const missing = traitDecl.methods
    .filter((method) => !method.defaultBody)
    .map((method) => getSymbolName(method.symbol, ctx))
    .filter((name) => !implMethodsByName.has(name));

  if (missing.length === 0) {
    traitDecl.methods.forEach((traitMethod) => {
      const implMethod = implMethodsByName.get(
        getSymbolName(traitMethod.symbol, ctx)
      );
      if (!implMethod) return;

      const signatureError = compareMethodSignatures({
        traitMethod,
        implMethod,
        traitSymbol,
        impl,
        ctx,
        traitMethodHir: traitMethodsBySymbol.get(traitMethod.symbol),
        implFunction: implFunctionsBySymbol.get(implMethod.symbol),
        traitTypeSubstitutions,
      });
      if (signatureError) {
        throw signatureError;
      }
    });
    return;
  }

  const targetName =
    impl.target.typeKind === "named" && typeof impl.target.symbol === "number"
      ? getSymbolName(impl.target.symbol, ctx)
      : "impl target";
  const traitName = getSymbolName(traitSymbol, ctx);
  const plural = missing.length > 1 ? "s" : "";
  const missingList = missing.join(", ");
  throw new Error(
    `impl ${traitName} for ${targetName} is missing trait method${plural}: ${missingList}`
  );
};

const compareMethodSignatures = ({
  traitMethod,
  implMethod,
  traitSymbol,
  impl,
  ctx,
  traitMethodHir,
  implFunction,
  traitTypeSubstitutions,
}: {
  traitMethod: NonNullable<
    ReturnType<TypingContext["decls"]["getTrait"]>
  >["methods"][number];
  implMethod: NonNullable<
    ReturnType<TypingContext["decls"]["getImpl"]>
  >["methods"][number];
  traitSymbol: SymbolId;
  impl: HirImplDecl;
  ctx: TypingContext;
  traitMethodHir?: HirTraitMethod;
  implFunction?: HirFunction;
  traitTypeSubstitutions?: Map<SymbolId, HirTypeExpr>;
}): Error | undefined => {
  const traitName = getSymbolName(traitSymbol, ctx);
  const methodName = getSymbolName(traitMethod.symbol, ctx);
  const targetName =
    impl.target.typeKind === "named" && typeof impl.target.symbol === "number"
      ? getSymbolName(impl.target.symbol, ctx)
      : "impl target";

  if (traitMethod.params.length !== implMethod.params.length) {
    return new Error(
      `impl ${traitName} for ${targetName} method ${methodName} has ${implMethod.params.length} parameter(s) but trait declares ${traitMethod.params.length}`
    );
  }

  const traitParamCount = traitMethod.typeParameters?.length ?? 0;
  const implParamCount = implMethod.typeParameters?.length ?? 0;
  if (traitParamCount !== implParamCount) {
    return new Error(
      `impl ${traitName} for ${targetName} method ${methodName} must declare ${traitParamCount} type parameter(s)`
    );
  }

  for (let index = 0; index < traitMethod.params.length; index += 1) {
    const traitParam = traitMethod.params[index]!;
    const implParam = implMethod.params[index]!;
    if (traitParam.label !== implParam.label) {
      return new Error(
        `impl ${traitName} for ${targetName} method ${methodName} parameter ${
          index + 1
        } label mismatch`
      );
    }
    const traitTypeKey = typeExprKey(
      traitMethodHir?.parameters[index]?.type,
      traitTypeSubstitutions,
      undefined,
      impl.target
    );
    const implTypeKey = typeExprKey(
      implFunction?.parameters[index]?.type,
      traitTypeSubstitutions,
      undefined,
      impl.target
    );
    if (traitTypeKey && !implTypeKey) {
      return new Error(
        `impl ${traitName} for ${targetName} method ${methodName} parameter ${
          index + 1
        } is missing type annotation`
      );
    }
    if (traitTypeKey && implTypeKey && traitTypeKey !== implTypeKey) {
      return new Error(
        `impl ${traitName} for ${targetName} method ${methodName} parameter ${
          index + 1
        } type mismatch: expected ${traitTypeKey}, got ${implTypeKey}`
      );
    }
  }

  const traitReturnKey = typeExprKey(
    traitMethodHir?.returnType,
    traitTypeSubstitutions,
    undefined,
    impl.target
  );
  const implReturnKey = typeExprKey(
    implFunction?.returnType,
    traitTypeSubstitutions,
    undefined,
    impl.target
  );
  if (traitReturnKey && !implReturnKey) {
    return new Error(
      `impl ${traitName} for ${targetName} method ${methodName} is missing return type annotation`
    );
  }
  if (traitReturnKey && implReturnKey && traitReturnKey !== implReturnKey) {
    return new Error(
      `impl ${traitName} for ${targetName} method ${methodName} return type mismatch: expected ${traitReturnKey}, got ${implReturnKey}`
    );
  }

  return undefined;
};

const buildTraitTypeSubstitutions = ({
  traitTypeParameters,
  traitExpr,
}: {
  traitTypeParameters?: readonly { symbol: SymbolId }[];
  traitExpr?: HirTypeExpr;
}): Map<SymbolId, HirTypeExpr> | undefined => {
  if (
    traitExpr?.typeKind !== "named" ||
    !traitExpr.typeArguments ||
    traitExpr.typeArguments.length === 0
  ) {
    return undefined;
  }

  const params = traitTypeParameters ?? [];
  if (params.length === 0) {
    return undefined;
  }

  const substitutions = new Map<SymbolId, HirTypeExpr>();
  params.forEach((param, index) => {
    const arg = traitExpr.typeArguments?.[index];
    if (arg) {
      substitutions.set(param.symbol, arg);
    }
  });

  return substitutions.size > 0 ? substitutions : undefined;
};

const typeExprKey = (
  expr: HirTypeExpr | undefined,
  substitutions?: Map<SymbolId, HirTypeExpr>,
  visiting?: Set<SymbolId>,
  selfType?: HirTypeExpr
): string | undefined => {
  if (!expr) return undefined;

  switch (expr.typeKind) {
    case "named": {
      const symbol = expr.symbol;
      const substitution =
        typeof symbol === "number" ? substitutions?.get(symbol) : undefined;
      if (substitution) {
        const nextVisiting = new Set(visiting ?? []);
        if (typeof symbol === "number" && nextVisiting.has(symbol)) {
          return undefined;
        }
        if (typeof symbol === "number") {
          nextVisiting.add(symbol);
        }
        return typeExprKey(substitution, substitutions, nextVisiting, selfType);
      }
      const args = expr.typeArguments?.map((arg) =>
        typeExprKey(arg, substitutions, visiting, selfType)
      );
      const renderedArgs =
        args && args.length > 0
          ? `<${args.map((arg) => arg ?? "_").join(",")}>`
          : "";
      return `${expr.path.join("::")}${renderedArgs}`;
    }
    case "object":
      return "object";
    case "tuple":
      return `(${expr.elements
        .map(
          (entry) =>
            typeExprKey(entry, substitutions, visiting, selfType) ?? "_"
        )
        .join(",")})`;
    case "union":
      return expr.members
        .map(
          (entry) =>
            typeExprKey(entry, substitutions, visiting, selfType) ?? "_"
        )
        .join("|");
    case "intersection":
      return expr.members
        .map(
          (entry) =>
            typeExprKey(entry, substitutions, visiting, selfType) ?? "_"
        )
        .join("&");
    case "function": {
      const typeParamCount = expr.typeParameters?.length ?? 0;
      const params = expr.parameters
        .map(
          (param) =>
            typeExprKey(param, substitutions, visiting, selfType) ?? "_"
        )
        .join(",");
      const returnKey =
        typeExprKey(expr.returnType, substitutions, visiting, selfType) ??
        "void";
      const typeParamPart = typeParamCount > 0 ? `<${typeParamCount}>` : "";
      return `fn${typeParamPart}(${params})->${returnKey}`;
    }
    case "self":
      if (!selfType || selfType.typeKind === "self") return "Self";
      return typeExprKey(selfType, substitutions, visiting, selfType);
    default:
      return undefined;
  }
};
