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
import { DiagnosticError } from "../../../diagnostics/index.js";
import { toSourceSpan } from "../../utils.js";
import { getSymbolTable } from "../../_internal/symbol-table.js";
import type { HirMethodCallExpr } from "../../hir/nodes.js";

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

const dependencyForUse = (
  ast: Form,
  path: ModulePath
): ModuleDependency => {
  const useForm = isForm(ast.rest[0]) && ast.rest[0]!.calls("use")
    ? (ast.rest[0] as Expr)
    : ast.rest.find((entry) => isForm(entry) && entry.calls("use"));
  const span = toSourceSpan((useForm ?? ast)!);
  return { kind: "use", path, span };
};

const externalPath: ModulePath = {
  namespace: "pkg",
  packageName: "dep",
  segments: ["pkg"],
};

const externalSource = `
pub obj External {
  api visible: i32,
  hidden: i32,
  pri secret: i32,
}

impl External
  api fn expose(self) -> i32
    self.visible

  fn internal(self) -> i32
    self.hidden

  pri fn hide(self) -> i32
    self.secret

pub fn make() -> External
  External { visible: 1, hidden: 2, secret: 3 }
`;

const localLibPath: ModulePath = { namespace: "src", segments: ["lib"] };

const localLibSource = `
pub obj Local {
  value: i32,
  pri secret: i32,
}

pub fn make() -> Local
  Local { value: 7, secret: 9 }
`;

const stdUtilPath: ModulePath = { namespace: "std", segments: ["util"] };
const stdUtilSource = `
pub fn id(): () -> i32
  1
`;

const stdPkgPath: ModulePath = { namespace: "std", segments: ["pkg"] };
const stdPkgSource = `
pub use std::util::all
`;

