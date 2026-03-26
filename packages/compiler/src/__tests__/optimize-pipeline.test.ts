import { describe, expect, it } from "vitest";
import { resolve, sep } from "node:path";
import { createMemoryModuleHost } from "../modules/memory-host.js";
import { createNodePathAdapter } from "../modules/node-path-adapter.js";
import { analyzeModules, loadModuleGraph, lowerProgram } from "../pipeline.js";
import { monomorphizeProgram } from "../semantics/linking.js";
import { buildProgramCodegenView } from "../semantics/codegen-view/index.js";
import { optimizeProgram } from "../optimize/pipeline.js";
import { walkExpression } from "../semantics/hir/index.js";
import type { ModuleHost } from "../modules/types.js";
import { codegenProgram } from "../codegen/index.js";
import type {
  HirLambdaExpr,
  HirMethodCallExpr,
  HirModuleLet,
} from "../semantics/hir/index.js";

const createMemoryHost = (files: Record<string, string>): ModuleHost =>
  createMemoryModuleHost({ files, pathAdapter: createNodePathAdapter() });

const buildOptimized = async ({
  files,
  entryFile = "main.voyd",
}: {
  files: Record<string, string>;
  entryFile?: string;
}) => {
  const root = resolve("/proj/src");
  const host = createMemoryHost(
    Object.fromEntries(
      Object.entries(files).map(([fileName, source]) => [
        `${root}${sep}${fileName}`,
        source,
      ]),
    ),
  );
  const entryPath = `${root}${sep}${entryFile}`;
  const graph = await loadModuleGraph({
    entryPath,
    roots: { src: root },
    host,
  });
  const { semantics, diagnostics } = analyzeModules({ graph });
  const firstError = [...graph.diagnostics, ...diagnostics].find(
    (diagnostic) => diagnostic.severity === "error",
  );
  if (firstError) {
    throw new Error(`${firstError.code}: ${firstError.message}`);
  }
  const { orderedModules, entry } = lowerProgram({ graph, semantics });
  const modules = orderedModules
    .map((id) => semantics.get(id))
    .filter((value): value is NonNullable<typeof value> => Boolean(value));
  const monomorphized = monomorphizeProgram({ modules, semantics });
  const program = buildProgramCodegenView(modules, {
    instances: monomorphized.instances,
    moduleTyping: monomorphized.moduleTyping,
  });
  const optimized = optimizeProgram({
    program,
    modules,
    entryModuleId: entry,
  });

  return {
    entryModuleId: entry,
    optimized,
  };
};

const findFunction = ({
  moduleId,
  name,
  program,
}: {
  moduleId: string;
  name: string;
  program: ReturnType<typeof buildProgramCodegenView>;
}) =>
  Array.from(program.modules.get(moduleId)?.hir.items.values() ?? []).find(
    (item) =>
      item.kind === "function" &&
      program.symbols.getName(program.symbols.idOf({ moduleId, symbol: item.symbol })) === name,
  );

const findModuleLet = ({
  moduleId,
  name,
  program,
}: {
  moduleId: string;
  name: string;
  program: ReturnType<typeof buildProgramCodegenView>;
}) =>
  Array.from(program.modules.get(moduleId)?.hir.items.values() ?? []).find(
    (item): item is HirModuleLet =>
      item.kind === "module-let" &&
      program.symbols.getName(program.symbols.idOf({ moduleId, symbol: item.symbol })) === name,
  );

