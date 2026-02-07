import type {
  HirExprId,
  TypeId,
  TypeParamId,
} from "../../ids.js";
import type {
  Arg,
  FunctionSignature,
  TypingContext,
  TypingState,
} from "../types.js";
import { bindTypeParamsFromType } from "../type-system.js";
import { typeExpression } from "../expressions.js";
import { applyCurrentSubstitution } from "./shared.js";

export type CallArgInput = {
  expr: HirExprId;
  label?: string;
};

export const buildCallArgumentHintSubstitution = ({
  signature,
  probeArgs,
  expectedReturnType,
  seedSubstitution,
  ctx,
  state,
}: {
  signature: FunctionSignature;
  probeArgs: readonly Arg[];
  expectedReturnType: TypeId | undefined;
  seedSubstitution?: ReadonlyMap<TypeParamId, TypeId>;
  ctx: TypingContext;
  state: TypingState;
}): ReadonlyMap<TypeParamId, TypeId> | undefined => {
  const hasTypeParams = signature.typeParams && signature.typeParams.length > 0;
  if (!hasTypeParams && !seedSubstitution) {
    return undefined;
  }

  const merged = new Map<TypeParamId, TypeId>(seedSubstitution);
  probeArgs.forEach((arg, index) => {
    const param = signature.parameters[index];
    if (!param) {
      return;
    }
    const expected = ctx.arena.substitute(param.type, merged);
    bindTypeParamsFromType(expected, arg.type, merged, ctx, state);
  });

  if (
    typeof expectedReturnType === "number" &&
    expectedReturnType !== ctx.primitives.unknown
  ) {
    const expected = ctx.arena.substitute(signature.returnType, merged);
    bindTypeParamsFromType(
      expected,
      applyCurrentSubstitution(expectedReturnType, ctx, state),
      merged,
      ctx,
      state,
    );
  }

  return merged.size > 0 ? merged : undefined;
};

export const typeCallArgsWithSignatureContext = ({
  args,
  signature,
  paramOffset,
  hintSubstitution,
  ctx,
  state,
}: {
  args: readonly CallArgInput[];
  signature: FunctionSignature;
  paramOffset: number;
  hintSubstitution: ReadonlyMap<TypeParamId, TypeId> | undefined;
  ctx: TypingContext;
  state: TypingState;
}): readonly Arg[] =>
  args.map((arg, index) => ({
    label: arg.label,
    type: typeExpression(arg.expr, ctx, state, {
      expectedType: expectedCallParamType({
        signature,
        index: index + paramOffset,
        hintSubstitution,
        ctx,
      }),
    }),
    exprId: arg.expr,
  }));

const expectedCallParamType = ({
  signature,
  index,
  hintSubstitution,
  ctx,
}: {
  signature: FunctionSignature;
  index: number;
  hintSubstitution: ReadonlyMap<TypeParamId, TypeId> | undefined;
  ctx: TypingContext;
}): TypeId | undefined => {
  const param = signature.parameters[index];
  if (!param) {
    return undefined;
  }
  return hintSubstitution
    ? ctx.arena.substitute(param.type, hintSubstitution)
    : param.type;
};
