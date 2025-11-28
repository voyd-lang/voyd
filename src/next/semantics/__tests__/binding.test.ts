import { describe, expect, it } from "vitest";

import { SymbolTable } from "../binder/index.js";
import { runBindingPipeline } from "../binding/binding.js";
import { loadAst } from "./load-ast.js";
import { isForm, isIdentifierAtom } from "../../parser/index.js";

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
    expect(mainFn?.visibility).toBe("public");
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

  it("binds impl blocks and exposes methods as module-level functions", () => {
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
    expect(doubleSymbol).toBe(method.symbol);

    const implScope = binding.scopeByNode.get(impl.form!.syntaxId);
    expect(implScope).toBeDefined();
    if (implScope) {
      expect(symbolTable.getScope(implScope).kind).toBe("impl");
    }
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
});
