import type {
  CodegenContext,
  CompiledExpression,
  FunctionContext,
  HirExpression,
  SymbolId,
} from "../context.js";
import { getRequiredBinding, loadBindingValue } from "../locals.js";
import { arrayNew, arrayNewFixed } from "@voyd/lib/binaryen-gc/index.js";
import { getFixedArrayWasmTypes, wasmTypeFor } from "../types.js";
import { requireDependencyFunctionMeta } from "../function-dependencies.js";

const encoder = new TextEncoder();

export const compileLiteralExpr = (
  expr: HirExpression & {
    exprKind: "literal";
    literalKind: string;
    value: string;
  },
  ctx: CodegenContext
): CompiledExpression => {
  switch (expr.literalKind) {
    case "i32":
      return {
        expr: ctx.mod.i32.const(Number.parseInt(expr.value, 10)),
        usedReturnCall: false,
      };
    case "i64": {
      const value = BigInt(expr.value);
      const low = Number(value & BigInt(0xffffffff));
      const high = Number((value >> BigInt(32)) & BigInt(0xffffffff));
      return {
        expr: ctx.mod.i64.const(low, high),
        usedReturnCall: false,
      };
    }
    case "f32":
      return {
        expr: ctx.mod.f32.const(Number.parseFloat(expr.value)),
        usedReturnCall: false,
      };
    case "f64":
      return {
        expr: ctx.mod.f64.const(Number.parseFloat(expr.value)),
        usedReturnCall: false,
      };
    case "boolean":
      return {
        expr: ctx.mod.i32.const(expr.value === "true" ? 1 : 0),
        usedReturnCall: false,
      };
    case "void":
      return { expr: ctx.mod.nop(), usedReturnCall: false };
    case "string":
      return { expr: emitStringLiteral(expr.value, ctx), usedReturnCall: false };
    default:
      throw new Error(
        `codegen does not support literal kind ${expr.literalKind}`
      );
  }
};

export const compileIdentifierExpr = (
  expr: HirExpression & { exprKind: "identifier"; symbol: SymbolId },
  ctx: CodegenContext,
  fnCtx: FunctionContext
): CompiledExpression => {
  const binding = getRequiredBinding(expr.symbol, ctx, fnCtx);
  return { expr: loadBindingValue(binding, ctx), usedReturnCall: false };
};

export const emitStringLiteral = (value: string, ctx: CodegenContext): number => {
  const newStringMeta = requireDependencyFunctionMeta({
    ctx,
    dependency: "string-literal-constructor",
  });
  const signature = ctx.program.functions.getSignature(
    newStringMeta.moduleId,
    newStringMeta.symbol
  );
  if (!signature) {
    throw new Error("missing signature for string literal constructor");
  }
  const fixedArrayType = signature.parameters[0]?.typeId;
  if (typeof fixedArrayType !== "number") {
    throw new Error("string literal constructor missing FixedArray parameter");
  }

  const arrayInfo = getFixedArrayWasmTypes(fixedArrayType, ctx);
  const bytes = encoder.encode(value);
  const values = Array.from(bytes, (byte) => ctx.mod.i32.const(byte));
  const arrayExpr =
    values.length > 0
      ? arrayNewFixed(ctx.mod, arrayInfo.heapType, values as number[])
      : arrayNew(
          ctx.mod,
          arrayInfo.heapType,
          ctx.mod.i32.const(0),
          ctx.mod.i32.const(0)
        );

  return ctx.mod.call(
    newStringMeta.wasmName,
    [arrayExpr],
    wasmTypeFor(signature.returnType, ctx)
  );
};
