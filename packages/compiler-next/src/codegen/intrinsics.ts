import binaryen from "binaryen";
import type {
  CodegenContext,
  FunctionContext,
  HirCallExpr,
  HirExprId,
  TypeId,
} from "./context.js";
import {
  getExprBinaryenType,
  getRequiredExprType,
  getStructuralTypeInfo,
  getFixedArrayWasmTypes,
  wasmTypeFor,
} from "./types.js";
import { allocateTempLocal } from "./locals.js";
import { loadStructuralField } from "./structural.js";
import {
  arrayCopy,
  arrayGet,
  arrayLen,
  arrayNew,
  arrayNewFixed,
  arraySet,
  modBinaryenTypeToHeapType,
} from "@voyd/lib/binaryen-gc/index.js";
import type { HeapTypeRef } from "@voyd/lib/binaryen-gc/types.js";

type NumericKind = "i32" | "i64" | "f32" | "f64";
type EqualityKind = NumericKind | "bool";

interface CompileIntrinsicCallParams {
  name: string;
  call: HirCallExpr;
  args: readonly binaryen.ExpressionRef[];
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  instanceKey?: string;
}

interface EmitNumericIntrinsicParams {
  kind: NumericKind;
  args: readonly binaryen.ExpressionRef[];
  ctx: CodegenContext;
}

interface EmitEqualityIntrinsicParams {
  op: "==" | "!=";
  kind: EqualityKind;
  args: readonly binaryen.ExpressionRef[];
  ctx: CodegenContext;
}

export const compileIntrinsicCall = ({
  name,
  call,
  args,
  ctx,
  fnCtx,
  instanceKey,
}: CompileIntrinsicCallParams): binaryen.ExpressionRef => {
  switch (name) {
    case "~": {
      assertArgCount(name, args, 1);
      return args[0]!;
    }
    case "__array_new": {
      assertArgCount(name, args, 1);
      const arrayType = getRequiredExprType(call.id, ctx, instanceKey);
      const heapType = getFixedArrayHeapType(arrayType, ctx);
      const descriptor = getFixedArrayDescriptor(arrayType, ctx);
      const init = defaultValueForType(descriptor.element, ctx);
      return arrayNew(ctx.mod, heapType, args[0]!, init);
    }
    case "__array_new_fixed": {
      const arrayType = getRequiredExprType(call.id, ctx, instanceKey);
      const heapType = getFixedArrayHeapType(arrayType, ctx);
      return arrayNewFixed(ctx.mod, heapType, args);
    }
    case "__array_get": {
      if (args.length === 2) {
        const arrayType = getFixedArrayDescriptor(
          getRequiredExprType(call.args[0]!.expr, ctx, instanceKey),
          ctx
        );
        const elementType = wasmTypeFor(arrayType.element, ctx);
        return arrayGet(ctx.mod, args[0]!, args[1]!, elementType, false);
      }
      assertArgCount(name, args, 4);
      const elementType = getBinaryenTypeArg({
        call,
        ctx,
        index: 2,
        instanceKey,
        name,
      });
      const signed = getBooleanLiteralArg({ name, call, ctx, index: 3 });
      return arrayGet(ctx.mod, args[0]!, args[1]!, elementType, signed);
    }
    case "__array_set": {
      assertArgCount(name, args, 3);
      const arrayType = getExprBinaryenType(
        call.args[0]!.expr,
        ctx,
        instanceKey
      );
      const temp = allocateTempLocal(arrayType, fnCtx);
      const target = ctx.mod.local.get(temp.index, arrayType);
      return ctx.mod.block(
        null,
        [
          ctx.mod.local.set(temp.index, args[0]!),
          arraySet(ctx.mod, target, args[1]!, args[2]!),
          ctx.mod.local.get(temp.index, arrayType),
        ],
        getExprBinaryenType(call.id, ctx, instanceKey)
      );
    }
    case "__array_len": {
      assertArgCount(name, args, 1);
      return arrayLen(ctx.mod, args[0]!);
    }
    case "__array_copy": {
      if (args.length === 2) {
        return emitArrayCopyFromOptions({
          call,
          args,
          ctx,
          fnCtx,
          instanceKey,
        });
      }
      assertArgCount(name, args, 5);
      const arrayType = getExprBinaryenType(
        call.args[0]!.expr,
        ctx,
        instanceKey
      );
      const temp = allocateTempLocal(arrayType, fnCtx);
      const target = ctx.mod.local.get(temp.index, arrayType);
      return ctx.mod.block(
        null,
        [
          ctx.mod.local.set(temp.index, args[0]!),
          arrayCopy(
            ctx.mod,
            target,
            args[1]!,
            args[2]!,
            args[3]!,
            args[4]!
          ),
          ctx.mod.local.get(temp.index, arrayType),
        ],
        getExprBinaryenType(call.id, ctx, instanceKey)
      );
    }
    case "__type_to_heap_type": {
      assertArgCount(name, args, 1);
      return getHeapTypeArg({ call, ctx, index: 0, instanceKey, name });
    }
    case "+":
    case "-":
    case "*":
    case "/": {
      assertArgCount(name, args, 2);
      const operandKind = requireHomogeneousNumericKind(
        call.args.map((a) => a.expr),
        ctx,
        instanceKey
      );
      return emitArithmeticIntrinsic({ op: name, kind: operandKind, args, ctx });
    }
    case "<":
    case "<=":
    case ">":
    case ">=": {
      assertArgCount(name, args, 2);
      const operandKind = requireHomogeneousNumericKind(
        call.args.map((a) => a.expr),
        ctx,
        instanceKey
      );
      return emitComparisonIntrinsic({ op: name, kind: operandKind, args, ctx });
    }
    case "==":
    case "!=": {
      assertArgCount(name, args, 2);
      const operandKind = requireHomogeneousEqualityKind({
        argExprIds: call.args.map((a) => a.expr),
        ctx,
        instanceKey,
      });
      return emitEqualityIntrinsic({ op: name, kind: operandKind, args, ctx });
    }
    default:
      throw new Error(`unsupported intrinsic ${name}`);
  }
};

