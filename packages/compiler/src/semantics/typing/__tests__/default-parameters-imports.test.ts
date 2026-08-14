import { describe, expect, it } from "vitest";
import { loadAst } from "../../__tests__/load-ast.js";
import { semanticsPipeline } from "../../pipeline.js";
import { modulePathToString } from "../../../modules/path.js";
import type {
  ModuleDependency,
  ModuleGraph,
  ModuleNode,
} from "../../../modules/types.js";
import { isForm, parse } from "../../../parser/index.js";
import type { Form } from "../../../parser/index.js";
import { toSourceSpan } from "../../utils.js";
import { getSymbolTable } from "../../_internal/symbol-table.js";

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

describe("default parameter import metadata", () => {
  it("preserves the declared type without requiring Optional in scope", () => {
    const dep = buildModule({
      fixture: DEP_FIXTURE,
      segments: ["dep"],
    });
    const depSemantics = semanticsPipeline({
      module: dep.module,
      graph: dep.graph,
    });

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
    expect(parameter?.optional).toBe(false);
    expect(parameter?.defaulted).toBe(true);
    if (!parameter) {
      return;
    }

    expect(parameter.type).toBe(mainSemantics.typing.primitives.i32);

    const planKinds = Array.from(
      mainSemantics.typing.callArgumentPlans.values(),
    ).flatMap((byInstance) =>
      Array.from(byInstance.values()).flatMap((plan) =>
        plan.map((entry) => entry.kind),
      ),
    );
    expect(planKinds).toContain("omitted-default");
    expect(planKinds).toContain("direct");
  });

  it("preserves generic result identity through imported signature translation", () => {
    const depAst = parse(
      `@result(detached)
pub fn relay<T>(value: T) -> i32
  0
`,
      "result-identity-import/dep.voyd",
    );
    const dep = buildModule({
      fixture: "result-identity-import/dep.voyd",
      segments: ["dep"],
      ast: depAst,
    });
    const depSemantics = semanticsPipeline({
      module: dep.module,
      graph: dep.graph,
    });

    const mainAst = parse(
      `use src::dep::all

fn consume(value: i32) -> i32
  relay(value)
`,
      "result-identity-import/main.voyd",
    );
    const use = mainAst.rest.find(
      (entry): entry is Form => isForm(entry) && entry.calls("use"),
    );
    const main = buildModule({
      fixture: "result-identity-import/main.voyd",
      segments: ["main"],
      ast: mainAst,
      dependencies: [
        {
          kind: "use",
          path: dep.module.path,
          span: toSourceSpan(use ?? mainAst),
        },
      ],
    });
    const semantics = semanticsPipeline({
      module: main.module,
      graph: main.graph,
      exports: new Map([[dep.module.id, depSemantics.exports]]),
      dependencies: new Map([[dep.module.id, depSemantics]]),
    });
    const symbols = getSymbolTable(semantics);
    const relay = symbols.resolve("relay", symbols.rootScope);
    expect(typeof relay).toBe("number");
    expect(
      typeof relay === "number"
        ? semantics.typing.functions.getSignature(relay)?.resultIdentity
        : undefined,
    ).toEqual({ kind: "detached" });
  });

  it("preserves staged access through imported signature translation", () => {
    const depAst = parse(
      `pub obj Box { api value: i32 }

@staged(into: out)
pub fn copy_value(source: Box, ~out: Box) -> i32
  let snapshot = source.value
  out.value = snapshot
  snapshot
`,
      "staged-access-import/dep.voyd",
    );
    const dep = buildModule({
      fixture: "staged-access-import/dep.voyd",
      segments: ["dep"],
      ast: depAst,
    });
    const depSemantics = semanticsPipeline({
      module: dep.module,
      graph: dep.graph,
    });
    const mainAst = parse(
      `use src::dep::all

fn update(~box: Box) -> i32
  copy_value(box, ~box)
`,
      "staged-access-import/main.voyd",
    );
    const use = mainAst.rest.find(
      (entry): entry is Form => isForm(entry) && entry.calls("use"),
    );
    const main = buildModule({
      fixture: "staged-access-import/main.voyd",
      segments: ["main"],
      ast: mainAst,
      dependencies: [
        {
          kind: "use",
          path: dep.module.path,
          span: toSourceSpan(use ?? mainAst),
        },
      ],
    });
    const semantics = semanticsPipeline({
      module: main.module,
      graph: main.graph,
      exports: new Map([[dep.module.id, depSemantics.exports]]),
      dependencies: new Map([[dep.module.id, depSemantics]]),
    });
    const symbols = getSymbolTable(semantics);
    const copy = symbols.resolve("copy_value", symbols.rootScope);
    expect(typeof copy).toBe("number");
    expect(
      typeof copy === "number"
        ? semantics.typing.functions.getSignature(copy)?.stagedAccess
        : undefined,
    ).toEqual({ destinationParameterIndex: 1 });
  });

  it("inherits an imported trait result contract on the implementation", () => {
    const depAst = parse(
      `pub trait Factory
  @result(fresh)
  fn build(self) -> i32
`,
      "result-identity-trait-import/dep.voyd",
    );
    const dep = buildModule({
      fixture: "result-identity-trait-import/dep.voyd",
      segments: ["dep"],
      ast: depAst,
    });
    const depSemantics = semanticsPipeline({
      module: dep.module,
      graph: dep.graph,
    });
    const mainAst = parse(
      `use src::dep::all

obj Maker {}

impl Factory for Maker
  fn build(self) -> i32
    0
`,
      "result-identity-trait-import/main.voyd",
    );
    const use = mainAst.rest.find(
      (entry): entry is Form => isForm(entry) && entry.calls("use"),
    );
    const main = buildModule({
      fixture: "result-identity-trait-import/main.voyd",
      segments: ["main"],
      ast: mainAst,
      dependencies: [
        {
          kind: "use",
          path: dep.module.path,
          span: toSourceSpan(use ?? mainAst),
        },
      ],
    });

    const semantics = semanticsPipeline({
      module: main.module,
      graph: main.graph,
      exports: new Map([[dep.module.id, depSemantics.exports]]),
      dependencies: new Map([[dep.module.id, depSemantics]]),
    });
    const implementation = Array.from(
      semantics.typing.traitMethodImpls.keys(),
    )[0];
    expect(
      implementation === undefined
        ? undefined
        : semantics.typing.functions.getSignature(implementation)
            ?.resultIdentity,
    ).toEqual({ kind: "fresh" });
  });
});