describe("typing visibility", () => {
  const external = buildModule({ source: externalSource, path: externalPath });
  const externalSemantics = semanticsPipeline({
    module: external.module,
    graph: external.graph,
  });

  const localLib = buildModule({
    source: localLibSource,
    path: localLibPath,
  });
  const localLibSemantics = semanticsPipeline({
    module: localLib.module,
    graph: localLib.graph,
  });

  const stdUtil = buildModule({
    source: stdUtilSource,
    path: stdUtilPath,
  });
  const stdUtilSemantics = semanticsPipeline({
    module: stdUtil.module,
    graph: stdUtil.graph,
  });

  const stdPkgAst = parse(stdPkgSource, modulePathToString(stdPkgPath));
  const stdPkg = buildModule({
    source: stdPkgSource,
    path: stdPkgPath,
    ast: stdPkgAst,
    dependencies: [dependencyForUse(stdPkgAst, stdUtilPath)],
  });
  const stdPkgSemantics = semanticsPipeline({
    module: stdPkg.module,
    graph: stdPkg.graph,
    exports: new Map([[stdUtil.module.id, stdUtilSemantics.exports]]),
    dependencies: new Map([[stdUtil.module.id, stdUtilSemantics]]),
  });

  it("allows package-visible members within the same package", () => {
    const mainPath: ModulePath = { namespace: "src", segments: ["main"] };
    const mainSource = `
use lib::all

pub fn read() -> i32
  make().value
`;
    const mainAst = parse(mainSource, modulePathToString(mainPath));
    const main = buildModule({
      source: mainSource,
      path: mainPath,
      ast: mainAst,
      dependencies: [dependencyForUse(mainAst, localLibPath)],
    });

    expect(() =>
      semanticsPipeline({
        module: main.module,
        graph: main.graph,
        exports: new Map([[localLib.module.id, localLibSemantics.exports]]),
        dependencies: new Map([[localLib.module.id, localLibSemantics]]),
      })
    ).not.toThrow();
  });

  it("rejects object-private members outside their impl even in the same package", () => {
    const mainPath: ModulePath = { namespace: "src", segments: ["main"] };
    const mainSource = `
use lib::all

pub fn read() -> i32
  make().secret
`;
    const mainAst = parse(mainSource, modulePathToString(mainPath));
    const main = buildModule({
      source: mainSource,
      path: mainPath,
      ast: mainAst,
      dependencies: [dependencyForUse(mainAst, localLibPath)],
    });

    let caught: unknown;
    try {
      semanticsPipeline({
        module: main.module,
        graph: main.graph,
        exports: new Map([[localLib.module.id, localLibSemantics.exports]]),
        dependencies: new Map([[localLib.module.id, localLibSemantics]]),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DiagnosticError);
    if (caught instanceof DiagnosticError) {
      expect(caught.diagnostic.code).toBe("TY0009");
    }
  });

  it("hides non-api members from external packages", () => {
    const mainPath: ModulePath = { namespace: "src", segments: ["consumer"] };
    const mainSource = `
use pkg::dep::all

pub fn leak() -> i32
  make().hidden
`;
    const mainAst = parse(mainSource, modulePathToString(mainPath));
    const main = buildModule({
      source: mainSource,
      path: mainPath,
      ast: mainAst,
      dependencies: [dependencyForUse(mainAst, externalPath)],
    });

    let caught: unknown;
    try {
      semanticsPipeline({
        module: main.module,
        graph: main.graph,
        exports: new Map([[external.module.id, externalSemantics.exports]]),
        dependencies: new Map([[external.module.id, externalSemantics]]),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DiagnosticError);
    if (caught instanceof DiagnosticError) {
      expect(caught.diagnostic.code).toBe("TY0009");
    }
  });

  it("prevents calling non-api or private methods across packages", () => {
    const mainPath: ModulePath = { namespace: "src", segments: ["methods"] };
    const mainSource = `
use pkg::dep::all

pub fn call_internal() -> i32
  make().internal()

pub fn call_private() -> i32
  make().hide()
`;
    const mainAst = parse(mainSource, modulePathToString(mainPath));
    const main = buildModule({
      source: mainSource,
      path: mainPath,
      ast: mainAst,
      dependencies: [dependencyForUse(mainAst, externalPath)],
    });

    let caught: unknown;
    try {
      semanticsPipeline({
        module: main.module,
        graph: main.graph,
        exports: new Map([[external.module.id, externalSemantics.exports]]),
        dependencies: new Map([[external.module.id, externalSemantics]]),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DiagnosticError);
    if (caught instanceof DiagnosticError) {
      expect(caught.diagnostic.code).toBe("TY0009");
    }
  });

  it("allows calling api methods across packages", () => {
    const mainPath: ModulePath = { namespace: "src", segments: ["api-methods"] };
    const mainSource = `
use pkg::dep::all

pub fn call() -> i32
  make().expose()
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

    const methodCall = Array.from(result.hir.expressions.values()).find(
      (expr): expr is HirMethodCallExpr =>
        expr.exprKind === "method-call" && expr.method === "expose"
    );
    expect(methodCall).toBeDefined();

    const symbolTable = getSymbolTable(result);
    const callSymbol = symbolTable.resolve("call", symbolTable.rootScope);
    expect(typeof callSymbol).toBe("number");
    if (typeof callSymbol !== "number" || !methodCall) return;

    const externalSymbols = getSymbolTable(externalSemantics);
    const exposeSymbol = Array.from(externalSemantics.hir.items.values()).find(
      (item) =>
        item.kind === "function" &&
        externalSymbols.getSymbol(item.symbol).name === "expose"
    )?.symbol;
    expect(typeof exposeSymbol).toBe("number");
    if (typeof exposeSymbol !== "number") return;

    const instanceKey = `${callSymbol}<>`;
    const target = result.typing.callTargets.get(methodCall.id)?.get(instanceKey);
    expect(target).toEqual({
      moduleId: external.module.id,
      symbol: exposeSymbol,
    });
  });

  it("rejects constructing external types that require hidden fields", () => {
    const mainPath: ModulePath = { namespace: "src", segments: ["construct"] };
    const mainSource = `
use pkg::dep::all

pub fn build() -> External
  External { visible: 5 }
`;
    const mainAst = parse(mainSource, modulePathToString(mainPath));
    const main = buildModule({
      source: mainSource,
      path: mainPath,
      ast: mainAst,
      dependencies: [dependencyForUse(mainAst, externalPath)],
    });

    let caught: unknown;
    try {
      semanticsPipeline({
        module: main.module,
        graph: main.graph,
        exports: new Map([[external.module.id, externalSemantics.exports]]),
        dependencies: new Map([[external.module.id, externalSemantics]]),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DiagnosticError);
    if (caught instanceof DiagnosticError) {
      expect(caught.diagnostic.code).toBe("TY0010");
    }
  });

  it("allows std module imports when exported from pkg.voyd", () => {
    const mainPath: ModulePath = { namespace: "src", segments: ["std-import"] };
    const mainSource = `
use std::util::all

pub fn read() -> i32
  id()
`;
    const mainAst = parse(mainSource, modulePathToString(mainPath));
    const main = buildModule({
      source: mainSource,
      path: mainPath,
      ast: mainAst,
      dependencies: [dependencyForUse(mainAst, stdUtilPath)],
    });

    expect(() =>
      semanticsPipeline({
        module: main.module,
        graph: main.graph,
        exports: new Map([
          [stdPkg.module.id, stdPkgSemantics.exports],
          [stdUtil.module.id, stdUtilSemantics.exports],
        ]),
        dependencies: new Map([
          [stdPkg.module.id, stdPkgSemantics],
          [stdUtil.module.id, stdUtilSemantics],
        ]),
      })
    ).not.toThrow();
  });

  it("allows std root imports from pkg exports", () => {
    const mainPath: ModulePath = { namespace: "src", segments: ["std-root"] };
    const mainSource = `
use std::{ id }

pub fn read() -> i32
  id()
`;
    const mainAst = parse(mainSource, modulePathToString(mainPath));
    const main = buildModule({
      source: mainSource,
      path: mainPath,
      ast: mainAst,
      dependencies: [dependencyForUse(mainAst, stdPkgPath)],
    });

    expect(() =>
      semanticsPipeline({
        module: main.module,
        graph: main.graph,
        exports: new Map([
          [stdPkg.module.id, stdPkgSemantics.exports],
          [stdUtil.module.id, stdUtilSemantics.exports],
        ]),
        dependencies: new Map([
          [stdPkg.module.id, stdPkgSemantics],
          [stdUtil.module.id, stdUtilSemantics],
        ]),
      })
    ).not.toThrow();
  });

  it("allows std module imports when pkg exports the module", () => {
    const moduleStdPkgSource = `
pub use util
`;
    const moduleStdPkgAst = parse(
      moduleStdPkgSource,
      modulePathToString(stdPkgPath)
    );
    const moduleStdPkg = buildModule({
      source: moduleStdPkgSource,
      path: stdPkgPath,
      ast: moduleStdPkgAst,
      dependencies: [dependencyForUse(moduleStdPkgAst, stdUtilPath)],
    });
    const moduleStdPkgSemantics = semanticsPipeline({
      module: moduleStdPkg.module,
      graph: moduleStdPkg.graph,
      exports: new Map([[stdUtil.module.id, stdUtilSemantics.exports]]),
      dependencies: new Map([[stdUtil.module.id, stdUtilSemantics]]),
    });

    const mainPath: ModulePath = { namespace: "src", segments: ["std-module"] };
    const mainSource = `
use std::util::{ id }

pub fn read() -> i32
  id()
`;
    const mainAst = parse(mainSource, modulePathToString(mainPath));
    const main = buildModule({
      source: mainSource,
      path: mainPath,
      ast: mainAst,
      dependencies: [dependencyForUse(mainAst, stdUtilPath)],
    });

    expect(() =>
      semanticsPipeline({
        module: main.module,
        graph: main.graph,
        exports: new Map([
          [moduleStdPkg.module.id, moduleStdPkgSemantics.exports],
          [stdUtil.module.id, stdUtilSemantics.exports],
        ]),
        dependencies: new Map([
          [moduleStdPkg.module.id, moduleStdPkgSemantics],
          [stdUtil.module.id, stdUtilSemantics],
        ]),
      })
    ).not.toThrow();
  });
});