const emitArithmeticIntrinsic = ({
  op,
  kind,
  args,
  ctx,
}: { op: "+" | "-" | "*" | "/"; } & EmitNumericIntrinsicParams): binaryen.ExpressionRef => {
  const left = args[0]!;
  const right = args[1]!;
  switch (kind) {
    case "i32":
      switch (op) {
        case "+":
          return ctx.mod.i32.add(left, right);
        case "-":
          return ctx.mod.i32.sub(left, right);
        case "*":
          return ctx.mod.i32.mul(left, right);
        case "/":
          return ctx.mod.i32.div_s(left, right);
      }
      break;
    case "i64":
      switch (op) {
        case "+":
          return ctx.mod.i64.add(left, right);
        case "-":
          return ctx.mod.i64.sub(left, right);
        case "*":
          return ctx.mod.i64.mul(left, right);
        case "/":
          return ctx.mod.i64.div_s(left, right);
      }
      break;
    case "f32":
      switch (op) {
        case "+":
          return ctx.mod.f32.add(left, right);
        case "-":
          return ctx.mod.f32.sub(left, right);
        case "*":
          return ctx.mod.f32.mul(left, right);
        case "/":
          return ctx.mod.f32.div(left, right);
      }
      break;
    case "f64":
      switch (op) {
        case "+":
          return ctx.mod.f64.add(left, right);
        case "-":
          return ctx.mod.f64.sub(left, right);
        case "*":
          return ctx.mod.f64.mul(left, right);
        case "/":
          return ctx.mod.f64.div(left, right);
      }
      break;
  }
  throw new Error(`unsupported ${op} intrinsic for numeric kind ${kind}`);
};

const emitComparisonIntrinsic = ({
  op,
  kind,
  args,
  ctx,
}: { op: "<" | "<=" | ">" | ">="; } & EmitNumericIntrinsicParams): binaryen.ExpressionRef => {
  const left = args[0]!;
  const right = args[1]!;
  switch (kind) {
    case "i32":
      switch (op) {
        case "<":
          return ctx.mod.i32.lt_s(left, right);
        case "<=":
          return ctx.mod.i32.le_s(left, right);
        case ">":
          return ctx.mod.i32.gt_s(left, right);
        case ">=":
          return ctx.mod.i32.ge_s(left, right);
      }
      break;
    case "i64":
      switch (op) {
        case "<":
          return ctx.mod.i64.lt_s(left, right);
        case "<=":
          return ctx.mod.i64.le_s(left, right);
        case ">":
          return ctx.mod.i64.gt_s(left, right);
        case ">=":
          return ctx.mod.i64.ge_s(left, right);
      }
      break;
    case "f32":
      switch (op) {
        case "<":
          return ctx.mod.f32.lt(left, right);
        case "<=":
          return ctx.mod.f32.le(left, right);
        case ">":
          return ctx.mod.f32.gt(left, right);
        case ">=":
          return ctx.mod.f32.ge(left, right);
      }
      break;
    case "f64":
      switch (op) {
        case "<":
          return ctx.mod.f64.lt(left, right);
        case "<=":
          return ctx.mod.f64.le(left, right);
        case ">":
          return ctx.mod.f64.gt(left, right);
        case ">=":
          return ctx.mod.f64.ge(left, right);
      }
      break;
  }
  throw new Error(`unsupported ${op} comparison for numeric kind ${kind}`);
};

