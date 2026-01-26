import { describe, expect, it } from "vitest";
import {
  type HirBlockExpr,
  type HirCallExpr,
  type HirFunction,
  type HirIdentifierExpr,
  type HirIfExpr,
  type HirNamedTypeExpr,
  type HirLetStatement,
  type HirPattern,
} from "../hir/nodes.js";
import { semanticsPipeline } from "../pipeline.js";
import type { SymbolId, TypeId } from "../ids.js";
import type { TypingResult } from "../typing/typing.js";
import { loadAst } from "./load-ast.js";
import { SymbolTable } from "../binder/index.js";
import { runBindingPipeline, type BindingResult } from "../binding/binding.js";
import type { ModuleGraph, ModuleNode } from "../../modules/types.js";
import { modulePathToString } from "../../modules/path.js";
import { toSourceSpan } from "../utils.js";
import { isForm } from "../../parser/index.js";
import { getSymbolTable } from "../_internal/symbol-table.js";

type SemanticsResult = ReturnType<typeof semanticsPipeline>;

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

const stripPatternSpan = (pattern?: HirPattern): void => {
  if (!pattern) return;
  delete (pattern as { span?: unknown }).span;
  switch (pattern.kind) {
    case "destructure":
      pattern.fields.forEach((field) => stripPatternSpan(field.pattern));
      stripPatternSpan(pattern.spread);
      return;
    case "tuple":
      pattern.elements.forEach(stripPatternSpan);
      return;
    case "type":
      stripPatternSpan(pattern.binding);
      return;
    default:
      return;
  }
};

const stripPatternSpansFromHir = (hir: ReturnType<typeof semanticsPipeline>["hir"]) => {
  hir.items.forEach((item) => {
    if (item.kind === "function") {
      item.parameters.forEach((param) => stripPatternSpan(param.pattern));
    }
  });
  hir.statements.forEach((stmt) => {
    if (stmt.kind === "let") {
      stripPatternSpan(stmt.pattern);
    }
  });
  hir.expressions.forEach((expr) => {
    if (expr.exprKind === "match") {
      expr.arms.forEach((arm) => stripPatternSpan(arm.pattern));
    }
    if (expr.exprKind === "assign" && expr.pattern) {
      stripPatternSpan(expr.pattern);
    }
    if (expr.exprKind === "lambda") {
      expr.parameters.forEach((param) => stripPatternSpan(param.pattern));
    }
  });
  return hir;
};

const buildModule = ({
  fixture,
  segments,
  ast,
  dependencies = [],
}: {
  fixture: string;
  segments: readonly string[];
  ast?: ReturnType<typeof loadAst>;
  dependencies?: ModuleNode["dependencies"];
}): { module: ModuleNode; graph: ModuleGraph } => {
  const parsedAst = ast ?? loadAst(fixture);
  const path = { namespace: "src" as const, segments };
  const id = modulePathToString(path);
  const module: ModuleNode = {
    id,
    path,
    origin: { kind: "file", filePath: fixture },
    ast: parsedAst,
    source: "",
    dependencies,
  };
  const graph: ModuleGraph = {
    entry: id,
    modules: new Map([[id, module]]),
    diagnostics: [],
  };
  return { module, graph };
};

