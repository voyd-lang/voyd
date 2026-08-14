import { describe, expect, it, vi } from "vitest";
import { getWasmInstance } from "@voyd-lang/lib/wasm.js";
import { parse } from "../../parser/index.js";
import { semanticsPipeline } from "../../semantics/pipeline.js";
import { monomorphizeProgram } from "../../semantics/linking.js";
import {
  buildProgramCodegenView,
  type ExactCallOptimizationFact,
} from "../../semantics/codegen-view/index.js";
import { optimizeProgram } from "../../optimize/pipeline.js";
import { codegenProgram } from "../index.js";
import type { ModuleGraph, ModuleNode } from "../../modules/types.js";

const perf = vi.hoisted(() => ({ increment: vi.fn() }));
vi.mock("../../perf.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../perf.js")>()),
  incrementCompilerPerfCounter: perf.increment,
}));

const recordedCounters = (): string[] =>
  perf.increment.mock.calls.map(([name]) => String(name));

const compile = (
  source: string,
  exactFactOverride?: ExactCallOptimizationFact,
) => {
  const ast = parse(source, "stable_field_load_forwarding.voyd");
  const moduleNode: ModuleNode = {
    id: "std::stable_field_load_forwarding",
    path: { namespace: "std", segments: ["stable_field_load_forwarding"] },
    origin: { kind: "file", filePath: "stable_field_load_forwarding.voyd" },
    ast,
    source,
    dependencies: [],
  };
  const graph: ModuleGraph = {
    entry: moduleNode.id,
    modules: new Map([[moduleNode.id, moduleNode]]),
    diagnostics: [],
  };
  const semantics = semanticsPipeline({ module: moduleNode, graph });
  const semanticsByModule = new Map([[moduleNode.id, semantics]]);
  const monomorphized = monomorphizeProgram({
    modules: [semantics],
    semantics: semanticsByModule,
  });
  const program = buildProgramCodegenView([semantics], {
    instances: monomorphized.instances,
    moduleTyping: monomorphized.moduleTyping,
  });
  if (exactFactOverride) {
    const bump = Array.from(semantics.hir.items.values()).find(
      (item) =>
        item.kind === "function" &&
        semantics.binding.symbolTable.getSymbol(item.symbol).name === "bump",
    );
    if (bump?.kind !== "function") {
      throw new Error("missing bump function in stable-field fixture");
    }
    const bumpTarget = program.functions.getFunctionId({
      moduleId: moduleNode.id,
      symbol: bump.symbol,
    });
    expect(bumpTarget).toBeDefined();
    const exactCallOptimizations = program.exactCallOptimizations;
    program.exactCallOptimizations = {
      getFact: (target) =>
        target === bumpTarget
          ? { kind: "available", fact: exactFactOverride }
          : exactCallOptimizations.getFact(target),
      getMetrics: () => exactCallOptimizations.getMetrics(),
    };
  }
  const exactMetricsBeforeOptimization =
    program.exactCallOptimizations.getMetrics();
  const optimized = optimizeProgram({
    program,
    modules: [semantics],
    entryModuleId: moduleNode.id,
  });
  const generated = codegenProgram({
    program: optimized.program,
    entryModuleId: moduleNode.id,
    optimization: optimized.facts,
    options: { validate: true },
  });
  const baseline = codegenProgram({
    program: optimized.program,
    entryModuleId: moduleNode.id,
    options: { validate: true },
  });
  if (generated.diagnostics.length > 0) {
    throw new Error(JSON.stringify(generated.diagnostics, null, 2));
  }
  return {
    optimized,
    generated,
    baseline,
    program,
    exactMetricsBeforeOptimization,
    moduleId: moduleNode.id,
  };
};

const source = ({ mutation }: { mutation: "sibling" | "same" | "root" }) => `
obj Record { stable: i32, changing: i32 }

fn bump(~value: Record) -> void
  ${
    mutation === "sibling"
      ? "value.changing = value.changing + 1"
      : mutation === "same"
        ? "value.stable = value.stable + 1"
        : "value = Record { stable: 9, changing: 0 }"
  }

pub fn main() -> i32
  let ~value = Record { stable: 3, changing: 0 }
  let alias = value
  var iteration = 0
  var total = 0
  while iteration < 10:
    total = total + alias.stable
    bump(~value)
    total = total + alias.stable
    iteration = iteration + 1
  total + value.changing
`;

