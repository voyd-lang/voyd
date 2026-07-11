import { describe, expect, it } from "vitest";
import { walkExpression } from "../../semantics/hir/index.js";
import { codegenProgram } from "../../codegen/index.js";
import type { HirMethodCallExpr } from "../../semantics/hir/index.js";
import {
  buildOptimized,
  findFunction,
  findObjectNominal,
} from "./pipeline-test-helpers.js";

describe("compiler optimization pipeline: integration", () => {
  it("does not specialize externally callable trait-parameter exports from internal edges", async () => {
    const { optimized } = await buildOptimized({
      optimizeOptions: { boundaryExports: "auto" },
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

pub fn score(runner: Runner) -> i32
  runner.run()

fn internal() -> i32
  score(Box { value: 4 })

pub fn main() -> i32
  internal()
`,
      },
    });

    const moduleId = "src::main";
    const program = optimized.program;
    const scoreFn = findFunction({ moduleId, name: "score", program });
    expect(scoreFn?.kind).toBe("function");
    if (!scoreFn || scoreFn.kind !== "function") return;
    const scoreInstanceId = program.functions.getInstanceId(
      moduleId,
      scoreFn.symbol,
      [],
    );
    expect(typeof scoreInstanceId).toBe("number");
    if (typeof scoreInstanceId !== "number") return;

    expect(
      optimized.facts.exactParameterTypes
        .get(scoreInstanceId)
        ?.get(scoreFn.parameters[0]!.symbol),
    ).toBeUndefined();
    expect(
      optimized.facts.knownParameterTypes
        .get(scoreInstanceId)
        ?.get(scoreFn.parameters[0]!.symbol),
    ).toBeUndefined();

    const moduleView = program.modules.get(moduleId);
    expect(moduleView).toBeDefined();
    if (!moduleView) return;
    let dispatchCall: HirMethodCallExpr | undefined;
    walkExpression({
      exprId: scoreFn.body,
      hir: moduleView.hir,
      onEnterExpression: (_exprId, expr) => {
        if (expr.exprKind !== "method-call") {
          return;
        }
        dispatchCall = expr;
        return { stop: true };
      },
    });
    expect(dispatchCall?.exprKind).toBe("method-call");
    if (!dispatchCall) return;
    expect(
      program.calls.getCallInfo(moduleId, dispatchCall.id).traitDispatch,
    ).toBe(true);
  });

  it("treats entry-module re-exported trait-parameter functions as externally callable", async () => {
    const { optimized } = await buildOptimized({
      entryFile: "pkg.voyd",
      optimizeOptions: { boundaryExports: "auto" },
      files: {
        "pkg.voyd": `
use src::util::internal
pub use src::util::score

pub fn main() -> i32
  internal()
`,
        "util.voyd": `
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

pub fn score(runner: Runner) -> i32
  runner.run()

pub fn internal() -> i32
  score(Box { value: 4 })
`,
      },
    });

    const moduleId = "src::util";
    const program = optimized.program;
    const scoreFn = findFunction({ moduleId, name: "score", program });
    expect(scoreFn?.kind).toBe("function");
    if (!scoreFn || scoreFn.kind !== "function") return;
    const scoreInstanceId = program.functions.getInstanceId(
      moduleId,
      scoreFn.symbol,
      [],
    );
    expect(typeof scoreInstanceId).toBe("number");
    if (typeof scoreInstanceId !== "number") return;

    expect(
      optimized.facts.exactParameterTypes
        .get(scoreInstanceId)
        ?.get(scoreFn.parameters[0]!.symbol),
    ).toBeUndefined();
    expect(
      optimized.facts.knownParameterTypes
        .get(scoreInstanceId)
        ?.get(scoreFn.parameters[0]!.symbol),
    ).toBeUndefined();

    const moduleView = program.modules.get(moduleId);
    expect(moduleView).toBeDefined();
    if (!moduleView) return;
    let dispatchCall: HirMethodCallExpr | undefined;
    walkExpression({
      exprId: scoreFn.body,
      hir: moduleView.hir,
      onEnterExpression: (_exprId, expr) => {
        if (expr.exprKind !== "method-call") {
          return;
        }
        dispatchCall = expr;
        return { stop: true };
      },
    });
    expect(dispatchCall?.exprKind).toBe("method-call");
    if (!dispatchCall) return;
    expect(
      program.calls.getCallInfo(moduleId, dispatchCall.id).traitDispatch,
    ).toBe(true);
  });

  it("still propagates exact facts for non-entry public helper exports", async () => {
    const { optimized } = await buildOptimized({
      files: {
        "main.voyd": `
use src::util::run_box

pub fn main() -> i32
  run_box()
`,
        "util.voyd": `
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

pub fn score(runner: Runner) -> i32
  runner.run()

pub fn run_box() -> i32
  score(Box { value: 4 })
`,
      },
    });

    const moduleId = "src::util";
    const program = optimized.program;
    const boxType = findObjectNominal({ moduleId, name: "Box", program });
    expect(typeof boxType).toBe("number");
    if (typeof boxType !== "number") return;
    const scoreFn = findFunction({ moduleId, name: "score", program });
    expect(scoreFn?.kind).toBe("function");
    if (!scoreFn || scoreFn.kind !== "function") return;
    const scoreInstanceId = program.functions.getInstanceId(
      moduleId,
      scoreFn.symbol,
      [],
    );
    expect(typeof scoreInstanceId).toBe("number");
    if (typeof scoreInstanceId !== "number") return;
    expect(
      optimized.facts.exactParameterTypes
        .get(scoreInstanceId)
        ?.get(scoreFn.parameters[0]!.symbol),
    ).toBe(boxType);
  });

  it("scales the convergence budget for specialization chains deeper than 32 rounds", async () => {
    const stageCount = 40;
    const stages = Array.from({ length: stageCount }, (_, offset) => {
      const stage = stageCount - offset - 1;
      if (stage === stageCount - 1) {
        return `fn stage_${stage}(runner: Runner) -> i32
  match(runner)
    Box: 7
    else: 8`;
      }
      return `fn stage_${stage}(runner: Runner) -> i32
  match(runner)
    Box: stage_${stage + 1}(runner)
    else: stage_${stage + 1}(Alt { value: 0 })`;
    }).join("\n\n");
    const { optimized } = await buildOptimized({
      files: {
        "main.voyd": `
obj Box { value: i32 }
obj Alt { value: i32 }
type Runner = Box | Alt

${stages}

pub fn main() -> i32
  stage_0(Box { value: 1 })
`,
      },
    });

    const moduleView = optimized.program.modules.get("src::main");
    expect(moduleView).toBeDefined();
    if (!moduleView) return;
    const remainingMatches = Array.from(
      moduleView.hir.expressions.values(),
    ).filter((expr) => expr.exprKind === "match");
    expect(remainingMatches).toEqual([]);
  });

  it("marks returned parameters and callers that cross those boundaries", async () => {
    const { optimized } = await buildOptimized({
      files: {
        "main.voyd": `
obj Vec2 {
  x: i32,
  y: i32
}

fn identity(vec: Vec2) -> Vec2
  vec

pub fn main() -> i32
  let vec = Vec2 { x: 1, y: 2 }
  identity(vec).x
`,
      },
    });

    const moduleId = "src::main";
    const program = optimized.program;
    const identityFn = findFunction({ moduleId, name: "identity", program });
    expect(identityFn?.kind).toBe("function");
    if (!identityFn || identityFn.kind !== "function") return;
    const identityInstanceId = program.functions.getInstanceId(
      moduleId,
      identityFn.symbol,
      [],
    );
    expect(typeof identityInstanceId).toBe("number");
    if (typeof identityInstanceId !== "number") return;
    expect(
      optimized.facts.escapeAnalysis.parameters
        .get(identityInstanceId)
        ?.get(identityFn.parameters[0]!.symbol),
    ).toMatchObject({
      escapes: true,
      escapeReasons: ["return"],
    });

    const aggregateFact = Array.from(
      optimized.facts.escapeAnalysis.origins.get(moduleId)?.values() ?? [],
    ).find(
      (fact) =>
        fact.originKind === "aggregate" &&
        fact.directLocalSymbols.length === 1 &&
        fact.escapeReasons.includes("call-boundary"),
    );
    expect(aggregateFact).toMatchObject({
      originKind: "aggregate",
      escapes: true,
      escapeReasons: ["call-boundary"],
    });
  });

  it("lowers small trait-dispatch sets to direct type switches", async () => {
    const { optimized, entryModuleId } = await buildOptimized({
      files: {
        "main.voyd": `
trait Runner
  fn run(self, offset: i32) -> i32

obj Box {
  value: i32
}

obj Alt {
  value: i32
}

impl Runner for Box
  fn run(self, offset: i32) -> i32
    self.value + offset

impl Runner for Alt
  fn run(self, offset: i32) -> i32
    self.value + offset + 1

fn box_runner(value: i32) -> Runner
  Box { value }

fn alt_runner(value: i32) -> Runner
  Alt { value }

fn choose(flag: bool) -> Runner
  if
    flag:
      box_runner(4)
    else:
      alt_runner(5)

fn invoke(runner: Runner, offset: i32) -> i32
  runner.run(offset)

pub fn main() -> i32
  invoke(choose(true), 2)
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
