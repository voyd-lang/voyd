import { describe, expect, it } from "vitest";
import { type Expr, type Form, isForm, parse } from "../../../parser/index.js";
import type {
  ModuleDependency,
  ModuleGraph,
  ModuleNode,
  ModulePath,
} from "../../../modules/types.js";
import { modulePathToString } from "../../../modules/path.js";
import { semanticsPipeline } from "../../pipeline.js";
import { toSourceSpan } from "../../utils.js";
import { getSymbolTable } from "../../_internal/symbol-table.js";
import type { HirCallExpr, HirIdentifierExpr } from "../../hir/nodes.js";

const buildModule = ({
  source,
  path,
  dependencies = [],
  ast,
}: {
  source: string;
  path: ModulePath;
  dependencies?: ModuleDependency[];
  ast?: Form;
}): { module: ModuleNode; graph: ModuleGraph; ast: Form } => {
  const parsedAst = ast ?? parse(source, modulePathToString(path));
  const id = modulePathToString(path);
  const module: ModuleNode = {
    id,
    path,
    origin: { kind: "file", filePath: id },
    ast: parsedAst,
    source,
    dependencies,
  };
  const graph: ModuleGraph = {
    entry: id,
    modules: new Map([[id, module]]),
    diagnostics: [],
  };
  return { module, graph, ast: parsedAst };
};

const dependencyForUse = (ast: Form, path: ModulePath): ModuleDependency => {
  const useForm =
    isForm(ast.rest[0]) && ast.rest[0]!.calls("use")
      ? (ast.rest[0] as Expr)
      : ast.rest.find((entry) => isForm(entry) && entry.calls("use"));
  const span = toSourceSpan((useForm ?? ast)!);
  return { kind: "use", path, span };
};

describe("operator overloads across modules", () => {
  it("supports external generic operator overload targets with type arguments", () => {
    const externalPath: ModulePath = {
      namespace: "pkg",
      packageName: "dep",
      segments: ["pkg"],
    };
    const externalSource = `
pub obj Box<T> {
  api value: T
}

impl<T> Box<T>
  api fn '=='(self, other: Box<T>): () -> bool
    true
`;
    const external = buildModule({ source: externalSource, path: externalPath });
    const externalSemantics = semanticsPipeline({
      module: external.module,
      graph: external.graph,
    });

    const mainPath: ModulePath = { namespace: "src", segments: ["main"] };
    const mainSource = `
use pkg::dep::all

pub fn main(): () -> bool
  let a = Box<i32> { value: 1 }
  let b = Box<i32> { value: 2 }
  a == b
`;
    const mainAst = parse(mainSource, modulePathToString(mainPath));
    const main = buildModule({
      source: mainSource,
      path: mainPath,
      ast: mainAst,
      dependencies: [dependencyForUse(mainAst, externalPath)],
    });

    const result = semanticsPipeline({
      module: main.module,
      graph: main.graph,
      exports: new Map([[external.module.id, externalSemantics.exports]]),
      dependencies: new Map([[external.module.id, externalSemantics]]),
    });

    expect(result.diagnostics).toHaveLength(0);

    const symbolTable = getSymbolTable(result);
    const mainSymbol = symbolTable.resolve("main", symbolTable.rootScope);
    expect(typeof mainSymbol).toBe("number");
    if (typeof mainSymbol !== "number") {
      throw new Error("missing main symbol");
    }

    const callExpr = Array.from(result.hir.expressions.values()).find(
      (expr): expr is HirCallExpr => {
        if (expr.exprKind !== "call") {
          return false;
        }
        const callee = result.hir.expressions.get(expr.callee);
        if (!callee || callee.exprKind !== "identifier") {
          return false;
        }
        const name = symbolTable.getSymbol((callee as HirIdentifierExpr).symbol).name;
        return name === "==";
      }
    );
    expect(callExpr).toBeDefined();
    if (!callExpr) return;

    const expectedExport = externalSemantics.exports.get("==");
    expect(expectedExport).toBeDefined();
    const expectedSymbol = expectedExport?.symbols?.[0] ?? expectedExport?.symbol;
    expect(typeof expectedSymbol).toBe("number");
    if (typeof expectedSymbol !== "number") {
      throw new Error("missing external operator export symbol");
    }

    const instanceKey = `${mainSymbol}<>`;
    const target = result.typing.callTargets.get(callExpr.id)?.get(instanceKey);
    expect(target).toEqual({
      moduleId: external.module.id,
      symbol: expectedSymbol,
    });

    const argPlan = result.typing.callArgumentPlans
      .get(callExpr.id)
      ?.get(instanceKey);
    expect(argPlan).toEqual([
      { kind: "direct", argIndex: 0 },
      { kind: "direct", argIndex: 1 },
    ]);
  });
});
