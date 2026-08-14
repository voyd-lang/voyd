import { describe, expect, it, vi } from "vitest";
import { DiagnosticError } from "../../../diagnostics/index.js";
import type { ModuleGraph, ModuleNode } from "../../../modules/types.js";
import { parse } from "../../../parser/index.js";
import { semanticsPipeline } from "../../pipeline.js";

const perf = vi.hoisted(() => ({ increment: vi.fn() }));
vi.mock("../../../perf.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../perf.js")>()),
  incrementCompilerPerfCounter: perf.increment,
}));

const analyze = (source: string) =>
  semanticsPipeline(parse(source, "scoped-borrowing.test.voyd"));

const analyzeStd = (source: string) => {
  const ast = parse(source, "scoped-borrowing-std.test.voyd");
  const module: ModuleNode = {
    id: "std::scoped_borrowing_test",
    path: { namespace: "std", segments: ["scoped_borrowing_test"] },
    origin: { kind: "file", filePath: "scoped-borrowing-std.test.voyd" },
    ast,
    source,
    dependencies: [],
  };
  const graph: ModuleGraph = {
    entry: module.id,
    modules: new Map([[module.id, module]]),
    diagnostics: [],
  };
  return semanticsPipeline({ module, graph });
};

const diagnosticCodes = (source: string): readonly string[] => {
  try {
    analyze(source);
    return [];
  } catch (error) {
    if (error instanceof DiagnosticError) {
      return error.diagnostics.map((diagnostic) => diagnostic.code);
    }
    throw error;
  }
};

const diagnosticCodesStd = (source: string): readonly string[] => {
  try {
    analyzeStd(source);
    return [];
  } catch (error) {
    if (error instanceof DiagnosticError) {
      return error.diagnostics.map((diagnostic) => diagnostic.code);
    }
    throw error;
  }
};

const isRejected = (run: () => unknown): boolean => {
  try {
    run();
    return false;
  } catch {
    return true;
  }
};

const boxPrelude = `
obj Box { value: i32 }

fn read(value: Borrow<Box>) -> i32
  value.value

fn increment(~value: Borrow<Box>) -> void
  value.value = value.value + 1
`;

type LivenessCounterGroup = {
  cfgBlocks: number;
  cfgEdges: number;
  trackedCapabilities: number;
  stateInsertions: number;
  workItems: number;
};

const livenessCounterGroups = (
  calls: readonly (readonly unknown[])[],
): readonly LivenessCounterGroup[] => {
  const prefix = "borrowing.ordinary.liveness.";
  const values = calls
    .filter(([name]) => String(name).startsWith(prefix))
    .map(([name, value]) => [String(name).slice(prefix.length), Number(value)]);
  const groups = [];
  for (let index = 0; index < values.length; index += 5) {
    groups.push(Object.fromEntries(values.slice(index, index + 5)));
  }
  return groups as LivenessCounterGroup[];
};

describe("ordinary exclusive capability liveness", () => {
  const prelude = `
obj Box { value: i32 }

fn use(~value: Box) -> void
  value.value = 1

fn invoke(callback: fn() : () -> void) -> void
  callback()
`;

  it("ends exclusive access after the final local use", () => {
    expect(() =>
      analyze(`
${prelude}

fn valid(~value: Box, callback: fn() : () -> void) -> void
  use(~value)
  invoke(callback)
`),
    ).not.toThrow();

    expect(
      diagnosticCodes(`
${prelude}

fn invalid(~value: Box, callback: fn() : () -> void) -> void
  invoke(callback)
  use(~value)
`),
    ).toContain("TY0055");

    expect(() =>
      analyze(`
obj Box { value: i32 }

eff Tick
  wait(resume) -> void

fn valid(~value: Box): Tick -> void
  value.value = value.value + 1
  Tick::wait()
`),
    ).not.toThrow();
    expect(
      diagnosticCodes(`
obj Box { value: i32 }

eff Tick
  wait(resume) -> void

fn invalid(~value: Box): Tick -> void
  Tick::wait()
  value.value = value.value + 1
`),
    ).toContain("TY0055");
  });

  it("treats mutually exclusive branch uses independently in either order", () => {
    const callable = (reversed: boolean) => `
${prelude}

fn valid(
  ~value: Box,
  callback: fn() : () -> void,
  flag: bool
) -> void
  if
    flag:
      ${reversed ? "invoke(callback)" : "use(~value)"}
    else:
      ${reversed ? "use(~value)" : "invoke(callback)"}
`;
    expect(() => analyze(callable(false))).not.toThrow();
    expect(() => analyze(callable(true))).not.toThrow();
  });

  it("keeps aliases live across loop backedges and post-loop uses", () => {
    const loopAlias = diagnosticCodes(`
${prelude}

fn invalid(
  ~value: Box,
  callback: fn() : () -> void,
  running: bool
) -> void
  while running:
    let alias = value
    invoke(callback)
    let observed = alias.value
`);
    const postLoop = diagnosticCodes(`
${prelude}

fn invalid(
  ~value: Box,
  callback: fn() : () -> void,
  running: bool
) -> void
  while running:
    invoke(callback)
  use(~value)
`);
    expect(loopAlias).toContain("TY0055");
    expect(postLoop).toContain("TY0055");
  });

  it("propagates handled performs to capability uses in handler bodies", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }

eff Tick
  wait(resume) -> void

fn invalid(~value: Box) -> void
  try
    Tick::wait()
  Tick::wait(resume):
    value.value = value.value + 1
    resume()
`),
    ).toContain("TY0055");
  });

  it("kills a local capability origin when its alias is overwritten", () => {
    expect(() =>
      analyze(`
${prelude}

fn read_value(value: Box) -> i32
  value.value

fn valid(~value: Box, callback: fn() : () -> void) -> i32
  let ~alias = value
  alias.value = alias.value + 1
  alias = Box { value: 2 }
  invoke(callback)
  read_value(alias)
`),
    ).not.toThrow();

    expect(
      diagnosticCodes(`
${prelude}

fn read_value(value: Box) -> i32
  value.value

fn invalid(~value: Box, callback: fn() : () -> void) -> i32
  let alias = value
  invoke(callback)
  read_value(alias)
`),
    ).toContain("TY0055");
  });

  it("compares direct ambient access with only the live capabilities", () => {
    expect(() =>
      analyze(`
obj Box { value: i32 }
obj Other { value: i32 }

let ambient = Box { value: 4 }

fn valid(~box: Box, ~other: Other) -> i32
  box.value = box.value + 1
  let observed = ambient.value
  other.value = other.value + 1
  observed + other.value
`),
    ).not.toThrow();
  });

  it("allows a final nested transfer and rejects a suspended parent", () => {
    const nested = `
${prelude}

fn nested(~value: Box, callback: fn() : () -> void) -> void
  use(~value)
  invoke(callback)
`;
    expect(() =>
      analyze(`
${nested}

fn valid(~value: Box, callback: fn() : () -> void) -> void
  nested(~value, callback)
`),
    ).not.toThrow();
    expect(
      diagnosticCodes(`
${nested}

fn invalid(~value: Box, callback: fn() : () -> void) -> void
  nested(~value, callback)
  use(~value)
`),
    ).toContain("TY0055");
  });

  it("keeps CFG solver counters within their monotone bounds", () => {
    const callStart = perf.increment.mock.calls.length;
    analyze(`
${prelude}

fn bounded(
  ~value: Box,
  callback: fn() : () -> void,
  running: bool
) -> void
  while running:
    use(~value)
  invoke(callback)
`);
    const groups = livenessCounterGroups(
      perf.increment.mock.calls.slice(callStart),
    );
    const bounded = groups
      .filter(({ trackedCapabilities }) => Boolean(trackedCapabilities))
      .sort((left, right) => right.cfgBlocks - left.cfgBlocks)[0];
    expect(bounded).toBeDefined();
    expect(bounded!.stateInsertions).toBeLessThanOrEqual(
      bounded!.cfgBlocks * bounded!.trackedCapabilities,
    );
    expect(bounded!.workItems).toBeLessThanOrEqual(
      bounded!.cfgBlocks + bounded!.cfgEdges * bounded!.trackedCapabilities,
    );

    const zeroStart = perf.increment.mock.calls.length;
    analyze(`
obj Box { value: i32 }

fn no_capability(value: Box) -> i32
  value.value
`);
    expect(
      livenessCounterGroups(perf.increment.mock.calls.slice(zeroStart)),
    ).toContainEqual({
      cfgBlocks: 0,
      cfgEdges: 0,
      trackedCapabilities: 0,
      stateInsertions: 0,
      workItems: 0,
    });
  });
});

describe("scoped explicit borrowing", () => {
  it("forms a shared borrow from a place and keeps nested reborrows bounded", () => {
    expect(() =>
      analyze(`
${boxPrelude}

fn read_twice(value: Borrow<Box>) -> i32
  read(value) + read(value)

fn main() -> i32
  let value = Box { value: 7 }
  read_twice(value)
`),
    ).not.toThrow();
  });

  it("keeps a temporary alive for the complete borrowed invocation", () => {
    expect(() =>
      analyze(`
${boxPrelude}

fn main() -> i32
  read(Box { value: 17 })
`),
    ).not.toThrow();
  });

  it("forms exclusive scoped access only from mutable storage", () => {
    expect(() =>
      analyze(`
${boxPrelude}

fn main() -> i32
  let ~value = Box { value: 2 }
  increment(~value)
  value.value
`),
    ).not.toThrow();

    expect(
      diagnosticCodes(`
${boxPrelude}

fn invalid(value: Borrow<Box>) -> void
  increment(~value)
`),
    ).toContain("TY0050");
  });

  it("rejects laundering a borrow through a plain input", () => {
    expect(() =>
      analyze(`
${boxPrelude}

fn read_plain(value: Box) -> i32
  value.value

fn invalid(value: Borrow<Box>) -> i32
  read_plain(value)
`),
    ).toThrow();
  });

  it("rejects laundering a borrow through an ordinary generic", () => {
    expect(() =>
      analyze(`
${boxPrelude}

fn identity<T>(value: T) -> T
  value

fn invalid(value: Borrow<Box>) -> Box
  identity(value)
`),
    ).toThrow(/cannot instantiate ordinary type parameter/);
  });

  it("rejects ordinary method dispatch on a borrowed receiver", () => {
    expect(() =>
      analyze(`
obj Box { value: i32 }

impl Box
  fn get(self) -> i32
    self.value

fn invalid(value: Borrow<Box>) -> i32
  value.get()
`),
    ).toThrow(/Borrow-aware helper/);
  });

  it("rejects direct and nested borrowed results", () => {
    expect(() =>
      analyze(`
${boxPrelude}

fn invalid(value: Borrow<Box>) -> Borrow<Box>
  value
`),
    ).toThrow(/complete callable parameter/);

    expect(() =>
      analyze(`
obj Box { value: i32 }

fn invalid(value: Borrow<Box>) -> (Borrow<Box>, i32)
  (value, 1)
`),
    ).toThrow(/complete callable parameter/);
  });

  it("rejects Borrow fields and module storage", () => {
    expect(() =>
      analyze(`
obj Box { value: i32 }
obj Holder { value: Borrow<Box> }
`),
    ).toThrow(/complete callable parameter/);

    expect(() =>
      analyze(`
obj Box { value: i32 }
let value: Borrow<Box> = Box { value: 1 }
`),
    ).toThrow(/complete callable parameter/);
  });

  it("allows a stored function value whose input is borrowed", () => {
    expect(() =>
      analyze(`
obj Box { value: i32 }

fn invoke(value: Box, body: fn(value: Borrow<Box>) : () -> i32) -> i32
  body(value)

fn main() -> i32
  let reader: fn(value: Borrow<Box>) : () -> i32 = (value) => value.value
  invoke(Box { value: 5 }, reader)
`),
    ).not.toThrow();
  });

  it("rejects effectful callables with a borrowed input", () => {
    expect(() =>
      analyze(`
obj Box { value: i32 }

eff Log
  write(tail, value: i32) -> void

fn invalid(value: Borrow<Box>) : Log -> i32
  Log::write(value.value)
  value.value
`),
    ).toThrow(/empty effect row/);
  });

  it("rejects closure capture of an active borrowed parameter", () => {
    expect(() =>
      analyze(`
${boxPrelude}

fn invalid(value: Borrow<Box>) -> i32
  let captured = () => value.value
  captured()
`),
    ).toThrow(/cannot capture active Borrow/);
  });

  it("permits independent scalar extraction", () => {
    expect(() =>
      analyze(`
${boxPrelude}

fn copy_scalar(value: Borrow<Box>) -> i32
  let copied = value.value
  copied
`),
    ).not.toThrow();
  });

  it("rejects overlapping mutable arguments", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }

fn mutate_both(~left: Box, ~right: Box) -> void
  left.value = left.value + 1
  right.value = right.value + 1

fn invalid(~value: Box) -> void
  mutate_both(~value, ~value)
`),
    ).toContain("TY0048");

    expect(
      diagnosticCodes(`
obj Box { value: i32 }

fn replace_and_mutate(~slot: Box, ~contents: Box) -> void
  slot = Box { value: 0 }
  contents.value = contents.value + 1

fn invalid(~value: Box) -> void
  replace_and_mutate(~value, ~value)
`),
    ).toContain("TY0048");

    expect(
      diagnosticCodes(`
obj Box { value: i32 }

eff Tick
  wait(tail) -> i32

trait Runner
  fn run(self): Tick -> i32

impl Runner for Box
  fn run(self): Tick -> i32
    self.value + Tick::wait()

fn invalid_runner(runner: Runner, ~value: Box): Tick -> i32
  value.value = value.value + 1
  runner.run() + value.value
`),
    ).toContain("TY0055");
  });

  it("rejects overlapping shared and mutable arguments", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }

fn read_and_mutate(readable: Box, ~writable: Box) -> void
  let observed = readable.value
  writable.value = observed + 1

fn invalid(~value: Box) -> void
  read_and_mutate(value, ~value)
`),
    ).toContain("TY0048");
  });

  it("keeps locally disjoint fields independent", () => {
    expect(() =>
      analyze(`
obj Box { value: i32 }
obj Pair { left: Box, right: Box }

fn mutate_both(~left: Box, ~right: Box) -> void
  left.value = left.value + 1
  right.value = right.value + 1

fn valid(~pair: Pair) -> void
  mutate_both(~pair.left, ~pair.right)
`),
    ).not.toThrow();
  });

  it("keeps ordinary aliases independent outside active call access", () => {
    expect(() =>
      analyze(`
obj Box { value: i32 }

fn increment_plain(~value: Box) -> void
  value.value = value.value + 1

fn main() -> i32
  let ~value = Box { value: 1 }
  let alias = value
  increment_plain(~value)
  alias.value
`),
    ).not.toThrow();
  });

  it("rejects an unknown callback while exclusive access is active", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }

fn update(~value: Box, notify: fn() : () -> void) -> void
  value.value = value.value + 1
  notify()
  value.value = value.value + 1
`),
    ).toContain("TY0055");
  });
});

describe("finite ordinary mutation safety", () => {
  it("accepts bounded helpers, trait implementations, ordinary object results, and mutable value writeback", () => {
    expect(() =>
      analyze(`
obj Box { value: i32 }

val Counter { value: i32 }

fn read_value(value: Box) -> i32
  value.value

fn update(~value: Box) -> i32
  let before = read_value(value)
  value.value = value.value + 1
  before + value.value

fn return_object(~value: Box) -> Box
  value

fn increment_counter(~value: Counter) -> void
  value.value = value.value + 1

trait Mutator
  fn update(self, ~value: Box): () -> void

obj DirectMutator {}

impl Mutator for DirectMutator
  fn update(self, ~value: Box): () -> void
    value.value = value.value + 1

fn use_counter(~value: Counter) -> i32
  increment_counter(~value)
  value.value
`),
    ).not.toThrow();
  });

  it("rejects ambient module access while exclusive access is active", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }

let ambient = Box { value: 1 }

fn invalid(~value: Box) -> i32
  value.value = value.value + 1
  let observed = ambient.value
  value.value + observed
`),
    ).toContain("TY0055");
  });

  it("allows direct ambient access proven disjoint from exclusive storage", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj Other { value: i32 }

let ambient = Other { value: 4 }

fn valid(~value: Box) -> i32
  value.value = value.value + 1
  ambient.value + value.value
`),
    ).toEqual([]);
  });

  it("keeps helper-mediated ambient access conservative", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj Other { value: i32 }

let ambient = Other { value: 4 }

fn ambient_value() -> i32
  ambient.value

fn invalid(~value: Box) -> i32
  value.value = value.value + 1
  ambient_value() + value.value
`),
    ).toContain("TY0055");
  });

  it("rejects effects and dynamically uncertain alias access while exclusive access is active", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }

eff Tick
  wait(resume) -> void

fn invalid_effect(~value: Box): Tick -> void
  value.value = value.value + 1
  Tick::wait()
  value.value = value.value + 1
`),
    ).toContain("TY0055");

    expect(
      diagnosticCodes(`
obj Box { value: i32 }

trait Reader
  fn read(self) -> i32

impl Reader for Box
  fn read(self) -> i32
    self.value

fn invalid_dynamic(reader: Reader, ~value: Box) -> i32
  let observed = reader.read()
  value.value = value.value + 1
  observed + value.value
`),
    ).toContain("TY0048");
  });

  it("uses conservative ambient and reentrant bounds for open trait declarations", () => {
    expect(() =>
      analyze(`
obj Box { value: i32 }

trait Mutator
  fn update(
    self,
    ~value: Box,
    body: fn() : () -> void
  ) -> void

obj CallbackMutator {}

impl Mutator for CallbackMutator
  fn update(
    self,
    ~value: Box,
    body: fn() : () -> void
  ) -> void
    value.value = value.value + 1
    body()
`),
    ).not.toThrow();
  });

  it("rejects an open-trait wrapper under a live exclusive parameter", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }

trait Reader
  fn read(self): () -> i32

fn read_wrapper<T: Reader>(reader: T): () -> i32
  reader.read()

fn invalid<T: Reader>(~value: Box, reader: T): () -> i32
  value.value = value.value + 1
  let observed = read_wrapper(reader)
  value.value + observed
`),
    ).toContain("TY0055");
  });

  it("proves stable indices disjoint and guards dynamically uncertain indices", () => {
    const result = analyzeStd(`
obj Box { value: i32 }

@intrinsic(name: "__array_get", uses_signature: false)
fn array_get<T>(values: FixedArray<T>, index: i32) -> T
  __array_get(values, index)

fn mutate_both(~left: Box, ~right: Box) -> void
  left.value = left.value + 1
  right.value = right.value + 1

fn distinct(~values: FixedArray<Box>) -> void
  mutate_both(
    ~array_get(values, 0),
    ~array_get(values, 1)
  )

fn guarded(
  ~values: FixedArray<Box>,
  left: i32,
  right: i32
) -> void
  mutate_both(
    ~array_get(values, left),
    ~array_get(values, right)
  )
`);
    const guards = Array.from(
      result.borrowing.runtimeIdentityGuards.values(),
    ).flat();

    expect(guards).toHaveLength(1);
    expect(guards[0]).toMatchObject({
      left: { parameter: 0, identity: "allocation" },
      right: { parameter: 1, identity: "allocation" },
    });
  });

  it("retains child origins inside fresh intrinsic arrays", () => {
    expect(() =>
      analyzeStd(`
obj Child { value: i32 }

@intrinsic(name: "__array_new_fixed")
fn new_fixed<T>(value: T) -> FixedArray<T>
  __array_new_fixed(value)

@intrinsic(name: "__array_get")
fn get<T>(values: FixedArray<T>, index: i32) -> T
  __array_get(values, index)

fn read_first(values: FixedArray<Child>) -> i32
  get(values, 0).value

fn indirect(child: Child) -> i32
  let values = new_fixed(child)
  read_first(values)

fn invalid(~child: Child) -> i32
  let alias = child
  let observed = indirect(alias)
  child.value + observed
`),
    ).toThrow(/TY0048/);
  });

  it("invalidates fresh identity after local result, aggregate, storage, and branch aliases", () => {
    const result = analyze(`
obj Box { value: i32 }
obj Holder { value: Box }

fn relay(value: Box) -> Box
  value

fn mutate_both(~left: Box, ~right: Box) -> void
  left.value = left.value + 1
  right.value = right.value + 1

fn direct_distinct() -> void
  let ~left = Box { value: 1 }
  let ~right = Box { value: 10 }
  mutate_both(~left, ~right)

fn relay_alias() -> void
  let ~left = Box { value: 1 }
  let alias = relay(left)
  mutate_both(~left, ~alias)

fn holder_alias() -> void
  let ~left = Box { value: 1 }
  let holder = Holder { value: left }
  mutate_both(~left, ~holder.value)

fn holder_write_alias() -> void
  let ~left = Box { value: 1 }
  let ~holder = Holder { value: Box { value: 10 } }
  holder.value = left
  mutate_both(~left, ~holder.value)

fn tuple_alias() -> void
  let ~left = Box { value: 1 }
  let pair = (left, Box { value: 10 })
  mutate_both(~left, ~pair.0)

fn branch_alias() -> void
  let ~left = Box { value: 1 }
  let ~right = Box { value: 10 }
  let alias = if true then: left else: right
  mutate_both(~left, ~alias)
`);
    const guards = Array.from(
      result.borrowing.runtimeIdentityGuards.values(),
    ).flat();

    expect(guards).toHaveLength(5);
  });

  it("keeps long local identity-alias chains bounded and guarded", () => {
    const aliasCount = 128;
    const aliases = Array.from({ length: aliasCount }, (_, index) => {
      const source = index === 0 ? "left" : `alias_${index - 1}`;
      return `  let alias_${index} = ${source}`;
    }).join("\n");
    const result = analyze(`
obj Box { value: i32 }

fn mutate_both(~left: Box, ~right: Box) -> void
  left.value = left.value + 1
  right.value = right.value + 1

fn long_alias_chain() -> void
  let ~left = Box { value: 1 }
${aliases}
  mutate_both(~left, ~alias_${aliasCount - 1})
`);
    const guards = Array.from(
      result.borrowing.runtimeIdentityGuards.values(),
    ).flat();

    expect(guards).toHaveLength(1);
  });

  it("keeps exact scoped reads from invalidating independent fresh roots", () => {
    const result = analyze(`
obj Box { value: i32 }

fn inspect(value: Borrow<Box>) -> i32
  value.value

fn mutate_both(~left: Box, ~right: Box) -> void
  left.value = left.value + 1
  right.value = right.value + 1

fn distinct() -> void
  let ~left = Box { value: 1 }
  let ~right = Box { value: 10 }
  let observed = inspect(left) + inspect(right)
  mutate_both(~left, ~right)
`);

    expect(result.borrowing.runtimeIdentityGuards.size).toBe(0);
  });

  it("keeps reference-bearing call results aliased inside an active exclusive scope", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }

fn relay(value: Box) -> Box
  value

fn invalid(~value: Box) -> i32
  let alias = relay(value)
  value.value = value.value + 1
  alias.value + value.value
`),
    ).toContain("TY0048");
  });

  it("tracks bound call-result aliases across helper accesses in both directions", () => {
    const helperWriteThenAliasRead = diagnosticCodes(`
obj Box { value: i32 }

fn relay(value: Box) -> Box
  value

fn increment(~value: Box) -> void
  value.value = value.value + 1

fn invalid(~value: Box) -> i32
  let alias = relay(value)
  increment(~value)
  alias.value
`);
    const aliasWriteThenSourceRead = diagnosticCodes(`
obj Box { value: i32 }

fn relay(value: Box) -> Box
  value

fn invalid(~value: Box) -> i32
  let ~alias = relay(value)
  alias.value = alias.value + 1
  value.value
`);
    const sourceAliasWriteThenResultRead = diagnosticCodes(`
obj Box { value: i32 }

fn relay(value: Box) -> Box
  value

fn increment(~value: Box) -> void
  value.value = value.value + 1

fn invalid(~value: Box) -> i32
  let source_alias = value
  let result = relay(value)
  increment(~source_alias)
  result.value
`);
    const aggregateSourceWriteThenResultRead = diagnosticCodes(`
obj Box { value: i32 }
obj Holder { item: Box }

fn relay(value: Box) -> Box
  value

fn increment(~value: Box) -> void
  value.value = value.value + 1

fn invalid(~value: Box) -> i32
  let holder = Holder { item: value }
  let result = relay(value)
  increment(~holder.item)
  result.value
`);
    const assignedSourceAliasThenResultRead = diagnosticCodes(`
obj Box { value: i32 }

fn relay(value: Box) -> Box
  value

fn increment(~value: Box) -> void
  value.value = value.value + 1

fn invalid(~value: Box) -> i32
  let ~source_alias = Box { value: 0 }
  source_alias = value
  let result = relay(source_alias)
  increment(~value)
  result.value
`);
    const assignedSourceChainThenResultRead = diagnosticCodes(`
obj Box { value: i32 }
obj Holder { item: Box }

fn relay(value: Box) -> Box
  value

fn increment(~value: Box) -> void
  value.value = value.value + 1

fn invalid(~value: Box) -> i32
  let holder = Holder { item: value }
  let ~assigned = Holder { item: Box { value: 0 } }
  assigned.item = holder.item
  let result = relay(assigned.item)
  increment(~value)
  result.value
`);

    expect({
      helperWriteThenAliasRead,
      aliasWriteThenSourceRead,
      sourceAliasWriteThenResultRead,
      aggregateSourceWriteThenResultRead,
      assignedSourceAliasThenResultRead,
      assignedSourceChainThenResultRead,
    }).toEqual({
      helperWriteThenAliasRead: expect.arrayContaining(["TY0048"]),
      aliasWriteThenSourceRead: expect.arrayContaining(["TY0048"]),
      sourceAliasWriteThenResultRead: expect.arrayContaining(["TY0048"]),
      aggregateSourceWriteThenResultRead: expect.arrayContaining(["TY0048"]),
      assignedSourceAliasThenResultRead: expect.arrayContaining(["TY0048"]),
      assignedSourceChainThenResultRead: expect.arrayContaining(["TY0048"]),
    });
  });

  it("treats dynamically dispatched mutable helper access as a result-alias conflict", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }

fn relay(value: Box) -> Box
  value

trait Mutator
  fn update(self, ~value: Box) -> void

obj DirectMutator {}

impl Mutator for DirectMutator
  fn update(self, ~value: Box) -> void
    value.value = value.value + 1

fn invalid(mutator: Mutator, ~value: Box) -> i32
  let alias = relay(value)
  mutator.update(~value)
  alias.value
