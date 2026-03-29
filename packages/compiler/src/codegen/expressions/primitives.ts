import binaryen from "binaryen";
import type {
  CodegenContext,
  CompiledExpression,
  FunctionContext,
  HirExpression,
  SymbolId,
  TypeId,
} from "../context.js";
import {
  loadBindingValue,
  loadLocalValue,
} from "../locals.js";
import { arrayNew, arrayNewFixed } from "@voyd-lang/lib/binaryen-gc/index.js";
import { getFixedArrayWasmTypes, wasmTypeFor } from "../types.js";
import { requireDependencyFunctionMeta } from "../function-dependencies.js";
import { resolveModuleLetGetter } from "../module-lets.js";
import { materializeProjectedElementBinding } from "../projected-element-views.js";
import { coerceValueToType } from "../structural.js";
import { unboxSignatureSpillValue } from "../signature-spill.js";

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
  fnCtx: FunctionContext,
  expectedResultTypeId?: TypeId,
  preserveStorageRefs = false,
): CompiledExpression => {
  const binding = fnCtx.bindings.get(expr.symbol);
  if (binding) {
    if (binding.kind === "projected-element-ref") {
      if (preserveStorageRefs) {
        const value = loadBindingValue(binding, ctx);
        return {
          expr:
            typeof expectedResultTypeId === "number"
              ? coerceValueToType({
                  value,
                  actualType: binding.typeId ?? expectedResultTypeId,
                  targetType: expectedResultTypeId,
                  ctx,
                  fnCtx,
                })
              : value,
          usedReturnCall: false,
        };
      }
      const materialized = materializeProjectedElementBinding({
        symbol: expr.symbol,
        binding,
        ctx,
        fnCtx,
      });
      const value = loadLocalValue(materialized.binding, ctx);
      const exprValue =
        typeof expectedResultTypeId === "number"
          ? coerceValueToType({
              value,
              actualType: materialized.binding.typeId ?? expectedResultTypeId,
              targetType: expectedResultTypeId,
              ctx,
              fnCtx,
            })
          : value;
      return {
        expr:
          materialized.setup.length === 0
            ? exprValue
            : ctx.mod.block(
                null,
                [...materialized.setup, exprValue],
                binaryen.getExpressionType(exprValue),
              ),
        usedReturnCall: false,
      };
    }
    const value = loadBindingValue(binding, ctx);
    if (
      typeof expectedResultTypeId === "number" &&
      typeof binding.typeId === "number"
    ) {
      return {
        expr: coerceValueToType({
          value,
          actualType: binding.typeId,
          targetType: expectedResultTypeId,
          ctx,
          fnCtx,
        }),
        usedReturnCall: false,
      };
    }
    return { expr: value, usedReturnCall: false };
  }

  const localGetter = resolveModuleLetGetter({
    ctx,
    moduleId: ctx.moduleId,
    symbol: expr.symbol,
  });
  if (localGetter) {
    const value = unboxSignatureSpillValue({
      value: ctx.mod.call(localGetter.wasmName, [], localGetter.wasmType),
      typeId: localGetter.typeId,
      ctx,
    });
    return {
      expr:
        typeof expectedResultTypeId === "number"
          ? coerceValueToType({
              value,
              actualType: localGetter.typeId,
              targetType: expectedResultTypeId,
              ctx,
              fnCtx,
            })
          : value,
      usedReturnCall: false,
    };
  }

  const targetId = ctx.program.imports.getTarget(ctx.moduleId, expr.symbol);
  if (typeof targetId === "number") {
    const targetRef = ctx.program.symbols.refOf(targetId);
    const importedGetter = resolveModuleLetGetter({
      ctx,
      moduleId: targetRef.moduleId,
      symbol: targetRef.symbol,
    });
    if (importedGetter) {
      const value = unboxSignatureSpillValue({
        value: ctx.mod.call(
          importedGetter.wasmName,
          [],
          importedGetter.wasmType,
        ),
        typeId: importedGetter.typeId,
        ctx,
      });
      return {
        expr:
          typeof expectedResultTypeId === "number"
            ? coerceValueToType({
                value,
                actualType: importedGetter.typeId,
                targetType: expectedResultTypeId,
                ctx,
                fnCtx,
              })
            : value,
        usedReturnCall: false,
      };
    }
  }

  const name =
    ctx.program.symbols.getName(
      ctx.program.symbols.idOf({ moduleId: ctx.moduleId, symbol: expr.symbol }),
    ) ?? `${expr.symbol}`;
  throw new Error(`codegen missing binding for symbol ${name}`);
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
