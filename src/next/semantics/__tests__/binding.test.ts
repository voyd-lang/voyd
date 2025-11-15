import { describe, expect, it } from "vitest";

import { SymbolTable } from "../binder/index.js";
import { runBindingPipeline } from "../binding/pipeline.js";
import { loadAst } from "./load-ast.js";

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

    expect(binding.scopeByNode.get(fibFn!.form.syntaxId)).toBe(fibFn!.scope);
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
});
