import binaryen from "binaryen";
import {
  arrayGet,
  structGetFieldValue,
} from "@voyd-lang/lib/binaryen-gc/index.js";
import type {
  CodegenContext,
  CompiledExpression,
  ExpressionCompiler,
  FunctionContext,
  HirMethodCallExpr,
  StructuralFieldInfo,
  StructuralTypeInfo,
  TypeId,
} from "../context.js";
import { allocateTempLocal, loadLocalValue, storeLocalValue } from "../locals.js";
import {
  coerceValueToType,
  liftHeapValueToInline,
} from "../structural.js";
import {
  getExprBinaryenType,
  getFixedArrayWasmTypes,
  getRequiredExprType,
  getStructuralTypeInfo,
  wasmHeapFieldTypeFor,
  wasmTypeFor,
} from "../types.js";
import { coerceExprToWasmType } from "../wasm-type-coercions.js";

type ArrayMethodInfo = {
  targetTypeId: TypeId;
  structInfo: StructuralTypeInfo;
  storageField: StructuralFieldInfo;
  countField: StructuralFieldInfo;
};

const isStdArrayType = ({
  typeId,
  ctx,
}: {
  typeId: TypeId;
  ctx: CodegenContext;
}): boolean => {
  const desc = ctx.program.types.getTypeDesc(typeId);
  const nominal =
    desc.kind === "nominal-object"
      ? desc
      : desc.kind === "intersection" && typeof desc.nominal === "number"
        ? ctx.program.types.getTypeDesc(desc.nominal)
        : undefined;
  if (nominal?.kind !== "nominal-object") {
    return false;
  }
  return (
    nominal.name === "Array" &&
    ctx.program.symbols.getPackageId(nominal.owner) === "std"
  );
};

