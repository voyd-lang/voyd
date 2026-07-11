import { describe, expect, it } from "vitest";
import { walkExpression } from "../../semantics/hir/index.js";
import { codegenProgram } from "../../codegen/index.js";
import type { HirMethodCallExpr } from "../../semantics/hir/index.js";
import {
  buildOptimized,
  findFunction,
  findObjectNominal,
} from "./pipeline-test-helpers.js";

describe("compiler optimization pipeline: receiver-trait", () => {
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
});
