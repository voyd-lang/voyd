import { describe, expect, it } from "vitest";
import { loadAst } from "../../__tests__/load-ast.js";
import { semanticsPipeline } from "../../pipeline.js";
import { modulePathToString } from "../../../modules/path.js";
import type {
  ModuleDependency,
  ModuleGraph,
  ModuleNode,
} from "../../../modules/types.js";
import { isForm } from "../../../parser/index.js";
import type { Form } from "../../../parser/index.js";
import { toSourceSpan } from "../../utils.js";
import { getSymbolTable } from "../../_internal/symbol-table.js";
import {
  getOptionalInfo,
  optionalResolverContextForTypingResultWithSymbolTable,
} from "../optionals.js";

const DEP_FIXTURE = "default_param_optional_import/dep.voyd";
const MAIN_FIXTURE = "default_param_optional_import/main.voyd";

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

describe("default parameter optional wrapper resolution", () => {
  it("resolves Optional imported from another module", () => {
    const dep = buildModule({
      fixture: DEP_FIXTURE,
      segments: ["dep"],
    });
    const depSemantics = semanticsPipeline({ module: dep.module, graph: dep.graph });

    const mainAst = loadAst(MAIN_FIXTURE);
    const firstUse = mainAst.rest.find(
      (entry): entry is Form => isForm(entry) && entry.calls("use"),
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

    const mainSemantics = semanticsPipeline({
      module: main.module,
      graph: main.graph,
      exports: new Map([[dep.module.id, depSemantics.exports]]),
      dependencies: new Map([[dep.module.id, depSemantics]]),
    });

    expect(mainSemantics.diagnostics).toHaveLength(0);

    const symbolTable = getSymbolTable(mainSemantics);
    const initSymbol = symbolTable.resolve("init", symbolTable.rootScope);
    expect(typeof initSymbol).toBe("number");
    if (typeof initSymbol !== "number") {
      return;
    }

    const signature = mainSemantics.typing.functions.getSignature(initSymbol);
    expect(signature).toBeDefined();
    if (!signature) {
      return;
    }

    const parameter = signature.parameters[0];
    expect(parameter?.optional).toBe(true);
    if (!parameter) {
      return;
    }

    const optionalInfo = getOptionalInfo(
      parameter.type,
      optionalResolverContextForTypingResultWithSymbolTable(
        mainSemantics.typing,
        symbolTable,
      ),
    );
    expect(optionalInfo).toBeDefined();
  });
});