const arrayMethodInfo = ({
  expr,
  ctx,
  fnCtx,
}: {
  expr: HirMethodCallExpr;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): ArrayMethodInfo | undefined => {
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const targetTypeId = getRequiredExprType(expr.target, ctx, typeInstanceId);
  if (!isStdArrayType({ typeId: targetTypeId, ctx })) {
    return undefined;
  }

  const structInfo = getStructuralTypeInfo(targetTypeId, ctx);
  const storageField = structInfo?.fieldMap.get("storage");
  const countField = structInfo?.fieldMap.get("count");
  if (!structInfo || !storageField || !countField) {
    return undefined;
  }

  return { targetTypeId, structInfo, storageField, countField };
};

const directArrayFieldLoad = ({
  target,
  structInfo,
  field,
  ctx,
}: {
  target: () => binaryen.ExpressionRef;
  structInfo: StructuralTypeInfo;
  field: StructuralFieldInfo;
  ctx: CodegenContext;
}): binaryen.ExpressionRef =>
  liftHeapValueToInline({
    value: structGetFieldValue({
      mod: ctx.mod,
      fieldType: field.heapWasmType,
      fieldIndex: field.runtimeIndex,
      exprRef: coerceExprToWasmType({
        expr: target(),
        targetType: structInfo.runtimeType,
        ctx,
      }),
    }),
    typeId: field.typeId,
    ctx,
  });

const compileArrayTarget = ({
  expr,
  info,
  ctx,
  fnCtx,
  compileExpr,
}: {
  expr: HirMethodCallExpr;
  info: ArrayMethodInfo;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
}) => {
  const targetLocal = allocateTempLocal(
    wasmTypeFor(info.targetTypeId, ctx),
    fnCtx,
    info.targetTypeId,
    ctx,
  );
  const setup = storeLocalValue({
    binding: targetLocal,
    value: compileExpr({
      exprId: expr.target,
      ctx,
      fnCtx,
      expectedResultTypeId: info.targetTypeId,
    }).expr,
    ctx,
    fnCtx,
  });
  return {
    setup,
    target: () => loadLocalValue(targetLocal, ctx),
  };
};

const compileArrayLenFastPath = ({
  expr,
  info,
  ctx,
  fnCtx,
  compileExpr,
}: {
  expr: HirMethodCallExpr;
  info: ArrayMethodInfo;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
}): CompiledExpression | undefined => {
  if (expr.args.length !== 0) {
    return undefined;
  }

  const { setup, target } = compileArrayTarget({
    expr,
    info,
    ctx,
    fnCtx,
    compileExpr,
  });
  const count = directArrayFieldLoad({
    target,
    structInfo: info.structInfo,
    field: info.countField,
    ctx,
  });
  return {
    expr: ctx.mod.block(null, [setup, count], binaryen.i32),
    usedReturnCall: false,
  };
};

const compileArrayAtFastPath = ({
  expr,
  info,
  expectedResultTypeId,
  ctx,
  fnCtx,
  compileExpr,
}: {
  expr: HirMethodCallExpr;
  info: ArrayMethodInfo;
  expectedResultTypeId?: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
}): CompiledExpression | undefined => {
  if (expr.args.length !== 1) {
    return undefined;
  }

  const storageDesc = ctx.program.types.getTypeDesc(info.storageField.typeId);
  if (storageDesc.kind !== "fixed-array") {
    return undefined;
  }
  const storageWasmTypes = getFixedArrayWasmTypes(info.storageField.typeId, ctx);
  if (storageWasmTypes.kind !== "plain-array") {
    return undefined;
  }

  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const returnTypeId = getRequiredExprType(expr.id, ctx, typeInstanceId);
  const resultTypeId = expectedResultTypeId ?? returnTypeId;
  const resultWasmType = getExprBinaryenType(expr.id, ctx, typeInstanceId);
  const elementHeapType = wasmHeapFieldTypeFor(
    storageDesc.element,
    ctx,
    new Set(),
    "runtime",
  );
  const storageLocal = allocateTempLocal(
    wasmTypeFor(info.storageField.typeId, ctx),
    fnCtx,
    info.storageField.typeId,
    ctx,
  );
  const countLocal = allocateTempLocal(binaryen.i32, fnCtx);
  const indexLocal = allocateTempLocal(binaryen.i32, fnCtx);
  const computedIndexLocal = allocateTempLocal(binaryen.i32, fnCtx);
  const { setup: setupTarget, target } = compileArrayTarget({
    expr,
    info,
    ctx,
    fnCtx,
    compileExpr,
  });
  const storage = () => loadLocalValue(storageLocal, ctx);
  const count = () => ctx.mod.local.get(countLocal.index, binaryen.i32);
  const index = () => ctx.mod.local.get(indexLocal.index, binaryen.i32);
  const computedIndex = () =>
    ctx.mod.local.get(computedIndexLocal.index, binaryen.i32);
  const boundsCheck = ctx.mod.if(
    ctx.mod.i32.or(
      ctx.mod.i32.lt_s(computedIndex(), ctx.mod.i32.const(0)),
      ctx.mod.i32.ge_s(computedIndex(), count()),
    ),
    ctx.mod.unreachable(),
  );
  const rawValue = arrayGet(
    ctx.mod,
    storage(),
    computedIndex(),
    elementHeapType,
    false,
  );
  const inlineValue = liftHeapValueToInline({
    value: rawValue,
    typeId: storageDesc.element,
    ctx,
  });
  const coerced = coerceExprToWasmType({
    expr:
      storageDesc.element === resultTypeId
        ? inlineValue
        : coerceValueToType({
            value: inlineValue,
            actualType: storageDesc.element,
            targetType: resultTypeId,
            ctx,
            fnCtx,
          }),
    targetType: resultWasmType,
    ctx,
  });

  return {
    expr: ctx.mod.block(
      null,
      [
        setupTarget,
        storeLocalValue({
          binding: storageLocal,
          value: directArrayFieldLoad({
            target,
            structInfo: info.structInfo,
            field: info.storageField,
            ctx,
          }),
          ctx,
          fnCtx,
        }),
        ctx.mod.local.set(
          countLocal.index,
          directArrayFieldLoad({
            target,
            structInfo: info.structInfo,
            field: info.countField,
            ctx,
          }),
        ),
        ctx.mod.local.set(
          indexLocal.index,
          compileExpr({
            exprId: expr.args[0]!.expr,
            ctx,
            fnCtx,
            expectedResultTypeId: ctx.program.primitives.i32,
          }).expr,
        ),
        ctx.mod.local.set(
          computedIndexLocal.index,
          ctx.mod.if(
            ctx.mod.i32.lt_s(index(), ctx.mod.i32.const(0)),
            ctx.mod.i32.add(count(), index()),
            index(),
          ),
        ),
        boundsCheck,
        coerced,
      ],
      resultWasmType,
    ),
    usedReturnCall: false,
  };
};

export const tryCompileArrayMethodFastPath = ({
  expr,
  expectedResultTypeId,
  ctx,
  fnCtx,
  compileExpr,
}: {
  expr: HirMethodCallExpr;
  expectedResultTypeId?: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
}): CompiledExpression | undefined => {
  if (expr.method !== "len" && expr.method !== "at") {
    return undefined;
  }
  const info = arrayMethodInfo({ expr, ctx, fnCtx });
  if (!info) {
    return undefined;
  }
  if (expr.method === "len") {
    return compileArrayLenFastPath({ expr, info, ctx, fnCtx, compileExpr });
  }
  return compileArrayAtFastPath({
    expr,
    info,
    expectedResultTypeId,
    ctx,
    fnCtx,
    compileExpr,
  });
};
