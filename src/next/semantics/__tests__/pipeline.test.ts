import { describe, expect, it } from "vitest";
import {
  type HirBlockExpr,
  type HirCallExpr,
  type HirFunction,
  type HirIfExpr,
  type HirNamedTypeExpr,
} from "../hir/nodes.js";
import { semanticsPipeline } from "../pipeline.js";
import type { SymbolId, TypeId } from "../ids.js";
import type { TypingResult } from "../typing/pipeline.js";
import { loadAst } from "./load-ast.js";

const expectPrimitiveType = (
  typing: TypingResult,
  typeId: TypeId | undefined,
  name: string
): void => {
  expect(typeId).toBeDefined();
  expect(typing.arena.get(typeId!)).toMatchObject({
    kind: "primitive",
    name,
  });
};

const expectFunctionReturnPrimitive = (
  typing: TypingResult,
  symbol: SymbolId,
  name: string
): void => {
  const scheme = typing.table.getSymbolScheme(symbol);
  expect(scheme).toBeDefined();
  const fnType = typing.arena.instantiate(scheme!, []);
  const fnDesc = typing.arena.get(fnType);
  expect(fnDesc.kind).toBe("function");
  if (fnDesc.kind !== "function") {
    throw new Error("expected function type");
  }
  expectPrimitiveType(typing, fnDesc.returnType, name);
};

