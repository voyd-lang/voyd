import { describe, expect, it } from "vitest";
import binaryen from "binaryen";
import { compileIntrinsicCall } from "../intrinsics.js";
import {
  defineArrayType,
  binaryenTypeFromHeapType,
  modBinaryenTypeToHeapType,
} from "@voyd/lib/binaryen-gc/index.js";
import { getFixedArrayWasmTypes } from "../types.js";
import type { CodegenContext, HirCallExpr, HirExpression, HirExprId, TypeId } from "../context.js";
import { createTestCodegenContext } from "./support/test-codegen-context.js";

const span = { start: 0, end: 0 } as const;

const createContext = () => {
  const { ctx, descriptors, exprTypes, expressions } = createTestCodegenContext();
  const fnCtx = {
    bindings: new Map(),
    tempLocals: new Map(),
    locals: [],
    nextLocalIndex: 0,
    returnTypeId: 0 as TypeId,
    effectful: false,
  };
  return { ctx, descriptors, exprTypes, expressions, fnCtx };
};

const cacheArrayType = (
  ctx: CodegenContext,
  elementType: binaryen.Type,
  type: binaryen.Type
): void => {
  ctx.fixedArrayTypes.set(elementType, {
    type,
    heapType: modBinaryenTypeToHeapType(ctx.mod, type),
  });
};

const registerExpr = (
  params: {
    expressions: Map<HirExprId, HirExpression>;
    exprTypes: Map<HirExprId, TypeId>;
    typeId: TypeId;
  },
  exprId: HirExprId,
  expr: HirExpression
): void => {
  params.expressions.set(exprId, expr);
  params.exprTypes.set(exprId, params.typeId);
};

const makeCall = (args: readonly HirExprId[]): HirCallExpr => ({
  id: 0 as HirExprId,
  ast: 0 as any,
  span: span as any,
  kind: "expr",
  exprKind: "call",
  callee: 0 as HirExprId,
  args: args.map((expr) => ({ expr })),
});

const expectExpressionId = (
  expr: binaryen.ExpressionRef,
  expected: number
): void => {
  expect(binaryen.getExpressionId(expr)).toBe(expected);
};

const expectUnaryOp = (
  expr: binaryen.ExpressionRef,
  op: binaryen.Operations
): void => {
  const info = binaryen.getExpressionInfo(expr) as binaryen.UnaryInfo;
  expect(info.id).toBe(binaryen.ExpressionIds.Unary);
  expect(info.op).toBe(op);
};

