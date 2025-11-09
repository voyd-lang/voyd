import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "../../parser/index.js";
import { createSymbolTable } from "../binder/index.js";
import { runBindingPipeline } from "../binding/pipeline.js";

const loadAst = (relPath: string) => {
  const source = readFileSync(resolve(process.cwd(), relPath), "utf8");
  return parse(source, relPath);
};

describe("binding pipeline", () => {
  it("collects functions, parameters, and scopes for the fib sample module", () => {
    const relPath = "sb/fib.voyd";
    const ast = loadAst(relPath);
    const symbolTable = createSymbolTable({ rootOwner: ast.syntaxId });
    symbolTable.declare({
      name: relPath,
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
    expect(binding.symbolTable.resolve("fib", binding.symbolTable.rootScope)).toBe(fibFn!.symbol);
    expect(binding.symbolTable.resolve("main", binding.symbolTable.rootScope)).toBe(mainFn!.symbol);
  });
});
