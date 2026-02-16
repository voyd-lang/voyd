import {
  registerPrimitive,
  resolveTypeExpr,
  getSymbolName,
  getNominalComponent,
  unifyWithBudget,
} from "./type-system.js";
import type { SymbolId, TypeId } from "../ids.js";
import {
  BASE_OBJECT_NAME,
  type TraitImplTemplate,
  type TypingContext,
  type TypingState,
} from "./types.js";
import { canonicalSymbolRefForTypingContext } from "./symbol-ref-utils.js";
import type {
  HirFunction,
  HirImplDecl,
  HirTraitMethod,
  HirTypeExpr,
} from "../hir/index.js";
import {
  freshOpenEffectRow,
  effectOpName,
  resolveEffectAnnotation,
} from "./effects.js";
import {
  diagnosticFromCode,
  emitDiagnostic,
  normalizeSpan,
} from "../../diagnostics/index.js";
import { isStdOnlyIntrinsicName } from "../intrinsics.js";
import {
  assertUniqueMethodSignatures,
  buildImplMethodSignatureInfos,
  buildTraitMethodMapByExactSignature,
  buildTraitMethodSignatureInfos,
  buildTraitMethodSignatureInfosFromHir,
  matchTraitMethodsWithShapeFallback,
  typeExprKey,
} from "./trait-method-matcher.js";

