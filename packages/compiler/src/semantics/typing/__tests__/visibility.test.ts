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
});