const expectAnimalConstructorBindings = (
  semantics: SemanticsResult
): void => {
  const symbolTable = getSymbolTable(semantics);
  let animalSymbol = symbolTable.resolve("Animal", symbolTable.rootScope);
  if (typeof animalSymbol !== "number") {
    const moduleSymbol = symbolTable.resolve("animal", symbolTable.rootScope);
    const moduleMember = semantics.binding.moduleMembers
      .get(typeof moduleSymbol === "number" ? moduleSymbol : -1)
      ?.get("Animal");
    const resolvedMember =
      moduleMember && moduleMember.size > 0
        ? moduleMember.values().next().value
        : undefined;
    animalSymbol =
      typeof resolvedMember === "number" ? resolvedMember : animalSymbol;
  }
  expect(typeof animalSymbol).toBe("number");
  if (typeof animalSymbol !== "number") return;

  const constructors =
    semantics.binding.staticMethods.get(animalSymbol)?.get("init");
  expect(constructors?.size).toBe(3);
  const constructorOverloadIds = new Set(
    Array.from(constructors ?? []).map((symbol) =>
      semantics.binding.overloadBySymbol.get(symbol)
    )
  );
  expect(constructorOverloadIds.size).toBe(1);

  const mainFn = Array.from(semantics.hir.items.values()).find(
    (item): item is HirFunction =>
      item.kind === "function" &&
      symbolTable.getSymbol(item.symbol).name === "main"
  );
  expect(mainFn).toBeDefined();
  if (!mainFn) return;

  const mainBlock = semantics.hir.expressions.get(
    mainFn.body
  ) as HirBlockExpr | undefined;
  expect(mainBlock?.exprKind).toBe("block");
  if (!mainBlock) return;

  const letStatements = mainBlock.statements
    .map((stmtId) => semantics.hir.statements.get(stmtId))
    .filter(
      (stmt): stmt is HirLetStatement =>
        stmt !== undefined && stmt.kind === "let"
    );
  expect(letStatements).toHaveLength(3);

  letStatements.forEach((stmt) => {
    const initializer = semantics.hir.expressions.get(stmt.initializer);
    expect(initializer?.exprKind).toBe("call");
    const call = initializer as HirCallExpr;
    const callee = semantics.hir.expressions.get(call.callee);
    if (callee?.exprKind === "overload-set") {
      expect(constructorOverloadIds.has(callee.set)).toBe(true);
      return;
    }
    expect(callee?.exprKind).toBe("identifier");
    if (callee?.exprKind === "identifier") {
      expect(constructors?.has(callee.symbol)).toBe(true);
    }
  });
};

