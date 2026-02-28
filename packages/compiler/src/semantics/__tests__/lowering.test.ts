import { describe, expect, it } from "vitest";
import { SymbolTable } from "../binder/index.js";
import { runBindingPipeline } from "../binding/binding.js";
import { createHirBuilder } from "../hir/builder.js";
import {
  type HirBlockExpr,
  type HirCallExpr,
  type HirEffectHandlerExpr,
  type HirFieldAccessExpr,
  type HirFunction,
  type HirIdentifierExpr,
  type HirIfExpr,
  type HirImplDecl,
  type HirLetStatement,
  type HirMethodCallExpr,
  type HirObjectLiteralExpr,
  type HirTypeAlias,
  type HirTraitDecl,
  type HirNamedTypeExpr,
} from "../hir/nodes.js";
import { createLowerContext } from "../lowering/context.js";
import { lowerImplDecl } from "../lowering/declarations.js";
import { runLoweringPipeline } from "../lowering/lowering.js";
import { toSourceSpan } from "../utils.js";
import { loadAst } from "./load-ast.js";
import type { ModuleGraph, ModuleNode } from "../../modules/types.js";
import type { ModuleExportTable } from "../modules.js";
import { modulePathToString } from "../../modules/path.js";
import { isForm, parse } from "../../parser/index.js";
import { packageIdFromPath } from "../packages.js";
import { packageVisibility } from "../hir/index.js";

