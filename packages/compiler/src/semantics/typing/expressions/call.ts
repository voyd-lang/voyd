import type {
  HirCallExpr,
  HirExpression,
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
    const overloaded = typeOverloadedCall(expr, calleeExpr, args, ctx, state);
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
    if (metadata.unresolved) {
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
        allowIntrinsicTypeArgs
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
            allowIntrinsicTypeArgs
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
      const { returnType, effectRow } = typeFunctionCall({
        args,
        signature,
        calleeSymbol: calleeExpr.symbol,
        typeArguments,
        expectedReturnType,
        callId: expr.id,
        calleeExprId: calleeExpr.id,
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
          allowIntrinsicTypeArgs
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

const optionalNoneMember = (type: TypeId, ctx: TypingContext): TypeId | undefined => {
  const desc = ctx.arena.get(type);
  if (desc.kind !== "union") {
    return undefined;
  }
  for (const member of desc.members) {
    const nominal = getNominalComponent(member, ctx);
    if (typeof nominal !== "number") {
      continue;
    }
    const nominalDesc = ctx.arena.get(nominal);
    if (nominalDesc.kind !== "nominal-object") {
      continue;
    }
    const name = nominalDesc.name ?? getSymbolName(nominalDesc.owner, ctx);
    if (name === "None") {
      return member;
    }
  }
  return undefined;
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
        const noneType = optionalNoneMember(param.type, ctx);
        if (typeof noneType !== "number") {
          throw new Error("optional parameter type must include None");
        }
        ensureTypeMatches(
          noneType,
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
            cursor += 1;
            continue;
          }

          if (runParam.optional) {
            const noneType = optionalNoneMember(runParam.type, ctx);
            if (typeof noneType !== "number") {
              throw new Error("optional parameter type must include None");
            }
            ensureTypeMatches(
              noneType,
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
      const noneType = optionalNoneMember(param.type, ctx);
      if (typeof noneType !== "number") {
        throw new Error("optional parameter type must include None");
      }
      ensureTypeMatches(
        noneType,
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
  if (
    receiverDesc.kind !== "trait" ||
    receiverDesc.owner !== methodMetadata.traitSymbol
  ) {
    return undefined;
  }
  const updated = [{ ...params[0]!, type: receiverType }, ...params.slice(1)];
  return updated;
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
}): { returnType: TypeId; effectRow: number } => {
  const record = ctx.symbolTable.getSymbol(calleeSymbol);
  const intrinsicMetadata = (record.metadata ?? {}) as {
    intrinsic?: boolean;
    intrinsicUsesSignature?: boolean;
  };
  const hasTypeParams = signature.typeParams && signature.typeParams.length > 0;
  const instantiation = hasTypeParams
    ? instantiateFunctionCall({
        signature,
        args,
        typeArguments,
        expectedReturnType,
        calleeSymbol,
        ctx,
        state,
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
    });
    const callKey = formatFunctionInstanceKey(calleeSymbol, appliedTypeArgs);
    ctx.callResolution.typeArguments.set(callId, appliedTypeArgs);
    ctx.callResolution.instanceKeys.set(callId, callKey);
    const skipGenericBody =
      intrinsicMetadata.intrinsic === true &&
      intrinsicMetadata.intrinsicUsesSignature !== true;
    if (!skipGenericBody) {
      typeGenericFunctionBody({
        symbol: calleeSymbol,
        signature,
        substitution: instantiation.substitution,
        ctx,
        state,
      });
    }
  } else {
    ctx.callResolution.typeArguments.delete(callId);
  }

  return { returnType: instantiation.returnType, effectRow: signature.effectRow };
};

const instantiateFunctionCall = ({
  signature,
  args,
  typeArguments,
  expectedReturnType,
  calleeSymbol,
  ctx,
  state,
}: {
  signature: FunctionSignature;
  args: readonly Arg[];
  typeArguments?: readonly TypeId[];
  expectedReturnType?: TypeId;
  calleeSymbol: SymbolId;
  ctx: TypingContext;
  state: TypingState;
}): {
  substitution: ReadonlyMap<TypeParamId, TypeId>;
  parameters: readonly ParamSignature[];
  returnType: TypeId;
} => {
  const typeParams = signature.typeParams ?? [];

  if (typeArguments && typeArguments.length > typeParams.length) {
    throw new Error(
      `function ${getSymbolName(
        calleeSymbol,
        ctx
      )} received too many type arguments`
    );
  }

  const substitution = new Map<TypeParamId, TypeId>();
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
      `function ${getSymbolName(calleeSymbol, ctx)} is missing ${
        missing.length
      } type argument(s)`
    );
  }

  typeParams.forEach((param) =>
    enforceTypeParamConstraint(param, substitution, ctx, state)
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
  state: TypingState
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
      `type argument for ${getSymbolName(
        param.symbol,
        ctx
      )} does not satisfy its constraint`
    );
  }
};

const typeGenericFunctionBody = ({
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
    ctx.functions.cacheInstance(key, expectedReturn, ctx.resolvedExprTypes);
    ctx.functions.recordInstantiation(symbol, key, appliedTypeArgs);
  } finally {
    state.currentFunction = previousFunction;
    ctx.resolvedExprTypes = previousResolved;
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
}: {
  signature: FunctionSignature;
  substitution: ReadonlyMap<TypeParamId, TypeId>;
  symbol: SymbolId;
  ctx: TypingContext;
}): readonly TypeId[] => {
  const typeParams = signature.typeParams ?? [];
  return typeParams.map((param) => {
    const applied = substitution.get(param.typeParam);
    if (typeof applied !== "number") {
      throw new Error(
        `function ${getSymbolName(
          symbol,
          ctx
        )} is missing a type argument for ${getSymbolName(param.symbol, ctx)}`
      );
    }
    if (applied === ctx.primitives.unknown) {
      throw new Error(
        `function ${getSymbolName(
          symbol,
          ctx
        )} has unresolved type argument for ${getSymbolName(param.symbol, ctx)}`
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
  state: TypingState
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
  const targets =
    ctx.callResolution.targets.get(call.id) ?? new Map<string, SymbolId>();
  targets.set(instanceKey, selected.symbol);
  ctx.callResolution.targets.set(call.id, targets);
  ctx.table.setExprType(callee.id, selected.signature.typeId);
  return {
    returnType: selected.signature.returnType,
    effectRow: selected.signature.effectRow,
  };
};

const resolveTraitDispatchOverload = ({
  candidates,
  args,
  ctx,
  state,
}: {
  candidates: readonly { symbol: SymbolId; signature: FunctionSignature }[];
  args: readonly Arg[];
  ctx: TypingContext;
  state: TypingState;
}): { symbol: SymbolId; signature: FunctionSignature } | undefined => {
  if (args.length === 0) {
    return undefined;
  }
  const receiver = args[0];
  const receiverDesc = ctx.arena.get(receiver.type);
  if (receiverDesc.kind !== "trait") {
    return undefined;
  }

  const impls = ctx.traitImplsByTrait.get(receiverDesc.owner);
  const templates = ctx.traits.getImplTemplatesForTrait(receiverDesc.owner);
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
    if (!methodMetadata || methodMetadata.traitSymbol !== receiverDesc.owner) {
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
    symbol: candidate.symbol,
    signature:
      params === candidate.signature.parameters
        ? candidate.signature
        : {
            ...candidate.signature,
            parameters: params,
            typeId: adjustedType,
            effectRow,
          },
  };
};

const matchesOverloadSignature = (
  symbol: SymbolId,
  signature: FunctionSignature,
  args: readonly Arg[],
  ctx: TypingContext,
  state: TypingState
): boolean => {
  if (!callArgumentsSatisfyParams({ args, params: signature.parameters, ctx, state })) {
    return false;
  }

  signature.parameters.forEach(({ type }) => {
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
  allowTypeArguments = false
): TypeId => {
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
    default: {
      const signatures = intrinsicSignaturesFor(name, ctx);
      if (signatures.length === 0) {
        throw new Error(`unsupported intrinsic ${name}`);
      }

      const matches = signatures.filter((signature) =>
        intrinsicSignatureMatches(signature, args, ctx)
      );

      if (matches.length === 0) {
        throw new Error(`no matching overload for intrinsic ${name}`);
      }

      if (matches.length > 1) {
        throw new Error(`ambiguous intrinsic overload for ${name}`);
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
}: {
  args: readonly Arg[];
  ctx: TypingContext;
  state: TypingState;
  typeArguments?: readonly TypeId[];
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
    elementType = inferArrayLiteralElementType({ args, ctx, state });
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
}: {
  args: readonly Arg[];
  ctx: TypingContext;
  state: TypingState;
}): TypeId => {
  if (args.length === 0) {
    throw new Error(
      "__array_new_fixed requires at least one element to infer the element type"
    );
  }

  const nonUnknown = args
    .map((arg) => arg.type)
    .filter((type) => type !== ctx.primitives.unknown);

  if (nonUnknown.length === 0) {
    return ctx.primitives.unknown;
  }

  const first = nonUnknown[0]!;
  if (nonUnknown.every((type) => type === first)) {
    return first;
  }

  const primitives = new Set<TypeId>();
  const nominalTypes: TypeId[] = [];
  const structuralTypes: TypeId[] = [];
  const others: TypeId[] = [];

  const addUnique = (bucket: TypeId[], type: TypeId) => {
    if (!bucket.includes(type)) bucket.push(type);
  };

  nonUnknown.forEach((type) => {
    const desc = ctx.arena.get(type);
    switch (desc.kind) {
      case "primitive":
        primitives.add(type);
        return;
      default: {
        const nominalComponent = getNominalComponent(type, ctx);
        const structuralFields = getStructuralFields(type, ctx, state);
        const isBaseNominal =
          typeof nominalComponent === "number" &&
          nominalComponent === ctx.objects.base.nominal;

        if (nominalComponent && !isBaseNominal) {
          addUnique(nominalTypes, type);
          return;
        }

        if (structuralFields) {
          addUnique(structuralTypes, type);
          return;
        }

        if (nominalComponent) {
          addUnique(structuralTypes, type);
          return;
        }

        others.push(type);
      }
    }
  });

  if (
    primitives.size > 1 ||
    (primitives.size > 0 &&
      (nominalTypes.length > 0 ||
        structuralTypes.length > 0 ||
        others.length > 0))
  ) {
    throw new Error("array literal elements must not mix primitive types");
  }

  if (others.length > 0) {
    throw new Error("array literal elements must share a compatible type");
  }

  if (
    nominalTypes.length > 0 &&
    structuralTypes.length === 0 &&
    primitives.size === 0
  ) {
    return nominalTypes.length === 1
      ? nominalTypes[0]!
      : ctx.arena.internUnion(nominalTypes);
  }

  if (
    structuralTypes.length > 0 &&
    nominalTypes.length === 0 &&
    primitives.size === 0
  ) {
    return ctx.objects.base.type;
  }

  throw new Error("array literal elements must share a compatible type");
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
