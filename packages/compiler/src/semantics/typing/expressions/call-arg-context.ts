import type { HirExprId, TypeId, TypeParamId } from "../../ids.js";
import type {
  Arg,
  FunctionSignature,
  ParamSignature,
  TypingContext,
  TypingState,
} from "../types.js";
import { bindTypeParams as bindTypeParamsFromType } from "../type-relations.js";
import { getStructuralFields } from "../type-system.js";
import { typeExpression } from "../expressions.js";
import { applyCurrentSubstitution } from "./shared.js";
import {
  getOptionalInfo,
  optionalResolverContextForTypingContext,
} from "../optionals.js";

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
  bindCallArgumentTypeParams({
    signature,
    args: probeArgs,
    substitution: merged,
    ctx,
    state,
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
      expectedType: expectedCallArgType({
        args,
        index: index + paramOffset,
        argIndex: index,
        params: signature.parameters,
        hintSubstitution,
        ctx,
      }),
    }),
    exprId: arg.expr,
  }));

export const expectedCallArgType = ({
  args,
  index,
  argIndex,
  params,
  hintSubstitution,
  ctx,
}: {
  args: readonly CallArgInput[];
  index: number;
  argIndex: number;
  params: readonly ParamSignature[];
  hintSubstitution: ReadonlyMap<TypeParamId, TypeId> | undefined;
  ctx: TypingContext;
}): TypeId | undefined => {
  const param = params[index];
  if (!param) {
    return undefined;
  }
  const directType = providedArgumentTypeForParam({
    param,
    hintSubstitution,
    ctx,
  });
  const arg = args[argIndex];
  if (!arg || !param.label || arg.label !== undefined) {
    return directType;
  }

  const expr = ctx.hir.expressions.get(arg.expr);
  if (
    expr?.exprKind !== "object-literal" ||
    expr.literalKind !== "structural"
  ) {
    return directType;
  }

  const explicitFieldNames = new Set(
    expr.entries
      .filter((entry) => entry.kind === "field")
      .map((entry) => entry.name),
  );
  const fields: { name: string; type: TypeId }[] = [];
  let cursor = index;
  while (cursor < params.length) {
    const runParam = params[cursor]!;
    if (!runParam.label) {
      break;
    }
    if (runParam.optional && !explicitFieldNames.has(runParam.label)) {
      cursor += 1;
      continue;
    }
    fields.push({
      name: runParam.label,
      type: providedArgumentTypeForParam({
        param: runParam,
        hintSubstitution,
        ctx,
      }),
    });
    cursor += 1;
  }

  return fields.length > 0
    ? ctx.arena.internStructuralObject({ fields })
    : directType;
};

export const bindCallArgumentTypeParams = ({
  signature,
  args,
  substitution,
  ctx,
  state,
}: {
  signature: FunctionSignature;
  args: readonly Arg[];
  substitution: Map<TypeParamId, TypeId>;
  ctx: TypingContext;
  state: TypingState;
}): void => {
  forEachCallArgumentMatch({
    args,
    params: signature.parameters,
    ctx,
    state,
    onMatch: ({ param, actualType }) => {
      const expectedType = providedArgumentTypeForParam({
        param,
        hintSubstitution: substitution,
        ctx,
      });
      bindTypeParamsFromType(
        expectedType,
        actualType,
        substitution,
        ctx,
        state,
      );
    },
  });
};

const forEachCallArgumentMatch = ({
  args,
  params,
  ctx,
  state,
  onMatch,
}: {
  args: readonly Arg[];
  params: readonly ParamSignature[];
  ctx: TypingContext;
  state: TypingState;
  onMatch: (match: { param: ParamSignature; actualType: TypeId }) => void;
}): void => {
  if (
    args.length > 0 &&
    args.every((arg) => arg.label !== undefined) &&
    params.length > 0 &&
    params.every((param) => param.label !== undefined)
  ) {
    const byLabel = new Map(args.map((arg) => [arg.label, arg] as const));
    params.forEach((param) => {
      const arg = param.label ? byLabel.get(param.label) : undefined;
      if (arg) {
        onMatch({ param, actualType: arg.type });
      }
    });
    return;
  }

  let argIndex = 0;
  let paramIndex = 0;
  while (paramIndex < params.length) {
    const param = params[paramIndex]!;
    const arg = args[argIndex];
    if (!arg) {
      paramIndex += 1;
      continue;
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
          const field = structuralFields.find(
            (candidate) => candidate.name === runParam.label,
          );
          if (field) {
            onMatch({ param: runParam, actualType: field.type });
          }
          cursor += 1;
        }
        if (cursor > paramIndex) {
          paramIndex = cursor;
          argIndex += 1;
          continue;
        }
      }
    }

    if (param.label === arg.label) {
      onMatch({ param, actualType: arg.type });
      paramIndex += 1;
      argIndex += 1;
      continue;
    }

    if (param.optional) {
      paramIndex += 1;
      continue;
    }

    paramIndex += 1;
    argIndex += 1;
  }
};

const providedArgumentTypeForParam = ({
  param,
  hintSubstitution,
  ctx,
}: {
  param: ParamSignature;
  hintSubstitution: ReadonlyMap<TypeParamId, TypeId> | undefined;
  ctx: TypingContext;
}): TypeId => {
  const type = hintSubstitution
    ? ctx.arena.substitute(param.type, hintSubstitution)
    : param.type;
  if (typeof param.defaultValue !== "number") {
    return type;
  }
  return (
    getOptionalInfo(type, optionalResolverContextForTypingContext(ctx))
      ?.innerType ?? type
  );
};
