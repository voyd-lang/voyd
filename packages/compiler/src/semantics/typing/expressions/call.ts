import type {
  HirCallExpr,
  HirExpression,
  HirMethodCallExpr,
  HirOverloadSetExpr,
  HirTypeExpr,
} from "../../hir/index.js";
import type {
  HirExprId,
  SourceSpan,
  SymbolId,
  TypeId,
  TypeParamId,
} from "../../ids.js";
import type { ModuleExportEntry } from "../../modules.js";
import { intrinsicValueMetadataFor } from "../../intrinsics.js";
import {
  bindTypeParamsFromType,
  ensureTypeMatches,
  getNominalComponent,
  getPrimitiveType,
  getStructuralFields,
  resolveTypeExpr,
  typeSatisfies,
  getSymbolName,
  unifyWithBudget,
} from "../type-system.js";
import {
  getOptionalInfo,
  optionalResolverContextForTypingContext,
} from "../optionals.js";
import { emitDiagnostic, normalizeSpan } from "../../../diagnostics/index.js";
import {
  composeEffectRows,
  freshOpenEffectRow,
  getExprEffectRow,
  ensureEffectCompatibility,
  applyEffectRowSubstitution,
} from "../effects.js";
import {
  intrinsicSignaturesFor,
  type IntrinsicSignature,
} from "./intrinsics.js";
import {
  buildCallArgumentHintSubstitution,
  typeCallArgsWithSignatureContext,
} from "./call-arg-context.js";
import {
  filterCandidatesByExpectedReturnType,
  filterCandidatesByExplicitTypeArguments,
  type ExpectedCallContext,
} from "./overload-candidates.js";
import { typeExpression } from "../expressions.js";
import { applyCurrentSubstitution } from "./shared.js";
import { getValueType } from "./identifier.js";
import { assertMutableObjectBinding, findBindingSymbol } from "./mutability.js";
import type {
  Arg,
  CallArgumentPlanEntry,
  DependencySemantics,
  FunctionSignature,
  FunctionTypeParam,
  ParamSignature,
  TypingContext,
  TypingState,
} from "../types.js";
import { typeDescriptorToUserString } from "../type-arena.js";
import { assertMemberAccess } from "../visibility.js";
import { symbolRefEquals, type SymbolRef } from "../symbol-ref.js";
import {
  canonicalSymbolRefForTypingContext,
  localSymbolForSymbolRef,
  symbolRefKey,
} from "../symbol-ref-utils.js";
import { createTranslation, translateFunctionSignature } from "../import-type-translation.js";
import { typingContextsShareInterners } from "../shared-interners.js";
import {
  mapDependencySymbolToLocal,
} from "../import-symbol-mapping.js";
import { hydrateImportedTraitMetadataForOwnerRef } from "../import-trait-impl-hydration.js";
import { collectTraitOwnersFromTypeParams } from "../constraint-trait-owners.js";

type SymbolNameResolver = (symbol: SymbolId) => string;
type OverloadCandidate = {
  symbol: SymbolId;
  signature: FunctionSignature;
};

type MethodCallCandidate = {
  symbol: SymbolId;
  signature: FunctionSignature;
  symbolRef: SymbolRef;
  nameForSymbol?: SymbolNameResolver;
  exported?: ModuleExportEntry;
  receiverTypeOverride?: TypeId;
};

type MethodCallResolution = {
  candidates: MethodCallCandidate[];
  receiverName?: string;
  includesMethodCandidates?: boolean;
};

type MethodCallSelection = {
  selected?: MethodCallCandidate;
  usedTraitDispatch: boolean;
};

const dependencyMethodSignatureCache = new WeakMap<
  TypingContext,
  Map<string, FunctionSignature>
>();

const ensureImportedConstraintTraitsForSignature = ({
  signature,
  dependency,
  ctx,
}: {
  signature: FunctionSignature;
  dependency: DependencySemantics;
  ctx: TypingContext;
}): void => {
  const owners = collectTraitOwnersFromTypeParams({
    typeParams: signature.typeParams,
    arena: dependency.typing.arena,
  });

  owners.forEach((owner) => {
    hydrateImportedTraitMetadataForOwnerRef({
      ownerModuleId: owner.moduleId,
      ownerSymbol: owner.symbol,
      preferredDependency: dependency,
      ctx,
    });
  });
};

const getDependencyMethodSignature = ({
  dependency,
  symbol,
  ctx,
}: {
  dependency: DependencySemantics;
  symbol: SymbolId;
  ctx: TypingContext;
}): FunctionSignature | undefined => {
  const signature = dependency.typing.functions.getSignature(symbol);
  if (!signature) {
    return undefined;
  }
  ensureImportedConstraintTraitsForSignature({ signature, dependency, ctx });
  if (
    typingContextsShareInterners({
      sourceArena: dependency.typing.arena,
      targetArena: ctx.arena,
      sourceEffects: dependency.typing.effects,
      targetEffects: ctx.effects,
    })
  ) {
    return signature;
  }

  const cache =
    dependencyMethodSignatureCache.get(ctx) ??
    (() => {
      const created = new Map<string, FunctionSignature>();
      dependencyMethodSignatureCache.set(ctx, created);
      return created;
    })();
  const key = `${dependency.moduleId}:${symbol}`;
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }

  const paramMap = new Map<TypeParamId, TypeParamId>();
  const translation = createTranslation({
    sourceArena: dependency.typing.arena,
    targetArena: ctx.arena,
    sourceEffects: dependency.typing.effects,
    targetEffects: ctx.effects,
    paramMap,
    cache: new Map(),
    mapSymbol: (owner) =>
      mapDependencySymbolToLocal({
        owner,
        dependency,
        ctx,
        allowUnexported: true,
      }),
  });
  const translated = translateFunctionSignature({
    signature,
    translation,
    dependency,
    ctx,
    paramMap,
  }).signature;
  cache.set(key, translated);
  return translated;
};

export const typeCallExpr = (
  expr: HirCallExpr,
  ctx: TypingContext,
  state: TypingState,
  expectedReturnType?: TypeId,
): TypeId => {
  const calleeExpr = ctx.hir.expressions.get(expr.callee);
  if (!calleeExpr) {
    throw new Error(`missing callee expression ${expr.callee}`);
  }

  const typeArguments =
    expr.typeArguments && expr.typeArguments.length > 0
      ? resolveTypeArguments(expr.typeArguments, ctx, state)
      : undefined;

  const expectedCallContext = getExpectedCallParameters({
    callee: calleeExpr,
    typeArguments,
    expectedReturnType,
    callSpan: expr.span,
    ctx,
    state,
  });
  const expectedParams = expectedCallContext.params;
  const shouldDeferLambdaProbeTyping = calleeExpr.exprKind === "overload-set";

  const args = expr.args.map((arg, index) => {
    const expectedType = expectedParams?.[index];
    const shouldDeferLambdaArgTyping =
      shouldDeferLambdaProbeTyping &&
      ctx.hir.expressions.get(arg.expr)?.exprKind === "lambda" &&
      (typeof expectedType !== "number" ||
        expectedType === ctx.primitives.unknown);
    return {
      label: arg.label,
      type: shouldDeferLambdaArgTyping
        ? ctx.primitives.unknown
        : typeExpression(arg.expr, ctx, state, { expectedType }),
      exprId: arg.expr,
    };
  });

  const argEffectRow = composeEffectRows(
    ctx.effects,
    args.map((arg) =>
      typeof arg.exprId === "number"
        ? getExprEffectRow(arg.exprId, ctx)
        : ctx.effects.emptyRow,
    ),
  );

  const finalizeCall = ({
    returnType,
    latentEffectRow = ctx.effects.emptyRow,
    calleeEffectRow = ctx.effects.emptyRow,
  }: {
    returnType: TypeId;
    latentEffectRow?: number;
    calleeEffectRow?: number;
  }): TypeId => {
    const callEffect = composeEffectRows(ctx.effects, [
      calleeEffectRow,
      argEffectRow,
      latentEffectRow,
    ]);
    ctx.effects.setExprEffect(expr.id, callEffect);
    return returnType;
  };

  if (calleeExpr.exprKind === "overload-set") {
    const probeArgs = args;
    ctx.table.setExprType(calleeExpr.id, ctx.primitives.unknown);
    ctx.effects.setExprEffect(calleeExpr.id, ctx.effects.emptyRow);
    const overloaded = typeOverloadedCall(
      expr,
      calleeExpr,
      probeArgs,
      ctx,
      state,
      expectedReturnType,
      typeArguments,
      expectedCallContext.expectedReturnCandidates,
    );
    return finalizeCall({
      returnType: overloaded.returnType,
      latentEffectRow: overloaded.effectRow,
    });
  }

  if (calleeExpr.exprKind === "identifier") {
    const record = ctx.symbolTable.getSymbol(calleeExpr.symbol);
    const metadata = (record.metadata ?? {}) as {
      intrinsic?: boolean;
      intrinsicName?: string;
      intrinsicUsesSignature?: boolean;
      unresolved?: boolean;
    };
    if (metadata.unresolved === true) {
      return reportUnknownFunction({
        name: record.name,
        span: calleeExpr.span ?? expr.span,
        ctx,
      });
    }
    if (record.kind === "type") {
      return emitDiagnostic({
        ctx,
        code: "TY0041",
        params: {
          kind: "symbol-not-a-value",
          name: record.name,
          symbolKind: record.kind,
        },
        span: normalizeSpan(calleeExpr.span, expr.span),
      });
    }
    assertMemberAccess({
      symbol: calleeExpr.symbol,
      ctx,
      state,
      span: calleeExpr.span ?? expr.span,
      context: "calling member",
    });
    const intrinsicName = metadata.intrinsicName ?? record.name;
    const allowIntrinsicTypeArgs =
      metadata.intrinsic === true &&
      typeof metadata.intrinsicName === "string" &&
      metadata.intrinsicName !== record.name;
    const signature = ctx.functions.getSignature(calleeExpr.symbol);
    const intrinsicSignatures = intrinsicSignaturesFor(record.name, ctx);
    const intrinsicSignatureCount = intrinsicSignatures?.length ?? 0;

    const operatorOverload =
      metadata.intrinsic === true && intrinsicSignatureCount > 0
        ? typeOperatorOverloadCall({
            call: expr,
            callee: calleeExpr,
            operatorName: record.name,
            args,
            ctx,
            state,
            typeArguments,
            expectedReturnType,
          })
        : undefined;
    if (operatorOverload) {
      return finalizeCall({
        returnType: operatorOverload.returnType,
        latentEffectRow: operatorOverload.effectRow,
      });
    }

    const hasIntrinsicHandler =
      metadata.intrinsicUsesSignature === false || intrinsicSignatureCount > 0;

    const missingFunction =
      metadata.intrinsic === true && !signature && !hasIntrinsicHandler;

    if (missingFunction) {
      return reportUnknownFunction({
        name: intrinsicName,
        span: calleeExpr.span ?? expr.span,
        ctx,
      });
    }

    const intrinsicFallbackForIdentifier =
      metadata.intrinsic !== true && signature
        ? resolveIntrinsicFallbackForIdentifierCall({
            call: expr,
            calleeSymbol: calleeExpr.symbol,
            signature,
            args,
            ctx,
            state,
            typeArguments,
          })
        : undefined;
    if (intrinsicFallbackForIdentifier) {
      ctx.table.setExprType(calleeExpr.id, intrinsicFallbackForIdentifier.calleeType);
      ctx.resolvedExprTypes.set(
        calleeExpr.id,
        applyCurrentSubstitution(
          intrinsicFallbackForIdentifier.calleeType,
          ctx,
          state,
        ),
      );
      ctx.effects.setExprEffect(calleeExpr.id, ctx.effects.emptyRow);
      return finalizeCall({
        returnType: intrinsicFallbackForIdentifier.returnType,
        latentEffectRow: intrinsicFallbackForIdentifier.effectRow,
      });
    }

    if (metadata.intrinsic && metadata.intrinsicUsesSignature === false) {
      const returnType = typeIntrinsicCall(
        intrinsicName,
        args,
        ctx,
        state,
        typeArguments,
        allowIntrinsicTypeArgs,
        expr.span,
      );
      const calleeType =
        signature?.typeId ??
        ctx.arena.internFunction({
          parameters: args.map(({ type, label }) => ({
            type,
            label,
            optional: false,
          })),
          returnType,
          effectRow: ctx.primitives.defaultEffectRow,
        });
      ctx.table.setExprType(calleeExpr.id, calleeType);
      ctx.resolvedExprTypes.set(
        calleeExpr.id,
        applyCurrentSubstitution(calleeType, ctx, state),
      );
      return finalizeCall({
        returnType,
        latentEffectRow:
          signature?.effectRow ?? ctx.primitives.defaultEffectRow,
      });
    }

    let intrinsicReturn: TypeId | undefined;
    const isRawIntrinsic =
      metadata.intrinsic === true &&
      !signature &&
      metadata.intrinsicUsesSignature !== true &&
      intrinsicSignatureCount === 0;

    const calleeType = isRawIntrinsic
      ? (() => {
          intrinsicReturn = typeIntrinsicCall(
            intrinsicName,
            args,
            ctx,
            state,
            typeArguments,
            allowIntrinsicTypeArgs,
            expr.span,
          );
          return ctx.arena.internFunction({
            parameters: args.map(({ type, label }) => ({
              type,
              label,
              optional: false,
            })),
            returnType: intrinsicReturn,
            effectRow: ctx.primitives.defaultEffectRow,
          });
        })()
      : signature ||
          !metadata.intrinsic ||
          intrinsicSignatures.length > 0
        ? getValueType(calleeExpr.symbol, ctx, {
            span: calleeExpr.span ?? expr.span,
            mode: state.mode,
          })
        : expectedCalleeType(args, ctx);
    ctx.table.setExprType(calleeExpr.id, calleeType);
    ctx.resolvedExprTypes.set(
      calleeExpr.id,
      applyCurrentSubstitution(calleeType, ctx, state),
    );
    ctx.effects.setExprEffect(calleeExpr.id, ctx.effects.emptyRow);

    if (signature) {
      const shouldTryIntrinsicFallback =
        metadata.intrinsic !== true &&
        intrinsicSignatureCount > 0 &&
        !matchesOverloadSignature(
          calleeExpr.symbol,
          signature,
          args,
          ctx,
          state,
          typeArguments,
        );
      if (shouldTryIntrinsicFallback) {
        const intrinsicFallback = typeIntrinsicFallbackCall({
          name: record.name,
          args,
          typeArguments,
          callId: expr.id,
          callSpan: expr.span,
          calleeExprId: calleeExpr.id,
          ctx,
          state,
        });
        if (intrinsicFallback) {
          return finalizeCall({
            returnType: intrinsicFallback.returnType,
            latentEffectRow: intrinsicFallback.effectRow,
          });
        }
      }

      const calleeRef = canonicalSymbolRefForTypingContext(
        calleeExpr.symbol,
        ctx,
      );
      const { returnType, effectRow } = typeFunctionCall({
        args,
        signature,
        calleeSymbol: calleeExpr.symbol,
        typeArguments,
        expectedReturnType,
        callId: expr.id,
        calleeExprId: calleeExpr.id,
        calleeModuleId: calleeRef.moduleId,
        ctx,
        state,
      });

      return finalizeCall({ returnType, latentEffectRow: effectRow });
    }

    if (metadata.intrinsic) {
      return finalizeCall({
        returnType: typeIntrinsicCall(
          intrinsicName,
          args,
          ctx,
          state,
          typeArguments,
          allowIntrinsicTypeArgs,
          expr.span,
        ),
        latentEffectRow: ctx.primitives.defaultEffectRow,
      });
    }

    const returnType =
      intrinsicReturn ??
      resolveCurriedCallReturnType({
        args,
        calleeType,
        ctx,
        state,
        callSpan: expr.span,
        calleeSpan: calleeExpr.span,
      });
    const calleeDesc = ctx.arena.get(calleeType);
    const latentEffectRow =
      calleeDesc.kind === "function"
        ? calleeDesc.effectRow
        : ctx.primitives.defaultEffectRow;
    return finalizeCall({
      returnType,
      latentEffectRow,
    });
  }

  const calleeType = typeExpression(expr.callee, ctx, state, {
    expectedType: expectedCalleeType(args, ctx),
  });

  if (expr.typeArguments && expr.typeArguments.length > 0) {
    throw new Error("call does not accept type arguments");
  }

  const calleeDesc = ctx.arena.get(calleeType);
  if (calleeDesc.kind !== "function") {
    reportNonFunctionCallee({
      callSpan: expr.span,
      calleeSpan: calleeExpr.span,
      ctx,
    });
  }

  const returnType = resolveCurriedCallReturnType({
    args,
    calleeType,
    ctx,
    state,
    callSpan: expr.span,
    calleeSpan: calleeExpr.span,
  });
  const latentEffectRow =
    calleeDesc.kind === "function"
      ? calleeDesc.effectRow
      : ctx.primitives.defaultEffectRow;
  return finalizeCall({
    returnType,
    latentEffectRow,
    calleeEffectRow: getExprEffectRow(expr.callee, ctx),
  });
};

const resolveSymbolName = (
  symbol: SymbolId,
  ctx: TypingContext,
  nameForSymbol?: SymbolNameResolver,
): string =>
  nameForSymbol ? nameForSymbol(symbol) : getSymbolName(symbol, ctx);

export const typeMethodCallExpr = (
  expr: HirMethodCallExpr,
  ctx: TypingContext,
  state: TypingState,
  expectedReturnType?: TypeId,
): TypeId => {
  const typeArguments =
    expr.typeArguments && expr.typeArguments.length > 0
      ? resolveTypeArguments(expr.typeArguments, ctx, state)
      : undefined;

  const targetType = typeExpression(expr.target, ctx, state);
  ctx.table.pushExprTypeScope();
  const probeArgs: Arg[] = [
    { type: targetType, exprId: expr.target },
    ...expr.args.map((arg) => ({
      label: arg.label,
      type:
        ctx.hir.expressions.get(arg.expr)?.exprKind === "lambda"
          ? ctx.primitives.unknown
          : typeExpression(arg.expr, ctx, state),
      exprId: arg.expr,
    })),
  ];
  ctx.table.popExprTypeScope();

  const argEffectRowFor = (args: readonly Arg[]): number =>
    composeEffectRows(
      ctx.effects,
      args.map((arg) =>
        typeof arg.exprId === "number"
          ? getExprEffectRow(arg.exprId, ctx)
          : ctx.effects.emptyRow,
      ),
    );

  const finalizeCall = ({
    returnType,
    latentEffectRow = ctx.effects.emptyRow,
    argsForEffects = probeArgs,
  }: {
    returnType: TypeId;
    latentEffectRow?: number;
    argsForEffects?: readonly Arg[];
  }): TypeId => {
    const callEffect = composeEffectRows(ctx.effects, [
      argEffectRowFor(argsForEffects),
      latentEffectRow,
    ]);
    ctx.effects.setExprEffect(expr.id, callEffect);
    return returnType;
  };

  if (targetType === ctx.primitives.unknown) {
    return finalizeCall({ returnType: ctx.primitives.unknown });
  }

  const resolution =
    typeof expr.traitSymbol === "number"
      ? resolveQualifiedTraitMethodCallCandidates({
          receiverType: targetType,
          traitSymbol: expr.traitSymbol,
          methodName: expr.method,
          ctx,
        })
      : resolveMethodCallCandidates({
          receiverType: targetType,
          methodName: expr.method,
          ctx,
        });
  const selection = selectMethodCallCandidate({
    expr,
    resolution,
    probeArgs,
    typeArguments,
    ctx,
    state,
  });
  const selected = selection.selected;

  if (!selected) {
    return finalizeCall({ returnType: ctx.primitives.unknown });
  }

  const instanceKey = state.currentFunction?.instanceKey;
  if (!instanceKey) {
    throw new Error(`missing function instance key for method call ${expr.id}`);
  }

  if (selection.usedTraitDispatch) {
    ctx.callResolution.traitDispatches.add(expr.id);
  } else {
    ctx.callResolution.traitDispatches.delete(expr.id);
  }

  if (!selection.usedTraitDispatch) {
    if (selected.exported) {
      assertExportedMemberAccess({
        exported: selected.exported,
        methodName: expr.method,
        ctx,
        state,
        span: expr.span,
      });
    } else if (selected.symbolRef.moduleId === ctx.moduleId) {
      assertMemberAccess({
        symbol: selected.symbol,
        ctx,
        state,
        span: expr.span,
        context: "calling member",
      });
    }
  }

  const selectedRef =
    selected.symbolRef ??
    canonicalSymbolRefForTypingContext(selected.symbol, ctx);
  const targets =
    ctx.callResolution.targets.get(expr.id) ?? new Map<string, SymbolRef>();
  targets.set(instanceKey, selectedRef);
  ctx.callResolution.targets.set(expr.id, targets);

  const receiverType = selected.receiverTypeOverride ?? targetType;
  if (selected.receiverTypeOverride) {
    ctx.resolvedExprTypes.set(expr.target, receiverType);
  }

  const hintArgs =
    selected.receiverTypeOverride && probeArgs.length > 0
      ? [{ ...probeArgs[0]!, type: receiverType }, ...probeArgs.slice(1)]
      : probeArgs;
  const hintSubstitution = buildCallArgumentHintSubstitution({
    signature: selected.signature,
    probeArgs: hintArgs,
    expectedReturnType,
    seedSubstitution: mergeExplicitTypeArgumentSubstitution({
      signature: selected.signature,
      typeArguments,
      calleeSymbol: selected.symbol,
      seedSubstitution: getTraitMethodTypeBindings({
        calleeSymbol: selected.symbol,
        calleeModuleId: selectedRef.moduleId,
        receiverType,
        signature: selected.signature,
        ctx,
        state,
      }),
      ctx,
    }),
    ctx,
    state,
  });

  const args: Arg[] = [
    { type: receiverType, exprId: expr.target },
    ...typeCallArgsWithSignatureContext({
      args: expr.args,
      signature: selected.signature,
      paramOffset: 1,
      hintSubstitution,
      ctx,
      state,
    }),
  ];

  const { returnType, effectRow } = typeFunctionCall({
    args,
    signature: selected.signature,
    calleeSymbol: selected.symbol,
    typeArguments,
    expectedReturnType,
    callId: expr.id,
    ctx,
    state,
    calleeModuleId: selectedRef.moduleId,
    nameForSymbol: selected.nameForSymbol,
  });

  return finalizeCall({
    returnType,
    latentEffectRow: effectRow,
    argsForEffects: args,
  });
};