const emitEqualityIntrinsic = ({
  op,
  kind,
  args,
  ctx,
}: EmitEqualityIntrinsicParams): binaryen.ExpressionRef => {
  const left = args[0]!;
  const right = args[1]!;
  switch (kind) {
    case "bool":
      return op === "=="
        ? ctx.mod.i32.eq(left, right)
        : ctx.mod.i32.ne(left, right);
    case "i32":
      return op === "=="
        ? ctx.mod.i32.eq(left, right)
        : ctx.mod.i32.ne(left, right);
    case "i64":
      return op === "=="
        ? ctx.mod.i64.eq(left, right)
        : ctx.mod.i64.ne(left, right);
    case "f32":
      return op === "=="
        ? ctx.mod.f32.eq(left, right)
        : ctx.mod.f32.ne(left, right);
    case "f64":
      return op === "=="
        ? ctx.mod.f64.eq(left, right)
        : ctx.mod.f64.ne(left, right);
  }
  throw new Error(`unsupported ${op} equality for kind ${kind}`);
};

const requireHomogeneousNumericKind = (
  argExprIds: readonly HirExprId[],
  ctx: CodegenContext,
  instanceKey?: string
): NumericKind => {
  if (argExprIds.length === 0) {
    throw new Error("intrinsic requires at least one operand");
  }
  const firstKind = getNumericKind(
    getRequiredExprType(argExprIds[0]!, ctx, instanceKey),
    ctx
  );
  for (let i = 1; i < argExprIds.length; i += 1) {
    const nextKind = getNumericKind(
      getRequiredExprType(argExprIds[i]!, ctx, instanceKey),
      ctx
    );
    if (nextKind !== firstKind) {
      throw new Error("intrinsic operands must share the same numeric type");
    }
  }
  return firstKind;
};

const requireHomogeneousEqualityKind = ({
  argExprIds,
  ctx,
  instanceKey,
}: {
  argExprIds: readonly HirExprId[];
  ctx: CodegenContext;
  instanceKey?: string;
}): EqualityKind => {
  if (argExprIds.length === 0) {
    throw new Error("intrinsic requires at least one operand");
  }
  const firstKind = getEqualityKind(
    getRequiredExprType(argExprIds[0]!, ctx, instanceKey),
    ctx
  );
  for (let i = 1; i < argExprIds.length; i += 1) {
    const nextKind = getEqualityKind(
      getRequiredExprType(argExprIds[i]!, ctx, instanceKey),
      ctx
    );
    if (nextKind !== firstKind) {
      throw new Error(
        "intrinsic operands must share the same primitive type"
      );
    }
  }
  return firstKind;
};

const getNumericKind = (typeId: TypeId, ctx: CodegenContext): NumericKind => {
  const descriptor = ctx.typing.arena.get(typeId);
  if (descriptor.kind === "primitive") {
    switch (descriptor.name) {
      case "i32":
        return "i32";
      case "i64":
        return "i64";
      case "f32":
        return "f32";
      case "f64":
        return "f64";
    }
  }
  throw new Error("intrinsic arguments must be primitive numeric types");
};

const getEqualityKind = (
  typeId: TypeId,
  ctx: CodegenContext
): EqualityKind => {
  const descriptor = ctx.typing.arena.get(typeId);
  if (descriptor.kind === "primitive") {
    switch (descriptor.name) {
      case "bool":
      case "boolean":
        return "bool";
      case "i32":
        return "i32";
      case "i64":
        return "i64";
      case "f32":
        return "f32";
      case "f64":
        return "f64";
    }
  }
  throw new Error(
    "intrinsic arguments must be primitive numeric or boolean types"
  );
};

const assertArgCount = (
  name: string,
  args: readonly unknown[],
  expected: number
): void => {
  if (args.length !== expected) {
    throw new Error(
      `intrinsic ${name} expected ${expected} args, received ${args.length}`
    );
  }
};

const assertMinArgCount = (
  name: string,
  args: readonly unknown[],
  min: number
): void => {
  if (args.length < min) {
    throw new Error(
      `intrinsic ${name} expected at least ${min} args, received ${args.length}`
    );
  }
};

const getBinaryenTypeArg = ({
  call,
  ctx,
  index,
  instanceKey,
  name,
}: {
  call: HirCallExpr;
  ctx: CodegenContext;
  index: number;
  instanceKey?: string;
  name?: string;
}): binaryen.Type => {
  const arg = call.args[index];
  if (!arg) {
    const source = name ? `intrinsic ${name}` : "intrinsic";
    throw new Error(`${source} argument ${index + 1} missing`);
  }
  return getExprBinaryenType(arg.expr, ctx, instanceKey);
};

