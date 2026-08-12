import { beforeEach, describe, expect, it, vi } from "vitest";
import { getWasmInstance } from "@voyd-lang/lib/wasm.js";
import { parse } from "../../parser/index.js";
import { semanticsPipeline } from "../../semantics/pipeline.js";
import { monomorphizeProgram } from "../../semantics/linking.js";
import { buildProgramCodegenView } from "../../semantics/codegen-view/index.js";
import { optimizeProgram } from "../../optimize/pipeline.js";
import { codegen, codegenProgram } from "../index.js";
import type { ModuleGraph, ModuleNode } from "../../modules/types.js";

const perf = vi.hoisted(() => ({ increment: vi.fn() }));
vi.mock("../../perf.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../perf.js")>()),
  incrementCompilerPerfCounter: perf.increment,
}));

const recordedCounters = (): string[] =>
  perf.increment.mock.calls.map(([name]) => String(name));

const compileProgram = (
  source: string,
  mode: "baseline" | "optimized" = "baseline",
) => {
  const ast = parse(source, "borrowed_array_element_views.voyd");
  const moduleNode: ModuleNode = {
    id: "std::borrowed_array_element_views",
    path: { namespace: "std", segments: ["borrowed_array_element_views"] },
    origin: {
      kind: "file",
      filePath: "borrowed_array_element_views.voyd",
    },
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
  const generated =
    mode === "baseline"
      ? codegen(semantics)
      : (() => {
          const semanticsByModule = new Map([[moduleNode.id, semantics]]);
          const monomorphized = monomorphizeProgram({
            modules: [semantics],
            semantics: semanticsByModule,
          });
          const program = buildProgramCodegenView([semantics], {
            instances: monomorphized.instances,
            moduleTyping: monomorphized.moduleTyping,
          });
          const optimized = optimizeProgram({
            program,
            modules: [semantics],
            entryModuleId: moduleNode.id,
          });
          return codegenProgram({
            program: optimized.program,
            entryModuleId: moduleNode.id,
            optimization: optimized.facts,
          });
        })();
  const { module, diagnostics } = generated;
  if (diagnostics.length > 0) {
    throw new Error(JSON.stringify(diagnostics, null, 2));
  }
  const instance = getWasmInstance(module);
  return { instance, module };
};

const compileMain = (source: string): (() => number) =>
  compileProgram(source).instance.exports.main as () => number;

describe("borrowed array element views", () => {
  beforeEach(() => perf.increment.mockClear());

  it("lowers call-scoped identity guards after single-shot arguments", () => {
    const { instance, module } = compileProgram(`
obj Box { value: i32 }

fn mutate_both(~left: Box, ~right: Box) -> i32
  left.value = left.value + 1
  right.value = right.value + 2
  left.value + right.value

fn guarded(~left: Box, ~right: Box) -> i32
  mutate_both(~left, ~right)

pub fn main() -> i32
  let ~left = Box { value: 1 }
  let ~right = Box { value: 10 }
  guarded(~left, ~right)
`);
    expect((instance.exports.main as () => number)()).toBe(14);
    expect(module.emitText()).toContain("ref.eq");
    expect(recordedCounters()).toContain(
      "borrowing.identity_guard.emitted.immediate",
    );
  });

  it("compares mutable root storage instead of aliased stored objects", () => {
    const { instance, module } = compileProgram(`
obj Box { value: i32 }

fn replace_both(~left: Box, ~right: Box) -> i32
  left = Box { value: 1 }
  right = Box { value: 2 }
  left.value + right.value

fn guarded(~left: Box, ~right: Box) -> i32
  replace_both(~left, ~right)

pub fn main() -> i32
  let ~left = Box { value: 0 }
  let ~right = Box { value: 10 }
  right = left
  guarded(~left, ~right)
`);
    expect((instance.exports.main as () => number)()).toBe(3);
    expect(module.emitText()).toContain("ref.eq");
  });

  it("does not emit a guard for statically disjoint arguments", () => {
    const { instance, module } = compileProgram(`
obj Box { value: i32 }

fn mutate_both(~left: Box, ~right: Box) -> i32
  left.value = left.value + 1
  right.value = right.value + 2
  left.value + right.value

pub fn main() -> i32
  let ~values = __array_new_fixed(
    Box { value: 1 },
    Box { value: 10 }
  )
  mutate_both(
    ~__array_get(values, 0),
    ~__array_get(values, 1)
  )
`);
    expect((instance.exports.main as () => number)()).toBe(14);
    expect(module.emitText()).not.toContain("ref.eq");
  });

  it("guards dynamically selected fixed-array allocations", () => {
    const { instance } = compileProgram(`
obj Box { value: i32 }

fn mutate_both(~left: Box, ~right: Box) -> i32
  left.value = left.value + 1
  right.value = right.value + 2
  left.value + right.value

fn guarded(
  ~values: FixedArray<Box>,
  left: i32,
  right: i32
) -> i32
  mutate_both(
    ~__array_get(values, left),
    ~__array_get(values, right)
  )

pub fn distinct() -> i32
  let ~values = __array_new_fixed(
    Box { value: 1 },
    Box { value: 10 }
  )
  guarded(~values, 0, 1)

pub fn overlapping() -> i32
  let ~values = __array_new_fixed(
    Box { value: 1 },
    Box { value: 10 }
  )
  guarded(~values, 0, 0)

pub fn aliased_elements() -> i32
  let ~shared = Box { value: 1 }
  let ~values = __array_new_fixed(shared, shared)
  guarded(~values, 0, 1)
`);
    expect((instance.exports.distinct as () => number)()).toBe(14);
    expect(() => (instance.exports.overlapping as () => number)()).toThrow();
    expect(() =>
      (instance.exports.aliased_elements as () => number)(),
    ).toThrow();
  });

  it("compares the nested allocation reached by dereferenced footprints", () => {
    const { instance } = compileProgram(`
obj Box { value: i32 }
obj Holder { box: Box }

fn mutate_both(~left: Holder, ~right: Holder) -> i32
  left.box.value = left.box.value + 1
  right.box.value = right.box.value + 2
  left.box.value + right.box.value

fn guarded(
  ~values: FixedArray<Holder>,
  left: i32,
  right: i32
) -> i32
  mutate_both(
    ~__array_get(values, left),
    ~__array_get(values, right)
  )

pub fn distinct() -> i32
  let ~values = __array_new_fixed(
    Holder { box: Box { value: 1 } },
    Holder { box: Box { value: 10 } }
  )
  guarded(~values, 0, 1)

pub fn aliased_nested() -> i32
  let shared = Box { value: 1 }
  let ~values = __array_new_fixed(
    Holder { box: shared },
    Holder { box: shared }
  )
  guarded(~values, 0, 1)

pub fn distinct_constants() -> i32
  let ~values = __array_new_fixed(
    Holder { box: Box { value: 1 } },
    Holder { box: Box { value: 10 } }
  )
  mutate_both(
    ~__array_get(values, 0),
    ~__array_get(values, 1)
  )

pub fn aliased_nested_constants() -> i32
  let shared = Box { value: 1 }
  let ~values = __array_new_fixed(
    Holder { box: shared },
    Holder { box: shared }
  )
  mutate_both(
    ~__array_get(values, 0),
    ~__array_get(values, 1)
  )
`);
    expect((instance.exports.distinct_constants as () => number)()).toBe(14);
    expect((instance.exports.distinct as () => number)()).toBe(14);
    expect(() => (instance.exports.aliased_nested as () => number)()).toThrow();
    expect(() =>
      (instance.exports.aliased_nested_constants as () => number)(),
    ).toThrow();
  });

  it("compares complete identities for dynamic projected value places", () => {
    const { instance, module } = compileProgram(`
val WideVec5 {
  a: i32,
  b: i32,
  c: i32,
  d: i32,
  e: i32
}

fn mutate_both(~left: WideVec5, ~right: WideVec5) -> i32
  left.a = left.a + 1
  right.a = right.a + 2
  left.a + right.a

fn guarded(
  ~values: FixedArray<WideVec5>,
  left: i32,
  right: i32
) -> i32
  mutate_both(
    ~__array_get(values, left),
    ~__array_get(values, right)
  )

pub fn distinct() -> i32
  let ~values = __array_new<WideVec5>(2)
  __array_set(values, 0, WideVec5 { a: 1, b: 0, c: 0, d: 0, e: 0 })
  __array_set(values, 1, WideVec5 { a: 10, b: 0, c: 0, d: 0, e: 0 })
  guarded(~values, 0, 1)

pub fn overlapping() -> i32
  let ~values = __array_new<WideVec5>(2)
  __array_set(values, 0, WideVec5 { a: 1, b: 0, c: 0, d: 0, e: 0 })
  __array_set(values, 1, WideVec5 { a: 10, b: 0, c: 0, d: 0, e: 0 })
  guarded(~values, 0, 0)
`);
    expect((instance.exports.distinct as () => number)()).toBe(14);
    expect(() => (instance.exports.overlapping as () => number)()).toThrow();
    expect(module.emitText()).toMatch(/ref\.eq[\s\S]*i32\.eq/);
  });

  it("lowers identity guards after omitted defaults", () => {
    const { instance, module } = compileProgram(`
obj Box { value: i32 }

fn mutate_both(
  ~left: Box,
  ~right: Box,
  increment: i32 = 2
) -> i32
  left.value = left.value + increment
  right.value = right.value + increment
  left.value + right.value

fn guarded(~left: Box, ~right: Box) -> i32
  mutate_both(~left, ~right)

pub fn distinct() -> i32
  let ~left = Box { value: 1 }
  let ~right = Box { value: 10 }
  guarded(~left, ~right)
`);
    expect((instance.exports.distinct as () => number)()).toBe(15);
    expect(module.emitText()).toContain("__voyd_panic_ptr");
    expect(recordedCounters()).toContain(
      "borrowing.identity_guard.emitted.deferred_default",
    );
    expect(recordedCounters()).toContain(
      "codegen.default_identity_guard_companion.created",
    );
    expect(recordedCounters()).toContain(
      "codegen.default_identity_guard_companion.compiled",
    );
  });

  it("does not emit a guarded companion for a statically safe default", () => {
    const { instance, module } = compileProgram(`
pub fn identity(value: i32 = 1) -> i32
  value

pub fn main() -> i32
  identity()
`);
    expect((instance.exports.main as () => number)()).toBe(1);
    expect(module.emitText()).not.toContain("__default_identity_guard_v1");
    expect(recordedCounters()).not.toContain(
      "codegen.default_identity_guard_companion.requested",
    );
  });

  it("defers complete projected-place conflicts until after defaults", () => {
    const { instance } = compileProgram(`
val WideVec5 {
  a: i32,
  b: i32,
  c: i32,
  d: i32,
  e: i32
}

fn mutate_both(
  ~left: WideVec5,
  ~right: WideVec5,
  increment: i32 = 2
) -> i32
  left.a = left.a + increment
  right.a = right.a + increment
  left.a + right.a

fn guarded(
  ~values: FixedArray<WideVec5>,
  left: i32,
  right: i32
) -> i32
  mutate_both(
    ~__array_get(values, left),
    ~__array_get(values, right)
  )

pub fn distinct() -> i32
  let ~values = __array_new<WideVec5>(2)
  __array_set(values, 0, WideVec5 { a: 1, b: 0, c: 0, d: 0, e: 0 })
  __array_set(values, 1, WideVec5 { a: 10, b: 0, c: 0, d: 0, e: 0 })
  guarded(~values, 0, 1)

pub fn overlapping() -> i32
  let ~values = __array_new<WideVec5>(2)
  __array_set(values, 0, WideVec5 { a: 1, b: 0, c: 0, d: 0, e: 0 })
  __array_set(values, 1, WideVec5 { a: 10, b: 0, c: 0, d: 0, e: 0 })
  guarded(~values, 0, 0)
`);
    expect((instance.exports.distinct as () => number)()).toBe(15);
    expect(() => (instance.exports.overlapping as () => number)()).toThrow();
  });

  it("guards nested identities behind distinct outer nominals", () => {
    const { instance, module } = compileProgram(`
obj Box { value: i32 }
obj LeftHolder { box: Box }
obj RightHolder { box: Box }

fn mutate_nested(~left: LeftHolder, ~right: RightHolder) -> i32
  left.box.value = left.box.value + 1
  right.box.value = right.box.value + 2
  left.box.value + right.box.value

pub fn distinct() -> i32
  let ~left = LeftHolder { box: Box { value: 1 } }
  let ~right = RightHolder { box: Box { value: 10 } }
  mutate_nested(~left, ~right)

pub fn overlapping() -> i32
  let shared = Box { value: 1 }
  let ~left = LeftHolder { box: shared }
  let ~right = RightHolder { box: shared }
  mutate_nested(~left, ~right)
`);
    expect((instance.exports.distinct as () => number)()).toBe(14);
    expect(() => (instance.exports.overlapping as () => number)()).toThrow();
    expect(module.emitText()).toContain("ref.eq");
  });

  it("evaluates guard operands and defaults once in source order", () => {
    const { instance } = compileProgram(`
obj Box { value: i32 }
obj Counter { state: i32 }

fn stamp(~counter: Counter, digit: i32) -> i32
  counter.state = counter.state * 10 + digit
  digit

fn select(
  ~counter: Counter,
  ~value: Box,
  digit: i32
) -> Box
  stamp(~counter, digit)
  value

fn mutate_both(
  ~left: Box,
  ~right: Box,
  ~counter: Counter,
  increment: i32 = stamp(~counter, 3)
) -> i32
  left.value = left.value + increment
  right.value = right.value + increment
  left.value + right.value

fn guarded(
  ~counter: Counter,
  ~left: Box,
  ~right: Box
) -> i32
  mutate_both(
    ~select(~counter, ~left, 1),
    ~select(~counter, ~right, 2),
    ~counter
  )

pub fn main() -> i32
  let ~counter = Counter { state: 0 }
  let ~left = Box { value: 1 }
  let ~right = Box { value: 10 }
  guarded(~counter, ~left, ~right) + counter.state * 100
`);
    expect((instance.exports.main as () => number)()).toBe(12317);
  });

  it("preserves side effects and skips the callee on a guard trap", () => {
    const { instance } = compileProgram(`
obj Box { value: i32 }

fn record(digit: i32) -> i32
  let current = __memory_load_u32(0)
  __memory_store_u32(0, current * 10 + digit)
  digit

fn recorded_index(value: i32, digit: i32) -> i32
  record(digit)
  value

fn guarded(
  ~left: Box,
  ~right: Box,
  increment: i32 = record(3)
) -> i32
  record(4)
  left.value = left.value + increment
  right.value = right.value + increment
  left.value + right.value

pub fn run(right: i32) -> i32
  __memory_store_u32(0, 0)
  let ~values = __array_new_fixed(
    Box { value: 1 },
    Box { value: 10 }
  )
  guarded(
    ~__array_get(values, recorded_index(0, 1)),
    ~__array_get(values, recorded_index(right, 2))
  )
`);
    const run = instance.exports.run as (right: number) => number;
    const memory = instance.exports.memory as WebAssembly.Memory;
    const recorded = () => new DataView(memory.buffer).getUint32(0, true);

    expect(run(1)).toBe(17);
    expect(recorded()).toBe(1234);
    expect(() => run(0)).toThrow();
    expect(recorded()).toBe(123);
  });

  it("lowers identity guards for open trait dispatch", () => {
    const { instance } = compileProgram(`
obj Box { value: i32 }

trait Mutator
  fn update(~self, ~left: Box, ~right: Box) -> i32

obj ConcreteMutator {}

impl Mutator for ConcreteMutator
  fn update(~self, ~left: Box, ~right: Box) -> i32
    left.value = left.value + 1
    right.value = right.value + 2
    left.value + right.value

fn guarded(
  ~mutator: Mutator,
  ~left: Box,
  ~right: Box
) -> i32
  mutator.update(~left, ~right)

pub fn main() -> i32
  let ~mutator: Mutator = ConcreteMutator {}
  let ~left = Box { value: 1 }
  let ~right = Box { value: 10 }
  guarded(~mutator, ~left, ~right)
`);
    expect((instance.exports.main as () => number)()).toBe(14);
  });

  it("uses allocation identity for mutable open trait receivers", () => {
    const { instance } = compileProgram(`
obj Box { value: i32 }

trait Bumper
  fn bump(~self, ~other: Box) -> i32

impl Bumper for Box
  fn bump(~self, ~other: Box) -> i32
    self.value = self.value + 1
    other.value = other.value + 2
    self.value + other.value

fn guarded(~left: Bumper, ~right: Box) -> i32
  left.bump(~right)

pub fn main() -> i32
  let ~left: Bumper = Box { value: 1 }
  let ~right = Box { value: 10 }
  guarded(~left, ~right)
`);
    expect((instance.exports.main as () => number)()).toBe(14);
  });

  it("uses storage identity for root-rebinding open trait receivers", () => {
    const { instance, module } = compileProgram(`
trait Replacer
  fn replace(~self, ~other: Replacer) -> i32

obj Box {}

impl Replacer for Box
  fn replace(~self, ~other: Replacer) -> i32
    self = Box {}
    other = Box {}
    3

fn guarded(~left: Replacer, ~right: Replacer) -> i32
  left.replace(~right)

pub fn main() -> i32
  let ~left: Replacer = Box {}
  let ~right: Replacer = Box {}
  guarded(~left, ~right)
`);
    expect((instance.exports.main as () => number)()).toBe(3);
    expect(module.emitText()).toContain("ref.eq");
  });

  it("preserves identity guards through generic instantiation", () => {
    const { instance } = compileProgram(`
obj Box { value: i32 }

fn mutate_both(~left: Box, ~right: Box) -> i32
  left.value = left.value + 1
  right.value = right.value + 2
  left.value + right.value

fn guarded<Marker>(
  marker: Marker,
  ~left: Box,
  ~right: Box
) -> i32
  mutate_both(~left, ~right)

pub fn main() -> i32
  let ~left = Box { value: 1 }
  let ~right = Box { value: 10 }
  guarded<i32>(0, ~left, ~right)
`);
    expect((instance.exports.main as () => number)()).toBe(14);
  });

  it("preserves guard behavior in optimized and unoptimized builds", () => {
    const source = `
obj Box { value: i32 }

fn mutate_both(~left: Box, ~right: Box) -> i32
  left.value = left.value + 1
  right.value = right.value + 2
  left.value + right.value

fn guarded(
  ~values: FixedArray<Box>,
  left: i32,
  right: i32
) -> i32
  mutate_both(
    ~__array_get(values, left),
    ~__array_get(values, right)
  )

pub fn run(right: i32) -> i32
  let ~values = __array_new_fixed(
    Box { value: 1 },
    Box { value: 10 }
  )
  guarded(~values, 0, right)
`;
    const baseline = compileProgram(source).instance.exports.run as (
      right: number,
    ) => number;
    const optimized = compileProgram(source, "optimized").instance.exports
      .run as (right: number) => number;

    expect(baseline(1)).toBe(14);
    expect(optimized(1)).toBe(14);
    expect(() => baseline(0)).toThrow();
    expect(() => optimized(0)).toThrow();
  });

  it("does not bypass methods on array-shaped user containers", () => {
    const main = compileMain(`
pub val WideVec5 {
  a: i32,
  b: i32,
  c: i32,
  d: i32,
  e: i32
}

pub obj ArrayLookalike {
  storage: FixedArray<WideVec5>,
  count: i32
}

impl ArrayLookalike
  fn get(self, index: i32) -> WideVec5
    WideVec5 { a: 99, b: index, c: 0, d: 0, e: 0 }

pub fn main() -> i32
  let storage = __array_new<WideVec5>(1)
  __array_set(storage, 0, WideVec5 { a: 1, b: 2, c: 3, d: 4, e: 5 })
  let values = ArrayLookalike { storage: storage, count: 1 }
  values.get(0).a
`);
    expect(main()).toBe(99);
  });

  it("reads wide fields from direct fixed-array element projections", () => {
    const main = compileMain(`
pub val WideVec5 {
  a: i32,
  b: i32,
  c: i32,
  d: i32,
  e: i32
}

pub fn main() -> i32
  let arr = __array_new<WideVec5>(2)
  __array_set(arr, 0, WideVec5 { a: 1, b: 2, c: 3, d: 4, e: 5 })
  __array_set(arr, 1, WideVec5 { a: 6, b: 7, c: 8, d: 9, e: 10 })
  __array_get(arr, 0).b + __array_get(arr, 1).e
`);
    expect(main()).toBe(12);
  });

  it("keeps immutable local views borrowed across readonly field reads", () => {
    const main = compileMain(`
pub val WideVec5 {
  a: i32,
  b: i32,
  c: i32,
  d: i32,
  e: i32
}

pub fn main() -> i32
  let arr = __array_new<WideVec5>(2)
  __array_set(arr, 0, WideVec5 { a: 1, b: 2, c: 3, d: 4, e: 5 })
  __array_set(arr, 1, WideVec5 { a: 6, b: 7, c: 8, d: 9, e: 10 })
  let value = __array_get(arr, 1)
  value.e + value.b
`);
    expect(main()).toBe(17);
  });

  it("materializes a projected wide local before mutable-ref calls", () => {
    const main = compileMain(`
pub val WideVec5 {
  a: i32,
  b: i32,
  c: i32,
  d: i32,
  e: i32
}

fn bump_wide_a(~value: WideVec5)
  value.a = value.a + 10

pub fn main() -> i32
  let arr = __array_new<WideVec5>(1)
  __array_set(arr, 0, WideVec5 { a: 1, b: 2, c: 3, d: 4, e: 5 })
  let ~value = __array_get(arr, 0)
  bump_wide_a(~value)
  value.a + __array_get(arr, 0).a
`);
    expect(main()).toBe(12);
  });

  it("materializes a projected wide local before returning ownership", () => {
    const main = compileMain(`
pub val WideVec5 {
  a: i32,
  b: i32,
  c: i32,
  d: i32,
  e: i32
}

fn copy_first(arr: FixedArray<WideVec5>) -> WideVec5
  let value = __array_get(arr, 0)
  value

pub fn main() -> i32
  let arr = __array_new<WideVec5>(1)
  __array_set(arr, 0, WideVec5 { a: 1, b: 2, c: 3, d: 4, e: 5 })
  let ~copy = copy_first(arr)
  copy.a = copy.a + 10
  copy.a + __array_get(arr, 0).a
`);
    expect(main()).toBe(12);
  });

  it("materializes a projected wide local before mutating the root container", () => {
    const main = compileMain(`
pub val WideVec5 {
  a: i32,
  b: i32,
  c: i32,
  d: i32,
  e: i32
}

pub fn main() -> i32
  let arr = __array_new<WideVec5>(1)
  __array_set(arr, 0, WideVec5 { a: 1, b: 2, c: 3, d: 4, e: 5 })
  let value = __array_get(arr, 0)
  __array_set(arr, 0, WideVec5 { a: 9, b: 10, c: 11, d: 12, e: 13 })
  value.a + __array_get(arr, 0).a
`);
    expect(main()).toBe(10);
  });

  it("materializes a projected wide local before mutating through a root alias", () => {
    const main = compileMain(`
pub val WideVec5 {
  a: i32,
  b: i32,
  c: i32,
  d: i32,
  e: i32
}

pub fn main() -> i32
  let arr = __array_new<WideVec5>(1)
  __array_set(arr, 0, WideVec5 { a: 1, b: 2, c: 3, d: 4, e: 5 })
  let alias = arr
  let value = __array_get(arr, 0)
  __array_set(alias, 0, WideVec5 { a: 9, b: 10, c: 11, d: 12, e: 13 })
  value.a + __array_get(arr, 0).a
`);
    expect(main()).toBe(10);
  });

  it("keeps projected wide locals borrowed across readonly root accesses", () => {
    const main = compileMain(`
pub val WideVec5 {
  a: i32,
  b: i32,
  c: i32,
  d: i32,
  e: i32
}

pub fn main() -> i32
  let arr = __array_new<WideVec5>(2)
  __array_set(arr, 0, WideVec5 { a: 1, b: 2, c: 3, d: 4, e: 5 })
  __array_set(arr, 1, WideVec5 { a: 6, b: 7, c: 8, d: 9, e: 10 })
  let value = __array_get(arr, 1)
  value.e + __array_len(arr)
`);
    expect(main()).toBe(12);
  });

  it("keeps projected wide locals borrowed across readonly alias accesses", () => {
    const main = compileMain(`
pub val WideVec5 {
  a: i32,
  b: i32,
  c: i32,
  d: i32,
  e: i32
}

pub fn main() -> i32
  let arr = __array_new<WideVec5>(2)
  __array_set(arr, 0, WideVec5 { a: 1, b: 2, c: 3, d: 4, e: 5 })
  __array_set(arr, 1, WideVec5 { a: 6, b: 7, c: 8, d: 9, e: 10 })
  let alias = arr
  let value = __array_get(arr, 1)
  value.e + __array_len(alias)
`);
    expect(main()).toBe(12);
  });

  it("keeps projected wide locals borrowed across readonly assignment aliases", () => {
    const main = compileMain(`
pub val WideVec5 {
  a: i32,
  b: i32,
  c: i32,
  d: i32,
  e: i32
}

pub fn main() -> i32
  let arr = __array_new<WideVec5>(2)
  __array_set(arr, 0, WideVec5 { a: 1, b: 2, c: 3, d: 4, e: 5 })
  __array_set(arr, 1, WideVec5 { a: 6, b: 7, c: 8, d: 9, e: 10 })
  var alias = __array_new<WideVec5>(0)
  let value = __array_get(arr, 1)
  alias = arr
  value.e + __array_len(alias)
`);
    expect(main()).toBe(12);
  });

  it("keeps projected wide locals borrowed across nested readonly assignment aliases", () => {
    const main = compileMain(`
pub val WideVec5 {
  a: i32,
  b: i32,
  c: i32,
  d: i32,
  e: i32
}

pub fn main() -> i32
  let arr = __array_new<WideVec5>(2)
  __array_set(arr, 0, WideVec5 { a: 1, b: 2, c: 3, d: 4, e: 5 })
  __array_set(arr, 1, WideVec5 { a: 6, b: 7, c: 8, d: 9, e: 10 })
  var alias = __array_new<WideVec5>(0)
  let value = __array_get(arr, 1)
  if true:
    alias = arr
  value.e + __array_len(alias)
`);
    expect(main()).toBe(12);
  });

  it("passes projected wide locals to non-mut methods without materializing eagerly", () => {
    const main = compileMain(`
pub val WideVec5 {
  a: i32,
  b: i32,
  c: i32,
  d: i32,
  e: i32
}

impl WideVec5
  fn tail_sum(self) -> i32
    self.b + self.e

pub fn main() -> i32
  let arr = __array_new<WideVec5>(2)
  __array_set(arr, 0, WideVec5 { a: 1, b: 2, c: 3, d: 4, e: 5 })
  __array_set(arr, 1, WideVec5 { a: 6, b: 7, c: 8, d: 9, e: 10 })
  let value = __array_get(arr, 1)
  value.tail_sum()
`);
    expect(main()).toBe(17);
  });

  it("passes direct projected wide receivers to non-mut methods", () => {
    const main = compileMain(`
pub val WideVec5 {
  a: i32,
  b: i32,
  c: i32,
  d: i32,
  e: i32
}

impl WideVec5
  fn tail_sum(self) -> i32
    self.b + self.e

pub fn main() -> i32
  let arr = __array_new<WideVec5>(2)
  __array_set(arr, 0, WideVec5 { a: 1, b: 2, c: 3, d: 4, e: 5 })
  __array_set(arr, 1, WideVec5 { a: 6, b: 7, c: 8, d: 9, e: 10 })
  __array_get(arr, 1).tail_sum()
`);
    expect(main()).toBe(17);
  });
});