describe("semanticsPipeline", () => {
  it("binds and lowers the fib sample module", () => {
    const name = "fib.voyd";
    const ast = loadAst(name);
    const result = semanticsPipeline(ast);

    const { symbolTable, hir, typing } = result;
    expect(hir.module.path).toBe(name);
    expect(hir.module.items).toHaveLength(2);

    const rootScope = symbolTable.rootScope;
    const fibSymbol = symbolTable.resolve("fib", rootScope);
    const mainSymbol = symbolTable.resolve("main", rootScope);
    expect(fibSymbol).toBeDefined();
    expect(mainSymbol).toBeDefined();

    const fibId = fibSymbol!;
    const mainId = mainSymbol!;

    expect(symbolTable.getSymbol(fibId).kind).toBe("value");
    expect(symbolTable.getSymbol(mainId).kind).toBe("value");

    const fibFn = Array.from(hir.items.values()).find(
      (item): item is HirFunction =>
        item.kind === "function" && item.symbol === fibId
    );
    expect(fibFn).toBeDefined();
    expect(fibFn?.parameters).toHaveLength(1);

    const fibParam = fibFn!.parameters[0];
    expect(fibParam.type?.typeKind).toBe("named");
    expect((fibParam.type as HirNamedTypeExpr).path).toEqual(["i32"]);
    expect((fibFn!.returnType as HirNamedTypeExpr).path).toEqual(["i32"]);
    expect(symbolTable.getSymbol(fibParam.symbol).kind).toBe("parameter");

    const fibBlock = hir.expressions.get(fibFn!.body)!;
    expect(fibBlock.exprKind).toBe("block");
    const fibIf = hir.expressions.get((fibBlock as HirBlockExpr).value!)!;
    expect(fibIf.exprKind).toBe("if");
    const ifNode = fibIf as HirIfExpr;
    expect(ifNode.branches).toHaveLength(1);
    expect(ifNode.branches[0]?.condition).toBeDefined();
    expect(ifNode.branches[0]?.value).toBeDefined();
    expect(ifNode.defaultBranch).toBeDefined();
    const ifConditionType = typing.table.getExprType(
      ifNode.branches[0]!.condition
    );
    expect(ifConditionType).toBeDefined();
    expect(typing.arena.get(ifConditionType!)).toMatchObject({
      kind: "primitive",
      name: "bool",
    });
    const ifValueType = typing.table.getExprType(ifNode.id);
    expect(ifValueType).toBeDefined();
    expect(typing.arena.get(ifValueType!)).toMatchObject({
      kind: "primitive",
      name: "i32",
    });

    const mainFn = Array.from(hir.items.values()).find(
      (item): item is HirFunction =>
        item.kind === "function" && item.symbol === mainId
    );
    expect(mainFn).toBeDefined();
    expect(mainFn?.visibility).toBe("public");
    expect(hir.module.exports.map((entry) => entry.symbol)).toContain(mainId);

    const mainBlock = hir.expressions.get(mainFn!.body)!;
    expect(mainBlock.exprKind).toBe("block");
    const callExpr = hir.expressions.get((mainBlock as HirBlockExpr).value!)!;
    expect(callExpr.exprKind).toBe("call");
    const callExprType = typing.table.getExprType(callExpr.id);
    expect(callExprType).toBeDefined();
    expect(typing.arena.get(callExprType!)).toMatchObject({
      kind: "primitive",
      name: "i32",
    });
    const blockType = typing.table.getExprType(mainBlock.id);
    expect(blockType).toBe(callExprType);

    const fibScheme = typing.table.getSymbolScheme(fibId);
    expect(fibScheme).toBeDefined();
    const fibFnType = typing.arena.instantiate(fibScheme!, []);
    const fibFnDesc = typing.arena.get(fibFnType);
    expect(fibFnDesc.kind).toBe("function");
    if (fibFnDesc.kind !== "function") {
      throw new Error("expected fib scheme to produce a function type");
    }
    expect(fibFnDesc.parameters).toHaveLength(1);
    const fibParamType = typing.arena.get(fibFnDesc.parameters[0]!.type);
    expect(fibParamType).toMatchObject({
      kind: "primitive",
      name: "i32",
    });
    expect(typing.arena.get(fibFnDesc.returnType)).toMatchObject({
      kind: "primitive",
      name: "i32",
    });
  });

  it("infers return types for forward references", () => {
    const ast = loadAst("forward_inference.voyd");
    const result = semanticsPipeline(ast);
    const { symbolTable, hir, typing } = result;
    const rootScope = symbolTable.rootScope;
    const mainSymbol = symbolTable.resolve("main", rootScope);
    const helperSymbol = symbolTable.resolve("helper", rootScope);
    expect(mainSymbol).toBeDefined();
    expect(helperSymbol).toBeDefined();

    const mainFn = Array.from(hir.items.values()).find(
      (item): item is HirFunction =>
        item.kind === "function" && item.symbol === mainSymbol
    );
    expect(mainFn).toBeDefined();

    const mainBlock = hir.expressions.get(mainFn!.body);
    expect(mainBlock?.exprKind).toBe("block");
    const callExprId = (mainBlock as HirBlockExpr).value;
    expect(callExprId).toBeDefined();
    const callType = typing.table.getExprType(callExprId!);
    expectPrimitiveType(typing, callType, "i32");

    expectFunctionReturnPrimitive(typing, mainSymbol!, "i32");
    expectFunctionReturnPrimitive(typing, helperSymbol!, "i32");
  });

  it("infers return types for recursive functions", () => {
    const ast = loadAst("recursive_inference.voyd");
    const result = semanticsPipeline(ast);
    const { symbolTable, hir, typing } = result;
    const rootScope = symbolTable.rootScope;
    const factSymbol = symbolTable.resolve("fact", rootScope);
    const mainSymbol = symbolTable.resolve("main", rootScope);
    expect(factSymbol).toBeDefined();
    expect(mainSymbol).toBeDefined();

    const recursiveCall = Array.from(hir.expressions.values()).find(
      (expr): expr is HirCallExpr => {
        if (expr.exprKind !== "call") {
          return false;
        }
        const callee = hir.expressions.get(expr.callee);
        return callee?.exprKind === "identifier" && callee.symbol === factSymbol;
      }
    );
    expect(recursiveCall).toBeDefined();
    const recursiveCallType = typing.table.getExprType(recursiveCall!.id);
    expectPrimitiveType(typing, recursiveCallType, "i32");

    expectFunctionReturnPrimitive(typing, factSymbol!, "i32");
    expectFunctionReturnPrimitive(typing, mainSymbol!, "i32");
  });

  it("binds and lowers the fib sample module", () => {
    const ast = loadAst("fib.voyd");
    const result = semanticsPipeline(ast);
    expect(result.hir).toMatchSnapshot();
    expect(result.symbolTable.snapshot()).toMatchSnapshot();
  });

  it("resolves overloaded functions based on argument types", () => {
    const ast = loadAst("function_overloads.voyd");
    const result = semanticsPipeline(ast);
    const { symbolTable, hir, typing } = result;
    const rootScope = symbolTable.rootScope;

    const addSymbols = symbolTable.resolveAll("add", rootScope);
    expect(addSymbols).toHaveLength(2);

    const resolveFunction = (name: string): SymbolId => {
      const symbol = symbolTable.resolve(name, rootScope);
      expect(symbol).toBeDefined();
      return symbol!;
    };

    const callIntSymbol = resolveFunction("call_int");
    const callFloatSymbol = resolveFunction("call_float");

    const getFunctionItem = (symbol: SymbolId): HirFunction => {
      const fn = Array.from(hir.items.values()).find(
        (item): item is HirFunction =>
          item.kind === "function" && item.symbol === symbol
      );
      if (!fn) {
        throw new Error(`missing function item for symbol ${symbol}`);
      }
      return fn;
    };

    const getAddSymbolFor = (expectedParamType: string): SymbolId => {
      for (const symbol of addSymbols) {
        const scheme = typing.table.getSymbolScheme(symbol);
        expect(scheme).toBeDefined();
        const instantiated = typing.arena.instantiate(scheme!, []);
        const descriptor = typing.arena.get(instantiated);
        if (descriptor.kind !== "function") {
          continue;
        }
        const firstParam = descriptor.parameters[0];
        if (!firstParam) {
          continue;
        }
        const paramDesc = typing.arena.get(firstParam.type);
        if (paramDesc.kind === "primitive" && paramDesc.name === expectedParamType) {
          return symbol;
        }
      }
      throw new Error(`missing add overload for ${expectedParamType}`);
    };

    const intAddSymbol = getAddSymbolFor("i32");
    const floatAddSymbol = getAddSymbolFor("f64");

    const expectCallResolution = (
      fnSymbol: SymbolId,
      expectedTarget: SymbolId,
      expectedType: string
    ) => {
      const fn = getFunctionItem(fnSymbol);
      const block = hir.expressions.get(fn.body);
      expect(block?.exprKind).toBe("block");
      const callExprId = (block as HirBlockExpr).value;
      expect(callExprId).toBeDefined();
      const callExpr = hir.expressions.get(callExprId!);
      expect(callExpr?.exprKind).toBe("call");
      expect(typing.callTargets.get(callExpr!.id)).toBe(expectedTarget);
      const callType = typing.table.getExprType(callExpr!.id);
      expectPrimitiveType(typing, callType, expectedType);
    };

    expectCallResolution(callIntSymbol, intAddSymbol, "i32");
    expectCallResolution(callFloatSymbol, floatAddSymbol, "f64");
  });
});