const getExpectedCallParameters = ({
  callee,
  typeArguments,
  expectedReturnType,
  callSpan,
  ctx,
  state,
}: {
  callee: HirExpression;
  typeArguments: readonly TypeId[] | undefined;
  expectedReturnType: TypeId | undefined;
  callSpan?: SourceSpan;
  ctx: TypingContext;
  state: TypingState;
}): ExpectedCallContext => {
  if (
    callee.exprKind === "overload-set" &&
    typeof expectedReturnType === "number" &&
    expectedReturnType !== ctx.primitives.unknown
  ) {
    const overloads = ctx.overloads.get(callee.set);
    if (!overloads) {
      return {};
    }
    const candidates = overloads
      .map((symbol) => {
        const signature = ctx.functions.getSignature(symbol);
        return signature ? { symbol, signature } : undefined;
      })
      .filter(
        (entry): entry is { symbol: SymbolId; signature: FunctionSignature } =>
          Boolean(entry),
      );
    const explicitTypeMatches = filterCandidatesByExplicitTypeArguments({
      candidates,
      typeArguments,
    });
    const matchingReturn = filterCandidatesByExpectedReturnType({
      candidates: explicitTypeMatches,
      expectedReturnType,
      typeArguments,
      ctx,
      state,
    });
    enforceOverloadCandidateBudget({
      name: callee.name,
      candidateCount: matchingReturn.length,
      ctx,
      span: callSpan ?? callee.span,
    });
    if (matchingReturn.length === 0) {
      return {};
    }
    const expectedReturnCandidates = new Set(
      matchingReturn.map((candidate) => candidate.symbol),
    );
    if (matchingReturn.length !== 1) {
      return { expectedReturnCandidates };
    }
    const selected = matchingReturn[0]!;
    const substitution =
      selected.signature.typeParams && selected.signature.typeParams.length > 0
        ? applyExplicitTypeArguments({
            signature: selected.signature,
            typeArguments,
            calleeSymbol: selected.symbol,
            ctx,
          })
        : undefined;
    return {
      params: selected.signature.parameters.map((param) =>
        substitution ? ctx.arena.substitute(param.type, substitution) : param.type,
      ),
      expectedReturnCandidates,
    };
  }

  if (callee.exprKind !== "identifier") {
    return {};
  }
  const signature = ctx.functions.getSignature(callee.symbol);
  if (!signature) {
    return {};
  }
  const substitution =
    signature.typeParams && signature.typeParams.length > 0
      ? applyExplicitTypeArguments({
          signature,
          typeArguments,
          calleeSymbol: callee.symbol,
          ctx,
        })
      : undefined;
  return {
    params: signature.parameters.map((param) =>
      substitution ? ctx.arena.substitute(param.type, substitution) : param.type,
    ),
  };
};

const applyExplicitTypeArguments = ({
  signature,
  typeArguments,
  calleeSymbol,
  ctx,
}: {
  signature: FunctionSignature;
  typeArguments: readonly TypeId[] | undefined;
  calleeSymbol: SymbolId;
  ctx: TypingContext;
}): ReadonlyMap<TypeParamId, TypeId> | undefined => {
  if (!typeArguments || typeArguments.length === 0) {
    return undefined;
  }
  const params = signature.typeParams ?? [];
  if (typeArguments.length > params.length) {
    throw new Error(
      `function ${getSymbolName(
        calleeSymbol,
        ctx,
      )} received too many type arguments`,
    );
  }
  const substitution = new Map<TypeParamId, TypeId>();
  params.forEach((param, index) => {
    const arg = typeArguments[index];
    if (typeof arg === "number") {
      substitution.set(param.typeParam, arg);
    }
  });
  return substitution.size > 0 ? substitution : undefined;
};

const mergeExplicitTypeArgumentSubstitution = ({
  signature,
  typeArguments,
  calleeSymbol,
  seedSubstitution,
  ctx,
}: {
  signature: FunctionSignature;
  typeArguments: readonly TypeId[] | undefined;
  calleeSymbol: SymbolId;
  seedSubstitution?: ReadonlyMap<TypeParamId, TypeId>;
  ctx: TypingContext;
}): ReadonlyMap<TypeParamId, TypeId> | undefined => {
  const explicitSubstitution =
    signature.typeParams && signature.typeParams.length > 0
      ? applyExplicitTypeArguments({
          signature,
          typeArguments,
          calleeSymbol,
          ctx,
        })
      : undefined;

  if (!seedSubstitution || seedSubstitution.size === 0) {
    return explicitSubstitution;
  }
  if (!explicitSubstitution || explicitSubstitution.size === 0) {
    return seedSubstitution;
  }

  const merged = new Map<TypeParamId, TypeId>(seedSubstitution);
  explicitSubstitution.forEach((value, key) => merged.set(key, value));
  return merged;
};

const findMatchingOverloadCandidates = <
  T extends { symbol: SymbolId; signature: FunctionSignature },
>({
  candidates,
  args,
  ctx,
  state,
  typeArguments,
  argsForCandidate,
}: {
  candidates: readonly T[];
  args: readonly Arg[];
  ctx: TypingContext;
  state: TypingState;
  typeArguments?: readonly TypeId[];
  argsForCandidate?: (candidate: T) => readonly Arg[];
}): T[] =>
  candidates.filter((candidate) =>
    matchesOverloadSignature(
      candidate.symbol,
      candidate.signature,
      argsForCandidate ? argsForCandidate(candidate) : args,
      ctx,
      state,
      typeArguments,
    ),
  );

const enforceOverloadCandidateBudget = ({
  name,
  candidateCount,
  ctx,
  span,
}: {
  name: string;
  candidateCount: number;
  ctx: TypingContext;
  span?: SourceSpan;
}): void => {
  if (candidateCount <= ctx.typeCheckBudget.maxOverloadCandidates) {
    return;
  }
  emitDiagnostic({
    ctx,
    code: "TY0041",
    params: {
      kind: "overload-candidate-budget-exceeded",
      name,
      candidates: candidateCount,
      maxCandidates: ctx.typeCheckBudget.maxOverloadCandidates,
    },
    span: normalizeSpan(span, ctx.hir.module.span),
  });
};

const expectedCalleeType = (args: readonly Arg[], ctx: TypingContext): TypeId =>
  ctx.arena.internFunction({
    parameters: args.map(({ type, label }) => ({
      type,
      label,
      optional: false,
    })),
    returnType: ctx.primitives.unknown,
    effectRow: freshOpenEffectRow(ctx.effects),
  });

const resolveTypeArguments = (
  typeArguments: readonly HirTypeExpr[] | undefined,
  ctx: TypingContext,
  state: TypingState,
): TypeId[] | undefined =>
  typeArguments && typeArguments.length > 0
    ? typeArguments.map((entry) =>
        resolveTypeExpr(
          entry,
          ctx,
          state,
          ctx.primitives.unknown,
          state.currentFunction?.typeParams,
        ),
      )
    : undefined;

const labelsCompatible = (
  param: ParamSignature,
  argLabel: string | undefined,
): boolean => {
  if (!param.label) {
    return argLabel === undefined;
  }
  return argLabel === param.label;
};

const labelForDiagnostic = (label: string | undefined): string | undefined =>
  label && label.length > 0 ? label : undefined;

const spanForArg = (arg: Arg, ctx: TypingContext): SourceSpan | undefined => {
  if (typeof arg.exprId !== "number") {
    return undefined;
  }
  return ctx.hir.expressions.get(arg.exprId)?.span;
};

const spanForObjectLiteralFieldValue = (
  arg: Arg,
  fieldName: string,
  ctx: TypingContext,
): SourceSpan | undefined => {
  if (typeof arg.exprId !== "number") {
    return undefined;
  }

  const argExpr = ctx.hir.expressions.get(arg.exprId);
  if (argExpr?.exprKind !== "object-literal") {
    return spanForArg(arg, ctx);
  }

  const field = argExpr.entries.find(
    (entry) => entry.kind === "field" && entry.name === fieldName,
  );
  if (!field || field.kind !== "field") {
    return argExpr.span;
  }

  return ctx.hir.expressions.get(field.value)?.span ?? field.span;
};

type MatchedCallArgument = {
  arg: Arg;
  argIndex: number;
  param: ParamSignature;
  paramIndex: number;
  matchedType: TypeId;
  matchedExprId?: HirExprId;
  kind: "direct" | "structural-field";
  fieldName?: string;
};

type SkippedOptionalCallParameter = {
  param: ParamSignature;
  paramIndex: number;
  reason: "missing-argument" | "structural-missing-field" | "label-mismatch";
};

type CallArgumentWalkFailure =
  | { kind: "missing-argument"; paramIndex: number }
  | { kind: "missing-labeled-argument"; paramIndex: number; label: string }
  | {
      kind: "label-mismatch";
      paramIndex: number;
      argIndex: number;
      expectedLabel?: string;
      actualLabel?: string;
    }
  | { kind: "extra-arguments"; extra: number }
  | { kind: "incompatible"; paramIndex: number; argIndex?: number };

type CallArgumentWalkResult =
  | { kind: "ok" }
  | { kind: "error"; failure: CallArgumentWalkFailure };

const resolveStructuralMatchedExprId = ({
  arg,
  fieldName,
  ctx,
}: {
  arg: Arg;
  fieldName: string;
  ctx: TypingContext;
}): HirExprId | undefined => {
  if (typeof arg.exprId !== "number") {
    return undefined;
  }
  const argExpr = ctx.hir.expressions.get(arg.exprId);
  if (argExpr?.exprKind !== "object-literal") {
    return arg.exprId;
  }
  const directField = argExpr.entries.find(
    (entry) => entry.kind === "field" && entry.name === fieldName,
  );
  return directField?.kind === "field" ? directField.value : arg.exprId;
};

const walkCallArguments = ({
  args,
  params,
  ctx,
  state,
  onMatch,
  onSkipOptionalParam,
}: {
  args: readonly Arg[];
  params: readonly ParamSignature[];
  ctx: TypingContext;
  state: TypingState;
  onMatch: (match: MatchedCallArgument) => boolean;
  onSkipOptionalParam: (skipped: SkippedOptionalCallParameter) => boolean;
}): CallArgumentWalkResult => {
  let argIndex = 0;
  let paramIndex = 0;

  while (paramIndex < params.length) {
    const param = params[paramIndex]!;
    const arg = args[argIndex];

    if (!arg) {
      if (param.optional) {
        if (
          !onSkipOptionalParam({
            param,
            paramIndex,
            reason: "missing-argument",
          })
        ) {
          return {
            kind: "error",
            failure: { kind: "incompatible", paramIndex },
          };
        }
        paramIndex += 1;
        continue;
      }
      return { kind: "error", failure: { kind: "missing-argument", paramIndex } };
    }

    if (param.label && arg.label === undefined) {
      const structuralFields = getStructuralFields(arg.type, ctx, state);
      if (structuralFields) {
        let cursor = paramIndex;
        while (cursor < params.length) {
          const runParam = params[cursor]!;
          if (!runParam.label) {
            break;
          }
          const match = structuralFields.find(
            (field) => field.name === runParam.label,
          );
          if (match) {
            if (
              !onMatch({
                arg,
                argIndex,
                param: runParam,
                paramIndex: cursor,
                matchedType: match.type,
                matchedExprId: resolveStructuralMatchedExprId({
                  arg,
                  fieldName: runParam.label,
                  ctx,
                }),
                kind: "structural-field",
                fieldName: runParam.label,
              })
            ) {
              return {
                kind: "error",
                failure: { kind: "incompatible", paramIndex: cursor, argIndex },
              };
            }
            cursor += 1;
            continue;
          }
          if (runParam.optional) {
            if (
              !onSkipOptionalParam({
                param: runParam,
                paramIndex: cursor,
                reason: "structural-missing-field",
              })
            ) {
              return {
                kind: "error",
                failure: { kind: "incompatible", paramIndex: cursor, argIndex },
              };
            }
            cursor += 1;
            continue;
          }
          return {
            kind: "error",
            failure: {
              kind: "missing-labeled-argument",
              paramIndex: cursor,
              label: runParam.label,
            },
          };
        }

        if (cursor > paramIndex) {
          paramIndex = cursor;
          argIndex += 1;
          continue;
        }
      }
    }

    if (labelsCompatible(param, arg.label)) {
      if (
        !onMatch({
          arg,
          argIndex,
          param,
          paramIndex,
          matchedType: arg.type,
          matchedExprId: arg.exprId,
          kind: "direct",
        })
      ) {
        return {
          kind: "error",
          failure: { kind: "incompatible", paramIndex, argIndex },
        };
      }
      argIndex += 1;
      paramIndex += 1;
      continue;
    }

    if (param.optional) {
      if (
        !onSkipOptionalParam({
          param,
          paramIndex,
          reason: "label-mismatch",
        })
      ) {
        return {
          kind: "error",
          failure: { kind: "incompatible", paramIndex, argIndex },
        };
      }
      paramIndex += 1;
      continue;
    }

    return {
      kind: "error",
      failure: {
        kind: "label-mismatch",
        paramIndex,
        argIndex,
        expectedLabel: labelForDiagnostic(param.label),
        actualLabel: labelForDiagnostic(arg.label),
      },
    };
  }

  if (argIndex < args.length) {
    return {
      kind: "error",
      failure: { kind: "extra-arguments", extra: args.length - argIndex },
    };
  }

  return { kind: "ok" };
};

const ensureOptionalParameterIsSkippable = ({
  param,
  paramIndex,
  ctx,
  state,
  callSpan,
  fallbackSpan,
}: {
  param: ParamSignature;
  paramIndex: number;
  ctx: TypingContext;
  state: TypingState;
  callSpan?: SourceSpan;
  fallbackSpan: SourceSpan;
}): void => {
  const optionalInfo = getOptionalInfo(
    param.type,
    optionalResolverContextForTypingContext(ctx),
  );
  if (!optionalInfo) {
    throw new Error("optional parameter type must be Optional");
  }
  ensureTypeMatches(
    optionalInfo.noneType,
    param.type,
    ctx,
    state,
    `call argument ${paramIndex + 1}`,
    normalizeSpan(callSpan, param.span, fallbackSpan),
  );
};

const validateCallArgs = (
  args: readonly Arg[],
  params: readonly ParamSignature[],
  ctx: TypingContext,
  state: TypingState,
  callSpan?: SourceSpan,
): { ok: true; plan: readonly CallArgumentPlanEntry[] } | { ok: false } => {
  const span = callSpan ?? ctx.hir.module.span;
  const plan: CallArgumentPlanEntry[] = [];
  const result = walkCallArguments({
    args,
    params,
    ctx,
    state,
    onMatch: (match) => {
      const matchSpan =
        match.kind === "structural-field" && match.fieldName
          ? spanForObjectLiteralFieldValue(match.arg, match.fieldName, ctx)
          : spanForArg(match.arg, ctx);
      ensureTypeMatches(
        match.matchedType,
        match.param.type,
        ctx,
        state,
        `call argument ${match.paramIndex + 1}`,
        normalizeSpan(matchSpan, match.param.span, span),
      );
      ensureMutableArgument({
        arg: {
          ...match.arg,
          type: match.matchedType,
          exprId: match.matchedExprId ?? match.arg.exprId,
        },
        param: match.param,
        index: match.paramIndex,
        ctx,
      });
      if (match.kind === "direct") {
        plan.push({ kind: "direct", argIndex: match.argIndex });
        return true;
      }
      plan.push({
        kind: "container-field",
        containerArgIndex: match.argIndex,
        fieldName: match.fieldName!,
        targetTypeId: match.param.type,
      });
      return true;
    },
    onSkipOptionalParam: ({ param, paramIndex }) => {
      ensureOptionalParameterIsSkippable({
        param,
        paramIndex,
        ctx,
        state,
        callSpan,
        fallbackSpan: span,
      });
      plan.push({ kind: "missing", targetTypeId: param.type });
      return true;
    },
  });
  if (result.kind === "ok") {
    return { ok: true, plan };
  }

  const { failure } = result;
  switch (failure.kind) {
    case "missing-argument": {
      const param = params[failure.paramIndex]!;
      emitDiagnostic({
        ctx,
        code: "TY0021",
        params: {
          kind: "call-missing-argument",
          paramName:
            param.name ?? param.label ?? `parameter ${failure.paramIndex + 1}`,
        },
        span,
      });
      return { ok: false };
    }
    case "missing-labeled-argument":
      emitDiagnostic({
        ctx,
        code: "TY0021",
        params: {
          kind: "call-missing-labeled-argument",
          label: failure.label,
        },
        span,
      });
      return { ok: false };
    case "label-mismatch": {
      const param = params[failure.paramIndex]!;
      const arg = args[failure.argIndex];
      emitDiagnostic({
        ctx,
        code: "TY0021",
        params: {
          kind: "call-argument-label-mismatch",
          argumentIndex: failure.paramIndex + 1,
          expectedLabel: failure.expectedLabel,
          actualLabel: failure.actualLabel,
        },
        span: normalizeSpan(
          arg ? spanForArg(arg, ctx) : undefined,
          param?.span,
          span,
        ),
      });
      return { ok: false };
    }
    case "extra-arguments":
      emitDiagnostic({
        ctx,
        code: "TY0021",
        params: {
          kind: "call-extra-arguments",
          extra: failure.extra,
        },
        span,
      });
      return { ok: false };
    case "incompatible":
      throw new Error("call argument type mismatch");
  }
  return { ok: false };
};

const callArgumentsSatisfyParams = ({
  args,
  params,
  ctx,
  state,
}: {
  args: readonly Arg[];
  params: readonly ParamSignature[];
  ctx: TypingContext;
  state: TypingState;
}): boolean =>
  walkCallArguments({
    args,
    params,
    ctx,
    state,
    onMatch: (match) =>
      match.matchedType === ctx.primitives.unknown
        ? true
        : typeSatisfies(match.matchedType, match.param.type, ctx, state),
    onSkipOptionalParam: () => true,
  }).kind === "ok";

const MAX_OVERLOAD_DIAGNOSTIC_CANDIDATES = 12;

const formatTypeForDiagnostic = ({
  type,
  ctx,
}: {
  type: TypeId;
  ctx: TypingContext;
}): string => typeDescriptorToUserString(ctx.arena.get(type), ctx.arena);

