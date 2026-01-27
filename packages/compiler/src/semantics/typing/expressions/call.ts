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
import {
  bindTypeParamsFromType,
  ensureTypeMatches,
  getNominalComponent,
  getPrimitiveType,
  getStructuralFields,
  resolveTypeExpr,
  typeSatisfies,
  getSymbolName,
} from "../type-system.js";
import {
  getOptionalInfo,
  optionalResolverContextForTypingContext,
} from "../optionals.js";
import {
  emitDiagnostic,
  normalizeSpan,
} from "../../../diagnostics/index.js";
import {
  composeEffectRows,
  freshOpenEffectRow,
  getExprEffectRow,
  ensureEffectCompatibility,
} from "../effects.js";
import {
  intrinsicSignaturesFor,
  type IntrinsicSignature,
} from "./intrinsics.js";
import { typeExpression } from "../expressions.js";
import { applyCurrentSubstitution } from "./shared.js";
import { getValueType } from "./identifier.js";
import { assertMutableObjectBinding, findBindingSymbol } from "./mutability.js";
import type {
  Arg,
  FunctionSignature,
  FunctionTypeParam,
  ParamSignature,
  TypingContext,
  TypingState,
} from "../types.js";
import { assertMemberAccess } from "../visibility.js";
import type { SymbolRef } from "../symbol-ref.js";
import {
  canonicalSymbolRefForTypingContext,
  localSymbolForSymbolRef,
  symbolRefKey,
} from "../symbol-ref-utils.js";

type SymbolNameResolver = (symbol: SymbolId) => string;

type MethodCallCandidate = {
  symbol: SymbolId;
  signature: FunctionSignature;
  symbolRef: SymbolRef;
  nameForSymbol?: SymbolNameResolver;
  exported?: ModuleExportEntry;
};

type MethodCallResolution = {
  candidates: MethodCallCandidate[];
  receiverName?: string;
};

