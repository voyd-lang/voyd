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
});
