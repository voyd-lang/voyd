import binaryen from "binaryen";
import type {
  CodegenContext,
  HirCallExpr,
  HirExprId,
  TypeId,
} from "./context.js";
import { getRequiredExprType } from "./types.js";

type NumericKind = "i32" | "i64" | "f32" | "f64";

interface CompileIntrinsicCallParams {
  name: string;
  call: HirCallExpr;
  args: readonly binaryen.ExpressionRef[];
  ctx: CodegenContext;
}

interface EmitNumericIntrinsicParams {
  kind: NumericKind;
  args: readonly binaryen.ExpressionRef[];
  ctx: CodegenContext;
}

export const compileIntrinsicCall = ({
  name,
  call,
  args,
  ctx,
}: CompileIntrinsicCallParams): binaryen.ExpressionRef => {
  switch (name) {
    case "+":
    case "-":
    case "*":
    case "/": {
      assertArgCount(name, args, 2);
      const operandKind = requireHomogeneousNumericKind(
        call.args.map((a) => a.expr),
        ctx
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
        ctx
      );
      return emitComparisonIntrinsic({ op: name, kind: operandKind, args, ctx });
    }
    case "==":
    case "!=": {
      assertArgCount(name, args, 2);
      const operandKind = requireHomogeneousNumericKind(
        call.args.map((a) => a.expr),
        ctx
      );
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
}: { op: "==" | "!="; } & EmitNumericIntrinsicParams): binaryen.ExpressionRef => {
  const left = args[0]!;
  const right = args[1]!;
  switch (kind) {
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
  throw new Error(`unsupported ${op} equality for numeric kind ${kind}`);
};

const requireHomogeneousNumericKind = (
  argExprIds: readonly HirExprId[],
  ctx: CodegenContext
): NumericKind => {
  if (argExprIds.length === 0) {
    throw new Error("intrinsic requires at least one operand");
  }
  const firstKind = getNumericKind(
    getRequiredExprType(argExprIds[0]!, ctx),
    ctx
  );
  for (let i = 1; i < argExprIds.length; i += 1) {
    const nextKind = getNumericKind(
      getRequiredExprType(argExprIds[i]!, ctx),
      ctx
    );
    if (nextKind !== firstKind) {
      throw new Error("intrinsic operands must share the same numeric type");
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