`),
    ).toContain("TY0048");
  });

  it("preserves uncertain result aliases when the result is wrapped before binding", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj Holder { item: Box }

fn relay(value: Box) -> Box
  value

fn increment(~value: Box) -> void
  value.value = value.value + 1

fn invalid(~value: Box) -> i32
  let holder = Holder { item: relay(value) }
  let alias = holder
  increment(~value)
  alias.item.value
`),
    ).toContain("TY0048");
  });

  it("preserves uncertain result aliases through local alias chains and assignment", () => {
    const aliasChain = diagnosticCodes(`
obj Box { value: i32 }

fn relay(value: Box) -> Box
  value

fn increment(~value: Box) -> void
  value.value = value.value + 1

fn invalid(~value: Box) -> i32
  let result = relay(value)
  let middle = result
  let alias = middle
  increment(~value)
  alias.value
`);
    const assigned = diagnosticCodes(`
obj Box { value: i32 }
obj Holder { item: Box }

fn relay(value: Box) -> Box
  value

fn increment(~value: Box) -> void
  value.value = value.value + 1

fn invalid(~value: Box) -> i32
  let ~alias = Holder { item: Box { value: 0 } }
  alias.item = relay(value)
  increment(~value)
  alias.item.value
`);
    const relayedAgain = diagnosticCodes(`
obj Box { value: i32 }

fn relay(value: Box) -> Box
  value

fn increment(~value: Box) -> void
  value.value = value.value + 1

fn invalid(~value: Box) -> i32
  let result = relay(value)
  let alias = relay(result)
  increment(~value)
  alias.value
`);
    const mixedCallArguments = diagnosticCodes(`
obj Box { value: i32 }

fn relay(value: Box) -> Box
  value

fn choose(left: Box, right: Box) -> Box
  right

fn increment(~value: Box) -> void
  value.value = value.value + 1

fn invalid(~left: Box, ~right: Box) -> i32
  let first = relay(left)
  let result = choose(right, first)
  increment(~left)
  result.value
`);

    expect({ aliasChain, assigned, relayedAgain, mixedCallArguments }).toEqual({
      aliasChain: expect.arrayContaining(["TY0048"]),
      assigned: expect.arrayContaining(["TY0048"]),
      relayedAgain: expect.arrayContaining(["TY0048"]),
      mixedCallArguments: expect.arrayContaining(["TY0048"]),
    });
  });

  it("keeps long caller-local result-alias chains finite and conservative", () => {
    const chain = Array.from(
      { length: 128 },
      (_, index) =>
        `  let alias_${index + 1} = ${index === 0 ? "result" : `alias_${index}`}`,
    ).join("\n");
    expect(
      diagnosticCodes(`
obj Box { value: i32 }

fn relay(value: Box) -> Box
  value

fn increment(~value: Box) -> void
  value.value = value.value + 1

fn invalid(~value: Box) -> i32
  let result = relay(value)
${chain}
  increment(~value)
  alias_128.value
`),
    ).toContain("TY0048");
  });

  it("propagates uncertain result aliases through match pattern bindings", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj Some<T> { value: T }
obj None {}
type Optional<T> = Some<T> | None

fn relay_option(value: Box) -> Optional<Box>
  Some<Box> { value }

fn increment(~value: Box) -> void
  value.value = value.value + 1

fn invalid(~value: Box) -> i32
  let alias = match(relay_option(value))
    Some<Box> { value: item }: item
    None: Box { value: 0 }
  increment(~value)
  alias.value
`),
    ).toContain("TY0048");
  });

  it("does not retain detached result aliases through match pattern bindings", () => {
    expect(() =>
      analyze(`
obj Box { value: i32 }
obj Some<T> { value: T }
obj None {}
type Optional<T> = Some<T> | None

@result(detached)
fn detached_option(source: Box) -> Optional<Box>
  Some<Box> { value: Box { value: source.value } }

fn increment(~value: Box) -> void
  value.value = value.value + 1

fn valid(~value: Box) -> i32
  let alias = match(detached_option(value))
    Some<Box> { value: item }: item
    None: Box { value: 0 }
  increment(~value)
  alias.value
`),
    ).not.toThrow();
  });

  it("keeps nested detached match bindings independent at a mutable call", () => {
    expect(() =>
      analyze(`
obj Box { value: i32 }
obj Failure { code: i32 }
obj Ok<T> { value: T }
obj Err<E> { error: E }
type Result<T, E> = Ok<T> | Err<E>
obj Store { count: i32 }

impl Store
  @result(fresh)
  fn init() -> Store
    Store { count: 0 }

  fn set(~self, key: Box, value: Box) -> ~self
    self.count = key.value + value.value
    self

@result(detached)
fn parse(~cursor: Box, offset: i32) -> Result<Box, Failure>
  cursor.value = cursor.value + 1
  Ok<Box> { value: Box { value: cursor.value + offset } }

fn valid(~cursor: Box) -> i32
  let ~store = Store::init()
  match(parse(cursor, 0))
    Ok<Box> { value: key }:
      match(parse(cursor, 1))
        Ok<Box> { value }:
          let _ = store.set(key, value)
        Err<Failure>:
          void
    Err<Failure>:
      void
  cursor.value + store.count
`),
    ).not.toThrow();
  });

  it("does not retain result aliases through scalar projections", () => {
    expect(() =>
      analyze(`
obj Box { value: i32 }

fn relay(value: Box) -> Box
  value

fn increment(~value: Box) -> void
  value.value = value.value + 1

fn valid(~value: Box) -> i32
  let copied = relay(value).value
  increment(~value)
  copied
`),
    ).not.toThrow();
  });

  it("keeps unrelated fields independent from a wrapped result alias", () => {
    expect(() =>
      analyze(`
obj Box { value: i32 }
obj Holder { item: Box, count: i32 }

fn relay(value: Box) -> Box
  value

fn increment(~value: Box) -> void
  value.value = value.value + 1

fn valid(~value: Box) -> i32
  let holder = Holder { item: relay(value), count: 7 }
  increment(~value)
  holder.count
`),
    ).not.toThrow();
  });

  it("does not impose the uncertain result rule on a direct local alias", () => {
    expect(() =>
      analyze(`
obj Box { value: i32 }
obj Holder { item: Box }

fn increment(~value: Box) -> void
  value.value = value.value + 1

fn valid(~value: Box) -> i32
  let holder = Holder { item: value }
  increment(~value)
  holder.item.value
`),
    ).not.toThrow();
  });

  it("keeps a call-result alias independent from mutation of a disjoint field", () => {
    expect(() =>
      analyze(`
obj Box { value: i32 }
obj Cursor { current: Box, index: i32 }

impl Box
  fn relay(self, index: i32) -> Box
    self

fn next(~cursor: Cursor) -> Box
  let value = cursor.current.relay(cursor.index)
  cursor.index = cursor.index + 1
  value
`),
    ).not.toThrow();
  });

  it("rejects storage, return, overlap, and plain-call laundering of active exclusive capabilities", () => {
    const storage = diagnosticCodes(`
obj Box { value: i32 }

type Callback = fn() : () -> i32

obj CallbackHolder { body: Callback }

fn store_capability() -> CallbackHolder
  let ~value = Box { value: 1 }
  let body: Callback = () =>
    value.value = value.value + 1
    value.value
  CallbackHolder { body }
`);

    const returned = diagnosticCodes(`
obj Box { value: i32 }
type Callback = fn() : () -> i32

fn return_capability() -> Callback
  let ~value = Box { value: 1 }
  () =>
    value.value = value.value + 1
    value.value
`);

    const closureResult = diagnosticCodes(`
obj Box { value: i32 }

fn return_captured_value() -> Box
  let ~value = Box { value: 1 }
  let captured = () => value
  captured()
`);

    const overlap = diagnosticCodes(`
obj Box { value: i32 }

fn overlap_parent(~value: Box) -> i32
  let ~alias = value
  let observed = value.value
  alias.value + observed
`);

    const laundering = diagnosticCodes(`
obj Box { value: i32 }

fn launder_plain(
  ~value: Box,
  body: fn(Box) : () -> void
) -> void
  body(value)
  value.value = value.value + 1
`);

    expect({ storage, returned, closureResult, overlap, laundering }).toEqual({
      storage: expect.arrayContaining(["TY0049"]),
      returned: expect.arrayContaining(["TY0049"]),
      closureResult: expect.arrayContaining(["TY0049"]),
      overlap: expect.arrayContaining(["TY0048"]),
      laundering: expect.arrayContaining(["TY0055"]),
    });
  });
});

describe("scoped Borrow origin boundaries", () => {
  it("supports shared and exclusive nested reborrows and restores the parent", () => {
    expect(() =>
      analyze(`
obj Box { value: i32 }

fn read(value: Borrow<Box>) -> i32
  value.value

fn increment(~value: Borrow<Box>) -> void
  value.value = value.value + 1

fn nested_exclusive(~value: Borrow<Box>) -> i32
  let before = read(value)
  increment(~value)
  before + read(value)

fn outer_exclusive(~value: Borrow<Box>) -> i32
  let first = nested_exclusive(~value)
  increment(~value)
  first + read(value)

fn main() -> i32
  let ~value = Box { value: 3 }
  let result = outer_exclusive(~value)
  result + value.value
`),
    ).not.toThrow();
  });

  it("preserves Borrow origins through local aliases and projections", () => {
    expect(() =>
      analyze(`
obj Box { value: i32 }
obj Wrapper { inner: Box }

fn read(value: Borrow<Box>) -> i32
  value.value

fn read_wrapper(value: Borrow<Wrapper>) -> i32
  let inner: Borrow<Box> = value.inner
  read(inner)
`),
    ).not.toThrow();
  });

  it("rejects shared-to-exclusive upgrades", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }

fn increment(~value: Borrow<Box>) -> void
  value.value = value.value + 1

fn invalid(value: Borrow<Box>) -> void
  increment(~value)
`),
    ).toContain("TY0050");
  });

  it("rejects callable adaptation across Borrow boundaries", () => {
    expect(() =>
      analyze(`
obj Box { value: i32 }

fn plain(value: Box) -> i32
  value.value

fn invalid() -> fn(value: Borrow<Box>) : () -> i32
  plain
`),
    ).toThrow();

    expect(() =>
      analyze(`
obj Box { value: i32 }

fn borrowed(value: Borrow<Box>) -> i32
  value.value

fn invalid() -> fn(value: Box) : () -> i32
  borrowed
`),
    ).toThrow();
  });

  it("rejects ordinary generic and method flow after Borrow projections", () => {
    const generic = () =>
      analyze(`
obj Box { value: i32 }
obj Wrapper { inner: Box }

fn identity<T>(value: T) -> T
  value

fn invalid(value: Borrow<Wrapper>) -> Box
  identity(value.inner)
`);

    const method = () =>
      analyze(`
obj Box { value: i32 }
obj Wrapper { inner: Box }

impl Box
  fn read(self) -> i32
    self.value

fn invalid(value: Borrow<Wrapper>) -> i32
  value.inner.read()
`);

    expect({
      generic: isRejected(generic),
      method: isRejected(method),
    }).toEqual({ generic: true, method: true });
  });

  it("rejects Borrow-derived closure and effect boundaries", () => {
    expect(() =>
      analyze(`
obj Box { value: i32 }
type Callback = fn() : () -> i32

fn invalid_capture(value: Borrow<Box>) -> Callback
  () => value.value
`),
    ).toThrow(/cannot capture active Borrow/);

    expect(() =>
      analyze(`
obj Box { value: i32 }

eff Log
  write(tail, value: i32) -> void

fn invalid_effect(value: Borrow<Box>): Log -> i32
  Log::write(value.value)
  value.value
`),
    ).toThrow();
  });

  it("rejects projected and container-wrapped Borrow escapes", () => {
    const projected = diagnosticCodes(`
obj Box { value: i32 }
obj Wrapper { inner: Box }

fn invalid_projection(value: Borrow<Wrapper>) -> Box
  value.inner
`);

    const wrapped = diagnosticCodes(`
obj Box { value: i32 }
obj Container<T> { value: T }

fn invalid_container(value: Borrow<Box>) -> Container<Box>
  Container<Box> { value }
`);

    expect({ projected, wrapped }).toEqual({
      projected: expect.arrayContaining(["TY0051"]),
      wrapped: expect.arrayContaining(["TY0051"]),
    });
  });

  it("rejects Borrow origins hidden by arrays, destructuring, and value containers", () => {
    const array = () =>
      analyzeStd(`
obj Box { value: i32 }

fn invalid(value: Borrow<FixedArray<Box>>) -> Box
  __array_get(value, 0)
`);

    const destructuring = () =>
      analyze(`
obj Box { value: i32 }

fn invalid(value: Borrow<(Box, i32)>) -> Box
  let (box, _) = value
  box
`);

    const valueContainer = () =>
      analyze(`
obj Box { value: i32 }
val Wrapper { inner: Box }

fn invalid(value: Borrow<Wrapper>) -> Box
  value.inner
`);

    expect({
      array: isRejected(array),
      destructuring: isRejected(destructuring),
      valueContainer: isRejected(valueContainer),
    }).toEqual({ array: true, destructuring: true, valueContainer: true });
  });

  it("rejects invocation of callable fields projected from borrowed data", () => {
    expect(
      diagnosticCodes(`
type Reader = fn() : () -> i32

obj Holder { reader: Reader }

fn invalid(value: Borrow<Holder>) -> i32
  let reader = value.reader
  reader()
`),
    ).toContain("TY0051");
  });

  it("allows known pure helpers and rejects unrelated uncertain boundaries", () => {
    expect(() =>
      analyze(`
obj Box { value: i32 }

fn add_one(value: i32) -> i32
  value + 1

fn valid(value: Borrow<Box>) -> i32
  add_one(value.value)
`),
    ).not.toThrow();

    const unknownCallback = diagnosticCodes(`
obj Box { value: i32 }

fn invoke(body: fn() : () -> i32) -> i32
  body()

fn invalid(
  value: Borrow<Box>,
  body: fn() : () -> i32
) -> i32
  let copied = value.value
  invoke(body) + copied
`);
    const openDispatch = diagnosticCodes(`
obj Box { value: i32 }

trait Reader
  fn read(self) -> i32

fn invalid<T: Reader>(value: Borrow<Box>, reader: T) -> i32
  reader.read() + value.value
`);

    expect({ unknownCallback, openDispatch }).toEqual({
      unknownCallback: expect.arrayContaining(["TY0051"]),
      openDispatch: expect.arrayContaining(["TY0051"]),
    });
  });

  it("allows compatible ambient reads while a shared Borrow is active", () => {
    const direct = diagnosticCodes(`
obj Box { value: i32 }
let ambient = Box { value: 4 }

fn invalid(value: Borrow<Box>) -> i32
  value.value + ambient.value
`);
    const helper = diagnosticCodes(`
obj Box { value: i32 }
let ambient = Box { value: 4 }

fn ambient_value() -> i32
  ambient.value

fn invalid(value: Borrow<Box>) -> i32
  ambient_value() + value.value
`);

    expect({ direct, helper }).toEqual({ direct: [], helper: [] });
  });

  it("rejects host and task boundaries even when no Borrow value is passed", () => {
    const external = diagnosticCodes(`
obj Box { value: i32 }

@external(id: "example:test/scoped@1")
fn host_read(value: i32) -> i32
  host_read(value)

fn invalid(value: Borrow<Box>) -> i32
  host_read(1) + value.value
`);
    const task = (() => {
      try {
        analyzeStd(`
obj Box { value: i32 }

@intrinsic(name: "__task_cancel")
fn task_cancel(id: i32) -> bool __task_cancel(id)

fn invalid(value: Borrow<Box>) -> i32
  let ignored = task_cancel(0)
  value.value
`);
        return [];
      } catch (error) {
        return error instanceof DiagnosticError
          ? error.diagnostics.map((diagnostic) => diagnostic.code)
          : ["unexpected-error"];
      }
    })();

    expect({ external, task }).toEqual({
      external: expect.arrayContaining(["TY0051"]),
      task: expect.arrayContaining(["TY0051"]),
    });
  });

  it("requires a mutable place for selected exclusive Borrow inputs", () => {
    expect(() =>
      analyze(`
${boxPrelude}

fn valid() -> i32
  let ~value = Box { value: 1 }
  increment(~value)
  value.value
`),
    ).not.toThrow();

    const immutable = diagnosticCodes(`
${boxPrelude}

fn invalid() -> void
  let value = Box { value: 1 }
  increment(~value)
`);
    const temporary = diagnosticCodes(`
${boxPrelude}

fn invalid() -> void
  increment(~Box { value: 1 })
`);

    expect({ immutable, temporary }).toEqual({
      immutable: expect.arrayContaining(["TY0050"]),
      temporary: expect.arrayContaining(["TY0050"]),
    });
  });

  it("allows closed reference-free logical copies to leave a Borrow scope", () => {
    expect(() =>
      analyze(`
val Snapshot { count: i32, ready: bool }
type StructuralSnapshot = { count: i32, ready: bool }

fn copy_value(value: Borrow<Snapshot>) -> Snapshot
  Snapshot { count: value.count, ready: value.ready }

fn copy_tuple(value: Borrow<(i32, bool)>) -> (i32, bool)
  (value.0, value.1)

fn copy_structural(
  value: Borrow<StructuralSnapshot>
) -> StructuralSnapshot
  { count: value.count, ready: value.ready }
`),
    ).not.toThrow();
  });

  it("allows the exact compiler-known SharedCell scoped methods to nest", () => {
    expect(() =>
      analyzeStd(`
@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

impl<T> SharedCell<T>
  fn with<R>(self, body: fn(value: Borrow<T>) : () -> R) -> R
    body(self.value)

  fn with_mut<R>(self, body: fn(~value: Borrow<T>) : () -> R) -> R
    let ~copy = self.value
    body(~copy)

obj Box { value: i32 }

fn nested(cell: SharedCell<Box>) -> i32
  cell.with((outer) =>
    let copied = outer.value
    cell.with((inner) => copied + inner.value)
  )

fn nested_during_write(cell: SharedCell<Box>) -> i32
  cell.with_mut((~outer) =>
    outer.value = outer.value + 1
    cell.with((inner) => inner.value)
  )
`),
    ).not.toThrow();
  });

  it("checks ordinary aliases for the full SharedCell callback invocation", () => {
    const source = (body: string) => `
@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

impl<T> SharedCell<T>
  fn with<R>(self, body: fn(value: Borrow<T>) : () -> R) -> R
    body(self.value)

  fn with_mut<R>(self, body: fn(~value: Borrow<T>) : () -> R) -> R
    let ~copy = self.value
    body(~copy)

obj Box { value: i32 }

fn read(value: Box) -> i32
  value.value

fn write(~value: Box) -> void
  value.value = value.value + 1

fn check() -> i32
  let state = Box { value: 1 }
  let cell = SharedCell<Box> { value: state }
  ${body}
`;

    expect(() =>
      analyzeStd(
        source(`cell.with((borrowed) => read(state) + borrowed.value)`),
      ),
    ).not.toThrow();
    expect(
      diagnosticCodesStd(
        source(`cell.with((borrowed) =>
    let ~alias = state
    write(~alias)
    borrowed.value
  )`),
      ),
    ).toContain("TY0051");
    expect(
      diagnosticCodesStd(
        source(`cell.with_mut((~borrowed) =>
    read(state) + borrowed.value
  )`),
      ),
    ).toContain("TY0051");
  });

  it("keeps reference-bearing values and stable-handle lookalikes scoped", () => {
    const referenceBearingValue = diagnosticCodes(`
obj Box { value: i32 }
val Wrapper { inner: Box }

fn invalid(value: Borrow<Wrapper>) -> Wrapper
  value
`);
    const lookalike = diagnosticCodes(`
obj Backing { value: i32 }
obj SliceLookalike { source: Backing, start: i32, len: i32 }

fn invalid(value: Borrow<SliceLookalike>) -> SliceLookalike
  value
`);

    expect({ referenceBearingValue, lookalike }).toEqual({
      referenceBearingValue: expect.arrayContaining(["TY0051"]),
      lookalike: expect.arrayContaining(["TY0051"]),
    });
  });

  it("recognizes only compiler-known StringSlice as a stable retained handle", () => {
    expect(() =>
      analyzeStd(`
obj Backing { value: i32 }

@intrinsic_type(type: "voyd.std.string-slice")
obj StableSlice { source: Backing, start: i32, len: i32 }

obj Holder { slice: StableSlice }

fn relay(slice: StableSlice) -> StableSlice
  slice

fn copy_slice(value: Borrow<Holder>) -> StableSlice
  value.slice

fn replace_after_relay(~value: Holder) -> i32
  let copy = relay(value.slice)
  value.slice = relay(value.slice)
  copy.len
`),
    ).not.toThrow();
  });

  it("does not classify a compiler-known StringSlice capture as ambient", () => {
    const stable = analyzeStd(`
obj Backing { value: i32 }

@intrinsic_type(type: "voyd.std.string-slice")
obj StableSlice { source: Backing, start: i32, len: i32 }

fn reader(slice: StableSlice) -> (fn() -> i32)
  () => slice.len
`);
    const stableLambda = Array.from(stable.hir.expressions.values()).find(
      (expression) => expression.exprKind === "lambda",
    );
    expect(
      stableLambda
        ? stable.borrowing.ordinaryMutationSummaries.get(-1 - stableLambda.id)
            ?.ambientAccess
        : undefined,
    ).toBe(0);

    const lookalike = analyze(`
obj Backing { value: i32 }
obj SliceLookalike { source: Backing, start: i32, len: i32 }

fn reader(slice: SliceLookalike) -> (fn() -> i32)
  () => slice.len
`);
    const lookalikeLambda = Array.from(lookalike.hir.expressions.values()).find(
      (expression) => expression.exprKind === "lambda",
    );
    expect(
      lookalikeLambda
        ? lookalike.borrowing.ordinaryMutationSummaries.get(
            -1 - lookalikeLambda.id,
          )?.ambientAccess
        : undefined,
    ).toBe(1);
  });
});