describe("semanticsPipeline", () => {
 it("binds and lowers the fib sample module", () => {
    const name = "fib.voyd";
    const ast = loadAst(name);
    const result = semanticsPipeline(ast);

    const { hir, typing } = result;
    const symbolTable = getSymbolTable(result);
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
    expect(mainFn?.visibility.level).toBe("package");
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
    const { hir, typing } = result;
    const symbolTable = getSymbolTable(result);
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
    const { hir, typing } = result;
    const symbolTable = getSymbolTable(result);
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
        return (
          callee?.exprKind === "identifier" && callee.symbol === factSymbol
        );
      }
    );
    expect(recursiveCall).toBeDefined();
    const recursiveCallType = typing.table.getExprType(recursiveCall!.id);
    expectPrimitiveType(typing, recursiveCallType, "i32");

    expectFunctionReturnPrimitive(typing, factSymbol!, "i32");
    expectFunctionReturnPrimitive(typing, mainSymbol!, "i32");
  });

  it("types impl methods and their calls", () => {
    const name = "impl_methods.voyd";
    const ast = loadAst(name);
    const result = semanticsPipeline(ast);

    const { hir, typing } = result;
    const symbolTable = getSymbolTable(result);
    const rootScope = symbolTable.rootScope;
    const mainSymbol = symbolTable.resolve("main", rootScope)!;
    const doubleSymbol = symbolTable.resolve("double", rootScope)!;

    expectFunctionReturnPrimitive(typing, mainSymbol, "i32");
    const doubleSignature = typing.functions.getSignature(doubleSymbol);
    expect(doubleSignature).toBeDefined();
    expect(doubleSignature?.parameters[0]?.type).toBeDefined();

    const implItem = Array.from(hir.items.values()).find(
      (item) => item.kind === "impl"
    );
    expect(implItem).toBeDefined();
    if (implItem?.kind === "impl") {
      expect(implItem.target.typeId).toBeDefined();
      const targetType = implItem.target.typeId!;
      const targetDesc = typing.arena.get(targetType);
      const nominalDesc =
        targetDesc.kind === "nominal-object"
          ? targetDesc
          : targetDesc.kind === "intersection" &&
            typeof targetDesc.nominal === "number"
          ? typing.arena.get(targetDesc.nominal)
          : undefined;
      expect(nominalDesc?.kind).toBe("nominal-object");
    }
  });

  it("infers tuple destructuring from forward-declared functions", () => {
    const ast = loadAst("tuples.voyd");
    const result = semanticsPipeline(ast);
    const { typing } = result;
    const symbolTable = getSymbolTable(result);
    const rootScope = symbolTable.rootScope;

    const buildPair = symbolTable.resolve("build_pair", rootScope);
    const consumeForward = symbolTable.resolve("consume_forward", rootScope);
    const combine = symbolTable.resolve("combine", rootScope);
    const main = symbolTable.resolve("main", rootScope);
    expect(buildPair).toBeDefined();
    expect(consumeForward).toBeDefined();
    expect(combine).toBeDefined();
    expect(main).toBeDefined();

    const buildPairScheme = typing.table.getSymbolScheme(buildPair!);
    expect(buildPairScheme).toBeDefined();
    const buildPairType = typing.arena.instantiate(buildPairScheme!, []);
    const buildPairDesc = typing.arena.get(buildPairType);
    expect(buildPairDesc.kind).toBe("function");
    if (buildPairDesc.kind !== "function") {
      throw new Error("expected build_pair to have a function type");
    }
    const tupleDesc = typing.arena.get(buildPairDesc.returnType);
    expect(tupleDesc.kind).toBe("structural-object");
    if (tupleDesc.kind !== "structural-object") {
      throw new Error("expected build_pair to return a structural tuple");
    }
    expect(tupleDesc.fields).toHaveLength(2);
    expectPrimitiveType(typing, tupleDesc.fields[0]?.type, "i32");
    expectPrimitiveType(typing, tupleDesc.fields[1]?.type, "i32");

    expectFunctionReturnPrimitive(typing, consumeForward!, "i32");
    expectFunctionReturnPrimitive(typing, combine!, "i32");
    expectFunctionReturnPrimitive(typing, main!, "i32");
  });

  it("binds and lowers the fib sample module", () => {
    const ast = loadAst("fib.voyd");
    const result = semanticsPipeline(ast);
    const sanitizedHir = stripPatternSpansFromHir(structuredClone(result.hir));
    expect(sanitizedHir).toMatchSnapshot();
    expect(getSymbolTable(result).snapshot()).toMatchSnapshot();
  });

  it("resolves overloaded functions based on argument types", () => {
    const ast = loadAst("function_overloads.voyd");
    const result = semanticsPipeline(ast);
    const { hir, typing } = result;
    const symbolTable = getSymbolTable(result);
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
        if (
          paramDesc.kind === "primitive" &&
          paramDesc.name === expectedParamType
        ) {
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
      const instanceKey = `${fnSymbol}<>`;
      const fn = getFunctionItem(fnSymbol);
      const block = hir.expressions.get(fn.body);
      expect(block?.exprKind).toBe("block");
      const callExprId = (block as HirBlockExpr).value;
      expect(callExprId).toBeDefined();
      const callExpr = hir.expressions.get(callExprId!);
      expect(callExpr?.exprKind).toBe("call");
      expect(typing.callTargets.get(callExpr!.id)?.get(instanceKey)).toEqual({
        moduleId: result.moduleId,
        symbol: expectedTarget,
      });
      const callee = hir.expressions.get((callExpr as HirCallExpr)!.callee);
      expect(callee?.exprKind).toBe("identifier");
      expect((callee as HirIdentifierExpr).symbol).toBe(expectedTarget);
      const callType = typing.table.getExprType(callExpr!.id);
      expectPrimitiveType(typing, callType, expectedType);
    };

    expectCallResolution(callIntSymbol, intAddSymbol, "i32");
    expectCallResolution(callFloatSymbol, floatAddSymbol, "f64");
  });

  it("tracks overload resolution separately for generic instantiations", () => {
    const ast = loadAst("generic_overload_resolution.voyd");
    const semantics = semanticsPipeline(ast);
    const { hir, typing } = semantics;
    const symbolTable = getSymbolTable(semantics);
    const rootScope = symbolTable.rootScope;

    const chooseSymbol = symbolTable.resolve("choose", rootScope);
    const callIntSymbol = symbolTable.resolve("call_int", rootScope);
    const callFloatSymbol = symbolTable.resolve("call_float", rootScope);
    expect(chooseSymbol).toBeDefined();
    expect(callIntSymbol).toBeDefined();
    expect(callFloatSymbol).toBeDefined();

    const overloadFns = Array.from(hir.items.values()).filter(
      (item): item is HirFunction =>
        item.kind === "function" &&
        symbolTable.getSymbol(item.symbol).name === "overloaded"
    );
    const resolveOverload = (primitiveName: string): SymbolId => {
      const match = overloadFns.find((fn) => {
        const param = fn.parameters[0];
        if (!param?.type || param.type.typeKind !== "named") {
          return false;
        }
        return param.type.path[0] === primitiveName;
      });
      if (!match) {
        throw new Error(`missing overloaded function for ${primitiveName}`);
      }
      return match.symbol;
    };

    const intOverload = resolveOverload("i32");
    const floatOverload = resolveOverload("f64");

    const chooseFn = Array.from(hir.items.values()).find(
      (item): item is HirFunction =>
        item.kind === "function" && item.symbol === chooseSymbol
    );
    expect(chooseFn).toBeDefined();
    const body = hir.expressions.get(chooseFn!.body);
    expect(body?.exprKind).toBe("block");
    const callExprId = (body as HirBlockExpr).value;
    expect(callExprId).toBeDefined();
    const callExpr = callExprId ? hir.expressions.get(callExprId) : undefined;
    expect(callExpr?.exprKind).toBe("call");
    const callee = callExpr
      ? hir.expressions.get((callExpr as HirCallExpr).callee)
      : undefined;
    expect(callee?.exprKind).toBe("overload-set");

    const targets = typing.callTargets.get(callExprId!);
    const intKey = `${chooseSymbol}<${typing.arena.internPrimitive("i32")}>`;
    const floatKey = `${chooseSymbol}<${typing.arena.internPrimitive("f64")}>`;
    expect(targets?.get(intKey)).toEqual({
      moduleId: semantics.moduleId,
      symbol: intOverload,
    });
    expect(targets?.get(floatKey)).toEqual({
      moduleId: semantics.moduleId,
      symbol: floatOverload,
    });
  });

  it("lowers nominal constructor overloads across modules", () => {
    const animalFixture = "nominal_constructors_cross_module/animal.voyd";
    const mainFixture = "nominal_constructors_cross_module/main.voyd";
    const animal = buildModule({
      fixture: animalFixture,
      segments: ["animal"],
    });
    const animalSemantics = semanticsPipeline({
      module: animal.module,
      graph: animal.graph,
    });

    const mainAst = loadAst(mainFixture);
    const useForm = mainAst.rest.find(
      (entry) => isForm(entry) && entry.calls("use")
    );
    const dependency = {
      kind: "use" as const,
      path: animal.module.path,
      span: toSourceSpan(useForm ?? mainAst),
    };
    const main = buildModule({
      fixture: mainFixture,
      ast: mainAst,
      segments: ["main"],
      dependencies: [dependency],
    });

    const mainSemantics = semanticsPipeline({
      module: main.module,
      graph: main.graph,
      exports: new Map([[animal.module.id, animalSemantics.exports]]),
      dependencies: new Map([[animal.module.id, animalSemantics]]),
    });

    expectAnimalConstructorBindings(mainSemantics);
  });

  it("binds constructor overloads through module namespaces", () => {
    const animalFixture = "nominal_constructors_namespace/animal.voyd";
    const mainFixture = "nominal_constructors_namespace/main.voyd";
    const animal = buildModule({
      fixture: animalFixture,
      segments: ["animal"],
    });
    const animalSemantics = semanticsPipeline({
      module: animal.module,
      graph: animal.graph,
    });

    const mainAst = loadAst(mainFixture);
    const useForm = mainAst.rest.find(
      (entry) => isForm(entry) && entry.calls("use")
    );
    const dependency = {
      kind: "use" as const,
      path: animal.module.path,
      span: toSourceSpan(useForm ?? mainAst),
    };
    const main = buildModule({
      fixture: mainFixture,
      ast: mainAst,
      segments: ["main"],
      dependencies: [dependency],
    });

    const mainSemantics = semanticsPipeline({
      module: main.module,
      graph: main.graph,
      exports: new Map([[animal.module.id, animalSemantics.exports]]),
      dependencies: new Map([[animal.module.id, animalSemantics]]),
    });

    expect(mainSemantics.diagnostics).toHaveLength(0);
    expectAnimalConstructorBindings(mainSemantics);
  });

  it("resolves operator calls to impl overloads", () => {
    const ast = loadAst("operator_overload_eq.voyd");
    const result = semanticsPipeline(ast);
    expect(result.diagnostics).toHaveLength(0);

    const { hir, typing } = result;
    const symbolTable = getSymbolTable(result);
    const rootScope = symbolTable.rootScope;

    const mainSymbol = symbolTable.resolve("main", rootScope);
    expect(typeof mainSymbol).toBe("number");
    if (typeof mainSymbol !== "number") {
      throw new Error("missing main symbol");
    }

    const mainFn = Array.from(hir.items.values()).find(
      (item): item is HirFunction => item.kind === "function" && item.symbol === mainSymbol
    );
    expect(mainFn).toBeDefined();
    if (!mainFn) return;

    const body = hir.expressions.get(mainFn.body);
    expect(body?.exprKind).toBe("block");
    if (!body || body.exprKind !== "block") return;

    const callExprId = body.value;
    expect(typeof callExprId).toBe("number");
    if (typeof callExprId !== "number") return;
    const callExpr = hir.expressions.get(callExprId);
    expect(callExpr?.exprKind).toBe("call");
    if (!callExpr || callExpr.exprKind !== "call") return;

    const instanceKey = `${mainSymbol}<>`;
    const target = typing.callTargets.get(callExpr.id)?.get(instanceKey);
    expect(target).toBeDefined();
    if (!target) return;

    const eqSymbols = symbolTable.resolveAll("==", rootScope) ?? [];
    const intrinsicEq = eqSymbols.find((symbol) => {
      const record = symbolTable.getSymbol(symbol);
      const meta = (record.metadata ?? {}) as { intrinsic?: boolean };
      return meta.intrinsic === true;
    });
    expect(target.symbol).not.toBe(intrinsicEq);

    const targetRecord = symbolTable.getSymbol(target.symbol);
    const targetMeta = (targetRecord.metadata ?? {}) as { intrinsic?: boolean };
    expect(targetRecord.name).toBe("==");
    expect(targetMeta.intrinsic).not.toBe(true);

    const callType = typing.table.getExprType(callExpr.id);
    expectPrimitiveType(typing, callType, "bool");
  });

  it("rejects ambiguous overloaded calls", () => {
    const ast = loadAst("function_overloads_ambiguous.voyd");
    expect(() => semanticsPipeline(ast)).toThrow(/ambiguous overload for add/);
  });

  it("rejects overload sets that escape call sites", () => {
    const ast = loadAst("function_overloads_capture.voyd");
    expect(() => semanticsPipeline(ast)).toThrow(
      /cannot be used outside of a call expression/
    );
  });

  it("requires argument labels to match for non-overloaded calls", () => {
    const ast = loadAst("function_labeled_call_mismatch.voyd");
    expect(() => semanticsPipeline(ast)).toThrow(/label mismatch/);
  });

  it("exposes binder overload metadata", () => {
    const binding = bindFixture("function_overloads.voyd");
    expect(binding.overloads.size).toBe(1);
    const [setId, overloadSet] = binding.overloads.entries().next().value!;
    expect(overloadSet.functions).toHaveLength(2);
    overloadSet.functions.forEach((fn) => {
      expect(binding.overloadBySymbol.get(fn.symbol)).toBe(setId);
      expect(fn.overloadSetId).toBe(setId);
    });
    expect(binding.diagnostics).toHaveLength(0);
  });

  it("reports duplicate overload signatures during binding", () => {
    const binding = bindFixture("function_overloads_duplicate.voyd");
    expect(
      binding.diagnostics.some((diag) =>
        diag.message.includes("already defines overload")
      )
    ).toBe(true);
  });

  it("rejects overloads that differ only by return type", () => {
    const binding = bindFixture("function_overloads_return_type.voyd");
    expect(
      binding.diagnostics.some((diag) =>
        diag.message.includes("already defines overload convert(a: i32)")
      )
    ).toBe(true);
  });

  it("rejects impls that target structural types", () => {
    const ast = loadAst("impl_structural_target.voyd");
    expect(() => semanticsPipeline(ast)).toThrow(
      /nominal object type/
    );
  });

  it("requires parameter annotations for overloaded functions", () => {
    const binding = bindFixture("function_overloads_missing_annotation.voyd");
    expect(
      binding.diagnostics.some((diag) =>
        diag.message.includes("must declare a type")
      )
    ).toBe(true);
  });
});

const bindFixture = (fixtureName: string): BindingResult => {
  const ast = loadAst(fixtureName);
  const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
  symbolTable.declare({
    name: fixtureName,
    kind: "module",
    declaredAt: ast.syntaxId,
  });
  return runBindingPipeline({
    moduleForm: ast,
    symbolTable,
  });
};