export const seedPrimitiveTypes = (ctx: TypingContext): void => {
  ctx.primitives.void = registerPrimitive(ctx, "voyd", "void", "Voyd");
  ctx.primitives.bool = registerPrimitive(ctx, "bool", "boolean", "Bool");
  ctx.primitives.unknown = registerPrimitive(ctx, "unknown");
  ctx.primitives.i32 = registerPrimitive(ctx, "i32");
  ctx.primitives.i64 = registerPrimitive(ctx, "i64");
  ctx.primitives.f32 = registerPrimitive(ctx, "f32");
  ctx.primitives.f64 = registerPrimitive(ctx, "f64");

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
    owner: canonicalSymbolRefForTypingContext(symbol, ctx),
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
    const typeParams: readonly { symbol: SymbolId; constraint?: HirTypeExpr }[] =
      item.typeParameters?.map((param) => ({
        symbol: param.symbol,
        constraint: param.constraint,
      })) ??
      decl?.typeParameters?.map((param) => ({ symbol: param.symbol })) ??
      [];
    const params = typeParams.map((param) => ({
      symbol: param.symbol,
      constraint: param.constraint,
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
    const traitDecl = ctx.decls.getTrait(item.symbol);
    if (traitDecl) {
      const traitMethodsBySymbol = new Map(
        item.methods.map((method) => [method.symbol, method]),
      );
      const traitInfos = buildTraitMethodSignatureInfos({
        traitMethods: traitDecl.methods,
        traitMethodsBySymbol,
        ctx,
      });
      assertUniqueMethodSignatures({
        traitName: getSymbolName(item.symbol, ctx),
        methods: traitInfos,
      });
    }
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
    const symbolRecord = ctx.symbolTable.getSymbol(item.symbol);
    const symbolMetadata = (symbolRecord.metadata ?? {}) as {
      intrinsic?: unknown;
      intrinsicName?: unknown;
    };
    const intrinsicName =
      typeof symbolMetadata.intrinsicName === "string"
        ? symbolMetadata.intrinsicName
        : undefined;
    if (
      ctx.packageId !== "std" &&
      symbolMetadata.intrinsic === true &&
      typeof intrinsicName === "string" &&
      isStdOnlyIntrinsicName(intrinsicName)
    ) {
      emitDiagnostic({
        code: "TY0038",
        ctx,
        span: normalizeSpan(item.span, ctx.hir.module.span),
        params: {
          kind: "std-only-intrinsic-wrapper",
          intrinsicName,
        },
      });
    }
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
    const implItem = implDecl
      ? Array.from(ctx.hir.items.values()).find(
          (entry): entry is HirImplDecl =>
            entry.kind === "impl" && entry.symbol === implDecl.symbol
        )
      : undefined;
    const fnTypeParameters: readonly {
      symbol: SymbolId;
      constraint?: HirTypeExpr;
    }[] =
      item.typeParameters?.map((param) => ({
        symbol: param.symbol,
        constraint: param.constraint,
      })) ??
      fnDecl?.typeParameters?.map((param) => ({ symbol: param.symbol })) ??
      [];
    const implTypeParameters: readonly {
      symbol: SymbolId;
      constraint?: HirTypeExpr;
    }[] =
      implItem?.typeParameters?.map((param) => ({
        symbol: param.symbol,
        constraint: param.constraint,
      })) ??
      implDecl?.typeParameters?.map((param) => ({ symbol: param.symbol })) ??
      [];
    const typeParameterDecls = [...fnTypeParameters, ...implTypeParameters];
    const paramMap = new Map<SymbolId, TypeId>();
    const typeParams =
      typeParameterDecls.length === 0
        ? undefined
        : typeParameterDecls.map((param) => {
            const typeParam = ctx.arena.freshTypeParam();
            const typeRef = ctx.arena.internTypeParamRef(typeParam);
            paramMap.set(param.symbol, typeRef);
            return {
              symbol: param.symbol,
              typeParam,
              typeRef,
              constraint: undefined as TypeId | undefined,
            };
          });
    typeParams?.forEach((param, index) => {
      const constraintExpr = typeParameterDecls[index]?.constraint;
      if (!constraintExpr) {
        return;
      }
      param.constraint = resolveTypeExpr(
        constraintExpr,
        ctx,
        state,
        ctx.primitives.unknown,
        paramMap
      );
    });

    if (typeParams && typeParams.length > 0 && !item.returnType) {
      ctx.diagnostics.report(
        diagnosticFromCode({
          code: "TY0034",
          params: {
            kind: "return-type-inference-failed",
            functionName: getSymbolName(item.symbol, ctx),
          },
          span: normalizeSpan(item.span, ctx.hir.module.span),
        })
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
        optional: declParam?.optional ?? param.optional,
      };
    });

    const effectAnnotation = resolveEffectAnnotation(
      item.effectType,
      ctx,
      state
    );
    const initialEffectRow = effectAnnotation ?? ctx.primitives.defaultEffectRow;
    const annotatedEffects = effectAnnotation !== undefined;

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
      parameters: parameters.map(({ type, label, optional }) => ({
        type,
        label,
        optional: optional ?? false,
      })),
      returnType: declaredReturn,
      effectRow: initialEffectRow,
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
      annotatedReturn: hasExplicitReturn,
      effectRow: initialEffectRow,
      annotatedEffects,
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

export const registerEffectOperations = (
  ctx: TypingContext,
  state: TypingState
): void => {
  for (const item of ctx.hir.items.values()) {
    if (item.kind !== "effect") continue;

    const decl = ctx.decls.getEffect(item.symbol);
    const typeParameterDecls: readonly {
      symbol: SymbolId;
      constraint?: HirTypeExpr;
    }[] =
      item.typeParameters?.map((param) => ({
        symbol: param.symbol,
        constraint: param.constraint,
      })) ??
      decl?.typeParameters?.map((param) => ({ symbol: param.symbol })) ??
      [];
    const typeParamMap = new Map<SymbolId, TypeId>();
    const typeParams =
      typeParameterDecls.length === 0
        ? undefined
        : typeParameterDecls.map((param) => {
            const typeParam = ctx.arena.freshTypeParam();
            const typeRef = ctx.arena.internTypeParamRef(typeParam);
            typeParamMap.set(param.symbol, typeRef);
            return {
              symbol: param.symbol,
              typeParam,
              typeRef,
              constraint: undefined as TypeId | undefined,
            };
          });
    typeParams?.forEach((param, index) => {
      const constraintExpr = typeParameterDecls[index]?.constraint;
      if (!constraintExpr) {
        return;
      }
      param.constraint = resolveTypeExpr(
        constraintExpr,
        ctx,
        state,
        ctx.primitives.unknown,
        typeParamMap
      );
    });
    const typeParamMapRef = typeParams ? typeParamMap : undefined;

    item.operations.forEach((op) => {
      const parameters = op.parameters.map((param) => ({
        type:
          resolveTypeExpr(
            param.type,
            ctx,
            state,
            ctx.primitives.unknown,
            typeParamMapRef
          ) ?? ctx.primitives.unknown,
        label: undefined,
        bindingKind: param.bindingKind,
        span: param.span,
        name: getSymbolName(param.symbol, ctx),
        symbol: param.symbol,
      }));

      const hasExplicitReturn = Boolean(op.returnType);
      const returnType =
        resolveTypeExpr(
          op.returnType,
          ctx,
          state,
          ctx.primitives.unknown,
          typeParamMapRef
        ) ?? ctx.primitives.void;

      const effectRow = ctx.effects.internRow({
        operations: [
          {
            name: effectOpName(op.symbol, ctx),
          },
        ],
      });

      const functionType = ctx.arena.internFunction({
        parameters: parameters.map((param) => ({
          type: param.type,
          label: param.label,
          optional: false,
        })),
        returnType,
        effectRow,
      });

      const scheme = ctx.arena.newScheme(
        typeParams?.map((param) => param.typeParam) ?? [],
        functionType
      );
      ctx.functions.setSignature(op.symbol, {
        typeId: functionType,
        parameters,
        returnType,
        hasExplicitReturn,
        annotatedReturn: hasExplicitReturn,
        effectRow,
        annotatedEffects: true,
        typeParams,
        scheme,
        typeParamMap:
          typeParams && typeParams.length > 0
            ? new Map(
                typeParams.map((param) => [param.symbol, param.typeRef] as const)
              )
            : undefined,
      });
      ctx.valueTypes.set(op.symbol, functionType);
      ctx.table.setSymbolScheme(op.symbol, scheme);
    });
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
    const typeParameterDecls: readonly {
      symbol: SymbolId;
      constraint?: HirTypeExpr;
    }[] =
      item.typeParameters?.map((param) => ({
        symbol: param.symbol,
        constraint: param.constraint,
      })) ??
      decl?.typeParameters?.map((param) => ({ symbol: param.symbol })) ??
      [];
    const typeParamMap = new Map<SymbolId, TypeId>();
    const typeParams =
      typeParameterDecls.length === 0
        ? []
        : typeParameterDecls.map((param) => {
            const typeParam = ctx.arena.freshTypeParam();
            const typeRef = ctx.arena.internTypeParamRef(typeParam);
            typeParamMap.set(param.symbol, typeRef);
            return {
              symbol: param.symbol,
              typeParam,
              typeRef,
              constraint: undefined as TypeId | undefined,
            };
          });
    typeParams.forEach((param, index) => {
      const constraintExpr = typeParameterDecls[index]?.constraint;
      if (!constraintExpr) {
        return;
      }
      param.constraint = resolveTypeExpr(
        constraintExpr,
        ctx,
        state,
        ctx.primitives.unknown,
        typeParamMap
      );
    });
    const typeParamMapRef = typeParams.length > 0 ? typeParamMap : undefined;

    resolveTypeExpr(
      item.target,
      ctx,
      state,
      ctx.primitives.unknown,
      typeParamMapRef
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
      typeParamMapRef
    );
    validateImplTraitMethods({
      impl: item,
      implDecl: decl,
      ctx,
    });

    const traitSymbol =
      item.trait?.typeKind === "named" ? item.trait.symbol : undefined;
    const methodMap =
      typeof traitSymbol === "number"
        ? buildTraitMethodMap({
            impl: item,
            implDecl: decl,
            traitSymbol,
            ctx,
          })
        : undefined;
    const implTarget =
      (item.target.typeId as TypeId | undefined) ?? targetType;
    const traitType = item.trait?.typeId as TypeId | undefined;
    if (
      methodMap &&
      methodMap.size > 0 &&
      typeof traitSymbol === "number" &&
      typeof implTarget === "number" &&
      typeof traitType === "number"
    ) {
      const template: TraitImplTemplate = {
        trait: traitType,
        traitSymbol,
        target: implTarget,
        typeParams,
        methods: methodMap,
        implSymbol: item.symbol,
      };
      registerTraitImplTemplate({
        impl: item,
        template,
        ctx,
      });
      methodMap.forEach((implMethodSymbol, traitMethodSymbol) => {
        ctx.traitMethodImpls.set(implMethodSymbol, {
          traitSymbol,
          traitMethodSymbol,
        });
      });
    }

    item.with?.forEach((entry) => {
      if (entry.kind === "member-import") {
        resolveTypeExpr(
          entry.source,
          ctx,
          state,
          ctx.primitives.unknown,
          typeParamMapRef
        );
        return;
      }
      resolveTypeExpr(
        entry.source,
        ctx,
        state,
        ctx.primitives.unknown,
        typeParamMapRef
      );
      resolveTypeExpr(
        entry.trait,
        ctx,
        state,
        ctx.primitives.unknown,
        typeParamMapRef
      );
    });
  }
};

const registerTraitImplTemplate = ({
  impl,
  template,
  ctx,
}: {
  impl: HirImplDecl;
  template: TraitImplTemplate;
  ctx: TypingContext;
}): void => {
  const conflictingImpl = ctx.traits.registerImplTemplateChecked({
    template,
    conflictsWith: (left, right) =>
      traitImplTemplatesOverlap({
        left,
        right,
        ctx,
      }),
  });
  if (!conflictingImpl) {
    return;
  }

  const traitName = getSymbolName(template.traitSymbol, ctx);
  const targetName = typeExprKey(impl.target) ?? "impl target";
  const previousImpl = findImplBySymbol(conflictingImpl.implSymbol, ctx);
  emitDiagnostic({
    code: "TY0036",
    ctx,
    span: normalizeSpan(impl.span, impl.target.span),
    params: {
      kind: "duplicate-trait-implementation",
      traitName,
      targetName,
    },
    related: previousImpl
      ? [
          diagnosticFromCode({
            code: "TY0036",
            span: normalizeSpan(previousImpl.span, previousImpl.target.span),
            severity: "note",
            params: {
              kind: "previous-trait-implementation",
              traitName,
              targetName,
            },
          }),
        ]
      : undefined,
  });
};

const findImplBySymbol = (
  symbol: SymbolId,
  ctx: TypingContext
): HirImplDecl | undefined =>
  Array.from(ctx.hir.items.values()).find(
    (item): item is HirImplDecl => item.kind === "impl" && item.symbol === symbol
  );

const traitImplTemplatesOverlap = ({
  left,
  right,
  ctx,
}: {
  left: TraitImplTemplate;
  right: TraitImplTemplate;
  ctx: TypingContext;
}): boolean => {
  const targetMatch = unifyWithBudget({
    actual: left.target,
    expected: right.target,
    options: {
      location: ctx.hir.module.ast,
      reason: "trait impl overlap check (target)",
      variance: "invariant",
      allowUnknown: false,
    },
    ctx,
  });
  if (!targetMatch.ok) {
    return false;
  }

  const leftTrait = ctx.arena.substitute(left.trait, targetMatch.substitution);
  const rightTrait = ctx.arena.substitute(right.trait, targetMatch.substitution);
  const traitMatch = unifyWithBudget({
    actual: leftTrait,
    expected: rightTrait,
    options: {
      location: ctx.hir.module.ast,
      reason: "trait impl overlap check (trait)",
      variance: "invariant",
      allowUnknown: false,
    },
    ctx,
  });
  return traitMatch.ok;
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

  const traitMethodsBySymbol = new Map(
    traitHirDecl?.methods.map((method) => [method.symbol, method]) ?? [],
  );
  const implFunctionsBySymbol = new Map(
    implDecl.methods.map((method) => [
      method.symbol,
      ctx.functions.getFunction(method.symbol),
    ]),
  );
  const traitTypeSubstitutions = buildTraitTypeSubstitutions({
    traitTypeParameters:
      traitHirDecl?.typeParameters ?? traitDecl.typeParameters,
    traitExpr: impl.trait,
  });
  const traitName = getSymbolName(traitSymbol, ctx);
  const targetName =
    impl.target.typeKind === "named" && typeof impl.target.symbol === "number"
      ? getSymbolName(impl.target.symbol, ctx)
      : "impl target";
  const traitMethodSignatures = buildTraitMethodSignatureInfos({
    traitMethods: traitDecl.methods,
    traitMethodsBySymbol,
    ctx,
    traitTypeSubstitutions,
    selfType: impl.target,
  });
  assertUniqueMethodSignatures({
    traitName,
    methods: traitMethodSignatures,
  });
  const implMethodSignatures = buildImplMethodSignatureInfos({
    implMethods: implDecl.methods,
    implFunctionsBySymbol,
    ctx,
    traitTypeSubstitutions,
    selfType: impl.target,
  });
  const { matches, missing } = matchTraitMethodsWithShapeFallback({
    traitMethods: traitMethodSignatures,
    implMethods: implMethodSignatures,
    ambiguousMessage: (method) =>
      `impl ${traitName} for ${targetName} has ambiguous overloads for ${method.display}`,
  });

  matches.forEach(({ traitMethod, implMethod }) => {
    const signatureError = compareMethodSignatures({
      traitMethod: traitMethod.method,
      implMethod: implMethod.method,
      traitSymbol,
      impl,
      ctx,
      traitMethodHir: traitMethod.methodHir,
      implFunction: implFunctionsBySymbol.get(implMethod.method.symbol),
      traitTypeSubstitutions,
    });
    if (signatureError) {
      throw signatureError;
    }
  });

  const missingRequired = missing
    .filter((method) => !method.hasDefaultBody)
    .map((method) => method.display);

  if (missingRequired.length === 0) {
    return;
  }

  const plural = missingRequired.length > 1 ? "s" : "";
  const missingList = missingRequired.join(", ");
  throw new Error(
    `impl ${traitName} for ${targetName} is missing trait method${plural}: ${missingList}`
  );
};

const buildTraitMethodMap = ({
  impl,
  implDecl,
  traitSymbol,
  ctx,
}: {
  impl: HirImplDecl;
  implDecl?: ReturnType<TypingContext["decls"]["getImpl"]>;
  traitSymbol: SymbolId;
  ctx: TypingContext;
}): ReadonlyMap<SymbolId, SymbolId> | undefined => {
  if (!implDecl) {
    return undefined;
  }
  const traitDecl = ctx.decls.getTrait(traitSymbol);
  const traitHirDecl = ctx.traits.getDecl(traitSymbol);
  if (
    (!traitDecl || traitDecl.methods.length === 0) &&
    (!traitHirDecl || traitHirDecl.methods.length === 0)
  ) {
    return undefined;
  }
  const traitMethodsBySymbol = new Map(
    traitHirDecl?.methods.map((method) => [method.symbol, method]) ?? [],
  );
  const implFunctionsBySymbol = new Map(
    implDecl.methods.map((method) => [
      method.symbol,
      ctx.functions.getFunction(method.symbol),
    ]),
  );
  const traitTypeSubstitutions = buildTraitTypeSubstitutions({
    traitTypeParameters:
      traitHirDecl?.typeParameters ?? traitDecl?.typeParameters,
    traitExpr: impl.trait,
  });

  if (!traitDecl) {
    const traitMethodSignatures = buildTraitMethodSignatureInfosFromHir({
      traitMethods: traitHirDecl?.methods ?? [],
      ctx,
      traitTypeSubstitutions,
      selfType: impl.target,
    });
    assertUniqueMethodSignatures({
      traitName: getSymbolName(traitSymbol, ctx),
      methods: traitMethodSignatures,
    });
    const implMethodSignatures = buildImplMethodSignatureInfos({
      implMethods: implDecl.methods,
      implFunctionsBySymbol,
      ctx,
      traitTypeSubstitutions,
      selfType: impl.target,
    });
    const dispatchTraitMethodSignatures = traitMethodSignatures.filter(
      (method) => method.hasSelfReceiver,
    );
    if (dispatchTraitMethodSignatures.length === 0) {
      return undefined;
    }
    const methodMap = buildTraitMethodMapByExactSignature({
      traitMethods: dispatchTraitMethodSignatures,
      implMethods: implMethodSignatures,
      ambiguousMessage: (method) =>
        `trait method mapping is ambiguous for ${method.display}`,
    });
    return methodMap.size > 0 ? methodMap : undefined;
  }

  const traitMethodSignatures = buildTraitMethodSignatureInfos({
    traitMethods: traitDecl.methods,
    traitMethodsBySymbol,
    ctx,
    traitTypeSubstitutions,
    selfType: impl.target,
  });
  assertUniqueMethodSignatures({
    traitName: getSymbolName(traitSymbol, ctx),
    methods: traitMethodSignatures,
  });
  const implMethodSignatures = buildImplMethodSignatureInfos({
    implMethods: implDecl.methods,
    implFunctionsBySymbol,
    ctx,
    traitTypeSubstitutions,
    selfType: impl.target,
  });
  const dispatchTraitMethodSignatures = traitMethodSignatures.filter(
    (method) => method.hasSelfReceiver,
  );
  if (dispatchTraitMethodSignatures.length === 0) {
    return undefined;
  }
  const methodMap = buildTraitMethodMapByExactSignature({
    traitMethods: dispatchTraitMethodSignatures,
    implMethods: implMethodSignatures,
    ambiguousMessage: (method) =>
      `trait method mapping is ambiguous for ${method.display}`,
  });
  return methodMap.size > 0 ? methodMap : undefined;
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