export const typeCallExpr = (
  expr: HirCallExpr,
  ctx: TypingContext,
  state: TypingState,
  expectedReturnType?: TypeId
): TypeId => {
  const calleeExpr = ctx.hir.expressions.get(expr.callee);
  if (!calleeExpr) {
    throw new Error(`missing callee expression ${expr.callee}`);
  }

  const typeArguments =
    expr.typeArguments && expr.typeArguments.length > 0
      ? resolveTypeArguments(expr.typeArguments, ctx, state)
      : undefined;

  const expectedParams = getExpectedCallParameters({
    callee: calleeExpr,
    typeArguments,
    expectedReturnType,
    ctx,
    state,
  });

  const args = expr.args.map((arg, index) => ({
    label: arg.label,
    type: typeExpression(arg.expr, ctx, state, expectedParams?.[index]),
    exprId: arg.expr,
  }));

  const argEffectRow = composeEffectRows(
    ctx.effects,
    args.map((arg) =>
      typeof arg.exprId === "number"
        ? getExprEffectRow(arg.exprId, ctx)
        : ctx.effects.emptyRow
    )
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
    if (typeArguments && typeArguments.length > 0) {
      throw new Error(
        "type arguments are not supported with overload sets yet"
      );
    }
    ctx.table.setExprType(calleeExpr.id, ctx.primitives.unknown);
    ctx.effects.setExprEffect(calleeExpr.id, ctx.effects.emptyRow);
    const overloaded = typeOverloadedCall(
      expr,
      calleeExpr,
      args,
      ctx,
      state,
      expectedReturnType
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
        span: calleeExpr.span,
        ctx,
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
    const intrinsicSignatures =
      metadata.intrinsic === true
        ? intrinsicSignaturesFor(intrinsicName, ctx)
        : undefined;
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
        span: calleeExpr.span,
        ctx,
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
        expr.span
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
        applyCurrentSubstitution(calleeType, ctx, state)
      );
      return finalizeCall({
        returnType,
        latentEffectRow: signature?.effectRow ?? ctx.primitives.defaultEffectRow,
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
            expr.span
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
        (intrinsicSignatures && intrinsicSignatures.length > 0)
      ? getValueType(calleeExpr.symbol, ctx)
      : expectedCalleeType(args, ctx);
    ctx.table.setExprType(calleeExpr.id, calleeType);
    ctx.resolvedExprTypes.set(
      calleeExpr.id,
      applyCurrentSubstitution(calleeType, ctx, state)
    );
    ctx.effects.setExprEffect(calleeExpr.id, ctx.effects.emptyRow);

    if (signature) {
      const calleeRef = canonicalSymbolRefForTypingContext(calleeExpr.symbol, ctx);
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
          expr.span
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

  const calleeType = typeExpression(
    expr.callee,
    ctx,
    state,
    expectedCalleeType(args, ctx)
  );

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
  nameForSymbol?: SymbolNameResolver
): string => (nameForSymbol ? nameForSymbol(symbol) : getSymbolName(symbol, ctx));

export const typeMethodCallExpr = (
  expr: HirMethodCallExpr,
  ctx: TypingContext,
  state: TypingState,
  expectedReturnType?: TypeId
): TypeId => {
  const typeArguments =
    expr.typeArguments && expr.typeArguments.length > 0
      ? resolveTypeArguments(expr.typeArguments, ctx, state)
      : undefined;

  const targetType = typeExpression(expr.target, ctx, state);
  const args: Arg[] = [
    { type: targetType, exprId: expr.target },
    ...expr.args.map((arg) => ({
      label: arg.label,
      type: typeExpression(arg.expr, ctx, state),
      exprId: arg.expr,
    })),
  ];

  const argEffectRow = composeEffectRows(
    ctx.effects,
    args.map((arg) =>
      typeof arg.exprId === "number"
        ? getExprEffectRow(arg.exprId, ctx)
        : ctx.effects.emptyRow
    )
  );

  const finalizeCall = ({
    returnType,
    latentEffectRow = ctx.effects.emptyRow,
  }: {
    returnType: TypeId;
    latentEffectRow?: number;
  }): TypeId => {
    const callEffect = composeEffectRows(ctx.effects, [
      argEffectRow,
      latentEffectRow,
    ]);
    ctx.effects.setExprEffect(expr.id, callEffect);
    return returnType;
  };

  if (targetType === ctx.primitives.unknown) {
    return finalizeCall({ returnType: ctx.primitives.unknown });
  }

  const resolution = resolveMethodCallCandidates({
    receiverType: targetType,
    methodName: expr.method,
    ctx,
  });
  if (!resolution || resolution.candidates.length === 0) {
    reportUnknownMethod({
      methodName: expr.method,
      receiverName: resolution?.receiverName,
      span: expr.span,
      ctx,
    });
    return finalizeCall({ returnType: ctx.primitives.unknown });
  }

  const matches = resolution.candidates.filter(({ symbol, signature }) =>
    matchesOverloadSignature(symbol, signature, args, ctx, state, typeArguments)
  );
  const traitDispatch =
    matches.length === 0
      ? resolveTraitDispatchOverload({
          candidates: resolution.candidates,
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
        params: { kind: "no-overload", name: expr.method },
        span: expr.span,
      });
    }

    if (matches.length > 1) {
      emitDiagnostic({
        ctx,
        code: "TY0007",
        params: { kind: "ambiguous-overload", name: expr.method },
        span: expr.span,
      });
    }

    selected = matches[0];
  }

  if (!selected) {
    return finalizeCall({ returnType: ctx.primitives.unknown });
  }

  const instanceKey = state.currentFunction?.instanceKey;
  if (!instanceKey) {
    throw new Error(
      `missing function instance key for method call ${expr.id}`
    );
  }

  if (traitDispatch) {
    ctx.callResolution.traitDispatches.add(expr.id);
  } else {
    ctx.callResolution.traitDispatches.delete(expr.id);
  }

  if (selected.exported) {
    assertExportedMemberAccess({
      exported: selected.exported,
      methodName: expr.method,
      ctx,
      state,
      span: expr.span,
    });
  } else {
    assertMemberAccess({
      symbol: selected.symbol,
      ctx,
      state,
      span: expr.span,
      context: "calling member",
    });
  }

  const selectedRef =
    selected.symbolRef ?? canonicalSymbolRefForTypingContext(selected.symbol, ctx);
  const targets =
    ctx.callResolution.targets.get(expr.id) ?? new Map<string, SymbolRef>();
  targets.set(instanceKey, selectedRef);
  ctx.callResolution.targets.set(expr.id, targets);

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

  return finalizeCall({ returnType, latentEffectRow: effectRow });
};

const getExpectedCallParameters = ({
  callee,
  typeArguments,
  expectedReturnType,
  ctx,
  state,
}: {
  callee: HirExpression;
  typeArguments: readonly TypeId[] | undefined;
  expectedReturnType: TypeId | undefined;
  ctx: TypingContext;
  state: TypingState;
}): readonly TypeId[] | undefined => {
  if (
    callee.exprKind === "overload-set" &&
    typeof expectedReturnType === "number" &&
    expectedReturnType !== ctx.primitives.unknown
  ) {
    const overloads = ctx.overloads.get(callee.set);
    if (!overloads) {
      return undefined;
    }
    const candidates = overloads
      .map((symbol) => ctx.functions.getSignature(symbol))
      .filter((entry): entry is FunctionSignature => Boolean(entry));
    const matchingReturn = candidates.filter((signature) =>
      typeSatisfies(signature.returnType, expectedReturnType, ctx, state)
    );
    if (matchingReturn.length !== 1) {
      return undefined;
    }
    return matchingReturn[0].parameters.map((param) => param.type);
  }

  if (callee.exprKind !== "identifier") {
    return undefined;
  }
  const signature = ctx.functions.getSignature(callee.symbol);
  if (!signature) {
    return undefined;
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
  return signature.parameters.map((param) =>
    substitution ? ctx.arena.substitute(param.type, substitution) : param.type
  );
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
        ctx
      )} received too many type arguments`
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
  state: TypingState
): TypeId[] | undefined =>
  typeArguments && typeArguments.length > 0
    ? typeArguments.map((entry) =>
        resolveTypeExpr(
          entry,
          ctx,
          state,
          ctx.primitives.unknown,
          state.currentFunction?.typeParams
        )
      )
    : undefined;

const expectedParamLabel = (param: ParamSignature): string | undefined =>
  param.label ?? param.name;

const labelsCompatible = (
  param: ParamSignature,
  argLabel: string | undefined
): boolean => {
  const expected = expectedParamLabel(param);
  if (!expected) {
    return argLabel === undefined;
  }
  if (param.label) {
    return argLabel === expected;
  }
  return argLabel === undefined || argLabel === expected;
};

const validateCallArgs = (
  args: readonly Arg[],
  params: readonly ParamSignature[],
  ctx: TypingContext,
  state: TypingState,
  callSpan?: SourceSpan
): void => {
  const span = callSpan ?? ctx.hir.module.span;

  let argIndex = 0;
  let paramIndex = 0;

  while (paramIndex < params.length) {
    const param = params[paramIndex]!;
    const arg = args[argIndex];

    if (!arg) {
      if (param.optional) {
        const optionalInfo = getOptionalInfo(
          param.type,
          optionalResolverContextForTypingContext(ctx)
        );
        if (!optionalInfo) {
          throw new Error("optional parameter type must be Optional");
        }
        ensureTypeMatches(
          optionalInfo.noneType,
          param.type,
          ctx,
          state,
          `call argument ${paramIndex + 1}`
        );
        paramIndex += 1;
        continue;
      }

      emitDiagnostic({
        ctx,
        code: "TY0021",
        params: {
          kind: "call-missing-argument",
          paramName: param.name ?? param.label ?? `parameter ${paramIndex + 1}`,
        },
        span,
      });
      throw new Error("call argument count mismatch");
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
            (field) => field.name === runParam.label
          );
          if (match) {
            ensureTypeMatches(
              match.type,
              runParam.type,
              ctx,
              state,
              `call argument ${cursor + 1}`
            );
            const mutabilityExprId = (() => {
              if (typeof arg.exprId !== "number") {
                return undefined;
              }
              const argExpr = ctx.hir.expressions.get(arg.exprId);
              if (argExpr?.exprKind !== "object-literal") {
                return arg.exprId;
              }
              const directField = argExpr.entries.find(
                (entry) => entry.kind === "field" && entry.name === runParam.label
              );
              return directField?.kind === "field" ? directField.value : arg.exprId;
            })();
            ensureMutableArgument({
              arg: { ...arg, type: match.type, exprId: mutabilityExprId ?? arg.exprId },
              param: runParam,
              index: cursor,
              ctx,
            });
            cursor += 1;
            continue;
          }

          if (runParam.optional) {
            const optionalInfo = getOptionalInfo(
              runParam.type,
              optionalResolverContextForTypingContext(ctx)
            );
            if (!optionalInfo) {
              throw new Error("optional parameter type must be Optional");
            }
            ensureTypeMatches(
              optionalInfo.noneType,
              runParam.type,
              ctx,
              state,
              `call argument ${cursor + 1}`
            );
            cursor += 1;
            continue;
          }

          emitDiagnostic({
            ctx,
            code: "TY0021",
            params: { kind: "call-missing-labeled-argument", label: runParam.label },
            span,
          });
          throw new Error("call argument count mismatch");
        }

        if (cursor > paramIndex) {
          paramIndex = cursor;
          argIndex += 1;
          continue;
        }
      }
    }

    if (labelsCompatible(param, arg.label)) {
      ensureTypeMatches(
        arg.type,
        param.type,
        ctx,
        state,
        `call argument ${paramIndex + 1}`
      );
      ensureMutableArgument({ arg, param, index: paramIndex, ctx });
      argIndex += 1;
      paramIndex += 1;
      continue;
    }

    if (param.optional) {
      const optionalInfo = getOptionalInfo(
        param.type,
        optionalResolverContextForTypingContext(ctx)
      );
      if (!optionalInfo) {
        throw new Error("optional parameter type must be Optional");
      }
      ensureTypeMatches(
        optionalInfo.noneType,
        param.type,
        ctx,
        state,
        `call argument ${paramIndex + 1}`
      );
      paramIndex += 1;
      continue;
    }

    const expectedLabel = expectedParamLabel(param) ?? "no label";
    const actualLabel = arg.label ?? "no label";
    throw new Error(
      `call argument ${
        paramIndex + 1
      } label mismatch: expected ${expectedLabel}, got ${actualLabel}`
    );
  }

  if (argIndex < args.length) {
    emitDiagnostic({
      ctx,
      code: "TY0021",
      params: {
        kind: "call-extra-arguments",
        extra: args.length - argIndex,
      },
      span,
    });
    throw new Error("call argument count mismatch");
  }
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
}): boolean => {
  let argIndex = 0;
  let paramIndex = 0;

  while (paramIndex < params.length) {
    const param = params[paramIndex]!;
    const arg = args[argIndex];

    if (!arg) {
      return params
        .slice(paramIndex)
        .every((remaining) => Boolean(remaining.optional));
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
            (field) => field.name === runParam.label
          );
          if (match) {
            if (
              match.type !== ctx.primitives.unknown &&
              !typeSatisfies(match.type, runParam.type, ctx, state)
            ) {
              return false;
            }
            cursor += 1;
            continue;
          }
          if (runParam.optional) {
            cursor += 1;
            continue;
          }
          return false;
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
        arg.type !== ctx.primitives.unknown &&
        !typeSatisfies(arg.type, param.type, ctx, state)
      ) {
        return false;
      }
      paramIndex += 1;
      argIndex += 1;
      continue;
    }

    if (param.optional) {
      paramIndex += 1;
      continue;
    }

    return false;
  }

  return argIndex === args.length;
};

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

const adjustTraitDispatchParameters = ({
  args,
  params,
  calleeSymbol,
  ctx,
}: {
  args: readonly Arg[];
  params: readonly ParamSignature[];
  calleeSymbol: SymbolId;
  ctx: TypingContext;
}): readonly ParamSignature[] | undefined => {
  if (args.length === 0 || params.length === 0) {
    return undefined;
  }
  const methodMetadata = ctx.traitMethodImpls.get(calleeSymbol);
  if (!methodMetadata) {
    return undefined;
  }
  const receiverType = args[0].type;
  const receiverDesc = ctx.arena.get(receiverType);
  const receiverTraitSymbol =
    receiverDesc.kind === "trait"
      ? localSymbolForSymbolRef(receiverDesc.owner, ctx)
      : undefined;
  if (
    receiverDesc.kind !== "trait" ||
    receiverTraitSymbol !== methodMetadata.traitSymbol
  ) {
    return undefined;
  }
  const updated = [{ ...params[0]!, type: receiverType }, ...params.slice(1)];
  return updated;
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
  receiverType,
  signature,
  ctx,
  state,
}: {
  calleeSymbol: SymbolId;
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
  const methodMetadata = ctx.traitMethodImpls.get(calleeSymbol);
  if (!methodMetadata) {
    return undefined;
  }
  const receiverTraitSymbol = localSymbolForSymbolRef(receiverDesc.owner, ctx);
  if (
    typeof receiverTraitSymbol !== "number" ||
    receiverTraitSymbol !== methodMetadata.traitSymbol
  ) {
    return undefined;
  }
  const template = ctx.traits
    .getImplTemplatesForTrait(receiverTraitSymbol)
    .find(
      (entry) =>
        entry.methods.get(methodMetadata.traitMethodSymbol) === calleeSymbol
    );
  if (!template) {
    return undefined;
  }

  const allowUnknown = state.mode === "relaxed";
  const match = ctx.arena.unify(receiverType, template.trait, {
    location: ctx.hir.module.ast,
    reason: "trait method inference",
    variance: "covariant",
    allowUnknown,
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
    params: { kind: "unknown-function", name },
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

const formatVisibilityLabel = (visibility: ModuleExportEntry["visibility"]): string => {
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
      return traitResolution;
    }
    return {
      candidates: resolveFreeFunctionCandidates({ methodName, ctx }),
      receiverName: traitResolution.receiverName,
    };
  }
  const nominalResolution = resolveNominalMethodCandidates({
    receiverType,
    methodName,
    ctx,
  });
  if (nominalResolution && nominalResolution.candidates.length > 0) {
    return nominalResolution;
  }
  return {
    candidates: resolveFreeFunctionCandidates({ methodName, ctx }),
    receiverName: nominalResolution?.receiverName,
  };
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

  const matches = resolution.candidates.filter(({ symbol, signature }) =>
    matchesOverloadSignature(symbol, signature, args, ctx, state, typeArguments)
  );
  const traitDispatch =
    matches.length === 0
      ? resolveTraitDispatchOverload({
          candidates: resolution.candidates,
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
        params: { kind: "no-overload", name: operatorName },
        span: call.span,
      });
    }

    if (matches.length > 1) {
      emitDiagnostic({
        ctx,
        code: "TY0007",
        params: { kind: "ambiguous-overload", name: operatorName },
        span: call.span,
      });
    }

    selected = matches[0];
  }

  if (!selected) {
    return { returnType: ctx.primitives.unknown, effectRow: ctx.effects.emptyRow };
  }

  const instanceKey = state.currentFunction?.instanceKey;
  if (!instanceKey) {
    throw new Error(
      `missing function instance key for operator resolution at call ${call.id}`
    );
  }

  if (traitDispatch) {
    ctx.callResolution.traitDispatches.add(call.id);
  } else {
    ctx.callResolution.traitDispatches.delete(call.id);
  }

  if (selected.exported) {
    assertExportedMemberAccess({
      exported: selected.exported,
      methodName: operatorName,
      ctx,
      state,
      span: call.span,
    });
  } else {
    assertMemberAccess({
      symbol: selected.symbol,
      ctx,
      state,
      span: call.span,
      context: "calling member",
    });
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
  const receiverName =
    ownerRef.moduleId === ctx.moduleId
      ? (() => {
          const owner = localSymbolForSymbolRef(ownerRef, ctx);
          return typeof owner === "number"
            ? ctx.symbolTable.getSymbol(owner).name
            : undefined;
        })()
      : (() => {
          const dependency = ctx.dependencies.get(ownerRef.moduleId);
          return dependency
            ? dependency.symbolTable.getSymbol(ownerRef.symbol).name
            : undefined;
        })();

  return { candidates, receiverName };
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
  const traitSymbol = localSymbolForSymbolRef(receiverDesc.owner, ctx);
  if (typeof traitSymbol !== "number") {
    return { candidates: [] };
  }
  const traitDecl = ctx.traits.getDecl(traitSymbol);
  const traitName = ctx.symbolTable.getSymbol(traitSymbol).name;
  const traitMethod = traitDecl?.methods.find(
    (method) => ctx.symbolTable.getSymbol(method.symbol).name === methodName
  );
  if (!traitMethod) {
    return { candidates: [], receiverName: traitName };
  }

  const implMethods = new Set<SymbolId>();
  const impls = ctx.traitImplsByTrait.get(traitSymbol) ?? [];
  impls.forEach((impl) => {
    const methodSymbol = impl.methods.get(traitMethod.symbol);
    if (typeof methodSymbol === "number") {
      implMethods.add(methodSymbol);
    }
  });
  const templates = ctx.traits.getImplTemplatesForTrait(traitSymbol);
  templates.forEach((template) => {
    const methodSymbol = template.methods.get(traitMethod.symbol);
    if (typeof methodSymbol === "number") {
      implMethods.add(methodSymbol);
    }
  });

  const candidates = Array.from(implMethods)
    .map((symbol) => {
      const signature = ctx.functions.getSignature(symbol);
      if (!signature) {
        throw new Error(
          `missing type signature for trait method ${getSymbolName(symbol, ctx)}`
        );
      }
      return {
        symbol,
        signature,
        symbolRef: { moduleId: ctx.moduleId, symbol },
      };
    });

  return { candidates, receiverName: traitName };
};

const resolveFreeFunctionCandidates = ({
  methodName,
  ctx,
}: {
  methodName: string;
  ctx: TypingContext;
}): MethodCallCandidate[] => {
  const symbols = ctx.symbolTable.resolveAll(methodName, ctx.symbolTable.rootScope);
  if (!symbols || symbols.length === 0) {
    return [];
  }

  return symbols
    .map((symbol) => {
      const record = ctx.symbolTable.getSymbol(symbol);
      if (record.kind !== "value") {
        return undefined;
      }
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
          `missing type signature for method ${getSymbolName(symbol, ctx)}`
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
    const signature = dependency.typing.functions.getSignature(symbol);
    if (!signature) {
      throw new Error(`missing type signature for method ${nameForSymbol(symbol)}`);
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
    validateCallArgs(segment, parameters, ctx, state, callSpan);

    remainingArgs = remainingArgs.slice(parameters.length);
    if (remainingArgs.length === 0) {
      return returnType;
    }

    currentType = returnType;
  }
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
	  const record = isExternal ? undefined : ctx.symbolTable.getSymbol(calleeSymbol);
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
      ctx,
    }) ?? instantiation.parameters;

  const callSpan = ctx.hir.expressions.get(callId)?.span;
  validateCallArgs(args, adjustedParameters, ctx, state, callSpan);

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
      applyCurrentSubstitution(calleeType, ctx, state)
    );
  }

  if (hasTypeParams) {
    const mergedSubstitution = mergeSubstitutions(
      instantiation.substitution,
      state.currentFunction?.substitution,
      ctx
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
	    const existingTypeArgs = ctx.callResolution.typeArguments.get(callId) ?? new Map();
	    existingTypeArgs.set(callerInstanceKey, codegenTypeArgs);
	    ctx.callResolution.typeArguments.set(callId, existingTypeArgs);
	    const existingKeys = ctx.callResolution.instanceKeys.get(callId) ?? new Map();
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
        appliedTypeArgs
      );
	    }
	  } else {
	    ctx.callResolution.typeArguments.delete(callId);
	    ctx.callResolution.instanceKeys.delete(callId);
	  }

  return { returnType: instantiation.returnType, effectRow: signature.effectRow };
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
        nameForSymbol
      )} received too many type arguments`
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
      state
    );
  }

  const missing = typeParams.filter((param) => !substitution.has(param.typeParam));
  if (missing.length > 0) {
    throw new Error(
      `function ${resolveSymbolName(calleeSymbol, ctx, nameForSymbol)} is missing ${
        missing.length
      } type argument(s)`
    );
  }

  typeParams.forEach((param) =>
    enforceTypeParamConstraint(
      param,
      substitution,
      ctx,
      state,
      nameForSymbol
    )
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
  nameForSymbol?: SymbolNameResolver
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
    throw new Error(
      `type argument for ${resolveSymbolName(
        param.symbol,
        ctx,
        nameForSymbol
      )} does not satisfy its constraint`
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
    ctx
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
      : signature.typeParamMap ?? previousFunction?.typeParams;
  const expectedReturn = ctx.arena.substitute(
    signature.returnType,
    mergedSubstitution
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
    bodyType = typeExpression(fn.body, ctx, state, expectedReturn);
    ensureTypeMatches(
      bodyType,
      expectedReturn,
      ctx,
      state,
      `function ${getSymbolName(symbol, ctx)} return type`
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
        functionType
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
          signature.effectRow ?? ctx.primitives.defaultEffectRow
        );
      }
    }
    ctx.functions.cacheInstanceValueTypes(key, ctx.valueTypes);
    ctx.functions.cacheInstance(key, expectedReturn, ctx.resolvedExprTypes);
    ctx.functions.recordInstantiation(
      symbolRefKey(canonicalSymbolRefForTypingContext(symbol, ctx)),
      key,
      appliedTypeArgs
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
  ctx: TypingContext
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
          nameForSymbol
        )} is missing a type argument for ${resolveSymbolName(
          param.symbol,
          ctx,
          nameForSymbol
        )}`
      );
    }
    if (applied === ctx.primitives.unknown) {
      throw new Error(
        `function ${resolveSymbolName(
          symbol,
          ctx,
          nameForSymbol
        )} has unresolved type argument for ${resolveSymbolName(
          param.symbol,
          ctx,
          nameForSymbol
        )}`
      );
    }
    return applied;
  });
};

export const formatFunctionInstanceKey = (
  symbol: SymbolId,
  typeArgs: readonly TypeId[]
): string => `${symbol}<${typeArgs.join(",")}>`;

const typeOverloadedCall = (
  call: HirCallExpr,
  callee: HirOverloadSetExpr,
  argTypes: readonly Arg[],
  ctx: TypingContext,
  state: TypingState,
  expectedReturnType?: TypeId
): { returnType: TypeId; effectRow: number } => {
  const options = ctx.overloads.get(callee.set);
  if (!options) {
    throw new Error(
      `missing overload metadata for ${callee.name} (set ${callee.set})`
    );
  }

  const candidates = options.map((symbol) => {
    const signature = ctx.functions.getSignature(symbol);
    if (!signature) {
      throw new Error(
        `missing type signature for overloaded function ${getSymbolName(
          symbol,
          ctx
        )}`
      );
    }
    return { symbol, signature };
  });
  const matches = candidates.filter(({ symbol, signature }) =>
    matchesOverloadSignature(symbol, signature, argTypes, ctx, state)
  );

  const traitDispatch =
    matches.length === 0
      ? resolveTraitDispatchOverload({
          candidates,
          args: argTypes,
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
        params: { kind: "no-overload", name: callee.name },
        span: call.span,
      });
    }

    if (matches.length > 1) {
      emitDiagnostic({
        ctx,
        code: "TY0007",
        params: { kind: "ambiguous-overload", name: callee.name },
        span: call.span,
      });
    }

    selected = matches[0];
  }
  const instanceKey = state.currentFunction?.instanceKey;
  if (!instanceKey) {
    throw new Error(
      `missing function instance key for overload resolution at call ${call.id}`
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
  return typeFunctionCall({
    args: argTypes,
    signature: selected.signature,
    calleeSymbol: selected.symbol,
    typeArguments: undefined,
    expectedReturnType,
    callId: call.id,
    ctx,
    state,
    calleeExprId: callee.id,
    calleeModuleId: selectedRef.moduleId,
  });
};

const resolveTraitDispatchOverload = <
  T extends { symbol: SymbolId; signature: FunctionSignature }
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

  const receiverTraitSymbol = localSymbolForSymbolRef(receiverDesc.owner, ctx);
  if (typeof receiverTraitSymbol !== "number") {
    return undefined;
  }
  const impls = ctx.traitImplsByTrait.get(receiverTraitSymbol);
  const templates = ctx.traits.getImplTemplatesForTrait(receiverTraitSymbol);
  if (
    (!impls || impls.length === 0) &&
    (!templates || templates.length === 0)
  ) {
    return undefined;
  }

  const allowUnknown = state.mode === "relaxed";
  const candidate = candidates.find(({ symbol, signature }) => {
    if (signature.parameters.length === 0) {
      return false;
    }
    const methodMetadata = ctx.traitMethodImpls.get(symbol);
    if (!methodMetadata || methodMetadata.traitSymbol !== receiverTraitSymbol) {
      return false;
    }
    const hasMatchingImpl =
      impls?.some(
        (entry) =>
          entry.methods.get(methodMetadata.traitMethodSymbol) === symbol &&
          typeSatisfies(receiver.type, entry.trait, ctx, state)
      ) === true;
    const hasCompatibleTemplate =
      templates?.some((template) => {
        const implMethod = template.methods.get(
          methodMetadata.traitMethodSymbol
        );
        if (implMethod !== symbol) {
          return false;
        }
        const comparison = ctx.arena.unify(receiver.type, template.trait, {
          location: ctx.hir.module.ast,
          reason: "trait object dispatch",
          variance: "covariant",
          allowUnknown,
        });
        return comparison.ok;
      }) === true;
    if (!hasMatchingImpl && !hasCompatibleTemplate) {
      return false;
    }
    const adjustedParams =
      adjustTraitDispatchParameters({
        args,
        params: signature.parameters,
        calleeSymbol: symbol,
        ctx,
      }) ?? signature.parameters;
    return callArgumentsSatisfyParams({ args, params: adjustedParams, ctx, state });
  });

  if (!candidate) {
    return undefined;
  }

  const params =
    adjustTraitDispatchParameters({
      args,
      params: candidate.signature.parameters,
      calleeSymbol: candidate.symbol,
      ctx,
    }) ?? candidate.signature.parameters;

  if (params === candidate.signature.parameters) {
    return candidate;
  }

  const signatureDesc = ctx.arena.get(candidate.signature.typeId);
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
    returnType: candidate.signature.returnType,
    effectRow,
  });

  return {
    ...candidate,
    signature: {
      ...candidate.signature,
      parameters: params,
      typeId: adjustedType,
      effectRow,
    },
  } as T;
};

const matchesOverloadSignature = (
  symbol: SymbolId,
  signature: FunctionSignature,
  args: readonly Arg[],
  ctx: TypingContext,
  state: TypingState,
  typeArguments?: readonly TypeId[]
): boolean => {
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
          ctx
        )} must declare parameter types`
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
  span?: SourceSpan
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
      return typeMemoryStoreIntrinsic({ name, args, ctx, state, typeArguments });
    case "__memory_copy":
      return typeMemoryCopyIntrinsic({ args, ctx, state, typeArguments });
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
      return typeReinterpretIntrinsic({ name, args, ctx, state, typeArguments });
    case "__f32_demote_f64":
    case "__f64_promote_f32":
      return typeFloatConvertIntrinsic({
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
        intrinsicSignatureMatches(signature, args, ctx)
      );

      if (matches.length === 0) {
        emitDiagnostic({
          ctx,
          code: "TY0008",
          params: { kind: "no-overload", name },
          span: callSpan,
        });
        return ctx.primitives.unknown;
      }

      if (matches.length > 1) {
        emitDiagnostic({
          ctx,
          code: "TY0007",
          params: { kind: "ambiguous-overload", name },
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
      "mutable expression target"
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
  ensureTypeMatches(args[0]!.type, sizeType, ctx, state, "__array_new size");
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
        "__array_new_fixed element"
      )
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
        "__array_new_fixed element"
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
    unique.every((member) => typeSatisfies(member, candidate, ctx, state))
  );

  const bestCandidate = candidates.find((candidate) =>
    candidates.every((other) => typeSatisfies(candidate, other, ctx, state))
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
  ensureTypeMatches(args[1]!.type, int32, ctx, state, "__array_get index");
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
  ensureTypeMatches(args[1]!.type, int32, ctx, state, "__array_set index");
  ensureTypeMatches(args[2]!.type, element, ctx, state, "__array_set value");
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

    ensureTypeMatches(toIndex, int32, ctx, state, "__array_copy to_index");
    ensureTypeMatches(fromIndex, int32, ctx, state, "__array_copy from_index");
    ensureTypeMatches(count, int32, ctx, state, "__array_copy count");
    ensureTypeMatches(
      fromArray.element,
      element,
      ctx,
      state,
      "__array_copy element type"
    );
    return array;
  }

  ensureTypeMatches(args[1]!.type, int32, ctx, state, "__array_copy to_index");
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
    "__array_copy from_index"
  );
  ensureTypeMatches(args[4]!.type, int32, ctx, state, "__array_copy count");
  ensureTypeMatches(
    fromArray.element,
    element,
    ctx,
    state,
    "__array_copy element type"
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
  assertIntrinsicArgCount({ name: "__memory_grow", args, expected: 1, detail: "pages" });
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
  assertIntrinsicArgCount({ name, args, expected: 2, detail: "value and bits" });
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

const typeFloatConvertIntrinsic = ({
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
  const float32 = getPrimitiveType(ctx, "f32");
  const float64 = getPrimitiveType(ctx, "f64");
  switch (name) {
    case "__f32_demote_f64":
      ensureTypeMatches(args[0]!.type, float64, ctx, state, name);
      return float32;
    case "__f64_promote_f32":
      ensureTypeMatches(args[0]!.type, float32, ctx, state, name);
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
    `intrinsic ${name} expects ${expected} argument(s)${descriptor}, received ${args.length}`
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
    `intrinsic ${name} expects ${descriptor} argument(s), received ${args.length}`
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
    `intrinsic ${name} requires exactly 1 type argument${descriptor}, received ${count}`
  );
};

const assertNoIntrinsicTypeArgs = (
  name: string,
  typeArguments: readonly TypeId[] | undefined
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
    `${name} type argument`
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
  ctx: TypingContext
): boolean => {
  if (signature.parameters.length !== args.length) {
    return false;
  }
  return signature.parameters.every((param, index) => {
    const arg = args[index];
    return arg.type === ctx.primitives.unknown || param === arg.type;
  });
};