const typeSatisfiesForDiagnostic = ({
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
  const originalMax = ctx.typeCheckBudget.maxUnifySteps;
  const originalSteps = ctx.typeCheckBudget.unifyStepsUsed.value;
  ctx.typeCheckBudget.maxUnifySteps = Number.MAX_SAFE_INTEGER;
  try {
    return typeSatisfies(actual, expected, ctx, state);
  } finally {
    ctx.typeCheckBudget.maxUnifySteps = originalMax;
    ctx.typeCheckBudget.unifyStepsUsed.value = originalSteps;
  }
};

const formatInferredArgumentsForDiagnostic = ({
  args,
  ctx,
}: {
  args: readonly Arg[];
  ctx: TypingContext;
}): readonly string[] =>
  args.map((arg) => {
    const typeLabel = formatTypeForDiagnostic({ type: arg.type, ctx });
    return arg.label ? `${arg.label}: ${typeLabel}` : typeLabel;
  });

const signatureWithExplicitTypeArgumentsForDiagnostic = ({
  symbol,
  signature,
  typeArguments,
  ctx,
}: {
  symbol: SymbolId;
  signature: FunctionSignature;
  typeArguments?: readonly TypeId[];
  ctx: TypingContext;
}): FunctionSignature => {
  if (!typeArguments || typeArguments.length === 0) {
    return signature;
  }

  const typeParamCount = signature.typeParams?.length ?? 0;
  if (typeArguments.length > typeParamCount) {
    return signature;
  }

  const explicitSubstitution =
    signature.typeParams && signature.typeParams.length > 0
      ? applyExplicitTypeArguments({
          signature,
          typeArguments,
          calleeSymbol: symbol,
          ctx,
        })
      : undefined;
  if (!explicitSubstitution || explicitSubstitution.size === 0) {
    return signature;
  }

  return {
    ...signature,
    parameters: signature.parameters.map((param) => ({
      ...param,
      type: ctx.arena.substitute(param.type, explicitSubstitution),
    })),
    returnType: ctx.arena.substitute(signature.returnType, explicitSubstitution),
  };
};

const formatFunctionSignatureForDiagnostic = ({
  name,
  signature,
  ctx,
}: {
  name: string;
  signature: FunctionSignature;
  ctx: TypingContext;
}): string => {
  const typeParams = signature.typeParams?.map((param) =>
    getSymbolName(param.symbol, ctx),
  );
  const typeParamSuffix =
    typeParams && typeParams.length > 0 ? `<${typeParams.join(", ")}>` : "";

  const params = signature.parameters.map((param) => {
    const typeLabel = formatTypeForDiagnostic({ type: param.type, ctx });
    const label = param.label ?? param.name;
    const labelPrefix = label ? `${label}: ` : "";
    const optionalSuffix = param.optional ? "?" : "";
    return `${labelPrefix}${typeLabel}${optionalSuffix}`;
  });
  const returnType = formatTypeForDiagnostic({ type: signature.returnType, ctx });
  return `${name}${typeParamSuffix}(${params.join(", ")}) -> ${returnType}`;
};

const formatIntrinsicSignatureForDiagnostic = ({
  name,
  signature,
  ctx,
}: {
  name: string;
  signature: IntrinsicSignature;
  ctx: TypingContext;
}): string => {
  const params = signature.parameters.map((param) =>
    formatTypeForDiagnostic({ type: param, ctx }),
  );
  const returnType = formatTypeForDiagnostic({ type: signature.returnType, ctx });
  return `${name}(${params.join(", ")}) -> ${returnType}`;
};

const overloadCandidateFailureReason = ({
  symbol,
  signature,
  args,
  ctx,
  state,
  typeArguments,
}: {
  symbol: SymbolId;
  signature: FunctionSignature;
  args: readonly Arg[];
  ctx: TypingContext;
  state: TypingState;
  typeArguments?: readonly TypeId[];
}): string | undefined => {
  const typeParamCount = signature.typeParams?.length ?? 0;
  if (typeArguments && typeArguments.length > typeParamCount) {
    return `type argument arity mismatch: expected at most ${typeParamCount}, got ${typeArguments.length}`;
  }

  const explicitSubstitution =
    signature.typeParams && signature.typeParams.length > 0
      ? applyExplicitTypeArguments({
          signature,
          typeArguments,
          calleeSymbol: symbol,
          ctx,
        })
      : undefined;
  const params = explicitSubstitution
    ? signature.parameters.map((param) => ({
        ...param,
        type: ctx.arena.substitute(param.type, explicitSubstitution),
      }))
    : signature.parameters;

  let mismatch:
    | {
        paramIndex: number;
        argIndex: number;
        expectedType: TypeId;
        actualType: TypeId;
      }
    | undefined;

  const walkResult = walkCallArguments({
    args,
    params,
    ctx,
    state,
    onMatch: (match) => {
      if (match.matchedType === ctx.primitives.unknown) {
        return true;
      }
      const ok = typeSatisfiesForDiagnostic({
        actual: match.matchedType,
        expected: match.param.type,
        ctx,
        state,
      });
      if (!ok) {
        mismatch = {
          paramIndex: match.paramIndex,
          argIndex: match.argIndex,
          expectedType: match.param.type,
          actualType: match.matchedType,
        };
      }
      return ok;
    },
    onSkipOptionalParam: () => true,
  });
  if (walkResult.kind === "ok") {
    return undefined;
  }

  const { failure } = walkResult;
  switch (failure.kind) {
    case "missing-argument": {
      const param = params[failure.paramIndex];
      const paramName =
        param?.label ?? param?.name ?? `parameter ${failure.paramIndex + 1}`;
      return `arity mismatch: missing argument for ${paramName}`;
    }
    case "missing-labeled-argument":
      return `labels mismatch: missing labeled argument ${failure.label}`;
    case "label-mismatch":
      return `labels mismatch at argument ${failure.paramIndex + 1}: expected ${failure.expectedLabel ?? "no label"}, got ${failure.actualLabel ?? "no label"}`;
    case "extra-arguments":
      return `arity mismatch: ${failure.extra} extra argument(s)`;
    case "incompatible": {
      if (mismatch) {
        const expected = formatTypeForDiagnostic({
          type: mismatch.expectedType,
          ctx,
        });
        const actual = formatTypeForDiagnostic({ type: mismatch.actualType, ctx });
        return `type incompatibility at argument ${mismatch.argIndex + 1}: expected ${expected}, got ${actual}`;
      }

      const argIndex =
        typeof failure.argIndex === "number" ? failure.argIndex : undefined;
      const arg = typeof argIndex === "number" ? args[argIndex] : undefined;
      const param = params[failure.paramIndex];
      if (arg && param && typeof argIndex === "number") {
        const expected = formatTypeForDiagnostic({ type: param.type, ctx });
        const actual = formatTypeForDiagnostic({ type: arg.type, ctx });
        return `type incompatibility at argument ${argIndex + 1}: expected ${expected}, got ${actual}`;
      }

      return "type incompatibility";
    }
  }
};

const overloadDiagnosticCandidates = <
  T extends {
    symbol: SymbolId;
    signature: FunctionSignature;
    nameForSymbol?: SymbolNameResolver;
  },
>({
  candidates,
  args,
  ctx,
  state,
  typeArguments,
  includeFailureReasons,
  argsForCandidate,
  signatureForCandidate,
}: {
  candidates: readonly T[];
  args: readonly Arg[];
  ctx: TypingContext;
  state: TypingState;
  typeArguments?: readonly TypeId[];
  includeFailureReasons: boolean;
  argsForCandidate?: (candidate: T) => readonly Arg[];
  signatureForCandidate?: (candidate: T) => FunctionSignature;
}): { signature: string; reason?: string }[] => {
  const limitedCandidates = candidates.slice(0, MAX_OVERLOAD_DIAGNOSTIC_CANDIDATES);
  const details = limitedCandidates.map((candidate) => {
    const signatureForCandidateEntry = signatureForCandidate
      ? signatureForCandidate(candidate)
      : candidate.signature;
    const signature = signatureWithExplicitTypeArgumentsForDiagnostic({
      symbol: candidate.symbol,
      signature: signatureForCandidateEntry,
      typeArguments,
      ctx,
    });
    const signatureLabel = formatFunctionSignatureForDiagnostic({
      name: resolveSymbolName(candidate.symbol, ctx, candidate.nameForSymbol),
      signature,
      ctx,
    });

    if (!includeFailureReasons) {
      return { signature: signatureLabel };
    }

    const reason = overloadCandidateFailureReason({
      symbol: candidate.symbol,
      signature: signatureForCandidateEntry,
      args: argsForCandidate ? argsForCandidate(candidate) : args,
      ctx,
      state,
      typeArguments,
    });

    return reason
      ? { signature: signatureLabel, reason }
      : { signature: signatureLabel };
  });

  const omitted = candidates.length - limitedCandidates.length;
  if (omitted > 0) {
    details.push({
      signature: `... ${omitted} more candidate(s) omitted`,
    });
  }
  return details;
};

const noOverloadDiagnosticParams = <
  T extends {
    symbol: SymbolId;
    signature: FunctionSignature;
    nameForSymbol?: SymbolNameResolver;
  },
>({
  name,
  candidates,
  args,
  ctx,
  state,
  typeArguments,
  argsForCandidate,
  signatureForCandidate,
}: {
  name: string;
  candidates: readonly T[];
  args: readonly Arg[];
  ctx: TypingContext;
  state: TypingState;
  typeArguments?: readonly TypeId[];
  argsForCandidate?: (candidate: T) => readonly Arg[];
  signatureForCandidate?: (candidate: T) => FunctionSignature;
}) => ({
  kind: "no-overload" as const,
  name,
  inferredArguments: formatInferredArgumentsForDiagnostic({ args, ctx }),
  candidates: overloadDiagnosticCandidates({
    candidates,
    args,
    ctx,
    state,
    typeArguments,
    includeFailureReasons: true,
    argsForCandidate,
    signatureForCandidate,
  }),
});

const ambiguousOverloadDiagnosticParams = <
  T extends {
    symbol: SymbolId;
    signature: FunctionSignature;
    nameForSymbol?: SymbolNameResolver;
  },
>({
  name,
  matches,
  args,
  ctx,
  state,
  typeArguments,
  argsForCandidate,
}: {
  name: string;
  matches: readonly T[];
  args: readonly Arg[];
  ctx: TypingContext;
  state: TypingState;
  typeArguments?: readonly TypeId[];
  argsForCandidate?: (candidate: T) => readonly Arg[];
}) => ({
  kind: "ambiguous-overload" as const,
  name,
  inferredArguments: formatInferredArgumentsForDiagnostic({ args, ctx }),
  candidates: overloadDiagnosticCandidates({
    candidates: matches,
    args,
    ctx,
    state,
    typeArguments,
    includeFailureReasons: false,
    argsForCandidate,
  }),
});

const intrinsicNoOverloadDiagnosticParams = ({
  name,
  signatures,
  args,
  ctx,
}: {
  name: string;
  signatures: readonly IntrinsicSignature[];
  args: readonly Arg[];
  ctx: TypingContext;
}) => {
  const details = signatures
    .slice(0, MAX_OVERLOAD_DIAGNOSTIC_CANDIDATES)
    .map((signature) => {
      const signatureLabel = formatIntrinsicSignatureForDiagnostic({
        name,
        signature,
        ctx,
      });
      if (signature.parameters.length !== args.length) {
        return {
          signature: signatureLabel,
          reason: `arity mismatch: expected ${signature.parameters.length}, got ${args.length}`,
        };
      }
      const mismatchIndex = signature.parameters.findIndex((param, index) => {
        const arg = args[index];
        return Boolean(arg && arg.type !== ctx.primitives.unknown && arg.type !== param);
      });
      if (mismatchIndex >= 0) {
        const expected = formatTypeForDiagnostic({
          type: signature.parameters[mismatchIndex]!,
          ctx,
        });
        const actual = formatTypeForDiagnostic({
          type: args[mismatchIndex]!.type,
          ctx,
        });
        return {
          signature: signatureLabel,
          reason: `type incompatibility at argument ${mismatchIndex + 1}: expected ${expected}, got ${actual}`,
        };
      }
      return { signature: signatureLabel };
    });

  const omitted = signatures.length - details.length;
  if (omitted > 0) {
    details.push({ signature: `... ${omitted} more candidate(s) omitted` });
  }

  return {
    kind: "no-overload" as const,
    name,
    inferredArguments: formatInferredArgumentsForDiagnostic({ args, ctx }),
    candidates: details,
  };
};

const intrinsicAmbiguousOverloadDiagnosticParams = ({
  name,
  matches,
  args,
  ctx,
}: {
  name: string;
  matches: readonly IntrinsicSignature[];
  args: readonly Arg[];
  ctx: TypingContext;
}) => ({
  kind: "ambiguous-overload" as const,
  name,
  inferredArguments: formatInferredArgumentsForDiagnostic({ args, ctx }),
  candidates: matches
    .slice(0, MAX_OVERLOAD_DIAGNOSTIC_CANDIDATES)
    .map((signature) => ({
      signature: formatIntrinsicSignatureForDiagnostic({ name, signature, ctx }),
    })),
});

const ensureMutableArgument = ({
  arg,
  param,
  index,
  ctx,
}: {
  arg: Arg;
  param: ParamSignature;
  index: number;
  ctx: TypingContext;
}): void => {
  if (param.bindingKind !== "mutable-ref") {
    return;
  }
  if (typeof arg.exprId !== "number") {
    return;
  }

  const argExpr = ctx.hir.expressions.get(arg.exprId);
  if (argExpr?.exprKind === "call") {
    const calleeExpr = ctx.hir.expressions.get(argExpr.callee);
    if (calleeExpr?.exprKind === "identifier") {
      const record = ctx.symbolTable.getSymbol(calleeExpr.symbol);
      const metadata = (record.metadata ?? {}) as { intrinsic?: boolean };
      if (metadata.intrinsic === true && record.name === "~") {
        return;
      }
    }
  }
  const span = argExpr?.span ?? param.span ?? ctx.hir.module.span;
  const symbol =
    typeof arg.exprId === "number"
      ? findBindingSymbol(arg.exprId, ctx)
      : undefined;
  const paramName = param.name ?? param.label ?? `parameter ${index + 1}`;

  if (typeof symbol !== "number") {
    emitDiagnostic({
      ctx,
      code: "TY0004",
      params: { kind: "argument-must-be-mutable", paramName },
      span,
    });
    return;
  }

  assertMutableObjectBinding({
    symbol,
    span,
    ctx,
    reason: `${paramName} requires a mutable object reference`,
  });
};

const traitMethodImplMetadataFor = ({
  symbol,
  moduleId,
  ctx,
}: {
  symbol: SymbolId;
  moduleId?: string;
  ctx: TypingContext;
}):
  | {
      metadata: NonNullable<ReturnType<TypingContext["traitMethodImpls"]["get"]>>;
      moduleId: string;
    }
  | undefined => {
  const resolvedModuleId = moduleId ?? ctx.moduleId;
  if (resolvedModuleId === ctx.moduleId) {
    const metadata = ctx.traitMethodImpls.get(symbol);
    return metadata ? { metadata, moduleId: resolvedModuleId } : undefined;
  }
  const dependency = ctx.dependencies.get(resolvedModuleId);
  const metadata = dependency?.typing.traitMethodImpls.get(symbol);
  return metadata ? { metadata, moduleId: resolvedModuleId } : undefined;
};

const symbolNameForRef = ({
  ref,
  ctx,
}: {
  ref: SymbolRef;
  ctx: TypingContext;
}): string | undefined => {
  if (ref.moduleId === ctx.moduleId) {
    const local = localSymbolForSymbolRef(ref, ctx);
    return typeof local === "number"
      ? ctx.symbolTable.getSymbol(local).name
      : undefined;
  }
  const dependency = ctx.dependencies.get(ref.moduleId);
  return dependency
    ? dependency.symbolTable.getSymbol(ref.symbol).name
    : undefined;
};

const traitSymbolRefFor = ({
  traitSymbol,
  moduleId,
  ctx,
}: {
  traitSymbol: SymbolId;
  moduleId: string;
  ctx: TypingContext;
}): SymbolRef =>
  canonicalSymbolRefForModuleSymbol({
    moduleId,
    symbol: traitSymbol,
    ctx,
  });

const traitMethodRefsFor = ({
  traitRef,
  methodName,
  ctx,
}: {
  traitRef: SymbolRef;
  methodName: string;
  ctx: TypingContext;
}): SymbolRef[] => {
  const traitScope =
    traitRef.moduleId === ctx.moduleId
      ? { symbolTable: ctx.symbolTable, traits: ctx.traits }
      : (() => {
          const dependency = ctx.dependencies.get(traitRef.moduleId);
          return dependency
            ? {
                symbolTable: dependency.symbolTable,
                traits: dependency.typing.traits,
              }
            : undefined;
        })();
  if (!traitScope) {
    return [];
  }

  const traitDecl = traitScope.traits.getDecl(traitRef.symbol);
  if (!traitDecl) {
    return [];
  }
  return traitDecl.methods
    .filter(
      (method) =>
        traitScope.symbolTable.getSymbol(method.symbol).name === methodName,
    )
    .map((method) =>
      canonicalSymbolRefForModuleSymbol({
        moduleId: traitRef.moduleId,
        symbol: method.symbol,
        ctx,
      }),
    );
};

const adjustTraitDispatchParameters = ({
  args,
  params,
  calleeSymbol,
  calleeModuleId,
  ctx,
}: {
  args: readonly Arg[];
  params: readonly ParamSignature[];
  calleeSymbol: SymbolId;
  calleeModuleId?: string;
  ctx: TypingContext;
}): readonly ParamSignature[] | undefined => {
  if (args.length === 0 || params.length === 0) {
    return undefined;
  }
  const methodMetadata = traitMethodImplMetadataFor({
    symbol: calleeSymbol,
    moduleId: calleeModuleId,
    ctx,
  });
  if (!methodMetadata) {
    return undefined;
  }
  const receiverType = args[0].type;
  const receiverDesc = ctx.arena.get(receiverType);
  if (receiverDesc.kind !== "trait") {
    return undefined;
  }
  const methodTraitRef = traitSymbolRefFor({
    traitSymbol: methodMetadata.metadata.traitSymbol,
    moduleId: methodMetadata.moduleId,
    ctx,
  });
  if (!symbolRefEquals(receiverDesc.owner, methodTraitRef)) {
    return undefined;
  }
  const updated = [{ ...params[0]!, type: receiverType }, ...params.slice(1)];
  return updated;
};

const signatureWithAdjustedTraitDispatchParameters = ({
  args,
  signature,
  calleeSymbol,
  calleeModuleId,
  ctx,
}: {
  args: readonly Arg[];
  signature: FunctionSignature;
  calleeSymbol: SymbolId;
  calleeModuleId?: string;
  ctx: TypingContext;
}): FunctionSignature => {
  const params =
    adjustTraitDispatchParameters({
      args,
      params: signature.parameters,
      calleeSymbol,
      calleeModuleId,
      ctx,
    }) ?? signature.parameters;
  if (params === signature.parameters) {
    return signature;
  }

  const signatureDesc = ctx.arena.get(signature.typeId);
  const effectRow =
    signatureDesc.kind === "function"
      ? signatureDesc.effectRow
      : ctx.primitives.defaultEffectRow;
  const adjustedType = ctx.arena.internFunction({
    parameters: params.map((param) => ({
      type: param.type,
      label: param.label,
      optional: param.optional ?? false,
    })),
    returnType: signature.returnType,
    effectRow,
  });
  return {
    ...signature,
    parameters: params,
    typeId: adjustedType,
    effectRow,
  };
};

const instantiationRefKeyForCall = ({
  calleeSymbol,
  calleeModuleId,
  ctx,
}: {
  calleeSymbol: SymbolId;
  calleeModuleId?: string;
  ctx: TypingContext;
}): string => {
  const imported = ctx.importsByLocal.get(calleeSymbol);
  if (imported) {
    return symbolRefKey(imported);
  }
  if (calleeModuleId && calleeModuleId !== ctx.moduleId) {
    return symbolRefKey({ moduleId: calleeModuleId, symbol: calleeSymbol });
  }
  return symbolRefKey(canonicalSymbolRefForTypingContext(calleeSymbol, ctx));
};

const getTraitMethodTypeBindings = ({
  calleeSymbol,
  calleeModuleId,
  receiverType,
  signature,
  ctx,
  state,
}: {
  calleeSymbol: SymbolId;
  calleeModuleId?: string;
  receiverType: TypeId;
  signature: FunctionSignature;
  ctx: TypingContext;
  state: TypingState;
}): ReadonlyMap<TypeParamId, TypeId> | undefined => {
  if (!signature.typeParams || signature.typeParams.length === 0) {
    return undefined;
  }
  const receiverDesc = ctx.arena.get(receiverType);
  if (receiverDesc.kind !== "trait") {
    return undefined;
  }
  const methodMetadata = traitMethodImplMetadataFor({
    symbol: calleeSymbol,
    moduleId: calleeModuleId,
    ctx,
  });
  if (!methodMetadata) {
    return undefined;
  }
  const methodTraitRef = traitSymbolRefFor({
    traitSymbol: methodMetadata.metadata.traitSymbol,
    moduleId: methodMetadata.moduleId,
    ctx,
  });
  if (!symbolRefEquals(receiverDesc.owner, methodTraitRef)) {
    return undefined;
  }
  const templates =
    methodMetadata.moduleId === ctx.moduleId
      ? ctx.traits.getImplTemplatesForTrait(methodMetadata.metadata.traitSymbol)
      : (ctx.dependencies
          .get(methodMetadata.moduleId)
          ?.typing.traits.getImplTemplatesForTrait(
            methodMetadata.metadata.traitSymbol,
          ) ?? []);
  const template = templates
    .find(
      (entry) =>
        entry.methods.get(methodMetadata.metadata.traitMethodSymbol) ===
        calleeSymbol,
    );
  if (!template) {
    return undefined;
  }

  const allowUnknown = state.mode === "relaxed";
  const match = unifyWithBudget({
    actual: receiverType,
    expected: template.trait,
    options: {
      location: ctx.hir.module.ast,
      reason: "trait method inference",
      variance: "covariant",
      allowUnknown,
    },
    ctx,
  });
  if (!match.ok) {
    return undefined;
  }

  const symbolBindings = new Map<SymbolId, TypeId>();
  template.typeParams.forEach((param) => {
    const applied = match.substitution.get(param.typeParam);
    if (typeof applied === "number") {
      symbolBindings.set(param.symbol, applied);
    }
  });
  if (symbolBindings.size === 0) {
    return undefined;
  }

  const bindings = new Map<TypeParamId, TypeId>();
  signature.typeParams.forEach((param) => {
    const applied = symbolBindings.get(param.symbol);
    if (typeof applied === "number") {
      bindings.set(param.typeParam, applied);
    }
  });
  return bindings.size > 0 ? bindings : undefined;
};

const reportNonFunctionCallee = ({
  callSpan,
  calleeSpan,
  ctx,
}: {
  callSpan: SourceSpan;
  calleeSpan?: SourceSpan;
  ctx: TypingContext;
}): never =>
  emitDiagnostic({
    ctx,
    code: "TY0005",
    params: { kind: "not-callable" },
    span: normalizeSpan(calleeSpan, callSpan),
  });

const reportUnknownFunction = ({
  name,
  span,
  ctx,
}: {
  name: string;
  span?: SourceSpan;
  ctx: TypingContext;
}): never =>
  emitDiagnostic({
    ctx,
    code: "TY0006",
    params:
      name === "new_string"
        ? { kind: "missing-string-helper", name: "new_string" }
        : { kind: "unknown-function", name },
    span: normalizeSpan(span),
  });

const reportUnknownMethod = ({
  methodName,
  receiverName,
  span,
  ctx,
}: {
  methodName: string;
  receiverName?: string;
  span?: SourceSpan;
  ctx: TypingContext;
}): void => {
  emitDiagnostic({
    ctx,
    code: "TY0022",
    params: {
      kind: "unknown-method",
      name: methodName,
      ...(receiverName ? { receiver: receiverName } : {}),
    },
    span: normalizeSpan(span),
  });
};

const formatVisibilityLabel = (
  visibility: ModuleExportEntry["visibility"],
): string => {
  const base = visibility.level === "object" ? "pri" : visibility.level;
  return visibility.api ? `${base} (api)` : base;
};

const canAccessExportedMember = ({
  exported,
  ctx,
  state,
}: {
  exported: ModuleExportEntry;
  ctx: TypingContext;
  state: TypingState;
}): boolean => {
  const visibility = exported.visibility;
  if (!visibility) {
    return true;
  }
  if (visibility.level === "object") {
    return (
      typeof exported.memberOwner === "number" &&
      state.currentFunction?.memberOf === exported.memberOwner
    );
  }
  if (visibility.level === "module") {
    return false;
  }
  const samePackage = exported.packageId === ctx.packageId;
  if (samePackage) {
    return visibility.level === "package" || visibility.level === "public";
  }
  return visibility.api === true;
};

const assertExportedMemberAccess = ({
  exported,
  methodName,
  ctx,
  state,
  span,
}: {
  exported: ModuleExportEntry;
  methodName: string;
  ctx: TypingContext;
  state: TypingState;
  span?: SourceSpan;
}): void => {
  if (canAccessExportedMember({ exported, ctx, state })) {
    return;
  }
  emitDiagnostic({
    ctx,
    code: "TY0009",
    params: {
      kind: "member-access",
      memberKind: "method",
      name: methodName,
      visibility: formatVisibilityLabel(exported.visibility),
      context: "calling member",
    },
    span: normalizeSpan(span),
  });
};

const argsForMethodCallCandidate = ({
  probeArgs,
  receiverTypeOverride,
}: {
  probeArgs: readonly Arg[];
  receiverTypeOverride?: TypeId;
}): readonly Arg[] =>
  receiverTypeOverride
    ? [{ ...probeArgs[0]!, type: receiverTypeOverride }, ...probeArgs.slice(1)]
    : probeArgs;

const resolveMethodTraitDispatchCandidate = ({
  candidates,
  probeArgs,
  ctx,
  state,
}: {
  candidates: readonly MethodCallCandidate[];
  probeArgs: readonly Arg[];
  ctx: TypingContext;
  state: TypingState;
}): MethodCallCandidate | undefined => {
  const direct = resolveTraitDispatchOverload({
    candidates,
    args: probeArgs,
    ctx,
    state,
  });
  if (direct) {
    return direct;
  }

  const overrides = Array.from(
    new Set(
      candidates
        .map((candidate) => candidate.receiverTypeOverride)
        .filter((type): type is TypeId => typeof type === "number"),
    ),
  );

  return overrides
    .map((receiverTypeOverride) =>
      resolveTraitDispatchOverload({
        candidates,
        args: argsForMethodCallCandidate({ probeArgs, receiverTypeOverride }),
        ctx,
        state,
      }),
    )
    .find((candidate) => candidate !== undefined);
};

const resolveFreeFunctionFallbackCandidates = ({
  methodName,
  existing,
  ctx,
}: {
  methodName: string;
  existing: readonly MethodCallCandidate[];
  ctx: TypingContext;
}): MethodCallCandidate[] =>
  resolveFreeFunctionCandidates({
    methodName,
    ctx,
  }).filter(
    (fallback) =>
      !existing.some(
        (candidate) =>
          candidate.symbol === fallback.symbol &&
          candidate.symbolRef.moduleId === fallback.symbolRef.moduleId,
      ),
  );

const mergeCandidatesForMethodNoOverloadDiagnostic = ({
  methodCandidates,
  fallbackCandidates,
}: {
  methodCandidates: readonly MethodCallCandidate[];
  fallbackCandidates: readonly MethodCallCandidate[];
}): MethodCallCandidate[] => {
  const seen = new Set<string>();
  return [...methodCandidates, ...fallbackCandidates].filter((candidate) => {
    const key = `${candidate.symbolRef.moduleId}:${candidate.symbol}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

const selectMethodCallCandidate = ({
  expr,
  resolution,
  probeArgs,
  typeArguments,
  ctx,
  state,
}: {
  expr: HirMethodCallExpr;
  resolution: MethodCallResolution | undefined;
  probeArgs: readonly Arg[];
  typeArguments: readonly TypeId[] | undefined;
  ctx: TypingContext;
  state: TypingState;
}): MethodCallSelection => {
  if (!resolution || resolution.candidates.length === 0) {
    reportUnknownMethod({
      methodName: expr.method,
      receiverName: resolution?.receiverName,
      span: expr.span,
      ctx,
    });
    return { usedTraitDispatch: false };
  }

  const argsForCandidate = (candidate: MethodCallCandidate): readonly Arg[] =>
    argsForMethodCallCandidate({
      probeArgs,
      receiverTypeOverride: candidate.receiverTypeOverride,
    });
  const signatureForCandidate = (
    candidate: MethodCallCandidate,
  ): FunctionSignature =>
    signatureWithAdjustedTraitDispatchParameters({
      args: argsForCandidate(candidate),
      signature: candidate.signature,
      calleeSymbol: candidate.symbol,
      calleeModuleId: candidate.symbolRef.moduleId,
      ctx,
    });

  const methodCandidates = filterCandidatesByExplicitTypeArguments({
    candidates: resolution.candidates,
    typeArguments,
  });
  let candidates = methodCandidates;
  let noOverloadDiagnosticCandidates = methodCandidates;
  enforceOverloadCandidateBudget({
    name: expr.method,
    candidateCount: candidates.length,
    ctx,
    span: expr.span,
  });
  let matches = findMatchingOverloadCandidates({
    candidates,
    args: probeArgs,
    ctx,
    state,
    typeArguments,
    argsForCandidate,
  });

  let traitDispatch =
    matches.length === 0
      ? resolveMethodTraitDispatchCandidate({
          candidates,
          probeArgs,
          ctx,
          state,
        })
      : undefined;

  if (
    !traitDispatch &&
    matches.length === 0 &&
    resolution.includesMethodCandidates === true &&
    typeof expr.traitSymbol !== "number"
  ) {
    // Preserve method precedence, but allow UFCS-style free functions when
    // same-named methods exist and none of them match the call shape.
    const fallbackCandidates = resolveFreeFunctionFallbackCandidates({
      methodName: expr.method,
      existing: resolution.candidates,
      ctx,
    });

    if (fallbackCandidates.length > 0) {
      const filteredFallbackCandidates = filterCandidatesByExplicitTypeArguments({
        candidates: fallbackCandidates,
        typeArguments,
      });
      candidates = filteredFallbackCandidates;
      noOverloadDiagnosticCandidates = mergeCandidatesForMethodNoOverloadDiagnostic({
        methodCandidates,
        fallbackCandidates: filteredFallbackCandidates,
      });
      enforceOverloadCandidateBudget({
        name: expr.method,
        candidateCount: candidates.length,
        ctx,
        span: expr.span,
      });
      matches = findMatchingOverloadCandidates({
        candidates,
        args: probeArgs,
        ctx,
        state,
        typeArguments,
        argsForCandidate,
      });
    }
  }

  if (traitDispatch) {
    return {
      selected: traitDispatch,
      usedTraitDispatch: true,
    };
  }

  if (matches.length === 0) {
    emitDiagnostic({
      ctx,
      code: "TY0008",
      params: noOverloadDiagnosticParams({
        name: expr.method,
        candidates: noOverloadDiagnosticCandidates,
        args: probeArgs,
        ctx,
        state,
        typeArguments,
        argsForCandidate,
        signatureForCandidate,
      }),
      span: expr.span,
    });
    return { usedTraitDispatch: false };
  }

  if (matches.length > 1) {
    emitDiagnostic({
      ctx,
      code: "TY0007",
      params: ambiguousOverloadDiagnosticParams({
        name: expr.method,
        matches,
        args: probeArgs,
        ctx,
        state,
        typeArguments,
        argsForCandidate,
      }),
      span: expr.span,
    });
    return { usedTraitDispatch: false };
  }

  return { selected: matches[0], usedTraitDispatch: false };
};

const resolveMethodCallCandidates = ({
  receiverType,
  methodName,
  ctx,
}: {
  receiverType: TypeId;
  methodName: string;
  ctx: TypingContext;
}): MethodCallResolution | undefined => {
  const receiverDesc = ctx.arena.get(receiverType);
  if (receiverDesc.kind === "trait") {
    const traitResolution = resolveTraitMethodCandidates({
      receiverDesc,
      methodName,
      ctx,
    });
    if (traitResolution.candidates.length > 0) {
      return {
        ...traitResolution,
        includesMethodCandidates: true,
      };
    }
    return {
      candidates: resolveFreeFunctionCandidates({ methodName, ctx }),
      receiverName: traitResolution.receiverName,
      includesMethodCandidates: false,
    };
  }

  if (receiverDesc.kind === "intersection" && receiverDesc.traits) {
    const traitCandidates = receiverDesc.traits.flatMap((traitType) => {
      const traitDesc = ctx.arena.get(traitType);
      if (traitDesc.kind !== "trait") {
        return [];
      }
      const resolution = resolveTraitMethodCandidates({
        receiverDesc: traitDesc,
        methodName,
        ctx,
      });
      return resolution.candidates.map((candidate) => ({
        ...candidate,
        receiverTypeOverride: traitType,
      }));
    });

    if (traitCandidates.length > 0) {
      const receiverName = receiverDesc.traits
        .map((traitType) => {
          const traitDesc = ctx.arena.get(traitType);
          if (traitDesc.kind !== "trait") {
            return undefined;
          }
          const symbol = localSymbolForSymbolRef(traitDesc.owner, ctx);
          return typeof symbol === "number"
            ? ctx.symbolTable.getSymbol(symbol).name
            : undefined;
        })
        .filter((entry): entry is string => Boolean(entry))
        .join(" & ");
      return {
        candidates: traitCandidates,
        receiverName,
        includesMethodCandidates: true,
      };
    }
  }
  const nominalResolution = resolveNominalMethodCandidates({
    receiverType,
    methodName,
    ctx,
  });
  if (nominalResolution && nominalResolution.candidates.length > 0) {
    return {
      ...nominalResolution,
      includesMethodCandidates: true,
    };
  }
  return {
    candidates: resolveFreeFunctionCandidates({ methodName, ctx }),
    receiverName: nominalResolution?.receiverName,
    includesMethodCandidates: false,
  };
};

const resolveQualifiedTraitMethodCallCandidates = ({
  receiverType,
  traitSymbol,
  methodName,
  ctx,
}: {
  receiverType: TypeId;
  traitSymbol: SymbolId;
  methodName: string;
  ctx: TypingContext;
}): MethodCallResolution => {
  const traitRecord = ctx.symbolTable.getSymbol(traitSymbol);
  const traitName = traitRecord.name;
  const qualifiedTraitRef = canonicalSymbolRefForTypingContext(traitSymbol, ctx);

  if (receiverType === ctx.primitives.unknown) {
    return { candidates: [], receiverName: traitName };
  }

  const receiverDesc = ctx.arena.get(receiverType);
  if (receiverDesc.kind === "trait") {
    if (!symbolRefEquals(receiverDesc.owner, qualifiedTraitRef)) {
      return { candidates: [], receiverName: traitName };
    }
    const resolution = resolveTraitMethodCandidates({
      receiverDesc,
      methodName,
      ctx,
    });
    return { ...resolution, receiverName: traitName };
  }

  if (receiverDesc.kind === "intersection" && receiverDesc.traits) {
    const candidates = receiverDesc.traits.flatMap((traitType) => {
      const traitTypeDesc = ctx.arena.get(traitType);
      if (traitTypeDesc.kind !== "trait") {
        return [];
      }
      if (!symbolRefEquals(traitTypeDesc.owner, qualifiedTraitRef)) {
        return [];
      }
      const resolution = resolveTraitMethodCandidates({
        receiverDesc: traitTypeDesc,
        methodName,
        ctx,
      });
      return resolution.candidates.map((candidate) => ({
        ...candidate,
        receiverTypeOverride: traitType,
      }));
    });
    return { candidates, receiverName: traitName };
  }

  const nominalResolution = resolveNominalMethodCandidates({
    receiverType,
    methodName,
    ctx,
  });
  if (!nominalResolution || nominalResolution.candidates.length === 0) {
    return { candidates: [], receiverName: traitName };
  }

  const candidates = nominalResolution.candidates.filter(
    (candidate) => {
      const methodMetadata = traitMethodImplMetadataFor({
        symbol: candidate.symbol,
        moduleId: candidate.symbolRef.moduleId,
        ctx,
      });
      if (!methodMetadata) {
        return false;
      }
      const methodTraitRef = traitSymbolRefFor({
        traitSymbol: methodMetadata.metadata.traitSymbol,
        moduleId: methodMetadata.moduleId,
        ctx,
      });
      return symbolRefEquals(methodTraitRef, qualifiedTraitRef);
    },
  );

  return { candidates, receiverName: traitName };
};

const resolveOperatorOverloadCandidates = ({
  receiverType,
  operatorName,
  ctx,
}: {
  receiverType: TypeId;
  operatorName: string;
  ctx: TypingContext;
}): MethodCallResolution | undefined => {
  const receiverDesc = ctx.arena.get(receiverType);
  if (receiverDesc.kind === "trait") {
    const traitResolution = resolveTraitMethodCandidates({
      receiverDesc,
      methodName: operatorName,
      ctx,
    });
    return traitResolution.candidates.length > 0 ? traitResolution : undefined;
  }

  const nominalResolution = resolveNominalMethodCandidates({
    receiverType,
    methodName: operatorName,
    ctx,
  });
  return nominalResolution && nominalResolution.candidates.length > 0
    ? nominalResolution
    : undefined;
};

const typeOperatorOverloadCall = ({
  call,
  callee,
  operatorName,
  args,
  ctx,
  state,
  typeArguments,
  expectedReturnType,
}: {
  call: HirCallExpr;
  callee: HirExpression;
  operatorName: string;
  args: readonly Arg[];
  ctx: TypingContext;
  state: TypingState;
  typeArguments: readonly TypeId[] | undefined;
  expectedReturnType: TypeId | undefined;
}): { returnType: TypeId; effectRow: number } | undefined => {
  if (callee.exprKind !== "identifier") {
    return undefined;
  }
  if (args.length === 0) {
    return undefined;
  }

  const receiverType = args[0]!.type;
  if (receiverType === ctx.primitives.unknown) {
    return undefined;
  }

  const resolution = resolveOperatorOverloadCandidates({
    receiverType,
    operatorName,
    ctx,
  });
  if (!resolution || resolution.candidates.length === 0) {
    return undefined;
  }

  const candidates = filterCandidatesByExplicitTypeArguments({
    candidates: resolution.candidates,
    typeArguments,
  });
  enforceOverloadCandidateBudget({
    name: operatorName,
    candidateCount: candidates.length,
    ctx,
    span: call.span,
  });

  const matches = findMatchingOverloadCandidates({
    candidates,
    args,
    ctx,
    state,
    typeArguments,
  });
  const traitDispatch =
    matches.length === 0
      ? resolveTraitDispatchOverload({
          candidates,
          args,
          ctx,
          state,
        })
      : undefined;
  let selected = traitDispatch;

  if (!selected) {
    if (matches.length === 0) {
      emitDiagnostic({
        ctx,
        code: "TY0008",
        params: noOverloadDiagnosticParams({
          name: operatorName,
          candidates,
          args,
          ctx,
          state,
          typeArguments,
        }),
        span: call.span,
      });
    }

    if (matches.length > 1) {
      emitDiagnostic({
        ctx,
        code: "TY0007",
        params: ambiguousOverloadDiagnosticParams({
          name: operatorName,
          matches,
          args,
          ctx,
          state,
          typeArguments,
        }),
        span: call.span,
      });
    }

    selected = matches[0];
  }

  if (!selected) {
    return {
      returnType: ctx.primitives.unknown,
      effectRow: ctx.effects.emptyRow,
    };
  }

  const instanceKey = state.currentFunction?.instanceKey;
  if (!instanceKey) {
    throw new Error(
      `missing function instance key for operator resolution at call ${call.id}`,
    );
  }

  if (traitDispatch) {
    ctx.callResolution.traitDispatches.add(call.id);
  } else {
    ctx.callResolution.traitDispatches.delete(call.id);
  }

  if (!traitDispatch) {
    if (selected.exported) {
      assertExportedMemberAccess({
        exported: selected.exported,
        methodName: operatorName,
        ctx,
        state,
        span: call.span,
      });
    } else if (selected.symbolRef.moduleId === ctx.moduleId) {
      assertMemberAccess({
        symbol: selected.symbol,
        ctx,
        state,
        span: call.span,
        context: "calling member",
      });
    }
  }

  const targets =
    ctx.callResolution.targets.get(call.id) ?? new Map<string, SymbolRef>();
  targets.set(instanceKey, selected.symbolRef);
  ctx.callResolution.targets.set(call.id, targets);

  return typeFunctionCall({
    args,
    signature: selected.signature,
    calleeSymbol: selected.symbol,
    typeArguments,
    expectedReturnType,
    callId: call.id,
    ctx,
    state,
    calleeModuleId: selected.symbolRef.moduleId,
    nameForSymbol: selected.nameForSymbol,
  });
};

const resolveNominalMethodCandidates = ({
  receiverType,
  methodName,
  ctx,
}: {
  receiverType: TypeId;
  methodName: string;
  ctx: TypingContext;
}): MethodCallResolution | undefined => {
  const receiverNominal = getNominalComponent(receiverType, ctx);
  if (typeof receiverNominal !== "number") {
    return undefined;
  }

  const receiverDesc = ctx.arena.get(receiverNominal);
  if (receiverDesc.kind !== "nominal-object") {
    return undefined;
  }

  const ownerRef = receiverDesc.owner;
  const candidates =
    ownerRef.moduleId === ctx.moduleId
      ? findLocalMethodCandidates({
          owner: localSymbolForSymbolRef(ownerRef, ctx),
          methodName,
          ctx,
        })
      : findExportedMethodCandidates({
          ownerRef,
          methodName,
          ctx,
        });
  const receiverName = symbolNameForRef({ ref: ownerRef, ctx });

  return { candidates, receiverName };
};

const canonicalSymbolRefForModuleSymbol = ({
  moduleId,
  symbol,
  ctx,
  seen = new Set<string>(),
}: {
  moduleId: string;
  symbol: SymbolId;
  ctx: TypingContext;
  seen?: Set<string>;
}): SymbolRef => {
  const key = `${moduleId}:${symbol}`;
  if (seen.has(key)) {
    return { moduleId, symbol };
  }
  seen.add(key);

  if (moduleId === ctx.moduleId) {
    return canonicalSymbolRefForTypingContext(symbol, ctx);
  }

  const dependency = ctx.dependencies.get(moduleId);
  if (!dependency) {
    return { moduleId, symbol };
  }

  const metadata = (dependency.symbolTable.getSymbol(symbol).metadata ?? {}) as {
    import?: { moduleId?: unknown; symbol?: unknown };
  };
  if (
    typeof metadata.import?.moduleId === "string" &&
    typeof metadata.import?.symbol === "number"
  ) {
    return canonicalSymbolRefForModuleSymbol({
      moduleId: metadata.import.moduleId,
      symbol: metadata.import.symbol,
      ctx,
      seen,
    });
  }

  return { moduleId, symbol };
};

const resolveTraitMethodCandidates = ({
  receiverDesc,
  methodName,
  ctx,
}: {
  receiverDesc: ReturnType<TypingContext["arena"]["get"]>;
  methodName: string;
  ctx: TypingContext;
}): MethodCallResolution => {
  if (receiverDesc.kind !== "trait") {
    return { candidates: [] };
  }
  const receiverName = symbolNameForRef({ ref: receiverDesc.owner, ctx });
  const receiverMethodRefs = traitMethodRefsFor({
    traitRef: receiverDesc.owner,
    methodName,
    ctx,
  });
  if (receiverMethodRefs.length === 0) {
    return { candidates: [], receiverName };
  }
  const receiverMethodRefKeys = new Set(receiverMethodRefs.map(symbolRefKey));

  const candidates: MethodCallCandidate[] = [];
  const seen = new Set<string>();
  const addCandidate = ({
    moduleId,
    symbol,
    signature,
    nameForSymbol,
  }: {
    moduleId: string;
    symbol: SymbolId;
    signature: FunctionSignature;
    nameForSymbol?: SymbolNameResolver;
  }) => {
    const key = symbolRefKey(
      canonicalSymbolRefForModuleSymbol({
        moduleId,
        symbol,
        ctx,
      }),
    );
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push({
      symbol,
      signature,
      symbolRef: { moduleId, symbol },
      nameForSymbol,
    });
  };

  const collectFromModule = ({
    moduleId,
    symbolTable,
    getSignature,
    traitMethodImpls,
    nameForSymbol,
  }: {
    moduleId: string;
    symbolTable: TypingContext["symbolTable"];
    getSignature: (symbol: SymbolId) => FunctionSignature | undefined;
    traitMethodImpls: ReadonlyMap<
      SymbolId,
      { traitSymbol: SymbolId; traitMethodSymbol: SymbolId }
    >;
    nameForSymbol?: SymbolNameResolver;
  }) => {
    traitMethodImpls.forEach((metadata, implMethod) => {
      const traitRef = canonicalSymbolRefForModuleSymbol({
        moduleId,
        symbol: metadata.traitSymbol,
        ctx,
      });
      if (!symbolRefEquals(traitRef, receiverDesc.owner)) {
        return;
      }
      const traitMethodRef = canonicalSymbolRefForModuleSymbol({
        moduleId,
        symbol: metadata.traitMethodSymbol,
        ctx,
      });
      if (!receiverMethodRefKeys.has(symbolRefKey(traitMethodRef))) {
        return;
      }
      const signature = getSignature(implMethod);
      if (!signature) {
        throw new Error(
          `missing type signature for trait method ${symbolTable.getSymbol(implMethod).name}`,
        );
      }
      addCandidate({ moduleId, symbol: implMethod, signature, nameForSymbol });
    });
  };

  collectFromModule({
    moduleId: ctx.moduleId,
    symbolTable: ctx.symbolTable,
    getSignature: (symbol) => ctx.functions.getSignature(symbol),
    traitMethodImpls: ctx.traitMethodImpls,
  });
  ctx.dependencies.forEach((dependency) => {
    collectFromModule({
      moduleId: dependency.moduleId,
      symbolTable: dependency.symbolTable,
      getSignature: (symbol) =>
        getDependencyMethodSignature({
          dependency,
          symbol,
          ctx,
        }),
      traitMethodImpls: dependency.typing.traitMethodImpls,
      nameForSymbol: (symbol) => dependency.symbolTable.getSymbol(symbol).name,
    });
  });

  return { candidates, receiverName };
};

const resolveFreeFunctionCandidates = ({
  methodName,
  ctx,
}: {
  methodName: string;
  ctx: TypingContext;
}): MethodCallCandidate[] => {
  const symbols = ctx.symbolTable.resolveAllByKinds(
    methodName,
    ctx.symbolTable.rootScope,
    ["value"],
  );
  if (!symbols || symbols.length === 0) {
    return [];
  }

  return symbols
    .map((symbol) => {
      const signature = ctx.functions.getSignature(symbol);
      if (!signature) {
        return undefined;
      }
      return {
        symbol,
        signature,
        symbolRef: canonicalSymbolRefForTypingContext(symbol, ctx),
      };
    })
    .filter((entry): entry is MethodCallCandidate => Boolean(entry));
};

const findLocalMethodCandidates = ({
  owner,
  methodName,
  ctx,
}: {
  owner: SymbolId | undefined;
  methodName: string;
  ctx: TypingContext;
}): MethodCallCandidate[] => {
  if (typeof owner !== "number") {
    return [];
  }

  return Array.from(ctx.memberMetadata.entries())
    .filter(([, metadata]) => metadata.owner === owner)
    .map(([symbol]) => {
      const record = ctx.symbolTable.getSymbol(symbol);
      const metadata = (record.metadata ?? {}) as { static?: boolean };
      if (metadata.static === true || record.name !== methodName) {
        return undefined;
      }
      const signature = ctx.functions.getSignature(symbol);
      if (!signature) {
        throw new Error(
          `missing type signature for method ${getSymbolName(symbol, ctx)}`,
        );
      }
      return {
        symbol,
        signature,
        symbolRef: { moduleId: ctx.moduleId, symbol },
      };
    })
    .filter((entry): entry is MethodCallCandidate => Boolean(entry));
};

const findExportedMethodCandidates = ({
  ownerRef,
  methodName,
  ctx,
}: {
  ownerRef: SymbolRef;
  methodName: string;
  ctx: TypingContext;
}): MethodCallCandidate[] => {
  const dependency = ctx.dependencies.get(ownerRef.moduleId);
  if (!dependency) {
    return [];
  }
  const exported = dependency.exports.get(methodName);
  if (
    !exported ||
    typeof exported.memberOwner !== "number" ||
    exported.memberOwner !== ownerRef.symbol
  ) {
    return [];
  }
  if (exported.isStatic === true) {
    return [];
  }

  const symbols =
    exported.symbols && exported.symbols.length > 0
      ? exported.symbols
      : [exported.symbol];
  const nameForSymbol = (symbol: SymbolId): string =>
    dependency.symbolTable.getSymbol(symbol).name;

  return symbols.map((symbol): MethodCallCandidate => {
    const signature = getDependencyMethodSignature({
      dependency,
      symbol,
      ctx,
    });
    if (!signature) {
      throw new Error(
        `missing type signature for method ${nameForSymbol(symbol)}`,
      );
    }
    return {
      symbol,
      signature,
      symbolRef: { moduleId: dependency.moduleId, symbol },
      nameForSymbol,
      exported,
    };
  });
};

const resolveCurriedCallReturnType = ({
  args,
  calleeType,
  ctx,
  state,
  callSpan,
  calleeSpan,
}: {
  args: readonly Arg[];
  calleeType: TypeId;
  ctx: TypingContext;
  state: TypingState;
  callSpan: SourceSpan;
  calleeSpan?: SourceSpan;
}): TypeId => {
  let remainingArgs = args;
  let currentType = calleeType;

  while (true) {
    const desc = ctx.arena.get(currentType);
    if (desc.kind !== "function") {
      return reportNonFunctionCallee({ callSpan, calleeSpan, ctx });
    }

    const { parameters, returnType } = desc;
    if (parameters.length === 0) {
      if (remainingArgs.length > 0) {
        throw new Error("call argument count mismatch");
      }
      return returnType;
    }

    const segment = remainingArgs.slice(0, parameters.length);
    const validation = validateCallArgs(segment, parameters, ctx, state, callSpan);
    if (!validation.ok) {
      return ctx.primitives.unknown;
    }

    remainingArgs = remainingArgs.slice(parameters.length);
    if (remainingArgs.length === 0) {
      return returnType;
    }

    currentType = returnType;
  }
};

type EffectVariance = "covariant" | "contravariant" | "invariant";

const flipEffectVariance = (variance: EffectVariance): EffectVariance => {
  if (variance === "covariant") {
    return "contravariant";
  }
  if (variance === "contravariant") {
    return "covariant";
  }
  return "invariant";
};

const mergeEffectTailSubstitutions = ({
  current,
  next,
  ctx,
}: {
  current: Map<number, number>;
  next: ReadonlyMap<number, number>;
  ctx: TypingContext;
}): void => {
  next.forEach((row, tailVar) => {
    const existing = current.get(tailVar);
    if (typeof existing !== "number") {
      current.set(tailVar, row);
      return;
    }
    if (existing === row) {
      return;
    }
    current.set(tailVar, ctx.effects.compose(existing, row));
  });
};

const collectEffectTailSubstitutionsFromTypes = ({
  actualType,
  expectedType,
  variance,
  location,
  reason,
  ctx,
  substitution,
  seen,
}: {
  actualType: TypeId;
  expectedType: TypeId;
  variance: EffectVariance;
  location: HirExprId;
  reason: string;
  ctx: TypingContext;
  substitution: Map<number, number>;
  seen: Set<string>;
}): void => {
  if (
    actualType === ctx.primitives.unknown ||
    expectedType === ctx.primitives.unknown
  ) {
    return;
  }

  if (variance === "invariant") {
    collectEffectTailSubstitutionsFromTypes({
      actualType,
      expectedType,
      variance: "covariant",
      location,
      reason,
      ctx,
      substitution,
      seen,
    });
    collectEffectTailSubstitutionsFromTypes({
      actualType,
      expectedType,
      variance: "contravariant",
      location,
      reason,
      ctx,
      substitution,
      seen,
    });
    return;
  }

  const key = `${variance}:${actualType}:${expectedType}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);

  const actualDesc = ctx.arena.get(actualType);
  const expectedDesc = ctx.arena.get(expectedType);
  if (actualDesc.kind === "function" && expectedDesc.kind === "function") {
    const subEffectRow =
      variance === "covariant"
        ? actualDesc.effectRow
        : expectedDesc.effectRow;
    const supEffectRow =
      variance === "covariant"
        ? expectedDesc.effectRow
        : actualDesc.effectRow;
    const constrained = ctx.effects.constrain(subEffectRow, supEffectRow, {
      location,
      reason,
    });
    if (constrained.ok) {
      mergeEffectTailSubstitutions({
        current: substitution,
        next: constrained.substitution.rows,
        ctx,
      });
    }

    const count = Math.min(
      actualDesc.parameters.length,
      expectedDesc.parameters.length,
    );
    for (let index = 0; index < count; index += 1) {
      collectEffectTailSubstitutionsFromTypes({
        actualType: actualDesc.parameters[index]!.type,
        expectedType: expectedDesc.parameters[index]!.type,
        variance: flipEffectVariance(variance),
        location,
        reason,
        ctx,
        substitution,
        seen,
      });
    }
    collectEffectTailSubstitutionsFromTypes({
      actualType: actualDesc.returnType,
      expectedType: expectedDesc.returnType,
      variance,
      location,
      reason,
      ctx,
      substitution,
      seen,
    });
    return;
  }

  if (
    actualDesc.kind === "nominal-object" &&
    expectedDesc.kind === "nominal-object" &&
    symbolRefEquals(actualDesc.owner, expectedDesc.owner)
  ) {
    const count = Math.min(actualDesc.typeArgs.length, expectedDesc.typeArgs.length);
    for (let index = 0; index < count; index += 1) {
      collectEffectTailSubstitutionsFromTypes({
        actualType: actualDesc.typeArgs[index]!,
        expectedType: expectedDesc.typeArgs[index]!,
        variance,
        location,
        reason,
        ctx,
        substitution,
        seen,
      });
    }
    return;
  }

  if (
    actualDesc.kind === "trait" &&
    expectedDesc.kind === "trait" &&
    symbolRefEquals(actualDesc.owner, expectedDesc.owner)
  ) {
    const count = Math.min(actualDesc.typeArgs.length, expectedDesc.typeArgs.length);
    for (let index = 0; index < count; index += 1) {
      collectEffectTailSubstitutionsFromTypes({
        actualType: actualDesc.typeArgs[index]!,
        expectedType: expectedDesc.typeArgs[index]!,
        variance,
        location,
        reason,
        ctx,
        substitution,
        seen,
      });
    }
    return;
  }

  if (actualDesc.kind === "fixed-array" && expectedDesc.kind === "fixed-array") {
    collectEffectTailSubstitutionsFromTypes({
      actualType: actualDesc.element,
      expectedType: expectedDesc.element,
      variance,
      location,
      reason,
      ctx,
      substitution,
      seen,
    });
    return;
  }

  if (
    actualDesc.kind === "structural-object" &&
    expectedDesc.kind === "structural-object"
  ) {
    expectedDesc.fields.forEach((expectedField) => {
      const actualField = actualDesc.fields.find(
        (candidate) => candidate.name === expectedField.name,
      );
      if (!actualField) {
        return;
      }
      collectEffectTailSubstitutionsFromTypes({
        actualType: actualField.type,
        expectedType: expectedField.type,
        variance,
        location,
        reason,
        ctx,
        substitution,
        seen,
      });
    });
    return;
  }

  if (actualDesc.kind === "union" && expectedDesc.kind === "union") {
    const count = Math.min(actualDesc.members.length, expectedDesc.members.length);
    for (let index = 0; index < count; index += 1) {
      collectEffectTailSubstitutionsFromTypes({
        actualType: actualDesc.members[index]!,
        expectedType: expectedDesc.members[index]!,
        variance,
        location,
        reason,
        ctx,
        substitution,
        seen,
      });
    }
    return;
  }

  if (
    actualDesc.kind === "intersection" &&
    expectedDesc.kind === "intersection"
  ) {
    if (
      typeof actualDesc.nominal === "number" &&
      typeof expectedDesc.nominal === "number"
    ) {
      collectEffectTailSubstitutionsFromTypes({
        actualType: actualDesc.nominal,
        expectedType: expectedDesc.nominal,
        variance,
        location,
        reason,
        ctx,
        substitution,
        seen,
      });
    }
    if (
      typeof actualDesc.structural === "number" &&
      typeof expectedDesc.structural === "number"
    ) {
      collectEffectTailSubstitutionsFromTypes({
        actualType: actualDesc.structural,
        expectedType: expectedDesc.structural,
        variance,
        location,
        reason,
        ctx,
        substitution,
        seen,
      });
    }
  }
};

const specializeCallEffectRow = ({
  effectRow,
  args,
  params,
  callId,
  ctx,
}: {
  effectRow: number;
  args: readonly Arg[];
  params: readonly ParamSignature[];
  callId: HirExprId;
  ctx: TypingContext;
}): number => {
  if (!ctx.effects.isOpen(effectRow)) {
    return effectRow;
  }

  const substitution = new Map<number, number>();
  const count = Math.min(args.length, params.length);
  for (let index = 0; index < count; index += 1) {
    collectEffectTailSubstitutionsFromTypes({
      actualType: args[index]!.type,
      expectedType: params[index]!.type,
      variance: "covariant",
      location: callId,
      reason: "call argument callback effects",
      ctx,
      substitution,
      seen: new Set(),
    });
  }

  return applyEffectRowSubstitution({
    row: effectRow,
    substitution,
    effects: ctx.effects,
  });
};

const typeFunctionCall = ({
  args,
  signature,
  calleeSymbol,
  typeArguments,
  expectedReturnType,
  callId,
  ctx,
  state,
  calleeExprId,
  calleeModuleId,
  nameForSymbol,
}: {
  args: readonly Arg[];
  signature: FunctionSignature;
  calleeSymbol: SymbolId;
  typeArguments?: readonly TypeId[];
  expectedReturnType?: TypeId;
  callId: HirExprId;
  ctx: TypingContext;
  state: TypingState;
  calleeExprId?: HirExprId;
  calleeModuleId?: string;
  nameForSymbol?: SymbolNameResolver;
}): { returnType: TypeId; effectRow: number } => {
  const callerInstanceKey = state.currentFunction?.instanceKey;
  if (!callerInstanceKey) {
    throw new Error(`missing function instance key for call ${callId}`);
  }
  const resolvedModuleId = calleeModuleId ?? ctx.moduleId;
  const isExternal = resolvedModuleId !== ctx.moduleId;
  const record = isExternal
    ? undefined
    : ctx.symbolTable.getSymbol(calleeSymbol);
  const intrinsicMetadata = record
    ? ((record.metadata ?? {}) as {
        intrinsic?: boolean;
        intrinsicUsesSignature?: boolean;
      })
    : {};
  const resolveName = (symbol: SymbolId): string =>
    resolveSymbolName(symbol, ctx, nameForSymbol);
  const hasTypeParams = signature.typeParams && signature.typeParams.length > 0;
  const prefilledSubstitution =
    hasTypeParams && args.length > 0
      ? getTraitMethodTypeBindings({
          calleeSymbol,
          calleeModuleId: resolvedModuleId,
          receiverType: args[0]!.type,
          signature,
          ctx,
          state,
        })
      : undefined;
  const instantiation = hasTypeParams
    ? instantiateFunctionCall({
        signature,
        args,
        typeArguments,
        expectedReturnType,
        calleeSymbol,
        prefilledSubstitution,
        ctx,
        state,
        nameForSymbol: resolveName,
      })
    : {
        substitution: new Map<TypeParamId, TypeId>(),
        parameters: signature.parameters,
        returnType: signature.returnType,
      };

  if (!hasTypeParams && typeArguments && typeArguments.length > 0) {
    throw new Error("call does not accept type arguments");
  }

  const adjustedParameters =
    adjustTraitDispatchParameters({
      args,
      params: instantiation.parameters,
      calleeSymbol,
      calleeModuleId: resolvedModuleId,
      ctx,
    }) ?? instantiation.parameters;

  const callSpan = ctx.hir.expressions.get(callId)?.span;
  const validation = validateCallArgs(
    args,
    adjustedParameters,
    ctx,
    state,
    callSpan,
  );
  if (validation.ok) {
    const existingPlans =
      ctx.callResolution.argumentPlans.get(callId) ?? new Map();
    existingPlans.set(callerInstanceKey, validation.plan);
    ctx.callResolution.argumentPlans.set(callId, existingPlans);
  } else {
    const existingPlans = ctx.callResolution.argumentPlans.get(callId);
    if (existingPlans) {
      existingPlans.delete(callerInstanceKey);
      if (existingPlans.size === 0) {
        ctx.callResolution.argumentPlans.delete(callId);
      }
    }
  }
  const specializedEffectRow = specializeCallEffectRow({
    effectRow: signature.effectRow,
    args,
    params: adjustedParameters,
    callId,
    ctx,
  });

  if (typeof calleeExprId === "number") {
    const calleeType = ctx.arena.internFunction({
      parameters: adjustedParameters.map((param) => ({
        ...param,
        optional: false,
      })),
      returnType: instantiation.returnType,
      effectRow: ctx.primitives.defaultEffectRow,
    });
    ctx.table.setExprType(calleeExprId, calleeType);
    ctx.resolvedExprTypes.set(
      calleeExprId,
      applyCurrentSubstitution(calleeType, ctx, state),
    );
  }

  if (hasTypeParams) {
    const mergedSubstitution = mergeSubstitutions(
      instantiation.substitution,
      state.currentFunction?.substitution,
      ctx,
    );
    args.forEach((arg) => {
      if (typeof arg.exprId === "number") {
        const applied = ctx.arena.substitute(arg.type, mergedSubstitution);
        ctx.resolvedExprTypes.set(arg.exprId, applied);
      }
    });
    const appliedTypeArgs = getAppliedTypeArguments({
      signature,
      substitution: mergedSubstitution,
      symbol: calleeSymbol,
      ctx,
      nameForSymbol: resolveName,
    });
    const codegenTypeArgs = getAppliedTypeArguments({
      signature,
      substitution: instantiation.substitution,
      symbol: calleeSymbol,
      ctx,
      nameForSymbol: resolveName,
    });
    const callKey = formatFunctionInstanceKey(calleeSymbol, appliedTypeArgs);
    if (typeof calleeExprId === "number") {
      // Avoid re-canonicalizing external overload symbols.
      // Some call paths resolve directly to dependency symbols (methods, operator overloads, etc).
      // Those symbols are not guaranteed to exist in the caller's symbol table, so fall back to
      // the provided `calleeModuleId` when we can't canonicalize via local import metadata.
      const imported = ctx.importsByLocal.get(calleeSymbol);
      const calleeRef =
        imported ??
        (calleeModuleId && calleeModuleId !== ctx.moduleId
          ? { moduleId: calleeModuleId, symbol: calleeSymbol }
          : (() => {
              try {
                return canonicalSymbolRefForTypingContext(calleeSymbol, ctx);
              } catch {
                return { moduleId: ctx.moduleId, symbol: calleeSymbol };
              }
            })());
      const existingTargets =
        ctx.callResolution.targets.get(callId) ?? new Map();
      existingTargets.set(callerInstanceKey, calleeRef);
      ctx.callResolution.targets.set(callId, existingTargets);
    }
    const existingTypeArgs =
      ctx.callResolution.typeArguments.get(callId) ?? new Map();
    existingTypeArgs.set(callerInstanceKey, codegenTypeArgs);
    ctx.callResolution.typeArguments.set(callId, existingTypeArgs);
    const existingKeys =
      ctx.callResolution.instanceKeys.get(callId) ?? new Map();
    existingKeys.set(callerInstanceKey, callKey);
    ctx.callResolution.instanceKeys.set(callId, existingKeys);
    const instantiationKey = instantiationRefKeyForCall({
      calleeSymbol,
      calleeModuleId,
      ctx,
    });
    const skipGenericBody =
      intrinsicMetadata.intrinsic === true &&
      intrinsicMetadata.intrinsicUsesSignature !== true;
    if (!skipGenericBody && !isExternal) {
      typeGenericFunctionBody({
        symbol: calleeSymbol,
        signature,
        substitution: instantiation.substitution,
        ctx,
        state,
      });
    } else if (!skipGenericBody && isExternal) {
      ctx.functions.recordInstantiation(
        instantiationKey,
        callKey,
        appliedTypeArgs,
      );
    }
  } else {
    ctx.callResolution.typeArguments.delete(callId);
    ctx.callResolution.instanceKeys.delete(callId);
  }

  return {
    returnType: instantiation.returnType,
    effectRow: specializedEffectRow,
  };
};

const instantiateFunctionCall = ({
  signature,
  args,
  typeArguments,
  expectedReturnType,
  calleeSymbol,
  prefilledSubstitution,
  ctx,
  state,
  nameForSymbol,
}: {
  signature: FunctionSignature;
  args: readonly Arg[];
  typeArguments?: readonly TypeId[];
  expectedReturnType?: TypeId;
  calleeSymbol: SymbolId;
  prefilledSubstitution?: ReadonlyMap<TypeParamId, TypeId>;
  ctx: TypingContext;
  state: TypingState;
  nameForSymbol?: SymbolNameResolver;
}): {
  substitution: ReadonlyMap<TypeParamId, TypeId>;
  parameters: readonly ParamSignature[];
  returnType: TypeId;
} => {
  const typeParams = signature.typeParams ?? [];

  if (typeArguments && typeArguments.length > typeParams.length) {
    throw new Error(
      `function ${resolveSymbolName(
        calleeSymbol,
        ctx,
        nameForSymbol,
      )} received too many type arguments`,
    );
  }

  const substitution = new Map<TypeParamId, TypeId>(prefilledSubstitution);
  typeParams.forEach((param, index) => {
    const explicit = typeArguments?.[index];
    if (typeof explicit === "number") {
      substitution.set(param.typeParam, explicit);
    }
  });

  args.forEach((arg, index) => {
    const expected = signature.parameters[index];
    if (!expected) {
      return;
    }
    const expectedType = ctx.arena.substitute(expected.type, substitution);
    bindTypeParamsFromType(expectedType, arg.type, substitution, ctx, state);
  });

  if (
    typeof expectedReturnType === "number" &&
    expectedReturnType !== ctx.primitives.unknown
  ) {
    const expected = ctx.arena.substitute(signature.returnType, substitution);
    bindTypeParamsFromType(
      expected,
      applyCurrentSubstitution(expectedReturnType, ctx, state),
      substitution,
      ctx,
      state,
    );
  }

  const missing = typeParams.filter(
    (param) => !substitution.has(param.typeParam),
  );
  if (missing.length > 0) {
    throw new Error(
      `function ${resolveSymbolName(calleeSymbol, ctx, nameForSymbol)} is missing ${
        missing.length
      } type argument(s); add explicit type arguments`,
    );
  }

  typeParams.forEach((param) =>
    enforceTypeParamConstraint(param, substitution, ctx, state, nameForSymbol),
  );

  const parameters = signature.parameters.map((param) => ({
    ...param,
    type: ctx.arena.substitute(param.type, substitution),
  }));
  const returnType = ctx.arena.substitute(signature.returnType, substitution);

  return { substitution, parameters, returnType };
};

export const enforceTypeParamConstraint = (
  param: FunctionTypeParam,
  substitution: ReadonlyMap<TypeParamId, TypeId>,
  ctx: TypingContext,
  state: TypingState,
  nameForSymbol?: SymbolNameResolver,
): void => {
  if (!param.constraint) {
    return;
  }
  const applied = substitution.get(param.typeParam);
  if (typeof applied !== "number") {
    return;
  }
  const constraint = ctx.arena.substitute(param.constraint, substitution);
  if (!typeSatisfies(applied, constraint, ctx, state)) {
    const appliedType = typeDescriptorToUserString(ctx.arena.get(applied), ctx.arena);
    const constraintType = typeDescriptorToUserString(
      ctx.arena.get(constraint),
      ctx.arena,
    );
    throw new Error(
      `type argument for ${resolveSymbolName(
        param.symbol,
        ctx,
        nameForSymbol,
      )} does not satisfy its constraint (applied=${appliedType}, constraint=${constraintType}, symbol=${param.symbol}, type_param=${param.typeParam})`,
    );
  }
};

export const typeGenericFunctionBody = ({
  symbol,
  signature,
  substitution,
  ctx,
  state,
}: {
  symbol: SymbolId;
  signature: FunctionSignature;
  substitution: ReadonlyMap<TypeParamId, TypeId>;
  ctx: TypingContext;
  state: TypingState;
}): void => {
  const typeParams = signature.typeParams ?? [];
  if (typeParams.length === 0) {
    return;
  }

  const previousFunction = state.currentFunction;

  const mergedSubstitution = mergeSubstitutions(
    substitution,
    previousFunction?.substitution,
    ctx,
  );
  const appliedTypeArgs = getAppliedTypeArguments({
    signature,
    substitution: mergedSubstitution,
    symbol,
    ctx,
  });
  const key = formatFunctionInstanceKey(symbol, appliedTypeArgs);
  if (ctx.functions.isCachedOrActive(key)) {
    return;
  }

  const fn = ctx.functions.getFunction(symbol);
  if (!fn) {
    throw new Error(`missing function body for symbol ${symbol}`);
  }

  ctx.functions.beginInstantiation(key);
  ctx.table.pushExprTypeScope();
  const previousResolved = ctx.resolvedExprTypes;
  ctx.resolvedExprTypes = new Map();
  const previousValueTypes = ctx.valueTypes;
  ctx.valueTypes = new Map(previousValueTypes);
  const nextTypeParams =
    signature.typeParamMap && previousFunction?.typeParams
      ? new Map([
          ...previousFunction.typeParams.entries(),
          ...signature.typeParamMap.entries(),
        ])
      : (signature.typeParamMap ?? previousFunction?.typeParams);
  const expectedReturn = ctx.arena.substitute(
    signature.returnType,
    mergedSubstitution,
  );

  state.currentFunction = {
    returnType: expectedReturn,
    instanceKey: key,
    typeParams: nextTypeParams,
    substitution: mergedSubstitution,
    memberOf: ctx.memberMetadata.get(symbol)?.owner,
    functionSymbol: symbol,
  };

  let bodyType: TypeId | undefined;

  try {
    bodyType = typeExpression(fn.body, ctx, state, {
      expectedType: expectedReturn,
    });
    ensureTypeMatches(
      bodyType,
      expectedReturn,
      ctx,
      state,
      `function ${getSymbolName(symbol, ctx)} return type`,
    );
    const inferredEffectRow = getExprEffectRow(fn.body, ctx);
    if (signature.annotatedEffects) {
      ensureEffectCompatibility({
        inferred: inferredEffectRow,
        annotated: signature.effectRow ?? ctx.primitives.defaultEffectRow,
        ctx,
        span: fn.span,
        location: fn.ast,
        reason: `function ${getSymbolName(symbol, ctx)} effects`,
      });
    } else if (signature.effectRow !== inferredEffectRow) {
      signature.effectRow = inferredEffectRow;
      const functionType = ctx.arena.internFunction({
        parameters: signature.parameters.map(({ type, label }) => ({
          type,
          label,
          optional: false,
        })),
        returnType: signature.returnType,
        effectRow: inferredEffectRow,
      });
      const scheme = ctx.arena.newScheme(
        signature.typeParams?.map((param) => param.typeParam) ?? [],
        functionType,
      );
      signature.typeId = functionType;
      signature.scheme = scheme;
      ctx.valueTypes.set(symbol, functionType);
      ctx.table.setSymbolScheme(symbol, scheme);
    }
    if (state.mode === "strict" && signature.scheme) {
      if (ctx.effects.getFunctionEffect(symbol) === undefined) {
        ctx.effects.setFunctionEffect(
          symbol,
          signature.scheme,
          signature.effectRow ?? ctx.primitives.defaultEffectRow,
        );
      }
    }
    ctx.functions.cacheInstanceValueTypes(key, ctx.valueTypes);
    ctx.functions.cacheInstance(key, expectedReturn, ctx.resolvedExprTypes);
    ctx.functions.recordInstantiation(
      symbolRefKey(canonicalSymbolRefForTypingContext(symbol, ctx)),
      key,
      appliedTypeArgs,
    );
  } finally {
    const updatedFunctionType = ctx.valueTypes.get(symbol);
    if (typeof updatedFunctionType === "number") {
      previousValueTypes.set(symbol, updatedFunctionType);
    }
    state.currentFunction = previousFunction;
    ctx.resolvedExprTypes = previousResolved;
    ctx.valueTypes = previousValueTypes;
    ctx.table.popExprTypeScope();
    ctx.functions.endInstantiation(key);
  }
};

export const mergeSubstitutions = (
  current: ReadonlyMap<TypeParamId, TypeId>,
  previous: ReadonlyMap<TypeParamId, TypeId> | undefined,
  ctx: TypingContext,
): ReadonlyMap<TypeParamId, TypeId> => {
  if (!previous || previous.size === 0) {
    return current;
  }

  const merged = new Map(previous);
  current.forEach((value, key) => {
    merged.set(key, ctx.arena.substitute(value, merged));
  });
  return merged;
};

const getAppliedTypeArguments = ({
  signature,
  substitution,
  symbol,
  ctx,
  nameForSymbol,
}: {
  signature: FunctionSignature;
  substitution: ReadonlyMap<TypeParamId, TypeId>;
  symbol: SymbolId;
  ctx: TypingContext;
  nameForSymbol?: SymbolNameResolver;
}): readonly TypeId[] => {
  const typeParams = signature.typeParams ?? [];
  return typeParams.map((param) => {
    const applied = substitution.get(param.typeParam);
    if (typeof applied !== "number") {
      throw new Error(
        `function ${resolveSymbolName(
          symbol,
          ctx,
          nameForSymbol,
        )} is missing a type argument for ${resolveSymbolName(
          param.symbol,
          ctx,
          nameForSymbol,
        )}`,
      );
    }
    if (applied === ctx.primitives.unknown) {
      throw new Error(
        `function ${resolveSymbolName(
          symbol,
          ctx,
          nameForSymbol,
        )} has unresolved type argument for ${resolveSymbolName(
          param.symbol,
          ctx,
          nameForSymbol,
        )}`,
      );
    }
    return applied;
  });
};

export const formatFunctionInstanceKey = (
  symbol: SymbolId,
  typeArgs: readonly TypeId[],
): string => `${symbol}<${typeArgs.join(",")}>`;

const resolveIntrinsicFallbackSymbol = ({
  name,
  ctx,
}: {
  name: string;
  ctx: TypingContext;
}): SymbolId | undefined => {
  const metadata = intrinsicValueMetadataFor(name);
  if (!metadata) {
    return undefined;
  }
  if (metadata.access === "std-only" && ctx.packageId !== "std") {
    return undefined;
  }

  const existing = ctx.symbolTable.resolveWhere(
    name,
    ctx.symbolTable.rootScope,
    (record) => {
      const symbolMetadata = (record.metadata ?? {}) as { intrinsic?: boolean };
      return symbolMetadata.intrinsic === true;
    },
  );
  if (typeof existing === "number") {
    return existing;
  }

  return ctx.symbolTable.declare({
    name,
    kind: "value",
    declaredAt: ctx.hir.module.ast,
    metadata: { intrinsic: true, ...metadata },
  });
};

const intrinsicFallbackMatchesArgs = ({
  name,
  args,
  ctx,
}: {
  name: string;
  args: readonly Arg[];
  ctx: TypingContext;
}): boolean => {
  const intrinsicSignatures = intrinsicSignaturesFor(name, ctx);
  if (intrinsicSignatures.length === 0) {
    return false;
  }
  return intrinsicSignatures.some(
    (signature) =>
      signature.parameters.length === args.length &&
      signature.parameters.every(
        (paramType, index) => args[index]!.type === paramType,
      ),
  );
};

const typeIntrinsicFallbackCall = ({
  name,
  args,
  typeArguments,
  callId,
  callSpan,
  calleeExprId,
  ctx,
  state,
}: {
  name: string;
  args: readonly Arg[];
  typeArguments: readonly TypeId[] | undefined;
  callId: HirExprId;
  callSpan: SourceSpan | undefined;
  calleeExprId?: HirExprId;
  ctx: TypingContext;
  state: TypingState;
}): { returnType: TypeId; effectRow: number } | undefined => {
  if (typeArguments && typeArguments.length > 0) {
    return undefined;
  }
  if (args.some((arg) => arg.type === ctx.primitives.unknown)) {
    return undefined;
  }
  if (!intrinsicFallbackMatchesArgs({ name, args, ctx })) {
    return undefined;
  }

  const fallbackSymbol = resolveIntrinsicFallbackSymbol({ name, ctx });
  if (typeof fallbackSymbol !== "number") {
    return undefined;
  }
  const instanceKey = state.currentFunction?.instanceKey;
  if (!instanceKey) {
    throw new Error(`missing function instance key for intrinsic fallback at call ${callId}`);
  }
  const targets =
    ctx.callResolution.targets.get(callId) ?? new Map<string, SymbolRef>();
  targets.set(
    instanceKey,
    canonicalSymbolRefForTypingContext(fallbackSymbol, ctx),
  );
  ctx.callResolution.targets.set(callId, targets);
  ctx.callResolution.traitDispatches.delete(callId);

  const returnType = typeIntrinsicCall(
    name,
    args,
    ctx,
    state,
    typeArguments,
    false,
    callSpan,
  );
  if (typeof calleeExprId === "number") {
    const calleeType = ctx.arena.internFunction({
      parameters: args.map((arg) => ({
        type: arg.type,
        label: arg.label,
        optional: false,
      })),
      returnType,
      effectRow: ctx.primitives.defaultEffectRow,
    });
    ctx.table.setExprType(calleeExprId, calleeType);
    ctx.resolvedExprTypes.set(
      calleeExprId,
      applyCurrentSubstitution(calleeType, ctx, state),
    );
  }

  return {
    returnType,
    effectRow: ctx.primitives.defaultEffectRow,
  };
};

const resolveIntrinsicFallbackForIdentifierCall = ({
  call,
  calleeSymbol,
  signature,
  args,
  ctx,
  state,
  typeArguments,
}: {
  call: HirCallExpr;
  calleeSymbol: SymbolId;
  signature: FunctionSignature;
  args: readonly Arg[];
  ctx: TypingContext;
  state: TypingState;
  typeArguments: readonly TypeId[] | undefined;
}):
  | { returnType: TypeId; effectRow: number; calleeType: TypeId }
  | undefined => {
  const signatureMatchesCall = matchesOverloadSignature(
    calleeSymbol,
    signature,
    args,
    ctx,
    state,
    typeArguments,
  );
  if (signatureMatchesCall) {
    return undefined;
  }

  const calleeName = ctx.symbolTable.getSymbol(calleeSymbol).name;
  const intrinsicFallback = typeIntrinsicFallbackCall({
    name: calleeName,
    args,
    typeArguments,
    callId: call.id,
    callSpan: call.span,
    ctx,
    state,
  });
  if (!intrinsicFallback) {
    return undefined;
  }

  const calleeType = ctx.arena.internFunction({
    parameters: args.map((arg) => ({
      type: arg.type,
      label: arg.label,
      optional: false,
    })),
    returnType: intrinsicFallback.returnType,
    effectRow: ctx.primitives.defaultEffectRow,
  });

  return {
    ...intrinsicFallback,
    calleeType,
  };
};

const selectHintedOverloadCandidates = ({
  candidates,
  typeArguments,
  expectedReturnType,
  expectedReturnCandidates,
  ctx,
  state,
}: {
  candidates: readonly OverloadCandidate[];
  typeArguments: readonly TypeId[] | undefined;
  expectedReturnType: TypeId | undefined;
  expectedReturnCandidates: ReadonlySet<SymbolId> | undefined;
  ctx: TypingContext;
  state: TypingState;
}): {
  hintedCandidates: readonly OverloadCandidate[];
  fallbackCandidates?: readonly OverloadCandidate[];
} => {
  const candidatesForBudget = filterCandidatesByExplicitTypeArguments({
    candidates,
    typeArguments,
  });

  const returnHintCandidates =
    expectedReturnCandidates && expectedReturnCandidates.size > 0
      ? candidatesForBudget.filter((candidate) =>
          expectedReturnCandidates.has(candidate.symbol),
        )
      : filterCandidatesByExpectedReturnType({
          candidates: candidatesForBudget,
          expectedReturnType,
          typeArguments,
          ctx,
          state,
        });

  if (
    returnHintCandidates.length === 0 ||
    returnHintCandidates.length === candidatesForBudget.length
  ) {
    return { hintedCandidates: candidatesForBudget };
  }

  return {
    hintedCandidates: returnHintCandidates,
    fallbackCandidates: candidatesForBudget,
  };
};

const findOverloadMatches = ({
  name,
  candidates,
  args,
  typeArguments,
  span,
  ctx,
  state,
}: {
  name: string;
  candidates: readonly OverloadCandidate[];
  args: readonly Arg[];
  typeArguments: readonly TypeId[] | undefined;
  span: SourceSpan;
  ctx: TypingContext;
  state: TypingState;
}): readonly OverloadCandidate[] => {
  enforceOverloadCandidateBudget({
    name,
    candidateCount: candidates.length,
    ctx,
    span,
  });
  return findMatchingOverloadCandidates({
    candidates,
    args,
    ctx,
    state,
    typeArguments,
  });
};

const typeOverloadedCall = (
  call: HirCallExpr,
  callee: HirOverloadSetExpr,
  probeArgs: readonly Arg[],
  ctx: TypingContext,
  state: TypingState,
  expectedReturnType?: TypeId,
  typeArguments?: readonly TypeId[],
  expectedReturnCandidates?: ReadonlySet<SymbolId>,
): { returnType: TypeId; effectRow: number } => {
  const options = ctx.overloads.get(callee.set);
  if (!options) {
    throw new Error(
      `missing overload metadata for ${callee.name} (set ${callee.set})`,
    );
  }

  const candidates = options.map((symbol) => {
    const signature = ctx.functions.getSignature(symbol);
    if (!signature) {
      throw new Error(
        `missing type signature for overloaded function ${getSymbolName(
          symbol,
          ctx,
        )}`,
      );
    }
    return { symbol, signature };
  });
  const { hintedCandidates, fallbackCandidates } = selectHintedOverloadCandidates({
    candidates,
    typeArguments,
    expectedReturnType,
    expectedReturnCandidates,
    ctx,
    state,
  });

  let candidatesForResolution = hintedCandidates;
  let matches = findOverloadMatches({
    name: callee.name,
    candidates: candidatesForResolution,
    args: probeArgs,
    typeArguments,
    span: call.span,
    ctx,
    state,
  });
  if (matches.length === 0 && fallbackCandidates) {
    // Expected-return narrowing is a hint. If it removes all valid matches,
    // retry with the full overload set before failing.
    candidatesForResolution = fallbackCandidates;
    matches = findOverloadMatches({
      name: callee.name,
      candidates: candidatesForResolution,
      args: probeArgs,
      typeArguments,
      span: call.span,
      ctx,
      state,
    });
  }

  const traitDispatch =
    matches.length === 0 && (!typeArguments || typeArguments.length === 0)
      ? resolveTraitDispatchOverload({
          candidates: candidatesForResolution,
          args: probeArgs,
          ctx,
          state,
        })
      : undefined;

  let selected = traitDispatch;
  if (!selected) {
    if (matches.length === 0) {
      const intrinsicFallback = typeIntrinsicFallbackCall({
        name: callee.name,
        args: probeArgs,
        typeArguments,
        callId: call.id,
        callSpan: call.span,
        calleeExprId: callee.id,
        ctx,
        state,
      });
      if (intrinsicFallback) {
        return intrinsicFallback;
      }
      emitDiagnostic({
        ctx,
        code: "TY0008",
        params: noOverloadDiagnosticParams({
          name: callee.name,
          candidates: candidatesForResolution,
          args: probeArgs,
          ctx,
          state,
          typeArguments,
        }),
        span: call.span,
      });
    }

    if (matches.length > 1) {
      emitDiagnostic({
        ctx,
        code: "TY0007",
        params: ambiguousOverloadDiagnosticParams({
          name: callee.name,
          matches,
          args: probeArgs,
          ctx,
          state,
          typeArguments,
        }),
        span: call.span,
      });
    }

    selected = matches[0];
  }
  if (!selected) {
    return {
      returnType: ctx.primitives.unknown,
      effectRow: ctx.effects.emptyRow,
    };
  }
  const instanceKey = state.currentFunction?.instanceKey;
  if (!instanceKey) {
    throw new Error(
      `missing function instance key for overload resolution at call ${call.id}`,
    );
  }
  if (traitDispatch) {
    ctx.callResolution.traitDispatches.add(call.id);
  } else {
    ctx.callResolution.traitDispatches.delete(call.id);
  }
  assertMemberAccess({
    symbol: selected.symbol,
    ctx,
    state,
    span: call.span,
    context: "calling member",
  });
  const selectedRef = canonicalSymbolRefForTypingContext(selected.symbol, ctx);
  const targets =
    ctx.callResolution.targets.get(call.id) ?? new Map<string, SymbolRef>();
  targets.set(instanceKey, selectedRef);
  ctx.callResolution.targets.set(call.id, targets);
  const hintSubstitution = buildCallArgumentHintSubstitution({
    signature: selected.signature,
    probeArgs,
    expectedReturnType,
    seedSubstitution: mergeExplicitTypeArgumentSubstitution({
      signature: selected.signature,
      typeArguments,
      calleeSymbol: selected.symbol,
      ctx,
    }),
    ctx,
    state,
  });
  const args = typeCallArgsWithSignatureContext({
    args: call.args,
    signature: selected.signature,
    paramOffset: 0,
    hintSubstitution,
    ctx,
    state,
  });

  return typeFunctionCall({
    args,
    signature: selected.signature,
    calleeSymbol: selected.symbol,
    typeArguments,
    expectedReturnType,
    callId: call.id,
    ctx,
    state,
    calleeExprId: callee.id,
    calleeModuleId: selectedRef.moduleId,
  });
};

const resolveTraitDispatchOverload = <
  T extends {
    symbol: SymbolId;
    signature: FunctionSignature;
    symbolRef?: SymbolRef;
  },
>({
  candidates,
  args,
  ctx,
  state,
}: {
  candidates: readonly T[];
  args: readonly Arg[];
  ctx: TypingContext;
  state: TypingState;
}): T | undefined => {
  if (args.length === 0) {
    return undefined;
  }
  const receiver = args[0];
  const receiverDesc = ctx.arena.get(receiver.type);
  if (receiverDesc.kind !== "trait") {
    return undefined;
  }

  const allowUnknown = state.mode === "relaxed";
  const candidate = candidates.find((candidate) => {
    const { symbol, signature } = candidate;
    if (signature.parameters.length === 0) {
      return false;
    }
    const candidateModuleId = candidate.symbolRef?.moduleId ?? ctx.moduleId;
    const methodMetadata = traitMethodImplMetadataFor({
      symbol,
      moduleId: candidateModuleId,
      ctx,
    });
    if (!methodMetadata) {
      return false;
    }

    const methodTraitRef = traitSymbolRefFor({
      traitSymbol: methodMetadata.metadata.traitSymbol,
      moduleId: methodMetadata.moduleId,
      ctx,
    });
    if (!symbolRefEquals(methodTraitRef, receiverDesc.owner)) {
      return false;
    }

    const impls =
      methodMetadata.moduleId === ctx.moduleId
        ? ctx.traitImplsByTrait.get(methodMetadata.metadata.traitSymbol)
        : ctx.dependencies
            .get(methodMetadata.moduleId)
            ?.typing.traitImplsByTrait.get(
              methodMetadata.metadata.traitSymbol,
            );
    const templates =
      methodMetadata.moduleId === ctx.moduleId
        ? ctx.traits.getImplTemplatesForTrait(
            methodMetadata.metadata.traitSymbol,
          )
        : ctx.dependencies
            .get(methodMetadata.moduleId)
            ?.typing.traits.getImplTemplatesForTrait(
              methodMetadata.metadata.traitSymbol,
            );
    const dependency =
      methodMetadata.moduleId === ctx.moduleId
        ? undefined
        : ctx.dependencies.get(methodMetadata.moduleId);
    const translateDependencyType =
      dependency &&
      !typingContextsShareInterners({
        sourceArena: dependency.typing.arena,
        targetArena: ctx.arena,
        sourceEffects: dependency.typing.effects,
        targetEffects: ctx.effects,
      })
        ? createTranslation({
            sourceArena: dependency.typing.arena,
            targetArena: ctx.arena,
            sourceEffects: dependency.typing.effects,
            targetEffects: ctx.effects,
            paramMap: new Map<TypeParamId, TypeParamId>(),
            cache: new Map(),
            mapSymbol: (owner) =>
              mapDependencySymbolToLocal({
                owner,
                dependency,
                ctx,
                allowUnexported: true,
              }),
          })
        : undefined;
    const toLocalType = (type: TypeId): TypeId =>
      translateDependencyType ? translateDependencyType(type) : type;

    if ((!impls || impls.length === 0) && (!templates || templates.length === 0)) {
      return false;
    }

    const hasMatchingImpl =
      impls?.some(
        (entry) =>
          entry.methods.get(methodMetadata.metadata.traitMethodSymbol) ===
            symbol &&
          typeSatisfies(receiver.type, toLocalType(entry.trait), ctx, state),
      ) === true;
    const hasCompatibleTemplate =
      templates?.some((template) => {
        const implMethod = template.methods.get(
          methodMetadata.metadata.traitMethodSymbol,
        );
        if (implMethod !== symbol) {
          return false;
        }
        const comparison = unifyWithBudget({
          actual: receiver.type,
          expected: toLocalType(template.trait),
          options: {
            location: ctx.hir.module.ast,
            reason: "trait object dispatch",
            variance: "covariant",
            allowUnknown,
          },
          ctx,
        });
        return comparison.ok;
      }) === true;
    if (!hasMatchingImpl && !hasCompatibleTemplate) {
      return false;
    }
    const adjustedSignature = signatureWithAdjustedTraitDispatchParameters({
      args,
      signature,
      calleeSymbol: symbol,
      calleeModuleId: candidateModuleId,
      ctx,
    });
    return callArgumentsSatisfyParams({
      args,
      params: adjustedSignature.parameters,
      ctx,
      state,
    });
  });

  if (!candidate) {
    return undefined;
  }

  const adjustedSignature = signatureWithAdjustedTraitDispatchParameters({
    args,
    signature: candidate.signature,
    calleeSymbol: candidate.symbol,
    calleeModuleId: candidate.symbolRef?.moduleId ?? ctx.moduleId,
    ctx,
  });
  if (adjustedSignature === candidate.signature) {
    return candidate;
  }

  return {
    ...candidate,
    signature: adjustedSignature,
  } as T;
};

const matchesOverloadSignature = (
  symbol: SymbolId,
  signature: FunctionSignature,
  args: readonly Arg[],
  ctx: TypingContext,
  state: TypingState,
  typeArguments?: readonly TypeId[],
): boolean => {
  const typeParamCount = signature.typeParams?.length ?? 0;
  if (typeArguments && typeArguments.length > typeParamCount) {
    return false;
  }
  const explicitSubstitution =
    signature.typeParams && signature.typeParams.length > 0
      ? applyExplicitTypeArguments({
          signature,
          typeArguments,
          calleeSymbol: symbol,
          ctx,
        })
      : undefined;
  const params = explicitSubstitution
    ? signature.parameters.map((param) => ({
        ...param,
        type: ctx.arena.substitute(param.type, explicitSubstitution),
      }))
    : signature.parameters;

  if (!callArgumentsSatisfyParams({ args, params, ctx, state })) {
    return false;
  }

  params.forEach(({ type }) => {
    if (type === ctx.primitives.unknown) {
      throw new Error(
        `overloaded function ${getSymbolName(
          symbol,
          ctx,
        )} must declare parameter types`,
      );
    }
  });

  return true;
};

const typeIntrinsicCall = (
  name: string,
  args: readonly Arg[],
  ctx: TypingContext,
  state: TypingState,
  typeArguments?: readonly TypeId[],
  allowTypeArguments = false,
  span?: SourceSpan,
): TypeId => {
  const callSpan = normalizeSpan(span);
  switch (name) {
    case "~":
      return typeMutableIntrinsic({ args, ctx, state, typeArguments });
    case "__array_new":
      return typeArrayNewIntrinsic({ args, ctx, state, typeArguments });
    case "__array_new_fixed":
      return typeArrayNewFixedIntrinsic({
        args,
        ctx,
        state,
        typeArguments,
        span: callSpan,
      });
    case "__array_get":
      return typeArrayGetIntrinsic({
        args,
        ctx,
        state,
        typeArguments,
        allowTypeArguments,
      });
    case "__array_set":
      return typeArraySetIntrinsic({
        args,
        ctx,
        state,
        typeArguments,
        allowTypeArguments,
      });
    case "__array_len":
      return typeArrayLenIntrinsic({
        args,
        ctx,
        state,
        typeArguments,
        allowTypeArguments,
      });
    case "__array_copy":
      return typeArrayCopyIntrinsic({
        args,
        ctx,
        state,
        typeArguments,
        allowTypeArguments,
      });
    case "__ref_is_null":
      return typeRefIsNullIntrinsic({ args, ctx });
    case "__memory_size":
      return typeMemorySizeIntrinsic({ args, ctx, typeArguments });
    case "__memory_grow":
      return typeMemoryGrowIntrinsic({ args, ctx, state, typeArguments });
    case "__memory_load_u8":
    case "__memory_load_u16":
    case "__memory_load_u32":
      return typeMemoryLoadIntrinsic({ name, args, ctx, state, typeArguments });
    case "__memory_store_u8":
    case "__memory_store_u16":
    case "__memory_store_u32":
      return typeMemoryStoreIntrinsic({
        name,
        args,
        ctx,
        state,
        typeArguments,
      });
    case "__memory_copy":
      return typeMemoryCopyIntrinsic({ args, ctx, state, typeArguments });
    case "__panic_trap":
      return typePanicTrapIntrinsic({ args, ctx, typeArguments });
    case "__shift_l":
    case "__shift_ru":
      return typeShiftIntrinsic({ name, args, ctx, state, typeArguments });
    case "__bit_and":
    case "__bit_or":
    case "__bit_xor":
      return typeBitwiseIntrinsic({ name, args, ctx, state, typeArguments });
    case "__i32_wrap_i64":
      return typeWrapIntrinsic({ args, ctx, state, typeArguments });
    case "__i64_extend_u":
    case "__i64_extend_s":
      return typeExtendIntrinsic({ name, args, ctx, state, typeArguments });
    case "__reinterpret_f32_to_i32":
    case "__reinterpret_i32_to_f32":
    case "__reinterpret_f64_to_i64":
    case "__reinterpret_i64_to_f64":
      return typeReinterpretIntrinsic({
        name,
        args,
        ctx,
        state,
        typeArguments,
      });
    case "__f32_demote_f64":
    case "__f64_promote_f32":
    case "__i32_trunc_f32_s":
    case "__i32_trunc_f64_s":
    case "__i64_trunc_f32_s":
    case "__i64_trunc_f64_s":
    case "__f32_convert_i32_s":
    case "__f32_convert_i64_s":
    case "__f64_convert_i32_s":
    case "__f64_convert_i64_s":
      return typeNumericConvertIntrinsic({
        name,
        args,
        ctx,
        state,
        typeArguments,
      });
    default: {
      const signatures = intrinsicSignaturesFor(name, ctx);
      if (signatures.length === 0) {
        throw new Error(`unsupported intrinsic ${name}`);
      }

      const matches = signatures.filter((signature) =>
        intrinsicSignatureMatches(signature, args, ctx),
      );

      if (matches.length === 0) {
        emitDiagnostic({
          ctx,
          code: "TY0008",
          params: intrinsicNoOverloadDiagnosticParams({
            name,
            signatures,
            args,
            ctx,
          }),
          span: callSpan,
        });
        return ctx.primitives.unknown;
      }

      if (matches.length > 1) {
        emitDiagnostic({
          ctx,
          code: "TY0007",
          params: intrinsicAmbiguousOverloadDiagnosticParams({
            name,
            matches,
            args,
            ctx,
          }),
          span: callSpan,
        });
        return ctx.primitives.unknown;
      }

      return matches[0]!.returnType;
    }
  }
};

const typeMutableIntrinsic = ({
  args,
  ctx,
  state,
  typeArguments,
}: {
  args: readonly Arg[];
  ctx: TypingContext;
  state: TypingState;
  typeArguments?: readonly TypeId[];
}): TypeId => {
  if (typeArguments && typeArguments.length > 0) {
    throw new Error("~ does not accept type arguments");
  }
  if (args.length === 0) {
    throw new Error("~ requires at least one argument");
  }
  const [target, ...rest] = args;
  const value = rest.length > 0 ? rest[rest.length - 1]! : target;
  if (rest.length > 0) {
    ensureTypeMatches(
      value.type,
      target.type,
      ctx,
      state,
      "mutable expression target",
      spanForArg(value, ctx),
    );
    return target.type;
  }
  return value.type;
};

const typeArrayNewIntrinsic = ({
  args,
  ctx,
  state,
  typeArguments,
}: {
  args: readonly Arg[];
  ctx: TypingContext;
  state: TypingState;
  typeArguments?: readonly TypeId[];
}): TypeId => {
  assertIntrinsicArgCount({
    name: "__array_new",
    args,
    expected: 1,
    detail: "size",
  });
  const elementType = requireSingleTypeArgument({
    name: "__array_new",
    typeArguments,
    detail: "element type",
  });
  const sizeType = getPrimitiveType(ctx, "i32");
  ensureTypeMatches(
    args[0]!.type,
    sizeType,
    ctx,
    state,
    "__array_new size",
    spanForArg(args[0]!, ctx),
  );
  return ctx.arena.internFixedArray(elementType);
};

const typeArrayNewFixedIntrinsic = ({
  args,
  ctx,
  state,
  typeArguments,
  span,
}: {
  args: readonly Arg[];
  ctx: TypingContext;
  state: TypingState;
  typeArguments?: readonly TypeId[];
  span?: SourceSpan;
}): TypeId => {
  let elementType: TypeId;
  if (typeArguments && typeArguments.length > 0) {
    elementType = requireSingleTypeArgument({
      name: "__array_new_fixed",
      typeArguments,
      detail: "element type",
    });
    args.forEach((arg) =>
      ensureTypeMatches(
        arg.type,
        elementType,
        ctx,
        state,
        "__array_new_fixed element",
        spanForArg(arg, ctx),
      ),
    );
  } else {
    elementType = inferArrayLiteralElementType({ args, ctx, state, span });
    args.forEach((arg) => {
      if (arg.type === ctx.primitives.unknown) return;
      ensureTypeMatches(
        arg.type,
        elementType,
        ctx,
        state,
        "__array_new_fixed element",
        spanForArg(arg, ctx),
      );
    });
  }

  return ctx.arena.internFixedArray(elementType);
};

const inferArrayLiteralElementType = ({
  args,
  ctx,
  state,
  span,
}: {
  args: readonly Arg[];
  ctx: TypingContext;
  state: TypingState;
  span?: SourceSpan;
}): TypeId => {
  const callSpan = normalizeSpan(span, ctx.hir.module.span);

  if (args.length === 0) {
    return emitDiagnostic({
      ctx,
      code: "TY0023",
      params: { kind: "array-literal-empty" },
      span: callSpan,
    });
  }

  const nonUnknown = args
    .map((arg) => arg.type)
    .filter((type) => type !== ctx.primitives.unknown);

  if (nonUnknown.length === 0) {
    return ctx.primitives.unknown;
  }

  const unique = [...new Set(nonUnknown)];
  if (unique.length === 1) {
    return unique[0]!;
  }

  const primitives = unique.filter((type) => {
    const desc = ctx.arena.get(type);
    return desc.kind === "primitive";
  });

  if (primitives.length > 0) {
    const first = primitives[0]!;
    const allPrimitive = primitives.length === unique.length;
    const homogeneous = primitives.every((type) => type === first);
    if (allPrimitive && homogeneous) {
      return first;
    }
    return emitDiagnostic({
      ctx,
      code: "TY0024",
      params: { kind: "array-literal-mixed-primitives" },
      span: callSpan,
    });
  }

  const candidates = unique.filter((candidate) =>
    unique.every((member) => typeSatisfies(member, candidate, ctx, state)),
  );

  const bestCandidate = candidates.find((candidate) =>
    candidates.every((other) => typeSatisfies(candidate, other, ctx, state)),
  );

  if (bestCandidate) {
    return bestCandidate;
  }

  if (candidates.length > 0) {
    return candidates[0]!;
  }

  const allNominalObjects = unique.every((type) => {
    const nominal = getNominalComponent(type, ctx);
    if (typeof nominal !== "number") return false;
    return nominal !== ctx.objects.base.nominal;
  });

  if (allNominalObjects) {
    return ctx.arena.internUnion(unique);
  }

  const allStructural = unique.every((type) => {
    const structuralFields = getStructuralFields(type, ctx, state);
    if (!structuralFields) return false;
    const nominalComponent = getNominalComponent(type, ctx);
    return nominalComponent === undefined;
  });

  if (allStructural) {
    return ctx.objects.base.type;
  }

  return emitDiagnostic({
    ctx,
    code: "TY0025",
    params: { kind: "array-literal-incompatible" },
    span: callSpan,
  });
};

const typeArrayGetIntrinsic = ({
  args,
  ctx,
  state,
  typeArguments,
  allowTypeArguments,
}: {
  args: readonly Arg[];
  ctx: TypingContext;
  state: TypingState;
  typeArguments?: readonly TypeId[];
  allowTypeArguments?: boolean;
}): TypeId => {
  assertIntrinsicArgCount({
    name: "__array_get",
    args,
    expected: 2,
    detail: "array and index",
  });
  const { element } = requireFixedArrayArg({
    arg: args[0]!.type,
    ctx,
    state,
    source: "__array_get target",
  });
  validateIntrinsicTypeArguments({
    name: "__array_get",
    typeArguments,
    expectedType: element,
    allow: allowTypeArguments === true,
    ctx,
    state,
  });
  const int32 = getPrimitiveType(ctx, "i32");
  ensureTypeMatches(
    args[1]!.type,
    int32,
    ctx,
    state,
    "__array_get index",
    spanForArg(args[1]!, ctx),
  );
  return element;
};

const typeArraySetIntrinsic = ({
  args,
  ctx,
  state,
  typeArguments,
  allowTypeArguments,
}: {
  args: readonly Arg[];
  ctx: TypingContext;
  state: TypingState;
  typeArguments?: readonly TypeId[];
  allowTypeArguments?: boolean;
}): TypeId => {
  assertIntrinsicArgCount({
    name: "__array_set",
    args,
    expected: 3,
    detail: "array, index, and value",
  });
  const { array, element } = requireFixedArrayArg({
    arg: args[0]!.type,
    ctx,
    state,
    source: "__array_set target",
  });
  validateIntrinsicTypeArguments({
    name: "__array_set",
    typeArguments,
    expectedType: element,
    allow: allowTypeArguments === true,
    ctx,
    state,
  });
  const int32 = getPrimitiveType(ctx, "i32");
  ensureTypeMatches(
    args[1]!.type,
    int32,
    ctx,
    state,
    "__array_set index",
    spanForArg(args[1]!, ctx),
  );
  ensureTypeMatches(
    args[2]!.type,
    element,
    ctx,
    state,
    "__array_set value",
    spanForArg(args[2]!, ctx),
  );
  return array;
};

const typeArrayLenIntrinsic = ({
  args,
  ctx,
  state,
  typeArguments,
  allowTypeArguments,
}: {
  args: readonly Arg[];
  ctx: TypingContext;
  state: TypingState;
  typeArguments?: readonly TypeId[];
  allowTypeArguments?: boolean;
}): TypeId => {
  assertIntrinsicArgCount({
    name: "__array_len",
    args,
    expected: 1,
    detail: "array",
  });
  const { element } = requireFixedArrayArg({
    arg: args[0]!.type,
    ctx,
    state,
    source: "__array_len target",
  });
  validateIntrinsicTypeArguments({
    name: "__array_len",
    typeArguments,
    expectedType: element,
    allow: allowTypeArguments === true,
    ctx,
    state,
  });
  return getPrimitiveType(ctx, "i32");
};

const typeArrayCopyIntrinsic = ({
  args,
  ctx,
  state,
  typeArguments,
  allowTypeArguments,
}: {
  args: readonly Arg[];
  ctx: TypingContext;
  state: TypingState;
  typeArguments?: readonly TypeId[];
  allowTypeArguments?: boolean;
}): TypeId => {
  assertIntrinsicArgCountOneOf({
    name: "__array_copy",
    args,
    expected: [2, 5],
  });
  const { array, element } = requireFixedArrayArg({
    arg: args[0]!.type,
    ctx,
    state,
    source: "__array_copy target",
  });
  validateIntrinsicTypeArguments({
    name: "__array_copy",
    typeArguments,
    expectedType: element,
    allow: allowTypeArguments === true,
    ctx,
    state,
  });
  const int32 = getPrimitiveType(ctx, "i32");
  if (args.length === 2) {
    const optionsFields = getStructuralFields(args[1]!.type, ctx, state);
    if (!optionsFields) {
      throw new Error("__array_copy options must be a structural object");
    }
    const toIndex = requireArrayCopyOptionsField({
      fields: optionsFields,
      name: "to_index",
    });
    const fromType = requireArrayCopyOptionsField({
      fields: optionsFields,
      name: "from",
    });
    const fromArray = requireFixedArrayArg({
      arg: fromType,
      ctx,
      state,
      source: "__array_copy options.from",
    });
    const fromIndex = requireArrayCopyOptionsField({
      fields: optionsFields,
      name: "from_index",
    });
    const count = requireArrayCopyOptionsField({
      fields: optionsFields,
      name: "count",
    });

    ensureTypeMatches(
      toIndex,
      int32,
      ctx,
      state,
      "__array_copy to_index",
      spanForObjectLiteralFieldValue(args[1]!, "to_index", ctx),
    );
    ensureTypeMatches(
      fromIndex,
      int32,
      ctx,
      state,
      "__array_copy from_index",
      spanForObjectLiteralFieldValue(args[1]!, "from_index", ctx),
    );
    ensureTypeMatches(
      count,
      int32,
      ctx,
      state,
      "__array_copy count",
      spanForObjectLiteralFieldValue(args[1]!, "count", ctx),
    );
    ensureTypeMatches(
      fromArray.element,
      element,
      ctx,
      state,
      "__array_copy element type",
      spanForObjectLiteralFieldValue(args[1]!, "from", ctx),
    );
    return array;
  }

  ensureTypeMatches(
    args[1]!.type,
    int32,
    ctx,
    state,
    "__array_copy to_index",
    spanForArg(args[1]!, ctx),
  );
  const fromArray = requireFixedArrayArg({
    arg: args[2]!.type,
    ctx,
    state,
    source: "__array_copy source",
  });
  ensureTypeMatches(
    args[3]!.type,
    int32,
    ctx,
    state,
    "__array_copy from_index",
    spanForArg(args[3]!, ctx),
  );
  ensureTypeMatches(
    args[4]!.type,
    int32,
    ctx,
    state,
    "__array_copy count",
    spanForArg(args[4]!, ctx),
  );
  ensureTypeMatches(
    fromArray.element,
    element,
    ctx,
    state,
    "__array_copy element type",
    spanForArg(args[2]!, ctx),
  );
  return array;
};

const typeRefIsNullIntrinsic = ({
  args,
  ctx,
}: {
  args: readonly Arg[];
  ctx: TypingContext;
}): TypeId => {
  assertIntrinsicArgCount({
    name: "__ref_is_null",
    args,
    expected: 1,
    detail: "value",
  });
  return ctx.primitives.bool;
};

const typeMemorySizeIntrinsic = ({
  args,
  ctx,
  typeArguments,
}: {
  args: readonly Arg[];
  ctx: TypingContext;
  typeArguments?: readonly TypeId[];
}): TypeId => {
  assertIntrinsicArgCount({ name: "__memory_size", args, expected: 0 });
  assertNoIntrinsicTypeArgs("__memory_size", typeArguments);
  return getPrimitiveType(ctx, "i32");
};

const typeMemoryGrowIntrinsic = ({
  args,
  ctx,
  state,
  typeArguments,
}: {
  args: readonly Arg[];
  ctx: TypingContext;
  state: TypingState;
  typeArguments?: readonly TypeId[];
}): TypeId => {
  assertIntrinsicArgCount({
    name: "__memory_grow",
    args,
    expected: 1,
    detail: "pages",
  });
  assertNoIntrinsicTypeArgs("__memory_grow", typeArguments);
  const int32 = getPrimitiveType(ctx, "i32");
  ensureTypeMatches(args[0]!.type, int32, ctx, state, "__memory_grow pages");
  return int32;
};

const typeMemoryLoadIntrinsic = ({
  name,
  args,
  ctx,
  state,
  typeArguments,
}: {
  name: string;
  args: readonly Arg[];
  ctx: TypingContext;
  state: TypingState;
  typeArguments?: readonly TypeId[];
}): TypeId => {
  assertIntrinsicArgCount({ name, args, expected: 1, detail: "ptr" });
  assertNoIntrinsicTypeArgs(name, typeArguments);
  const int32 = getPrimitiveType(ctx, "i32");
  ensureTypeMatches(args[0]!.type, int32, ctx, state, `${name} ptr`);
  return int32;
};

const typeMemoryStoreIntrinsic = ({
  name,
  args,
  ctx,
  state,
  typeArguments,
}: {
  name: string;
  args: readonly Arg[];
  ctx: TypingContext;
  state: TypingState;
  typeArguments?: readonly TypeId[];
}): TypeId => {
  assertIntrinsicArgCount({ name, args, expected: 2, detail: "ptr and value" });
  assertNoIntrinsicTypeArgs(name, typeArguments);
  const int32 = getPrimitiveType(ctx, "i32");
  ensureTypeMatches(args[0]!.type, int32, ctx, state, `${name} ptr`);
  ensureTypeMatches(args[1]!.type, int32, ctx, state, `${name} value`);
  return ctx.primitives.void;
};

const typeMemoryCopyIntrinsic = ({
  args,
  ctx,
  state,
  typeArguments,
}: {
  args: readonly Arg[];
  ctx: TypingContext;
  state: TypingState;
  typeArguments?: readonly TypeId[];
}): TypeId => {
  assertIntrinsicArgCount({ name: "__memory_copy", args, expected: 3 });
  assertNoIntrinsicTypeArgs("__memory_copy", typeArguments);
  const int32 = getPrimitiveType(ctx, "i32");
  ensureTypeMatches(args[0]!.type, int32, ctx, state, "__memory_copy dest");
  ensureTypeMatches(args[1]!.type, int32, ctx, state, "__memory_copy src");
  ensureTypeMatches(args[2]!.type, int32, ctx, state, "__memory_copy len");
  return ctx.primitives.void;
};

const typePanicTrapIntrinsic = ({
  args,
  ctx,
  typeArguments,
}: {
  args: readonly Arg[];
  ctx: TypingContext;
  typeArguments?: readonly TypeId[];
}): TypeId => {
  assertIntrinsicArgCount({ name: "__panic_trap", args, expected: 0 });
  assertNoIntrinsicTypeArgs("__panic_trap", typeArguments);
  return ctx.primitives.void;
};

const typeShiftIntrinsic = ({
  name,
  args,
  ctx,
  state,
  typeArguments,
}: {
  name: string;
  args: readonly Arg[];
  ctx: TypingContext;
  state: TypingState;
  typeArguments?: readonly TypeId[];
}): TypeId => {
  assertIntrinsicArgCount({
    name,
    args,
    expected: 2,
    detail: "value and bits",
  });
  assertNoIntrinsicTypeArgs(name, typeArguments);
  const int32 = getPrimitiveType(ctx, "i32");
  const int64 = getPrimitiveType(ctx, "i64");
  if (args[0]!.type !== int32 && args[0]!.type !== int64) {
    throw new Error(`intrinsic ${name} expects i32 or i64`);
  }
  ensureTypeMatches(args[1]!.type, int32, ctx, state, `${name} bits`);
  return args[0]!.type;
};

const typeBitwiseIntrinsic = ({
  name,
  args,
  ctx,
  state,
  typeArguments,
}: {
  name: string;
  args: readonly Arg[];
  ctx: TypingContext;
  state: TypingState;
  typeArguments?: readonly TypeId[];
}): TypeId => {
  assertIntrinsicArgCount({ name, args, expected: 2 });
  assertNoIntrinsicTypeArgs(name, typeArguments);
  const int32 = getPrimitiveType(ctx, "i32");
  const int64 = getPrimitiveType(ctx, "i64");
  if (args[0]!.type !== int32 && args[0]!.type !== int64) {
    throw new Error(`intrinsic ${name} expects i32 or i64`);
  }
  ensureTypeMatches(args[1]!.type, args[0]!.type, ctx, state, `${name} rhs`);
  return args[0]!.type;
};

const typeWrapIntrinsic = ({
  args,
  ctx,
  state,
  typeArguments,
}: {
  args: readonly Arg[];
  ctx: TypingContext;
  state: TypingState;
  typeArguments?: readonly TypeId[];
}): TypeId => {
  assertIntrinsicArgCount({ name: "__i32_wrap_i64", args, expected: 1 });
  assertNoIntrinsicTypeArgs("__i32_wrap_i64", typeArguments);
  const int32 = getPrimitiveType(ctx, "i32");
  const int64 = getPrimitiveType(ctx, "i64");
  ensureTypeMatches(args[0]!.type, int64, ctx, state, "__i32_wrap_i64 value");
  return int32;
};

const typeExtendIntrinsic = ({
  name,
  args,
  ctx,
  state,
  typeArguments,
}: {
  name: string;
  args: readonly Arg[];
  ctx: TypingContext;
  state: TypingState;
  typeArguments?: readonly TypeId[];
}): TypeId => {
  assertIntrinsicArgCount({ name, args, expected: 1 });
  assertNoIntrinsicTypeArgs(name, typeArguments);
  const int32 = getPrimitiveType(ctx, "i32");
  const int64 = getPrimitiveType(ctx, "i64");
  ensureTypeMatches(args[0]!.type, int32, ctx, state, `${name} value`);
  return int64;
};

const typeReinterpretIntrinsic = ({
  name,
  args,
  ctx,
  state,
  typeArguments,
}: {
  name: string;
  args: readonly Arg[];
  ctx: TypingContext;
  state: TypingState;
  typeArguments?: readonly TypeId[];
}): TypeId => {
  assertIntrinsicArgCount({ name, args, expected: 1 });
  assertNoIntrinsicTypeArgs(name, typeArguments);
  const int32 = getPrimitiveType(ctx, "i32");
  const int64 = getPrimitiveType(ctx, "i64");
  const float32 = getPrimitiveType(ctx, "f32");
  const float64 = getPrimitiveType(ctx, "f64");
  switch (name) {
    case "__reinterpret_f32_to_i32":
      ensureTypeMatches(args[0]!.type, float32, ctx, state, name);
      return int32;
    case "__reinterpret_i32_to_f32":
      ensureTypeMatches(args[0]!.type, int32, ctx, state, name);
      return float32;
    case "__reinterpret_f64_to_i64":
      ensureTypeMatches(args[0]!.type, float64, ctx, state, name);
      return int64;
    case "__reinterpret_i64_to_f64":
      ensureTypeMatches(args[0]!.type, int64, ctx, state, name);
      return float64;
    default:
      throw new Error(`unsupported intrinsic ${name}`);
  }
};

const typeNumericConvertIntrinsic = ({
  name,
  args,
  ctx,
  state,
  typeArguments,
}: {
  name: string;
  args: readonly Arg[];
  ctx: TypingContext;
  state: TypingState;
  typeArguments?: readonly TypeId[];
}): TypeId => {
  assertIntrinsicArgCount({ name, args, expected: 1 });
  assertNoIntrinsicTypeArgs(name, typeArguments);
  const int32 = getPrimitiveType(ctx, "i32");
  const int64 = getPrimitiveType(ctx, "i64");
  const float32 = getPrimitiveType(ctx, "f32");
  const float64 = getPrimitiveType(ctx, "f64");
  switch (name) {
    case "__f32_demote_f64":
      ensureTypeMatches(args[0]!.type, float64, ctx, state, name);
      return float32;
    case "__f64_promote_f32":
      ensureTypeMatches(args[0]!.type, float32, ctx, state, name);
      return float64;
    case "__i32_trunc_f32_s":
      ensureTypeMatches(args[0]!.type, float32, ctx, state, name);
      return int32;
    case "__i32_trunc_f64_s":
      ensureTypeMatches(args[0]!.type, float64, ctx, state, name);
      return int32;
    case "__i64_trunc_f32_s":
      ensureTypeMatches(args[0]!.type, float32, ctx, state, name);
      return int64;
    case "__i64_trunc_f64_s":
      ensureTypeMatches(args[0]!.type, float64, ctx, state, name);
      return int64;
    case "__f32_convert_i32_s":
      ensureTypeMatches(args[0]!.type, int32, ctx, state, name);
      return float32;
    case "__f32_convert_i64_s":
      ensureTypeMatches(args[0]!.type, int64, ctx, state, name);
      return float32;
    case "__f64_convert_i32_s":
      ensureTypeMatches(args[0]!.type, int32, ctx, state, name);
      return float64;
    case "__f64_convert_i64_s":
      ensureTypeMatches(args[0]!.type, int64, ctx, state, name);
      return float64;
    default:
      throw new Error(`unsupported intrinsic ${name}`);
  }
};

const assertIntrinsicArgCount = ({
  name,
  args,
  expected,
  detail,
}: {
  name: string;
  args: readonly Arg[];
  expected: number;
  detail?: string;
}): void => {
  if (args.length === expected) {
    return;
  }
  const descriptor = detail ? ` (${detail})` : "";
  throw new Error(
    `intrinsic ${name} expects ${expected} argument(s)${descriptor}, received ${args.length}`,
  );
};

const assertIntrinsicArgCountOneOf = ({
  name,
  args,
  expected,
}: {
  name: string;
  args: readonly Arg[];
  expected: readonly number[];
}): void => {
  if (expected.includes(args.length)) {
    return;
  }
  const descriptor = expected.join(" or ");
  throw new Error(
    `intrinsic ${name} expects ${descriptor} argument(s), received ${args.length}`,
  );
};

const requireSingleTypeArgument = ({
  name,
  typeArguments,
  detail,
}: {
  name: string;
  typeArguments?: readonly TypeId[];
  detail?: string;
}): TypeId => {
  const count = typeArguments?.length ?? 0;
  if (count === 1) {
    return typeArguments![0]!;
  }
  const descriptor = detail ? ` for ${detail}` : "";
  throw new Error(
    `intrinsic ${name} requires exactly 1 type argument${descriptor}, received ${count}`,
  );
};

const assertNoIntrinsicTypeArgs = (
  name: string,
  typeArguments: readonly TypeId[] | undefined,
): void => {
  if (!typeArguments || typeArguments.length === 0) {
    return;
  }
  throw new Error(`intrinsic ${name} does not accept type arguments`);
};

const validateIntrinsicTypeArguments = ({
  name,
  typeArguments,
  expectedType,
  allow,
  ctx,
  state,
}: {
  name: string;
  typeArguments?: readonly TypeId[];
  expectedType: TypeId;
  allow: boolean;
  ctx: TypingContext;
  state: TypingState;
}): void => {
  if (!allow) {
    assertNoIntrinsicTypeArgs(name, typeArguments);
    return;
  }
  if (!typeArguments || typeArguments.length === 0) {
    return;
  }
  const provided = requireSingleTypeArgument({
    name,
    typeArguments,
    detail: "element type",
  });
  ensureTypeMatches(
    provided,
    expectedType,
    ctx,
    state,
    `${name} type argument`,
  );
};

const requireArrayCopyOptionsField = ({
  fields,
  name,
}: {
  fields: readonly { name: string; type: TypeId }[];
  name: string;
}): TypeId => {
  const field = fields.find((entry) => entry.name === name);
  if (field) {
    return field.type;
  }
  throw new Error(`intrinsic __array_copy options missing field ${name}`);
};

const requireFixedArrayArg = ({
  arg,
  ctx,
  state,
  source,
}: {
  arg: TypeId;
  ctx: TypingContext;
  state: TypingState;
  source: string;
}): { array: TypeId; element: TypeId } => {
  const desc = ctx.arena.get(arg);
  if (desc.kind === "fixed-array") {
    return { array: arg, element: desc.element };
  }
  if (state.mode === "relaxed") {
    const fallback = ctx.arena.internFixedArray(ctx.primitives.unknown);
    return { array: fallback, element: ctx.primitives.unknown };
  }
  throw new Error(`${source} must be a FixedArray`);
};

const intrinsicSignatureMatches = (
  signature: IntrinsicSignature,
  args: readonly Arg[],
  ctx: TypingContext,
): boolean => {
  if (signature.parameters.length !== args.length) {
    return false;
  }
  return signature.parameters.every((param, index) => {
    const arg = args[index];
    return arg.type === ctx.primitives.unknown || param === arg.type;
  });
};
