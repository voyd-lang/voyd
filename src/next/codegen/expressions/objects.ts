import binaryen from "binaryen";
import {
  callRef,
  initStruct,
  refCast,
  structGetFieldValue,
} from "../../../lib/binaryen-gc/index.js";
import type {
  CodegenContext,
  CompiledExpression,
  ExpressionCompiler,
  FunctionContext,
  HirExprId,
  HirExpression,
  HirFieldAccessExpr,
  HirObjectLiteralExpr,
} from "../context.js";
import { LOOKUP_FIELD_ACCESSOR, RTT_METADATA_SLOTS } from "../rtt/index.js";
import { allocateTempLocal } from "../locals.js";
import { loadStructuralField } from "../structural.js";
import { getExprBinaryenType, getRequiredExprType, getStructuralTypeInfo } from "../types.js";

export const compileObjectLiteralExpr = (
  expr: HirObjectLiteralExpr,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  compileExpr: ExpressionCompiler
): CompiledExpression => {
  const typeId = getRequiredExprType(expr.id, ctx);
  const structInfo = getStructuralTypeInfo(typeId, ctx);
  if (!structInfo) {
    throw new Error("object literal missing structural type information");
  }

  const ops: binaryen.ExpressionRef[] = [];
  const fieldTemps = new Map<string, ReturnType<typeof allocateTempLocal>>();
  const initialized = new Set<string>();

  structInfo.fields.forEach((field) => {
    fieldTemps.set(field.name, allocateTempLocal(field.wasmType, fnCtx));
  });

  expr.entries.forEach((entry) => {
    if (entry.kind === "field") {
      const binding = fieldTemps.get(entry.name);
      if (!binding) {
        throw new Error(
          `object literal cannot set unknown field ${entry.name}`
        );
      }
      ops.push(
        ctx.mod.local.set(
          binding.index,
          compileExpr(entry.value, ctx, fnCtx).expr
        )
      );
      initialized.add(entry.name);
      return;
    }

    const spreadType = getRequiredExprType(entry.value, ctx);
    const spreadInfo = getStructuralTypeInfo(spreadType, ctx);
    if (!spreadInfo) {
      throw new Error("object spread requires a structural object");
    }

    const spreadTemp = allocateTempLocal(spreadInfo.interfaceType, fnCtx);
    ops.push(
      ctx.mod.local.set(
        spreadTemp.index,
        compileExpr(entry.value, ctx, fnCtx).expr
      )
    );

    spreadInfo.fields.forEach((sourceField) => {
      const target = fieldTemps.get(sourceField.name);
      if (!target) {
        return;
      }
      const pointer = ctx.mod.local.get(
        spreadTemp.index,
        spreadInfo.interfaceType
      );
      const lookupTable = structGetFieldValue({
        mod: ctx.mod,
        fieldType: ctx.rtt.fieldLookupHelpers.lookupTableType,
        fieldIndex: RTT_METADATA_SLOTS.FIELD_INDEX_TABLE,
        exprRef: pointer,
      });
      const accessor = ctx.mod.call(
        LOOKUP_FIELD_ACCESSOR,
        [
          ctx.mod.i32.const(sourceField.hash),
          lookupTable,
          ctx.mod.i32.const(0),
        ],
        binaryen.funcref
      );
      const getter = refCast(ctx.mod, accessor, sourceField.getterType!);
      const load = callRef(ctx.mod, getter, [pointer], sourceField.wasmType);
      ops.push(ctx.mod.local.set(target.index, load));
      initialized.add(sourceField.name);
    });
  });

  structInfo.fields.forEach((field) => {
    if (!initialized.has(field.name)) {
      throw new Error(`missing initializer for field ${field.name}`);
    }
  });

  const values = [
    ctx.mod.global.get(
      structInfo.ancestorsGlobal,
      ctx.rtt.extensionHelpers.i32Array
    ),
    ctx.mod.global.get(
      structInfo.fieldTableGlobal,
      ctx.rtt.fieldLookupHelpers.lookupTableType
    ),
    ctx.mod.global.get(
      structInfo.methodTableGlobal,
      ctx.rtt.methodLookupHelpers.lookupTableType
    ),
    ...structInfo.fields.map((field) => {
      const binding = fieldTemps.get(field.name);
      if (!binding) {
        throw new Error(`missing binding for field ${field.name}`);
      }
      return ctx.mod.local.get(binding.index, binding.type);
    }),
  ];
  const literal = initStruct(ctx.mod, structInfo.runtimeType, values);
  if (ops.length === 0) {
    return { expr: literal, usedReturnCall: false };
  }
  ops.push(literal);
  return {
    expr: ctx.mod.block(null, ops, getExprBinaryenType(expr.id, ctx)),
    usedReturnCall: false,
  };
};

