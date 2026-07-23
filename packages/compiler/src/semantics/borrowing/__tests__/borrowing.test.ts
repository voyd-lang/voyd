import { describe, expect, it } from "vitest";
import { resolve, sep } from "node:path";
import { DiagnosticError } from "../../../diagnostics/index.js";
import { createMemoryModuleHost } from "../../../modules/memory-host.js";
import { createNodePathAdapter } from "../../../modules/node-path-adapter.js";
import { analyzeModules, loadModuleGraph } from "../../../pipeline.js";
import { parse } from "../../../parser/index.js";
import { semanticsPipeline } from "../../pipeline.js";
import {
  mergeCallableBorrowContracts,
  normalizeCallableBorrowTransfers,
} from "../model.js";
import { normalizeReturnedSharedOrigins } from "../summaries.js";

const analyze = (source: string) => {
  const filePath = "borrowing.test.voyd";
  const ast = parse(source, filePath);
  if (
    !source.includes('@intrinsic_type(type: "voyd.std.shared-cell")') &&
    !source.includes("__array_set(") &&
    !source.includes("__array_copy(") &&
    !source.includes("__array_get(") &&
    !source.includes("__retain_callback") &&
    !source.includes("__boundary_retain_callback") &&
    !source.includes("__render_retain_callback") &&
    !source.includes("__task_spawn") &&
    !source.includes("__task_detach")
  ) {
    return semanticsPipeline(ast);
  }
  const module = {
    id: "std::borrowing_test",
    path: { namespace: "std" as const, segments: ["borrowing_test"] },
    origin: { kind: "file" as const, filePath },
    ast,
    source,
    dependencies: [],
  };
  return semanticsPipeline({
    module,
    graph: {
      entry: module.id,
      modules: new Map([[module.id, module]]),
      diagnostics: [],
    },
  });
};

const diagnosticCodes = (source: string): readonly string[] => {
  try {
    analyze(source);
    return [];
  } catch (error) {
    if (!(error instanceof DiagnosticError)) {
      throw error;
    }
    return error.diagnostics.map((diagnostic) => diagnostic.code);
  }
};

const analyzeWithRecovery = (source: string) => {
  const filePath = "borrowing-recovery.test.voyd";
  const ast = parse(source, filePath);
  const module = {
    id: "src::borrowing_recovery",
    path: { namespace: "src" as const, segments: ["borrowing_recovery"] },
    origin: { kind: "file" as const, filePath },
    ast,
    source,
    dependencies: [],
  };
  return semanticsPipeline({
    module,
    graph: {
      entry: module.id,
      modules: new Map([[module.id, module]]),
      diagnostics: [],
    },
    recoverFromTypingErrors: true,
  });
};

const recoveryDiagnosticCodes = (source: string): readonly string[] =>
  analyzeWithRecovery(source).diagnostics.map((diagnostic) => diagnostic.code);

const diagnosticsFor = (source: string) => {
  try {
    analyze(source);
    return [];
  } catch (error) {
    if (!(error instanceof DiagnosticError)) {
      throw error;
    }
    return error.diagnostics;
  }
};

const prelude = `
obj Box { value: i32 }
obj Pair { left: Box, right: Box }

fn read(value: Box) -> i32
  value.value

fn mutate(~value: Box) -> void
  value.value = value.value + 1

fn mutate_both(~left: Box, ~right: Box) -> void
  mutate(~left)
  mutate(~right)
`;