describe("compiler optimization pipeline", () => {
  it("folds pure helper calls, prunes dead generic instances, and shrinks lambda captures", async () => {
    const { optimized } = await buildOptimized({
      files: {
        "main.voyd": `
fn add_one(value: i32) -> i32
  value + 1

fn dead<T>(value: T) -> T
  value

fn make_adder(seed: i32)
  let spare = 99
  (value: i32) =>
    if add_one(40) == 41 then:
      seed + value
    else:
      dead<i32>(spare)

pub fn main() -> i32
  let adder = make_adder(2)
  adder(3)
`,
      },
    });

    const program = optimized.program;
    const moduleId = "src::main";
    const lambda = Array.from(program.modules.get(moduleId)?.hir.expressions.values() ?? []).find(
      (expr): expr is HirLambdaExpr => expr.exprKind === "lambda",
    );
    expect(lambda?.captures.map((capture) => capture.symbol)).toHaveLength(1);

    const deadFn = findFunction({ moduleId, name: "dead", program });
    expect(deadFn?.kind).toBe("function");
    if (!deadFn || deadFn.kind !== "function") return;
    const deadInstantiations = program.functions.getInstantiationInfo(moduleId, deadFn.symbol);
    expect(deadInstantiations?.size ?? 0).toBe(0);
  });

  it("eliminates effect handlers on proven-pure paths", async () => {
    const { optimized } = await buildOptimized({
      files: {
        "main.voyd": `
eff Log
  info(resume, x: i32) -> i32

fn pure_value() -> i32
  5

pub fn main() -> i32
  try
    pure_value()
  Log::info(resume, x):
    x
`,
      },
    });

    const mainFn = findFunction({
      moduleId: "src::main",
      name: "main",
      program: optimized.program,
    });
    expect(mainFn?.kind).toBe("function");
    if (!mainFn || mainFn.kind !== "function") return;
    const body = optimized.program.modules.get("src::main")?.hir.expressions.get(mainFn.body);
    expect(body?.exprKind).toBe("block");
  });

  it("records minimal handler capture sets", async () => {
    const { optimized } = await buildOptimized({
      files: {
        "main.voyd": `
eff Log
  info(resume, x: i32) -> i32

fn worker(): Log -> i32
  Log::info(5)

pub fn main(): () -> i32
  let used = 3
  let unused = 9
  try
    worker()
  Log::info(resume, x):
    used + x
`,
      },
    });

    const handlerCaptures = optimized.facts.handlerClauseCaptures.get("src::main");
    expect(handlerCaptures?.size ?? 0).toBe(1);
    const captures = Array.from(handlerCaptures?.values() ?? [])
      .flatMap((byClause) => Array.from(byClause.values()))
      .flat();
    expect(captures).toHaveLength(1);
  });

  it("devirtualizes single-impl trait dispatch calls", async () => {
    const { optimized } = await buildOptimized({
      files: {
        "main.voyd": `
trait Runner
  fn run(self) -> i32

obj Box {
  value: i32
}

impl Runner for Box
  fn run(self) -> i32
    self.value

pub fn invoke<T: Runner>(runner: T) -> i32
  runner.run()

pub fn main() -> i32
  invoke(Box { value: 4 })
`,
      },
    });

    const invokeFn = findFunction({
      moduleId: "src::main",
      name: "invoke",
      program: optimized.program,
    });
    expect(invokeFn?.kind).toBe("function");
    if (!invokeFn || invokeFn.kind !== "function") return;
    const moduleView = optimized.program.modules.get("src::main");
    const callExpr = (() => {
      if (!moduleView) {
        return undefined;
      }
      let found: HirMethodCallExpr | undefined;
      walkExpression({
        exprId: invokeFn.body,
        hir: moduleView.hir,
        onEnterExpression: (_exprId, expr) => {
          if (expr.exprKind !== "method-call") {
            return;
          }
          found = expr;
          return { stop: true };
        },
      });
      return found;
    })();
    expect(callExpr?.exprKind).toBe("method-call");
    if (!callExpr || callExpr.exprKind !== "method-call") return;
    const callInfo = optimized.program.calls.getCallInfo("src::main", callExpr.id);
    expect(callInfo.traitDispatch).toBe(false);
  });

  it("tracks reachable cross-module module lets and prunes unrelated specializations", async () => {
    const { optimized } = await buildOptimized({
      files: {
        "main.voyd": `
use src::util::get_value

pub fn main() -> i32
  get_value()
`,
        "util.voyd": `
fn id<T>(value: T) -> T
  value

fn keep<T>(value: T) -> T
  id<T>(value)

fn drop<T>(value: T) -> T
  id<T>(value)

let kept = keep(7)
let discarded = drop(true)

pub fn get_value() -> i32
  kept
`,
      },
    });

    const utilModuleId = "src::util";
    const dropFn = findFunction({
      moduleId: utilModuleId,
      name: "drop",
      program: optimized.program,
    });
    expect(dropFn?.kind).toBe("function");
    if (!dropFn || dropFn.kind !== "function") return;

    const kept = findModuleLet({
      moduleId: utilModuleId,
      name: "kept",
      program: optimized.program,
    });
    const discarded = findModuleLet({
      moduleId: utilModuleId,
      name: "discarded",
      program: optimized.program,
    });
    expect(kept?.kind).toBe("module-let");
    expect(discarded?.kind).toBe("module-let");
    if (!kept || !discarded) return;

    const dropInstantiations = optimized.program.functions.getInstantiationInfo(
      utilModuleId,
      dropFn.symbol,
    );
    expect(dropInstantiations?.size ?? 0).toBe(0);

    const reachableModuleLets = optimized.facts.reachableModuleLets.get(utilModuleId);
    expect(reachableModuleLets?.has(kept.symbol)).toBe(true);
    expect(reachableModuleLets?.has(discarded.symbol)).toBe(false);
  });

  it("inlines small pure direct calls during optimized codegen", async () => {
    const { optimized, entryModuleId } = await buildOptimized({
      files: {
        "main.voyd": `
fn double(value: i32) -> i32
  value + value

pub fn main() -> i32
  double(21)
`,
      },
    });

    const optimizedCodegen = codegenProgram({
      program: optimized.program,
      entryModuleId,
      optimization: optimized.facts,
      options: {
        optimize: false,
        validate: false,
        runtimeDiagnostics: false,
      },
    });
    const wasmText = optimizedCodegen.module.emitText();

    expect(wasmText).not.toContain("(func $src__main__double_");
    expect(wasmText).not.toContain("call $src__main__double_");
    expect(wasmText).toContain("(i32.const 42)");
  });

  it("lowers exact nominal field reads to direct struct loads", async () => {
    const { optimized, entryModuleId } = await buildOptimized({
      files: {
        "main.voyd": `
obj Vec2 {
  x: i32,
  y: i32
}

pub fn main() -> i32
  let vec = Vec2 { x: 1, y: 2 }
  vec.x + vec.y
`,
      },
    });

    const optimizedCodegen = codegenProgram({
      program: optimized.program,
      entryModuleId,
      optimization: optimized.facts,
      options: {
        optimize: false,
        validate: false,
        runtimeDiagnostics: false,
      },
    });
    const baselineCodegen = codegenProgram({
      program: optimized.program,
      entryModuleId,
      options: {
        optimize: false,
        validate: false,
        runtimeDiagnostics: false,
      },
    });
    const optimizedWasmText = optimizedCodegen.module.emitText();
    const baselineWasmText = baselineCodegen.module.emitText();

    expect(optimizedWasmText).toContain("call $__has_type");
    expect(baselineWasmText).not.toContain("call $__has_type");
  });

  it("lowers small trait-dispatch sets to direct type switches", async () => {
    const { optimized, entryModuleId } = await buildOptimized({
      files: {
        "main.voyd": `
trait Runner
  fn run(self) -> i32

obj Box {
  value: i32
}

obj Alt {
  value: i32
}

impl Runner for Box
  fn run(self) -> i32
    self.value

impl Runner for Alt
  fn run(self) -> i32
    self.value + 1

fn invoke(runner: Runner) -> i32
  runner.run()

pub fn main() -> i32
  invoke(Box { value: 4 })
`,
      },
    });

    const { module } = codegenProgram({
      program: optimized.program,
      entryModuleId,
      optimization: optimized.facts,
      options: {
        optimize: false,
        validate: false,
        runtimeDiagnostics: false,
      },
    });
    const wasmText = module.emitText();

    expect(wasmText).toContain("call $src__main__run_");
    expect(wasmText).toContain("call $__has_type");
    expect(wasmText).not.toContain("call $__lookup_method_accessor");
  });
});
