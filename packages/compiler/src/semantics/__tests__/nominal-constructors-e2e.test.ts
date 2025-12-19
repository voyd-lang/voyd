import { describe, expect, it } from "vitest";
import { semanticsPipeline } from "../pipeline.js";
import type { ModuleGraph, ModuleNode } from "../../modules/types.js";
import { modulePathToString } from "../../modules/path.js";
import { loadAst } from "./load-ast.js";
import { toSourceSpan } from "../utils.js";
import { isForm } from "../../parser/index.js";

const buildModule = ({
  fixture,
  segments,
}: {
  fixture: string;
  segments: readonly string[];
}): { module: ModuleNode; graph: ModuleGraph } => {
  const ast = loadAst(fixture);
  const path = { namespace: "src" as const, segments };
  const id = modulePathToString(path);
  const module: ModuleNode = {
    id,
    path,
    origin: { kind: "file", filePath: fixture },
    ast,
    source: "",
    dependencies: [],
  };
  const graph: ModuleGraph = {
    entry: id,
    modules: new Map([[id, module]]),
    diagnostics: [],
  };
  return { module, graph };
};

describe("e2e: nominal constructor overloads", () => {
  it("binds, lowers, and types constructor overloads across modules", () => {
    const animal = buildModule({
      fixture: "nominal_constructors_overload_e2e/animal.voyd",
      segments: ["animal_e2e"],
    });
    const animalSemantics = semanticsPipeline({
      module: animal.module,
      graph: animal.graph,
    });
    expect(animalSemantics.diagnostics).toHaveLength(0);

    const mainAst = loadAst("nominal_constructors_overload_e2e/main.voyd");
    const useForm = mainAst.rest.find(
      (entry) => isForm(entry) && entry.calls("use")
    );
    const dependency = {
      kind: "use" as const,
      path: animal.module.path,
      span: toSourceSpan(useForm ?? mainAst),
    };
    const mainPath = { namespace: "src" as const, segments: ["main_e2e"] };
    const mainId = modulePathToString(mainPath);
    const mainModule: ModuleNode = {
      id: mainId,
      path: mainPath,
      origin: { kind: "file", filePath: "nominal_constructors_overload_e2e/main.voyd" },
      ast: mainAst,
      source: "",
      dependencies: [dependency],
    };
    const mainGraph: ModuleGraph = {
      entry: mainId,
      modules: new Map([[mainId, mainModule]]),
      diagnostics: [],
    };

    const mainSemantics = semanticsPipeline({
      module: mainModule,
      graph: mainGraph,
      exports: new Map([[animal.module.id, animalSemantics.exports]]),
      dependencies: new Map([[animal.module.id, animalSemantics]]),
    });

    expect(mainSemantics.diagnostics).toHaveLength(0);

    const animalSymbol = mainSemantics.symbolTable.resolve(
      "Animal",
      mainSemantics.symbolTable.rootScope
    );
    expect(typeof animalSymbol).toBe("number");
    if (typeof animalSymbol !== "number") return;
    const constructors =
      mainSemantics.binding.staticMethods.get(animalSymbol)?.get("init");
    expect(constructors?.size).toBe(3);

    const mainSymbol = mainSemantics.symbolTable.resolve(
      "main",
      mainSemantics.symbolTable.rootScope
    );
    expect(typeof mainSymbol).toBe("number");
    if (typeof mainSymbol !== "number") return;
    const scheme = mainSemantics.typing.table.getSymbolScheme(mainSymbol);
    expect(scheme).toBeDefined();
    const mainType = mainSemantics.typing.arena.instantiate(scheme!, []);
    const desc = mainSemantics.typing.arena.get(mainType);
    expect(desc.kind).toBe("function");
    if (desc.kind === "function") {
      const returnDesc = mainSemantics.typing.arena.get(desc.returnType);
      expect(returnDesc).toMatchObject({ kind: "primitive", name: "i32" });
    }
  });
});