describe("result identity declaration validation", () => {
  it("accepts detached construction, stable StringSlice, local staging, and forwarding", () => {
    expect(() =>
      analyze(`
obj Box { value: i32 }

@result(detached)
fn detached_box(value: i32) -> Box
  Box { value }

@result(detached)
fn forwarded(value: i32, flag: bool) -> Box
  if
    flag: detached_box(value)
    else:
      let staged = detached_box(value + 1)
      staged
`),
    ).not.toThrow();

    expect(() =>
      analyzeStd(`
obj Backing { value: i32 }

@intrinsic_type(type: "voyd.std.string-slice")
obj StableSlice { source: Backing, start: i32, len: i32 }

@result(detached)
fn stable(slice: StableSlice) -> StableSlice
  slice
`),
    ).not.toThrow();
  });

  it("rejects detached declarations that return caller-owned identity", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }

@result(detached)
fn invalid(value: Box) -> Box
  value
`),
    ).toContain("TY0056");
  });

  it("rejects detached forwarding through an unannotated ambient helper", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
let ambient = Box { value: 0 }

fn ambient_box() -> Box
  ambient

@result(detached)
fn invalid() -> Box
  ambient_box()
`),
    ).toContain("TY0056");
  });

  it("rejects mutable staging contaminated by caller identity", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }

@result(detached)
fn make() -> Box
  Box { value: 0 }

@result(detached)
fn invalid(input: Box) -> Box
  var staged = make()
  staged = input
  staged
`),
    ).toContain("TY0056");

    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj Wrapper { box: Box }

@result(detached)
fn make() -> Box
  Box { value: 0 }

@result(detached)
fn invalid(input: Box) -> Wrapper
  let ~staged = Wrapper { box: make() }
  staged.box = input
  staged
`),
    ).toContain("TY0056");
  });

  it("keeps checked builder writes from contaminating detached local staging", () => {
    expect(() =>
      analyze(`
obj Source { value: i32 }
obj Output { value: i32 }

@result(fresh)
fn make_output() -> Output
  Output { value: 0 }

@access(builder: output)
fn append(~output: Output, source: Source) -> void
  output.value = source.value

@result(detached)
fn valid(source: Source) -> Output
  let ~output = make_output()
  append(output, source)
  output
`),
    ).not.toThrow();

    expect(
      diagnosticCodes(`
obj Source { value: i32 }
obj Output { source: Source }

@result(fresh)
fn make_output() -> Output
  Output { source: Source { value: 0 } }

@access(builder: output)
fn invalid_builder(~output: Output, source: Source) -> void
  output.source = source

@result(detached)
fn invalid(source: Source) -> Output
  let ~output = make_output()
  invalid_builder(output, source)
  output
`),
    ).toContain("TY0058");
  });

  it("accepts a fresh wrapper when every retained input is detached", () => {
    const source = `
obj Box { value: i32 }
obj Wrapper { box: Box }

@result(fresh)
fn make_box() -> Box
  Box { value: 0 }

@result(fresh)
fn wrap(box: Box) -> Wrapper
  Wrapper { box }
`;
    expect(() =>
      analyze(`${source}
@result(detached)
fn valid() -> Wrapper
  wrap(make_box())
`),
    ).not.toThrow();
    expect(
      diagnosticCodes(`${source}
@result(detached)
fn invalid(box: Box) -> Wrapper
  wrap(box)
`),
    ).toContain("TY0056");
  });

  it("preserves detached provenance through nested result and option patterns", () => {
    expect(() =>
      analyze(`
obj Box { value: i32 }
obj Failure { code: i32 }
obj Ok<T> { value: T }
obj Err<E> { error: E }
obj Some<T> { value: T }
obj None {}
type Result<T, E> = Ok<T> | Err<E>
type Option<T> = Some<T> | None

@result(detached)
fn source(flag: bool) -> Result<Option<Box>, Failure>
  if flag
    then: Err<Failure> { error: Failure { code: 1 } }
    else: Ok<Option<Box>> { value: Some<Box> { value: Box { value: 7 } } }

@result(detached)
fn forward(flag: bool) -> Result<Option<Box>, Failure>
  match(source(flag))
    Err<Failure> { error }:
      Err<Failure> { error }
    Ok<Option<Box>> { value }:
      match(value)
        None:
          Ok<Option<Box>> { value: None {} }
        Some<Box> { value: box }:
          Ok<Option<Box>> { value: Some<Box> { value: box } }
`),
    ).not.toThrow();
  });

  it("keeps fresh match spines independent when stored back into their source", () => {
    expect(() =>
      analyze(`
obj Item { value: i32 }
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None
obj Store { item: Item }
obj Container { store: Store }

fn get(store: Store) -> Option<Item>
  Some<Item> { value: store.item }

@result(fresh)
fn make_store(item: Item) -> Store
  Store { item }

@access(staged: container)
fn store(~container: Container, value: Store) -> void
  container.store = value

fn replace(~container: Container, fallback: Item, replacement: Item) -> void
  let ~copy = match(get(container.store))
    Some<Item> { value }: make_store(value)
    None: make_store(fallback)
  copy.item = replacement
  store(~container, copy)
`),
    ).not.toThrow();
  });

  it("keeps retained children of fresh results alias-sensitive", () => {
    expect(
      diagnosticCodes(`
obj Cell { value: i32 }
obj Wrapper { child: Cell }

@result(fresh)
fn wrap(child: Cell) -> Wrapper
  Wrapper { child }

fn mutate(~cell: Cell) -> void
  cell.value = cell.value + 1

fn invalid(~child: Cell) -> void
  let ~wrapper = wrap(child)
  mutate(~child)
  wrapper.child.value = wrapper.child.value + 1
`),
    ).toContain("TY0048");
  });

  it("rejects fresh results that hide mutable ambient child identity", () => {
    expect(
      diagnosticCodes(`
obj Cell { value: i32 }
obj Wrapper { child: Cell }
let ambient = Cell { value: 0 }

@result(fresh)
fn wrap() -> Wrapper
  Wrapper { child: ambient }

fn mutate(~cell: Cell) -> void
  cell.value = cell.value + 1

fn invalid() -> void
  let ~wrapped = wrap()
  mutate(~ambient)
  wrapped.child.value = wrapped.child.value + 1
`),
    ).toContain("TY0056");
  });

  it("tracks fresh child provenance through exact local helpers", () => {
    const source = `
obj Cell { value: i32 }
obj Wrapper { child: Cell }

fn child_of(wrapper: Wrapper) -> Cell
  wrapper.child

@result(fresh)
fn wrap(source: Wrapper) -> Wrapper
  Wrapper { child: child_of(source) }
`;
    expect(() => analyze(source)).not.toThrow();
    expect(
      diagnosticCodes(`${source}
let ambient = Cell { value: 0 }

fn ambient_child() -> Cell
  ambient

@result(fresh)
fn invalid() -> Wrapper
  Wrapper { child: ambient_child() }
`),
    ).toContain("TY0056");
  });

  it("does not launder an unsafe fresh result into detached", () => {
    const codes = diagnosticCodes(`
obj Cell { value: i32 }
obj Wrapper { child: Cell }
let ambient = Cell { value: 0 }

@result(fresh)
fn wrap() -> Wrapper
  Wrapper { child: ambient }

@result(detached)
fn detached_wrap() -> Wrapper
  wrap()
`);
    expect(codes.filter((code) => code === "TY0056")).toHaveLength(2);
  });

  it("converges nested match binder origins before indexing calls", () => {
    expect(() =>
      analyze(`
obj Key { value: i32 }
obj JsonString { value: Key }
obj JsonOther {}
type JsonValue = JsonString | JsonOther
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None
obj Fields { value: JsonValue }
obj Seen { value: i32 }

@result(fresh)
fn copy_fields(source: Fields) -> Fields
  Fields { value: source.value }

fn get(fields: Fields) -> Option<JsonValue>
  Some<JsonValue> { value: fields.value }

fn read_key(key: Key) -> i32
  key.value

fn record(~seen: Seen, value: i32) -> void
  seen.value = value

fn unique(~seen: Seen, operation: Fields) -> i32
  let ~fields = copy_fields(operation)
  match(get(fields))
    Some<JsonValue> { value }:
      match(value)
        JsonString { value: key }:
          let observed = read_key(key)
          record(~seen, observed)
          observed
        JsonOther:
          0
    None:
      0
`),
    ).not.toThrow();
  });

  it("does not detach projections from conservative destructuring", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj Wrapper { box: Box }

@result(detached)
fn invalid(input: Wrapper) -> Box
  match(input)
    Wrapper { box }:
      box
`),
    ).toContain("TY0056");
  });

  it("does not infer fresh identity for a projected pattern binding", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj Wrapper { box: Box }

@result(fresh)
fn make() -> Wrapper
  Wrapper { box: Box { value: 1 } }

@result(fresh)
fn invalid() -> Box
  match(make())
    Wrapper { box }:
      box
`),
    ).toContain("TY0056");
  });

  it("accepts fresh construction and forwarding on every branch", () => {
    expect(() =>
      analyze(`
obj Box { value: i32 }

@result(fresh)
fn make(value: i32) -> Box
  Box { value }

@result(fresh)
fn choose(value: i32, flag: bool) -> Box
  if flag then: make(value) else: Box { value: value + 1 }
`),
    ).not.toThrow();
  });

  it("rejects a fresh declaration that returns an input object", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }

@result(fresh)
fn invalid(value: Box, flag: bool) -> Box
  if flag then:
    return(Box { value: 0 })
  value
`),
    ).toContain("TY0056");
  });

  it("accepts exact same-place returns and matching forwarding", () => {
    expect(() =>
      analyze(`
obj Box { value: i32 }

fn identity(~value: Box) -> ~value
  value

fn forward(~value: Box) -> ~value
  identity(~value)
`),
    ).not.toThrow();
  });

  it("rejects a different same-typed parameter and a fresh replacement", () => {
    const wrongParameter = diagnosticCodes(`
obj Box { value: i32 }

fn invalid(~left: Box, ~right: Box) -> ~left
  right
`);
    const replacement = diagnosticCodes(`
obj Box { value: i32 }

fn invalid(~value: Box) -> ~value
  Box { value: 0 }
`);
    expect({ wrongParameter, replacement }).toEqual({
      wrongParameter: expect.arrayContaining(["TY0056"]),
      replacement: expect.arrayContaining(["TY0056"]),
    });
  });

  it("inherits trait contracts and rejects explicit incompatibility", () => {
    expect(() =>
      analyze(`
obj Box { value: i32 }
obj Maker {}

trait Factory
  @result(fresh)
  fn build(self) -> Box

impl Factory for Maker
  fn build(self) -> Box
    Box { value: 0 }
`),
    ).not.toThrow();

    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj Maker {}

trait Factory
  @result(fresh)
  fn build(self) -> Box

impl Factory for Maker
  @result(detached)
  fn build(self) -> Box
    Box { value: 0 }
`),
    ).toContain("TY0056");

    expect(
      diagnosticCodes(`
obj Box { value: i32 }

trait Copier
  @result(fresh)
  fn copy(self) -> Box

impl Copier for Box
  fn copy(self) -> Box
    self
`),
    ).toContain("TY0056");
  });

  it("records bounded validation counters", () => {
    perf.increment.mockClear();
    analyze(`
obj Box { value: i32 }

@result(fresh)
fn make() -> Box
  Box { value: 0 }
`);
    const counter = (name: string) =>
      perf.increment.mock.calls.find(([candidate]) => candidate === name)?.[1];
    expect(counter("borrowing.resultIdentity.declarations")).toBe(1);
    expect(counter("borrowing.resultIdentity.paths")).toBe(1);
    expect(counter("borrowing.resultIdentity.violations")).toBe(0);
  });
});

