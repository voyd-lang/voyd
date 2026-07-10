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
import type { CodegenOptions } from "../codegen/context.js";
import type {
  HirLambdaExpr,
  HirMethodCallExpr,
  HirModuleLet,
} from "../semantics/hir/index.js";
import { getWasmInstance } from "@voyd-lang/lib/wasm.js";

const createMemoryHost = (files: Record<string, string>): ModuleHost =>
  createMemoryModuleHost({ files, pathAdapter: createNodePathAdapter() });

const buildOptimized = async ({
  files,
  stdFiles = {},
  entryFile = "main.voyd",
  includeTests = false,
  optimizeOptions,
  transformProgram,
}: {
  files: Record<string, string>;
  stdFiles?: Record<string, string>;
  entryFile?: string;
  includeTests?: boolean;
  optimizeOptions?: CodegenOptions;
  transformProgram?: (
    program: ReturnType<typeof buildProgramCodegenView>,
  ) => void;
}) => {
  const srcRoot = resolve("/proj/src");
  const stdRoot = resolve("/proj/std");
  const host = createMemoryHost({
    ...Object.fromEntries(
      Object.entries(files).map(([fileName, source]) => [
        `${srcRoot}${sep}${fileName}`,
        source,
      ]),
    ),
    ...Object.fromEntries(
      Object.entries(stdFiles).map(([fileName, source]) => [
        `${stdRoot}${sep}${fileName}`,
        source,
      ]),
    ),
  });
  const entryPath = `${srcRoot}${sep}${entryFile}`;
  const graph = await loadModuleGraph({
    entryPath,
    roots: { src: srcRoot, std: stdRoot },
    host,
    includeTests,
  });
  const { semantics, diagnostics, tests } = analyzeModules({
    graph,
    includeTests,
    testScope: optimizeOptions?.testScope,
  });
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
  transformProgram?.(program);
  const optimized = optimizeProgram({
    program,
    modules,
    entryModuleId: entry,
    options: optimizeOptions,
  });

  return {
    entryModuleId: entry,
    optimized,
    tests,
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
      program.symbols.getName(
        program.symbols.idOf({ moduleId, symbol: item.symbol }),
      ) === name,
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
      program.symbols.getName(
        program.symbols.idOf({ moduleId, symbol: item.symbol }),
      ) === name,
  );

const findObjectNominal = ({
  moduleId,
  name,
  program,
}: {
  moduleId: string;
  name: string;
  program: ReturnType<typeof buildProgramCodegenView>;
}) => {
  const item = Array.from(
    program.modules.get(moduleId)?.hir.items.values() ?? [],
  ).find(
    (candidate) =>
      candidate.kind === "object" &&
      program.symbols.getName(
        program.symbols.idOf({ moduleId, symbol: candidate.symbol }),
      ) === name,
  );
  return item?.kind === "object"
    ? program.objects.getTemplate(
        program.symbols.idOf({ moduleId, symbol: item.symbol }),
      )?.nominal
    : undefined;
};

const getFunctionBodyValueExpr = ({
  moduleId,
  symbol,
  program,
}: {
  moduleId: string;
  symbol: number;
  program: ReturnType<typeof buildProgramCodegenView>;
}) => {
  const moduleView = program.modules.get(moduleId);
  const item = Array.from(moduleView?.hir.items.values() ?? []).find(
    (candidate) => candidate.kind === "function" && candidate.symbol === symbol,
  );
  if (!item || item.kind !== "function") {
    return undefined;
  }
  const body = moduleView?.hir.expressions.get(item.body);
  return body?.exprKind === "block" && typeof body.value === "number"
    ? moduleView?.hir.expressions.get(body.value)
    : body;
};

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
    const lambda = Array.from(
      program.modules.get(moduleId)?.hir.expressions.values() ?? [],
    ).find((expr): expr is HirLambdaExpr => expr.exprKind === "lambda");
    expect(lambda?.captures.map((capture) => capture.symbol)).toHaveLength(1);

    const deadFn = findFunction({ moduleId, name: "dead", program });
    expect(deadFn?.kind).toBe("function");
    if (!deadFn || deadFn.kind !== "function") return;
    const deadInstantiations = program.functions.getInstantiationInfo(
      moduleId,
      deadFn.symbol,
    );
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
    const body = optimized.program.modules
      .get("src::main")
      ?.hir.expressions.get(mainFn.body);
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

    const handlerCaptures =
      optimized.facts.handlerClauseCaptures.get("src::main");
    expect(handlerCaptures?.size ?? 0).toBe(1);
    const captures = Array.from(handlerCaptures?.values() ?? [])
      .flatMap((byClause) => Array.from(byClause.values()))
      .flat();
    expect(captures).toHaveLength(1);
  });

  it("recomputes handler captures after fixed-point match simplification", async () => {
    const { optimized } = await buildOptimized({
      files: {
        "main.voyd": `
eff Log
  info(resume, x: i32) -> i32

obj Box { value: i32 }
obj Alt { value: i32 }
type Runner = Box | Alt

fn worker(): Log -> i32
  Log::info(5)

fn classify(runner: Runner) -> i32
  let eliminated_capture = 100
  try
    worker()
  Log::info(resume, x):
    match(runner)
      Box: x
      else: eliminated_capture + x

pub fn main() -> i32
  classify(Box { value: 1 })
`,
      },
    });

    const captures = Array.from(
      optimized.facts.handlerClauseCaptures.get("src::main")?.values() ?? [],
    )
      .flatMap((byClause) => Array.from(byClause.values()))
      .flat();
    // The discriminant still evaluates `runner`, but the eliminated match arm's
    // local must not survive in the handler environment.
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
    const callInfo = optimized.program.calls.getCallInfo(
      "src::main",
      callExpr.id,
    );
    expect(callInfo.traitDispatch).toBe(false);
  });

  it("propagates exact receiver facts across monomorphic trait-typed call edges", async () => {
    const { optimized } = await buildOptimized({
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

fn helper(runner: Runner) -> i32
  runner.run()

fn invoke(runner: Runner) -> i32
  helper(runner)

pub fn main() -> i32
  invoke(Box { value: 4 })
`,
      },
    });

    const moduleId = "src::main";
    const program = optimized.program;
    const boxItem = Array.from(
      program.modules.get(moduleId)?.hir.items.values() ?? [],
    ).find(
      (item) =>
        item.kind === "object" &&
        program.symbols.getName(
          program.symbols.idOf({ moduleId, symbol: item.symbol }),
        ) === "Box",
    );
    const boxType =
      boxItem?.kind === "object"
        ? program.objects.getTemplate(
            program.symbols.idOf({ moduleId, symbol: boxItem.symbol }),
          )?.nominal
        : undefined;
    expect(typeof boxType).toBe("number");
    if (typeof boxType !== "number") return;

    for (const name of ["invoke", "helper"]) {
      const fn = findFunction({ moduleId, name, program });
      expect(fn?.kind, name).toBe("function");
      if (!fn || fn.kind !== "function") continue;
      const instanceId = program.functions.getInstanceId(
        moduleId,
        fn.symbol,
        [],
      );
      expect(typeof instanceId, name).toBe("number");
      if (typeof instanceId !== "number") continue;
      expect(
        optimized.facts.exactParameterTypes
          .get(instanceId)
          ?.get(fn.parameters[0]!.symbol),
        name,
      ).toBe(boxType);
    }
  });

  it("maps labeled call arguments when propagating exact receiver facts", async () => {
    const { optimized } = await buildOptimized({
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

fn helper({ offset: i32, runner: Runner }) -> i32
  runner.run(offset)

fn invoke({ offset: i32, runner: Runner }) -> i32
  helper(runner: runner, offset: offset)

pub fn main() -> i32
  invoke(runner: Box { value: 4 }, offset: 2)
`,
      },
    });

    const moduleId = "src::main";
    const program = optimized.program;
    const boxType = findObjectNominal({ moduleId, name: "Box", program });
    expect(typeof boxType).toBe("number");
    if (typeof boxType !== "number") return;

    for (const name of ["invoke", "helper"]) {
      const fn = findFunction({ moduleId, name, program });
      expect(fn?.kind, name).toBe("function");
      if (!fn || fn.kind !== "function") continue;
      const runner = fn.parameters.find(
        (parameter) => parameter.label === "runner",
      );
      expect(runner, name).toBeDefined();
      if (!runner) continue;
      const instanceId = program.functions.getInstanceId(
        moduleId,
        fn.symbol,
        [],
      );
      expect(typeof instanceId, name).toBe("number");
      if (typeof instanceId !== "number") continue;
      expect(
        optimized.facts.exactParameterTypes.get(instanceId)?.get(runner.symbol),
        name,
      ).toBe(boxType);
    }
  });

  it("devirtualizes monomorphic trait-typed callees using propagated exact receiver facts", async () => {
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
    const callInfo = optimized.program.calls.getCallInfo(
      "src::main",
      callExpr.id,
    );
    expect(callInfo.traitDispatch).toBe(false);
    expect(new Set(callInfo.targets?.values()).size).toBe(1);

    const { module } = codegenProgram({
      program: optimized.program,
      entryModuleId,
      optimization: optimized.facts,
      options: {
        optimize: false,
        validate: true,
        runtimeDiagnostics: false,
      },
    });
    const wasmText = module.emitText();
    expect(wasmText).toContain("call $src__main__run_");
    expect(wasmText).not.toContain("call $__lookup_method_accessor");
  });

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

  it("keeps functions used as values open for exact receiver facts", async () => {
    const { optimized } = await buildOptimized({
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

fn score(runner: Runner) -> i32
  runner.run()

fn apply(cb: fn(Runner) -> i32, runner: Runner) -> i32
  cb(runner)

fn internal() -> i32
  score(Box { value: 4 }) + apply(score, Alt { value: 5 })

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

  it("creates receiver-specialized clones for exact method call edges", async () => {
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

fn helper(runner: Runner, offset: i32) -> i32
  runner.run(offset)

obj Service {
  base: i32
}

impl Service
  fn invoke(self, runner: Runner, offset: i32) -> i32
    helper(runner, offset) + self.base

pub fn main() -> i32
  use_box() + use_alt()

fn use_box() -> i32
  Service { base: 1 }.invoke(Box { value: 4 }, 2)

fn use_alt() -> i32
  Service { base: 1 }.invoke(Alt { value: 5 }, 3)
`,
      },
    });

    expect(optimized.facts.receiverSpecializationRequests.size).toBeGreaterThan(
      0,
    );

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
    expect(wasmText).toMatch(/call \$src__main__invoke_\d+__receiver_/);
    expect(wasmText).toMatch(/call \$src__main__helper_\d+__receiver_/);
    expect(wasmText).not.toContain("call $__lookup_method_accessor");
  });

  it("propagates receiver specialization through mutually recursive forwarding", async () => {
    const { optimized, entryModuleId } = await buildOptimized({
      files: {
        "main.voyd": `
trait Runner
  fn run(self) -> i32

obj Box { value: i32 }
obj Alt { value: i32 }

impl Runner for Box
  fn run(self) -> i32
    self.value

impl Runner for Alt
  fn run(self) -> i32
    self.value + 1

fn a(runner: Runner, depth: i32) -> i32
  if depth == 0 then:
    runner.run()
  else:
    b(runner, depth - 1)

fn b(runner: Runner, depth: i32) -> i32
  if depth == 0 then:
    0
  else:
    a(runner, depth - 1)

fn use_box() -> i32
  a(Box { value: 4 }, 2)

fn use_alt() -> i32
  a(Alt { value: 5 }, 3)

pub fn main() -> i32
  use_box() + use_alt()
`,
      },
    });

    const { module } = codegenProgram({
      program: optimized.program,
      entryModuleId,
      optimization: optimized.facts,
      options: {
        optimize: false,
        validate: true,
        runtimeDiagnostics: false,
      },
    });
    const wasmText = module.emitText();
    expect(wasmText).toMatch(/call \$src__main__a_\d+__receiver_/);
    expect(wasmText).toMatch(/call \$src__main__b_\d+__receiver_/);
  });

  it("uses global exact facts when ordinary functions request downstream receiver clones", async () => {
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

fn leaf(runner: Runner, offset: i32) -> i32
  runner.run(offset)

fn exact_forward(runner: Runner, offset: i32) -> i32
  leaf(runner, offset)

fn use_box() -> i32
  exact_forward(Box { value: 4 }, 2)

fn use_alt() -> i32
  leaf(Alt { value: 5 }, 3)

pub fn main() -> i32
  use_box() + use_alt()
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
    expect(wasmText).toMatch(/call \$src__main__leaf_\d+__receiver_/);
    expect(wasmText).not.toContain("call $__lookup_method_accessor");
  });

  it("narrows direct trait switches to known receiver sets from multiple monomorphic call edges", async () => {
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

obj ExtraA {
  value: i32
}

obj ExtraB {
  value: i32
}

obj ExtraC {
  value: i32
}

impl Runner for Box
  fn run(self, offset: i32) -> i32
    self.value + offset

impl Runner for Alt
  fn run(self, offset: i32) -> i32
    self.value + offset + 1

impl Runner for ExtraA
  fn run(self, offset: i32) -> i32
    self.value + offset + 2

impl Runner for ExtraB
  fn run(self, offset: i32) -> i32
    self.value + offset + 3

impl Runner for ExtraC
  fn run(self, offset: i32) -> i32
    self.value + offset + 4

fn helper(runner: Runner, offset: i32) -> i32
  runner.run(offset)

fn invoke(runner: Runner, offset: i32) -> i32
  helper(runner, offset)

fn use_box() -> i32
  invoke(Box { value: 4 }, 2)

fn use_alt() -> i32
  invoke(Alt { value: 5 }, 3)

pub fn main() -> i32
  use_box() + use_alt()
`,
      },
    });

    const moduleId = "src::main";
    const program = optimized.program;
    const boxType = findObjectNominal({ moduleId, name: "Box", program });
    const altType = findObjectNominal({ moduleId, name: "Alt", program });
    expect(typeof boxType).toBe("number");
    expect(typeof altType).toBe("number");
    if (typeof boxType !== "number" || typeof altType !== "number") return;

    const invokeFn = findFunction({ moduleId, name: "invoke", program });
    expect(invokeFn?.kind).toBe("function");
    if (!invokeFn || invokeFn.kind !== "function") return;
    const invokeInstanceId = program.functions.getInstanceId(
      moduleId,
      invokeFn.symbol,
      [],
    );
    expect(typeof invokeInstanceId).toBe("number");
    if (typeof invokeInstanceId !== "number") return;

    expect(
      optimized.facts.exactParameterTypes
        .get(invokeInstanceId)
        ?.get(invokeFn.parameters[0]!.symbol),
    ).toBeUndefined();
    expect(
      optimized.facts.knownParameterTypes
        .get(invokeInstanceId)
        ?.get(invokeFn.parameters[0]!.symbol),
    ).toEqual(new Set([boxType, altType]));

    const { module } = codegenProgram({
      program,
      entryModuleId,
      optimization: optimized.facts,
      options: {
        optimize: false,
        validate: true,
        runtimeDiagnostics: false,
      },
    });
    const wasmText = module.emitText();
    expect(wasmText).toContain("__receiver_");
    expect(wasmText).toMatch(/call \$src__main__invoke_\d+__receiver_/);
    expect(wasmText).toMatch(/call \$src__main__helper_\d+__receiver_/);
    expect(wasmText).not.toContain("call $__lookup_method_accessor");
    expect(wasmText).not.toMatch(/\(func \$.*__method_\d+_/);
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

    const reachableModuleLets =
      optimized.facts.reachableModuleLets.get(utilModuleId);
    expect(reachableModuleLets?.has(kept.symbol)).toBe(true);
    expect(reachableModuleLets?.has(discarded.symbol)).toBe(false);
  });

  it("folds i64 constants without losing 64-bit precision", async () => {
    const { optimized } = await buildOptimized({
      files: {
        "main.voyd": `
pub fn main() -> i64
  9007199254740993i64 + 2i64
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

    const folded = getFunctionBodyValueExpr({
      moduleId: "src::main",
      symbol: mainFn.symbol,
      program: optimized.program,
    });
    expect(folded).toMatchObject({
      exprKind: "literal",
      literalKind: "i64",
      value: "9007199254740995",
    });
  });

  it("folds i32 constants with 32-bit integer semantics", async () => {
    const { optimized } = await buildOptimized({
      files: {
        "main.voyd": `
pub fn main() -> i32
  2147483647i32 * 2147483647i32
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

    const folded = getFunctionBodyValueExpr({
      moduleId: "src::main",
      symbol: mainFn.symbol,
      program: optimized.program,
    });
    expect(folded).toMatchObject({
      exprKind: "literal",
      literalKind: "i32",
      value: "1",
    });
  });

  it("folds f32 constants with single-precision semantics", async () => {
    const scenarios = [
      {
        name: "equality rounds operands to f32 first",
        source: `
pub fn main() -> bool
  16777217.0 == 16777216.0
`,
        expected: {
          exprKind: "literal",
          literalKind: "boolean",
          value: "true",
        },
      },
      {
        name: "arithmetic rounds each folded f32 result",
        source: `
pub fn main() -> f64
  16777217.0 + 1.0
`,
        expected: {
          exprKind: "literal",
          literalKind: "f32",
          value: "16777216",
        },
      },
    ] as const;

    for (const scenario of scenarios) {
      const { optimized } = await buildOptimized({
        files: { "main.voyd": scenario.source },
        transformProgram: (program) => {
          program.modules.get("src::main")?.hir.expressions.forEach((expr) => {
            if (expr.exprKind !== "literal" || expr.literalKind !== "f64") {
              return;
            }
            expr.literalKind = "f32";
          });
        },
      });

      const mainFn = findFunction({
        moduleId: "src::main",
        name: "main",
        program: optimized.program,
      });
      expect(mainFn?.kind, scenario.name).toBe("function");
      if (!mainFn || mainFn.kind !== "function") continue;

      const folded = getFunctionBodyValueExpr({
        moduleId: "src::main",
        symbol: mainFn.symbol,
        program: optimized.program,
      });
      expect(folded, scenario.name).toMatchObject(scenario.expected);
    }
  });

  it("preserves signed division overflow traps during constant folding", async () => {
    const scenarios = [
      {
        name: "i32",
        source: `
pub fn main() -> i32
  -2147483648i32 / -1i32
`,
      },
      {
        name: "i64",
        source: `
pub fn main() -> i64
  -9223372036854775808i64 / -1i64
`,
      },
    ] as const;

    for (const scenario of scenarios) {
      const { optimized } = await buildOptimized({
        files: { "main.voyd": scenario.source },
      });

      const mainFn = findFunction({
        moduleId: "src::main",
        name: "main",
        program: optimized.program,
      });
      expect(mainFn?.kind).toBe("function");
      if (!mainFn || mainFn.kind !== "function") continue;

      const bodyExpr = getFunctionBodyValueExpr({
        moduleId: "src::main",
        symbol: mainFn.symbol,
        program: optimized.program,
      });
      expect(bodyExpr?.exprKind, scenario.name).toBe("call");
    }
  });

  it("keeps discriminant evaluation when simplifying matches with known constructors", async () => {
    const { optimized } = await buildOptimized({
      files: {
        "main.voyd": `
eff Log
  info(resume) -> void

obj Box {
  value: i32
}

fn make_box(): Log -> Box
  Log::info()
  Box { value: 1 }

pub fn main(): Log -> i32
  match(make_box())
    Box: 7
    else: 8
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

    const moduleView = optimized.program.modules.get("src::main");
    const body = getFunctionBodyValueExpr({
      moduleId: "src::main",
      symbol: mainFn.symbol,
      program: optimized.program,
    });
    expect(body?.exprKind).toBe("block");
    if (!body || body.exprKind !== "block") return;
    expect(body.statements).toHaveLength(1);

    const stmt = moduleView?.hir.statements.get(body.statements[0]!);
    expect(stmt?.kind).toBe("expr-stmt");
    if (!stmt || stmt.kind !== "expr-stmt") return;

    const discriminant = moduleView?.hir.expressions.get(stmt.expr);
    expect(discriminant?.exprKind).toBe("call");
  });

  it("uses exact parameter facts to simplify constructor matches", async () => {
    const { optimized } = await buildOptimized({
      files: {
        "main.voyd": `
obj Box {
  value: i32
}

obj Alt {
  value: i32
}

type Runner = Box | Alt

fn classify(runner: Runner) -> i32
  match(runner)
    Box: 7
    else: 8

fn invoke(runner: Runner) -> i32
  classify(runner)

pub fn main() -> i32
  invoke(Box { value: 4 })
`,
      },
    });

    const moduleId = "src::main";
    const program = optimized.program;
    const classifyFn = findFunction({ moduleId, name: "classify", program });
    expect(classifyFn?.kind).toBe("function");
    if (!classifyFn || classifyFn.kind !== "function") return;
    const moduleView = program.modules.get(moduleId);
    expect(moduleView).toBeDefined();
    if (!moduleView) return;

    let sawMatch = false;
    walkExpression({
      exprId: classifyFn.body,
      hir: moduleView.hir,
      onEnterExpression: (_exprId, expr) => {
        if (expr.exprKind === "match") {
          sawMatch = true;
          return { stop: true };
        }
      },
    });
    expect(sawMatch).toBe(false);
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

  it("records non-escaping aggregate and parameter facts across direct pure calls", async () => {
    const { optimized } = await buildOptimized({
      files: {
        "main.voyd": `
obj Vec2 {
  x: i32,
  y: i32
}

fn sum(vec: Vec2) -> i32
  vec.x + vec.y

pub fn main() -> i32
  let vec = Vec2 { x: 1, y: 2 }
  sum(vec)
`,
      },
    });

    const moduleId = "src::main";
    const program = optimized.program;
    const aggregateFact = Array.from(
      optimized.facts.escapeAnalysis.origins.get(moduleId)?.values() ?? [],
    ).find(
      (fact) =>
        fact.originKind === "aggregate" &&
        !fact.escapes &&
        fact.directLocalSymbols.length === 1,
    );
    expect(aggregateFact).toMatchObject({
      originKind: "aggregate",
      escapes: false,
      escapeReasons: [],
    });
    expect(aggregateFact?.directLocalSymbols).toHaveLength(1);

    const sumFn = findFunction({ moduleId, name: "sum", program });
    expect(sumFn?.kind).toBe("function");
    if (!sumFn || sumFn.kind !== "function") return;
    const sumInstanceId = program.functions.getInstanceId(
      moduleId,
      sumFn.symbol,
      [],
    );
    expect(typeof sumInstanceId).toBe("number");
    if (typeof sumInstanceId !== "number") return;
    expect(
      optimized.facts.escapeAnalysis.parameters
        .get(sumInstanceId)
        ?.get(sumFn.parameters[0]!.symbol),
    ).toMatchObject({
      escapes: false,
      escapeReasons: [],
    });
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

  it("propagates parameter escapes through a multi-hop caller worklist", async () => {
    const { optimized } = await buildOptimized({
      files: {
        "main.voyd": `
obj Vec2 { x: i32, y: i32 }

fn sink(vec: Vec2) -> Vec2
  vec

fn middle(vec: Vec2) -> Vec2
  sink(vec)

fn outer(vec: Vec2) -> Vec2
  middle(vec)

pub fn main() -> i32
  outer(Vec2 { x: 1, y: 2 }).x
`,
      },
    });

    const moduleId = "src::main";
    const parameterFact = (name: string) => {
      const fn = findFunction({
        moduleId,
        name,
        program: optimized.program,
      });
      expect(fn?.kind).toBe("function");
      if (!fn || fn.kind !== "function") return undefined;
      const instanceId = optimized.program.functions.getInstanceId(
        moduleId,
        fn.symbol,
        [],
      );
      return typeof instanceId === "number"
        ? optimized.facts.escapeAnalysis.parameters
            .get(instanceId)
            ?.get(fn.parameters[0]!.symbol)
        : undefined;
    };

    expect(parameterFact("sink")).toMatchObject({
      escapes: true,
      escapeReasons: ["return"],
    });
    expect(parameterFact("middle")).toMatchObject({
      escapes: true,
      escapeReasons: ["call-boundary"],
    });
    expect(parameterFact("outer")).toMatchObject({
      escapes: true,
      escapeReasons: ["call-boundary"],
    });
  });

  it("tracks local aliases back to parameter escape facts", async () => {
    const { optimized } = await buildOptimized({
      files: {
        "main.voyd": `
eff Log
  info(resume, x: i32) -> i32

obj Vec2 {
  x: i32,
  y: i32
}

fn worker(): Log -> i32
  Log::info(5)

fn escaping_identity(vec: Vec2) -> Vec2
  vec

fn identity_alias(vec: Vec2) -> Vec2
  let alias = vec
  alias

fn alias_to_escaping_callee(vec: Vec2) -> Vec2
  let alias = vec
  escaping_identity(alias)

fn alias_closure_capture(vec: Vec2) -> i32
  let alias = vec
  let cb = () => alias.x
  cb()

fn alias_effect_capture(vec: Vec2): () -> i32
  let alias = vec
  try
    worker()
  Log::info(resume, x):
    alias.x + x

fn alias_non_escape(vec: Vec2) -> i32
  let alias = vec
  alias.x + alias.y

pub fn main(): () -> i32
  identity_alias(Vec2 { x: 1, y: 2 }).x +
    alias_to_escaping_callee(Vec2 { x: 3, y: 4 }).x +
    alias_closure_capture(Vec2 { x: 5, y: 6 }) +
    alias_effect_capture(Vec2 { x: 7, y: 8 }) +
    alias_non_escape(Vec2 { x: 9, y: 10 })
`,
      },
    });

    const moduleId = "src::main";
    const program = optimized.program;
    const parameterFact = (name: string) => {
      const fn = findFunction({ moduleId, name, program });
      expect(fn?.kind, name).toBe("function");
      if (!fn || fn.kind !== "function") {
        return undefined;
      }
      const instanceId = program.functions.getInstanceId(
        moduleId,
        fn.symbol,
        [],
      );
      expect(typeof instanceId, name).toBe("number");
      if (typeof instanceId !== "number") {
        return undefined;
      }
      return optimized.facts.escapeAnalysis.parameters
        .get(instanceId)
        ?.get(fn.parameters[0]!.symbol);
    };

    expect(parameterFact("identity_alias")).toMatchObject({
      escapes: true,
      escapeReasons: ["return"],
    });
    expect(parameterFact("alias_to_escaping_callee")).toMatchObject({
      escapes: true,
      escapeReasons: ["call-boundary"],
    });
    expect(parameterFact("alias_closure_capture")).toMatchObject({
      escapes: true,
      escapeReasons: ["closure-capture"],
    });
    expect(parameterFact("alias_effect_capture")).toMatchObject({
      escapes: true,
      escapeReasons: ["effect-handler-capture"],
    });
    expect(parameterFact("alias_non_escape")).toMatchObject({
      escapes: false,
      escapeReasons: [],
    });
  });

  it("tracks aliases through value-producing initializers", async () => {
    const { optimized } = await buildOptimized({
      files: {
        "main.voyd": `
obj Vec2 {
  x: i32,
  y: i32
}

fn if_alias(vec: Vec2, flag: bool) -> Vec2
  let alias =
    if flag:
      vec
    else:
      vec
  alias

fn block_alias(vec: Vec2) -> Vec2
  let alias =
    let inner = vec
    inner
  alias

fn aggregate_if(flag: bool) -> Vec2
  let alias =
    if flag:
      Vec2 { x: 1, y: 2 }
    else:
      Vec2 { x: 3, y: 4 }
  alias

fn aggregate_block() -> Vec2
  let alias =
    let inner = Vec2 { x: 5, y: 6 }
    inner
  alias

pub fn main() -> i32
  if_alias(Vec2 { x: 7, y: 8 }, true).x +
    block_alias(Vec2 { x: 9, y: 10 }).x +
    aggregate_if(false).x +
    aggregate_block().x
`,
      },
    });

    const moduleId = "src::main";
    const program = optimized.program;
    const parameterFact = (name: string) => {
      const fn = findFunction({ moduleId, name, program });
      expect(fn?.kind, name).toBe("function");
      if (!fn || fn.kind !== "function") {
        return undefined;
      }
      const instanceId = program.functions.getInstanceId(
        moduleId,
        fn.symbol,
        [],
      );
      expect(typeof instanceId, name).toBe("number");
      if (typeof instanceId !== "number") {
        return undefined;
      }
      return optimized.facts.escapeAnalysis.parameters
        .get(instanceId)
        ?.get(fn.parameters[0]!.symbol);
    };
    const aggregateFactsForFunction = (name: string) => {
      const fn = findFunction({ moduleId, name, program });
      expect(fn?.kind, name).toBe("function");
      if (!fn || fn.kind !== "function") {
        return [];
      }
      const moduleView = program.modules.get(moduleId);
      const facts = optimized.facts.escapeAnalysis.origins.get(moduleId);
      const exprIds: number[] = [];
      if (!moduleView || !facts) {
        return [];
      }
      walkExpression({
        exprId: fn.body,
        hir: moduleView.hir,
        onEnterExpression: (exprId, expr) => {
          if (expr.exprKind === "object-literal") {
            exprIds.push(exprId);
          }
        },
      });
      return exprIds.map((exprId) => facts.get(exprId));
    };

    expect(parameterFact("if_alias")).toMatchObject({
      escapes: true,
      escapeReasons: ["return"],
    });
    expect(parameterFact("block_alias")).toMatchObject({
      escapes: true,
      escapeReasons: ["return"],
    });
    expect(aggregateFactsForFunction("aggregate_if")).toEqual([
      expect.objectContaining({
        escapes: true,
        escapeReasons: ["return"],
      }),
      expect.objectContaining({
        escapes: true,
        escapeReasons: ["return"],
      }),
    ]);
    expect(aggregateFactsForFunction("aggregate_block")).toEqual([
      expect.objectContaining({
        escapes: true,
        escapeReasons: ["return"],
      }),
    ]);
  });

  it("treats exported aggregate parameters as public-boundary escapes", async () => {
    const { optimized } = await buildOptimized({
      files: {
        "main.voyd": `
obj Vec2 {
  x: i32,
  y: i32
}

pub fn exported(vec: Vec2) -> i32
  vec.x
`,
      },
    });

    const moduleId = "src::main";
    const program = optimized.program;
    const exportedFn = findFunction({ moduleId, name: "exported", program });
    expect(exportedFn?.kind).toBe("function");
    if (!exportedFn || exportedFn.kind !== "function") return;
    const exportedInstanceId = program.functions.getInstanceId(
      moduleId,
      exportedFn.symbol,
      [],
    );
    expect(typeof exportedInstanceId).toBe("number");
    if (typeof exportedInstanceId !== "number") return;
    expect(
      optimized.facts.escapeAnalysis.parameters
        .get(exportedInstanceId)
        ?.get(exportedFn.parameters[0]!.symbol),
    ).toMatchObject({
      escapes: true,
      escapeReasons: ["public-boundary"],
    });
  });

  it("tracks trait-object receiver temporaries through non-escaping direct calls", async () => {
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

fn invoke(runner: Runner) -> i32
  runner.run()

pub fn main() -> i32
  invoke(Box { value: 4 })
`,
      },
    });

    const moduleId = "src::main";
    const program = optimized.program;
    const invokeFn = findFunction({ moduleId, name: "invoke", program });
    expect(invokeFn?.kind).toBe("function");
    if (!invokeFn || invokeFn.kind !== "function") return;
    const invokeInstanceId = program.functions.getInstanceId(
      moduleId,
      invokeFn.symbol,
      [],
    );
    expect(typeof invokeInstanceId).toBe("number");
    if (typeof invokeInstanceId !== "number") return;

    const runnerParam = invokeFn.parameters[0]!;
    expect(
      program.types.getTypeDesc(
        program.functions.getSignature(moduleId, invokeFn.symbol)!
          .parameters[0]!.typeId,
      ).kind,
    ).toBe("trait");
    expect(
      optimized.facts.escapeAnalysis.parameters
        .get(invokeInstanceId)
        ?.get(runnerParam.symbol),
    ).toMatchObject({
      escapes: false,
      escapeReasons: [],
    });

    const traitObjectFact = Array.from(
      optimized.facts.escapeAnalysis.origins.get(moduleId)?.values() ?? [],
    ).find((fact) => fact.originKind === "trait-object");
    expect(traitObjectFact).toMatchObject({
      escapes: false,
      escapeReasons: [],
    });
  });

  it("marks aggregate captures into closures and effect handler environments", async () => {
    const { optimized } = await buildOptimized({
      files: {
        "main.voyd": `
eff Log
  info(resume, x: i32) -> i32

obj Vec2 {
  x: i32,
  y: i32
}

fn worker(): Log -> i32
  Log::info(5)

fn closure_capture() -> i32
  let vec = Vec2 { x: 1, y: 2 }
  let cb = () => vec.x
  cb()

pub fn main(): () -> i32
  let vec = Vec2 { x: 3, y: 4 }
  closure_capture() + try
    worker()
  Log::info(resume, x):
    vec.x + x
`,
      },
    });

    const moduleId = "src::main";
    const facts = Array.from(
      optimized.facts.escapeAnalysis.origins.get(moduleId)?.values() ?? [],
    );
    expect(facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          originKind: "closure-environment",
          escapes: false,
          escapeReasons: [],
        }),
        expect.objectContaining({
          originKind: "effect-environment",
          escapes: false,
          escapeReasons: [],
        }),
        expect.objectContaining({
          originKind: "aggregate",
          escapes: true,
          escapeReasons: ["closure-capture"],
        }),
        expect.objectContaining({
          originKind: "aggregate",
          escapes: true,
          escapeReasons: ["effect-handler-capture"],
        }),
      ]),
    );
  });

  it("keeps non-entry test exports reachable in optimized all-module test builds", async () => {
    const { optimized, entryModuleId, tests } = await buildOptimized({
      files: {
        "main.voyd": `
use src::util::anchor

pub fn main() -> i32
  anchor()
`,
        "util.voyd": `
pub fn anchor() -> i32
  1

test "reachable from export root":
  anchor()
`,
      },
      includeTests: true,
      optimizeOptions: {
        testMode: true,
        testScope: "all",
      },
    });

    const utilTest = tests.find((test) => test.moduleId === "src::util");
    expect(utilTest?.exportName).toBeDefined();
    if (!utilTest?.exportName) return;

    const utilModuleId = "src::util";
    const testFn = Array.from(
      optimized.program.modules.get(utilModuleId)?.hir.items.values() ?? [],
    ).find(
      (item) =>
        item.kind === "function" &&
        optimized.program.symbols
          .getName(
            optimized.program.symbols.idOf({
              moduleId: utilModuleId,
              symbol: item.symbol,
            }),
          )
          ?.startsWith("__test__"),
    );
    expect(testFn?.kind).toBe("function");
    if (!testFn || testFn.kind !== "function") return;

    const instanceId = optimized.program.functions.getInstanceId(
      utilModuleId,
      testFn.symbol,
      [],
    );
    expect(typeof instanceId).toBe("number");
    if (typeof instanceId !== "number") return;
    expect(optimized.facts.reachableFunctionInstances.has(instanceId)).toBe(
      true,
    );

    const codegen = codegenProgram({
      program: optimized.program,
      entryModuleId,
      optimization: optimized.facts,
      options: {
        optimize: false,
        validate: false,
        runtimeDiagnostics: false,
        testMode: true,
        testScope: "all",
      },
    });
    expect(codegen.diagnostics).toHaveLength(0);
    expect(codegen.module.emitText()).toContain(
      `(export "${utilTest.exportName}"`,
    );
  });

  it("lowers exact nominal field reads to direct struct loads", async () => {
    const { optimized, entryModuleId } = await buildOptimized({
      files: {
        "main.voyd": `
obj Vec2 {
  x: i32,
  y: i32
}

fn read(vec: Vec2) -> i32
  vec.x + vec.y

pub fn main() -> i32
  let vec = Vec2 { x: 1, y: 2 }
  read(vec)
`,
      },
    });

    const candidates =
      optimized.facts.runtimeTypeCheckElisionFieldAccesses.get("src::main");
    expect(candidates?.size).toBeGreaterThanOrEqual(2);

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

    expect(optimizedWasmText).not.toContain("call $__has_type");
    expect(optimizedWasmText).not.toContain("call $__lookup_field_accessor");
    expect(baselineWasmText).toContain("call $__lookup_field_accessor");
  });

  it("marks direct object-literal field accesses for semantic copy forwarding", async () => {
    const { optimized, entryModuleId } = await buildOptimized({
      files: {
        "main.voyd": `
obj Vec2 {
  x: i32,
  y: i32
}

fn bump(value: i32) -> i32
  value + 1

pub fn main() -> i32
  (Vec2 { x: bump(1), y: bump(2) }).y
`,
      },
    });

    const candidates =
      optimized.facts.semanticCopyForwardingFieldAccesses.get("src::main");
    expect(candidates?.size).toBe(1);

    const codegen = codegenProgram({
      program: optimized.program,
      entryModuleId,
      optimization: optimized.facts,
      options: {
        optimize: false,
        validate: false,
        runtimeDiagnostics: false,
      },
    });
    expect(codegen.diagnostics).toHaveLength(0);
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

  it("keeps dependencies reached only through dynamic trait impl bodies", async () => {
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

fn finish(value: i32) -> i32
  value + 2

impl Runner for Box
  fn run(self) -> i32
    finish(self.value)

impl Runner for Alt
  fn run(self) -> i32
    finish(self.value + 1)

fn invoke(runner: Runner) -> i32
  runner.run()

pub fn main() -> i32
  invoke(Box { value: 4 })
`,
      },
    });

    const { diagnostics } = codegenProgram({
      program: optimized.program,
      entryModuleId,
      optimization: optimized.facts,
      options: {
        optimize: false,
        validate: false,
        runtimeDiagnostics: false,
      },
    });

    expect(diagnostics).toHaveLength(0);
  });

  it("plans and emits compact recursive default-argument call shapes", async () => {
    const { optimized, entryModuleId } = await buildOptimized({
      files: {
        "main.voyd": `
obj Some<T> {
  value: T
}

obj None {}

type Optional<T> = Some<T> | None

fn sum_to(n: i32, step: i32 = 1) -> i32
  if
    n <= 0:
      0
    else:
      n + sum_to(n - step, step)

fn combine({ left: i32 = 4, right: i32 }) -> i32
  left + right

fn optional_state(value?: i32) -> i32
  match(value)
    Some<i32>:
      2
    None:
      1

obj Counter {
  value: i32
}

fn bump(~counter: Counter) -> i32
  counter.value = counter.value + 1
  counter.value

fn resolve(~counter: Counter, value: i32 = bump(counter)) -> i32
  value

val Wide {
  a: i32,
  b: i32,
  c: i32,
  d: i32,
  e: i32
}

fn wide_sum(value: Wide = Wide { a: 1, b: 2, c: 3, d: 4, e: 5 }) -> i32
  value.a + value.b + value.c + value.d + value.e

eff Tick
  next(tail) -> i32

fn effect_with_default(value: i32 = 3): Tick -> i32
  Tick::next() + value

fn run_effect_with_default() -> i32
  try
    effect_with_default()
  Tick::next(tail):
    tail(7)

pub fn main() -> i32
  let ~counter = Counter { value: 0 }
  let options = { left: 6, right: 7 }
  let default_result = resolve(counter)
  let provided_result = resolve(counter, 9)
  sum_to(5) + sum_to(5, 2) +
    combine({ right: 3 }) + combine({ left: 5, right: 3 }) + combine(options) +
    optional_state() + optional_state(9) +
    default_result * 100 + counter.value * 10 + provided_result +
    wide_sum() + wide_sum(Wide { a: 2, b: 2, c: 2, d: 2, e: 2 }) +
    run_effect_with_default()
`,
      },
    });

    const requests = Array.from(
      optimized.facts.callShapeSpecializationRequests.values(),
    ).flatMap((byCaller) => Array.from(byCaller.values()));
    expect(requests.map((request) => request.keyTokens.join("|"))).toEqual(
      expect.arrayContaining(["v1|provided|omitted", "v1|provided|provided"]),
    );

    const codegen = codegenProgram({
      program: optimized.program,
      entryModuleId,
      optimization: optimized.facts,
      options: {
        optimize: false,
        validate: true,
        runtimeDiagnostics: false,
      },
    });
    expect(codegen.diagnostics).toHaveLength(0);
    const wasmText = codegen.module.emitText();
    expect(wasmText).toContain("__call_shape_po");
    expect(wasmText).toContain("__call_shape_pp");
    expect(wasmText).toMatch(/combine_\d+__call_shape_op/);
    expect(wasmText).toMatch(/combine_\d+__call_shape_pp/);
    expect(wasmText).toMatch(/optional_state_\d+__call_shape_o/);
    expect(wasmText).toMatch(/wide_sum_\d+__call_shape_o/);
    expect(wasmText).toMatch(/wide_sum_\d+__call_shape_p/);
    expect(wasmText).toMatch(/effect_with_default_\d+__call_shape_o/);
    const signatures = wasmText
      .split("\n")
      .filter((line) => line.includes("sum_to") && line.includes("(func $"));
    const providedSignature = signatures.find((line) =>
      line.includes("__call_shape_pp"),
    );
    const omittedSignature = signatures.find((line) =>
      line.includes("__call_shape_po"),
    );
    expect(providedSignature?.match(/\(param/g)).toHaveLength(2);
    expect(omittedSignature?.match(/\(param/g)).toHaveLength(1);

    const instance = getWasmInstance(codegen.module);
    expect((instance.exports.main as () => number)()).toBe(209);

    const fallbackFacts = {
      ...optimized.facts,
      codegenPlan: {
        ...optimized.facts.codegenPlan,
        specializationPolicy: {
          ...optimized.facts.codegenPlan.specializationPolicy,
          callShapeContextsPerFunction: 0,
        },
      },
    };
    const fallbackCodegen = codegenProgram({
      program: optimized.program,
      entryModuleId,
      optimization: fallbackFacts,
      options: {
        optimize: false,
        validate: true,
        runtimeDiagnostics: false,
      },
    });
    expect(fallbackCodegen.module.emitText()).not.toContain("__call_shape_");
    const fallbackInstance = getWasmInstance(fallbackCodegen.module);
    expect((fallbackInstance.exports.main as () => number)()).toBe(209);
  });

  it("shares a raw stable-callsite shape while preserving per-site ids", async () => {
    const { optimized, entryModuleId } = await buildOptimized({
      files: {
        "main.voyd": `
use std::ids::{ tagged, choose }

fn first() -> i32
  tagged()

fn second() -> i32
  tagged()

pub fn main() -> i32
  if
    first() != second():
      choose<i32>(3) + choose<i32>(3, 4)
    else:
      0
`,
      },
      stdFiles: {
        "ids.voyd": `
obj Some<T> {
  value: T
}

obj None {}

type Optional<T> = Some<T> | None

@intrinsic(name: "__stable_callsite_id")
fn stable_callsite_id(): () -> i32
  0

pub fn tagged(id: i32 = stable_callsite_id()) -> i32
  id

pub fn choose<T>(fallback: T, value: T = fallback) -> T
  value
`,
      },
    });

    const stableRequests = Array.from(
      optimized.facts.callShapeSpecializationRequests.values(),
    )
      .flatMap((byCaller) => Array.from(byCaller.values()))
      .filter((request) => request.keyTokens.includes("stable-callsite-id"));
    expect(stableRequests).toHaveLength(2);
    expect(
      new Set(stableRequests.map((request) => request.keyTokens.join("|"))),
    ).toEqual(new Set(["v1|stable-callsite-id"]));

    const codegen = codegenProgram({
      program: optimized.program,
      entryModuleId,
      optimization: optimized.facts,
      options: {
        optimize: false,
        validate: true,
        runtimeDiagnostics: false,
      },
    });
    const wasmText = codegen.module.emitText();
    const stableDefinitions = wasmText
      .split("\n")
      .filter(
        (line) =>
          line.includes("(func $") &&
          line.includes("tagged_") &&
          line.includes("__call_shape_s"),
      );
    expect(stableDefinitions).toHaveLength(1);
    expect(stableDefinitions[0]?.match(/\(param/g)).toHaveLength(1);
    expect(wasmText).toMatch(/choose_\d+__inst_\d+__call_shape_po/);
    expect(wasmText).toMatch(/choose_\d+__inst_\d+__call_shape_pp/);

    const instance = getWasmInstance(codegen.module);
    expect((instance.exports.main as () => number)()).toBe(7);
  });
});
