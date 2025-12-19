import { describe, expect, it } from "vitest";
import { SymbolTable } from "../binder/index.js";
import { runBindingPipeline } from "../binding/binding.js";
import { createHirBuilder, type HirLambdaExpr, type HirNamedTypeExpr, type HirFunction } from "../hir/index.js";
import { runLoweringPipeline } from "../lowering/lowering.js";
import { analyzeLambdaCaptures } from "../lowering/captures.js";
import { toSourceSpan } from "../utils.js";
import { loadAst } from "./load-ast.js";
import type { HirGraph } from "../hir/index.js";
import type { ModuleGraph, ModuleNode } from "../../modules/types.js";

const buildSemantics = (fixture: string) => {
  const ast = loadAst(fixture);
  const module: ModuleNode = {
    id: fixture,
    path: { namespace: "src", segments: [] },
    origin: { kind: "file", filePath: fixture },
    ast,
    source: "",
    dependencies: [],
  };
  const graph: ModuleGraph = {
    entry: module.id,
    modules: new Map([[module.id, module]]),
    diagnostics: [],
  };

  const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
  const moduleSymbol = symbolTable.declare({
    name: module.id,
    kind: "module",
    declaredAt: ast.syntaxId,
  });

  const binding = runBindingPipeline({
    moduleForm: ast,
    symbolTable,
    module,
    graph,
    moduleExports: new Map(),
  });

  const builder = createHirBuilder({
    path: module.id,
    scope: moduleSymbol,
    ast: ast.syntaxId,
    span: toSourceSpan(ast),
  });

  const hir = runLoweringPipeline({
    builder,
    binding,
    moduleNodeId: ast.syntaxId,
    moduleId: module.id,
    modulePath: module.path,
    packageId: binding.packageId,
    isPackageRoot: binding.isPackageRoot,
  });

  analyzeLambdaCaptures({
    hir,
    symbolTable,
    scopeByNode: binding.scopeByNode,
  });

  return { hir, symbolTable };
};

const lambdaByParam = (
  hir: HirGraph,
  symbolTable: SymbolTable,
  paramName: string
): HirLambdaExpr | undefined =>
  Array.from(hir.expressions.values()).find(
    (expr): expr is HirLambdaExpr =>
      expr.exprKind === "lambda" &&
      expr.parameters.some(
        (param) => symbolTable.getSymbol(param.symbol).name === paramName
      )
  );

const functionByName = (
  hir: HirGraph,
  symbolTable: SymbolTable,
  name: string
): HirFunction | undefined =>
  Array.from(hir.items.values()).find(
    (item): item is HirFunction =>
      item.kind === "function" &&
      symbolTable.getSymbol(item.symbol).name === name
  );

const captureNames = (lambda: HirLambdaExpr, symbolTable: SymbolTable) =>
  lambda.captures.map((capture) => symbolTable.getSymbol(capture.symbol).name);

describe("lambda binding and captures", () => {
  it("lowers lambda signatures and records captures", () => {
    const { hir, symbolTable } = buildSemantics("lambda_captures.voyd");

    const makeAdderLambda = lambdaByParam(hir, symbolTable, "delta");
    expect(makeAdderLambda).toBeDefined();
    const makeAdderFn = functionByName(hir, symbolTable, "makeAdder");
    expect(makeAdderFn).toBeDefined();

    const lambdaParamType = makeAdderLambda?.parameters[0]?.type as HirNamedTypeExpr;
    expect(lambdaParamType.path).toEqual(["i32"]);
    const lambdaReturnType = makeAdderLambda?.returnType as HirNamedTypeExpr;
    expect(lambdaReturnType.path).toEqual(["i32"]);
    expect(captureNames(makeAdderLambda!, symbolTable)).toEqual(["base"]);
    expect(makeAdderLambda?.captures[0]?.mutable).toBe(false);
    expect(makeAdderLambda?.owner?.kind).toBe("function");
    expect(makeAdderLambda?.owner?.kind === "function" ? makeAdderLambda.owner.item : undefined).toBe(
      makeAdderFn?.id
    );

    const outerLambda = lambdaByParam(hir, symbolTable, "value");
    expect(outerLambda).toBeDefined();
    const nestedFn = functionByName(hir, symbolTable, "nested");
    expect(nestedFn).toBeDefined();
    expect(captureNames(outerLambda!, symbolTable)).toEqual(["base", "outer"]);
    expect(outerLambda?.captures.map((capture) => capture.mutable)).toEqual([
      false,
      false,
    ]);
    expect(outerLambda?.owner?.kind).toBe("function");
    expect(outerLambda?.owner?.kind === "function" ? outerLambda.owner.item : undefined).toBe(
      nestedFn?.id
    );

    const innerLambda = lambdaByParam(hir, symbolTable, "extra");
    expect(innerLambda).toBeDefined();
    expect(captureNames(innerLambda!, symbolTable)).toEqual([
      "shadow",
      "base",
      "outer",
      "total",
    ]);
    expect(innerLambda?.captures.map((capture) => capture.mutable)).toEqual([
      false,
      false,
      false,
      true,
    ]);
    expect(innerLambda?.owner?.kind).toBe("lambda");
    expect(
      innerLambda?.owner?.kind === "lambda" ? innerLambda.owner.expr : undefined
    ).toBe(outerLambda?.id);
  });
});