describe("borrow checking", () => {
  it("preserves borrowed-source taint when transfers widen", () => {
    const transfers = Array.from({ length: 33 }, (_entry, index) => ({
      sourceParameter: 1,
      destinationParameter: 0,
      sourcePath: [
        { kind: "field" as const, name: `source_${index}` },
      ],
      destinationPath: [
        { kind: "field" as const, name: `destination_${index}` },
      ],
      ...(index === 32 ? { borrowsSource: true as const } : {}),
    }));

    expect(normalizeCallableBorrowTransfers(transfers)).toEqual([
      expect.objectContaining({
        sourceParameter: 1,
        destinationParameter: 0,
        conservative: true,
        borrowsSource: true,
      }),
    ]);
  });

  it("keeps shared return provenance only when every target agrees", () => {
    const origin = { source: [], result: [] };
    const merged = mergeCallableBorrowContracts([
      {
        parameters: [
          {
            access: "shared",
            retained: false,
            returned: true,
            returnedOrigins: [origin],
            returnedSharedOrigins: [origin],
          },
        ],
        maySuspend: false,
      },
      {
        parameters: [
          {
            access: "shared",
            retained: false,
            returned: true,
            returnedOrigins: [origin],
          },
        ],
        maySuspend: false,
      },
    ]);

    expect(merged?.parameters[0]?.returnedSharedOrigins).toBeUndefined();
  });

  it("rejects overlapping aliases and reports the borrow origin", () => {
    const codes = diagnosticCodes(`${prelude}
fn conflict(~value: Box) -> i32
  let alias = value
  mutate(~value)
  alias.value
`);

    expect(codes).toContain("TY0048");
  });

  it("reports borrow diagnostics in recovery mode when typing is clean", () => {
    expect(
      recoveryDiagnosticCodes(`${prelude}
fn conflict(~value: Box) -> i32
  let alias = value
  mutate(~value)
  alias.value
`),
    ).toContain("TY0048");
  });

  it("tracks transitive alias provenance", () => {
    expect(
      diagnosticCodes(`${prelude}
fn conflict(~value: Box) -> i32
  let first = value
  let second = first
  mutate(~value)
  second.value
`),
    ).toContain("TY0048");
  });

  it("tracks unique roots captured by live closures", () => {
    expect(
      diagnosticCodes(`${prelude}
fn invalid() -> i32
  let ~value = Box { value: 1 }
  let change = () =>
    value.value = 2
  mutate(~value)
  change()
  value.value
`),
    ).toContain("TY0048");
  });

  it("ends unique-root capture borrows after the closure's last use", () => {
    expect(() =>
      analyze(`${prelude}
fn valid() -> i32
  let ~value = Box { value: 1 }
  let change = () =>
    value.value = 2
  change()
  mutate(~value)
  value.value
`),
    ).not.toThrow();
  });

  it("reports both the attempted access and borrow lifetime spans", () => {
    const diagnostics = diagnosticsFor(`${prelude}
fn conflict(~value: Box) -> i32
  let alias = value
  mutate(~value)
  alias.value
`);
    const conflict = diagnostics.find(
      (diagnostic) => diagnostic.code === "TY0048",
    );

    const relatedMessages =
      conflict?.related?.map((entry) => entry.message) ?? [];
    expect(relatedMessages.length).toBeGreaterThanOrEqual(2);
    expect(conflict?.related?.every((entry) => entry.span.start >= 0)).toBe(
      true,
    );
    expect(
      [
        conflict?.message,
        ...(conflict?.related ?? []).map((entry) => entry.message),
      ].join("\n"),
    ).not.toMatch(/HIR|codegen|symbol id/i);
  });

  it("ends a shared borrow after its last use", () => {
    expect(() =>
      analyze(`${prelude}
fn non_lexical(~value: Box) -> i32
  let alias = value
  let before = alias.value
  mutate(~value)
  before + value.value
`),
    ).not.toThrow();
  });

  it("allows mutable borrows from var bindings", () => {
    expect(() =>
      analyze(`${prelude}
fn valid() -> i32
  var value = Box { value: 1 }
  mutate(~value)
  value.value
`),
    ).not.toThrow();
  });

  it("rejects two mutable call arguments that overlap", () => {
    expect(
      diagnosticCodes(`${prelude}
fn conflict(~value: Box) -> void
  mutate_both(~value, ~value)
`),
    ).toContain("TY0048");
  });

  it("rejects overlapping mutable scalar call arguments", () => {
    expect(
      diagnosticCodes(`
fn mutate_both(~left: i32, ~right: i32) -> void
  left = left + 1
  right = right + 1

fn conflict() -> void
  var value = 1
  mutate_both(~value, ~value)
`),
    ).toContain("TY0048");
  });

  it("rejects shared and mutable arguments that overlap", () => {
    expect(
      diagnosticCodes(`${prelude}
fn read_and_mutate(readable: Box, ~writable: Box) -> void
  read(readable)
  mutate(~writable)

fn conflict(~value: Box) -> void
  read_and_mutate(value, ~value)
`),
    ).toContain("TY0048");
  });

  it("rejects a mutable receiver that overlaps an argument", () => {
    expect(
      diagnosticCodes(`${prelude}
impl Box
  fn copy_from(~self, source: Box) -> void
    self.value = source.value

fn conflict(~value: Box) -> void
  value.copy_from(value)
`),
    ).toContain("TY0048");
  });

  it("rejects owner access while a mutable reborrow is live", () => {
    expect(
      diagnosticCodes(`${prelude}
fn conflict(~value: Box) -> i32
  let ~alias = value
  let owner_value = value.value
  alias.value + owner_value
`),
    ).toContain("TY0048");
  });

  it("allows mutable borrows of distinct fields", () => {
    expect(() =>
      analyze(`${prelude}
fn distinct(~pair: Pair) -> i32
  let ~left = pair.left
  mutate(~pair.right)
  left.value + pair.right.value
`),
    ).not.toThrow();
  });

  it("preserves provenance through structural views", () => {
    expect(
      diagnosticCodes(`${prelude}
type Readable = { value: i32 }

fn conflict(~value: Box) -> i32
  let view: Readable = value
  mutate(~value)
  view.value
`),
    ).toContain("TY0048");
  });

  it("preserves provenance through trait views", () => {
    expect(
      diagnosticCodes(`${prelude}
trait Readable
  fn read(self) -> i32

impl Readable for Box
  fn read(self) -> i32
    self.value

fn conflict(~value: Box) -> i32
  let view: Readable = value
  mutate(~value)
  view.read()
`),
    ).toContain("TY0048");
  });

  it("conservatively overlaps indexed places without a stable-storage contract", () => {
    expect(
      diagnosticCodes(`${prelude}
obj Buffer { first: Box, second: Box }

impl Buffer
  fn subscript_get(self, index: i32) -> Box
    if index == 0:
      self.first
    else:
      self.second

fn conflict(~buffer: Buffer) -> void
  mutate_both(
    ~buffer.subscript_get(0),
    ~buffer.subscript_get(1)
  )
`),
    ).toContain("TY0048");
  });

  it("rejects creating a mutable borrow from shared access", () => {
    expect(
      diagnosticCodes(`${prelude}
fn invalid(value: Box) -> void
  let ~alias = value
  mutate(~alias)
`),
    ).toContain("TY0050");
  });

  it("rejects passing a shared binding to a mutable parameter", () => {
    expect(
      diagnosticCodes(`${prelude}
fn invalid(value: Box) -> void
  mutate(~value)
`),
    ).not.toHaveLength(0);
  });

  it("rejects passing a shared binding through an opaque mutable callable", () => {
    expect(
      diagnosticCodes(`${prelude}
fn invoke(callback: fn(~Box) : () -> void, value: Box) -> void
  callback(~value)
`),
    ).toContain("TY0050");
  });

  it("maps labeled container fields to their individual borrow capabilities", () => {
    expect(() =>
      analyze(`${prelude}
fn consume({ shared: Box, ~mutable: Box }) -> i32
  mutable.value = shared.value
  mutable.value

fn relay(shared: Box, ~mutable: Box) -> i32
  consume({ shared, mutable })
`),
    ).not.toThrow();
  });

  it("rejects mutable borrows passed to opaque retaining callables", () => {
    expect(
      diagnosticCodes(`${prelude}
fn invoke(~value: Box, callback: fn(Box) : () -> void) -> void
  callback(value)
`),
    ).toContain("TY0049");
  });

  it("allows rebinding after an opaque callable retains the old value", () => {
    expect(() =>
      analyze(`${prelude}
fn valid(initial: Box, step: fn(Box) : () -> Box) -> Box
  var current = initial
  current = step(current)
  current
`),
    ).not.toThrow();
  });

  it("rejects reference defaults that overlap mutable parameters", () => {
    expect(
      diagnosticCodes(`${prelude}
fn conflict(~left: Box, right: Box = left) -> i32
  left.value + right.value
`),
    ).toContain("TY0048");
  });

  it("tracks reference defaults through calls and earlier defaults", () => {
    expect(
      diagnosticCodes(`${prelude}
fn identity(value: Box) -> Box
  value

fn conflict(
  ~left: Box,
  middle: Box = identity(left),
  right: Box = middle
) -> i32
  left.value + middle.value + right.value
`),
    ).toContain("TY0048");
  });

  it("updates alias provenance after reference reassignment", () => {
    expect(
      diagnosticCodes(`${prelude}
fn conflict(~value: Box, other: Box) -> i32
  var alias = other
  alias = value
  mutate(~value)
  alias.value
`),
    ).toContain("TY0048");
  });

  it("does not treat an overwritten alias target as a read", () => {
    expect(() =>
      analyze(`${prelude}
fn valid(~value: Box, other: Box) -> void
  var alias = value
  mutate(~value)
  alias = other
`),
    ).not.toThrow();
  });

  it("merges alias provenance after conditional assignments", () => {
    expect(
      diagnosticCodes(`${prelude}
fn conflict(~value: Box, other: Box, replace: bool) -> i32
  var alias = value
  if replace:
    alias = other
  mutate(~value)
  alias.value
`),
    ).toContain("TY0048");
  });

  it("preserves every possible origin when copying a conditional alias", () => {
    expect(
      diagnosticCodes(`${prelude}
fn conflict(~value: Box, other: Box, replace: bool) -> i32
  var alias = other
  if replace:
    alias = value
  let copy = alias
  mutate(~value)
  copy.value
`),
    ).toContain("TY0048");
  });

  it("preserves every possible origin returned from a call", () => {
    expect(
      diagnosticCodes(`${prelude}
fn choose(first: Box, second: Box, select_first: bool) -> Box
  if select_first:
    first
  else:
    second

fn conflict(~value: Box, other: Box, select_first: bool) -> i32
  let selected = choose(value, other, select_first)
  mutate(~value)
  selected.value
`),
    ).toContain("TY0048");
  });

  it("preserves every possible origin of conditional expressions", () => {
    expect(
      diagnosticCodes(`${prelude}
fn conflict(~value: Box, other: Box, select_value: bool) -> i32
  let alias =
    if select_value:
      value
    else:
      other
  mutate(~value)
  alias.value
`),
    ).toContain("TY0048");
  });

  it("preserves pre-loop alias provenance when a loop may not run", () => {
    expect(
      diagnosticCodes(`${prelude}
fn conflict(~value: Box, other: Box, replace: bool) -> i32
  var alias = value
  while replace:
    alias = other
    break
  mutate(~value)
  alias.value
`),
    ).toContain("TY0048");
  });

  it("keeps outer borrows live when a returning loop may not run", () => {
    expect(
      diagnosticCodes(`${prelude}
fn conflict(~value: Box, should_return: bool) -> i32
  let alias = value
  while should_return:
    return 0
  mutate(~value)
  alias.value
`),
    ).toContain("TY0048");
  });

  it("does not analyze statements after break or continue", () => {
    expect(() =>
      analyze(`${prelude}
fn valid(~value: Box, keep_going: bool) -> void
  while keep_going:
    break
    let alias = value
    mutate(~value)
    let result = alias.value

  while keep_going:
    continue
    let alias = value
    mutate(~value)
    let result = alias.value
`),
    ).not.toThrow();
  });

  it("preserves reference provenance through object storage", () => {
    expect(
      diagnosticCodes(`${prelude}
obj Holder { value: Box }

fn invalid(~value: Box) -> void
  let holder = Holder { value: value }
  mutate(~value)
  let result = read(holder.value)
`),
    ).toContain("TY0048");
  });

  it("keeps fresh mutable aggregate identity separate from its contents", () => {
    expect(() =>
      analyze(`${prelude}
obj Pair { left: Box }
obj Holder { value: Box }

fn replace_locally(first: Box, second: Box) -> void
  let ~holder = Holder { value: first }
  holder.value = second

fn valid(~first: Pair, ~second: Pair) -> void
  replace_locally(first.left, second.left)
  mutate(~second.left)
`),
    ).not.toThrow();
  });

  it("propagates retained origins through fixed-array storage intrinsics", () => {
    expect(
      diagnosticCodes(`${prelude}
fn invalid(
  ~value: Box,
  storage: FixedArray<Box>
) -> i32
  __array_set(storage, 0, value)
  mutate(~value)
  __array_get(storage, 0).value
`),
    ).toContain("TY0051");
  });

  it("rejects mutation after a helper retains an array-element borrow", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }

fn retain_first(
  values: FixedArray<Box>,
  retain: fn(Box) : () -> void
) -> void
  retain(__array_get(values, 0))

fn mutate_array(~values: FixedArray<Box>) -> void
  __array_set(values, 0, Box { value: 1 })
  void

fn invalid(
  ~values: FixedArray<Box>,
  retain: fn(Box) : () -> void
) -> void
  retain_first(values, retain)
  mutate_array(~values)
`),
    ).toContain("TY0049");
  });

  it("preserves external retention when a helper also returns the source", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }

fn retain_and_return(
  values: FixedArray<Box>,
  retain: fn(Box) : () -> void
) -> FixedArray<Box>
  retain(__array_get(values, 0))
  values

fn mutate_array(~values: FixedArray<Box>) -> void
  __array_set(values, 0, Box { value: 1 })
  void

fn invalid(
  ~values: FixedArray<Box>,
  retain: fn(Box) : () -> void
) -> void
  let returned = retain_and_return(values, retain)
  let length = __array_len(returned)
  mutate_array(~values)
`),
    ).toContain("TY0049");
  });

  it("preserves array-element retention through caller-owned storage", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj Holder { value: Box }

fn store_first(values: FixedArray<Box>, ~holder: Holder) -> void
  holder.value = __array_get(values, 0)

fn mutate_array(~values: FixedArray<Box>) -> void
  __array_set(values, 0, Box { value: 1 })
  void

fn invalid(
  ~values: FixedArray<Box>,
  ~holder: Holder
) -> void
  store_first(values, ~holder)
  mutate_array(~values)
`),
    ).toContain("TY0049");
  });

  it("materializes scalar values stored through array intrinsics", () => {
    expect(() =>
      analyze(`
fn store(~value: i32, values: FixedArray<i32>) -> void
  __array_set(values, 0, value)
  void
`),
    ).not.toThrow();
  });

  it("materializes scalar values copied between arrays", () => {
    expect(() =>
      analyze(`
fn copy(values: FixedArray<i32>) -> FixedArray<i32>
  let destination = __array_new<i32>(1)
  __array_copy(destination, {
    from: values,
    to_index: 0,
    from_index: 0,
    count: 1
  })
  destination

fn mutate_array(~values: FixedArray<i32>) -> void
  __array_set(values, 0, 1)
  void

fn valid(~values: FixedArray<i32>) -> i32
  let copied = copy(values)
  mutate_array(~values)
  __array_get(copied, 0)
`),
    ).not.toThrow();
  });

  it("preserves reference provenance through value-object storage", () => {
    expect(
      diagnosticCodes(`${prelude}
val Wrapper { inner: Box }

fn inspect(wrapper: Wrapper, ~value: Box) -> i32
  mutate(~value)
  wrapper.inner.value

fn invalid(~value: Box) -> i32
  inspect(Wrapper { inner: value }, ~value)
`),
    ).toContain("TY0048");
  });

  it("preserves returned origins through nested value objects", () => {
    expect(
      diagnosticCodes(`${prelude}
val Wrapper { inner: Box }
val Outer { wrapper: Wrapper }

fn wrap(value: Box) -> Outer
  Outer { wrapper: Wrapper { inner: value } }

fn invalid(~value: Box) -> i32
  let outer = wrap(value)
  mutate(~value)
  outer.wrapper.inner.value
`),
    ).toContain("TY0048");
  });

  it("preserves contained origins in inline aggregate arguments", () => {
    expect(
      diagnosticCodes(`${prelude}
obj Holder { value: Box }

fn inspect(holder: Holder, ~value: Box) -> i32
  mutate(~value)
  holder.value.value

fn invalid(~value: Box) -> i32
  inspect(Holder { value: value }, ~value)
`),
    ).toContain("TY0048");
  });

  it("preserves contained origins through aggregate control flow", () => {
    expect(
      diagnosticCodes(`${prelude}
obj Holder { value: Box }

fn invalid(~value: Box, other: Box, choose_value: bool) -> i32
  let holder =
    if choose_value:
      Holder { value: value }
    else:
      Holder { value: other }
  mutate(~value)
  holder.value.value
`),
    ).toContain("TY0048");
  });

  it("preserves reference provenance through tuple storage", () => {
    expect(
      diagnosticCodes(`${prelude}
fn invalid(~value: Box, other: Box) -> i32
  let values = (value, other)
  mutate(~value)
  values.0.value
`),
    ).toContain("TY0048");
  });

  it("updates aggregate provenance after reassignment", () => {
    expect(
      diagnosticCodes(`${prelude}
obj Holder { value: Box }

fn invalid(~value: Box, other: Box) -> i32
  var holder = Holder { value: other }
  holder = Holder { value: value }
  mutate(~value)
  holder.value.value
`),
    ).toContain("TY0048");
  });

  it("preserves aggregate provenance through destructuring", () => {
    expect(
      diagnosticCodes(`${prelude}
fn invalid(~value: Box, other: Box) -> i32
  let (alias, _) = (value, other)
  mutate(~value)
  alias.value
`),
    ).toContain("TY0048");
  });

  it("preserves returned field projections across calls", () => {
    expect(() =>
      analyze(`${prelude}
fn left(pair: Pair) -> Box
  pair.left

fn valid(~pair: Pair) -> i32
  let alias = left(pair)
  mutate(~pair.right)
  alias.value + pair.right.value
`),
    ).not.toThrow();
  });

  it("composes returned aggregate projections across nested calls", () => {
    expect(
      diagnosticCodes(`${prelude}
fn copy_pair(pair: Pair) -> Pair
  Pair { left: pair.left, right: pair.right }

fn left(pair: Pair) -> Box
  pair.left

fn invalid(~pair: Pair) -> i32
  let alias = left(copy_pair(pair))
  mutate(~pair.left)
  alias.value
`),
    ).toContain("TY0048");

    expect(() =>
      analyze(`${prelude}
fn copy_pair(pair: Pair) -> Pair
  Pair { left: pair.left, right: pair.right }

fn left(pair: Pair) -> Box
  pair.left

fn valid(~pair: Pair) -> i32
  let alias = left(copy_pair(pair))
  mutate(~pair.right)
  alias.value
`),
    ).not.toThrow();
  });

  it("preserves unresolved projections through intermediate aggregates", () => {
    expect(
      diagnosticCodes(`${prelude}
obj Leaf { value: i32, other: i32 }
obj LeafPair { left: Leaf }
obj Inner { value: Leaf }
obj Outer { inner: Inner }

fn wrap(pair: LeafPair) -> Outer
  Outer { inner: Inner { value: pair.left } }

fn invalid(~pair: LeafPair) -> i32
  let inner = wrap(pair).inner
  let alias = inner.value
  pair.left.other = pair.left.other + 1
  alias.value
`),
    ).toContain("TY0048");
  });

  it("preserves unresolved projections through nested destructuring", () => {
    expect(
      diagnosticCodes(`${prelude}
obj Leaf { value: i32, other: i32 }
obj LeafPair { left: Leaf }
obj Inner { value: Leaf }
obj Outer { inner: Inner }

fn wrap(pair: LeafPair) -> Outer
  Outer { inner: Inner { value: pair.left } }

fn invalid(~pair: LeafPair) -> i32
  let { inner: { value: alias } } = wrap(pair)
  pair.left.other = pair.left.other + 1
  alias.value
`),
    ).toContain("TY0048");
  });

  it("conservatively preserves origins stored in returned aggregates", () => {
    expect(
      diagnosticCodes(`${prelude}
obj Holder { value: Box }

fn wrap(pair: Pair) -> Holder
  Holder { value: pair.left }

fn invalid(~pair: Pair) -> i32
  let wrapper = wrap(pair)
  let alias = wrapper.value
  mutate(~pair.left)
  alias.value
`),
    ).toContain("TY0048");
  });

  it("preserves conservative returned aggregates through reassignment", () => {
    expect(
      diagnosticCodes(`${prelude}
obj Holder { value: Box }

fn wrap(pair: Pair) -> Holder
  Holder { value: pair.left }

fn invalid(~pair: Pair, initial: Holder) -> i32
  var wrapper = initial
  wrapper = wrap(pair)
  let alias = wrapper.value
  mutate(~pair.left)
  alias.value
`),
    ).toContain("TY0048");
  });

  it("merges returned aggregate origins after conditional reassignment", () => {
    expect(
      diagnosticCodes(`${prelude}
obj Holder { value: Box }

fn wrap(pair: Pair) -> Holder
  Holder { value: pair.left }

fn invalid(~first: Pair, second: Pair, replace: bool) -> i32
  var wrapper = wrap(first)
  if replace:
    wrapper = wrap(second)
  let alias = wrapper.value
  mutate(~first.left)
  alias.value
`),
    ).toContain("TY0048");
  });

  it("merges direct and returned aggregate origins after reassignment", () => {
    expect(
      diagnosticCodes(`${prelude}
obj Holder { value: Box }

fn wrap(pair: Pair) -> Holder
  Holder { value: pair.left }

fn invalid(~initial: Holder, pair: Pair, replace: bool) -> i32
  var wrapper = initial
  if replace:
    wrapper = wrap(pair)
  let alias = wrapper.value
  mutate(~initial.value)
  alias.value
`),
    ).toContain("TY0048");
  });

  it("projects returned aggregate provenance through destructuring", () => {
    expect(
      diagnosticCodes(`${prelude}
obj Holder { value: Box }

fn wrap(pair: Pair) -> Holder
  Holder { value: pair.left }

fn invalid(~pair: Pair) -> i32
  let { value: alias } = wrap(pair)
  mutate(~pair.left)
  alias.value
`),
    ).toContain("TY0048");
  });

  it("preserves contained origins when passing returned aggregates directly", () => {
    expect(
      diagnosticCodes(`${prelude}
obj Holder { value: Box }

fn wrap(pair: Pair) -> Holder
  Holder { value: pair.left }

fn inspect(holder: Holder, ~value: Box) -> i32
  mutate(~value)
  holder.value.value

fn invalid(~pair: Pair) -> i32
  inspect(wrap(pair), ~pair.left)
`),
    ).toContain("TY0048");
  });

  it("preserves retained field projections across calls", () => {
    expect(() =>
      analyze(`${prelude}
obj Holder { value: Box }

fn retain_left(~holder: Holder, pair: Pair) -> void
  holder.value = pair.left

fn valid() -> void
  var pair = Pair {
    left: Box { value: 1 },
    right: Box { value: 2 }
  }
  var holder = Holder { value: Box { value: 0 } }
  retain_left(~holder, pair)
  mutate(~pair.right)
`),
    ).not.toThrow();
  });

  it("permanently shares a unique capability passed to a retaining call", () => {
    expect(
      diagnosticCodes(`${prelude}
obj Holder { value: Box }

fn retain(~holder: Holder, value: Box) -> void
  holder.value = value

fn invalid(~value: Box, ~holder: Holder) -> void
  retain(~holder, value)
  mutate(~value)
`),
    ).toContain("TY0051");
  });

  it("downgrades contained origins retained from returned aggregates", () => {
    expect(
      diagnosticCodes(`${prelude}
obj Holder { value: Box }

fn wrap(pair: Pair) -> Holder
  Holder { value: pair.left }

fn retain(~target: Holder, value: Holder) -> void
  target.value = value.value

fn invalid(~target: Holder) -> void
  var pair = Pair {
    left: Box { value: 1 },
    right: Box { value: 2 }
  }
  retain(~target, wrap(pair))
  mutate(~pair.left)
`),
    ).toContain("TY0051");
  });

  it("retains only the selected field of a returned aggregate alias", () => {
    expect(() =>
      analyze(`${prelude}
obj PairHolder { left: Box, right: Box }
obj Holder { value: Box }

fn wrap(pair: Pair) -> PairHolder
  PairHolder { left: pair.left, right: pair.right }

fn retain_right(~target: Holder, value: PairHolder) -> void
  target.value = value.right

fn valid(~target: Holder) -> void
  var pair = Pair {
    left: Box { value: 1 },
    right: Box { value: 2 }
  }
  let wrapped = wrap(pair)
  retain_right(~target, wrapped)
  mutate(~pair.left)
`),
    ).not.toThrow();
  });

  it("honors parameter-retention contracts across modules", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryModuleHost({
      files: {
        [`${root}${sep}storage.voyd`]: `
pub obj Box { api value: i32 }
pub obj Holder { api value: Box }

pub fn retain({ value: Box, into ~holder: Holder, marker: i32 = 0 }) -> void
  let _ = marker
  holder.value = value
`,
        [`${root}${sep}main.voyd`]: `
use src::storage::{ Box, Holder, retain }

fn mutate(~value: Box) -> void
  value.value = value.value + 1

fn invalid(~value: Box, ~holder: Holder) -> void
  retain(into: ~holder, value: value)
  mutate(~value)
`,
      },
      pathAdapter: createNodePathAdapter(),
    });
    const graph = await loadModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root },
      host,
    });
    const analyzed = analyzeModules({ graph });
    const diagnostics = [...graph.diagnostics, ...analyzed.diagnostics];
    const retainContract = Array.from(
      analyzed.semantics.get("src::storage")?.borrowing.callables.values() ??
        [],
    ).find((contract) => contract.parameters[0]?.retained);

    expect(retainContract?.parameters[0]?.retained).toBe(true);
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "TY0051",
    );
  });

  it("publishes parametric borrow contracts for exported generics", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryModuleHost({
      files: {
        [`${root}${sep}generic.voyd`]: `
pub obj Box { api value: i32 }

pub fn identity<T>(value: T) -> T
  value

fn instantiate_with_scalar() -> i32
  identity(1)
`,
        [`${root}${sep}main.voyd`]: `
use src::generic::{ Box, identity }

fn mutate(~value: Box) -> void
  value.value = value.value + 1

fn invalid(~value: Box) -> i32
  let alias = identity(value)
  mutate(~value)
  alias.value
`,
      },
      pathAdapter: createNodePathAdapter(),
    });
    const graph = await loadModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root },
      host,
    });
    const analyzed = analyzeModules({ graph });
    const diagnostics = [...graph.diagnostics, ...analyzed.diagnostics];
    const identityContract = Array.from(
      analyzed.semantics.get("src::generic")?.borrowing.callables.values() ??
        [],
    ).find((contract) => contract.parameters[0]?.returned);

    expect(identityContract?.parameters[0]?.returned).toBe(true);
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "TY0048",
    );
  });

  it("publishes retained callback contracts for generic task wrappers", async () => {
    const srcRoot = resolve("/proj/src");
    const stdRoot = resolve("/proj/std");
    const host = createMemoryModuleHost({
      files: {
        [`${stdRoot}${sep}task.voyd`]: `
pub obj Task<T> {
  api id: i32
}

@effect(id: "voyd.std.borrowing_test.task")
pub eff TaskRuntime
  wait(resume, id: i32) -> i32

@intrinsic(name: "__task_spawn")
fn spawn_id<T>(work: fn() : (open) -> T): (open) -> i32
  __task_spawn(work)

pub fn spawn<T>(work: fn() : (open) -> T): (TaskRuntime, open) -> Task<T>
  Task<T> { id: spawn_id(work) }

pub fn spawn_tuple<T>(
  work: fn() : (open) -> T
): (TaskRuntime, open) -> (i32, i32)
  (spawn_id(work), 0)
`,
        [`${srcRoot}${sep}main.voyd`]: `
use std::task::{ spawn }

obj Box { value: i32 }

fn mutate(~box: Box) -> void
  box.value = box.value + 1

pub fn invalid(): (open) -> void
  let ~box = Box { value: 0 }
  let work = () => box.value
  let _ = spawn(work)
  mutate(~box)
`,
      },
      pathAdapter: createNodePathAdapter(),
    });
    const graph = await loadModuleGraph({
      entryPath: `${srcRoot}${sep}main.voyd`,
      roots: { src: srcRoot, std: stdRoot },
      host,
    });
    const analyzed = analyzeModules({ graph });
    const diagnostics = [...graph.diagnostics, ...analyzed.diagnostics];
    const spawnExport = analyzed.semantics
      .get("std::task")
      ?.exports.get("spawn");
    const spawnContract = spawnExport?.borrowing?.find(
      (entry) => entry.symbol === spawnExport.symbol,
    )?.contract;
    const tupleExport = analyzed.semantics
      .get("std::task")
      ?.exports.get("spawn_tuple");
    const tupleContract = tupleExport?.borrowing?.find(
      (entry) => entry.symbol === tupleExport.symbol,
    )?.contract;

    expect(spawnContract?.parameters[0]?.retained).toBe(true);
    expect(tupleContract?.parameters[0]?.retained).toBe(true);
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "TY0049",
    );
  });

  it("widens recursive returned projections to a conservative root", () => {
    const result = analyze(`
obj Box { value: i32 }
obj Empty {}
obj Link {
  value: Box | Empty,
  next: Link | Empty
}

fn chain(value: Box, depth: i32) -> Link
  if depth <= 0:
    return Link { value, next: Empty {} }
  Link { value: Empty {}, next: chain(value, depth - 1) }
`);
    const recursive = Array.from(result.borrowing.callables.values()).find(
      (contract) =>
        contract.parameters[0]?.returnedOrigins?.some(
          (origin) => origin.source.length === 0 && origin.result.length === 0,
        ),
    );

    expect(recursive).toBeDefined();
  });

  it("widens recursive transfer projections to a conservative root", () => {
    const result = analyze(`
obj Box { value: i32 }
obj Chain {
  value: Box,
  next: Chain
}

fn write(~destination: Chain, source: Box, recurse: bool) -> void
  destination.value = source
  if recurse:
    write(~destination.next, source, recurse)
`);
    const recursive = Array.from(result.borrowing.callables.values()).find(
      (contract) =>
        contract.transfers?.some(
          (transfer) =>
            transfer.sourceParameter === 1 &&
            transfer.destinationParameter === 0 &&
            transfer.conservative,
        ),
    );

    expect(recursive).toBeDefined();
  });

  it("drops shared return guarantees instead of widening them", () => {
    const indexedOrigins = Array.from({ length: 33 }, (_entry, index) => ({
      source: [{ kind: "index" as const, constant: index, stable: true }],
      result: [],
    }));
    const deepOrigin = {
      source: Array.from({ length: 9 }, (_entry, index) => ({
        kind: "field" as const,
        name: `level_${index}`,
      })),
      result: [],
    };

    expect(normalizeReturnedSharedOrigins(indexedOrigins)).toBeUndefined();
    expect(normalizeReturnedSharedOrigins([deepOrigin])).toBeUndefined();
  });

  it("carries conditional break environments into returned origins", () => {
    const source = `${prelude}
fn choose(first: Box, second: Box, use_second: bool) -> Box
  var result = first
  while true:
    if use_second:
      result = second
      break
    else:
      break
  result

fn invalid(first: Box, ~second: Box, use_second: bool) -> i32
  let selected = choose(first, second, use_second)
  mutate(~second)
  selected.value
`;
    expect(diagnosticCodes(source)).toContain("TY0048");
  });

  it("carries mixed break and continue environments through loops", () => {
    expect(
      diagnosticCodes(`${prelude}
fn choose(first: Box, second: Box, active: bool, stop: bool) -> Box
  var result = first
  while active:
    result = second
    if stop:
      break
    else:
      continue
  result

fn invalid(first: Box, ~second: Box, active: bool, stop: bool) -> i32
  let selected = choose(first, second, active, stop)
  mutate(~second)
  selected.value
`),
    ).toContain("TY0048");
  });

  it("rejects returning a mutable borrow", () => {
    expect(
      diagnosticCodes(`${prelude}
fn escape(~value: Box) -> Box
  value
`),
    ).toContain("TY0049");
  });

  it("rejects storing a mutable borrow in caller-owned state", () => {
    expect(
      diagnosticCodes(`${prelude}
obj Holder { value: Box }

fn invalid(~value: Box, ~holder: Holder) -> void
  holder.value = value
`),
    ).toContain("TY0049");
  });

  it("rejects capturing a mutable parameter", () => {
    expect(
      diagnosticCodes(`${prelude}
fn invalid(~value: Box) -> (fn() : () -> i32)
  () => value.value
`),
    ).toContain("TY0049");
  });

  it("rejects mutable captures escaping through implicit returns", () => {
    expect(
      diagnosticCodes(`${prelude}
type Callback = fn() : () -> i32

fn make() -> Callback
  let ~value = Box { value: 0 }
  () =>
    value.value = value.value + 1
    value.value
`),
    ).toContain("TY0049");
  });

  it("rejects mutable scalar captures without other outer mutations", () => {
    expect(
      diagnosticCodes(`
type Callback = fn() : () -> i32

fn make() -> Callback
  var value = 0
  () =>
    value = value + 1
    value
`),
    ).toContain("TY0049");
  });

  it("rejects mutable captures retained by callback intrinsics", () => {
    expect(
      diagnosticCodes(`${prelude}
@intrinsic(name: "__render_retain_callback", uses_signature: true)
fn retain_callback(handler: fn() -> i32) -> i32
  0

fn invalid() -> void
  let ~box = Box { value: 0 }
  let callback = () => box.value
  let _ = retain_callback(callback)
  mutate(~box)
`),
    ).toContain("TY0049");
  });

  it("propagates retained callbacks through public wrappers", () => {
    expect(
      diagnosticCodes(`${prelude}
@intrinsic(name: "__retain_callback", uses_signature: true)
fn retain_callback_id(handler: fn() -> i32) -> i32
  0

pub fn retain_callback(handler: fn() -> i32) -> i32
  retain_callback_id(handler)

fn invalid() -> void
  let ~box = Box { value: 0 }
  let callback = () => box.value
  let _ = retain_callback(callback)
  mutate(~box)
`),
    ).toContain("TY0049");
  });

  it.each(["__task_spawn", "__task_detach"])(
    "rejects mutable captures retained by %s",
    (intrinsicName) => {
      expect(
        diagnosticCodes(`${prelude}
@intrinsic(name: "${intrinsicName}", uses_signature: true)
fn retain_work(work: fn() -> i32) -> i32
  0

fn invalid() -> void
  let ~box = Box { value: 0 }
  let work = () => box.value
  let _ = retain_work(work)
  mutate(~box)
`),
      ).toContain("TY0049");
    },
  );

  it("propagates task retention through spawn wrappers", () => {
    expect(
      diagnosticCodes(`${prelude}
@intrinsic(name: "__task_spawn", uses_signature: true)
fn spawn_id(work: fn() : (open) -> i32): (open) -> i32
  __task_spawn(work)

pub fn spawn(work: fn() : (open) -> i32): (open) -> i32
  spawn_id(work)

fn invalid(): (open) -> void
  let ~box = Box { value: 0 }
  let work = () => box.value
  let _ = spawn(work)
  mutate(~box)
`),
    ).toContain("TY0049");
  });

  it("propagates task retention through generic spawn wrappers", () => {
    expect(
      diagnosticCodes(`${prelude}
@intrinsic(name: "__task_spawn", uses_signature: true)
fn spawn_id<T>(work: fn() : (open) -> T): (open) -> i32
  __task_spawn(work)

pub fn spawn<T>(work: fn() : (open) -> T): (open) -> i32
  spawn_id(work)

fn invalid(): (open) -> void
  let ~box = Box { value: 0 }
  let work = () => box.value
  let _ = spawn(work)
  mutate(~box)
`),
    ).toContain("TY0049");
  });

  it("rejects mutable captures in aggregates returned implicitly", () => {
    expect(
      diagnosticCodes(`${prelude}
type Callback = fn() : () -> i32
obj CallbackResult {
  callback: Callback,
  count: i32
}

fn make() -> CallbackResult
  let ~value = Box { value: 0 }
  let callback = () =>
    value.value = value.value + 1
    value.value
  CallbackResult {
    callback,
    count: 1
  }
`),
    ).toContain("TY0049");
  });

  it("preserves mutable capture escapes through returned call arguments", () => {
    const source = `${prelude}
type Callback = fn() : () -> i32

fn identity(callback: Callback) -> Callback
  callback

fn make_implicit() -> Callback
  let ~value = Box { value: 0 }
  let callback = () =>
    value.value = value.value + 1
    value.value
  identity(callback)

fn make_explicit() -> Callback
  let ~value = Box { value: 0 }
  let callback = () =>
    value.value = value.value + 1
    value.value
  return identity(callback)
`;

    expect(
      diagnosticsFor(source).filter(
        (diagnostic) => diagnostic.code === "TY0049",
      ),
    ).toHaveLength(2);
  });

  it("does not escape unrelated projections from returned wrappers", () => {
    expect(() =>
      analyze(`${prelude}
type Callback = fn() : () -> i32
obj CallbackResult {
  callback: Callback,
  count: i32
}

fn wrap(callback: Callback) -> CallbackResult
  CallbackResult { callback, count: 1 }

fn valid() -> i32
  let ~value = Box { value: 0 }
  let callback = () =>
    value.value = value.value + 1
    value.value
  wrap(callback).count
`),
    ).not.toThrow();
  });

  it("tracks mutable capture escapes through returned effect handlers", () => {
    expect(
      diagnosticCodes(`${prelude}
type Callback = fn() : () -> i32

fn identity({ callback: Callback }) -> Callback
  callback

eff Flag
  get(resume) -> bool

fn make() -> Callback
  let ~value = Box { value: 0 }
  identity(callback:
    try
      if Flag::get() then:
        () =>
          value.value = value.value + 1
          value.value
      else:
        () => 0
    Flag::get(resume):
      resume(true)
  )
`),
    ).toContain("TY0049");
  });

  it("keeps shared captures borrowed through the closure's last use", () => {
    expect(
      diagnosticCodes(`${prelude}
fn invalid(~value: Box) -> i32
  let alias = value
  let read_alias = () => alias.value
  mutate(~value)
  read_alias()
`),
    ).toContain("TY0048");
  });

  it("ends a shared capture after a local closure's last use", () => {
    expect(() =>
      analyze(`${prelude}
fn valid(~value: Box) -> i32
  let alias = value
  let read_alias = () => alias.value
  let before = read_alias()
  mutate(~value)
  before + value.value
`),
    ).not.toThrow();
  });

  it("downgrades a root captured by an escaping closure", () => {
    expect(
      diagnosticCodes(`${prelude}
type Callback = fn() : () -> i32
obj CallbackHolder {
  callback: Callback
}

fn invalid(~value: Box, ~holder: CallbackHolder) -> void
  let alias = value
  let read_alias = () => alias.value
  holder.callback = read_alias
  mutate(~value)
`),
    ).toContain("TY0051");
  });

  it("tracks captures in inline callback arguments", () => {
    expect(
      diagnosticCodes(`${prelude}
fn invoke(read_value: fn() : () -> i32, ~value: Box) -> i32
  value.value = 2
  read_value()

fn invalid() -> i32
  let ~value = Box { value: 1 }
  invoke(() => value.value, ~value)
`),
    ).toContain("TY0048");
  });

  it("rejects unique roots captured by inline closures stored in fields", () => {
    expect(
      diagnosticCodes(`${prelude}
type Callback = fn() : () -> i32
obj CallbackHolder {
  callback: Callback
}

fn invalid(~holder: CallbackHolder) -> void
  let ~value = Box { value: 1 }
  holder.callback = () => value.value
  mutate(~value)
`),
    ).toContain("TY0049");
  });

  it("does not propagate terminated branch state or validate unreachable code", () => {
    expect(() =>
      analyze(`${prelude}
obj Holder { value: Box }

fn retain(~holder: Holder, value: Box) -> void
  holder.value = value

fn valid(other: Box, ~holder: Holder, stop: bool) -> i32
  var value = Box { value: 1 }
  var alias = other
  if stop:
    alias = value
    retain(~holder, value)
    return 0
  mutate(~value)
  let result = alias.value
  return result
  mutate(~value)
  0
`),
    ).not.toThrow();
  });

  it("does not carry conditional break paths through the loop body", () => {
    expect(() =>
      analyze(`${prelude}
obj Holder { value: Box }

fn retain(~holder: Holder, value: Box) -> void
  holder.value = value

fn valid(~holder: Holder, stop: bool) -> i32
  var value = Box { value: 1 }
  while true:
    if stop:
      retain(~holder, value)
      break
    mutate(~value)
    break
  value.value
`),
    ).not.toThrow();
  });

  it("carries aliases assigned before continue to the next iteration", () => {
    expect(
      diagnosticCodes(`${prelude}
fn invalid(other: Box, ~value: Box, running: bool) -> i32
  var alias = other
  var first = true
  while running:
    if first:
      alias = value
      first = false
      continue
    mutate(~value)
    break
  alias.value
`),
    ).toContain("TY0048");
  });

  it("carries aliases assigned at the end of a loop to its next iteration", () => {
    expect(
      diagnosticCodes(`${prelude}
fn invalid(other: Box, ~value: Box, running: bool) -> i32
  var alias = other
  while running:
    mutate(~value)
    alias = value
  alias.value
`),
    ).toContain("TY0048");
  });

  it("tracks loop-carried aliases used before their definition", () => {
    expect(
      diagnosticCodes(`${prelude}
fn invalid(other: Box, ~value: Box, running: bool) -> void
  var alias = other
  while running:
    mutate(~value)
    let observed = alias.value
    alias = value
`),
    ).toContain("TY0048");
  });

  it("kills loop-carried aliases at definite reassignments", () => {
    expect(() =>
      analyze(`${prelude}
fn valid(other: Box, ~value: Box, running: bool) -> void
  var alias = other
  while running:
    alias = other
    mutate(~value)
    alias = value
    alias = other
  let observed = alias.value
`),
    ).not.toThrow();
  });

  it("does not retain mutable capability after shared reassignment", () => {
    expect(
      diagnosticCodes(`${prelude}
fn invalid(~owned: Box, shared: Box) -> void
  owned = shared
  mutate(~owned)
`),
    ).toContain("TY0050");

    expect(
      diagnosticCodes(`${prelude}
fn invalid(~owned: Box, shared: Box) -> void
  owned = shared
  owned.value = 2
`),
    ).toContain("TY0050");
  });

  it("ends an old borrow when an alias is rebound to fresh storage", () => {
    expect(() =>
      analyze(`${prelude}
fn valid(~value: Box) -> i32
  var alias = value
  alias = Box { value: 2 }
  mutate(~value)
  alias.value
`),
    ).not.toThrow();
  });

  it("keeps mutable capability for fresh aggregates with reference fields", () => {
    expect(() =>
      analyze(`${prelude}
fn mutate_pair(~pair: Pair) -> void
  pair.left = Box { value: 3 }

fn valid() -> i32
  let ~pair = Pair {
    left: Box { value: 1 },
    right: Box { value: 2 }
  }
  mutate_pair(~pair)
  pair.left.value
`),
    ).not.toThrow();
  });

  it("rejects projected references escaping mutable parameters", () => {
    expect(
      diagnosticCodes(`${prelude}
fn invalid(~pair: Pair) -> Box
  pair.left
`),
    ).toContain("TY0049");
  });

  it("propagates source invalidation through later-defined helpers", () => {
    expect(() =>
      analyze(`
obj Box { value: i32 }
obj BoxArray { storage: FixedArray<Box> }

fn valid(~values: BoxArray) -> FixedArray<Box>
  let removed = __array_new<Box>(1)
  __array_copy(removed, {
    from: values.storage,
    to_index: 0,
    from_index: 0,
    count: 1
  })
  replace_storage(~values, __array_new<Box>(0))
  removed

fn replace_storage(~values: BoxArray, storage: FixedArray<Box>) -> void
  values.storage = storage
`),
    ).not.toThrow();
  });

  it("tracks source invalidation through mutable reborrows", () => {
    expect(() =>
      analyze(`
obj Box { value: i32 }
obj BoxArray { storage: FixedArray<Box> }

fn valid(~values: BoxArray) -> FixedArray<Box>
  let removed = __array_new<Box>(1)
  __array_copy(removed, {
    from: values.storage,
    to_index: 0,
    from_index: 0,
    count: 1
  })
  replace_storage(~values, __array_new<Box>(0))
  removed

fn replace_storage(~values: BoxArray, storage: FixedArray<Box>) -> void
  let ~alias = values
  alias.storage = storage
`),
    ).not.toThrow();
  });

  it("preserves mutable capability through nested aggregate reborrows", () => {
    expect(() =>
      analyze(`
obj Box { value: i32 }
obj BoxArray { storage: FixedArray<Box>, count: i32 }

fn valid(~values: BoxArray) -> void
  let ~alias = values
  if true:
    let ~nested = alias
    nested.count = 0
`),
    ).not.toThrow();
  });

  it("preserves same-root provenance written through helpers", () => {
    expect(
      diagnosticCodes(`${prelude}
fn invalid(~pair: Pair) -> Box
  replace_left_with_right(~pair)
  pair.left

fn replace_left_with_right(~pair: Pair) -> void
  pair.left = pair.right
`),
    ).toContain("TY0049");
  });

  it("downgrades copied same-root projections at helper call sites", () => {
    expect(
      diagnosticCodes(`${prelude}
fn invalid(~pair: Pair) -> i32
  replace_left_with_right(~pair)
  mutate(~pair.right)
  pair.left.value

fn replace_left_with_right(~pair: Pair) -> void
  pair.left = pair.right
`),
    ).toContain("TY0051");
  });

  it("updates physical-place provenance after mutable-reference rebinding", () => {
    expect(
      diagnosticCodes(`${prelude}
fn invalid(~pair: Pair, ~other: Pair) -> Box
  let moved = pair.left
  pair = other
  pair.left = Box { value: 2 }
  moved
`),
    ).toContain("TY0049");
  });

  it("rejects a mutable borrow across an effect operation", () => {
    expect(
      diagnosticCodes(`${prelude}
eff Async
  wait(resume) -> void

fn invalid(~value: Box): Async -> void
  Async::wait()
  mutate(~value)
`),
    ).toContain("TY0052");
  });

  it("allows mutable borrows across pure trait dispatch", () => {
    expect(() =>
      analyze(`${prelude}
trait Mutator
  fn update(self, { ~left: Box, ~right: Box }) -> void

obj ConcreteMutator {}

impl Mutator for ConcreteMutator
  fn update(self, { ~left: Box, ~right: Box }) -> void
    mutate(~left)
    mutate(~right)

fn valid(mutator: Mutator, ~left: Box, ~right: Box) -> i32
  mutator.update({ left, right })
  left.value + right.value
`),
    ).not.toThrow();
  });

  it("conservatively retains references passed to effect operations", () => {
    expect(
      diagnosticCodes(`${prelude}
eff Async
  hold(resume, value: Box) -> void

fn invalid(): Async -> void
  var value = Box { value: 0 }
  Async::hold(value)
  mutate(~value)
`),
    ).toContain("TY0051");
  });

  it("rejects borrowed values returned from SharedCell callbacks", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

impl SharedCell<T>
  fn with<R>(self, body: fn(T) : () -> R) -> R
    body(self.value)

fn invalid(cell: SharedCell<Box>) -> Box
  cell.with((value) => value)
`),
    ).toContain("TY0053");
  });

  it("rejects arrays copied from SharedCell callback values", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj BoxArray { storage: FixedArray<Box> }

fn copied(self: BoxArray) -> BoxArray
  let destination = __array_new<Box>(1)
  __array_copy(destination, {
    from: self.storage,
    to_index: 0,
    from_index: 0,
    count: 1
  })
  BoxArray { storage: destination }

@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

impl SharedCell<T>
  fn with<R>(self, body: fn(T) : () -> R) -> R
    body(self.value)

fn invalid(cell: SharedCell<BoxArray>) -> BoxArray
  cell.with((values) => copied(values))
`),
    ).toContain("TY0053");
  });

  it("rejects directly returned array copies from SharedCell callback values", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj BoxArray { storage: FixedArray<Box> }

fn copied(self: BoxArray) -> FixedArray<Box>
  let destination = __array_new<Box>(1)
  __array_copy(destination, {
    from: self.storage,
    to_index: 0,
    from_index: 0,
    count: 1
  })

@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

impl SharedCell<T>
  fn with<R>(self, body: fn(T) : () -> R) -> R
    body(self.value)

fn invalid(cell: SharedCell<BoxArray>) -> FixedArray<Box>
  cell.with((values) => copied(values))
`),
    ).toContain("TY0053");
  });

  it("rejects array elements returned from SharedCell callback values", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj BoxArray { storage: FixedArray<Box> }

@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

impl SharedCell<T>
  fn with<R>(self, body: fn(T) : () -> R) -> R
    body(self.value)

fn invalid(cell: SharedCell<BoxArray>) -> Box
  cell.with((values) => __array_get(values.storage, 0))
`),
    ).toContain("TY0053");
  });

  it("allows scalar values returned from SharedCell callbacks", () => {
    expect(() =>
      analyze(`
@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

impl SharedCell<T>
  fn with<R>(self, body: fn(T) : () -> R) -> R
    body(self.value)

fn valid(cell: SharedCell<i32>) -> i32
  cell.with((value) => value)
`),
    ).not.toThrow();
  });

  it("allows scalar values captured by callbacks returned from SharedCell", () => {
    expect(() =>
      analyze(`
@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

impl SharedCell<T>
  fn with<R>(self, body: fn(T) : () -> R) -> R
    body(self.value)

fn valid(cell: SharedCell<i32>) -> (fn() : () -> i32)
  cell.with((value) => () => value)
`),
    ).not.toThrow();
  });

  it("rejects mutable upgrades from shared array elements", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }

fn invalid(values: FixedArray<Box>) -> void
  let ~value = __array_get(values, 0)
  value.value = 1
`),
    ).toContain("TY0050");
  });

  it("rejects array elements retained from SharedCell callback values", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj BoxArray { storage: FixedArray<Box> }

@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

impl SharedCell<T>
  fn with<R>(self, body: fn(T) : () -> R) -> R
    body(self.value)

fn invalid(
  cell: SharedCell<BoxArray>,
  retain: fn(Box) : () -> void
) -> void
  cell.with((values) => retain(__array_get(values.storage, 0)))
`),
    ).toContain("TY0053");
  });

  it("preserves array-copy loans through recursive helpers", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj BoxArray { storage: FixedArray<Box> }

fn copied(self: BoxArray, depth: i32) -> BoxArray
  let destination = __array_new<Box>(1)
  __array_copy(destination, {
    from: self.storage,
    to_index: 0,
    from_index: 0,
    count: 1
  })
  let result = BoxArray { storage: destination }
  if depth <= 0:
    return result
  copied(result, depth - 1)

@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

impl SharedCell<T>
  fn with<R>(self, body: fn(T) : () -> R) -> R
    body(self.value)

fn invalid(cell: SharedCell<BoxArray>) -> BoxArray
  cell.with((values) => copied(values, 12))
`),
    ).toContain("TY0053");
  });

  it("tracks array copies into nested destination storage", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj BoxArray { storage: FixedArray<Box> }

fn copied(self: BoxArray) -> BoxArray
  let result = BoxArray { storage: __array_new<Box>(1) }
  __array_copy(result.storage, {
    from: self.storage,
    to_index: 0,
    from_index: 0,
    count: 1
  })
  result

@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

impl SharedCell<T>
  fn with<R>(self, body: fn(T) : () -> R) -> R
    body(self.value)

fn invalid(cell: SharedCell<BoxArray>) -> BoxArray
  cell.with((values) => copied(values))
`),
    ).toContain("TY0053");
  });

  it("allows copied elements to move out through mutable container APIs", () => {
    expect(() =>
      analyze(`
obj Box { value: i32 }
obj BoxArray { storage: FixedArray<Box> }

fn remove_all(~self: BoxArray) -> BoxArray
  let removed = __array_new<Box>(1)
  __array_copy(removed, {
    from: self.storage,
    to_index: 0,
    from_index: 0,
    count: 1
  })
  self.storage = __array_new<Box>(0)
  BoxArray { storage: removed }
`),
    ).not.toThrow();
  });

  it("keeps copied aggregate results shared after container replacement", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj BoxArray { storage: FixedArray<Box> }

fn take_all(~self: BoxArray) -> BoxArray
  let removed = __array_new<Box>(1)
  __array_copy(removed, {
    from: self.storage,
    to_index: 0,
    from_index: 0,
    count: 1
  })
  self.storage = __array_new<Box>(0)
  BoxArray { storage: removed }

fn invalid(~self: BoxArray) -> i32
  let ~removed = take_all(~self)
  clear(~removed)
  0

fn clear(~value: BoxArray) -> void
  value.storage = __array_new<Box>(0)
`),
    ).toContain("TY0050");
  });

  it("does not detach a return origin invalidated on only one branch", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj BoxArray { storage: FixedArray<Box> }

fn maybe_take(~self: BoxArray, detach: bool) -> BoxArray
  if detach:
    let removed = __array_new<Box>(1)
    __array_copy(removed, {
      from: self.storage,
      to_index: 0,
      from_index: 0,
      count: 1
    })
    self.storage = __array_new<Box>(0)
    return BoxArray { storage: removed }
  BoxArray { storage: self.storage }
`),
    ).toContain("TY0049");
  });

  it("retracts shared return guarantees after forward callees converge", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj BoxArray { storage: FixedArray<Box> }

fn detached(~self: BoxArray) -> BoxArray
  let removed = __array_new<Box>(1)
  __array_copy(removed, {
    from: self.storage,
    to_index: 0,
    from_index: 0,
    count: 1
  })
  self.storage = __array_new<Box>(0)
  BoxArray { storage: removed }

fn maybe_detached(~self: BoxArray, detach: bool) -> BoxArray
  if detach:
    detached(~self)
  else:
    live(self)

fn live(self: BoxArray) -> BoxArray
  BoxArray { storage: self.storage }
`),
    ).toContain("TY0049");
  });

  it("propagates scoped callback loans through higher-order wrappers", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

impl SharedCell<T>
  fn with<R>(self, body: fn(T) : () -> R) -> R
    body(self.value)

fn apply(cell: SharedCell<Box>, body: fn(Box) : () -> Box) -> Box
  cell.with(body)

fn invalid(cell: SharedCell<Box>) -> Box
  apply(cell, (value) => value)
`),
    ).toContain("TY0053");
  });

  it("rejects borrowed values returned through local callback aliases", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

impl SharedCell<T>
  fn with<R>(self, body: fn(T) : () -> R) -> R
    body(self.value)

fn invalid(cell: SharedCell<Box>) -> Box
  let callback: fn(Box) : () -> Box =
    (value: Box) -> Box => value
  cell.with(callback)
`),
    ).toContain("TY0053");
  });

  it("rejects opaque callbacks that may retain SharedCell values", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

impl SharedCell<T>
  fn with<R>(self, body: fn(T) : () -> R) -> R
    body(self.value)

fn invalid(
  cell: SharedCell<Box>,
  callback: fn(Box) : () -> void
) -> void
  cell.with((value) => callback(value))
`),
    ).toContain("TY0053");
  });

  it("rejects borrowed values returned through callable fields", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
type Callback = fn(Box) : () -> Box
obj Callbacks {
  body: Callback
}
@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

impl SharedCell<T>
  fn with<R>(self, body: fn(T) : () -> R) -> R
    body(self.value)

fn invalid(cell: SharedCell<Box>) -> Box
  let callbacks = Callbacks {
    body: (value) => value
  }
  cell.with(callbacks.body)
`),
    ).toContain("TY0053");
  });

  it("propagates callable-field loans through wrappers", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
type Callback = fn(Box) : () -> Box
obj Callbacks {
  body: Callback
}
@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

impl SharedCell<T>
  fn with<R>(self, body: fn(T) : () -> R) -> R
    body(self.value)

fn apply(cell: SharedCell<Box>, callbacks: Callbacks) -> Box
  cell.with(callbacks.body)

fn invalid(cell: SharedCell<Box>) -> Box
  let callbacks = Callbacks {
    body: (value) => value
  }
  apply(cell, callbacks)
`),
    ).toContain("TY0053");
  });

  it("propagates returned callable-field paths through wrappers", () => {
    expect(() =>
      analyze(`
obj Box { value: i32 }
type Callback = fn(Box) : () -> i32
obj Callbacks {
  body: Callback
}
@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

impl SharedCell<T>
  fn with<R>(self, body: fn(T) : () -> R) -> R
    body(self.value)

fn callback_of(callbacks: Callbacks) -> Callback
  callbacks.body

fn apply(cell: SharedCell<Box>, callbacks: Callbacks) -> i32
  cell.with(callback_of(callbacks))

fn valid(cell: SharedCell<Box>) -> i32
  let callbacks = Callbacks {
    body: (value) => value.value
  }
  apply(cell, callbacks)
`),
    ).not.toThrow();
  });

  it("rejects borrowed projections returned from SharedCell callbacks", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj Wrapper { inner: Box }
@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

impl SharedCell<T>
  fn with<R>(self, body: fn(T) : () -> R) -> R
    body(self.value)

fn invalid(cell: SharedCell<Wrapper>) -> Box
  cell.with((value) => value.inner)
`),
    ).toContain("TY0053");
  });

  it("rejects SharedCell callback captures of the borrowed value", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

impl SharedCell<T>
  fn with<R>(self, body: fn(T) : () -> R) -> R
    body(self.value)

fn invalid(cell: SharedCell<Box>) -> (fn() : () -> i32)
  cell.with((value) => () => value.value)
`),
    ).toContain("TY0053");
  });

  it("rejects storing a SharedCell callback value", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj Holder { value: Box }
@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

impl SharedCell<T>
  fn with<R>(self, body: fn(T) : () -> R) -> R
    body(self.value)

fn invalid(cell: SharedCell<Box>, ~holder: Holder) -> void
  cell.with((value) =>
    holder.value = value
  )
`),
    ).toContain("TY0053");
  });

  it("rejects effectful SharedCell callbacks", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

impl SharedCell<T>
  fn with<R>(self, body: fn(T) : () -> R) -> R
    body(self.value)

eff Async
  wait(resume) -> void

fn invalid(cell: SharedCell<Box>): Async -> i32
  cell.with((value) =>
    Async::wait()
    value.value
  )
`).length,
    ).toBeGreaterThan(0);
  });

  it("allows SharedCell callbacks to return owned values", () => {
    expect(() =>
      analyze(`
obj Box { value: i32 }
@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

impl SharedCell<T>
  fn with<R>(self, body: fn(T) : () -> R) -> R
    body(self.value)

fn valid(cell: SharedCell<Box>) -> i32
  cell.with((value) => value.value)
`),
    ).not.toThrow();
  });
});