describe("compileIntrinsicCall array intrinsics", () => {
  const i32Type = 1 as TypeId;
  const arrayType = 2 as TypeId;

  it("emits array.new", () => {
    const { ctx, descriptors, exprTypes, expressions, fnCtx } = createContext();
    descriptors.set(i32Type, { kind: "primitive", name: "i32" });
    descriptors.set(arrayType, { kind: "fixed-array", element: i32Type });
    const cachedArrayType = defineArrayType(
      ctx.mod,
      modBinaryenTypeToHeapType(ctx.mod, binaryen.eqref),
      true
    );
    cacheArrayType(ctx, binaryen.i32, cachedArrayType);

    registerExpr(
      { expressions, exprTypes, typeId: i32Type },
      2 as HirExprId,
      { id: 2 as HirExprId, ast: 0 as any, span: span as any, kind: "expr", exprKind: "literal", literalKind: "i32", value: "4" } as any
    );
    exprTypes.set(0 as HirExprId, arrayType);
    fnCtx.returnTypeId = arrayType;

    const expr = compileIntrinsicCall({
      name: "__array_new",
      call: makeCall([2 as HirExprId]),
      args: [ctx.mod.i32.const(4)],
      ctx,
      fnCtx,
    });

    expectExpressionId(expr, binaryen.ExpressionIds.ArrayNew);
  });

  it("emits array.new_fixed", () => {
    const { ctx, descriptors, exprTypes, expressions, fnCtx } = createContext();
    descriptors.set(i32Type, { kind: "primitive", name: "i32" });
    descriptors.set(arrayType, { kind: "fixed-array", element: i32Type });
    const cachedArrayType = defineArrayType(
      ctx.mod,
      modBinaryenTypeToHeapType(ctx.mod, binaryen.eqref),
      true
    );
    cacheArrayType(ctx, binaryen.i32, cachedArrayType);

    registerExpr(
      { expressions, exprTypes, typeId: i32Type },
      2 as HirExprId,
      { id: 2 as HirExprId, ast: 0 as any, span: span as any, kind: "expr", exprKind: "literal", literalKind: "i32", value: "1" } as any
    );
    registerExpr(
      { expressions, exprTypes, typeId: i32Type },
      3 as HirExprId,
      { id: 3 as HirExprId, ast: 0 as any, span: span as any, kind: "expr", exprKind: "literal", literalKind: "i32", value: "2" } as any
    );
    exprTypes.set(0 as HirExprId, arrayType);

    fnCtx.returnTypeId = arrayType;

    const expr = compileIntrinsicCall({
      name: "__array_new_fixed",
      call: makeCall([2 as HirExprId, 3 as HirExprId]),
      args: [ctx.mod.i32.const(1), ctx.mod.i32.const(2)],
      ctx,
      fnCtx,
    });

    expectExpressionId(expr, binaryen.ExpressionIds.ArrayNewFixed);
  });

  it("emits array.get and honors boolean signed flag", () => {
    const { ctx, descriptors, exprTypes, expressions, fnCtx } = createContext();
    descriptors.set(i32Type, { kind: "primitive", name: "i32" });
    descriptors.set(arrayType, { kind: "fixed-array", element: i32Type });
    const cachedArrayType = defineArrayType(
      ctx.mod,
      modBinaryenTypeToHeapType(ctx.mod, binaryen.eqref),
      true
    );
    cacheArrayType(ctx, binaryen.i32, cachedArrayType);

    registerExpr(
      { expressions, exprTypes, typeId: arrayType },
      1 as HirExprId,
      { id: 1 as HirExprId, ast: 0 as any, span: span as any, kind: "expr", exprKind: "literal", literalKind: "void", value: "void" } as any
    );
    registerExpr(
      { expressions, exprTypes, typeId: i32Type },
      2 as HirExprId,
      { id: 2 as HirExprId, ast: 0 as any, span: span as any, kind: "expr", exprKind: "literal", literalKind: "i32", value: "0" } as any
    );
    registerExpr(
      { expressions, exprTypes, typeId: i32Type },
      3 as HirExprId,
      { id: 3 as HirExprId, ast: 0 as any, span: span as any, kind: "expr", exprKind: "literal", literalKind: "i32", value: "0" } as any
    );
    expressions.set(4 as HirExprId, {
      id: 4 as HirExprId,
      ast: 0 as any,
      span: span as any,
      kind: "expr",
      exprKind: "literal",
      literalKind: "boolean",
      value: "false",
    } as any);
    exprTypes.set(4 as HirExprId, i32Type);

    fnCtx.returnTypeId = i32Type;

    const expr = compileIntrinsicCall({
      name: "__array_get",
      call: makeCall([
        1 as HirExprId,
        2 as HirExprId,
        3 as HirExprId,
        4 as HirExprId,
      ]),
      args: [
        ctx.mod.ref.null(
          binaryenTypeFromHeapType(
            modBinaryenTypeToHeapType(ctx.mod, cachedArrayType),
            true
          )
        ),
        ctx.mod.i32.const(0),
        ctx.mod.i32.const(0),
        ctx.mod.i32.const(0),
      ],
      ctx,
      fnCtx,
    });

    expectExpressionId(expr, binaryen.ExpressionIds.ArrayGet);
  });

  it("emits array.set", () => {
    const { ctx, descriptors, exprTypes, fnCtx } = createContext();
    descriptors.set(i32Type, { kind: "primitive", name: "i32" });
    descriptors.set(arrayType, { kind: "fixed-array", element: i32Type });
    exprTypes.set(0 as HirExprId, arrayType);
    exprTypes.set(1 as HirExprId, arrayType);
    exprTypes.set(2 as HirExprId, i32Type);
    exprTypes.set(3 as HirExprId, i32Type);
    fnCtx.returnTypeId = arrayType;
    const expr = compileIntrinsicCall({
      name: "__array_set",
      call: makeCall([1 as HirExprId, 2 as HirExprId, 3 as HirExprId]),
      args: [ctx.mod.nop(), ctx.mod.i32.const(0), ctx.mod.i32.const(1)],
      ctx,
      fnCtx,
    });

    expectExpressionId(expr, binaryen.ExpressionIds.Block);
  });

  it("emits array.len", () => {
    const { ctx, fnCtx } = createContext();
    const expr = compileIntrinsicCall({
      name: "__array_len",
      call: makeCall([1 as HirExprId]),
      args: [ctx.mod.nop()],
      ctx,
      fnCtx,
    });

    expectExpressionId(expr, binaryen.ExpressionIds.ArrayLen);
  });

  it("emits array.copy", () => {
    const { ctx, fnCtx } = createContext();
    const expr = compileIntrinsicCall({
      name: "__array_copy",
      call: makeCall([
        1 as HirExprId,
        2 as HirExprId,
        3 as HirExprId,
        4 as HirExprId,
        5 as HirExprId,
      ]),
      args: [
        ctx.mod.nop(),
        ctx.mod.i32.const(0),
        ctx.mod.nop(),
        ctx.mod.i32.const(1),
        ctx.mod.i32.const(2),
      ],
      ctx,
      fnCtx,
    });

    expectExpressionId(expr, binaryen.ExpressionIds.Block);
  });

  it("maps types to heap types", () => {
    const { ctx, descriptors, exprTypes, expressions, fnCtx } = createContext();
    descriptors.set(i32Type, { kind: "primitive", name: "i32" });
    descriptors.set(arrayType, { kind: "fixed-array", element: i32Type });
    const cachedArrayType = defineArrayType(
      ctx.mod,
      modBinaryenTypeToHeapType(ctx.mod, binaryen.eqref),
      true
    );
    cacheArrayType(ctx, binaryen.i32, cachedArrayType);

    registerExpr(
      { expressions, exprTypes, typeId: arrayType },
      1 as HirExprId,
      { id: 1 as HirExprId, ast: 0 as any, span: span as any, kind: "expr", exprKind: "literal", literalKind: "void", value: "void" } as any
    );

    const expr = compileIntrinsicCall({
      name: "__type_to_heap_type",
      call: makeCall([1 as HirExprId]),
      args: [ctx.mod.nop()],
      ctx,
      fnCtx,
    });

    const expected = ctx.fixedArrayTypes.get(binaryen.i32)!.heapType;
    expect(expr).toBe(expected);
  });

  it("caches fixed-array heap types per element type", () => {
    const secondArrayType = 3 as TypeId;
    const { ctx, descriptors } = createContext();
    descriptors.set(i32Type, { kind: "primitive", name: "i32" });
    descriptors.set(arrayType, { kind: "fixed-array", element: i32Type });
    descriptors.set(secondArrayType, { kind: "fixed-array", element: i32Type });

    const first = getFixedArrayWasmTypes(arrayType, ctx);
    const second = getFixedArrayWasmTypes(secondArrayType, ctx);

    expect(ctx.fixedArrayTypes.size).toBe(1);
    expect(second).toBe(first);
  });

  it("validates arity", () => {
    const { ctx, fnCtx } = createContext();
    expect(() =>
      compileIntrinsicCall({
        name: "__array_new",
        call: makeCall([]),
        args: [],
        ctx,
        fnCtx,
      })
    ).toThrow(/expected 1 args, received 0/);

    expect(() =>
      compileIntrinsicCall({
        name: "__array_new_fixed",
        call: makeCall([]),
        args: [],
        ctx,
        fnCtx,
      })
    ).toThrow(/codegen missing type information/);

    expect(() =>
      compileIntrinsicCall({
        name: "__array_set",
        call: makeCall([]),
        args: [],
        ctx,
        fnCtx,
      })
    ).toThrow(/expected 3 args, received 0/);

    expect(() =>
      compileIntrinsicCall({
        name: "__array_get",
        call: makeCall([]),
        args: [ctx.mod.nop()],
        ctx,
        fnCtx,
      })
    ).toThrow(/expected 4 args, received 1/);

    expect(() =>
      compileIntrinsicCall({
        name: "__array_copy",
        call: makeCall([]),
        args: [ctx.mod.nop()],
        ctx,
        fnCtx,
      })
    ).toThrow(/expected 5 args, received 1/);
  });

  it("requires boolean literal for signed flag", () => {
    const { ctx, descriptors, exprTypes, expressions, fnCtx } = createContext();
    descriptors.set(i32Type, { kind: "primitive", name: "i32" });
    descriptors.set(arrayType, { kind: "fixed-array", element: i32Type });

    registerExpr(
      { expressions, exprTypes, typeId: arrayType },
      1 as HirExprId,
      { id: 1 as HirExprId, ast: 0 as any, span: span as any, kind: "expr", exprKind: "literal", literalKind: "void", value: "void" } as any
    );
    registerExpr(
      { expressions, exprTypes, typeId: i32Type },
      2 as HirExprId,
      { id: 2 as HirExprId, ast: 0 as any, span: span as any, kind: "expr", exprKind: "literal", literalKind: "i32", value: "0" } as any
    );
    registerExpr(
      { expressions, exprTypes, typeId: i32Type },
      3 as HirExprId,
      { id: 3 as HirExprId, ast: 0 as any, span: span as any, kind: "expr", exprKind: "literal", literalKind: "i32", value: "0" } as any
    );
    expressions.set(4 as HirExprId, {
      id: 4 as HirExprId,
      ast: 0 as any,
      span: span as any,
      kind: "expr",
      exprKind: "literal",
      literalKind: "i32",
      value: "1",
    } as any);
    exprTypes.set(4 as HirExprId, i32Type);

  expect(() =>
    compileIntrinsicCall({
      name: "__array_get",
      call: makeCall([
        1 as HirExprId,
          2 as HirExprId,
          3 as HirExprId,
          4 as HirExprId,
        ]),
        args: [
          ctx.mod.nop(),
          ctx.mod.i32.const(0),
          ctx.mod.i32.const(0),
          ctx.mod.i32.const(0),
        ],
        ctx,
        fnCtx,
      })
    ).toThrow(/argument 4 must be a boolean literal/);
  });

  it("emits signed integer modulo intrinsics", () => {
    const i64Type = 5 as TypeId;
    const { ctx, descriptors, exprTypes, expressions, fnCtx } = createContext();
    descriptors.set(i32Type, { kind: "primitive", name: "i32" });
    descriptors.set(i64Type, { kind: "primitive", name: "i64" });

    registerExpr(
      { expressions, exprTypes, typeId: i32Type },
      1 as HirExprId,
      {
        id: 1 as HirExprId,
        ast: 0 as any,
        span: span as any,
        kind: "expr",
        exprKind: "literal",
        literalKind: "i32",
        value: "10",
      } as any
    );
    registerExpr(
      { expressions, exprTypes, typeId: i32Type },
      2 as HirExprId,
      {
        id: 2 as HirExprId,
        ast: 0 as any,
        span: span as any,
        kind: "expr",
        exprKind: "literal",
        literalKind: "i32",
        value: "3",
      } as any
    );
    registerExpr(
      { expressions, exprTypes, typeId: i64Type },
      3 as HirExprId,
      {
        id: 3 as HirExprId,
        ast: 0 as any,
        span: span as any,
        kind: "expr",
        exprKind: "literal",
        literalKind: "i64",
        value: "10",
      } as any
    );
    registerExpr(
      { expressions, exprTypes, typeId: i64Type },
      4 as HirExprId,
      {
        id: 4 as HirExprId,
        ast: 0 as any,
        span: span as any,
        kind: "expr",
        exprKind: "literal",
        literalKind: "i64",
        value: "3",
      } as any
    );

    fnCtx.returnTypeId = i32Type;
    const i32Expr = compileIntrinsicCall({
      name: "%",
      call: makeCall([1 as HirExprId, 2 as HirExprId]),
      args: [ctx.mod.i32.const(10), ctx.mod.i32.const(3)],
      ctx,
      fnCtx,
    });
    const i32Info = binaryen.getExpressionInfo(i32Expr) as binaryen.BinaryInfo;
    expect(i32Info.id).toBe(binaryen.ExpressionIds.Binary);
    expect(i32Info.op).toBe(binaryen.Operations.RemSInt32);

    fnCtx.returnTypeId = i64Type;
    const i64Expr = compileIntrinsicCall({
      name: "%",
      call: makeCall([3 as HirExprId, 4 as HirExprId]),
      args: [ctx.mod.i64.const(10, 0), ctx.mod.i64.const(3, 0)],
      ctx,
      fnCtx,
    });
    const i64Info = binaryen.getExpressionInfo(i64Expr) as binaryen.BinaryInfo;
    expect(i64Info.id).toBe(binaryen.ExpressionIds.Binary);
    expect(i64Info.op).toBe(binaryen.Operations.RemSInt64);
  });

  it("emits boolean logic intrinsics", () => {
    const boolType = 4 as TypeId;
    const { ctx, descriptors, exprTypes, expressions, fnCtx } = createContext();
    descriptors.set(boolType, { kind: "primitive", name: "bool" });

    registerExpr(
      { expressions, exprTypes, typeId: boolType },
      1 as HirExprId,
      {
        id: 1 as HirExprId,
        ast: 0 as any,
        span: span as any,
        kind: "expr",
        exprKind: "literal",
        literalKind: "boolean",
        value: "true",
      } as any
    );
    registerExpr(
      { expressions, exprTypes, typeId: boolType },
      2 as HirExprId,
      {
        id: 2 as HirExprId,
        ast: 0 as any,
        span: span as any,
        kind: "expr",
        exprKind: "literal",
        literalKind: "boolean",
        value: "false",
      } as any
    );
    registerExpr(
      { expressions, exprTypes, typeId: boolType },
      3 as HirExprId,
      {
        id: 3 as HirExprId,
        ast: 0 as any,
        span: span as any,
        kind: "expr",
        exprKind: "literal",
        literalKind: "boolean",
        value: "true",
      } as any
    );

    fnCtx.returnTypeId = boolType;

    const andExpr = compileIntrinsicCall({
      name: "and",
      call: makeCall([1 as HirExprId, 2 as HirExprId]),
      args: [ctx.mod.i32.const(1), ctx.mod.i32.const(0)],
      ctx,
      fnCtx,
    });
    const andInfo = binaryen.getExpressionInfo(andExpr) as binaryen.BinaryInfo;
    expect(andInfo.id).toBe(binaryen.ExpressionIds.Binary);
    expect(andInfo.op).toBe(binaryen.Operations.AndInt32);

    const orExpr = compileIntrinsicCall({
      name: "or",
      call: makeCall([1 as HirExprId, 2 as HirExprId]),
      args: [ctx.mod.i32.const(1), ctx.mod.i32.const(0)],
      ctx,
      fnCtx,
    });
    const orInfo = binaryen.getExpressionInfo(orExpr) as binaryen.BinaryInfo;
    expect(orInfo.id).toBe(binaryen.ExpressionIds.Binary);
    expect(orInfo.op).toBe(binaryen.Operations.OrInt32);

    const xorExpr = compileIntrinsicCall({
      name: "xor",
      call: makeCall([1 as HirExprId, 2 as HirExprId]),
      args: [ctx.mod.i32.const(1), ctx.mod.i32.const(0)],
      ctx,
      fnCtx,
    });
    const xorInfo = binaryen.getExpressionInfo(xorExpr) as binaryen.BinaryInfo;
    expect(xorInfo.id).toBe(binaryen.ExpressionIds.Binary);
    expect(xorInfo.op).toBe(binaryen.Operations.XorInt32);

    const notExpr = compileIntrinsicCall({
      name: "not",
      call: makeCall([3 as HirExprId]),
      args: [ctx.mod.i32.const(1)],
      ctx,
      fnCtx,
    });
    const notInfo = binaryen.getExpressionInfo(notExpr) as binaryen.UnaryInfo;
    expect(notInfo.id).toBe(binaryen.ExpressionIds.Unary);
    expect(notInfo.op).toBe(binaryen.Operations.EqZInt32);
  });

  it("emits unary float math intrinsics", () => {
    const f32Type = 6 as TypeId;
    const f64Type = 7 as TypeId;
    const { ctx, descriptors, exprTypes, expressions, fnCtx } = createContext();
    descriptors.set(f32Type, { kind: "primitive", name: "f32" });
    descriptors.set(f64Type, { kind: "primitive", name: "f64" });

    registerExpr(
      { expressions, exprTypes, typeId: f32Type },
      1 as HirExprId,
      {
        id: 1 as HirExprId,
        ast: 0 as any,
        span: span as any,
        kind: "expr",
        exprKind: "literal",
        literalKind: "float",
        value: "1.5",
      } as any
    );
    registerExpr(
      { expressions, exprTypes, typeId: f64Type },
      2 as HirExprId,
      {
        id: 2 as HirExprId,
        ast: 0 as any,
        span: span as any,
        kind: "expr",
        exprKind: "literal",
        literalKind: "float",
        value: "2.5",
      } as any
    );

    fnCtx.returnTypeId = f32Type;
    expectUnaryOp(
      compileIntrinsicCall({
        name: "__floor",
        call: makeCall([1 as HirExprId]),
        args: [ctx.mod.f32.const(1.5)],
        ctx,
        fnCtx,
      }),
      binaryen.Operations.FloorFloat32
    );
    expectUnaryOp(
      compileIntrinsicCall({
        name: "__ceil",
        call: makeCall([1 as HirExprId]),
        args: [ctx.mod.f32.const(1.5)],
        ctx,
        fnCtx,
      }),
      binaryen.Operations.CeilFloat32
    );
    expectUnaryOp(
      compileIntrinsicCall({
        name: "__round",
        call: makeCall([1 as HirExprId]),
        args: [ctx.mod.f32.const(1.5)],
        ctx,
        fnCtx,
      }),
      binaryen.Operations.NearestFloat32
    );
    expectUnaryOp(
      compileIntrinsicCall({
        name: "__trunc",
        call: makeCall([1 as HirExprId]),
        args: [ctx.mod.f32.const(1.5)],
        ctx,
        fnCtx,
      }),
      binaryen.Operations.TruncFloat32
    );
    expectUnaryOp(
      compileIntrinsicCall({
        name: "__sqrt",
        call: makeCall([1 as HirExprId]),
        args: [ctx.mod.f32.const(1.5)],
        ctx,
        fnCtx,
      }),
      binaryen.Operations.SqrtFloat32
    );

    fnCtx.returnTypeId = f64Type;
    expectUnaryOp(
      compileIntrinsicCall({
        name: "__floor",
        call: makeCall([2 as HirExprId]),
        args: [ctx.mod.f64.const(2.5)],
        ctx,
        fnCtx,
      }),
      binaryen.Operations.FloorFloat64
    );
    expectUnaryOp(
      compileIntrinsicCall({
        name: "__ceil",
        call: makeCall([2 as HirExprId]),
        args: [ctx.mod.f64.const(2.5)],
        ctx,
        fnCtx,
      }),
      binaryen.Operations.CeilFloat64
    );
    expectUnaryOp(
      compileIntrinsicCall({
        name: "__round",
        call: makeCall([2 as HirExprId]),
        args: [ctx.mod.f64.const(2.5)],
        ctx,
        fnCtx,
      }),
      binaryen.Operations.NearestFloat64
    );
    expectUnaryOp(
      compileIntrinsicCall({
        name: "__trunc",
        call: makeCall([2 as HirExprId]),
        args: [ctx.mod.f64.const(2.5)],
        ctx,
        fnCtx,
      }),
      binaryen.Operations.TruncFloat64
    );
    expectUnaryOp(
      compileIntrinsicCall({
        name: "__sqrt",
        call: makeCall([2 as HirExprId]),
        args: [ctx.mod.f64.const(2.5)],
        ctx,
        fnCtx,
      }),
      binaryen.Operations.SqrtFloat64
    );
  });
});
