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
  it("applies imported trait default operator methods to local impls", () => {
    const externalPath: ModulePath = {
      namespace: "pkg",
      packageName: "dep",
      segments: ["pkg"],
    };
    const externalSource = `
pub trait Eq<T>
  fn eq(self, { other: T }) -> bool

  fn ne(self, { other: T }) -> bool
    not self.eq(other: other)

  fn '=='(self, other: T) -> bool
    self.eq(other: other)

  fn '!='(self, other: T) -> bool
    self.ne(other: other)

pub trait Ord<T>
  fn cmp(self, { other: T }) -> i32

  fn '<'(self, other: T) -> bool
    self.cmp(other: other) < 0

  fn '<='(self, other: T) -> bool
    self.cmp(other: other) <= 0

  fn '>'(self, other: T) -> bool
    self.cmp(other: other) > 0

  fn '>='(self, other: T) -> bool
    self.cmp(other: other) >= 0
`;
    const external = buildModule({ source: externalSource, path: externalPath });
    const externalSemantics = semanticsPipeline({
      module: external.module,
      graph: external.graph,
    });

    const mainPath: ModulePath = { namespace: "src", segments: ["main"] };
    const mainSource = `
use pkg::dep::{ Eq, Ord }

obj Box {
  value: i32
}

impl Eq<Box> for Box
  fn eq(self, { other: Box }) -> bool
    self.value == other.value

impl Ord<Box> for Box
  fn cmp(self, { other: Box }) -> i32
    self.value - other.value

pub fn main(): () -> bool
  let a = Box { value: 1 }
  let b = Box { value: 2 }
  (a == a) and (a != b) and a.ne(other: b) and (a < b) and (a <= b) and (b > a) and (b >= a)
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
    expect(symbolTable.resolve("Less", symbolTable.rootScope)).toBeUndefined();
  });

  it("binds imported default operators without leaking trait module symbols", () => {
    const externalPath: ModulePath = {
      namespace: "pkg",
      packageName: "dep",
      segments: ["pkg"],
    };
    const externalSource = `
pub obj Less {}
pub obj Equal {}
pub obj Greater {}

pub type Ordering = Less | Equal | Greater

pub fn cmp_i32({ left: i32, right: i32 }) -> Ordering
  if left < right then:
    Less {}
  elif: left > right then:
    Greater {}
  else:
    Equal {}

pub trait Ord<T>
  fn cmp(self, { other: T }) -> Ordering

  fn '<'(self, other: T) -> bool
    self.cmp(other: other) is Less

  fn '<='(self, other: T) -> bool
    not (self.cmp(other: other) is Greater)

  fn '>'(self, other: T) -> bool
    self.cmp(other: other) is Greater

  fn '>='(self, other: T) -> bool
    not (self.cmp(other: other) is Less)
`;
    const external = buildModule({ source: externalSource, path: externalPath });
    const externalSemantics = semanticsPipeline({
      module: external.module,
      graph: external.graph,
    });

    const mainPath: ModulePath = { namespace: "src", segments: ["main"] };
    const mainSource = `
use pkg::dep::{ Ord, cmp_i32 }

obj Box {
  value: i32
}

impl Ord<Box> for Box
  fn cmp(self, { other: Box })
    cmp_i32(left: self.value, right: other.value)

pub fn main(): () -> bool
  let a = Box { value: 1 }
  let b = Box { value: 2 }
  (a < b) and (a <= b) and (b > a) and (b >= a)
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
  });

  it("does not implicitly import helper symbols used by imported trait defaults", () => {
    const externalPath: ModulePath = {
      namespace: "pkg",
      packageName: "dep",
      segments: ["pkg"],
    };
    const externalSource = `
pub fn helper_eq() -> bool
  true

pub trait Eq<T>
  fn eq(self, { other: T }) -> bool

  fn '=='(self, other: T) -> bool
    helper_eq() and self.eq(other: other)
`;
    const external = buildModule({ source: externalSource, path: externalPath });
    const externalSemantics = semanticsPipeline({
      module: external.module,
      graph: external.graph,
    });

    const mainPath: ModulePath = { namespace: "src", segments: ["main"] };
    const mainSource = `
use pkg::dep::Eq

obj Box {
  value: i32
}

impl Eq<Box> for Box
  fn eq(self, { other: Box }) -> bool
    self.value == other.value

pub fn main(): () -> bool
  let a = Box { value: 1 }
  let b = Box { value: 1 }
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
    expect(symbolTable.resolve("helper_eq", symbolTable.rootScope)).toBeUndefined();
  });

  it("keeps imported trait default method scopes isolated per local trait symbol", () => {
    const depAPath: ModulePath = {
      namespace: "src",
      segments: ["a"],
    };
    const depASource = `
pub trait Tag<T>
  fn tag(self) -> i32
`;
    const depA = buildModule({ source: depASource, path: depAPath });
    const depASemantics = semanticsPipeline({
      module: depA.module,
      graph: depA.graph,
    });

    const depBPath: ModulePath = {
      namespace: "src",
      segments: ["b"],
    };
    const depBSource = `
pub trait Tag<T>
  fn tag(self) -> i32
`;
    const depB = buildModule({ source: depBSource, path: depBPath });
    const depBSemantics = semanticsPipeline({
      module: depB.module,
      graph: depB.graph,
    });

    const mainPath: ModulePath = { namespace: "src", segments: ["main"] };
    const mainSource = `
use src::a::Tag as TagA
use src::b::Tag as TagB

obj Box {
  value: i32
}

impl TagA<Box> for Box
  fn tag(self) -> i32
    1

impl TagB<Box> for Box
  fn tag(self) -> i32
    2

pub fn main(): () -> bool
  let b = Box { value: 0 }
  (b.value == 0)
`;
    const mainAst = parse(mainSource, modulePathToString(mainPath));
    const main = buildModule({
      source: mainSource,
      path: mainPath,
      ast: mainAst,
      dependencies: [
        dependencyForUse(mainAst, depAPath),
        dependencyForUse(mainAst, depBPath),
      ],
    });

    const result = semanticsPipeline({
      module: main.module,
      graph: main.graph,
      exports: new Map([
        [depA.module.id, depASemantics.exports],
        [depB.module.id, depBSemantics.exports],
      ]),
      dependencies: new Map([
        [depA.module.id, depASemantics],
        [depB.module.id, depBSemantics],
      ]),
    });

    expect(result.diagnostics).toHaveLength(0);
  });

  it("falls back to intrinsic operators when imported overload sets have no match", () => {
    const externalPath: ModulePath = {
      namespace: "pkg",
      packageName: "dep",
      segments: ["pkg"],
    };
    const externalSource = `
pub fn '/'(left: i32, right: i32) -> i32
  left

pub fn '/'(left: i64, right: i64) -> i64
  left
`;
    const external = buildModule({ source: externalSource, path: externalPath });
    const externalSemantics = semanticsPipeline({
      module: external.module,
      graph: external.graph,
    });

    const mainPath: ModulePath = { namespace: "src", segments: ["main"] };
    const mainSource = `
use pkg::dep::all

pub fn main(): () -> f64
  8.0 / 2.0
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
  });
});