export const compileTupleExpr = (
  expr: HirExpression & { exprKind: "tuple"; elements: readonly HirExprId[] },
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  compileExpr: ExpressionCompiler
): CompiledExpression => {
  const typeId = getRequiredExprType(expr.id, ctx);
  const structInfo = getStructuralTypeInfo(typeId, ctx);
  if (!structInfo) {
    throw new Error("tuple missing structural type information");
  }

  if (structInfo.fields.length !== expr.elements.length) {
    throw new Error("tuple arity does not match inferred structural type");
  }

  const ops: binaryen.ExpressionRef[] = [];
  const fieldTemps = new Map<string, ReturnType<typeof allocateTempLocal>>();

  expr.elements.forEach((elementId, index) => {
    const fieldName = `${index}`;
    const field = structInfo.fieldMap.get(fieldName);
    if (!field) {
      throw new Error(`tuple element ${index} missing corresponding field`);
    }
    const temp = allocateTempLocal(field.wasmType, fnCtx);
    fieldTemps.set(field.name, temp);
    ops.push(
      ctx.mod.local.set(temp.index, compileExpr(elementId, ctx, fnCtx).expr)
    );
  });

  const values = [
    ctx.mod.global.get(
      structInfo.ancestorsGlobal,
      ctx.rtt.extensionHelpers.i32Array
    ),
    ctx.mod.global.get(
      structInfo.fieldTableGlobal,
      ctx.rtt.fieldLookupHelpers.lookupTableType
    ),
    ctx.mod.global.get(
      structInfo.methodTableGlobal,
      ctx.rtt.methodLookupHelpers.lookupTableType
    ),
    ...structInfo.fields.map((field) => {
      const temp = fieldTemps.get(field.name);
      if (!temp) {
        throw new Error(`missing binding for tuple field ${field.name}`);
      }
      return ctx.mod.local.get(temp.index, temp.type);
    }),
  ];

  const tupleValue = initStruct(ctx.mod, structInfo.runtimeType, values);
  if (ops.length === 0) {
    return { expr: tupleValue, usedReturnCall: false };
  }
  ops.push(tupleValue);
  return {
    expr: ctx.mod.block(null, ops, getExprBinaryenType(expr.id, ctx)),
    usedReturnCall: false,
  };
};

export const compileFieldAccessExpr = (
  expr: HirFieldAccessExpr,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  compileExpr: ExpressionCompiler
): CompiledExpression => {
  const targetType = getRequiredExprType(expr.target, ctx);
  const structInfo = getStructuralTypeInfo(targetType, ctx);
  if (!structInfo) {
    throw new Error("field access requires a structural object");
  }

  const field = structInfo.fieldMap.get(expr.field);
  if (!field) {
    throw new Error(`object does not contain field ${expr.field}`);
  }

  const pointerTemp = allocateTempLocal(structInfo.interfaceType, fnCtx);
  const storePointer = ctx.mod.local.set(
    pointerTemp.index,
    compileExpr(expr.target, ctx, fnCtx).expr
  );
  const pointer = ctx.mod.local.get(
    pointerTemp.index,
    structInfo.interfaceType
  );
  const value = loadStructuralField(structInfo, field, pointer, ctx);
  return {
    expr: ctx.mod.block(null, [storePointer, value], field.wasmType),
    usedReturnCall: false,
  };
};