describe("stable field load forwarding", () => {
  it("forwards a fixed field load across a resolved disjoint call", () => {
    const {
      optimized,
      generated,
      baseline,
      program,
      exactMetricsBeforeOptimization,
      moduleId,
    } = compile(source({ mutation: "sibling" }));
    const instance = getWasmInstance(generated.module);
    expect((instance.exports.main as () => number)()).toBe(70);
    expect(optimized.facts.stableFieldLoadForwarding.get(moduleId)?.size).toBe(
      1,
    );
    const structGets = (text: string) =>
      Array.from(text.matchAll(/\(struct\.get\b/g)).length;
    expect(structGets(generated.module.emitText())).toBeLessThan(
      structGets(baseline.module.emitText()),
    );
    expect(exactMetricsBeforeOptimization.requests).toBe(0);
    expect(program.exactCallOptimizations.getMetrics()).toMatchObject({
      cacheMisses: 1,
      bodyVisits: 1,
      acceptedFacts: 1,
      fallbacks: 0,
      budgetExhaustions: 0,
    });
    expect(
      program.exactCallOptimizations.getMetrics().cacheHits,
    ).toBeGreaterThan(0);
    expect(recordedCounters()).toContain(
      "optimize.pass.stable-field-load-forwarding.accepted",
    );
    expect(recordedCounters()).toEqual(
      expect.arrayContaining([
        "codegen.exact_call.cache_misses",
        "codegen.exact_call.body_visits",
        "codegen.exact_call.analysis_operations",
      ]),
    );
  });

  it("bails out when an otherwise disjoint callee has a nested call", () => {
    const { optimized, moduleId } = compile(`
obj Record { stable: i32, changing: i32 }

fn increment(value: i32) -> i32
  value + 1

fn bump(~value: Record) -> void
  value.changing = increment(value.changing)

pub fn main() -> i32
  let ~value = Record { stable: 3, changing: 0 }
  let alias = value
  var iteration = 0
  var total = 0
  while iteration < 10:
    total = total + alias.stable
    bump(~value)
    total = total + alias.stable
    iteration = iteration + 1
  total
`);
    expect(
      optimized.facts.stableFieldLoadForwarding.get(moduleId)?.size ?? 0,
    ).toBe(0);
    expect(recordedCounters()).toContain(
      "optimize.pass.stable-field-load-forwarding.fallback.unsafe-boundary",
    );
  });

  it.each([
    ["escape", { escapes: true }],
    ["retention", { retained: true }],
    ["result-alias", { resultAliases: true }],
  ] as const)("records the bounded %s fallback", (reason, override) => {
    const parameter = {
      readFields: ["changing"],
      writeFields: ["changing"],
      readsWholeValue: false,
      writesWholeValue: false,
      indirectAccess: false,
      escapes: false,
      retained: false,
      resultAliases: false,
      ...override,
    };
    const { optimized, moduleId } = compile(source({ mutation: "sibling" }), {
      parameters: [parameter],
      explicitReturn: false,
      nestedCall: false,
      recursiveCall: false,
      dynamicCall: false,
      unresolvedCall: false,
      identityGuard: false,
      externalAccess: false,
      maySuspend: false,
    });

    expect(
      optimized.facts.stableFieldLoadForwarding.get(moduleId)?.size ?? 0,
    ).toBe(0);
    expect(recordedCounters()).toContain(
      `optimize.pass.stable-field-load-forwarding.fallback.${reason}`,
    );
  });

  it.each(["same", "root"] as const)(
    "does not forward across a %s write",
    (mutation) => {
      const { optimized, moduleId } = compile(source({ mutation }));
      expect(
        optimized.facts.stableFieldLoadForwarding.get(moduleId)?.size ?? 0,
      ).toBe(0);
    },
  );

  it("bails out when a prior call returns provenance from the candidate root", () => {
    const { optimized, moduleId } = compile(`
obj Record { stable: i32, changing: i32 }

fn save(value: Record) -> Record
  value

fn bump(~value: Record) -> void
  value.changing = value.changing + 1

pub fn main() -> i32
  let ~value = Record { stable: 3, changing: 0 }
  let alias = value
  let saved = save(value)
  var iteration = 0
  var total = 0
  while iteration < 10:
    total = total + alias.stable
    bump(~value)
    total = total + alias.stable
    iteration = iteration + 1
  total + saved.changing
`);
    expect(
      optimized.facts.stableFieldLoadForwarding.get(moduleId)?.size ?? 0,
    ).toBe(0);
    expect(recordedCounters()).toContain(
      "optimize.pass.stable-field-load-forwarding.fallback.result-alias",
    );
  });

  it("rejects dynamic mutation whose open declaration cannot exclude aliasing", () => {
    expect(() =>
      compile(`
obj Record { stable: i32, changing: i32 }
trait Mutator
  fn bump(self, ~value: Record): () -> void

obj Increment {}
impl Mutator for Increment
  fn bump(self, ~value: Record) -> void
    value.changing = value.changing + 1

obj Reset {}
impl Mutator for Reset
  fn bump(self, ~value: Record) -> void
    value.stable = 0

fn run(mutator: Mutator) -> i32
  let ~value = Record { stable: 3, changing: 0 }
  let alias = value
  var iteration = 0
  var total = 0
  while iteration < 10:
    total = total + alias.stable
    mutator.bump(~value)
    total = total + alias.stable
    iteration = iteration + 1
  total

pub fn main(flag: i32) -> i32
  let mutator: Mutator = if flag == 0 then: Increment {} else: Reset {}
  run(mutator)
`),
    ).toThrow(/TY0048/);
  });

  it("bails out for an unresolved function-value call", () => {
    const { optimized, moduleId } = compile(`
obj Record { stable: i32, changing: i32 }

fn run(callback: fn(~Record) : () -> void) -> i32
  let ~value = Record { stable: 3, changing: 0 }
  let alias = value
  var iteration = 0
  var total = 0
  while iteration < 10:
    total = total + alias.stable
    callback(~value)
    total = total + alias.stable
    iteration = iteration + 1
  total

pub fn main() -> i32
  run((~value) => value.changing = value.changing + 1)
`);
    expect(
      optimized.facts.stableFieldLoadForwarding.get(moduleId)?.size ?? 0,
    ).toBe(0);
  });

  it("does not plan forwarding for indexed field paths", () => {
    const { optimized, moduleId } = compile(`
obj Record { stable: i32, changing: i32 }

fn new_array_unchecked<T>({ from source: FixedArray<T> }) -> FixedArray<T>
  source

pub fn main() -> i32
  let values = [Record { stable: 3, changing: 0 }]
  var iteration = 0
  var total = 0
  while iteration < 10:
    total = total + __array_get(values, 0).stable
    total = total + __array_get(values, 0).stable
    iteration = iteration + 1
  total
`);
    expect(
      optimized.facts.stableFieldLoadForwarding.get(moduleId)?.size ?? 0,
    ).toBe(0);
  });
});
