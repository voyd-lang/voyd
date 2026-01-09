import { describe, expect, it } from "vitest";
import { loadAst } from "../../__tests__/load-ast.js";
import { runBindingPipeline } from "../../binding/binding.js";
import { SymbolTable } from "../../binder/index.js";
import { modulePathToString } from "../../../modules/path.js";
import type { ModuleDependency, ModuleGraph, ModuleNode } from "../../../modules/types.js";
import { toSourceSpan } from "../../utils.js";
import { semanticsPipeline } from "../../pipeline.js";
import { isForm } from "../../../parser/index.js";
import type { Form } from "../../../parser/index.js";
import { getSymbolTable } from "../../_internal/symbol-table.js";

const DEP_FIXTURE = "import_metadata/dep.voyd";
const MAIN_FIXTURE = "import_metadata/main.voyd";

type BuiltModule = {
  module: ModuleNode;
  graph: ModuleGraph;
  ast: ReturnType<typeof loadAst>;
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
  dependencies?: ModuleDependency[];
}): BuiltModule => {
  const parsedAst = ast ?? loadAst(fixture);
  const path = { namespace: "src" as const, segments };
  const module: ModuleNode = {
    id: modulePathToString(path),
    path,
    origin: { kind: "file", filePath: fixture },
    ast: parsedAst,
    source: "",
    dependencies,
  };
  const graph: ModuleGraph = {
    entry: module.id,
    modules: new Map([[module.id, module]]),
    diagnostics: [],
  };
  return { module, graph, ast: parsedAst };
};

const buildImportGraph = () => {
  const dep = buildModule({ fixture: DEP_FIXTURE, segments: ["dep"] });
  const depSemantics = semanticsPipeline({ module: dep.module, graph: dep.graph });

  const mainAst = loadAst(MAIN_FIXTURE);
  const firstUse = mainAst.rest.find(
    (entry): entry is Form => isForm(entry) && entry.calls("use")
  );
  const dependency = {
    kind: "use" as const,
    path: dep.module.path,
    span: toSourceSpan(firstUse ?? mainAst),
  };
  const main = buildModule({
    fixture: MAIN_FIXTURE,
    segments: ["main"],
    ast: mainAst,
    dependencies: [dependency],
  });

  return { dep, depSemantics, main };
};

describe("import metadata propagation", () => {
  it("copies intrinsic metadata when binding imported dependency symbols", () => {
    const { dep, depSemantics, main } = buildImportGraph();
    const symbolTable = new SymbolTable({ rootOwner: main.ast.syntaxId });

    runBindingPipeline({
      moduleForm: main.ast,
      symbolTable,
      module: main.module,
      graph: main.graph,
      moduleExports: new Map([[dep.module.id, depSemantics.exports]]),
      dependencies: new Map([[dep.module.id, depSemantics.binding]]),
    });

    const depIntrinsic = symbolTable.resolve(
      "dep_intrinsic",
      symbolTable.rootScope
    );
    expect(typeof depIntrinsic).toBe("number");
    if (typeof depIntrinsic !== "number") return;

    const metadata = symbolTable.getSymbol(depIntrinsic)
      .metadata as Record<string, unknown> | undefined;
    expect(metadata).toMatchObject({
      intrinsic: true,
      intrinsicName: "__dep_intrinsic_impl",
      intrinsicUsesSignature: true,
      entity: "function",
    });
  });

  it("carries entity metadata onto imported dependency types resolved during typing", () => {
    const { dep, depSemantics, main } = buildImportGraph();

    const mainSemantics = semanticsPipeline({
      module: main.module,
      graph: main.graph,
      exports: new Map([[dep.module.id, depSemantics.exports]]),
      dependencies: new Map([[dep.module.id, depSemantics]]),
    });

    expect(mainSemantics.diagnostics).toHaveLength(0);
    const externalSymbol = mainSemantics.typing.objects.resolveName("External");
    expect(typeof externalSymbol).toBe("number");
    if (typeof externalSymbol !== "number") return;

    const symbolTable = getSymbolTable(mainSemantics);
    const metadata = symbolTable.getSymbol(externalSymbol)
      .metadata as Record<string, unknown> | undefined;
    expect(metadata).toMatchObject({ entity: "object" });
    const importMetadata = (metadata?.import ?? {}) as {
      moduleId?: string;
      symbol?: number;
    };
    expect(importMetadata.moduleId).toBe(dep.module.id);
  });
});
