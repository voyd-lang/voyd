import { describe, expect, it } from "vitest";

import { SymbolTable } from "../binder/index.js";
import { runBindingPipeline } from "../binding/binding.js";
import { loadAst } from "./load-ast.js";
import { isForm, isIdentifierAtom, parse, type Form } from "../../parser/index.js";
import { toSourceSpan } from "../utils.js";
import { modulePathToString } from "../../modules/path.js";
import { buildModuleGraph } from "../../modules/graph.js";
import { createMemoryModuleHost } from "../../modules/memory-host.js";
import { createNodePathAdapter } from "../../modules/node-path-adapter.js";
import type {
  ModuleDependency,
  ModuleGraph,
  ModuleHost,
  ModuleNode,
} from "../../modules/types.js";
import type { ModuleExportTable } from "../modules.js";
import { resolve, sep } from "node:path";
import {
  packageVisibility,
  publicVisibility,
} from "../hir/index.js";
import { packageIdFromPath } from "../packages.js";

const createMemoryHost = (files: Record<string, string>): ModuleHost =>
  createMemoryModuleHost({ files, pathAdapter: createNodePathAdapter() });

describe("binding pipeline", () => {
  it("collects functions, parameters, and scopes for the fib sample module", () => {
    const name = "fib.voyd";
    const ast = loadAst(name);
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    symbolTable.declare({
      name,
      kind: "module",
      declaredAt: ast.syntaxId,
    });

    const binding = runBindingPipeline({
      moduleForm: ast,
      symbolTable,
    });

    expect(binding.functions).toHaveLength(2);

    const fibFn = binding.functions.find(
      (fn) => symbolTable.getSymbol(fn.symbol).name === "fib"
    );
    const mainFn = binding.functions.find(
      (fn) => symbolTable.getSymbol(fn.symbol).name === "main"
    );

    expect(fibFn).toBeDefined();
    expect(mainFn).toBeDefined();
    expect(fibFn?.params).toHaveLength(1);
    expect(fibFn?.params[0]?.typeExpr).toBeDefined();
    expect(fibFn?.returnTypeExpr).toBeDefined();
    expect(mainFn?.visibility.level).toBe("package");
    expect(mainFn?.params).toHaveLength(0);

    expect(fibFn?.form).toBeDefined();
    expect(binding.scopeByNode.get(fibFn!.form!.syntaxId)).toBe(fibFn!.scope);
    expect(
      binding.symbolTable.resolve("fib", binding.symbolTable.rootScope)
    ).toBe(fibFn!.symbol);
    expect(
      binding.symbolTable.resolve("main", binding.symbolTable.rootScope)
    ).toBe(mainFn!.symbol);
  });

  it("incorporates labeled parameters into overload signatures", () => {
    const name = "function_overloads_labeled.voyd";
    const ast = loadAst(name);
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    symbolTable.declare({
      name,
      kind: "module",
      declaredAt: ast.syntaxId,
    });

    const binding = runBindingPipeline({
      moduleForm: ast,
      symbolTable,
    });

    const routeFns = binding.functions.filter(
      (fn) => symbolTable.getSymbol(fn.symbol).name === "route"
    );
    expect(routeFns).toHaveLength(2);
    expect(binding.diagnostics).toHaveLength(0);
    const labels = routeFns.map((fn) => {
      const label = fn.params[1]?.label;
      expect(label).toBeDefined();
      return label!;
    });
    expect(labels).toEqual(expect.arrayContaining(["from", "to"]));
  });

  it("binds structural object type aliases and parameters", () => {
    const name = "structural_objects.voyd";
    const ast = loadAst(name);
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    symbolTable.declare({ name, kind: "module", declaredAt: ast.syntaxId });

    const binding = runBindingPipeline({ moduleForm: ast, symbolTable });

    expect(binding.typeAliases).toHaveLength(1);
    const alias = binding.typeAliases[0]!;
    expect(symbolTable.getSymbol(alias.symbol).kind).toBe("type");
    expect(
      isForm(alias.target) && alias.target.callsInternal("object_literal")
    ).toBe(true);

    const addFn = binding.functions.find(
      (fn) => symbolTable.getSymbol(fn.symbol).name === "add"
    );
    expect(addFn).toBeDefined();
    const paramType = addFn?.params[0]?.typeExpr;
    expect(paramType).toBeDefined();
    expect(isIdentifierAtom(paramType) && paramType.value === "MyVec").toBe(
      true
    );

    const paramSymbol = addFn?.params[0]?.symbol;
    expect(paramSymbol).toBeDefined();
    expect(binding.decls.getParameter(paramSymbol!)).toBe(addFn?.params[0]);
  });

  it("binds type parameters for type aliases", () => {
    const name = "type_alias_generics.voyd";
    const ast = loadAst(name);
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    symbolTable.declare({ name, kind: "module", declaredAt: ast.syntaxId });

    const binding = runBindingPipeline({ moduleForm: ast, symbolTable });

    const optional = binding.typeAliases.find(
      (alias) => symbolTable.getSymbol(alias.symbol).name === "Optional"
    );
    expect(optional).toBeDefined();
    expect(optional?.typeParameters?.map((param) => param.name)).toEqual([
      "T",
    ]);

    const scope =
      optional?.form && binding.scopeByNode.get(optional.form.syntaxId);
    expect(scope).toBeDefined();
    if (scope && optional?.typeParameters?.[0]) {
      const resolved = symbolTable.resolve("T", scope);
      expect(resolved).toBe(optional.typeParameters[0].symbol);
    }
  });

  it("binds type parameters for functions", () => {
    const name = "function_generics.voyd";
    const ast = loadAst(name);
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    symbolTable.declare({ name, kind: "module", declaredAt: ast.syntaxId });

    const binding = runBindingPipeline({ moduleForm: ast, symbolTable });

    const addFn = binding.functions.find(
      (fn) => symbolTable.getSymbol(fn.symbol).name === "add"
    );
    expect(addFn?.typeParameters?.length).toBe(1);

    const fnScope =
      addFn?.form && binding.scopeByNode.get(addFn.form.syntaxId);
    const typeParamSymbol = addFn?.typeParameters?.[0]?.symbol;

    if (typeof fnScope === "number" && typeof typeParamSymbol === "number") {
      expect(symbolTable.resolve("T", fnScope)).toBe(typeParamSymbol);
    }
  });

  it("captures generic constraints on functions and type aliases", () => {
    const source = `
fn identity<T: Numeric>(value: T) -> T
  value

type Wrap<T: { value: i32 }> = T
`;
    const ast = parse(source, "main.voyd");
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    symbolTable.declare({ name: "main.voyd", kind: "module", declaredAt: ast.syntaxId });

    const binding = runBindingPipeline({ moduleForm: ast, symbolTable });

    const identity = binding.functions.find(
      (fn) => symbolTable.getSymbol(fn.symbol).name === "identity"
    );
    expect(identity).toBeDefined();
    const functionConstraint = identity?.typeParameters?.[0]?.constraint;
    expect(
      isIdentifierAtom(functionConstraint) && functionConstraint.value === "Numeric"
    ).toBe(true);

    const wrap = binding.typeAliases.find(
      (alias) => symbolTable.getSymbol(alias.symbol).name === "Wrap"
    );
    expect(wrap).toBeDefined();
    const aliasConstraint = wrap?.typeParameters?.[0]?.constraint;
    expect(
      isForm(aliasConstraint) && aliasConstraint.callsInternal("object_literal")
    ).toBe(true);
  });

  it("supports constrained generics across all declaration heads", () => {
    const source = `
obj Animal {
  id: i32
}

type Wrap<T: Animal> = T

obj Box<T: Animal> {
  value: T
}

trait Carrier<T: Animal>
  fn carry(self, value: T) -> i32

impl<T: Animal> Box<T>
  fn carry(self, value: T) -> i32
    value.id

eff Stream<T: Animal>
  fn next() -> T

fn id<T: Animal>(value: T) -> T
  value
`;
    const ast = parse(source, "main.voyd");
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    symbolTable.declare({ name: "main.voyd", kind: "module", declaredAt: ast.syntaxId });

    const binding = runBindingPipeline({ moduleForm: ast, symbolTable });

    const firstConstraintName = (constraint: unknown): string | undefined =>
      isIdentifierAtom(constraint) ? constraint.value : undefined;

    const typeAlias = binding.typeAliases.find(
      (entry) => symbolTable.getSymbol(entry.symbol).name === "Wrap"
    );
    const objectDecl = binding.objects.find(
      (entry) => symbolTable.getSymbol(entry.symbol).name === "Box"
    );
    const traitDecl = binding.traits.find(
      (entry) => symbolTable.getSymbol(entry.symbol).name === "Carrier"
    );
    const implDecl = binding.impls[0];
    const effectDecl = binding.effects.find(
      (entry) => symbolTable.getSymbol(entry.symbol).name === "Stream"
    );
    const functionDecl = binding.functions.find(
      (entry) => symbolTable.getSymbol(entry.symbol).name === "id"
    );

    expect(firstConstraintName(typeAlias?.typeParameters?.[0]?.constraint)).toBe("Animal");
    expect(firstConstraintName(objectDecl?.typeParameters?.[0]?.constraint)).toBe("Animal");
    expect(firstConstraintName(traitDecl?.typeParameters?.[0]?.constraint)).toBe("Animal");
    expect(firstConstraintName(implDecl?.typeParameters?.[0]?.constraint)).toBe("Animal");
    expect(firstConstraintName(effectDecl?.typeParameters?.[0]?.constraint)).toBe("Animal");
    expect(firstConstraintName(functionDecl?.typeParameters?.[0]?.constraint)).toBe("Animal");
  });

  it("binds impl blocks and keeps methods out of the root scope", () => {
    const name = "impl_methods.voyd";
    const ast = loadAst(name);
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    symbolTable.declare({ name, kind: "module", declaredAt: ast.syntaxId });

    const binding = runBindingPipeline({ moduleForm: ast, symbolTable });

    expect(binding.impls).toHaveLength(1);
    const impl = binding.impls[0]!;
    expect(impl.methods).toHaveLength(1);
    const method = impl.methods[0]!;

    expect(method.implId).toBe(impl.id);
    expect(method.params[0]?.name).toBe("self");
    expect(isIdentifierAtom(method.params[0]?.typeExpr) && method.params[0]?.typeExpr.value).toBe("Num");

    const rootScope = symbolTable.rootScope;
    const doubleSymbol = symbolTable.resolve("double", rootScope);
    expect(doubleSymbol).toBeUndefined();

    const implScope = binding.scopeByNode.get(impl.form!.syntaxId);
    expect(implScope).toBeDefined();
    if (implScope) {
      expect(symbolTable.getScope(implScope).kind).toBe("impl");
    }
  });

  it("records member visibility for api and pri fields and methods", () => {
    const name = "visibility_members.voyd";
    const ast = loadAst(name);
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    symbolTable.declare({ name, kind: "module", declaredAt: ast.syntaxId });

    const binding = runBindingPipeline({ moduleForm: ast, symbolTable });
    const vec = binding.objects.find(
      (object) => symbolTable.getSymbol(object.symbol).name === "Vec"
    );
    expect(vec?.visibility.level).toBe("package");

    const fieldVisibility = new Map(
      vec?.fields.map((field) => [field.name, field.visibility]) ?? []
    );
    expect(fieldVisibility.get("x")?.api).toBe(true);
    expect(fieldVisibility.get("x")?.level).toBe("package");
    expect(fieldVisibility.get("y")?.level).toBe("package");
    expect(fieldVisibility.get("z")?.level).toBe("object");

    const methodByName = new Map(
      binding.functions.map((fn) => [
        symbolTable.getSymbol(fn.symbol).name,
        fn,
      ])
    );
    expect(methodByName.get("double")?.memberVisibility?.api).toBe(true);
    expect(methodByName.get("double")?.visibility.level).toBe("package");
    expect(methodByName.get("sum")?.visibility.level).toBe("package");
    expect(methodByName.get("hide")?.visibility.level).toBe("object");
  });

  it("binds static methods to impl scopes and records them", () => {
    const name = "static_methods.voyd";
    const ast = loadAst(name);
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    symbolTable.declare({ name, kind: "module", declaredAt: ast.syntaxId });

    const binding = runBindingPipeline({ moduleForm: ast, symbolTable });

    const impl = binding.impls[0];
    expect(impl).toBeDefined();
    if (!impl) return;

    const implScope = impl.form
      ? binding.scopeByNode.get(impl.form.syntaxId)
      : undefined;
    expect(implScope).toBeDefined();

    const staticMethod = impl.methods.find(
      (method) => symbolTable.getSymbol(method.symbol).name === "new"
    );
    expect(staticMethod).toBeDefined();
    if (!staticMethod || !implScope) return;

    const staticMethodRecord = symbolTable.getSymbol(staticMethod.symbol);
    expect(staticMethodRecord.scope).toBe(implScope);

    const instanceMethod = impl.methods.find(
      (method) => symbolTable.getSymbol(method.symbol).name === "double"
    );
    const rootScope = symbolTable.rootScope;
    if (instanceMethod) {
      expect(symbolTable.getSymbol(instanceMethod.symbol).scope).not.toBe(rootScope);
      const scopeInfo = symbolTable.getScope(symbolTable.getSymbol(instanceMethod.symbol).scope);
      expect(scopeInfo.kind).toBe("members");
    }

    const counterSymbol = symbolTable.resolve("Counter", implScope);
    expect(typeof counterSymbol).toBe("number");
    if (typeof counterSymbol !== "number") return;

    const staticMethods = binding.staticMethods.get(counterSymbol);
    expect(staticMethods?.get("new")?.has(staticMethod.symbol)).toBe(true);
    expect(staticMethods?.get("double")).toBeUndefined();
  });

  it("records static methods even when the impl appears before the object", () => {
    const name = "static_methods_out_of_order.voyd";
    const ast = loadAst(name);
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    symbolTable.declare({ name, kind: "module", declaredAt: ast.syntaxId });

    const binding = runBindingPipeline({ moduleForm: ast, symbolTable });
    const counterSymbol = symbolTable.resolve("Counter", symbolTable.rootScope);
    expect(typeof counterSymbol).toBe("number");
    if (typeof counterSymbol !== "number") return;

    const staticMethods = binding.staticMethods.get(counterSymbol);
    const create = staticMethods?.get("create");
    expect(create?.size).toBe(1);
  });

  it("binds module-qualified calls via module imports", () => {
    const name = "module_qualified.voyd";
    const ast = loadAst(name);
    const useForm = ast.rest.find(
      (entry) => isForm(entry) && entry.calls("use")
    ) as Form | undefined;
    const span = toSourceSpan(useForm ?? ast);
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    symbolTable.declare({ name, kind: "module", declaredAt: ast.syntaxId });

    const modulePath = { namespace: "src" as const, segments: ["main"] as const };
    const utilPath = {
      namespace: "src" as const,
      segments: ["main", "util"] as const,
    };
    const moduleId = modulePathToString(modulePath);
    const utilId = modulePathToString(utilPath);
    const dependency = { kind: "use" as const, path: utilPath, span };
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

    const exportedSymbol = 77;
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
    expect(typeof utilSymbol).toBe("number");
    if (typeof utilSymbol !== "number") return;

    const helpers = binding.moduleMembers.get(utilSymbol)?.get("helper");
    expect(helpers?.size).toBe(1);
    const helperSymbol = helpers ? Array.from(helpers)[0] : undefined;
    expect(typeof helperSymbol).toBe("number");

    const importEntry = binding.imports.find(
      (entry) => entry.local === helperSymbol
    );
    expect(importEntry?.target?.moduleId).toBe(utilId);
    expect(importEntry?.target?.symbol).toBe(exportedSymbol);
    expect(importEntry?.visibility.level).toBe("module");
    expect(binding.diagnostics).toHaveLength(0);
  });

  it("reports a clear diagnostic when module and value imports collide by name", () => {
    const source = "use self::compare\nuse self::compare::all";
    const ast = parse(source, "pkg.voyd");
    const useForm = ast.rest.find((entry) => isForm(entry) && entry.calls("use")) as
      | Form
      | undefined;
    const span = toSourceSpan(useForm ?? ast);
    const modulePath = { namespace: "src" as const, segments: ["main"] as const };
    const moduleId = modulePathToString(modulePath);
    const comparePath = {
      namespace: "src" as const,
      segments: ["main", "compare"] as const,
    };
    const compareId = modulePathToString(comparePath);
    const moduleNode: ModuleNode = {
      id: moduleId,
      path: modulePath,
      origin: { kind: "file", filePath: "pkg.voyd" },
      ast,
      source,
      dependencies: [{ kind: "export", path: comparePath, span }],
    };
    const graph: ModuleGraph = {
      entry: moduleId,
      modules: new Map([[moduleId, moduleNode]]),
      diagnostics: [],
    };
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    symbolTable.declare({
      name: "pkg.voyd",
      kind: "module",
      declaredAt: ast.syntaxId,
    });

    const moduleExports: Map<string, ModuleExportTable> = new Map([
      [
        compareId,
        new Map([
          [
            "compare",
            {
              name: "compare",
              symbol: 99,
              overloadSet: 0,
              moduleId: compareId,
              modulePath: comparePath,
              packageId: packageIdFromPath(comparePath),
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

    const conflict = binding.diagnostics.find(
      (diag) =>
        diag.code === "BD0001" &&
        diag.message.includes("Cannot import compare as value"),
    );
    expect(conflict).toBeDefined();
  });

  it("reports overload-name collisions for top-level non-function declarations", () => {
    const source = [
      "fn add(a: i32) -> i32",
      "  a",
      "fn add(a: i32, b: i32) -> i32",
      "  a + b",
      "type add = i32",
    ].join("\n");
    const ast = parse(source, "main.voyd");
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    symbolTable.declare({
      name: "main.voyd",
      kind: "module",
      declaredAt: ast.syntaxId,
    });

    const binding = runBindingPipeline({
      moduleForm: ast,
      symbolTable,
    });

    expect(
      binding.diagnostics.some(
        (diag) =>
          diag.code === "BD0003" &&
          diag.message.includes("cannot declare add; overloads with this name"),
      ),
    ).toBe(true);
  });

  it("rejects cross-package imports of package-visible exports", () => {
    const source = "use pkg::dep::Thing";
    const ast = parse(source, "main.voyd");
    const useForm = ast.rest.find((entry) => isForm(entry) && entry.calls("use")) as Form | undefined;
    const span = toSourceSpan(useForm ?? ast);
    const modulePath = { namespace: "src" as const, segments: ["main"] as const };
    const moduleId = modulePathToString(modulePath);
    const depPath = {
      namespace: "pkg" as const,
      packageName: "dep",
      segments: ["pkg"] as const,
    };
    const depId = modulePathToString(depPath);
    const moduleNode: ModuleNode = {
      id: moduleId,
      path: modulePath,
      origin: { kind: "file", filePath: "main.voyd" },
      ast,
      source,
      dependencies: [{ kind: "use", path: depPath, span }],
    };
    const graph: ModuleGraph = {
      entry: moduleId,
      modules: new Map([[moduleId, moduleNode]]),
      diagnostics: [],
    };
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    symbolTable.declare({
      name: "main.voyd",
      kind: "module",
      declaredAt: ast.syntaxId,
    });

    const moduleExports: Map<string, ModuleExportTable> = new Map([
      [
        depId,
        new Map([
          [
            "Thing",
            {
              name: "Thing",
              symbol: 99,
              moduleId: depId,
              modulePath: depPath,
              packageId: packageIdFromPath(depPath),
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

    expect(binding.imports).toHaveLength(0);
    expect(binding.diagnostics.some((diag) => diag.code === "BD0001")).toBe(
      true
    );
  });

  it("binds trait declarations and trait targets on impl blocks", () => {
    const name = "trait_area.voyd";
    const ast = loadAst(name);
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    symbolTable.declare({ name, kind: "module", declaredAt: ast.syntaxId });

    const binding = runBindingPipeline({ moduleForm: ast, symbolTable });

    expect(binding.traits).toHaveLength(1);
    const trait = binding.traits[0]!;
    expect(symbolTable.getSymbol(trait.symbol).kind).toBe("trait");
    const traitScope =
      trait.form && binding.scopeByNode.get(trait.form.syntaxId);
    expect(traitScope).toBeDefined();
    if (traitScope) {
      expect(symbolTable.getScope(traitScope).kind).toBe("trait");
    }

    const methodNames = trait.methods.map(
      (method) => symbolTable.getSymbol(method.symbol).name
    );
    expect(methodNames).toEqual(["area", "double_area"]);
    const areaMethod = trait.methods.find(
      (method) => symbolTable.getSymbol(method.symbol).name === "area"
    );
    const doubleMethod = trait.methods.find(
      (method) => symbolTable.getSymbol(method.symbol).name === "double_area"
    );
    expect(areaMethod?.defaultBody).toBeUndefined();
    expect(doubleMethod?.defaultBody).toBeDefined();
    expect(doubleMethod?.params[0]?.name).toBe("self");

    const impl = binding.impls[0];
    expect(impl?.trait).toBeDefined();
    expect(isIdentifierAtom(impl?.trait) && impl?.trait.value).toBe("Area");
  });

  it("keeps trait method scopes intact when default methods are injected into impls", () => {
    const name = "trait_default_scope.voyd";
    const ast = loadAst(name);
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    symbolTable.declare({ name, kind: "module", declaredAt: ast.syntaxId });

    const binding = runBindingPipeline({ moduleForm: ast, symbolTable });

    const trait = binding.traits.find(
      (entry) => symbolTable.getSymbol(entry.symbol).name === "Area"
    );
    expect(trait).toBeDefined();
    if (!trait) return;

    const doubleMethod = trait.methods.find(
      (method) => symbolTable.getSymbol(method.symbol).name === "double_area"
    );
    expect(doubleMethod).toBeDefined();
    if (!doubleMethod) return;

    const recordedScope = binding.scopeByNode.get(doubleMethod.form!.syntaxId);
    expect(recordedScope).toBe(doubleMethod.scope);

    const implInjected = binding.functions.find(
      (fn) =>
        symbolTable.getSymbol(fn.symbol).name === "double_area" &&
        typeof fn.implId === "number"
    );
    expect(implInjected).toBeDefined();
    if (!implInjected) return;
    expect(implInjected.scope).not.toBe(doubleMethod.scope);
  });

  it("preserves helper overload sets for imported trait default methods", () => {
    const depPath = {
      namespace: "pkg" as const,
      packageName: "dep" as const,
      segments: ["pkg"] as const,
    };
    const depId = modulePathToString(depPath);
    const depSource = `
pub fn choose({ value: i32 }) -> bool
  true

pub fn choose({ value: bool }) -> bool
  value

pub trait Eq<T>
  fn eq(self, { other: T }) -> bool

  fn '=='(self, other: T) -> bool
    choose(value: self.eq(other: other))
`;
    const depAst = parse(depSource, depId);
    const depSymbolTable = new SymbolTable({ rootOwner: depAst.syntaxId });
    depSymbolTable.declare({ name: depId, kind: "module", declaredAt: depAst.syntaxId });
    const depModule: ModuleNode = {
      id: depId,
      path: depPath,
      origin: { kind: "file", filePath: depId },
      ast: depAst,
      source: depSource,
      dependencies: [],
    };
    const depGraph: ModuleGraph = {
      entry: depId,
      modules: new Map([[depId, depModule]]),
      diagnostics: [],
    };
    const depBinding = runBindingPipeline({
      moduleForm: depAst,
      symbolTable: depSymbolTable,
      module: depModule,
      graph: depGraph,
    });
    expect(depBinding.diagnostics).toHaveLength(0);

    const traitSymbol = depSymbolTable.resolve("Eq", depSymbolTable.rootScope);
    expect(typeof traitSymbol).toBe("number");
    if (typeof traitSymbol !== "number") return;

    const depExports: ModuleExportTable = new Map([
      [
        "Eq",
        {
          name: "Eq",
          symbol: traitSymbol,
          moduleId: depId,
          modulePath: depPath,
          packageId: packageIdFromPath(depPath),
          kind: "trait",
          visibility: publicVisibility(),
        },
      ],
    ]);

    const mainPath = {
      namespace: "src" as const,
      segments: ["main"] as const,
    };
    const mainId = modulePathToString(mainPath);
    const mainSource = `
use pkg::dep::Eq

obj Box {
  value: i32
}

impl Eq<Box> for Box
  fn eq(self, { other: Box }) -> bool
    self.value == other.value
`;
    const mainAst = parse(mainSource, mainId);
    const useForm = mainAst.rest.find((entry) => isForm(entry) && entry.calls("use"));
    const mainSymbolTable = new SymbolTable({ rootOwner: mainAst.syntaxId });
    mainSymbolTable.declare({
      name: mainId,
      kind: "module",
      declaredAt: mainAst.syntaxId,
    });
    const mainModule: ModuleNode = {
      id: mainId,
      path: mainPath,
      origin: { kind: "file", filePath: mainId },
      ast: mainAst,
      source: mainSource,
      dependencies: [
        {
          kind: "use",
          path: depPath,
          span: toSourceSpan(useForm ?? mainAst),
        },
      ],
    };
    const mainGraph: ModuleGraph = {
      entry: mainId,
      modules: new Map([[mainId, mainModule]]),
      diagnostics: [],
    };

    const mainBinding = runBindingPipeline({
      moduleForm: mainAst,
      symbolTable: mainSymbolTable,
      module: mainModule,
      graph: mainGraph,
      moduleExports: new Map([[depId, depExports]]),
      dependencies: new Map([[depId, depBinding]]),
    });

    expect(mainBinding.diagnostics).toHaveLength(0);

    const eqOperator = mainBinding.functions.find(
      (fn) =>
        mainSymbolTable.getSymbol(fn.symbol).name === "==" &&
        typeof fn.implId === "number",
    );
    expect(eqOperator).toBeDefined();
    if (!eqOperator) return;

    const importedScope = mainSymbolTable.getScope(eqOperator.scope).parent;
    expect(typeof importedScope).toBe("number");
    if (typeof importedScope !== "number") return;

    const chooseLocals = Array.from(mainSymbolTable.symbolsInScope(importedScope)).filter(
      (symbol) => mainSymbolTable.getSymbol(symbol).name === "choose",
    );
    expect(chooseLocals).toHaveLength(2);

    const overloadSetIds = new Set(
      chooseLocals
        .map((symbol) => mainBinding.overloadBySymbol.get(symbol))
        .filter((id): id is number => typeof id === "number"),
    );
    expect(overloadSetIds.size).toBe(1);
    const overloadSetId = Array.from(overloadSetIds)[0];
    expect(typeof overloadSetId).toBe("number");
    if (typeof overloadSetId !== "number") return;

    const importedOptions = mainBinding.importedOverloadOptions.get(overloadSetId);
    expect(importedOptions).toBeDefined();
    if (!importedOptions) return;
    expect(new Set(importedOptions)).toEqual(new Set(chooseLocals));
  });

  it("applies default trait methods for impls with trait type arguments", () => {
    const name = "trait_generic_defaults.voyd";
    const ast = loadAst(name);
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    symbolTable.declare({ name, kind: "module", declaredAt: ast.syntaxId });

    const binding = runBindingPipeline({ moduleForm: ast, symbolTable });

    const impl = binding.impls[0];
    expect(impl).toBeDefined();
    const methodNames = impl?.methods.map(
      (method) => symbolTable.getSymbol(method.symbol).name
    );
    expect(methodNames).toContain("get");
    expect(methodNames).toContain("copy");
  });

  it("injects only missing default overloads for same-name trait methods", () => {
    const name = "trait_default_overload_injection.voyd";
    const ast = loadAst(name);
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    symbolTable.declare({ name, kind: "module", declaredAt: ast.syntaxId });

    const binding = runBindingPipeline({ moduleForm: ast, symbolTable });
    const impl = binding.impls[0];
    expect(impl).toBeDefined();
    if (!impl) return;

    const parseMethods = impl.methods.filter(
      (method) => symbolTable.getSymbol(method.symbol).name === "parse",
    );
    expect(parseMethods).toHaveLength(2);
  });

  it("resolves self-relative use declarations using module export dependencies", () => {
    const source = "use self::util::all";
    const ast = parse(source, "main.voyd");
    const useForm = ast.rest.find((entry) => isForm(entry) && entry.calls("use"));
    expect(useForm).toBeDefined();
    if (!isForm(useForm)) return;

    const modulePath = { namespace: "src" as const, segments: ["main"] as const };
    const utilPath = {
      namespace: "src" as const,
      segments: ["main", "util"] as const,
    };
    const moduleId = modulePathToString(modulePath);
    const utilId = modulePathToString(utilPath);
    const dependencies: ModuleDependency[] = [
      { kind: "export", path: utilPath, span: toSourceSpan(useForm) },
    ];
    const moduleNode: ModuleNode = {
      id: moduleId,
      path: modulePath,
      origin: { kind: "file", filePath: "main.voyd" },
      ast,
      source,
      dependencies,
    };
    const graph: ModuleGraph = {
      entry: moduleId,
      modules: new Map([[moduleId, moduleNode]]),
      diagnostics: [],
    };
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    symbolTable.declare({ name: "main.voyd", kind: "module", declaredAt: ast.syntaxId });
    const exportedSymbol = 42;
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

    const [use] = binding.uses;
    expect(use.entries[0]?.moduleId).toBe(utilId);
    const helperSymbol = symbolTable.resolve("helper", symbolTable.rootScope);
    expect(helperSymbol).toBeDefined();
    if (!helperSymbol) return;
    const helperImport = symbolTable.getSymbol(helperSymbol)
      .metadata as { import?: { moduleId: string } } | undefined;

    expect(helperImport?.import?.moduleId).toBe(utilId);
  });

  it("preserves grouped self-relative selections when importing submodules", () => {
    const source = "use self::util::{self, helpers::math as math}";
    const ast = parse(source, "grouped.voyd");
    const useForm = ast.rest.find((entry) => isForm(entry) && entry.calls("use"));
    expect(useForm).toBeDefined();
    if (!isForm(useForm)) return;
    const span = toSourceSpan(useForm);

    const modulePath = { namespace: "src" as const, segments: ["grouped"] as const };
    const utilPath = {
      namespace: "src" as const,
      segments: ["grouped", "util"] as const,
    };
    const mathPath = {
      namespace: "src" as const,
      segments: ["grouped", "util", "helpers", "math"] as const,
    };
    const moduleId = modulePathToString(modulePath);
    const utilId = modulePathToString(utilPath);
    const mathId = modulePathToString(mathPath);
    const dependencies: ModuleDependency[] = [
      { kind: "export", path: utilPath, span },
      { kind: "export", path: mathPath, span },
    ];
    const moduleNode: ModuleNode = {
      id: moduleId,
      path: modulePath,
      origin: { kind: "file", filePath: "grouped.voyd" },
      ast,
      source,
      dependencies,
    };
    const graph: ModuleGraph = {
      entry: moduleId,
      modules: new Map([[moduleId, moduleNode]]),
      diagnostics: [],
    };
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    symbolTable.declare({ name: "grouped.voyd", kind: "module", declaredAt: ast.syntaxId });
    const exportedSymbol = 43;
    const moduleExports: Map<string, ModuleExportTable> = new Map([
      [
        mathId,
        new Map([
          [
            "math",
            {
              name: "math",
              symbol: exportedSymbol,
              moduleId: mathId,
              modulePath: mathPath,
              packageId: packageIdFromPath(mathPath),
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

    const [use] = binding.uses;
    expect(use.entries.map((entry) => entry.selectionKind)).toEqual([
      "module",
      "name",
    ]);
    expect(use.entries[0]?.moduleId).toBe(utilId);
    expect(use.entries[1]?.moduleId).toBe(mathId);
    expect(use.entries[1]?.alias).toBe("math");

    const mathImportSymbol = symbolTable.resolve("math", symbolTable.rootScope);
    expect(mathImportSymbol).toBeDefined();
    if (!mathImportSymbol) return;
    const mathImport = symbolTable.getSymbol(mathImportSymbol)
      .metadata as { import?: { moduleId: string } } | undefined;

    expect(mathImport?.import?.moduleId).toBe(mathId);
  });

  it("treats std submodule alias member imports as explicit std-submodule imports", () => {
    const source = "use std::memory::self as memory\nuse memory::Buffer";
    const ast = parse(source, "main.voyd");
    const useForm = ast.rest.find((entry) => isForm(entry) && entry.calls("use"));
    expect(useForm).toBeDefined();
    if (!isForm(useForm)) return;
    const span = toSourceSpan(useForm);

    const modulePath = { namespace: "src" as const, segments: ["main"] as const };
    const memoryPath = { namespace: "std" as const, segments: ["memory"] as const };
    const moduleId = modulePathToString(modulePath);
    const memoryId = modulePathToString(memoryPath);
    const dependencies: ModuleDependency[] = [{ kind: "use", path: memoryPath, span }];
    const moduleNode: ModuleNode = {
      id: moduleId,
      path: modulePath,
      origin: { kind: "file", filePath: "main.voyd" },
      ast,
      source,
      dependencies,
    };
    const graph: ModuleGraph = {
      entry: moduleId,
      modules: new Map([[moduleId, moduleNode]]),
      diagnostics: [],
    };
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    symbolTable.declare({ name: "main.voyd", kind: "module", declaredAt: ast.syntaxId });
    const exportedSymbol = 44;
    const moduleExports: Map<string, ModuleExportTable> = new Map([
      [
        memoryId,
        new Map([
          [
            "Buffer",
            {
              name: "Buffer",
              symbol: exportedSymbol,
              moduleId: memoryId,
              modulePath: memoryPath,
              packageId: packageIdFromPath(memoryPath),
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

    expect(binding.diagnostics).toHaveLength(0);

    const importedBufferSymbol = symbolTable.resolve("Buffer", symbolTable.rootScope);
    expect(importedBufferSymbol).toBeDefined();
    if (!importedBufferSymbol) return;
    const importedBuffer = symbolTable.getSymbol(importedBufferSymbol)
      .metadata as { import?: { moduleId: string } } | undefined;

    expect(importedBuffer?.import?.moduleId).toBe(memoryId);
  });

  it("populates module graph dependencies for grouped self-relative selections", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}grouped.voyd`]: "use self::util::{self, helpers::math as math}",
      [`${root}${sep}grouped${sep}util.voyd`]: "",
      [`${root}${sep}grouped${sep}util${sep}helpers${sep}math.voyd`]: "pub fn math()\n  1",
    });

    const graph = await buildModuleGraph({
      entryPath: `${root}${sep}grouped.voyd`,
      host,
      roots: { src: root },
    });

    expect(graph.diagnostics).toHaveLength(0);
    const moduleNode = graph.modules.get(graph.entry);
    expect(moduleNode).toBeDefined();
    if (!moduleNode) return;

    const symbolTable = new SymbolTable({ rootOwner: moduleNode.ast.syntaxId });
    symbolTable.declare({
      name: "grouped.voyd",
      kind: "module",
      declaredAt: moduleNode.ast.syntaxId,
    });

    const mathId = "src::grouped::util::helpers::math";
    const moduleExports: Map<string, ModuleExportTable> = new Map([
      [
        mathId,
        new Map([
          [
            "math",
            {
              name: "math",
              symbol: 1,
              moduleId: mathId,
              modulePath: {
                namespace: "src" as const,
                segments: ["grouped", "util", "helpers", "math"] as const,
              },
              packageId: packageIdFromPath({
                namespace: "src" as const,
                segments: ["grouped", "util", "helpers", "math"] as const,
              }),
              kind: "value",
              visibility: packageVisibility(),
            },
          ],
        ]),
      ],
    ]);

    const binding = runBindingPipeline({
      moduleForm: moduleNode.ast,
      symbolTable,
      module: moduleNode,
      graph,
      moduleExports,
    });

    const [use] = binding.uses;
    expect(use.entries.map((entry) => entry.selectionKind)).toEqual([
      "module",
      "name",
    ]);
    expect(use.entries[0]?.moduleId).toBe("src::grouped::util");
    expect(use.entries[1]?.moduleId).toBe(mathId);
    expect(use.entries[1]?.alias).toBe("math");
  });

  it("prefers nested export modules when resolving self-relative use paths", () => {
    const source = "pub use self::inner";
    const ast = parse(source, "outer.voyd");

    const modulePath = { namespace: "src" as const, segments: ["outer"] as const };
    const moduleId = modulePathToString(modulePath);

    const innerUsePath = { namespace: "src" as const, segments: ["inner"] as const };
    const innerNestedPath = {
      namespace: "src" as const,
      segments: ["outer", "inner"] as const,
    };
    const nestedId = modulePathToString(innerNestedPath);

    const dependencies: ModuleDependency[] = [
      { kind: "use", path: innerUsePath },
      { kind: "export", path: innerNestedPath },
    ];

    const moduleNode: ModuleNode = {
      id: moduleId,
      path: modulePath,
      origin: { kind: "file", filePath: "outer.voyd" },
      ast,
      source,
      dependencies,
    };

    const graph: ModuleGraph = {
      entry: moduleId,
      modules: new Map([[moduleId, moduleNode]]),
      diagnostics: [],
    };

    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    symbolTable.declare({ name: "outer.voyd", kind: "module", declaredAt: ast.syntaxId });

    const binding = runBindingPipeline({
      moduleForm: ast,
      symbolTable,
      module: moduleNode,
      graph,
      moduleExports: new Map(),
    });

    const [use] = binding.uses;
    expect(use?.entries[0]?.moduleId).toBe(nestedId);
    const innerSymbol = symbolTable.resolve("inner", symbolTable.rootScope);
    expect(innerSymbol).toBeDefined();
    if (typeof innerSymbol !== "number") return;
    const innerImport = symbolTable.getSymbol(innerSymbol)
      .metadata as { import?: { moduleId: string } } | undefined;
    expect(innerImport?.import?.moduleId).toBe(nestedId);
  });

  it("keeps pub use name imports in local scope while exporting them", () => {
    const source = "pub use self::inner::Thing";
    const ast = parse(source, "outer.voyd");

    const modulePath = { namespace: "src" as const, segments: ["outer"] as const };
    const moduleId = modulePathToString(modulePath);
    const innerPath = {
      namespace: "src" as const,
      segments: ["outer", "inner"] as const,
    };
    const innerId = modulePathToString(innerPath);
    const dependencies: ModuleDependency[] = [{ kind: "export", path: innerPath }];

    const moduleNode: ModuleNode = {
      id: moduleId,
      path: modulePath,
      origin: { kind: "file", filePath: "outer.voyd" },
      ast,
      source,
      dependencies,
    };

    const graph: ModuleGraph = {
      entry: moduleId,
      modules: new Map([[moduleId, moduleNode]]),
      diagnostics: [],
    };

    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    symbolTable.declare({ name: "outer.voyd", kind: "module", declaredAt: ast.syntaxId });

    const moduleExports: Map<string, ModuleExportTable> = new Map([
      [
        innerId,
        new Map([
          [
            "Thing",
            {
              name: "Thing",
              symbol: 1,
              moduleId: innerId,
              modulePath: innerPath,
              packageId: packageIdFromPath(innerPath),
              kind: "type",
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

    const useDecl = binding.uses[0];
    expect(useDecl?.visibility.level).toBe("package");
    expect(useDecl?.entries[0]?.imports).toHaveLength(1);
    const importedSymbol = symbolTable.resolve("Thing", symbolTable.rootScope);
    expect(typeof importedSymbol).toBe("number");
  });

  it("supports bare pub module-expression exports", () => {
    const source = "pub self::inner::Thing";
    const ast = parse(source, "outer.voyd");

    const modulePath = { namespace: "src" as const, segments: ["outer"] as const };
    const moduleId = modulePathToString(modulePath);
    const innerPath = {
      namespace: "src" as const,
      segments: ["outer", "inner"] as const,
    };
    const innerId = modulePathToString(innerPath);
    const dependencies: ModuleDependency[] = [{ kind: "export", path: innerPath }];

    const moduleNode: ModuleNode = {
      id: moduleId,
      path: modulePath,
      origin: { kind: "file", filePath: "outer.voyd" },
      ast,
      source,
      dependencies,
    };

    const graph: ModuleGraph = {
      entry: moduleId,
      modules: new Map([[moduleId, moduleNode]]),
      diagnostics: [],
    };

    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    symbolTable.declare({ name: "outer.voyd", kind: "module", declaredAt: ast.syntaxId });

    const moduleExports: Map<string, ModuleExportTable> = new Map([
      [
        innerId,
        new Map([
          [
            "Thing",
            {
              name: "Thing",
              symbol: 1,
              moduleId: innerId,
              modulePath: innerPath,
              packageId: packageIdFromPath(innerPath),
              kind: "type",
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

    const useDecl = binding.uses[0];
    expect(useDecl?.visibility.level).toBe("package");
    expect(useDecl?.entries[0]?.imports).toHaveLength(1);
    const importedSymbol = symbolTable.resolve("Thing", symbolTable.rootScope);
    expect(typeof importedSymbol).toBe("number");
  });

  it("resolves super-relative uses against the parent directory, not submodules", () => {
    const source = "use super::utils";
    const ast = parse(source, "bar.voyd");

    const modulePath = {
      namespace: "src" as const,
      segments: ["utils", "bar"] as const,
    };
    const moduleId = modulePathToString(modulePath);
    const siblingPath = {
      namespace: "src" as const,
      segments: ["utils", "utils"] as const,
    };
    const siblingId = modulePathToString(siblingPath);
    const submodulePath = {
      namespace: "src" as const,
      segments: ["utils", "bar", "utils"] as const,
    };

    const dependencies: ModuleDependency[] = [
      { kind: "use", path: siblingPath },
      { kind: "export", path: submodulePath },
    ];

    const moduleNode: ModuleNode = {
      id: moduleId,
      path: modulePath,
      origin: { kind: "file", filePath: "bar.voyd" },
      ast,
      source,
      dependencies,
    };
    const graph: ModuleGraph = {
      entry: moduleId,
      modules: new Map([[moduleId, moduleNode]]),
      diagnostics: [],
    };
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    symbolTable.declare({ name: "bar.voyd", kind: "module", declaredAt: ast.syntaxId });

    const binding = runBindingPipeline({
      moduleForm: ast,
      symbolTable,
      module: moduleNode,
      graph,
      moduleExports: new Map(),
    });

    const [use] = binding.uses;
    expect(use.entries[0]?.moduleId).toBe(siblingId);
  });

  it("reports duplicate local variable names in the same scope", () => {
    const source = `pub fn main() -> i32
  block
    let a = 1
    let a = 2
    a`;
    const ast = parse(source, "main.voyd");
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    symbolTable.declare({
      name: "main.voyd",
      kind: "module",
      declaredAt: ast.syntaxId,
    });

    const binding = runBindingPipeline({ moduleForm: ast, symbolTable });
    const diagnostics = binding.diagnostics.filter((entry) => entry.code === "BD0006");

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain("a");
    expect(diagnostics[0]?.related?.[0]?.code).toBe("BD0006");
    expect(diagnostics[0]?.related?.[0]?.severity).toBe("note");
  });

  it("reports duplicate function parameter names in the same scope", () => {
    const source = `pub fn sum(a: i32, a: i32) -> i32
  a`;
    const ast = parse(source, "main.voyd");
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    symbolTable.declare({
      name: "main.voyd",
      kind: "module",
      declaredAt: ast.syntaxId,
    });

    const binding = runBindingPipeline({ moduleForm: ast, symbolTable });
    const diagnostics = binding.diagnostics.filter((entry) => entry.code === "BD0006");

    expect(diagnostics).toHaveLength(1);
    const sum = binding.functions.find(
      (fn) => symbolTable.getSymbol(fn.symbol).name === "sum"
    );
    expect(sum?.params).toHaveLength(2);
  });

  it("keeps duplicate lambda parameter notes at the original form span", () => {
    const source = `pub fn main() -> i32
  let f = (~x, ~x) => x
  0`;
    const ast = parse(source, "main.voyd");
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    symbolTable.declare({
      name: "main.voyd",
      kind: "module",
      declaredAt: ast.syntaxId,
    });

    const binding = runBindingPipeline({ moduleForm: ast, symbolTable });
    const duplicate = binding.diagnostics.find(
      (entry) =>
        entry.code === "BD0006" && entry.message.includes("cannot redefine x"),
    );

    expect(duplicate).toBeDefined();
    expect(duplicate?.related?.[0]?.span.file).toBe("main.voyd");
    expect(duplicate?.related?.[0]?.span.start).toBeGreaterThan(0);
  });

  it("allows shadowing a binding in a nested scope", () => {
    const source = `pub fn main() -> i32
  let a = 1
  block
    let a = 2
    a`;
    const ast = parse(source, "main.voyd");
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    symbolTable.declare({
      name: "main.voyd",
      kind: "module",
      declaredAt: ast.syntaxId,
    });

    const binding = runBindingPipeline({ moduleForm: ast, symbolTable });
    const diagnostics = binding.diagnostics.filter((entry) => entry.code === "BD0006");
    expect(diagnostics).toHaveLength(0);
  });

  it("requires UpperCamelCase for type declaration names", () => {
    const source = `
type value_alias = i32

obj thing {}

trait watcher
  fn watch(self) -> i32

eff async_effect
  fn next() -> i32
`;
    const ast = parse(source, "main.voyd");
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    symbolTable.declare({ name: "main.voyd", kind: "module", declaredAt: ast.syntaxId });

    const binding = runBindingPipeline({ moduleForm: ast, symbolTable });
    const diagnostics = binding.diagnostics.filter((entry) => entry.code === "BD0007");
    const messages = diagnostics.map((entry) => entry.message);

    expect(diagnostics).toHaveLength(4);
    expect(messages).toEqual(
      expect.arrayContaining([
        "type alias value_alias must be UpperCamelCase",
        "obj thing must be UpperCamelCase",
        "trait watcher must be UpperCamelCase",
        "effect async_effect must be UpperCamelCase",
      ])
    );
  });

  it("reports unsupported mod declarations", () => {
    const source = "pub mod util";
    const ast = parse(source, "main.voyd");
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    symbolTable.declare({ name: "main.voyd", kind: "module", declaredAt: ast.syntaxId });

    const binding = runBindingPipeline({ moduleForm: ast, symbolTable });
    const diagnostic = binding.diagnostics.find((entry) => entry.code === "BD0005");
    expect(diagnostic).toBeDefined();
  });

  it("rejects bindings named void", () => {
    const source = "pub fn main() -> void\n  let void = 1";
    const ast = parse(source, "main.voyd");
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    symbolTable.declare({ name: "main.voyd", kind: "module", declaredAt: ast.syntaxId });

    expect(() => runBindingPipeline({ moduleForm: ast, symbolTable })).toThrow(
      /reserved identifier void/
    );
  });
});