describe("staged overlap contracts", () => {
  const prelude = `
obj Box { value: i32 }

@access(staged: out)
fn copy_value(source: Box, ~out: Box) -> void
  let snapshot = source.value
  out.value = snapshot
`;

  it("permits exact source and destination overlap after local staging", () => {
    expect(() =>
      analyze(`${prelude}
fn update(~box: Box) -> void
  copy_value(box, ~box)
`),
    ).not.toThrow();
  });

  it("rejects source access after the first destination write", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }

@access(staged: out)
fn invalid(source: Box, ~out: Box) -> void
  out.value = 1
  out.value = source.value
`),
    ).toContain("TY0057");
  });

  it("keeps source children retained through a fresh wrapper", () => {
    expect(
      diagnosticCodes(`
obj Child { value: i32 }
obj Wrapper { child: Child }

@result(fresh)
fn snapshot(source: Wrapper) -> Wrapper
  Wrapper { child: source.child }

@access(staged: out)
fn invalid(source: Wrapper, ~out: Wrapper) -> void
  let copy = snapshot(source)
  out.child.value = 1
  let observed = copy.child.value
`),
    ).toContain("TY0057");
  });

  it("keeps fresh-wrapper field arguments source-bearing", () => {
    expect(
      diagnosticCodes(`
obj Child { value: i32 }
obj Wrapper { child: Child }

@result(fresh)
fn snapshot(source: Wrapper) -> Wrapper
  Wrapper { child: source.child }

fn read(child: Child) -> i32
  child.value

@access(staged: out)
fn invalid(source: Wrapper, ~out: Wrapper) -> void
  let copy = snapshot(source)
  out.child.value = 1
  let observed = read(copy.child)
`),
    ).toContain("TY0057");
  });

  it("keeps whole fresh wrappers source-bearing for reachable reads", () => {
    expect(
      diagnosticCodes(`
obj Child { value: i32 }
obj Wrapper { child: Child }

@result(fresh)
fn snapshot(source: Wrapper) -> Wrapper
  Wrapper { child: source.child }

fn read_wrapper(wrapper: Wrapper) -> i32
  wrapper.child.value

@access(staged: out)
fn invalid(source: Wrapper, ~out: Wrapper) -> void
  let copy = snapshot(source)
  out.child.value = 1
  let observed = read_wrapper(copy)
`),
    ).toContain("TY0057");
  });

  it("allows compatible forwarding and rejects uncertified forwarding", () => {
    expect(() =>
      analyze(`${prelude}
@access(staged: out)
fn forward(source: Box, ~out: Box) -> void
  copy_value(source, ~out)
`),
    ).not.toThrow();

    expect(
      diagnosticCodes(`
obj Box { value: i32 }

fn unbounded(source: Box, ~out: Box) -> void
  let snapshot = source.value
  out.value = snapshot

@access(staged: out)
fn invalid(source: Box, ~out: Box) -> void
  unbounded(source, ~out)
`),
    ).toContain("TY0057");
  });

  it("publishes a fresh outer that retains destination children", () => {
    expect(() =>
      analyze(`
obj Child { value: i32 }
obj State { child: Child, count: i32 }

@result(fresh)
fn copied(source: State) -> State
  State { child: source.child, count: source.count }

impl State
  @access(staged: self)
  fn publish(~self, next: State) -> void
    let child = next.child
    let count = next.count
    self.child = child
    self.count = count

fn valid(~state: State) -> void
  let next = copied(state)
  state.publish(next)
`),
    ).not.toThrow();
  });

  it("validates branches and loop backedges", () => {
    expect(() =>
      analyze(`
obj Box { value: i32 }

@access(staged: out)
fn branch(source: Box, ~out: Box, flag: bool) -> void
  if flag:
    out.value = 1
  else:
    let ignored = source.value
`),
    ).not.toThrow();

    expect(
      diagnosticCodes(`
obj Box { value: i32 }

@access(staged: out)
fn looped(source: Box, ~out: Box, count: i32) -> void
  var index = 0
  while index < count:
    let snapshot = source.value
    out.value = snapshot
    index = index + 1
`),
    ).toContain("TY0057");
  });

  it("inherits a trait declaration contract without duplicate annotation", () => {
    expect(() =>
      analyze(`
obj Box { value: i32 }
obj Copier {}

trait CopyValue
  @access(staged: out)
  fn copy(self, source: Box, ~out: Box): () -> void

impl CopyValue for Copier
  fn copy(self, source: Box, ~out: Box) -> void
    let snapshot = source.value
    out.value = snapshot
`),
    ).not.toThrow();
  });

  it("keeps open trait dispatch conservative", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }

trait Copier
  @access(staged: out)
  fn copy(self, source: Box, ~out: Box): () -> void

fn invalid<T: Copier>(copier: T, ~box: Box): () -> void
  copier.copy(box, ~box)
`),
    ).toContain("TY0048");
  });

  it("rejects reentrancy and ambient access", () => {
    const callback = diagnosticCodes(`
obj Box { value: i32 }

@access(staged: out)
fn invalid(source: Box, ~out: Box, callback: fn() -> void) -> void
  callback()
  out.value = source.value
`);
    const ambient = diagnosticCodes(`
obj Box { value: i32 }
let shared = Box { value: 0 }

@access(staged: out)
fn invalid(source: Box, ~out: Box) -> void
  let snapshot = source.value + shared.value
  out.value = snapshot
`);
    expect({ callback, ambient }).toEqual({
      callback: expect.arrayContaining(["TY0057"]),
      ambient: expect.arrayContaining(["TY0057"]),
    });
  });

  it("records linear validation counters", () => {
    perf.increment.mockClear();
    analyze(prelude);
    const counter = (name: string) =>
      perf.increment.mock.calls.find(([candidate]) => candidate === name)?.[1];
    expect(counter("borrowing.staged.declarations")).toBe(1);
    expect(counter("borrowing.staged.cfgBlocks")).toBeGreaterThan(0);
    expect(counter("borrowing.staged.workItems")).toBeGreaterThan(0);
    expect(counter("borrowing.staged.violations")).toBe(0);
  });
});

describe("private builder contracts", () => {
  const writerPrelude = `
obj Cell { value: i32 }
obj Source { cell: Cell }
obj Writer { cell: Cell }

@result(fresh)
fn make_writer() -> Writer
  Writer { cell: Cell { value: 0 } }

@access(builder: out)
fn write(source: Source, ~out: Writer, remaining: i32) -> void
  out.cell.value = source.cell.value
  if remaining > 0:
    write(source, ~out, remaining - 1)
`;

  it("permits exact recursive writes into a locally fresh private builder", () => {
    expect(() =>
      analyze(`${writerPrelude}
fn encode(source: Source) -> Writer
  let ~writer = make_writer()
  write(source, ~writer, 2)
  writer
`),
    ).not.toThrow();
  });

  it("accepts a fresh allocation-backed builder beside another mutable input", () => {
    expect(() =>
      analyzeStd(`
@intrinsic_type(type: "voyd.std.array")
obj Buffer<T> { value: T }
obj Parser { value: i32 }

@result(fresh)
fn make_buffer() -> Buffer<i32>
  Buffer<i32> { value: 0 }

@access(builder: out)
fn append(~out: Buffer<i32>, ~parser: Parser) -> void
  out.value = parser.value
  parser.value = parser.value + 1

fn finish(out: Buffer<i32>) -> Buffer<i32>
  out

fn parse(~parser: Parser, finish_early: bool) -> Buffer<i32>
  let ~out = make_buffer()
  if finish_early:
    return finish(out)
  append(out, parser)
  out
`),
    ).not.toThrow();
  });

  it("rejects source retention and closure capture", () => {
    const retained = diagnosticCodes(`
obj Cell { value: i32 }
obj Source { cell: Cell }
obj Writer { cell: Cell }

@access(builder: out)
fn invalid(source: Source, ~out: Writer) -> void
  out.cell = source.cell
`);
    const captured = diagnosticCodes(`
obj Cell { value: i32 }
obj Source { cell: Cell }
obj Writer { cell: Cell }

@access(builder: out)
fn invalid(source: Source, ~out: Writer) -> void
  let callback: fn() : () -> i32 = () => source.cell.value
  out.cell.value = callback()
`);
    expect({ retained, captured }).toEqual({
      retained: expect.arrayContaining(["TY0058"]),
      captured: expect.arrayContaining(["TY0058"]),
    });
  });

  it("keeps non-fresh and open-dispatch destinations conservative", () => {
    const nonFresh = diagnosticCodes(`${writerPrelude}
fn invalid(source: Source, ~writer: Writer) -> void
  write(source, ~writer, 1)
`);
    const open = diagnosticCodes(`
obj Cell { value: i32 }
obj Source { cell: Cell }
obj Writer { cell: Cell }

trait Write
  @access(builder: out)
  fn write(self, source: Source, ~out: Writer): () -> void

@result(fresh)
fn make_writer() -> Writer
  Writer { cell: Cell { value: 0 } }

fn encode<T: Write>(encoder: T, source: Source) -> Writer
  let ~writer = make_writer()
  encoder.write(source, ~writer)
  writer
`);
    expect({ nonFresh, open }).toEqual({
      nonFresh: expect.arrayContaining(["TY0048"]),
      open: expect.arrayContaining(["TY0048"]),
    });
  });

  it("rejects a source selected from the fresh builder itself", () => {
    expect(
      diagnosticCodes(`
obj Cell { value: i32 }
obj Writer { cell: Cell }

@result(fresh)
fn make_writer() -> Writer
  Writer { cell: Cell { value: 0 } }

@access(builder: out)
fn write(source: Cell, ~out: Writer) -> void
  out.cell.value = source.value

fn invalid() -> Writer
  let ~writer = make_writer()
  write(writer.cell, ~writer)
  writer
`),
    ).toContain("TY0048");
  });

  it("rejects a fresh outer builder that retains the same source", () => {
    expect(
      diagnosticCodes(`
obj Child { value: i32 }
obj Builder { child: Child }

@result(fresh)
fn make_builder(source: Child) -> Builder
  Builder { child: source }

@access(builder: out)
fn write(source: Child, ~out: Builder) -> void
  out.child.value = source.value

fn invalid(source: Child) -> Builder
  let ~builder = make_builder(source)
  write(source, ~builder)
  builder
`),
    ).toContain("TY0048");
  });

  it("inherits a trait declaration contract without duplicate annotation", () => {
    expect(() =>
      analyze(`
obj Cell { value: i32 }
obj Source { cell: Cell }
obj Writer { cell: Cell }

trait Encode
  @access(builder: out)
  fn encode(self, source: Source, ~out: Writer): () -> void

impl Encode for Writer
  fn encode(self, source: Source, ~out: Writer) -> void
    out.cell.value = source.cell.value
`),
    ).not.toThrow();
  });

  it("records bounded validation counters", () => {
    perf.increment.mockClear();
    analyze(writerPrelude);
    const counter = (name: string) =>
      perf.increment.mock.calls.find(([candidate]) => candidate === name)?.[1];
    expect(counter("borrowing.builder.declarations")).toBe(1);
    expect(counter("borrowing.builder.originInsertions")).toBeLessThanOrEqual(
      3,
    );
    expect(counter("borrowing.builder.forwarding")).toBe(1);
    expect(counter("borrowing.builder.violations")).toBe(0);
  });
});