describe("lowering pipeline", () => {
  it("lowers the fib sample module into HIR", () => {
    const name = "fib.voyd";
    const ast = loadAst(name);
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    const moduleSymbol = symbolTable.declare({
      name,
      kind: "module",
      declaredAt: ast.syntaxId,
    });
    const binding = runBindingPipeline({
      moduleForm: ast,
      symbolTable,
    });
    const builder = createHirBuilder({
      path: name,
      scope: moduleSymbol,
      ast: ast.syntaxId,
      span: toSourceSpan(ast),
    });

    const hir = runLoweringPipeline({
      builder,
      binding,
      moduleNodeId: ast.syntaxId,
      modulePath: binding.modulePath,
      packageId: binding.packageId,
      isPackageRoot: binding.isPackageRoot,
    });

    expect(hir.module.items).toHaveLength(2);

    const fibSymbol = symbolTable.resolve("fib", symbolTable.rootScope);
    const mainSymbol = symbolTable.resolve("main", symbolTable.rootScope);

    const fibFn = Array.from(hir.items.values()).find(
      (item): item is HirFunction =>
        item.kind === "function" && item.symbol === fibSymbol
    );
    const mainFn = Array.from(hir.items.values()).find(
      (item): item is HirFunction =>
        item.kind === "function" && item.symbol === mainSymbol
    );

    expect(fibFn).toBeDefined();
    expect(mainFn).toBeDefined();

    expect(fibFn?.parameters).toHaveLength(1);
    const fibBlock = hir.expressions.get(fibFn!.body)!;
    expect(fibBlock.exprKind).toBe("block");
    const fibIf = hir.expressions.get(
      (fibBlock as HirBlockExpr).value!
    ) as HirIfExpr;
    expect(fibIf.exprKind).toBe("if");
    expect(fibIf.branches).toHaveLength(1);
    expect(fibIf.defaultBranch).toBeDefined();

    expect(mainFn?.visibility.level).toBe("package");
    expect(hir.module.exports.map((entry) => entry.symbol)).toEqual([
      mainSymbol,
    ]);
    expect(hir.module.exports.map((entry) => entry.visibility.level)).toEqual([
      "package",
    ]);
  });

  it("lowers structural object declarations and expressions", () => {
    const name = "structural_objects.voyd";
    const ast = loadAst(name);
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    const moduleSymbol = symbolTable.declare({
      name,
      kind: "module",
      declaredAt: ast.syntaxId,
    });
    const binding = runBindingPipeline({ moduleForm: ast, symbolTable });
    const builder = createHirBuilder({
      path: name,
      scope: moduleSymbol,
      ast: ast.syntaxId,
      span: toSourceSpan(ast),
    });

    const hir = runLoweringPipeline({
      builder,
      binding,
      moduleNodeId: ast.syntaxId,
      modulePath: binding.modulePath,
      packageId: binding.packageId,
      isPackageRoot: binding.isPackageRoot,
    });

    const alias = Array.from(hir.items.values()).find(
      (item): item is HirTypeAlias => item.kind === "type-alias"
    );
    expect(alias).toBeDefined();
    expect(alias?.target.typeKind).toBe("object");
    if (alias?.target.typeKind === "object") {
      const fieldNames = alias.target.fields.map((field) => field.name);
      expect(fieldNames).toEqual(["x", "y", "z"]);
    }

    const addSymbol = symbolTable.resolve("add", symbolTable.rootScope)!;
    const addFn = Array.from(hir.items.values()).find(
      (item): item is HirFunction =>
        item.kind === "function" && item.symbol === addSymbol
    );
    expect(addFn).toBeDefined();
    const addParamType = addFn?.parameters[0]?.type;
    expect(addParamType?.typeKind).toBe("named");
    if (addParamType?.typeKind === "named") {
      expect(addParamType.path).toEqual(["MyVec"]);
    }

    const addBody = hir.expressions.get(addFn!.body)!;
    expect(addBody.exprKind).toBe("block");
    const addValue = (addBody as HirBlockExpr).value;
    expect(addValue).toBeDefined();
    const addCall = hir.expressions.get(addValue!) as HirCallExpr;
    expect(addCall.exprKind).toBe("call");
    const firstField = hir.expressions.get(addCall.args[0]!.expr)!;
    expect(firstField.exprKind).toBe("field-access");
    expect((firstField as HirFieldAccessExpr).field).toBe("x");

    const mainSymbol = symbolTable.resolve("main", symbolTable.rootScope)!;
    const mainFn = Array.from(hir.items.values()).find(
      (item): item is HirFunction =>
        item.kind === "function" && item.symbol === mainSymbol
    );
    expect(mainFn).toBeDefined();
    const mainBlock = hir.expressions.get(mainFn!.body)!;
    expect(mainBlock.exprKind).toBe("block");
    const blockExpr = mainBlock as HirBlockExpr;
    const secondStmt = hir.statements.get(blockExpr.statements[1]!)!;
    expect(secondStmt.kind).toBe("let");
    const letStmt = secondStmt as HirLetStatement;
    const initializer = hir.expressions.get(letStmt.initializer)!;
    expect(initializer.exprKind).toBe("object-literal");
    const objectLiteral = initializer as HirObjectLiteralExpr;
    expect(objectLiteral.entries.some((entry) => entry.kind === "spread")).toBe(
      true
    );
  });

  it("lowers constrained declaration type parameters into HIR constraints", () => {
    const source = `
obj Animal {
  id: i32
}

trait Named
  fn name(self) -> i32

fn constrained<T: Named, U: { value: i32 }, V: Animal>(a: T, b: U, c: V) -> i32
  0
`;
    const ast = parse(source, "main.voyd");
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    const moduleSymbol = symbolTable.declare({
      name: "main.voyd",
      kind: "module",
      declaredAt: ast.syntaxId,
    });
    const binding = runBindingPipeline({ moduleForm: ast, symbolTable });
    const builder = createHirBuilder({
      path: "main.voyd",
      scope: moduleSymbol,
      ast: ast.syntaxId,
      span: toSourceSpan(ast),
    });

    const hir = runLoweringPipeline({
      builder,
      binding,
      moduleNodeId: ast.syntaxId,
      modulePath: binding.modulePath,
      packageId: binding.packageId,
      isPackageRoot: binding.isPackageRoot,
    });

    const constrainedSymbol = symbolTable.resolve("constrained", symbolTable.rootScope);
    const namedSymbol = symbolTable.resolve("Named", symbolTable.rootScope);
    const animalSymbol = symbolTable.resolve("Animal", symbolTable.rootScope);
    expect(typeof constrainedSymbol).toBe("number");
    expect(typeof namedSymbol).toBe("number");
    expect(typeof animalSymbol).toBe("number");
    if (
      typeof constrainedSymbol !== "number" ||
      typeof namedSymbol !== "number" ||
      typeof animalSymbol !== "number"
    ) {
      return;
    }

    const constrained = Array.from(hir.items.values()).find(
      (item): item is HirFunction =>
        item.kind === "function" && item.symbol === constrainedSymbol
    );
    expect(constrained).toBeDefined();
    const typeParameters = constrained?.typeParameters ?? [];
    expect(typeParameters).toHaveLength(3);

    const traitConstraint = typeParameters[0]?.constraint;
    expect(traitConstraint?.typeKind).toBe("named");
    if (traitConstraint?.typeKind === "named") {
      expect(traitConstraint.symbol).toBe(namedSymbol);
    }

    const structuralConstraint = typeParameters[1]?.constraint;
    expect(structuralConstraint?.typeKind).toBe("object");

    const nominalConstraint = typeParameters[2]?.constraint;
    expect(nominalConstraint?.typeKind).toBe("named");
    if (nominalConstraint?.typeKind === "named") {
      expect(nominalConstraint.symbol).toBe(animalSymbol);
    }
  });

  it("lowers nominal constructor literals with spreads as nominal object literals", () => {
    const name = "nominal_constructor_spread.voyd";
    const ast = loadAst(name);
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    const moduleSymbol = symbolTable.declare({
      name,
      kind: "module",
      declaredAt: ast.syntaxId,
    });
    const binding = runBindingPipeline({ moduleForm: ast, symbolTable });
    const builder = createHirBuilder({
      path: name,
      scope: moduleSymbol,
      ast: ast.syntaxId,
      span: toSourceSpan(ast),
    });

    const hir = runLoweringPipeline({
      builder,
      binding,
      moduleNodeId: ast.syntaxId,
      modulePath: binding.modulePath,
      packageId: binding.packageId,
      isPackageRoot: binding.isPackageRoot,
    });

    const versionSymbol = symbolTable.resolve("Version", symbolTable.rootScope)!;
    const mainSymbol = symbolTable.resolve("main", symbolTable.rootScope)!;
    const mainFn = Array.from(hir.items.values()).find(
      (item): item is HirFunction =>
        item.kind === "function" && item.symbol === mainSymbol
    );
    expect(mainFn).toBeDefined();
    const mainBlock = hir.expressions.get(mainFn!.body)!;
    expect(mainBlock.exprKind).toBe("block");
    const blockExpr = mainBlock as HirBlockExpr;
    const copyStmt = hir.statements.get(blockExpr.statements[1]!)!;
    expect(copyStmt.kind).toBe("let");
    const copyInitializer = hir.expressions.get(
      (copyStmt as HirLetStatement).initializer
    )!;
    expect(copyInitializer.exprKind).toBe("object-literal");
    const nominalLiteral = copyInitializer as HirObjectLiteralExpr;
    expect(nominalLiteral.literalKind).toBe("nominal");
    expect(nominalLiteral.targetSymbol).toBe(versionSymbol);
    expect(
      nominalLiteral.entries.some((entry) => entry.kind === "spread")
    ).toBe(true);
  });

  it("lowers dot calls into method-call expressions", () => {
    const name = "ufcs.voyd";
    const ast = loadAst(name);
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    const moduleSymbol = symbolTable.declare({
      name,
      kind: "module",
      declaredAt: ast.syntaxId,
    });
    const binding = runBindingPipeline({ moduleForm: ast, symbolTable });
    const builder = createHirBuilder({
      path: name,
      scope: moduleSymbol,
      ast: ast.syntaxId,
      span: toSourceSpan(ast),
    });

    const hir = runLoweringPipeline({
      builder,
      binding,
      moduleNodeId: ast.syntaxId,
      modulePath: binding.modulePath,
      packageId: binding.packageId,
      isPackageRoot: binding.isPackageRoot,
    });

    const mainSymbol = symbolTable.resolve("main", symbolTable.rootScope)!;

    const mainFn = Array.from(hir.items.values()).find(
      (item): item is HirFunction =>
        item.kind === "function" && item.symbol === mainSymbol
    );
    expect(mainFn).toBeDefined();

    const sumCalls = Array.from(hir.expressions.values()).filter(
      (expr): expr is HirMethodCallExpr =>
        expr.exprKind === "method-call" && expr.method === "sum"
    );

    expect(sumCalls).toHaveLength(2);
    const targetNames = sumCalls.map((call) => {
      const targetExpr = hir.expressions.get(call.target);
      expect(targetExpr?.exprKind).toBe("identifier");
      return symbolTable.getSymbol((targetExpr as HirIdentifierExpr).symbol).name;
    });

    expect(targetNames.sort()).toEqual(["v1", "v2"]);
  });

  it("lowers impl methods into functions and impl items", () => {
    const name = "impl_methods.voyd";
    const ast = loadAst(name);
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    const moduleSymbol = symbolTable.declare({
      name,
      kind: "module",
      declaredAt: ast.syntaxId,
    });
    const binding = runBindingPipeline({ moduleForm: ast, symbolTable });
    const builder = createHirBuilder({
      path: name,
      scope: moduleSymbol,
      ast: ast.syntaxId,
      span: toSourceSpan(ast),
    });

    const hir = runLoweringPipeline({
      builder,
      binding,
      moduleNodeId: ast.syntaxId,
      modulePath: binding.modulePath,
      packageId: binding.packageId,
      isPackageRoot: binding.isPackageRoot,
    });

    const doubleSymbol = binding.impls[0]?.methods[0]?.symbol;
    expect(typeof doubleSymbol).toBe("number");
    if (typeof doubleSymbol !== "number") {
      throw new Error("missing impl method symbol for double");
    }
    const doubleFn = Array.from(hir.items.values()).find(
      (item): item is HirFunction =>
        item.kind === "function" && item.symbol === doubleSymbol
    );
    expect(doubleFn).toBeDefined();

    const impl = Array.from(hir.items.values()).find(
      (item): item is HirImplDecl => item.kind === "impl"
    );
    expect(impl).toBeDefined();
    expect(impl?.members).toContain(doubleFn?.id);
    expect(impl?.target.typeKind).toBe("named");
    if (impl?.target.typeKind === "named") {
      expect(impl.target.path).toEqual(["Num"]);
    }

    const callExpressions = Array.from(hir.expressions.values()).filter(
      (expr): expr is HirMethodCallExpr =>
        expr.exprKind === "method-call" && expr.method === "double"
    );

    expect(callExpressions.length).toBeGreaterThan(0);
  });

  it("lowers static method calls without injecting self", () => {
    const name = "static_methods.voyd";
    const ast = loadAst(name);
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    const moduleSymbol = symbolTable.declare({
      name,
      kind: "module",
      declaredAt: ast.syntaxId,
    });
    const binding = runBindingPipeline({ moduleForm: ast, symbolTable });
    const builder = createHirBuilder({
      path: name,
      scope: moduleSymbol,
      ast: ast.syntaxId,
      span: toSourceSpan(ast),
    });

    const hir = runLoweringPipeline({
      builder,
      binding,
      moduleNodeId: ast.syntaxId,
      modulePath: binding.modulePath,
      packageId: binding.packageId,
      isPackageRoot: binding.isPackageRoot,
    });

    const counterSymbol = symbolTable.resolve("Counter", symbolTable.rootScope);
    expect(typeof counterSymbol).toBe("number");
    const staticNewSymbols =
      typeof counterSymbol === "number"
        ? binding.staticMethods.get(counterSymbol)?.get("new")
        : undefined;
    expect(staticNewSymbols).toBeDefined();
    const staticNewSymbol = staticNewSymbols
      ? Array.from(staticNewSymbols)[0]
      : undefined;

    const mainSymbol = symbolTable.resolve("main", symbolTable.rootScope)!;
    const mainFn = Array.from(hir.items.values()).find(
      (item): item is HirFunction =>
        item.kind === "function" && item.symbol === mainSymbol
    );
    expect(mainFn).toBeDefined();
    if (!mainFn) return;

    const mainBlock = hir.expressions.get(mainFn.body)! as HirBlockExpr;
    const firstStmt = hir.statements.get(mainBlock.statements[0]!)!;
    expect(firstStmt.kind).toBe("let");
    const initializer = hir.expressions.get(
      (firstStmt as HirLetStatement).initializer
    )!;
    expect(initializer.exprKind).toBe("call");
    const staticCall = initializer as HirCallExpr;
    expect(staticCall.args).toHaveLength(1);
    const calleeExpr = hir.expressions.get(staticCall.callee)!;
    expect(calleeExpr.exprKind).toBe("identifier");
    if (staticNewSymbol && calleeExpr.exprKind === "identifier") {
      expect((calleeExpr as HirIdentifierExpr).symbol).toBe(staticNewSymbol);
    }
  });

  it("fails when lowering static access with an unknown target", () => {
    const name = "bad_static_access.voyd";
    const ast = loadAst(name);
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    const moduleSymbol = symbolTable.declare({
      name,
      kind: "module",
      declaredAt: ast.syntaxId,
    });
    const binding = runBindingPipeline({ moduleForm: ast, symbolTable });
    const builder = createHirBuilder({
      path: name,
      scope: moduleSymbol,
      ast: ast.syntaxId,
      span: toSourceSpan(ast),
    });

    expect(() =>
      runLoweringPipeline({
        builder,
        binding,
        moduleNodeId: ast.syntaxId,
        modulePath: binding.modulePath,
        packageId: binding.packageId,
        isPackageRoot: binding.isPackageRoot,
      })
    ).toThrow(/static access target/);
  });

  it("lowers module-qualified calls", () => {
    const name = "module_qualified.voyd";
    const ast = loadAst(name);
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    const moduleSymbol = symbolTable.declare({
      name,
      kind: "module",
      declaredAt: ast.syntaxId,
    });

    const modulePath = { namespace: "src" as const, segments: ["main"] as const };
    const utilPath = {
      namespace: "src" as const,
      segments: ["main", "util"] as const,
    };
    const moduleId = modulePathToString(modulePath);
    const utilId = modulePathToString(utilPath);
    const useForm = ast.rest.find(
      (entry) => isForm(entry) && entry.calls("use")
    );
    const dependency = {
      kind: "use" as const,
      path: utilPath,
      span: toSourceSpan((useForm as any) ?? ast),
    };
    const moduleNode: ModuleNode = {
      id: moduleId,
      path: modulePath,
      origin: { kind: "file", filePath: name },
      ast,
      source: "",
      dependencies: [dependency],
    };
    const graph: ModuleGraph = {
      entry: moduleId,
      modules: new Map([[moduleId, moduleNode]]),
      diagnostics: [],
    };

    const exportedSymbol = 88;
    const moduleExports: Map<string, ModuleExportTable> = new Map([
      [
        utilId,
        new Map([
          [
            "helper",
            {
              name: "helper",
              symbol: exportedSymbol,
              moduleId: utilId,
              modulePath: utilPath,
              packageId: packageIdFromPath(utilPath),
              kind: "value",
              visibility: packageVisibility(),
            },
          ],
        ]),
      ],
    ]);

    const binding = runBindingPipeline({
      moduleForm: ast,
      symbolTable,
      module: moduleNode,
      graph,
      moduleExports,
    });

    const utilSymbol = symbolTable.resolve("util", symbolTable.rootScope);
    const helperSymbol =
      typeof utilSymbol === "number"
        ? binding.moduleMembers.get(utilSymbol)?.get("helper")
        : undefined;
    const helper = helperSymbol ? Array.from(helperSymbol)[0] : undefined;
    expect(typeof helper).toBe("number");

    const builder = createHirBuilder({
      path: name,
      scope: moduleSymbol,
      ast: ast.syntaxId,
      span: toSourceSpan(ast),
    });

    const hir = runLoweringPipeline({
      builder,
      binding,
      moduleNodeId: ast.syntaxId,
      modulePath: binding.modulePath,
      packageId: binding.packageId,
      isPackageRoot: binding.isPackageRoot,
    });

    const mainSymbol = symbolTable.resolve("main", symbolTable.rootScope)!;
    const mainFn = Array.from(hir.items.values()).find(
      (item): item is HirFunction =>
        item.kind === "function" && item.symbol === mainSymbol
    );
    expect(mainFn).toBeDefined();
    if (!mainFn || typeof helper !== "number") return;

    const block = hir.expressions.get(mainFn.body) as HirBlockExpr;
    const call = hir.expressions.get(block.value!) as HirCallExpr;
    const callee = hir.expressions.get(call.callee) as HirIdentifierExpr;
    expect(callee.symbol).toBe(helper);
  });

  it("lists ambiguity candidates for module-qualified members", () => {
    const source = `use self::util

fn main()
  util::helper()`;
    const ast = parse(source, "module_qualified_ambiguous_member.voyd");
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    const moduleSymbol = symbolTable.declare({
      name: "module_qualified_ambiguous_member.voyd",
      kind: "module",
      declaredAt: ast.syntaxId,
    });

    const modulePath = { namespace: "src" as const, segments: ["main"] as const };
    const utilPath = {
      namespace: "src" as const,
      segments: ["main", "util"] as const,
    };
    const moduleId = modulePathToString(modulePath);
    const utilId = modulePathToString(utilPath);
    const useForm = ast.rest.find((entry) => isForm(entry) && entry.calls("use"));
    const dependency = {
      kind: "use" as const,
      path: utilPath,
      span: toSourceSpan((useForm as any) ?? ast),
    };
    const moduleNode: ModuleNode = {
      id: moduleId,
      path: modulePath,
      origin: { kind: "file", filePath: "module_qualified_ambiguous_member.voyd" },
      ast,
      source,
      dependencies: [dependency],
    };
    const graph: ModuleGraph = {
      entry: moduleId,
      modules: new Map([[moduleId, moduleNode]]),
      diagnostics: [],
    };

    const depSource = `fn helper_i32(value: i32)
  value

fn helper_bool(value: bool)
  value`;
    const depAst = parse(
      depSource,
      "module_qualified_ambiguous_member_dep.voyd",
    );
    const depSymbolTable = new SymbolTable({ rootOwner: depAst.syntaxId });
    depSymbolTable.declare({
      name: "module_qualified_ambiguous_member_dep.voyd",
      kind: "module",
      declaredAt: depAst.syntaxId,
    });
    const depBinding = runBindingPipeline({
      moduleForm: depAst,
      symbolTable: depSymbolTable,
    });
    const helperI32 = depSymbolTable.resolve("helper_i32", depSymbolTable.rootScope);
    const helperBool = depSymbolTable.resolve(
      "helper_bool",
      depSymbolTable.rootScope,
    );
    expect(typeof helperI32).toBe("number");
    expect(typeof helperBool).toBe("number");
    if (typeof helperI32 !== "number" || typeof helperBool !== "number") {
      throw new Error("missing dependency helper symbols");
    }

    const moduleExports: Map<string, ModuleExportTable> = new Map([
      [
        utilId,
        new Map([
          [
            "helper",
            {
              name: "helper",
              symbol: helperI32,
              symbols: [helperI32, helperBool],
              moduleId: utilId,
              modulePath: utilPath,
              packageId: packageIdFromPath(utilPath),
              kind: "value",
              visibility: packageVisibility(),
            },
          ],
        ]),
      ],
    ]);

    const binding = runBindingPipeline({
      moduleForm: ast,
      symbolTable,
      module: moduleNode,
      graph,
      moduleExports,
      dependencies: new Map([[utilId, depBinding]]),
    });

    const builder = createHirBuilder({
      path: "module_qualified_ambiguous_member.voyd",
      scope: moduleSymbol,
      ast: ast.syntaxId,
      span: toSourceSpan(ast),
    });

    let caught: unknown;
    try {
      runLoweringPipeline({
        builder,
        binding,
        moduleNodeId: ast.syntaxId,
        modulePath: binding.modulePath,
        packageId: binding.packageId,
        isPackageRoot: binding.isPackageRoot,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    if (!(caught instanceof Error)) {
      return;
    }

    expect(caught.message).toContain("ambiguous module member helper on util");
    expect(caught.message).toContain("Candidates:");
    expect(caught.message).toContain("src::main::util::helper_i32");
    expect(caught.message).toContain("src::main::util::helper_bool");
  });

  it("preserves target type args for namespace-qualified effect ops", () => {
    const source = `use self::util

fn main()
  util::Gen<i32>::pass()`;
    const ast = parse(source, "module_qualified_effect_target.voyd");
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    const moduleSymbol = symbolTable.declare({
      name: "module_qualified_effect_target.voyd",
      kind: "module",
      declaredAt: ast.syntaxId,
    });

    const modulePath = { namespace: "src" as const, segments: ["main"] as const };
    const utilPath = {
      namespace: "src" as const,
      segments: ["main", "util"] as const,
    };
    const moduleId = modulePathToString(modulePath);
    const utilId = modulePathToString(utilPath);
    const useForm = ast.rest.find(
      (entry) => isForm(entry) && entry.calls("use")
    );
    const dependency = {
      kind: "use" as const,
      path: utilPath,
      span: toSourceSpan((useForm as any) ?? ast),
    };
    const moduleNode: ModuleNode = {
      id: moduleId,
      path: modulePath,
      origin: { kind: "file", filePath: "module_qualified_effect_target.voyd" },
      ast,
      source,
      dependencies: [dependency],
    };
    const graph: ModuleGraph = {
      entry: moduleId,
      modules: new Map([[moduleId, moduleNode]]),
      diagnostics: [],
    };

    const exportedEffect = 401;
    const exportedOp = 402;
    const moduleExports: Map<string, ModuleExportTable> = new Map([
      [
        utilId,
        new Map([
          [
            "Gen",
            {
              name: "Gen",
              symbol: exportedEffect,
              moduleId: utilId,
              modulePath: utilPath,
              packageId: packageIdFromPath(utilPath),
              kind: "effect",
              visibility: packageVisibility(),
            },
          ],
          [
            "pass",
            {
              name: "pass",
              symbol: exportedOp,
              moduleId: utilId,
              modulePath: utilPath,
              packageId: packageIdFromPath(utilPath),
              kind: "effect-op",
              visibility: packageVisibility(),
            },
          ],
        ]),
      ],
    ]);

    const binding = runBindingPipeline({
      moduleForm: ast,
      symbolTable,
      module: moduleNode,
      graph,
      moduleExports,
    });

    const builder = createHirBuilder({
      path: "module_qualified_effect_target.voyd",
      scope: moduleSymbol,
      ast: ast.syntaxId,
      span: toSourceSpan(ast),
    });
    const hir = runLoweringPipeline({
      builder,
      binding,
      moduleNodeId: ast.syntaxId,
      modulePath: binding.modulePath,
      packageId: binding.packageId,
      isPackageRoot: binding.isPackageRoot,
    });

    const mainSymbol = symbolTable.resolve("main", symbolTable.rootScope)!;
    const mainFn = Array.from(hir.items.values()).find(
      (item): item is HirFunction =>
        item.kind === "function" && item.symbol === mainSymbol
    );
    expect(mainFn).toBeDefined();
    if (!mainFn) return;

    const block = hir.expressions.get(mainFn.body) as HirBlockExpr;
    const call = hir.expressions.get(block.value!) as HirCallExpr;
    expect(call.exprKind).toBe("call");
    expect(call.typeArguments).toHaveLength(1);
    expect(call.typeArguments?.[0]?.typeKind).toBe("named");
    if (call.typeArguments?.[0]?.typeKind === "named") {
      expect(call.typeArguments[0].path).toEqual(["i32"]);
    }
  });

  it("resolves unqualified handler heads to effect-op symbols when wrappers share the name", () => {
    const source = `eff Env
  get(tail) -> i32

fn get() -> i32
  0

fn main() -> i32
  try
    Env::get()
  get(tail):
    tail()`;
    const ast = parse(source, "effect_op_resolution.voyd");
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    const moduleSymbol = symbolTable.declare({
      name: "effect_op_resolution.voyd",
      kind: "module",
      declaredAt: ast.syntaxId,
    });
    const binding = runBindingPipeline({
      moduleForm: ast,
      symbolTable,
    });
    const builder = createHirBuilder({
      path: "effect_op_resolution.voyd",
      scope: moduleSymbol,
      ast: ast.syntaxId,
      span: toSourceSpan(ast),
    });

    const hir = runLoweringPipeline({
      builder,
      binding,
      moduleNodeId: ast.syntaxId,
      modulePath: binding.modulePath,
      packageId: binding.packageId,
      isPackageRoot: binding.isPackageRoot,
    });

    const mainSymbol = symbolTable.resolve("main", symbolTable.rootScope)!;
    const mainFn = Array.from(hir.items.values()).find(
      (item): item is HirFunction =>
        item.kind === "function" && item.symbol === mainSymbol
    );
    expect(mainFn).toBeDefined();
    if (!mainFn) return;

    const block = hir.expressions.get(mainFn.body) as HirBlockExpr;
    const handlerExpr = hir.expressions.get(block.value!) as HirEffectHandlerExpr;
    expect(handlerExpr.exprKind).toBe("effect-handler");
    const handler = handlerExpr.handlers[0];
    expect(handler).toBeDefined();
    if (!handler) return;
    expect(symbolTable.getSymbol(handler.operation).kind).toBe("effect-op");
  });

  it("lowers traits and their default methods", () => {
    const name = "trait_area.voyd";
    const ast = loadAst(name);
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    const moduleSymbol = symbolTable.declare({
      name,
      kind: "module",
      declaredAt: ast.syntaxId,
    });
    const binding = runBindingPipeline({ moduleForm: ast, symbolTable });
    const builder = createHirBuilder({
      path: name,
      scope: moduleSymbol,
      ast: ast.syntaxId,
      span: toSourceSpan(ast),
    });

    const hir = runLoweringPipeline({
      builder,
      binding,
      moduleNodeId: ast.syntaxId,
      modulePath: binding.modulePath,
      packageId: binding.packageId,
      isPackageRoot: binding.isPackageRoot,
    });

    const traitSymbol = symbolTable.resolve("Area", symbolTable.rootScope)!;
    const trait = Array.from(hir.items.values()).find(
      (item): item is HirTraitDecl =>
        item.kind === "trait" && item.symbol === traitSymbol
    );
    expect(trait).toBeDefined();
    const methodNames = trait?.methods.map((method) =>
      symbolTable.getSymbol(method.symbol).name
    );
    expect(methodNames).toEqual(["area", "double_area"]);
    const areaMethod = trait?.methods.find(
      (method) => symbolTable.getSymbol(method.symbol).name === "area"
    );
    const doubleArea = trait?.methods.find(
      (method) => symbolTable.getSymbol(method.symbol).name === "double_area"
    );
    expect(areaMethod?.defaultBody).toBeUndefined();
    expect(doubleArea?.defaultBody).toBeDefined();

    const impl = Array.from(hir.items.values()).find(
      (item): item is HirImplDecl => item.kind === "impl"
    );
    expect(impl?.trait?.typeKind).toBe("named");
    if ((impl?.trait as HirNamedTypeExpr | undefined)?.typeKind === "named") {
      expect((impl?.trait as HirNamedTypeExpr).path).toEqual(["Area"]);
    }
  });

  it("only elevates exports to public API from pkg.voyd", () => {
    const source = "pub fn main()\n  1";

    const rootAst = parse(source, "pkg.voyd");
    const rootPath = { namespace: "src" as const, segments: ["pkg"] as const };
    const rootId = modulePathToString(rootPath);
    const rootSymbolTable = new SymbolTable({ rootOwner: rootAst.syntaxId });
    const rootModuleSymbol = rootSymbolTable.declare({
      name: rootId,
      kind: "module",
      declaredAt: rootAst.syntaxId,
    });
    const rootNode: ModuleNode = {
      id: rootId,
      path: rootPath,
      origin: { kind: "file", filePath: "pkg.voyd" },
      ast: rootAst,
      source,
      dependencies: [],
    };
    const rootGraph: ModuleGraph = {
      entry: rootId,
      modules: new Map([[rootId, rootNode]]),
      diagnostics: [],
    };
    const rootBinding = runBindingPipeline({
      moduleForm: rootAst,
      symbolTable: rootSymbolTable,
      module: rootNode,
      graph: rootGraph,
    });
    const rootBuilder = createHirBuilder({
      path: rootId,
      scope: rootModuleSymbol,
      ast: rootAst.syntaxId,
      span: toSourceSpan(rootAst),
    });
    const rootHir = runLoweringPipeline({
      builder: rootBuilder,
      binding: rootBinding,
      moduleNodeId: rootAst.syntaxId,
      modulePath: rootPath,
      packageId: rootBinding.packageId,
      isPackageRoot: rootBinding.isPackageRoot,
    });
    expect(rootHir.module.exports[0]?.visibility.level).toBe("public");

    const moduleAst = parse(source, "main.voyd");
    const modulePath = {
      namespace: "src" as const,
      segments: ["main"] as const,
    };
    const moduleId = modulePathToString(modulePath);
    const moduleSymbolTable = new SymbolTable({ rootOwner: moduleAst.syntaxId });
    const moduleSymbol = moduleSymbolTable.declare({
      name: moduleId,
      kind: "module",
      declaredAt: moduleAst.syntaxId,
    });
    const moduleNode: ModuleNode = {
      id: moduleId,
      path: modulePath,
      origin: { kind: "file", filePath: "main.voyd" },
      ast: moduleAst,
      source,
      dependencies: [],
    };
    const moduleGraph: ModuleGraph = {
      entry: moduleId,
      modules: new Map([[moduleId, moduleNode]]),
      diagnostics: [],
    };
    const moduleBinding = runBindingPipeline({
      moduleForm: moduleAst,
      symbolTable: moduleSymbolTable,
      module: moduleNode,
      graph: moduleGraph,
    });
    const moduleBuilder = createHirBuilder({
      path: moduleId,
      scope: moduleSymbol,
      ast: moduleAst.syntaxId,
      span: toSourceSpan(moduleAst),
    });
    const moduleHir = runLoweringPipeline({
      builder: moduleBuilder,
      binding: moduleBinding,
      moduleNodeId: moduleAst.syntaxId,
      modulePath: modulePath,
      packageId: moduleBinding.packageId,
      isPackageRoot: moduleBinding.isPackageRoot,
    });
    expect(moduleHir.module.exports[0]?.visibility.level).toBe("package");
  });

  it("throws when an impl references a method missing from the lowered module", () => {
    const name = "impl_methods.voyd";
    const ast = loadAst(name);
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    const moduleSymbol = symbolTable.declare({
      name,
      kind: "module",
      declaredAt: ast.syntaxId,
    });
    const binding = runBindingPipeline({ moduleForm: ast, symbolTable });
    const builder = createHirBuilder({
      path: name,
      scope: moduleSymbol,
      ast: ast.syntaxId,
      span: toSourceSpan(ast),
    });
    const ctx = createLowerContext({
      builder,
      binding,
      moduleNodeId: ast.syntaxId,
      modulePath: binding.modulePath,
      packageId: binding.packageId,
      isPackageRoot: binding.isPackageRoot,
    });

    expect(() => lowerImplDecl(binding.impls[0]!, ctx)).toThrow(
      /missing function item/
    );
  });

  it("falls back to regular call lowering when `is` rhs is not a type", () => {
    const source = `
obj Box {
  value: i32
}

pub fn main(): () -> bool
  let b = Box { value: 1 }
  b is (1 + 2)
`;
    const ast = parse(source, "main.voyd");
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    const moduleSymbol = symbolTable.declare({
      name: "main.voyd",
      kind: "module",
      declaredAt: ast.syntaxId,
    });
    const binding = runBindingPipeline({ moduleForm: ast, symbolTable });
    const builder = createHirBuilder({
      path: "main.voyd",
      scope: moduleSymbol,
      ast: ast.syntaxId,
      span: toSourceSpan(ast),
    });

    expect(() =>
      runLoweringPipeline({
        builder,
        binding,
        moduleNodeId: ast.syntaxId,
        modulePath: binding.modulePath,
        packageId: binding.packageId,
        isPackageRoot: binding.isPackageRoot,
      }),
    ).not.toThrow();
  });

  it("does not rewrite quoted `is` calls into type-check matches", () => {
    const source = `
pub fn 'is'({ left: i32, right: i32 }) -> bool
  left == right

pub fn main(): () -> bool
  'is'(left: 1, right: 2)
`;
    const ast = parse(source, "main.voyd");
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    const moduleSymbol = symbolTable.declare({
      name: "main.voyd",
      kind: "module",
      declaredAt: ast.syntaxId,
    });
    const binding = runBindingPipeline({ moduleForm: ast, symbolTable });
    const builder = createHirBuilder({
      path: "main.voyd",
      scope: moduleSymbol,
      ast: ast.syntaxId,
      span: toSourceSpan(ast),
    });
    const hir = runLoweringPipeline({
      builder,
      binding,
      moduleNodeId: ast.syntaxId,
      modulePath: binding.modulePath,
      packageId: binding.packageId,
      isPackageRoot: binding.isPackageRoot,
    });

    const mainSymbol = symbolTable.resolve("main", symbolTable.rootScope);
    expect(typeof mainSymbol).toBe("number");
    if (typeof mainSymbol !== "number") {
      throw new Error("missing main symbol");
    }
    const mainFn = Array.from(hir.items.values()).find(
      (item): item is HirFunction =>
        item.kind === "function" && item.symbol === mainSymbol,
    );
    expect(mainFn).toBeDefined();
    if (!mainFn) {
      throw new Error("missing lowered main function");
    }

    const mainBody = hir.expressions.get(mainFn.body);
    expect(mainBody?.exprKind).toBe("block");
    if (!mainBody || mainBody.exprKind !== "block") {
      throw new Error("main body is not a block");
    }
    const callExpr = hir.expressions.get(mainBody.value ?? -1);
    expect(callExpr?.exprKind).toBe("call");

    const hasMatchExpr = Array.from(hir.expressions.values()).some(
      (expr) => expr.exprKind === "match",
    );
    expect(hasMatchExpr).toBe(false);
  });

  it("does not rewrite quoted range operator identifiers into Range literals", () => {
    const source = `
pub fn '..'() -> i32
  1

pub fn main(): () -> i32
  '..'()
`;
    const ast = parse(source, "main.voyd");
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    const moduleSymbol = symbolTable.declare({
      name: "main.voyd",
      kind: "module",
      declaredAt: ast.syntaxId,
    });
    const binding = runBindingPipeline({ moduleForm: ast, symbolTable });
    const builder = createHirBuilder({
      path: "main.voyd",
      scope: moduleSymbol,
      ast: ast.syntaxId,
      span: toSourceSpan(ast),
    });
    const hir = runLoweringPipeline({
      builder,
      binding,
      moduleNodeId: ast.syntaxId,
      modulePath: binding.modulePath,
      packageId: binding.packageId,
      isPackageRoot: binding.isPackageRoot,
    });

    const mainSymbol = symbolTable.resolve("main", symbolTable.rootScope);
    expect(typeof mainSymbol).toBe("number");
    if (typeof mainSymbol !== "number") {
      throw new Error("missing main symbol");
    }
    const mainFn = Array.from(hir.items.values()).find(
      (item): item is HirFunction =>
        item.kind === "function" && item.symbol === mainSymbol,
    );
    expect(mainFn).toBeDefined();
    if (!mainFn) {
      throw new Error("missing lowered main function");
    }

    const mainBody = hir.expressions.get(mainFn.body);
    expect(mainBody?.exprKind).toBe("block");
    if (!mainBody || mainBody.exprKind !== "block") {
      throw new Error("main body is not a block");
    }

    const callExpr = hir.expressions.get(mainBody.value ?? -1);
    expect(callExpr?.exprKind).toBe("call");

    const hasRangeLiteral = Array.from(hir.expressions.values()).some(
      (expr) =>
        expr.exprKind === "object-literal" &&
        expr.literalKind === "nominal" &&
        expr.target?.typeKind === "named" &&
        expr.target.path.length === 1 &&
        expr.target.path[0] === "Range",
    );
    expect(hasRangeLiteral).toBe(false);
  });
});
