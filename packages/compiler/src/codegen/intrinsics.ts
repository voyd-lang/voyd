import binaryen from "binaryen";
import type {
  CodegenContext,
  FunctionContext,
  HirCallExpr,
  HirExprId,
  TypeId,
} from "./context.js";
import type { ProgramFunctionInstanceId } from "../semantics/ids.js";
import {
  getExprBinaryenType,
  getRequiredExprType,
  getStructuralTypeInfo,
  getFixedArrayWasmTypes,
  wasmHeapFieldTypeFor,
  wasmTypeFor,
} from "./types.js";
import { allocateTempLocal } from "./locals.js";
import { loadStructuralField } from "./structural.js";
import { coerceExprToWasmType } from "./wasm-type-coercions.js";
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
import { LINEAR_MEMORY_INTERNAL } from "./effects/host-boundary/constants.js";

type NumericKind = "i32" | "i64" | "f32" | "f64";
type EqualityKind = NumericKind | "bool";
type BooleanKind = "bool";
type IntegerKind = "i32" | "i64";
type FloatKind = "f32" | "f64";
type WasmFloatUnaryIntrinsicOp =
  | "__floor"
  | "__ceil"
  | "__round"
  | "__trunc"
  | "__sqrt";
type HostMathUnaryIntrinsicOp =
  | "__sin"
  | "__cos"
  | "__tan"
  | "__ln"
  | "__log2"
  | "__log10"
  | "__exp";
type HostMathBinaryIntrinsicOp = "__pow" | "__atan2";

const HOST_MATH_MODULE = "voyd_math";
const HOST_MATH_IMPORT_STATE = Symbol("host-math-imports");

const HOST_MATH_IMPORTS = {
  __sin: { local: "__voyd_math_sin", base: "sin" },
  __cos: { local: "__voyd_math_cos", base: "cos" },
  __tan: { local: "__voyd_math_tan", base: "tan" },
  __ln: { local: "__voyd_math_ln", base: "ln" },
  __log2: { local: "__voyd_math_log2", base: "log2" },
  __log10: { local: "__voyd_math_log10", base: "log10" },
  __exp: { local: "__voyd_math_exp", base: "exp" },
  __pow: { local: "__voyd_math_pow", base: "pow" },
  __atan2: { local: "__voyd_math_atan2", base: "atan2" },
} as const;

