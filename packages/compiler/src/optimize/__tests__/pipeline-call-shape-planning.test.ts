import { describe, expect, it } from "vitest";
import { codegenProgram } from "../../codegen/index.js";
import { getWasmInstance } from "@voyd-lang/lib/wasm.js";
import { buildOptimized } from "./pipeline-test-helpers.js";

describe("compiler optimization pipeline: call-shape-planning", () => {
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
