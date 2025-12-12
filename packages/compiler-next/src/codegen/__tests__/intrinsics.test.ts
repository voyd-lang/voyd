import { describe, expect, it } from "vitest";
import binaryen from "binaryen";
import { compileIntrinsicCall } from "../intrinsics.js";
import {
  defineArrayType,
  binaryenTypeFromHeapType,
  modBinaryenTypeToHeapType,
} from "@voyd/lib/binaryen-gc/index.js";
import { getFixedArrayWasmTypes } from "../types.js";
import { createEffectRuntime } from "../effects/runtime-abi.js";
import type {
  CodegenContext,
  HirCallExpr,
  HirExpression,
  HirExprId,
  TypeId,
} from "../context.js";

type TypeDescriptor =
  | { kind: "primitive"; name: string }
  | { kind: "fixed-array"; element: TypeId };

const span = { start: 0, end: 0 } as const;

const createContext = () => {
  const mod = new binaryen.Module();
  mod.setFeatures(binaryen.Features.All);
  const effectsRuntime = createEffectRuntime(mod);

  const descriptors = new Map<TypeId, TypeDescriptor>();
  const exprTypes = new Map<HirExprId, TypeId>();
  const expressions = new Map<HirExprId, HirExpression>();
  const fnCtx = {
    bindings: new Map(),
    locals: [],
    nextLocalIndex: 0,
    returnTypeId: 0 as TypeId,
    effectful: false,
  };

  const ctx: CodegenContext = {
    mod,
    moduleId: "test",
    moduleLabel: "test",
    binding: {} as any,
    symbolTable: {} as any,
    hir: { expressions } as any,
    typing: {
      arena: {
        get: (id: number) => {
          const desc = descriptors.get(id);
          if (!desc) {
            throw new Error(`missing descriptor for type ${id}`);
          }
          return desc as any;
        },
      },
      resolvedExprTypes: exprTypes,
      callTargets: new Map(),
      callInstanceKeys: new Map(),
      callTraitDispatches: new Set(),
      valueTypes: new Map(),
      intrinsicTypes: new Map(),
      intrinsicSymbols: new Map(),
      table: { getExprType: (id: number) => exprTypes.get(id) } as any,
      primitives: { unknown: -1 } as any,
    } as any,
    options: {
      optimize: false,
      validate: false,
      emitEffectHelpers: false,
    },
    functions: new Map(),
    functionInstances: new Map(),
    itemsToSymbols: new Map(),
    structTypes: new Map(),
    fixedArrayTypes: new Map(),
    closureTypes: new Map(),
    closureFunctionTypes: new Map(),
    lambdaEnvs: new Map(),
    lambdaFunctions: new Map(),
    rtt: { baseType: binaryen.none, extensionHelpers: { i32Array: binaryen.i32 } } as any,
    effectsRuntime,
    effectMir: {
      functions: new Map(),
      operations: new Map(),
      handlers: new Map(),
      calls: new Map(),
      handlerTails: new Map(),
      semantics: {} as any,
      stackSwitching: false,
    },
    effectLowering: {
      sitesByExpr: new Map(),
      sites: [],
      argsTypes: new Map(),
    },
    outcomeValueTypes: new Map(),
  };

  return { ctx, descriptors, exprTypes, expressions, fnCtx };
};

const cacheArrayType = (
  ctx: CodegenContext,
  element: TypeId,
  type: binaryen.Type
): void => {
  ctx.fixedArrayTypes.set(element, {
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
    cacheArrayType(ctx, i32Type, cachedArrayType);

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
    cacheArrayType(ctx, i32Type, cachedArrayType);

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
    cacheArrayType(ctx, i32Type, cachedArrayType);

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
    const { ctx, fnCtx } = createContext();
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
    cacheArrayType(ctx, i32Type, cachedArrayType);

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

    const expected = ctx.fixedArrayTypes.get(i32Type)!.heapType;
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
});
