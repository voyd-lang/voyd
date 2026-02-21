import type { TypeId } from "../../ids.js";
import { getPrimitiveType } from "../type-system.js";
import type { TypingContext } from "../types.js";

export interface IntrinsicSignature {
  parameters: readonly TypeId[];
  returnType: TypeId;
}

export const intrinsicSignaturesFor = (
  name: string,
  ctx: TypingContext
): readonly IntrinsicSignature[] => {
  const int32 = getPrimitiveType(ctx, "i32");
  const int64 = getPrimitiveType(ctx, "i64");
  const float32 = getPrimitiveType(ctx, "f32");
  const float64 = getPrimitiveType(ctx, "f64");

  const numericSignatures: IntrinsicSignature[] = [
    { parameters: [int32, int32], returnType: int32 },
    { parameters: [int64, int64], returnType: int64 },
    { parameters: [float32, float32], returnType: float32 },
    { parameters: [float64, float64], returnType: float64 },
  ];
  const integerSignatures: IntrinsicSignature[] = [
    { parameters: [int32, int32], returnType: int32 },
    { parameters: [int64, int64], returnType: int64 },
  ];
  const comparisonSignatures: IntrinsicSignature[] = [
    { parameters: [int32, int32], returnType: ctx.primitives.bool },
    { parameters: [int64, int64], returnType: ctx.primitives.bool },
    { parameters: [float32, float32], returnType: ctx.primitives.bool },
    { parameters: [float64, float64], returnType: ctx.primitives.bool },
  ];
  const equalitySignatures: IntrinsicSignature[] = [
    ...comparisonSignatures,
    {
      parameters: [ctx.primitives.bool, ctx.primitives.bool],
      returnType: ctx.primitives.bool,
    },
  ];
  const booleanBinarySignatures: IntrinsicSignature[] = [
    {
      parameters: [ctx.primitives.bool, ctx.primitives.bool],
      returnType: ctx.primitives.bool,
    },
  ];
  const booleanUnarySignatures: IntrinsicSignature[] = [
    { parameters: [ctx.primitives.bool], returnType: ctx.primitives.bool },
  ];

  switch (name) {
    case "+":
    case "-":
    case "*":
    case "/":
      return numericSignatures;
    case "%":
      return integerSignatures;
    case "<":
    case "<=":
    case ">":
    case ">=":
      return comparisonSignatures;
    case "==":
    case "!=":
      return equalitySignatures;
    case "and":
    case "or":
    case "xor":
      return booleanBinarySignatures;
    case "not":
      return booleanUnarySignatures;
    default:
      return [];
  }
};

export const getIntrinsicType = (name: string, ctx: TypingContext): TypeId => {
  const cached = ctx.intrinsicTypes.get(name);
  if (typeof cached === "number") {
    return cached;
  }

  const signatures = intrinsicSignaturesFor(name, ctx);
  if (signatures.length === 0) {
    throw new Error(`unsupported intrinsic ${name}`);
  }

  const signature = signatures[0]!;
  const fnType = ctx.arena.internFunction({
    parameters: signature.parameters.map((type) => ({
      type,
      optional: false,
    })),
    returnType: signature.returnType,
    effectRow: ctx.primitives.defaultEffectRow,
  });

  ctx.intrinsicTypes.set(name, fnType);
  return fnType;
};