const getHeapTypeArg = ({
  call,
  ctx,
  index,
  instanceKey,
  name,
}: {
  call: HirCallExpr;
  ctx: CodegenContext;
  index: number;
  instanceKey?: string;
  name?: string;
}): HeapTypeRef => {
  const type = getBinaryenTypeArg({ call, ctx, index, instanceKey, name });
  return modBinaryenTypeToHeapType(ctx.mod, type);
};

const getFixedArrayDescriptor = (
  typeId: TypeId,
  ctx: CodegenContext
): { kind: "fixed-array"; element: TypeId } => {
  const desc = ctx.typing.arena.get(typeId);
  if (desc.kind !== "fixed-array") {
    throw new Error("intrinsic requires a fixed-array type");
  }
  return desc as { kind: "fixed-array"; element: TypeId };
};

const getFixedArrayHeapType = (
  typeId: TypeId,
  ctx: CodegenContext
): HeapTypeRef => {
  const { heapType } = getFixedArrayWasmTypes(typeId, ctx);
  return heapType;
};

const emitArrayCopyFromOptions = ({
  call,
  args,
  ctx,
  fnCtx,
  instanceKey,
}: {
  call: HirCallExpr;
  args: readonly binaryen.ExpressionRef[];
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  instanceKey?: string;
}): binaryen.ExpressionRef => {
  const opts = call.args[1];
  if (!opts) {
    throw new Error("array.copy intrinsic missing options argument");
  }
  const arrayType = getExprBinaryenType(call.args[0]!.expr, ctx, instanceKey);
  const optsType = getRequiredExprType(opts.expr, ctx, instanceKey);
  const structInfo = getStructuralTypeInfo(optsType, ctx);
  if (!structInfo) {
    throw new Error("array.copy options must be a structural object");
  }

  const fieldOrder = [
    "to_index",
    "from",
    "from_index",
    "count",
  ] as const;
  const fields = fieldOrder.map((field) => {
    const resolved = structInfo.fieldMap.get(field);
    if (!resolved) {
      throw new Error(`array.copy options missing field ${field}`);
    }
    return resolved;
  });

  const destTemp = allocateTempLocal(arrayType, fnCtx);
  const temp = allocateTempLocal(structInfo.interfaceType, fnCtx);
  const target = ctx.mod.local.get(destTemp.index, arrayType);
  const pointer = ctx.mod.local.get(temp.index, structInfo.interfaceType);
  const loadField = (field: (typeof fields)[number]): binaryen.ExpressionRef =>
    loadStructuralField({ structInfo, field, pointer, ctx });

  const copyExpr = arrayCopy(
    ctx.mod,
    target,
    loadField(fields[0]!),
    loadField(fields[1]!),
    loadField(fields[2]!),
    loadField(fields[3]!)
  );

  return ctx.mod.block(
    null,
    [
      ctx.mod.local.set(destTemp.index, args[0]!),
      ctx.mod.local.set(temp.index, args[1]!),
      copyExpr,
      ctx.mod.local.get(destTemp.index, arrayType),
    ],
    getExprBinaryenType(call.id, ctx, instanceKey)
  );
};

const defaultValueForType = (
  typeId: TypeId,
  ctx: CodegenContext
): binaryen.ExpressionRef => {
  const desc = ctx.typing.arena.get(typeId);
  switch (desc.kind) {
    case "primitive":
      switch (desc.name) {
        case "i32":
        case "bool":
        case "boolean":
        case "unknown":
          return ctx.mod.i32.const(0);
        case "i64":
          return ctx.mod.i64.const(0, 0);
        case "f32":
          return ctx.mod.f32.const(0);
        case "f64":
          return ctx.mod.f64.const(0);
      }
      break;
    case "fixed-array": {
      const { heapType } = getFixedArrayWasmTypes(typeId, ctx);
      return ctx.mod.ref.null(heapType);
    }
    case "structural-object":
    case "nominal-object":
    case "trait":
    case "intersection":
    case "union": {
      const wasmType = wasmTypeFor(typeId, ctx);
      return ctx.mod.ref.null(modBinaryenTypeToHeapType(ctx.mod, wasmType));
    }
  }
  throw new Error(`unsupported intrinsic default value for ${desc.kind}`);
};

const getBooleanLiteralArg = ({
  name,
  call,
  ctx,
  index,
}: {
  name: string;
  call: HirCallExpr;
  ctx: CodegenContext;
  index: number;
}): boolean => {
  const exprId = call.args[index]?.expr;
  if (typeof exprId !== "number") {
    throw new Error(`intrinsic ${name} missing argument ${index + 1}`);
  }
  const expr = ctx.hir.expressions.get(exprId);
  if (
    !expr ||
    expr.exprKind !== "literal" ||
    expr.literalKind !== "boolean"
  ) {
    throw new Error(
      `intrinsic ${name} argument ${index + 1} must be a boolean literal`
    );
  }
  return expr.value === "true";
};