interface CompileIntrinsicCallParams {
  name: string;
  call: HirCallExpr;
  args: readonly binaryen.ExpressionRef[];
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  instanceId?: ProgramFunctionInstanceId;
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

interface EmitFloatUnaryIntrinsicParams {
  op: WasmFloatUnaryIntrinsicOp;
  kind: FloatKind;
  arg: binaryen.ExpressionRef;
  ctx: CodegenContext;
}

interface EmitHostMathUnaryIntrinsicParams {
  op: HostMathUnaryIntrinsicOp;
  kind: FloatKind;
  arg: binaryen.ExpressionRef;
  ctx: CodegenContext;
}

interface EmitHostMathBinaryIntrinsicParams {
  op: HostMathBinaryIntrinsicOp;
  kind: FloatKind;
  args: readonly binaryen.ExpressionRef[];
  ctx: CodegenContext;
}

export const compileIntrinsicCall = ({
  name,
  call,
  args,
  ctx,
  fnCtx,
  instanceId,
}: CompileIntrinsicCallParams): binaryen.ExpressionRef => {
  switch (name) {
    case "~": {
      assertArgCount(name, args, 1);
      return args[0]!;
    }
    case "__array_new": {
      assertArgCount(name, args, 1);
      const arrayType = getRequiredExprType(call.id, ctx, instanceId);
      const heapType = getFixedArrayHeapType(arrayType, ctx);
      const descriptor = getFixedArrayDescriptor(arrayType, ctx);
      const init = defaultValueForType(descriptor.element, ctx);
      return arrayNew(ctx.mod, heapType, args[0]!, init);
    }
    case "__array_new_fixed": {
      const arrayType = getRequiredExprType(call.id, ctx, instanceId);
      const heapType = getFixedArrayHeapType(arrayType, ctx);
      const desc = getFixedArrayDescriptor(arrayType, ctx);
      const elementType = wasmHeapFieldTypeFor(desc.element, ctx, new Set(), "runtime");
      const values = args.map((value) =>
        coerceExprToWasmType({ expr: value!, targetType: elementType, ctx })
      );
      return arrayNewFixed(ctx.mod, heapType, values as number[]);
    }
    case "__array_get": {
      if (args.length === 2) {
        const arrayType = getFixedArrayDescriptor(
          getRequiredExprType(call.args[0]!.expr, ctx, instanceId),
          ctx
        );
        const elementType = wasmHeapFieldTypeFor(arrayType.element, ctx, new Set(), "runtime");
        return arrayGet(ctx.mod, args[0]!, args[1]!, elementType, false);
      }
      assertArgCount(name, args, 4);
      const elementType = getBinaryenTypeArg({
        call,
        ctx,
        index: 2,
        instanceId,
        name,
      });
      const signed = getBooleanLiteralArg({ name, call, ctx, index: 3 });
      return arrayGet(ctx.mod, args[0]!, args[1]!, elementType, signed);
    }
    case "__ref_is_null": {
      assertArgCount(name, args, 1);
      const valueType = wasmTypeFor(
        getRequiredExprType(call.args[0]!.expr, ctx, instanceId),
        ctx
      );
      if (
        valueType === binaryen.i32 ||
        valueType === binaryen.i64 ||
        valueType === binaryen.f32 ||
        valueType === binaryen.f64
      ) {
        return ctx.mod.block(
          null,
          [ctx.mod.drop(args[0]!), ctx.mod.i32.const(0)],
          binaryen.i32
        );
      }
      return ctx.mod.ref.is_null(args[0]!);
    }
    case "__array_set": {
      assertArgCount(name, args, 3);
      const arrayType = getExprBinaryenType(
        call.args[0]!.expr,
        ctx,
        instanceId
      );
      const arrayTypeId = getRequiredExprType(call.id, ctx, instanceId);
      const desc = getFixedArrayDescriptor(arrayTypeId, ctx);
      const elementType = wasmHeapFieldTypeFor(desc.element, ctx, new Set(), "runtime");
      const value = coerceExprToWasmType({ expr: args[2]!, targetType: elementType, ctx });
      const temp = allocateTempLocal(arrayType, fnCtx);
      const target = ctx.mod.local.get(temp.index, arrayType);
      return ctx.mod.block(
        null,
        [
          ctx.mod.local.set(temp.index, args[0]!),
          arraySet(ctx.mod, target, args[1]!, value),
          ctx.mod.local.get(temp.index, arrayType),
        ],
        getExprBinaryenType(call.id, ctx, instanceId)
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
          instanceId,
        });
      }
      assertArgCount(name, args, 5);
      const arrayType = getExprBinaryenType(
        call.args[0]!.expr,
        ctx,
        instanceId
      );
      const temp = allocateTempLocal(arrayType, fnCtx);
      const target = ctx.mod.local.get(temp.index, arrayType);
      return ctx.mod.block(
        null,
        [
          ctx.mod.local.set(temp.index, args[0]!),
          arrayCopy(ctx.mod, target, args[1]!, args[2]!, args[3]!, args[4]!),
          ctx.mod.local.get(temp.index, arrayType),
        ],
        getExprBinaryenType(call.id, ctx, instanceId)
      );
    }
    case "__type_to_heap_type": {
      assertArgCount(name, args, 1);
      return getHeapTypeArg({ call, ctx, index: 0, instanceId, name });
    }
    case "__memory_size": {
      assertArgCount(name, args, 0);
      return ctx.mod.memory.size(LINEAR_MEMORY_INTERNAL);
    }
    case "__memory_grow": {
      assertArgCount(name, args, 1);
      return ctx.mod.memory.grow(args[0]!, LINEAR_MEMORY_INTERNAL);
    }
    case "__memory_load_u8": {
      assertArgCount(name, args, 1);
      return ctx.mod.i32.load8_u(0, 1, args[0]!, LINEAR_MEMORY_INTERNAL);
    }
    case "__memory_store_u8": {
      assertArgCount(name, args, 2);
      return ctx.mod.i32.store8(0, 1, args[0]!, args[1]!, LINEAR_MEMORY_INTERNAL);
    }
    case "__memory_load_u16": {
      assertArgCount(name, args, 1);
      return ctx.mod.i32.load16_u(0, 2, args[0]!, LINEAR_MEMORY_INTERNAL);
    }
    case "__memory_store_u16": {
      assertArgCount(name, args, 2);
      return ctx.mod.i32.store16(0, 2, args[0]!, args[1]!, LINEAR_MEMORY_INTERNAL);
    }
    case "__memory_load_u32": {
      assertArgCount(name, args, 1);
      return ctx.mod.i32.load(0, 4, args[0]!, LINEAR_MEMORY_INTERNAL);
    }
    case "__memory_store_u32": {
      assertArgCount(name, args, 2);
      return ctx.mod.i32.store(0, 4, args[0]!, args[1]!, LINEAR_MEMORY_INTERNAL);
    }
    case "__memory_copy": {
      assertArgCount(name, args, 3);
      return ctx.mod.memory.copy(
        args[0]!,
        args[1]!,
        args[2]!,
        LINEAR_MEMORY_INTERNAL,
        LINEAR_MEMORY_INTERNAL
      );
    }
    case "__panic_trap": {
      assertArgCount(name, args, 0);
      return ctx.mod.unreachable();
    }
    case "__shift_l":
    case "__shift_ru": {
      assertArgCount(name, args, 2);
      const valueKind = requireIntegerKind(
        getRequiredExprType(call.args[0]!.expr, ctx, instanceId),
        ctx
      );
      if (valueKind === "i32") {
        return name === "__shift_l"
          ? ctx.mod.i32.shl(args[0]!, args[1]!)
          : ctx.mod.i32.shr_u(args[0]!, args[1]!);
      }
      const shiftType = getRequiredExprType(call.args[1]!.expr, ctx, instanceId);
      const shiftExpr =
        shiftType === ctx.program.primitives.i32
          ? ctx.mod.i64.extend_u(args[1]!)
          : args[1]!;
      return name === "__shift_l"
        ? ctx.mod.i64.shl(args[0]!, shiftExpr)
        : ctx.mod.i64.shr_u(args[0]!, shiftExpr);
    }
    case "__bit_and":
    case "__bit_or":
    case "__bit_xor": {
      assertArgCount(name, args, 2);
      const valueKind = requireIntegerKind(
        getRequiredExprType(call.args[0]!.expr, ctx, instanceId),
        ctx
      );
      if (valueKind === "i32") {
        switch (name) {
          case "__bit_and":
            return ctx.mod.i32.and(args[0]!, args[1]!);
          case "__bit_or":
            return ctx.mod.i32.or(args[0]!, args[1]!);
          case "__bit_xor":
            return ctx.mod.i32.xor(args[0]!, args[1]!);
        }
      }
      switch (name) {
        case "__bit_and":
          return ctx.mod.i64.and(args[0]!, args[1]!);
        case "__bit_or":
          return ctx.mod.i64.or(args[0]!, args[1]!);
        case "__bit_xor":
          return ctx.mod.i64.xor(args[0]!, args[1]!);
      }
      return ctx.mod.unreachable();
    }
    case "__i32_wrap_i64": {
      assertArgCount(name, args, 1);
      return ctx.mod.i32.wrap(args[0]!);
    }
    case "__i64_extend_u": {
      assertArgCount(name, args, 1);
      return ctx.mod.i64.extend_u(args[0]!);
    }
    case "__i64_extend_s": {
      assertArgCount(name, args, 1);
      return ctx.mod.i64.extend_s(args[0]!);
    }
    case "__i32_trunc_f32_s": {
      assertArgCount(name, args, 1);
      return ctx.mod.i32.trunc_s.f32(args[0]!);
    }
    case "__i32_trunc_f64_s": {
      assertArgCount(name, args, 1);
      return ctx.mod.i32.trunc_s.f64(args[0]!);
    }
    case "__i64_trunc_f32_s": {
      assertArgCount(name, args, 1);
      return ctx.mod.i64.trunc_s.f32(args[0]!);
    }
    case "__i64_trunc_f64_s": {
      assertArgCount(name, args, 1);
      return ctx.mod.i64.trunc_s.f64(args[0]!);
    }
    case "__f32_convert_i32_s": {
      assertArgCount(name, args, 1);
      return ctx.mod.f32.convert_s.i32(args[0]!);
    }
    case "__f32_convert_i64_s": {
      assertArgCount(name, args, 1);
      return ctx.mod.f32.convert_s.i64(args[0]!);
    }
    case "__f64_convert_i32_s": {
      assertArgCount(name, args, 1);
      return ctx.mod.f64.convert_s.i32(args[0]!);
    }
    case "__f64_convert_i64_s": {
      assertArgCount(name, args, 1);
      return ctx.mod.f64.convert_s.i64(args[0]!);
    }
    case "__reinterpret_f32_to_i32": {
      assertArgCount(name, args, 1);
      return ctx.mod.i32.reinterpret(args[0]!);
    }
    case "__reinterpret_i32_to_f32": {
      assertArgCount(name, args, 1);
      return ctx.mod.f32.reinterpret(args[0]!);
    }
    case "__reinterpret_f64_to_i64": {
      assertArgCount(name, args, 1);
      return ctx.mod.i64.reinterpret(args[0]!);
    }
    case "__reinterpret_i64_to_f64": {
      assertArgCount(name, args, 1);
      return ctx.mod.f64.reinterpret(args[0]!);
    }
    case "__f32_demote_f64": {
      assertArgCount(name, args, 1);
      return ctx.mod.f32.demote(args[0]!);
    }
    case "__f64_promote_f32": {
      assertArgCount(name, args, 1);
      return ctx.mod.f64.promote(args[0]!);
    }
    case "__floor":
    case "__ceil":
    case "__round":
    case "__trunc":
    case "__sqrt": {
      assertArgCount(name, args, 1);
      const kind = requireFloatKind(
        getRequiredExprType(call.args[0]!.expr, ctx, instanceId),
        ctx
      );
      return emitFloatUnaryIntrinsic({
        op: name,
        kind,
        arg: args[0]!,
        ctx,
      });
    }
    case "__sin":
    case "__cos":
    case "__tan":
    case "__ln":
    case "__log2":
    case "__log10":
    case "__exp": {
      assertArgCount(name, args, 1);
      const kind = requireFloatKind(
        getRequiredExprType(call.args[0]!.expr, ctx, instanceId),
        ctx
      );
      return emitHostMathUnaryIntrinsic({
        op: name,
        kind,
        arg: args[0]!,
        ctx,
      });
    }
    case "__pow":
    case "__atan2": {
      assertArgCount(name, args, 2);
      const kind = requireHomogeneousFloatKind({
        argExprIds: call.args.map((a) => a.expr),
        ctx,
        instanceId,
      });
      return emitHostMathBinaryIntrinsic({
        op: name,
        kind,
        args,
        ctx,
      });
    }
    case "+":
    case "*":
    case "/": {
      assertArgCount(name, args, 2);
      const operandKind = requireHomogeneousNumericKind(
        call.args.map((a) => a.expr),
        ctx,
        instanceId
      );
      return emitArithmeticIntrinsic({
        op: name,
        kind: operandKind,
        args,
        ctx,
      });
    }
    case "-": {
      const operandKind = requireHomogeneousNumericKind(
        call.args.map((a) => a.expr),
        ctx,
        instanceId
      );
      if (args.length === 1) {
        return emitUnaryNegationIntrinsic({
          kind: operandKind,
          arg: args[0]!,
          ctx,
        });
      }
      assertArgCount(name, args, 2);
      return emitArithmeticIntrinsic({
        op: name,
        kind: operandKind,
        args,
        ctx,
      });
    }
    case "%": {
      assertArgCount(name, args, 2);
      const operandKind = requireHomogeneousIntegerKind({
        argExprIds: call.args.map((a) => a.expr),
        ctx,
        instanceId,
      });
      return emitModuloIntrinsic({ kind: operandKind, args, ctx });
    }
    case "<":
    case "<=":
    case ">":
    case ">=": {
      assertArgCount(name, args, 2);
      const operandKind = requireHomogeneousNumericKind(
        call.args.map((a) => a.expr),
        ctx,
        instanceId
      );
      return emitComparisonIntrinsic({
        op: name,
        kind: operandKind,
        args,
        ctx,
      });
    }
    case "==":
    case "!=": {
      assertArgCount(name, args, 2);
      const operandKind = requireHomogeneousEqualityKind({
        argExprIds: call.args.map((a) => a.expr),
        ctx,
        instanceId,
      });
      return emitEqualityIntrinsic({ op: name, kind: operandKind, args, ctx });
    }
    case "and":
    case "or":
    case "xor": {
      assertArgCount(name, args, 2);
      requireBooleanKind({
        argExprIds: call.args.map((a) => a.expr),
        ctx,
        instanceId,
      });
      return emitBooleanBinaryIntrinsic({
        op: name,
        args,
        ctx,
      });
    }
    case "not": {
      assertArgCount(name, args, 1);
      requireBooleanKind({
        argExprIds: call.args.map((a) => a.expr),
        ctx,
        instanceId,
      });
      return emitBooleanNotIntrinsic({ arg: args[0]!, ctx });
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
}: {
  op: "+" | "-" | "*" | "/";
} & EmitNumericIntrinsicParams): binaryen.ExpressionRef => {
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

const emitUnaryNegationIntrinsic = ({
  kind,
  arg,
  ctx,
}: {
  kind: NumericKind;
  arg: binaryen.ExpressionRef;
  ctx: CodegenContext;
}): binaryen.ExpressionRef => {
  switch (kind) {
    case "i32":
      return ctx.mod.i32.sub(ctx.mod.i32.const(0), arg);
    case "i64":
      return ctx.mod.i64.sub(ctx.mod.i64.const(0, 0), arg);
    case "f32":
      return ctx.mod.f32.neg(arg);
    case "f64":
      return ctx.mod.f64.neg(arg);
  }
};

const emitFloatUnaryIntrinsic = ({
  op,
  kind,
  arg,
  ctx,
}: EmitFloatUnaryIntrinsicParams): binaryen.ExpressionRef => {
  if (kind === "f32") {
    switch (op) {
      case "__floor":
        return ctx.mod.f32.floor(arg);
      case "__ceil":
        return ctx.mod.f32.ceil(arg);
      case "__round":
        return ctx.mod.f32.nearest(arg);
      case "__trunc":
        return ctx.mod.f32.trunc(arg);
      case "__sqrt":
        return ctx.mod.f32.sqrt(arg);
    }
  }

  switch (op) {
    case "__floor":
      return ctx.mod.f64.floor(arg);
    case "__ceil":
      return ctx.mod.f64.ceil(arg);
    case "__round":
      return ctx.mod.f64.nearest(arg);
    case "__trunc":
      return ctx.mod.f64.trunc(arg);
    case "__sqrt":
      return ctx.mod.f64.sqrt(arg);
  }
};

const emitHostMathUnaryIntrinsic = ({
  op,
  kind,
  arg,
  ctx,
}: EmitHostMathUnaryIntrinsicParams): binaryen.ExpressionRef => {
  const importDef = HOST_MATH_IMPORTS[op];
  const callF64 = (value: binaryen.ExpressionRef): binaryen.ExpressionRef =>
    callHostMathImport({
      ctx,
      localName: importDef.local,
      baseName: importDef.base,
      args: [value],
      resultType: binaryen.f64,
      paramTypes: [binaryen.f64],
    });
  if (kind === "f32") {
    return ctx.mod.f32.demote(callF64(ctx.mod.f64.promote(arg)));
  }
  return callF64(arg);
};

const emitHostMathBinaryIntrinsic = ({
  op,
  kind,
  args,
  ctx,
}: EmitHostMathBinaryIntrinsicParams): binaryen.ExpressionRef => {
  const importDef = HOST_MATH_IMPORTS[op];
  const callF64 = (
    left: binaryen.ExpressionRef,
    right: binaryen.ExpressionRef
  ): binaryen.ExpressionRef =>
    callHostMathImport({
      ctx,
      localName: importDef.local,
      baseName: importDef.base,
      args: [left, right],
      resultType: binaryen.f64,
      paramTypes: [binaryen.f64, binaryen.f64],
    });
  if (kind === "f32") {
    return ctx.mod.f32.demote(
      callF64(ctx.mod.f64.promote(args[0]!), ctx.mod.f64.promote(args[1]!))
    );
  }
  return callF64(args[0]!, args[1]!);
};

const emitComparisonIntrinsic = ({
  op,
  kind,
  args,
  ctx,
}: {
  op: "<" | "<=" | ">" | ">=";
} & EmitNumericIntrinsicParams): binaryen.ExpressionRef => {
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

const emitModuloIntrinsic = ({
  kind,
  args,
  ctx,
}: {
  kind: IntegerKind;
  args: readonly binaryen.ExpressionRef[];
  ctx: CodegenContext;
}): binaryen.ExpressionRef => {
  const left = args[0]!;
  const right = args[1]!;
  switch (kind) {
    case "i32":
      return ctx.mod.i32.rem_s(left, right);
    case "i64":
      return ctx.mod.i64.rem_s(left, right);
  }
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

const emitBooleanBinaryIntrinsic = ({
  op,
  args,
  ctx,
}: {
  op: "and" | "or" | "xor";
  args: readonly binaryen.ExpressionRef[];
  ctx: CodegenContext;
}): binaryen.ExpressionRef => {
  const left = args[0]!;
  const right = args[1]!;
  switch (op) {
    case "and":
      return ctx.mod.if(left, right, ctx.mod.i32.const(0));
    case "or":
      return ctx.mod.if(left, ctx.mod.i32.const(1), right);
    case "xor":
      return ctx.mod.i32.xor(left, right);
  }
};

const emitBooleanNotIntrinsic = ({
  arg,
  ctx,
}: {
  arg: binaryen.ExpressionRef;
  ctx: CodegenContext;
}): binaryen.ExpressionRef => ctx.mod.i32.eqz(arg);

const requireHomogeneousNumericKind = (
  argExprIds: readonly HirExprId[],
  ctx: CodegenContext,
  instanceId?: ProgramFunctionInstanceId
): NumericKind => {
  if (argExprIds.length === 0) {
    throw new Error("intrinsic requires at least one operand");
  }
  const firstKind = getNumericKind(
    getRequiredExprType(argExprIds[0]!, ctx, instanceId),
    ctx
  );
  for (let i = 1; i < argExprIds.length; i += 1) {
    const nextKind = getNumericKind(
      getRequiredExprType(argExprIds[i]!, ctx, instanceId),
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
  instanceId,
}: {
  argExprIds: readonly HirExprId[];
  ctx: CodegenContext;
  instanceId?: ProgramFunctionInstanceId;
}): EqualityKind => {
  if (argExprIds.length === 0) {
    throw new Error("intrinsic requires at least one operand");
  }
  const firstKind = getEqualityKind(
    getRequiredExprType(argExprIds[0]!, ctx, instanceId),
    ctx
  );
  for (let i = 1; i < argExprIds.length; i += 1) {
    const nextKind = getEqualityKind(
      getRequiredExprType(argExprIds[i]!, ctx, instanceId),
      ctx
    );
    if (nextKind !== firstKind) {
      throw new Error("intrinsic operands must share the same primitive type");
    }
  }
  return firstKind;
};

const requireHomogeneousIntegerKind = ({
  argExprIds,
  ctx,
  instanceId,
}: {
  argExprIds: readonly HirExprId[];
  ctx: CodegenContext;
  instanceId?: ProgramFunctionInstanceId;
}): IntegerKind => {
  if (argExprIds.length === 0) {
    throw new Error("intrinsic requires at least one operand");
  }
  const firstKind = requireIntegerKind(
    getRequiredExprType(argExprIds[0]!, ctx, instanceId),
    ctx
  );
  for (let i = 1; i < argExprIds.length; i += 1) {
    const nextKind = requireIntegerKind(
      getRequiredExprType(argExprIds[i]!, ctx, instanceId),
      ctx
    );
    if (nextKind !== firstKind) {
      throw new Error("intrinsic operands must share the same integer type");
    }
  }
  return firstKind;
};

const requireHomogeneousFloatKind = ({
  argExprIds,
  ctx,
  instanceId,
}: {
  argExprIds: readonly HirExprId[];
  ctx: CodegenContext;
  instanceId?: ProgramFunctionInstanceId;
}): FloatKind => {
  if (argExprIds.length === 0) {
    throw new Error("intrinsic requires at least one operand");
  }
  const firstKind = requireFloatKind(
    getRequiredExprType(argExprIds[0]!, ctx, instanceId),
    ctx
  );
  for (let i = 1; i < argExprIds.length; i += 1) {
    const nextKind = requireFloatKind(
      getRequiredExprType(argExprIds[i]!, ctx, instanceId),
      ctx
    );
    if (nextKind !== firstKind) {
      throw new Error("intrinsic operands must share the same float type");
    }
  }
  return firstKind;
};

const requireBooleanKind = ({
  argExprIds,
  ctx,
  instanceId,
}: {
  argExprIds: readonly HirExprId[];
  ctx: CodegenContext;
  instanceId?: ProgramFunctionInstanceId;
}): BooleanKind => {
  if (argExprIds.length === 0) {
    throw new Error("intrinsic requires at least one operand");
  }
  const firstKind = getBooleanKind(
    getRequiredExprType(argExprIds[0]!, ctx, instanceId),
    ctx
  );
  for (let i = 1; i < argExprIds.length; i += 1) {
    const nextKind = getBooleanKind(
      getRequiredExprType(argExprIds[i]!, ctx, instanceId),
      ctx
    );
    if (nextKind !== firstKind) {
      throw new Error("intrinsic operands must be boolean types");
    }
  }
  return firstKind;
};

const requireIntegerKind = (typeId: TypeId, ctx: CodegenContext): IntegerKind => {
  const desc = ctx.program.types.getTypeDesc(typeId);
  if (desc.kind === "primitive") {
    switch (desc.name) {
      case "i32":
        return "i32";
      case "i64":
        return "i64";
    }
  }
  throw new Error("intrinsic arguments must be i32 or i64");
};

const requireFloatKind = (typeId: TypeId, ctx: CodegenContext): FloatKind => {
  const desc = ctx.program.types.getTypeDesc(typeId);
  if (desc.kind === "primitive") {
    switch (desc.name) {
      case "f32":
        return "f32";
      case "f64":
        return "f64";
    }
  }
  throw new Error("intrinsic arguments must be f32 or f64");
};

const getNumericKind = (typeId: TypeId, ctx: CodegenContext): NumericKind => {
  const descriptor = ctx.program.types.getTypeDesc(typeId);
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

const getEqualityKind = (typeId: TypeId, ctx: CodegenContext): EqualityKind => {
  const descriptor = ctx.program.types.getTypeDesc(typeId);
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

const getBooleanKind = (
  typeId: TypeId,
  ctx: CodegenContext
): BooleanKind => {
  const descriptor = ctx.program.types.getTypeDesc(typeId);
  if (
    descriptor.kind === "primitive" &&
    (descriptor.name === "bool" || descriptor.name === "boolean")
  ) {
    return "bool";
  }
  throw new Error("intrinsic arguments must be boolean types");
};

const callHostMathImport = ({
  ctx,
  localName,
  baseName,
  args,
  resultType,
  paramTypes,
}: {
  ctx: CodegenContext;
  localName: string;
  baseName: string;
  args: readonly binaryen.ExpressionRef[];
  resultType: binaryen.Type;
  paramTypes: readonly binaryen.Type[];
}): binaryen.ExpressionRef => {
  ensureHostMathImport({
    ctx,
    localName,
    baseName,
    resultType,
    paramTypes,
  });
  return ctx.mod.call(localName, args as number[], resultType);
};

const ensureHostMathImport = ({
  ctx,
  localName,
  baseName,
  resultType,
  paramTypes,
}: {
  ctx: CodegenContext;
  localName: string;
  baseName: string;
  resultType: binaryen.Type;
  paramTypes: readonly binaryen.Type[];
}): void => {
  const registered = ctx.programHelpers.getHelperState(
    HOST_MATH_IMPORT_STATE,
    () => new Set<string>()
  );
  if (registered.has(localName)) {
    return;
  }
  ctx.mod.addFunctionImport(
    localName,
    HOST_MATH_MODULE,
    baseName,
    binaryen.createType(paramTypes as number[]),
    resultType
  );
  registered.add(localName);
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

const getBinaryenTypeArg = ({
  call,
  ctx,
  index,
  instanceId,
  name,
}: {
  call: HirCallExpr;
  ctx: CodegenContext;
  index: number;
  instanceId?: ProgramFunctionInstanceId;
  name?: string;
}): binaryen.Type => {
  const arg = call.args[index];
  if (!arg) {
    const source = name ? `intrinsic ${name}` : "intrinsic";
    throw new Error(`${source} argument ${index + 1} missing`);
  }
  return getExprBinaryenType(arg.expr, ctx, instanceId);
};

const getHeapTypeArg = ({
  call,
  ctx,
  index,
  instanceId,
  name,
}: {
  call: HirCallExpr;
  ctx: CodegenContext;
  index: number;
  instanceId?: ProgramFunctionInstanceId;
  name?: string;
}): HeapTypeRef => {
  const type = getBinaryenTypeArg({ call, ctx, index, instanceId, name });
  return modBinaryenTypeToHeapType(ctx.mod, type);
};

const getFixedArrayDescriptor = (
  typeId: TypeId,
  ctx: CodegenContext
): { kind: "fixed-array"; element: TypeId } => {
  const desc = ctx.program.types.getTypeDesc(typeId);
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
  instanceId,
}: {
  call: HirCallExpr;
  args: readonly binaryen.ExpressionRef[];
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  instanceId?: ProgramFunctionInstanceId;
}): binaryen.ExpressionRef => {
  const opts = call.args[1];
  if (!opts) {
    throw new Error("array.copy intrinsic missing options argument");
  }
  const arrayType = getExprBinaryenType(call.args[0]!.expr, ctx, instanceId);
  const optsType = getRequiredExprType(opts.expr, ctx, instanceId);
  const structInfo = getStructuralTypeInfo(optsType, ctx);
  if (!structInfo) {
    throw new Error("array.copy options must be a structural object");
  }

  const fieldOrder = ["to_index", "from", "from_index", "count"] as const;
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
    getExprBinaryenType(call.id, ctx, instanceId)
  );
};

const defaultValueForType = (
  typeId: TypeId,
  ctx: CodegenContext
): binaryen.ExpressionRef => {
  const desc = ctx.program.types.getTypeDesc(typeId);
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
      const { type } = getFixedArrayWasmTypes(typeId, ctx);
      return ctx.mod.ref.null(type);
    }
    case "structural-object":
    case "nominal-object":
    case "trait":
    case "intersection":
    case "union":
    case "recursive": {
      const wasmType = wasmHeapFieldTypeFor(typeId, ctx, new Set(), "runtime");
      if (wasmType === binaryen.i32) return ctx.mod.i32.const(0);
      if (wasmType === binaryen.i64) return ctx.mod.i64.const(0, 0);
      if (wasmType === binaryen.f32) return ctx.mod.f32.const(0);
      if (wasmType === binaryen.f64) return ctx.mod.f64.const(0);

      return ctx.mod.ref.null(wasmType);
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
  const expr = ctx.module.hir.expressions.get(exprId);
  if (!expr || expr.exprKind !== "literal" || expr.literalKind !== "boolean") {
    throw new Error(
      `intrinsic ${name} argument ${index + 1} must be a boolean literal`
    );
  }
  return expr.value === "true";
};
