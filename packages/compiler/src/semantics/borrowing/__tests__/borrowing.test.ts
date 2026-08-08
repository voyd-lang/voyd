import { describe, expect, it } from "vitest";
import { resolve, sep } from "node:path";
import { DiagnosticError } from "../../../diagnostics/index.js";
import { createMemoryModuleHost } from "../../../modules/memory-host.js";
import { createNodePathAdapter } from "../../../modules/node-path-adapter.js";
import { analyzeModules, loadModuleGraph } from "../../../pipeline.js";
import { parse } from "../../../parser/index.js";
import { walkExpression } from "../../hir/index.js";
import {
  createBorrowingDependencyProjectionCache,
  projectBorrowingDependencies,
  selectBorrowingDependencySemantics,
  semanticsPipeline,
  snapshotBorrowingDependencyProjectionCacheStats,
} from "../../pipeline.js";
import { buildProgramCodegenView } from "../../codegen-view/index.js";
import {
  mergeCallableBorrowContracts,
  normalizeCallableBorrowTransfers,
  projectionPathCovers,
  projectionPathsOverlap,
} from "../model.js";
import { normalizeReturnedSharedOrigins } from "../summaries.js";
import { borrowedTypeEntriesInType } from "../borrowed-types.js";
import { abstractTraitContractFromImplementation } from "../call-resolution.js";
import { createCallableBorrowSummary } from "../callable-summary.js";
import {
  stableBorrowCallInput,
  type CallableBorrowCallFact,
} from "../callable-facts.js";

const analyze = (source: string) => {
  const filePath = "borrowing.test.voyd";
  const ast = parse(source, filePath);
  if (
    !source.includes('@intrinsic_type(type: "voyd.std.shared-cell")') &&
    !source.includes("__array_set(") &&
    !source.includes("__array_copy(") &&
    !source.includes("__array_get(") &&
    !source.includes("__array_new_fixed(") &&
    !source.includes("__array_len(") &&
    !source.includes("__ref_is_null(") &&
    !source.includes("__retain_callback") &&
    !source.includes("__boundary_retain_callback") &&
    !source.includes("__render_retain_callback") &&
    !source.includes("__task_spawn") &&
    !source.includes("__task_detach") &&
    !source.includes("__boundary_value_to_msgpack") &&
    !source.includes("__boundary_msgpack_to_value")
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

const summaryDemandFor = (result: ReturnType<typeof analyze>) =>
  result.borrowing.summaryDemand!;

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

const capabilityFor = (
  result: ReturnType<typeof analyze> | ReturnType<typeof analyzeWithRecovery>,
  name: string,
) => {
  const symbol = result.symbols.resolveTopLevel(name);
  expect(typeof symbol).toBe("number");
  return typeof symbol === "number"
    ? result.borrowing.capabilities.get(symbol)
    : undefined;
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

const namedContractPrelude = `
obj Item { value: i32 }
obj ViewState { cursor: i32, source: Item }

trait ItemView
  region cursor
  region source
  disjoint cursor, source

  @borrow_contract(
    mutates: cursor,
    returns_from: source
  )
  fn next(~self) -> borrow Item
`;

describe("borrow checking", () => {
  it("materializes full facts only for flow-sensitive callables", () => {
    const result = analyze(`
obj Box { value: i32 }

fn square(value: i32) -> i32
  value * value

fn identity(value: Box) -> Box
  value

fn fresh_local(~value: Box) -> i32
  let ~out = Box { value: 0 }
  out.value = value.value
  square(out.value)
`);

    expect(capabilityFor(result, "square")).toBe("none");
    expect(capabilityFor(result, "identity")).toBe("flow-sensitive");
    expect(capabilityFor(result, "fresh_local")).toBe("transient");
    expect(result.borrowing.analysisMetrics).toMatchObject({
      fullFactsMaterialized: 1,
    });
    expect(result.borrowing.analysisMetrics?.fullFactSymbols).toHaveLength(1);
  });

  it("routes symbolic open dispatch through the flow-sensitive path", () => {
    const result = analyze(`
obj Box<T> { value: T }

impl<T> Box<T>
  fn update(~self, value: T) -> void
    self.value = value
  fn relay(~self, value: T) -> void
    self.update(value)
`);
    const useFunction = Array.from(result.hir.items.values()).find(
      (item) =>
        item.kind === "function" &&
        result.binding.symbolTable.getSymbol(item.symbol).name === "relay",
    );
    expect(useFunction).toBeDefined();
    const callIds: number[] = [];
    if (useFunction?.kind === "function") {
      walkExpression({
        exprId: useFunction.body,
        hir: result.hir,
        onEnterExpression: (exprId, expression) => {
          if (expression.exprKind === "method-call") callIds.push(exprId);
        },
      });
    }
    const callId = callIds[0];
    expect(callId).toBeDefined();
    if (callId !== undefined) {
      expect(result.typing.callTraitDispatches.has(callId)).toBe(false);
      expect(result.typing.callTargets.has(callId)).toBe(false);
      expect(result.typing.borrowCallTargets.has(callId)).toBe(true);
    }
    expect(
      useFunction?.kind !== "function"
        ? undefined
        : result.borrowing.capabilities.get(useFunction.symbol),
    ).toBe("flow-sensitive");
  });

  it("routes trait dispatch from its authoritative declaration contract", () => {
    const result = analyze(`
obj Item { value: i32 }
obj ItemView { source: Item }

trait Inspect
  region source

  @borrow_contract(reads: source)
  fn read(self) -> i32

impl Inspect for ItemView
  region source = deref(self.source)

  fn read(self) -> i32
    self.source.value

fn inspect(value: Inspect) -> i32
  value.read()
`);

    expect(
      result.borrowing.diagnostics.map((diagnostic) => diagnostic.code),
    ).toEqual([]);
    expect(capabilityFor(result, "inspect")).toBe("transient");
  });

  it("routes capability modes from compact behavior and escaping use", () => {
    const source = `
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None
obj Box { value: i32 }
obj Snapshot { count: i32, owned: Box }

fn mutate(~value: Box) -> void
  value.value = value.value + 1

fn square(value: i32) -> i32
  value * value

fn generic_identity<T>(value: T) -> T
  value

fn fresh_local(~value: Box) -> void
  let ~out = Box { value: 0 }
  out.value = value.value

fn next(~self: Box) -> Option<Box>
  Some<Box> { value: Box { value: 1 } }

fn next_snapshot(~self: Box, count: i32) -> Snapshot
  Snapshot { count, owned: Box { value: self.value } }

fn fresh_after_flow(~value: Box) -> Box
  let ~out = Box { value: value.value }
  let loan: borrow Box = out
  Box { value: loan.value }

fn relay_fresh_after_flow(~value: Box) -> Box
  fresh_after_flow(~value)

fn returned_borrow(value: Box) -> Option<borrow Box>
  Some<borrow Box> { value }

fn sequential(~value: Box) -> void
  mutate(~value)
  mutate(~value)

fn branch_local(~value: Box, condition: bool) -> void
  if condition:
    mutate(~value)
  else:
    mutate(~value)

fn borrowed_live(~value: Box) -> i32
  let loan: borrow Box = value
  square(1) + loan.value

fn ignore_flow_result(value: Box) -> void
  let _ = returned_borrow(value)

fn flow_owned(value: Box) -> Box
  let ~out = Box { value: value.value }
  let loan: borrow Box = out
  value

fn ignore_flow_owned(value: Box) -> void
  let _ = flow_owned(value)

`;
    const result = analyze(source);

    expect(capabilityFor(result, "square")).toBe("none");
    expect(capabilityFor(result, "generic_identity")).toBe("flow-sensitive");
    expect(capabilityFor(result, "fresh_local")).toBe("transient");
    expect(capabilityFor(result, "next")).toBe("transient");
    expect(capabilityFor(result, "next_snapshot")).toBe("transient");
    expect(capabilityFor(result, "fresh_after_flow")).toBe("flow-sensitive");
    expect(capabilityFor(result, "relay_fresh_after_flow")).toBe("transient");
    expect(capabilityFor(result, "returned_borrow")).toBe("flow-sensitive");
    expect(capabilityFor(result, "sequential")).toBe("transient");
    expect(capabilityFor(result, "branch_local")).toBe("transient");
    expect(capabilityFor(result, "borrowed_live")).toBe("flow-sensitive");
    expect(capabilityFor(result, "ignore_flow_result")).not.toBe(
      "flow-sensitive",
    );
    expect(capabilityFor(result, "flow_owned")).toBe("flow-sensitive");
    expect(capabilityFor(result, "ignore_flow_owned")).not.toBe(
      "flow-sensitive",
    );
    expect(
      diagnosticCodes(`
obj Box { value: i32 }

fn overlap(~left: Box, ~right: Box) -> void
  left.value = left.value + 1
  right.value = right.value + 1

fn overlap_caller(~value: Box) -> void
  overlap(~value, ~value)
`),
    ).toContain("TY0048");
    const overlapResult = analyzeWithRecovery(`
obj Box { value: i32 }

fn overlap(~left: Box, ~right: Box) -> void
  left.value = left.value + 1
  right.value = right.value + 1

fn overlap_caller(~value: Box) -> void
  overlap(~value, ~value)
`);
    expect(capabilityFor(overlapResult, "overlap_caller")).toBe("transient");
  });

  it("routes nested aliases inside fresh roots through full facts", () => {
    const source = `
obj Box { value: i32 }
obj Holder { box: Box }

fn mutate_holder(~holder: Holder) -> void
  holder.box.value = holder.box.value + 1

fn mutate_both(~left: Box, ~right: Box) -> void
  left.value = left.value + 1
  right.value = right.value + 1

fn via_fresh(~shared: Box) -> void
  let ~holder = Holder { box: shared }
  mutate_holder(~holder)

fn conflict(~shared: Box) -> void
  let ~holder = Holder { box: shared }
  mutate_both(~holder.box, ~shared)
`;
    const result = analyzeWithRecovery(source);

    expect(capabilityFor(result, "via_fresh")).toBe("flow-sensitive");
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "TY0048",
    );
  });

  it("publishes owned aggregate projections before capability routing", () => {
    const result = analyze(`
obj Box { value: i32 }
val Pair { left: Box, right: Box }

fn make_pair() -> Pair
  Pair {
    left: Box { value: 1 },
    right: Box { value: 2 }
  }

fn relay_pair() -> Pair
  let pair = make_pair()
  pair
`);
    expect(capabilityFor(result, "make_pair")).toBe("none");
    expect(capabilityFor(result, "relay_pair")).toBe("none");
    expect(result.borrowing.analysisMetrics?.fullFactsMaterialized).toBe(0);
  });

  it("keeps module aliases on the flow-sensitive provenance path", () => {
    const result = analyze(`
obj Box { value: i32 }
let stored = Box { value: 1 }

fn module_alias() -> Box
  let alias = stored
  alias
`);

    expect(capabilityFor(result, "module_alias")).toBe("flow-sensitive");
    expect(result.borrowing.analysisMetrics?.fullFactsMaterialized).toBe(1);
  });

  it("converges owned provenance through recursive wrappers", () => {
    const result = analyze(`
obj Box { value: i32 }

fn recursive_box(depth: i32) -> Box
  if depth <= 0:
    Box { value: 0 }
  else:
    recursive_box(depth - 1)

fn relay_recursive(depth: i32) -> Box
  let result = recursive_box(depth)
  result
`);

    expect(capabilityFor(result, "recursive_box")).toBe("none");
    expect(capabilityFor(result, "relay_recursive")).toBe("none");
    expect(result.borrowing.analysisMetrics?.fullFactsMaterialized).toBe(0);
  });

  it("routes projected local reference writes through full provenance", () => {
    const result = analyze(`
obj Box { value: i32 }
obj Holder { item: Box }

fn wrap(~source: Box) -> Holder
  let ~out = Holder { item: Box { value: 0 } }
  out.item = source
  out
`);
    const wrapSymbol = result.symbols.resolveTopLevel("wrap");
    const contract =
      typeof wrapSymbol === "number"
        ? result.borrowing.callables.get(wrapSymbol)
        : undefined;

    expect(capabilityFor(result, "wrap")).toBe("flow-sensitive");
    expect(contract?.parameters[0]?.returnedOrigins).toEqual([
      expect.objectContaining({
        source: [],
        result: [{ kind: "field", name: "item" }],
      }),
    ]);
    expect(result.borrowing.analysisMetrics?.fullFactsMaterialized).toBe(1);
  });

  it("preserves runtime guards through owned-result wrappers", () => {
    const result = analyze(`
obj Box { value: i32 }

fn mutate_both(~left: Box, ~right: Box) -> void
  left.value = left.value + 1
  right.value = right.value + 1

fn guarded_result(~left: Box, ~right: Box) -> Box
  mutate_both(~left, ~right)
  Box { value: left.value + right.value }

fn relay_guarded(~left: Box, ~right: Box) -> Box
  let result = guarded_result(~left, ~right)
  result
`);
    const guards = Array.from(
      result.borrowing.runtimeIdentityGuards.values(),
    ).flat();

    expect(capabilityFor(result, "guarded_result")).toBe("transient");
    expect(capabilityFor(result, "relay_guarded")).toBe("transient");
    expect(guards).toHaveLength(2);
    expect(result.borrowing.analysisMetrics?.fullFactsMaterialized).toBe(0);
  });

  it("includes argument-plan ambiguity in stable callable inputs", () => {
    const call = {
      exprId: 1,
      targets: [],
      intrinsic: false,
      intrinsicBoundary: false,
      substitutions: [],
      formsExplicitBorrow: false,
      maySuspend: false,
      contractSources: [],
    } as CallableBorrowCallFact;

    expect(stableBorrowCallInput(call)).not.toEqual(
      stableBorrowCallInput({ ...call, argumentPlanAmbiguous: true }),
    );
  });

  it("skips large private primitive helper chains during summary inference", () => {
    const helperCount = 80;
    const helpers = Array.from({ length: helperCount }, (_entry, index) =>
      index === 0
        ? `fn helper_0(value: i32) -> i32\n  value`
        : `fn helper_${index}(value: i32) -> i32\n  helper_${index - 1}(value)`,
    ).join("\n\n");
    const result = analyze(`
${helpers}

pub fn entry(value: i32) -> i32
  helper_${helperCount - 1}(value)
`);

    const demand = summaryDemandFor(result);
    expect(new Set(result.borrowing.capabilities.values())).toEqual(
      new Set(["none"]),
    );
    expect(demand.totalCallables).toBe(helperCount + 1);
    expect(demand.demandedCallables).toBeLessThanOrEqual(1);
    expect(demand.skippedTrivialCallables).toBeGreaterThanOrEqual(helperCount);
    expect(demand.evaluations).toBeLessThanOrEqual(1);
    expect(demand.worklistEdges).toBe(0);
  });

  it("routes module-storage reads through compact callable capabilities", () => {
    const result = analyze(`
obj Box { value: i32 }
let source = Box { value: 1 }

fn leaf() -> i32
  source.value

fn middle() -> i32
  leaf()

pub fn entry() -> i32
  middle()
`);
    const entry = result.symbols.resolveTopLevel("entry");

    const demand = summaryDemandFor(result);
    expect(new Set(result.borrowing.capabilities.values())).toEqual(
      new Set(["transient"]),
    );
    expect(demand.demandedCallables).toBe(0);
    expect(demand.skippedTrivialCallables).toBe(3);
    expect(demand.worklistIterations).toBe(0);
    expect(
      typeof entry === "number"
        ? result.borrowing.callables.get(entry)?.externalRead
        : undefined,
    ).toBe(true);
  });

  it("does not fabricate reads when compact wrappers only forward references", () => {
    const result = analyze(`
obj Box { value: i32 }

fn ignore(value: Box) -> i32
  0

fn wrapper(value: Box) -> i32
  ignore(value)

fn ignore_pair(value: (Box, Box)) -> i32
  0

fn pair_wrapper(left: Box, right: Box) -> i32
  ignore_pair((left, right))

val Pair { left: Box, right: Box }

fn ignore_object(value: Pair) -> i32
  0

fn object_wrapper(left: Box, right: Box) -> i32
  ignore_object(Pair { left, right })

fn conditional_wrapper(flag: bool, left: Box, right: Box) -> i32
  ignore(if flag: left else: right)
`);
    const wrapper = result.symbols.resolveTopLevel("wrapper");
    const contract =
      typeof wrapper === "number"
        ? result.borrowing.callables.get(wrapper)
        : undefined;

    expect(contract?.parameters[0]?.readPaths).toEqual([]);
    ["pair_wrapper", "object_wrapper"].forEach((name) => {
      const symbol = result.symbols.resolveTopLevel(name);
      const wrapperContract =
        typeof symbol === "number"
          ? result.borrowing.callables.get(symbol)
          : undefined;
      expect(wrapperContract?.parameters[0]?.readPaths).toEqual([]);
      expect(wrapperContract?.parameters[1]?.readPaths).toEqual([]);
    });
    const conditional = result.symbols.resolveTopLevel("conditional_wrapper");
    const conditionalContract =
      typeof conditional === "number"
        ? result.borrowing.callables.get(conditional)
        : undefined;
    expect(conditionalContract?.parameters[1]?.readPaths).toEqual([]);
    expect(conditionalContract?.parameters[2]?.readPaths).toEqual([]);
  });

  it("materializes plain value projections before mutable receiver calls", () => {
    const result = analyzeWithRecovery(`
obj Vec { x: f64, y: f64, z: f64 }
obj Record { point: Vec, normal: Vec, front: bool }

impl Vec
  fn '-'(self, other: Vec) -> Vec
    Vec { x: self.x - other.x, y: self.y - other.y, z: self.z - other.z }

  fn '/'(self, scalar: f64) -> Vec
    Vec { x: self.x / scalar, y: self.y / scalar, z: self.z / scalar }

impl Record
  fn update(~self, outward: Vec) -> void
    self.front = outward.x < 0.0
    self.normal = outward

fn valid(~rec: Record) -> void
  let outward = (rec.point - Vec { x: 0.0, y: 0.0, z: 0.0 }) / 1.0
  rec.update(outward)
`);
    expect(
      Array.from(result.borrowing.callables.values()).filter(
        (contract) => contract.freshResult === true,
      ),
    ).not.toHaveLength(0);
    expect(result.diagnostics).toEqual([]);
  });

  it("propagates overloaded operator reads through compact wrappers", () => {
    const result = analyze(`
obj Meter { value: i32 }

impl Meter
  fn '+'(self, delta: i32) -> i32
    self.value + delta

fn add_one(meter: Meter) -> i32
  meter + 1
`);
    const addOne = result.symbols.resolveTopLevel("add_one");
    const contract =
      typeof addOne === "number"
        ? result.borrowing.callables.get(addOne)
        : undefined;
    expect(contract?.parameters[0]?.readPaths).toContainEqual([
      { kind: "field", name: "value" },
    ]);
  });

  it("upgrades boundary summaries to ambient before propagating callers", () => {
    const result = analyze(`
obj Box { value: i32 }
let source = Box { value: 1 }

fn get() -> Box
  source

pub fn read() -> i32
  get().value
`);
    const read = result.symbols.resolveTopLevel("read");
    const demand = summaryDemandFor(result);

    // Returned external provenance is owned by full facts for both the
    // boundary and the caller that projects through its result.
    expect(demand.demandedCallables).toBe(2);
    expect(
      typeof read === "number"
        ? result.borrowing.callables.get(read)?.externalRead
        : undefined,
    ).toBe(true);
  });

  it("keeps opaque callbacks demanded while routing transient recursion compactly", () => {
    const result = analyze(`
obj Box { value: i32 }

fn invoke(callback: fn(i32) -> i32, value: i32) -> i32
  callback(value)

fn left(~value: Box) -> void
  right(~value)

fn right(~value: Box) -> void
  left(~value)
`);

    const demand = summaryDemandFor(result);
    expect(demand.demandedCallables).toBe(1);
    expect(demand.evaluations).toBeGreaterThanOrEqual(1);
  });

  it("routes lambda captures through the flow-sensitive path", () => {
    const result = analyze(`
obj Box { value: i32 }
let source = Box { value: 1 }

fn ignore_reader() -> i32
  let reader = () -> i32 => source.value
  0
`);

    expect(summaryDemandFor(result)).toMatchObject({
      totalCallables: 2,
      demandedCallables: 0,
      skippedTrivialCallables: 2,
      evaluations: 0,
    });
    expect(
      Array.from(result.borrowing.queries ?? []).filter(
        ([symbol]) => symbol < 0,
      ),
    ).toHaveLength(1);
  });

  it("uses a lambda callable's own captures for demand and query inputs", () => {
    const source = (mutable: boolean) =>
      analyze(`
fn ignore_capture() -> i32
  ${mutable ? "let ~value" : "let value"} = 1
  let reader = () -> i32 => value
  0
`);
    const ordinary = source(false);
    const mutable = source(true);
    const lambdaInput = (result: ReturnType<typeof analyze>) =>
      Array.from(result.borrowing.queries ?? []).find(
        ([symbol]) => symbol < 0,
      )?.[1].input;

    expect(summaryDemandFor(ordinary).demandedCallables).toBe(0);
    expect(summaryDemandFor(mutable).demandedCallables).toBe(2);
    expect(lambdaInput(mutable)).not.toBe(lambdaInput(ordinary));
  });

  it("publishes signature-derived synthetic lambda contracts", () => {
    const result = analyze(`
obj Box { value: i32 }
let external = 1

fn ignore_callbacks() -> i32
  let borrowed_callback: fn(borrow Box) : () -> borrow Box =
    (value: borrow Box) -> borrow Box => value
  let primitive_callback: fn(i32) : () -> i32 =
    (value: i32) -> i32 => value + external
  0
`);
    const outputs = Array.from(result.borrowing.queries ?? [])
      .filter(([symbol]) => symbol < 0)
      .map(([, query]) => query.output);

    expect(outputs).toHaveLength(2);
    expect(outputs).toContainEqual(
      expect.objectContaining({
        parameters: [expect.objectContaining({ access: "shared" })],
        borrowedResult: "parameter",
      }),
    );
    expect(outputs).toContainEqual(
      expect.objectContaining({
        parameters: [expect.objectContaining({ access: "owned" })],
        borrowedResult: "none",
      }),
    );
  });

  it("reuses immutable dependency contracts without decoding", () => {
    const dependency = analyze(`
pub obj Box { api value: i32 }

pub fn read(value: Box) -> i32
  value.value
`);
    const cache = createBorrowingDependencyProjectionCache();
    const dependencies = new Map([[dependency.moduleId, dependency]]);

    const first = projectBorrowingDependencies(dependencies, cache);
    const afterFirst = snapshotBorrowingDependencyProjectionCacheStats(cache);
    const second = projectBorrowingDependencies(dependencies, cache);
    const afterSecond = snapshotBorrowingDependencyProjectionCacheStats(cache);

    expect(afterFirst).toMatchObject({
      hits: 0,
      misses: 1,
    });
    expect(afterSecond).toEqual({
      ...afterFirst,
      hits: 1,
    });
    expect(second.get(dependency.moduleId)).toBe(
      first.get(dependency.moduleId),
    );
  });

  it("isolates dependency projections across snapshots and module contexts", () => {
    const source = `
pub obj Box { api value: i32 }

pub fn read(value: Box) -> i32
  value.value
`;
    const firstSnapshot = analyze(source);
    const secondSnapshot = analyze(source);
    const cache = createBorrowingDependencyProjectionCache();
    const first = projectBorrowingDependencies(
      new Map([[firstSnapshot.moduleId, firstSnapshot]]),
      cache,
    );
    const afterFirst = snapshotBorrowingDependencyProjectionCacheStats(cache);
    const second = projectBorrowingDependencies(
      new Map([[secondSnapshot.moduleId, secondSnapshot]]),
      cache,
    );
    const afterSecond = snapshotBorrowingDependencyProjectionCacheStats(cache);
    projectBorrowingDependencies(
      new Map([["src::alternate", firstSnapshot]]),
      cache,
    );
    const afterAlternateContext =
      snapshotBorrowingDependencyProjectionCacheStats(cache);

    expect(afterSecond.misses).toBe(afterFirst.misses + 1);
    expect(second.get(secondSnapshot.moduleId)).not.toBe(
      first.get(firstSnapshot.moduleId),
    );
    expect(afterAlternateContext.misses).toBe(afterSecond.misses + 1);
    expect(afterAlternateContext.hits).toBe(0);
  });

  it("assembles borrowing dependencies from graph and import edges", () => {
    const dependency = analyze(`
pub fn read() -> i32
  1
`);
    const dependencies = new Map(
      Array.from({ length: 100 }, (_, index) => [
        `src::prior_${index}`,
        dependency,
      ]),
    );
    dependencies.set("src::direct", dependency);
    dependencies.set("src::canonical_import", dependency);

    const selected = selectBorrowingDependencySemantics({
      dependencies,
      directDependencyModuleIds: ["src::direct", "src::direct"],
      importedModuleIds: ["src::canonical_import", "src::missing"],
    });

    expect(Array.from(selected.keys())).toEqual([
      "src::direct",
      "src::canonical_import",
    ]);
  });

  it("types mutable lambdas against explicitly borrowed callback parameters", () => {
    expect(() =>
      analyze(`
obj Box { value: i32 }

fn accept(body: fn(~value: borrow Box) : () -> void) -> void
  let ~value = Box { value: 1 }
  body(~value)

fn valid() -> void
  accept((~value) =>
    value.value = 2
  )
`),
    ).not.toThrow();
  });

  it("redacts every concrete implementation path from public summaries", () => {
    const privatePath = [{ kind: "field" as const, name: "private_storage" }];
    const privateCursorPath = [
      { kind: "field" as const, name: "private_cursor" },
    ];
    const implementation = {
      parameters: [
        {
          access: "mutable" as const,
          readPaths: [privatePath],
          writePaths: [privatePath],
          retained: true,
          returned: true,
          retainedPaths: [privatePath],
          externalRetainedPaths: [privatePath],
          borrowedRetainedPaths: [privatePath],
          returnedPaths: [privatePath],
          returnedOrigins: [{ source: privatePath, result: [] }],
          returnedSharedOrigins: [{ source: privatePath, result: [] }],
          returnedTypeMatchingOrigins: [
            {
              conditionId: "condition:private_storage",
              source: privatePath,
              result: [],
            },
          ],
          accessIfResultTypeDiffers: {
            conditionId: "condition:private_storage",
            parameter: 0,
            sourcePath: privatePath,
            resultPath: [],
          },
          invalidatedPaths: [privatePath],
          defaultOrigins: [{ parameter: 0, source: privatePath, result: [] }],
          defaultReadOrigins: [
            { parameter: 0, path: privatePath },
            { parameter: 0, path: privateCursorPath },
          ],
          defaultWriteOrigins: [
            { parameter: 0, path: privatePath },
            { parameter: 0, path: privateCursorPath },
          ],
        },
        {
          access: "owned" as const,
          readPaths: [privatePath],
          returned: true,
          returnedOrigins: [{ source: privatePath, result: privatePath }],
          defaultOrigins: [
            { parameter: 0, source: privatePath, result: privatePath },
          ],
          defaultReadOrigins: [{ parameter: 0, path: privatePath }],
          defaultWriteOrigins: [{ parameter: 0, path: privatePath }],
          retained: false,
          accessIfResultTypeDiffers: {
            conditionId: "cross-parameter",
            parameter: 0,
            sourcePath: privatePath,
            resultPath: [],
          },
        },
      ],
      maySuspend: false,
      borrowedResult: "parameter" as const,
      transfers: [
        {
          sourceParameter: 0,
          destinationParameter: 0,
          sourcePath: privatePath,
          destinationPath: privatePath,
        },
      ],
    };
    const named = {
      scope: "src::views::View",
      declaration: 1,
      trait: 2,
      implementation: 3,
      regions: [
        {
          name: "source",
          parameter: 0,
          place: privatePath,
        },
        {
          name: "cursor",
          parameter: 0,
          place: privateCursorPath,
        },
      ],
      disjoint: [["source", "cursor"] as const],
      reads: ["source", "cursor"],
      mutates: ["source", "cursor"],
      returnsFrom: ["source"],
    };
    const dynamicDispatch = abstractTraitContractFromImplementation({
      contract: implementation,
      named,
    });
    const summary = createCallableBorrowSummary({
      contract: { ...implementation, dynamicDispatch },
      namedContract: named,
    });

    expect(JSON.stringify(summary)).not.toContain("private_storage");
    expect(JSON.stringify(summary)).not.toContain("private_cursor");
    const decoded = summary;
    expect(
      decoded.contract.parameters[0]?.returnedTypeMatchingOrigins?.[0]
        ?.source[0],
    ).toMatchObject({
      kind: "region",
      scope: named.scope,
      name: "source",
    });
    expect(
      decoded.contract.parameters[0]?.defaultReadOrigins?.map(
        (origin) => origin.path[0],
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "region", name: "source" }),
        expect.objectContaining({ kind: "region", name: "cursor" }),
      ]),
    );
    expect(decoded.contract.parameters[0]?.defaultWriteOrigins).toHaveLength(2);
  });

  it("preserves safety facts in conservative public summaries", () => {
    const privatePath = [{ kind: "field" as const, name: "private_storage" }];
    const privateSummaryPath = [
      {
        kind: "region" as const,
        scope: "voyd.summary.private",
        name: "storage",
        disjoint: [],
      },
    ];
    const summary = createCallableBorrowSummary({
      publicAbstraction: true,
      contract: {
        parameters: [
          {
            access: "mutable",
            retained: false,
            returned: true,
            returnedOrigins: [
              {
                source: privatePath,
                result: privatePath,
                endpointAccess: "inline",
              },
              {
                source: privatePath,
                result: privatePath,
                endpointAccess: "dereferenced",
              },
            ],
            returnedSharedOrigins: [
              {
                source: privatePath,
                result: privatePath,
                endpointAccess: "dereferenced",
              },
            ],
          },
          {
            access: "owned",
            retained: false,
            returned: false,
          },
        ],
        maySuspend: false,
        transfers: [
          {
            sourceParameter: 0,
            destinationParameter: 1,
            sourcePath: privatePath,
            destinationPath: privatePath,
          },
        ],
        scopedCallbacks: [
          {
            callbackParameter: 1,
            callbackValueParameter: 0,
            access: "shared",
            callbackPath: ["private_storage"],
            defaultCallbackBehavior: "escapes",
          },
        ],
      },
    });
    const decoded = summary.contract;

    expect(JSON.stringify(summary)).not.toContain("private_storage");
    const returned = decoded.parameters[0]?.returnedOrigins ?? [];
    const returnedShared = decoded.parameters[0]?.returnedSharedOrigins ?? [];
    expect(returned).toHaveLength(2);
    expect(returnedShared).toHaveLength(1);
    expect(returned).toEqual(expect.arrayContaining([...returnedShared]));
    expect(decoded.transfers?.[0]).toMatchObject({
      sourceParameter: 0,
      destinationParameter: 1,
      sourcePath: privateSummaryPath,
      destinationPath: privateSummaryPath,
      conservative: true,
    });
    expect(decoded.scopedCallbacks?.[0]).toEqual({
      callbackParameter: 1,
      callbackValueParameter: 0,
      access: "shared",
      defaultCallbackBehavior: "escapes",
    });
  });

  it("uses disjoint declaration regions for open trait dispatch", () => {
    expect(() =>
      analyze(`
obj Item { value: i32 }
obj ItemView { cursor: i32, source: Item }

trait View
  region cursor
  region source
  disjoint cursor, source

  @borrow_contract(mutates: cursor, returns_from: source)
  fn next(~self) -> borrow Item

impl View for ItemView
  region cursor = self.cursor
  region source = deref(self.source)

  fn next(~self) -> borrow Item
    self.cursor = self.cursor + 1
    self.source

fn valid(~view: View) -> i32
  let first = view.next()
  let second = view.next()
  first.value + second.value
`),
    ).not.toThrow();
  });

  it("uses the selected overloaded trait declaration contract", () => {
    expect(
      diagnosticCodes(`
obj State { left: i32, right: i32 }

trait View
  region left
  region right
  disjoint left, right

  @borrow_contract(returns_from: left)
  fn get(self, index: i32) -> borrow i32

  @borrow_contract(returns_from: right)
  fn get(self, flag: bool) -> borrow i32

impl View for State
  region left = self.left
  region right = self.right

  fn get(self, index: i32) -> borrow i32
    self.left

  fn get(self, flag: bool) -> borrow i32
    self.right

pub fn main() -> i32
  let ~state = State { left: 1, right: 1 }
  let view: View = state
  let item = view.get(true)
  state.right = 2
  item
`),
    ).toContain("TY0048");
  });

  it("projects object-backed regions through local trait coercions", () => {
    const declarations = `
obj Item { value: i32 }
obj State { source: Item }

trait View
  region source
  @borrow_contract(returns_from: source)
  fn get(self) -> borrow Item

impl View for State
  region source = deref(self.source)

  fn get(self) -> borrow Item
    self.source
`;
    expect(
      diagnosticCodes(`
${declarations}
pub fn main() -> i32
  let ~state = State { source: Item { value: 1 } }
  let view: View = state
  let item = view.get()
  state.source.value = 2
  item.value
`),
    ).toContain("TY0048");
    expect(() =>
      analyze(`
${declarations}
pub fn main() -> i32
  let ~state = State { source: Item { value: 1 } }
  let view: View = state
  let item = view.get()
  let observed = item.value
  state.source.value = 2
  observed
`),
    ).not.toThrow();
  });

  it("projects inline regions through local trait coercions", () => {
    const declarations = `
obj State { source: i32 }

trait View
  region source
  @borrow_contract(returns_from: source)
  fn get(self) -> borrow i32

impl View for State
  region source = self.source

  fn get(self) -> borrow i32
    self.source
`;
    expect(
      diagnosticCodes(`
${declarations}
pub fn main() -> i32
  let ~state = State { source: 1 }
  let view: View = state
  let item = view.get()
  state.source = 2
  item
`),
    ).toContain("TY0048");
    expect(() =>
      analyze(`
${declarations}
pub fn main() -> i32
  let ~state = State { source: 1 }
  let view: View = state
  let item = view.get()
  let observed = item + 0
  state.source = 2
  observed
`),
    ).not.toThrow();
  });

  it("selects trait region projections by generic impl specialization", () => {
    const declarations = `
obj State<T> { left: T, right: T }

trait View<T>
  region source
  @borrow_contract(returns_from: source)
  fn get(self) -> borrow T

impl View<i32> for State<i32>
  region source = self.left

  fn get(self) -> borrow i32
    self.left

impl View<bool> for State<bool>
  region source = self.right

  fn get(self) -> borrow bool
    self.right
`;
    expect(() =>
      analyze(`
${declarations}
pub fn main() -> i32
  let ~state = State<i32> { left: 1, right: 2 }
  let view: View<i32> = state
  let item = view.get()
  state.right = 3
  item
`),
    ).not.toThrow();
    expect(
      diagnosticCodes(`
${declarations}
pub fn main() -> i32
  let ~state = State<i32> { left: 1, right: 2 }
  let view: View<i32> = state
  let item = view.get()
  state.left = 3
  item
`),
    ).toContain("TY0048");
    expect(() =>
      analyze(`
${declarations}
pub fn main() -> bool
  let ~state = State<bool> { left: false, right: true }
  let view: View<bool> = state
  let item = view.get()
  state.left = true
  item
`),
    ).not.toThrow();
    expect(
      diagnosticCodes(`
${declarations}
pub fn main() -> bool
  let ~state = State<bool> { left: false, right: true }
  let view: View<bool> = state
  let item = view.get()
  state.right = false
  item
`),
    ).toContain("TY0048");
  });

  it("preserves disjoint trait regions through aggregate wrappers", () => {
    const declarations = `
obj State { left: i32, right: i32 }
obj Wrapper { view: View }
obj Outer { inner: Wrapper }

trait View
  region left
  region right
  disjoint left, right
  @borrow_contract(returns_from: right)
  fn get(self, flag: bool) -> borrow i32

impl View for State
  region left = self.left
  region right = self.right

  fn get(self, flag: bool) -> borrow i32
    self.right
`;
    expect(() =>
      analyze(`
${declarations}
pub fn main() -> i32
  let ~state = State { left: 1, right: 1 }
  let wrapped = Wrapper { view: state }
  let item = wrapped.view.get(true)
  state.left = 2
  item
`),
    ).not.toThrow();
    expect(
      diagnosticCodes(`
${declarations}
pub fn main() -> i32
  let ~state = State { left: 1, right: 1 }
  let wrapped = Wrapper { view: state }
  let item = wrapped.view.get(true)
  state.right = 2
  item
`),
    ).toContain("TY0048");
    expect(() =>
      analyze(`
${declarations}
pub fn main() -> i32
  let ~state = State { left: 1, right: 1 }
  let wrapped = Outer { inner: Wrapper { view: state } }
  let item = wrapped.inner.view.get(true)
  state.left = 2
  item
`),
    ).not.toThrow();
    expect(
      diagnosticCodes(`
${declarations}
pub fn main() -> i32
  let ~state = State { left: 1, right: 1 }
  let wrapped = Outer { inner: Wrapper { view: state } }
  let item = wrapped.inner.view.get(true)
  state.right = 2
  item
`),
    ).toContain("TY0048");
    expect(() =>
      analyze(`
${declarations}
pub fn main() -> i32
  let ~state = State { left: 1, right: 1 }
  let inner = Wrapper { view: state }
  let wrapped = Outer { inner }
  let item = wrapped.inner.view.get(true)
  state.left = 2
  item
`),
    ).not.toThrow();
    expect(
      diagnosticCodes(`
${declarations}
pub fn main() -> i32
  let ~state = State { left: 1, right: 1 }
  let inner = Wrapper { view: state }
  let wrapped = Outer { inner }
  let item = wrapped.inner.view.get(true)
  state.right = 2
  item
`),
    ).toContain("TY0048");
  });

  it("preserves nested aggregate allocation identity", () => {
    const declarations = `
obj Box { value: i32 }
obj Inner { value: i32, child: Box }
obj Outer { inner: Inner }
`;
    expect(
      diagnosticCodes(`
${declarations}
pub fn main() -> i32
  let ~inner = Inner { value: 1, child: Box { value: 1 } }
  let outer = Outer { inner }
  let loan: borrow Inner = outer.inner
  inner.value = 2
  loan.value
`),
    ).toContain("TY0048");
    expect(
      diagnosticCodes(`
${declarations}
pub fn main() -> i32
  let ~inner = Inner { value: 1, child: Box { value: 1 } }
  let outer = (inner, 0)
  let loan: borrow Inner = outer.0
  inner.value = 2
  loan.value
`),
    ).toContain("TY0048");
  });

  it("preserves disjoint trait regions through optional wrappers", () => {
    const declarations = `
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None
obj Outer<T> { value: T }
obj State { left: i32, right: i32 }

trait View
  region left
  region right
  disjoint left, right
  @borrow_contract(returns_from: right)
  fn get(self, flag: bool) -> borrow i32

impl View for State
  region left = self.left
  region right = self.right

  fn get(self, flag: bool) -> borrow i32
    self.right
`;
    expect(() =>
      analyze(`
${declarations}
pub fn main() -> i32
  let ~state = State { left: 1, right: 1 }
  let wrapped: Option<View> = Some<View> { value: state }
  match(wrapped)
    Some<View> { value }:
      let item = value.get(true)
      state.left = 2
      item
    None:
      0
`),
    ).not.toThrow();
    expect(
      diagnosticCodes(`
${declarations}
pub fn main() -> i32
  let ~state = State { left: 1, right: 1 }
  let wrapped: Option<View> = Some<View> { value: state }
  match(wrapped)
    Some<View> { value }:
      let item = value.get(true)
      state.right = 2
      item
    None:
      0
`),
    ).toContain("TY0048");
    expect(() =>
      analyze(`
${declarations}
pub fn main() -> i32
  let ~state = State { left: 1, right: 1 }
  let wrapped = Outer<Option<View>> {
    value: Some<View> { value: state }
  }
  match(wrapped.value)
    Some<View> { value }:
      let item = value.get(true)
      state.left = 2
      item
    None:
      0
`),
    ).not.toThrow();
    expect(
      diagnosticCodes(`
${declarations}
pub fn main() -> i32
  let ~state = State { left: 1, right: 1 }
  let wrapped = Outer<Option<View>> {
    value: Some<View> { value: state }
  }
  match(wrapped.value)
    Some<View> { value }:
      let item = value.get(true)
      state.right = 2
      item
    None:
      0
`),
    ).toContain("TY0048");
  });

  it("synthesizes declaration contracts without local implementations", () => {
    const result = analyze(`
obj Item { value: i32 }

trait View
  region cursor
  region source
  disjoint cursor, source

  @borrow_contract(mutates: cursor, returns_from: source)
  fn next(~self) -> borrow Item
`);
    const traitMethod = Array.from(result.hir.items.values())
      .flatMap((item) => (item.kind === "trait" ? item.methods : []))
      .find(() => true);
    const contract =
      traitMethod === undefined
        ? undefined
        : result.borrowing.callables.get(traitMethod.symbol);

    expect(contract?.parameters[0]?.writePaths?.[0]?.[0]).toMatchObject({
      kind: "region",
      scope: "borrowing.test.voyd::View",
      name: "cursor",
    });
    expect(
      contract?.parameters[0]?.returnedSharedOrigins?.[0]?.source[0],
    ).toMatchObject({
      kind: "region",
      scope: "borrowing.test.voyd::View",
      name: "source",
    });
  });

  it("preserves ordinary returned aliases through open trait summaries", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj Chooser {}

fn mutate(~value: Box) -> void
  value.value = value.value + 1

trait Choose
  @borrow_contract()
  fn choose(self, candidate: Box) -> Box

impl Choose for Chooser
  fn choose(self, candidate: Box) -> Box
    candidate

fn invalid(chooser: Choose, ~candidate: Box) -> i32
  let loan: borrow Box = candidate
  let returned = chooser.choose(candidate)
  mutate(~returned)
  loan.value
`),
    ).toContain("TY0048");
  });

  it("uses declared result origins instead of a more precise implementation", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj Chooser {}

fn mutate(~value: Box) -> void
  value.value = value.value + 1

trait Choose
  @borrow_contract(returns_from: candidate)
  fn choose(self, candidate: Box) -> Box

impl Choose for Chooser
  fn choose(self, candidate: Box) -> Box
    Box { value: candidate.value }

fn invalid(chooser: Choose, ~candidate: Box) -> i32
  let loan: borrow Box = candidate
  let ~returned = chooser.choose(candidate)
  mutate(~returned)
  loan.value
`),
    ).toContain("TY0048");
  });

  it("preserves projected ordinary aliases through open trait summaries", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj Holder { item: Box }
obj Chooser {}

fn mutate(~value: Box) -> void
  value.value = value.value + 1

trait Choose
  @borrow_contract()
  fn choose(self, candidate: Holder) -> Box

impl Choose for Chooser
  fn choose(self, candidate: Holder) -> Box
    candidate.item

fn invalid(chooser: Choose, ~candidate: Holder) -> i32
  let loan: borrow Box = candidate.item
  let ~returned = chooser.choose(candidate)
  mutate(~returned)
  loan.value
`),
    ).toContain("TY0048");
  });

  it("materializes value-only results through open trait summaries", () => {
    expect(
      diagnosticCodes(`
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None
obj Counter { index: i32 }

trait Next
  fn next(~self) -> Option<i32>

impl Next for Counter
  fn next(~self) -> Option<i32>
    self.index = self.index + 1
    Some<i32> { value: self.index }

fn valid(~counter: Next) -> i32
  let first = counter.next()
  let second = counter.next()
  match(first)
    Some<i32> { value }:
      value
    None:
      match(second)
        Some<i32> { value }:
          value
        None:
          0
`),
    ).toEqual([]);
  });

  it("conservatively rejects projected aliases from unannotated open traits", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj Holder { item: Box }
obj Chooser {}

fn mutate(~value: Box) -> void
  value.value = value.value + 1

trait Choose
  fn choose(self, candidate: Holder) -> Box

impl Choose for Chooser
  fn choose(self, candidate: Holder) -> Box
    candidate.item

fn invalid(chooser: Choose, ~candidate: Holder) -> i32
  let loan: borrow Box = candidate.item
  let ~returned = chooser.choose(candidate)
  mutate(~returned)
  loan.value
`),
    ).toContain("TY0048");
  });

  it("conservatively retains callbacks passed through unannotated open traits", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }

fn mutate(~value: Box) -> void
  value.value = value.value + 1

@intrinsic(name: "__retain_callback", uses_signature: true)
fn retain_callback(handler: fn() -> i32) -> i32
  0

obj SinkImpl {}

trait Sink
  fn accept(self, handler: fn() -> i32) -> void

impl Sink for SinkImpl
  fn accept(self, handler: fn() -> i32) -> void
    let _ = retain_callback(handler)

fn invalid(sink: Sink) -> void
  let ~box = Box { value: 0 }
  let callback = () =>
    mutate(~box)
    0
  sink.accept(callback)
  mutate(~box)
`),
    ).toEqual(expect.arrayContaining(["TY0049"]));
  });

  it("retains ordinary siblings of explicit borrows through checked traits", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj Package { loan: borrow Box, callback: fn() -> i32 }

fn mutate(~value: Box) -> void
  value.value = value.value + 1

obj SinkImpl {}

trait Sink
  @borrow_contract()
  fn accept(self, package: Package) -> void

impl Sink for SinkImpl
  fn accept(self, package: Package) -> void
    let _ = 0

fn invalid(sink: Sink, loan: borrow Box) -> void
  let ~box = Box { value: 0 }
  let callback = () =>
    mutate(~box)
    0
  sink.accept(Package { loan, callback })
  mutate(~box)
`),
    ).toEqual(expect.arrayContaining(["TY0049"]));
  });

  it("specializes generic retention to ordinary sibling projections", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj Package<T> { loan: T, callback: fn() -> i32 }

fn mutate(~value: Box) -> void
  value.value = value.value + 1

trait Sink<T>
  @borrow_contract()
  fn accept(self, package: T) -> void

obj SinkImpl<T> {}
impl<T> Sink<T> for SinkImpl<T>
  fn accept(self, package: T) -> void
    let _ = 0

fn invalid(
  sink: Sink<Package<borrow Box>>,
  loan: borrow Box
) -> void
  let ~box = Box { value: 0 }
  let callback = () =>
    mutate(~box)
    0
  sink.accept(Package<borrow Box> { loan, callback })
  mutate(~box)
`),
    ).toEqual(expect.arrayContaining(["TY0049"]));
  });

  it("retains ordinary alternatives of root-level borrowed unions", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
type Callback = fn() : () -> i32
type Mixed = borrow Box | Callback

fn mutate(~value: Box) -> void
  value.value = value.value + 1

trait Sink<T>
  @borrow_contract()
  fn accept(self, value: T) -> void

obj SinkImpl<T> {}
impl<T> Sink<T> for SinkImpl<T>
  fn accept(self, value: T) -> void
    let _ = 0

fn invalid(sink: Sink<Mixed>) -> void
  let ~box = Box { value: 0 }
  let callback: Callback = () =>
    mutate(~box)
    0
  let mixed: Mixed = callback
  sink.accept(mixed)
  mutate(~box)
`),
    ).toEqual(expect.arrayContaining(["TY0049"]));
  });

  it("preserves ordinary siblings in mixed borrowed trait results", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj Mixed<T> { loan: T, ordinary: Box }
obj Chooser { source: Box }

fn mutate_both(~left: Box, ~right: Box) -> void
  left.value = right.value

trait Choose
  region source
  @borrow_contract(returns_from: source)
  fn choose(self, candidate: Box) -> Mixed<borrow Box>

impl Choose for Chooser
  region source = deref(self.source)
  fn choose(self, candidate: Box) -> Mixed<borrow Box>
    Mixed<borrow Box> { loan: self.source, ordinary: candidate }

fn invalid(chooser: Choose, ~candidate: Box) -> i32
  let ~result = chooser.choose(candidate)
  mutate_both(~candidate, ~result.ordinary)
  result.loan.value
`),
    ).toContain("TY0048");
  });

  it("recognizes borrowed fields in nominal trait results", () => {
    expect(
      diagnosticsFor(`
obj Box { value: i32 }
obj Mixed { loan: borrow Box }

trait View
  region source
  @borrow_contract(returns_from: source)
  fn get(self) -> Mixed
`),
    ).toEqual([]);
  });

  it("conservatively abstracts private allocation aliases in trait results", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj Source { item: Box }

fn mutate(~value: Box) -> void
  value.value = value.value + 1

trait Get
  @borrow_contract()
  fn get(self) -> Box

impl Get for Source
  fn get(self) -> Box
    self.item

fn invalid(~source: Source) -> i32
  let getter: Get = source
  let loan: borrow Box = source.item
  let ~returned = getter.get()
  mutate(~returned)
  loan.value
`),
    ).toContain("TY0048");
  });

  it("does not retain explicit-borrow trait arguments", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj Reader {}

trait Read
  @borrow_contract()
  fn read(self, value: borrow Box) -> i32

impl Read for Reader
  fn read(self, value: borrow Box) -> i32
    value.value

fn valid(reader: Read, value: borrow Box) -> i32
  reader.read(value)
`),
    ).not.toContain("TY0051");
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj Reader {}

trait Read<T>
  @borrow_contract()
  fn read(self, value: T) -> i32

impl Read<borrow Box> for Reader
  fn read(self, value: borrow Box) -> i32
    value.value

fn valid(reader: Read<borrow Box>, value: borrow Box) -> i32
  reader.read(value)
`),
    ).not.toContain("TY0051");
  });

  it("preserves conditional trait retention through generic wrappers", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }

trait Sink<T>
  @borrow_contract()
  fn accept(self, value: T) -> void

obj SinkImpl<T> {}
impl<T> Sink<T> for SinkImpl<T>
  fn accept(self, value: T) -> void
    let _ = 0

fn relay<T>(sink: Sink<T>, value: T) -> void
  sink.accept(value)

fn valid(sink: Sink<borrow Box>, value: borrow Box) -> void
  relay(sink, value)
`),
    ).not.toContain("TY0051");
  });

  it("preserves declaration-region summaries across modules", async () => {
    const srcRoot = resolve("/proj/src");
    const stdRoot = resolve("/proj/std");
    const host = createMemoryModuleHost({
      files: {
        [`${stdRoot}${sep}pkg.voyd`]: `
pub use self::views
pub use std::views::{ Item, ItemView, View }
`,
        [`${stdRoot}${sep}views.voyd`]: `
pub obj Item { api value: i32 }
pub obj ItemView { api cursor: i32, api source: Item }

pub trait View
  region cursor
  region source
  disjoint cursor, source

  @borrow_contract(mutates: cursor, returns_from: source)
  fn next(~self) -> borrow Item

impl View for ItemView
  region cursor = self.cursor
  region source = deref(self.source)

  api fn next(~self) -> borrow Item
    self.cursor = self.cursor + 1
    self.source
`,
        [`${srcRoot}${sep}main.voyd`]: `
use std::all

fn valid(~view: View) -> i32
  let first: borrow Item = view.next()
  let second: borrow Item = view.next()
  first.value + second.value
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
    const exportedSummaries = Array.from(
      analyzed.semantics.get("std::views")?.exports.values() ?? [],
    )
      .flatMap((entry) => entry.borrowing ?? [])
      .map((entry) => ({
        entry,
        summary: {
          dispatch: entry.dispatch ?? "ordinary",
          contract: entry.contract,
          namedContract: entry.namedContract,
          source: entry.source,
        },
      }));
    const declarationSummary = exportedSummaries.find(
      ({ summary }) => summary.dispatch === "trait-declaration",
    );
    const implementationSummary = exportedSummaries.find(
      ({ summary }) => summary.dispatch === "trait-implementation",
    );
    const callerUsesRegions = Array.from(
      analyzed.semantics.get("src::main")?.borrowing.callables.values() ?? [],
    ).some((contract) =>
      contract.parameters.some((parameter) =>
        [...(parameter.readPaths ?? []), ...(parameter.writePaths ?? [])].some(
          (path) => path.some((projection) => projection.kind === "region"),
        ),
      ),
    );
    expect(diagnostics).toEqual([]);
    expect(declarationSummary?.entry.contract).toBeDefined();
    expect(declarationSummary?.summary.namedContract?.returnsFrom).toEqual([
      "source",
    ]);
    expect(implementationSummary?.entry.contract).toBeDefined();
    expect(implementationSummary?.summary.namedContract?.scope).toBe(
      "std::views::View",
    );
    expect(JSON.stringify(implementationSummary?.entry.contract)).not.toContain(
      '"field"',
    );
    expect(
      implementationSummary?.summary.contract.parameters[0]
        ?.returnedOrigins?.[0]?.source[0],
    ).toMatchObject({ kind: "region", name: "source" });
    expect(
      implementationSummary?.summary.contract.parameters[0]
        ?.writePaths?.[0]?.[0],
    ).toMatchObject({ kind: "region", name: "cursor" });
    expect(callerUsesRegions).toBe(true);
  });

  it("uses the selected overloaded trait declaration contract across modules", async () => {
    const srcRoot = resolve("/proj/src");
    const stdRoot = resolve("/proj/std");
    const host = createMemoryModuleHost({
      files: {
        [`${stdRoot}${sep}pkg.voyd`]: `
pub use self::views
pub use std::views::{ State, View, make_state }
`,
        [`${stdRoot}${sep}views.voyd`]: `
pub obj State { api left: i32, api right: i32, hidden: i32 }

pub trait View
  region left
  region right
  region secret
  disjoint left, right

  @borrow_contract(returns_from: left)
  fn get(self, index: i32) -> borrow i32

  @borrow_contract(returns_from: right)
  fn get(self, flag: bool) -> borrow i32

impl View for State
  region left = self.left
  region right = self.right
  region secret = self.hidden

  fn get(self, index: i32) -> borrow i32
    self.left

  fn get(self, flag: bool) -> borrow i32
    self.right

pub fn make_state() -> State
  State { left: 1, right: 1, hidden: 1 }
`,
        [`${srcRoot}${sep}main.voyd`]: `
use std::all::{ View as RenamedView, make_state }

pub fn main() -> i32
  let ~state = make_state()
  let view: RenamedView = state
  let item = view.get(true)
  state.right = 2
  item
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
    const coercion = Array.from(
      analyzed.semantics.get("std::views")?.exports.values() ?? [],
    ).find((entry) => entry.name === "State")?.borrowingCoercions?.[0];
    const packageSemantics = analyzed.semantics.get("std::pkg");
    const publicImplementations =
      packageSemantics?.exports.borrowingTraitImplementations ?? [];
    const publicImplementation = publicImplementations.find(
      (implementation) => implementation.concrete.moduleId === "std::views",
    );
    const publicOnlyDependencies = projectBorrowingDependencies(
      packageSemantics ? new Map([["std::pkg", packageSemantics]]) : new Map(),
    );
    const implementationMethod =
      publicImplementation?.methods[0]?.implementation;

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "TY0048",
    );
    expect(JSON.stringify(coercion?.contract)).not.toContain("hidden");
    expect(JSON.stringify(coercion?.contract)).toContain(
      "voyd.summary.private",
    );
    expect(
      coercion?.contract.parameters[0]?.returnedOrigins?.[0]?.result[0],
    ).toMatchObject({
      kind: "region",
      scope: "std::views::View",
    });
    expect(publicImplementation).toBeDefined();
    expect(
      implementationMethod
        ? publicOnlyDependencies
            .get(implementationMethod.moduleId)
            ?.traitMethodContracts.has(implementationMethod.symbol)
        : false,
    ).toBe(true);
    expect(
      publicOnlyDependencies
        .get("std::pkg")
        ?.traitRegionProjections.some(
          (projection) =>
            projection.concrete.moduleId === "std::views" &&
            projection.result.scope === "std::views::View",
        ),
    ).toBe(true);
  });

  it("preserves trait contracts for private implementations returned by public factories", async () => {
    const srcRoot = resolve("/proj/src");
    const stdRoot = resolve("/proj/std");
    const host = createMemoryModuleHost({
      files: {
        [`${stdRoot}${sep}pkg.voyd`]: `
pub use self::views
pub use std::views::{
  Item,
  Owner,
  View,
  make_owner,
  make_view,
  make_either_view,
  make_reassigned_view,
  make_overwritten_view,
  make_early_return_view,
  make_wrapped_view,
  make_lambda_view,
  make_captured_lambda_view,
  make_higher_order_view,
  make_forwarded_view,
  make_generic_view,
  make_labeled_view,
  make_default_view,
  make_matched_view,
  make_variant_view,
  make_spread_holder,
  make_overwritten_holder,
  make_explicit_view
}
`,
        [`${stdRoot}${sep}views.voyd`]: `
pub obj Item { api value: i32 }
pub obj Owner { api source: Item }
obj State { source: Item, cursor: i32 }
obj AlternateState { source: Item, cursor: i32 }
obj FieldState { source: Item, cursor: i32 }
obj LambdaState { source: Item, cursor: i32 }
obj ForwardState { source: Item, cursor: i32 }
obj GenericState { source: Item, cursor: i32 }
obj LabeledState { source: Item, cursor: i32 }
obj DefaultState { source: Item, cursor: i32 }
obj MatchedState { source: Item, cursor: i32 }
obj EarlyState { source: Item, cursor: i32 }
obj HigherOrderState { source: Item, cursor: i32 }
obj ShadowedState { source: Item, cursor: i32 }
obj OverridingState { source: Item, cursor: i32 }
obj UnusedState { source: Item, cursor: i32 }
pub obj HiddenState { value: Item }
pub obj Wrapper { api view: View }
pub obj Holder { api view: View }
obj Some<T> { value: T }
obj None {}
type Maybe<T> = Some<T> | None
obj Left<T> { value: T }
obj Right<T> { value: T }
type Either<T> = Left<T> | Right<T>

pub trait View
  region cursor
  region source
  disjoint cursor, source

  @borrow_contract(mutates: cursor, returns_from: source)
  fn next(~self) -> borrow Item

impl View for State
  region cursor = self.cursor
  region source = deref(self.source)

  fn next(~self) -> borrow Item
    self.cursor = self.cursor + 1
    self.source

impl View for AlternateState
  region cursor = self.cursor
  region source = deref(self.source)

  fn next(~self) -> borrow Item
    self.cursor = self.cursor + 1
    self.source

impl View for FieldState
  region cursor = self.cursor
  region source = deref(self.source)

  fn next(~self) -> borrow Item
    self.cursor = self.cursor + 1
    self.source

impl View for LambdaState
  region cursor = self.cursor
  region source = deref(self.source)

  fn next(~self) -> borrow Item
    self.cursor = self.cursor + 1
    self.source

impl View for ForwardState
  region cursor = self.cursor
  region source = deref(self.source)

  fn next(~self) -> borrow Item
    self.cursor = self.cursor + 1
    self.source

impl View for GenericState
  region cursor = self.cursor
  region source = deref(self.source)

  fn next(~self) -> borrow Item
    self.cursor = self.cursor + 1
    self.source

impl View for LabeledState
  region cursor = self.cursor
  region source = deref(self.source)

  fn next(~self) -> borrow Item
    self.cursor = self.cursor + 1
    self.source

impl View for DefaultState
  region cursor = self.cursor
  region source = deref(self.source)

  fn next(~self) -> borrow Item
    self.cursor = self.cursor + 1
    self.source

impl View for MatchedState
  region cursor = self.cursor
  region source = deref(self.source)

  fn next(~self) -> borrow Item
    self.cursor = self.cursor + 1
    self.source

impl View for EarlyState
  region cursor = self.cursor
  region source = deref(self.source)

  fn next(~self) -> borrow Item
    self.cursor = self.cursor + 1
    self.source

impl View for HigherOrderState
  region cursor = self.cursor
  region source = deref(self.source)

  fn next(~self) -> borrow Item
    self.cursor = self.cursor + 1
    self.source

impl View for ShadowedState
  region cursor = self.cursor
  region source = deref(self.source)

  fn next(~self) -> borrow Item
    self.cursor = self.cursor + 1
    self.source

impl View for OverridingState
  region cursor = self.cursor
  region source = deref(self.source)

  fn next(~self) -> borrow Item
    self.cursor = self.cursor + 1
    self.source

impl View for UnusedState
  region cursor = self.cursor
  region source = deref(self.source)

  fn next(~self) -> borrow Item
    self.cursor = self.cursor + 1
    self.source

trait HiddenView
  region source

  @borrow_contract(returns_from: source)
  fn get(self) -> borrow Item

impl HiddenView for HiddenState
  region source = deref(self.value)

  fn get(self) -> borrow Item
    self.value

pub fn make_owner() -> Owner
  Owner { source: Item { value: 1 } }

pub fn make_view(owner: Owner) -> View
  State { source: owner.source, cursor: 0 }

pub fn make_either_view(owner: Owner, alternate: bool) -> View
  if alternate then:
    AlternateState { source: owner.source, cursor: 0 }
  else:
    State { source: owner.source, cursor: 0 }

pub fn make_reassigned_view(owner: Owner, alternate: bool) -> View
  var result: View = State { source: owner.source, cursor: 0 }
  if alternate:
    result = AlternateState { source: owner.source, cursor: 0 }
  result

pub fn make_overwritten_view(owner: Owner) -> View
  var result: View = ShadowedState { source: owner.source, cursor: 0 }
  result = State { source: owner.source, cursor: 0 }
  result

pub fn make_early_return_view(owner: Owner, early: bool) -> View
  var result: View = EarlyState { source: owner.source, cursor: 0 }
  if early:
    return result
  result = State { source: owner.source, cursor: 0 }
  result

pub fn make_wrapped_view(owner: Owner, alternate: bool) -> Wrapper
  let ~wrapper = Wrapper {
    view: State { source: owner.source, cursor: 0 }
  }
  if alternate:
    wrapper.view = FieldState { source: owner.source, cursor: 0 }
  wrapper

pub fn make_lambda_view(owner: Owner, alternate: bool) -> View
  let factory = () =>
    var result: View = State { source: owner.source, cursor: 0 }
    if alternate:
      result = LambdaState { source: owner.source, cursor: 0 }
    result
  factory()

pub fn make_captured_lambda_view(owner: Owner, early: bool) -> View
  var result: View = EarlyState { source: owner.source, cursor: 0 }
  let factory = () => result
  if early:
    return factory()
  result = State { source: owner.source, cursor: 0 }
  factory()

fn apply(factory: fn() -> View) -> View
  factory()

pub fn make_higher_order_view(owner: Owner) -> View
  apply(() =>
    HigherOrderState { source: owner.source, cursor: 0 }
  )

fn forward(value: View) -> View
  value

fn generic_forward<T: View>(value: T) -> View
  value

pub fn make_forwarded_view(owner: Owner) -> View
  forward(ForwardState { source: owner.source, cursor: 0 })

pub fn make_generic_view(owner: Owner) -> View
  generic_forward(GenericState { source: owner.source, cursor: 0 })

fn labeled_forward({ fallback: View, value: View }) -> View
  value

pub fn make_labeled_view(owner: Owner) -> View
  labeled_forward(
    value: LabeledState { source: owner.source, cursor: 0 },
    fallback: State { source: owner.source, cursor: 0 }
  )

fn default_forward(
  value: View = DefaultState {
    source: Item { value: 2 },
    cursor: 0
  }
) -> View
  value

pub fn make_default_view() -> View
  default_forward()

pub fn make_matched_view(owner: Owner) -> View
  let selected: Maybe<View> = Some<View> {
    value: MatchedState { source: owner.source, cursor: 0 }
  }
  match(selected)
    Some<View> { value }: value
    None: State { source: owner.source, cursor: 0 }

pub fn make_variant_view(owner: Owner, alternate: bool) -> View
  let returned: View = MatchedState {
    source: owner.source,
    cursor: 0
  }
  let shadowed: View = ShadowedState {
    source: owner.source,
    cursor: 0
  }
  let selected: Either<View> =
    if alternate then:
      Left<View> { value: returned }
    else:
      Right<View> { value: shadowed }
  match(selected)
    Left<View> { value }: value
    Right<View>: State { source: owner.source, cursor: 0 }

pub fn make_spread_holder(owner: Owner) -> Holder
  let shadowed = Holder {
    view: ShadowedState { source: owner.source, cursor: 0 }
  }
  Holder {
    ...shadowed,
    view: OverridingState { source: owner.source, cursor: 0 }
  }

pub fn make_overwritten_holder(owner: Owner) -> Holder
  let ~result = Holder {
    view: ShadowedState { source: owner.source, cursor: 0 }
  }
  result.view = OverridingState { source: owner.source, cursor: 0 }
  result

fn explicit_forward(
  value: View = UnusedState {
    source: Item { value: 3 },
    cursor: 0
  }
) -> View
  value

pub fn make_explicit_view(owner: Owner) -> View
  explicit_forward(State { source: owner.source, cursor: 0 })
`,
        [`${srcRoot}${sep}main.voyd`]: `
use std::all

pub fn main() -> i32
  let ~owner = make_owner()
  let ~view = make_view(owner)
  let item = view.next()
  owner.source.value = 2
  item.value
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
    const privateImplementation = analyzed.semantics
      .get("std::views")
      ?.exports.borrowingTraitImplementations?.find(
        (implementation) => implementation.concrete.moduleId === "std::views",
      );
    const publishedImplementations =
      analyzed.semantics.get("std::views")?.exports
        .borrowingTraitImplementations ?? [];
    const forwardedImplementations =
      analyzed.semantics.get("std::pkg")?.exports
        .borrowingTraitImplementations ?? [];
    const hiddenExport = Array.from(
      analyzed.semantics.get("std::views")?.exports.values() ?? [],
    ).find((entry) => entry.name === "HiddenState");
    const viewsSemantics = analyzed.semantics.get("std::views");
    const forwardSymbol = viewsSemantics?.symbols.resolveTopLevel("forward");
    const forwardContract =
      typeof forwardSymbol === "number"
        ? viewsSemantics?.borrowing.callables.get(forwardSymbol)
        : undefined;

    expect(
      diagnostics.filter((diagnostic) => diagnostic.code === "TY0048"),
    ).toHaveLength(1);
    expect(forwardContract?.parameters[0]).toMatchObject({
      returned: true,
    });
    expect(
      publishedImplementations
        .map((implementation) =>
          analyzed.semantics
            .get("std::views")
            ?.symbols.getName(implementation.concrete.symbol),
        )
        .sort(),
    ).toEqual(
      [
        "AlternateState",
        "FieldState",
        "ForwardState",
        "GenericState",
        "HigherOrderState",
        "LabeledState",
        "LambdaState",
        "DefaultState",
        "EarlyState",
        "MatchedState",
        "OverridingState",
        "State",
      ].sort(),
    );
    expect(forwardedImplementations).toHaveLength(12);
    expect(privateImplementation?.methods).toHaveLength(1);
    expect(hiddenExport?.borrowingCoercions ?? []).toEqual([]);
    expect(JSON.stringify(hiddenExport)).not.toContain("HiddenView");
    expect(
      Array.from(
        analyzed.semantics.get("std::views")?.exports.values() ?? [],
      ).some((entry) => entry.name === "State"),
    ).toBe(false);
  });

  it("tracks returned trait values through structural parameter containers", async () => {
    const srcRoot = resolve("/proj/src");
    const stdRoot = resolve("/proj/std");
    const host = createMemoryModuleHost({
      files: {
        [`${stdRoot}${sep}pkg.voyd`]: `
pub use self::api
pub use std::api::{ View, from_bound_container, from_inline_container }
`,
        [`${stdRoot}${sep}api.voyd`]: `
pub obj Item { api value: i32 }
obj ReturnedState { source: Item }
obj InlineState { source: Item }
obj ShadowedState { source: Item }
type Args = { value: View }

pub trait View
  region source

  @borrow_contract(returns_from: source)
  fn get(self) -> borrow Item

impl View for ReturnedState
  region source = deref(self.source)

  fn get(self) -> borrow Item
    self.source

impl View for InlineState
  region source = deref(self.source)

  fn get(self) -> borrow Item
    self.source

impl View for ShadowedState
  region source = deref(self.source)

  fn get(self) -> borrow Item
    self.source

fn select({ value: View }) -> View
  value

pub fn from_bound_container() -> View
  let returned: View = ReturnedState {
    source: Item { value: 1 }
  }
  let arguments: Args = { value: returned }
  select(arguments)

pub fn from_inline_container() -> View
  let shadowed_view: View = ShadowedState {
    source: Item { value: 2 }
  }
  let shadowed: Args = {
    value: shadowed_view
  }
  let inline_view: View = InlineState {
    source: Item { value: 3 }
  }
  select({
    ...shadowed,
    value: inline_view
  })
`,
        [`${srcRoot}${sep}main.voyd`]: `
use std::all

pub fn main() -> i32
  from_bound_container().get().value + from_inline_container().get().value
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
    const api = analyzed.semantics.get("std::api");
    const coercionNamesFor = (name: string): readonly string[] =>
      Array.from(api?.exports.values() ?? [])
        .find((entry) => entry.name === name)
        ?.borrowingCoercions?.map(
          (coercion) => api?.symbols.getName(coercion.concrete.symbol) ?? "",
        ) ?? [];

    expect([...graph.diagnostics, ...analyzed.diagnostics]).toEqual([]);
    expect(coercionNamesFor("from_bound_container")).toEqual(["ReturnedState"]);
    expect(coercionNamesFor("from_inline_container")).toEqual(["InlineState"]);
    expect(
      (api?.exports.borrowingTraitImplementations ?? []).map((implementation) =>
        api?.symbols.getName(implementation.concrete.symbol),
      ),
    ).not.toContain("ShadowedState");
  });

  it("keeps imported default result provenance in its declaration module", async () => {
    const srcRoot = resolve("/proj/src");
    const stdRoot = resolve("/proj/std");
    const host = createMemoryModuleHost({
      files: {
        [`${stdRoot}${sep}pkg.voyd`]: `
pub use self::api
pub use std::api::{ Item, View, forward, chained, overloaded, apply }
`,
        [`${stdRoot}${sep}api.voyd`]: `
pub obj Item { api value: i32 }
obj DefaultState { source: Item }
obj FirstState { source: Item }
obj SecondState { source: Item }

pub trait View
  region source

  @borrow_contract(returns_from: source)
  fn get(self) -> borrow Item

impl View for DefaultState
  region source = deref(self.source)

  fn get(self) -> borrow Item
    self.source

impl View for FirstState
  region source = deref(self.source)

  fn get(self) -> borrow Item
    self.source

impl View for SecondState
  region source = deref(self.source)

  fn get(self) -> borrow Item
    self.source

pub fn forward({
  value: View = DefaultState {
    source: Item { value: 7 }
  }
}) -> View
  value

pub fn chained({
  base: View = DefaultState {
    source: Item { value: 9 }
  },
  selected: View = base
}) -> View
  selected

pub fn overloaded(value: i32) -> View
  FirstState { source: Item { value } }

pub fn overloaded(value: bool) -> View
  SecondState {
    source: Item { value: if value then: 1 else: 0 }
  }

pub fn apply(factory: fn() -> View) -> View
  factory()
`,
        [`${srcRoot}${sep}main.voyd`]: `
use std::all

obj CollisionState { value: i32 }
obj CallerState { source: Item }

impl View for CallerState
  region source = deref(self.source)

  fn get(self) -> borrow Item
    self.source

pub fn explicit(owner: Item) -> View
  forward(value: CallerState { source: owner })

pub fn omitted() -> View
  forward()

pub fn chained_explicit(owner: Item) -> View
  chained(base: CallerState { source: owner })

pub fn chained_omitted() -> View
  chained()

pub fn selected_overload() -> View
  overloaded(1)

pub fn higher_order(owner: Item) -> View
  apply(() => CallerState { source: owner })

pub fn main() -> i32
  let first = CollisionState { value: 1 }
  let second = CollisionState { value: first.value + 1 }
  let third = CollisionState { value: second.value + 1 }
  let view = omitted()
  view.get().value + third.value
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
    const api = analyzed.semantics.get("std::api");
    const main = analyzed.semantics.get("src::main");
    const forwardExport = Array.from(api?.exports.values() ?? []).find(
      (entry) => entry.name === "forward",
    );
    const forwardedExport = Array.from(
      analyzed.semantics.get("std::pkg")?.exports.values() ?? [],
    ).find((entry) => entry.name === "forward");
    const explicitExport = Array.from(main?.exports.values() ?? []).find(
      (entry) => entry.name === "explicit",
    );
    const omittedExport = Array.from(main?.exports.values() ?? []).find(
      (entry) => entry.name === "omitted",
    );
    const chainedExport = Array.from(api?.exports.values() ?? []).find(
      (entry) => entry.name === "chained",
    );
    const chainedExplicitExport = Array.from(main?.exports.values() ?? []).find(
      (entry) => entry.name === "chained_explicit",
    );
    const chainedOmittedExport = Array.from(main?.exports.values() ?? []).find(
      (entry) => entry.name === "chained_omitted",
    );
    const selectedOverloadExport = Array.from(
      main?.exports.values() ?? [],
    ).find((entry) => entry.name === "selected_overload");
    const higherOrderExport = Array.from(main?.exports.values() ?? []).find(
      (entry) => entry.name === "higher_order",
    );
    const forwardedApplyExport = Array.from(
      analyzed.semantics.get("std::pkg")?.exports.values() ?? [],
    ).find((entry) => entry.name === "apply");
    const forwardSymbol = api?.symbols.resolveTopLevel("forward");
    const forwardItem = Array.from(api?.hir.items.values() ?? []).find(
      (item) => item.kind === "function" && item.symbol === forwardSymbol,
    );
    const defaultExpression =
      forwardItem?.kind === "function"
        ? forwardItem.parameters[0]?.defaultValue
        : undefined;

    expect([...graph.diagnostics, ...analyzed.diagnostics]).toEqual([]);
    expect(forwardExport?.borrowingCoercions).toHaveLength(1);
    expect(forwardedExport?.borrowingCoercions).toHaveLength(1);
    expect(
      forwardExport?.borrowingCoercions?.[0]?.applicability?.[0]
        ?.omissionRequirements,
    ).toEqual([[0]]);
    expect(
      explicitExport?.borrowingCoercions?.map(
        (coercion) => coercion.concrete.moduleId,
      ),
    ).toEqual(["src::main"]);
    expect(
      omittedExport?.borrowingCoercions?.map(
        (coercion) => coercion.concrete.moduleId,
      ),
    ).toEqual(["std::api"]);
    expect(
      chainedExport?.borrowingCoercions?.[0]?.applicability?.[0]
        ?.omissionRequirements,
    ).toEqual([[0, 1]]);
    expect(
      chainedExplicitExport?.borrowingCoercions?.map(
        (coercion) => coercion.concrete.moduleId,
      ),
    ).toEqual(["src::main"]);
    expect(
      chainedOmittedExport?.borrowingCoercions?.map(
        (coercion) => coercion.concrete.moduleId,
      ),
    ).toEqual(["std::api"]);
    expect(
      selectedOverloadExport?.borrowingCoercions?.map((coercion) =>
        api?.symbols.getName(coercion.concrete.symbol),
      ),
    ).toEqual(["FirstState"]);
    expect(
      higherOrderExport?.borrowingCoercions?.map((coercion) =>
        main?.symbols.getName(coercion.concrete.symbol),
      ),
    ).toEqual(["CallerState"]);
    expect(
      forwardedApplyExport?.borrowing?.[0]?.contract.callableResultInvocations,
    ).toEqual([{ parameter: 0, source: [], callbackResult: [], result: [] }]);
    expect(typeof defaultExpression).toBe("number");
    expect(
      typeof defaultExpression === "number" &&
        main?.hir.expressions.has(defaultExpression),
    ).toBe(true);
  });

  it("keeps re-exported overload applicability module-qualified", async () => {
    const srcRoot = resolve("/proj/src");
    const stdRoot = resolve("/proj/std");
    const implementationModule = (parameter: string, literal: string) => `
use std::common::{ Item, View }

obj State { source: Item }

impl View for State
  region source = deref(self.source)

  fn get(self) -> borrow Item
    self.source

pub fn select(value: ${parameter}) -> View
  let _ = value
  State { source: Item { value: ${literal} } }
`;
    const host = createMemoryModuleHost({
      files: {
        [`${stdRoot}${sep}pkg.voyd`]: `
pub use self::common
pub use self::a
pub use self::b
pub use std::common::{ Item, View }
pub use std::a::{ select }
pub use std::b::{ select }
`,
        [`${stdRoot}${sep}common.voyd`]: `
pub obj Item { api value: i32 }

pub trait View
  region source

  @borrow_contract(returns_from: source)
  fn get(self) -> borrow Item
`,
        [`${stdRoot}${sep}a.voyd`]: implementationModule("i32", "1"),
        [`${stdRoot}${sep}b.voyd`]: implementationModule("bool", "2"),
        [`${srcRoot}${sep}main.voyd`]: `
use std::all

pub fn chosen() -> View
  select(true)
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
    const aSelect = Array.from(
      analyzed.semantics.get("std::a")?.exports.values() ?? [],
    ).find((entry) => entry.name === "select");
    const bSelect = Array.from(
      analyzed.semantics.get("std::b")?.exports.values() ?? [],
    ).find((entry) => entry.name === "select");
    const chosen = Array.from(
      analyzed.semantics.get("src::main")?.exports.values() ?? [],
    ).find((entry) => entry.name === "chosen");
    const aCallable =
      aSelect?.borrowingCoercions?.[0]?.applicability?.[0]?.callable;
    const bCallable =
      bSelect?.borrowingCoercions?.[0]?.applicability?.[0]?.callable;

    expect([...graph.diagnostics, ...analyzed.diagnostics]).toEqual([]);
    expect(aCallable?.symbol).toBe(bCallable?.symbol);
    expect(aCallable?.moduleId).toBe("std::a");
    expect(bCallable?.moduleId).toBe("std::b");
    expect(
      chosen?.borrowingCoercions?.map((coercion) => coercion.concrete.moduleId),
    ).toEqual(["std::b"]);
  });

  it("selects generic trait region specializations across modules", async () => {
    const srcRoot = resolve("/proj/src");
    const stdRoot = resolve("/proj/std");
    const host = createMemoryModuleHost({
      files: {
        [`${stdRoot}${sep}pkg.voyd`]: `
pub use self::views
pub use std::views::{ State, View }
`,
        [`${stdRoot}${sep}views.voyd`]: `
pub obj State<T> { api left: T, api right: T }

pub trait View<T>
  region source
  @borrow_contract(returns_from: source)
  fn get(self) -> borrow T

impl View<i32> for State<i32>
  region source = self.left

  fn get(self) -> borrow i32
    self.left

impl View<bool> for State<bool>
  region source = self.right

  fn get(self) -> borrow bool
    self.right
`,
        [`${srcRoot}${sep}main.voyd`]: `
use std::all

fn valid_i32() -> i32
  let ~state = State<i32> { left: 1, right: 2 }
  let view: View<i32> = state
  let item = view.get()
  state.right = 3
  item

fn invalid_i32() -> i32
  let ~state = State<i32> { left: 1, right: 2 }
  let view: View<i32> = state
  let item = view.get()
  state.left = 3
  item

fn valid_bool() -> bool
  let ~state = State<bool> { left: false, right: true }
  let view: View<bool> = state
  let item = view.get()
  state.left = true
  item

fn invalid_bool() -> bool
  let ~state = State<bool> { left: false, right: true }
  let view: View<bool> = state
  let item = view.get()
  state.right = false
  item

pub fn main() -> i32
  valid_i32()
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
    const coercions =
      Array.from(
        analyzed.semantics.get("std::pkg")?.exports.values() ?? [],
      ).find((entry) => entry.name === "State")?.borrowingCoercions ?? [];

    expect(
      diagnostics.filter((diagnostic) => diagnostic.code === "TY0048"),
    ).toHaveLength(2);
    expect(coercions).toHaveLength(2);
    expect(
      new Set(
        coercions.map((coercion) => JSON.stringify(coercion.implementation)),
      ),
    ).toHaveLength(2);
  });

  it("publishes conservative summaries for resumable effect operations", () => {
    const result = analyze(`
obj Box { value: i32 }

eff Inspect
  read(resume, value: borrow Box) -> i32
`);
    const operation = Array.from(result.hir.items.values())
      .flatMap((item) => (item.kind === "effect" ? item.operations : []))
      .find(() => true);
    const contract =
      operation === undefined
        ? undefined
        : result.borrowing.callables.get(operation.symbol);

    expect(contract).toMatchObject({
      maySuspend: true,
      parameters: [
        {
          access: "shared",
          readPaths: [[]],
          retained: true,
          returned: false,
        },
      ],
    });
    expect(
      diagnosticCodes(`
obj Box { value: i32 }

eff Inspect
  read(resume, value: borrow Box) -> borrow Box

fn invalid(value: borrow Box): Inspect -> i32
  let returned = Inspect::read(value)
  returned.value
`),
    ).toContain("TY0051");

    const tailResult = analyzeWithRecovery(`
obj Box { value: i32 }

eff Inspect
  read(tail, value: borrow Box) -> i32

fn helper(value: borrow Box): Inspect -> i32
  Inspect::read(value)
`);
    expect(
      tailResult.diagnostics.map((diagnostic) => diagnostic.code),
    ).toContain("TY0051");
    const helper = tailResult.binding.functions.find(
      (candidate) => candidate.name === "helper",
    );
    expect(
      helper === undefined
        ? undefined
        : tailResult.borrowing.callables.get(helper.symbol)?.parameters[0]
            ?.retained,
    ).toBe(true);
    expect(
      diagnosticCodes(`
obj Box { value: i32 }

fn mutate(~value: Box) -> void
  value.value = value.value + 1

eff Echo
  echo(tail, value: Box) -> Box

fn invalid(~value: Box): Echo -> i32
  let loan: borrow Box = value
  let ~returned = Echo::echo(value)
  mutate(~returned)
  loan.value
`),
    ).toContain("TY0048");
    const projectedResult = analyze(`
obj Box { value: i32 }
obj Holder { item: Box }

eff Echo
  echo(tail, value: Holder) -> Box
`);
    const projectedOperation = Array.from(projectedResult.hir.items.values())
      .flatMap((item) => (item.kind === "effect" ? item.operations : []))
      .find(() => true);
    expect(
      projectedOperation === undefined
        ? undefined
        : projectedResult.borrowing.callables.get(projectedOperation.symbol)
            ?.parameters[0]?.returnedOrigins,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: [{ kind: "field", name: "item" }],
          result: [],
          endpointAccess: "dereferenced",
        }),
      ]),
    );

    const recursiveResult = analyze(`
type Node = { value: i32, next: Node }

eff Echo
  echo(tail, value: Node) -> Node
`);
    const recursiveOperation = Array.from(recursiveResult.hir.items.values())
      .flatMap((item) => (item.kind === "effect" ? item.operations : []))
      .find(() => true);
    expect(
      recursiveOperation === undefined
        ? undefined
        : recursiveResult.borrowing.callables.get(recursiveOperation.symbol)
            ?.parameters[0]?.returnedOrigins,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: [{ kind: "field", name: "next" }],
          endpointAccess: "dereferenced",
        }),
      ]),
    );
  });

  it("uses imported contracts for local open-dispatch implementations", async () => {
    const srcRoot = resolve("/proj/src");
    const stdRoot = resolve("/proj/std");
    const host = createMemoryModuleHost({
      files: {
        [`${stdRoot}${sep}pkg.voyd`]: `
pub use self::views
pub use std::views::{ Item, View }
`,
        [`${stdRoot}${sep}views.voyd`]: `
pub obj Item { api value: i32 }

pub trait View
  region cursor
  region source
  disjoint cursor, source

  @borrow_contract(mutates: cursor, returns_from: source)
  fn next(~self) -> borrow Item
`,
        [`${srcRoot}${sep}main.voyd`]: `
use std::all

obj ItemView { cursor: i32, source: Item }

impl View for ItemView
  region cursor = self.cursor
  region source = deref(self.source)

  fn next(~self) -> borrow Item
    self.cursor = self.cursor + 1
    self.source

fn valid(~view: View) -> i32
  let first = view.next()
  let second = view.next()
  first.value + second.value
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
    const callerUsesRegions = Array.from(
      analyzed.semantics.get("src::main")?.borrowing.callables.values() ?? [],
    ).some((contract) =>
      contract.parameters.some((parameter) =>
        [...(parameter.readPaths ?? []), ...(parameter.writePaths ?? [])].some(
          (path) => path.some((projection) => projection.kind === "region"),
        ),
      ),
    );
    const localSemantics = analyzed.semantics.get("src::main");
    const localImplementation = Array.from(
      localSemantics?.borrowing.namedContracts.entries() ?? [],
    ).find(([, contract]) => contract.implementation !== undefined);
    const localDispatchScope =
      localImplementation === undefined
        ? undefined
        : localSemantics?.borrowing.callables.get(localImplementation[0])
            ?.dynamicDispatch?.parameters[0]?.writePaths?.[0]?.[0];
    expect(diagnostics).toEqual([]);
    expect(callerUsesRegions).toBe(true);
    expect(localDispatchScope).toMatchObject({
      kind: "region",
      scope: "std::views::View",
    });
  });

  const borrowedOptionPrelude = `
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None
obj Box { value: i32 }

fn mutate(~value: Box) -> void
  value.value = value.value + 1
`;

  it("accepts checked named regions and implementation mappings", () => {
    const result = analyze(`${namedContractPrelude}
impl ItemView for ViewState
  region cursor = self.cursor
  region source = deref(self.source)

  api fn next(~self) -> borrow Item
    self.cursor = self.cursor + 1
    self.source
`);

    const next = result.binding.functions.find((fn) => fn.name === "next");
    expect(next).toBeDefined();
    expect(result.borrowing.namedContracts.get(next!.symbol)).toMatchObject({
      reads: [],
      mutates: ["cursor"],
      returnsFrom: ["source"],
      regions: [
        { name: "cursor", parameter: 0 },
        { name: "source", parameter: 0 },
      ],
    });
  });

  it("requires returns_from for explicit borrowed trait results", () => {
    expect(
      diagnosticCodes(`
obj Item { value: i32 }
trait InvalidView
  region source
  @borrow_contract(reads: source)
  fn next(self) -> borrow Item
`),
    ).toContain("TY0054");
  });

  it("supports Option<borrow T> results under returns_from", () => {
    expect(
      diagnosticCodes(`
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None
obj Item { value: i32 }
obj ViewState { cursor: i32, source: Item }

trait ViewIterator<T>
  region cursor
  region source
  disjoint cursor, source
  @borrow_contract(mutates: cursor, returns_from: source)
  fn next(~self) -> Option<borrow T>

impl ViewIterator<Item> for ViewState
  region cursor = self.cursor
  region source = deref(self.source)
  api fn next(~self) -> Option<borrow Item>
    self.cursor = self.cursor + 1
    Some<borrow Item> { value: self.source }
`),
    ).toEqual([]);
  });

  it("supports generic borrowed views formed from allocation-mapped elements", () => {
    expect(
      diagnosticCodes(`
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None
obj ViewState<T> { cursor: i32, source: FixedArray<T> }

trait ViewIterator<T>
  region cursor
  region source
  disjoint cursor, source
  @borrow_contract(mutates: cursor, returns_from: source)
  fn next(~self) -> Option<borrow T>

impl<T> ViewIterator<T> for ViewState<T>
  region cursor = self.cursor
  region source = deref(self.source)
  api fn next(~self) -> Option<borrow T>
    let value: borrow T = __array_get(self.source, self.cursor)
    self.cursor = self.cursor + 1
    Some<borrow T> { value }
`),
    ).toEqual([]);
  });

  it("projects concrete implementation storage into returned trait regions", () => {
    const result = analyze(`
obj Item { value: i32 }
obj Owner { source: Item }
obj ConcreteView { source: Item, cursor: i32 }

trait View
  region cursor
  region source
  disjoint cursor, source
  @borrow_contract(mutates: cursor, returns_from: source)
  fn next(~self) -> borrow Item

impl View for ConcreteView
  region cursor = self.cursor
  region source = deref(self.source)

  api fn next(~self) -> borrow Item
    self.cursor = self.cursor + 1
    self.source

fn make_view(owner: Owner) -> View
  ConcreteView { source: owner.source, cursor: 0 }
`);
    const factory = result.binding.functions.find(
      (fn) => fn.name === "make_view",
    );
    const contract =
      factory === undefined
        ? undefined
        : result.borrowing.callables.get(factory.symbol);

    expect(contract?.parameters[0]?.returnedOrigins).toEqual([
      {
        source: [{ kind: "field", name: "source" }],
        result: [
          {
            kind: "region",
            scope: "borrowing.test.voyd::View",
            name: "source",
            disjoint: ["cursor"],
          },
        ],
        endpointAccess: "inline",
      },
    ]);
  });

  it("does not extend allocation-mapped regions through nested handles", () => {
    expect(
      diagnosticCodes(`
obj Leaf { value: i32 }
obj Wrapper { child: Leaf }
obj ViewState { source: FixedArray<Wrapper> }

trait LeafView
  region source
  @borrow_contract(returns_from: source)
  fn get(self) -> borrow Leaf

impl LeafView for ViewState
  region source = deref(self.source)
  api fn get(self) -> borrow Leaf
    __array_get(self.source, 0).child
`),
    ).toContain("TY0054");
  });

  it("checks declared reads independently from writes", () => {
    expect(
      diagnosticCodes(`
obj State { metadata: i32, hidden: i32 }
trait Reader
  region metadata
  @borrow_contract(reads: metadata)
  fn inspect(self) -> i32

impl Reader for State
  region metadata = self.metadata
  api fn inspect(self) -> i32
    self.metadata
`),
    ).toEqual([]);

    expect(
      diagnosticsFor(`
obj State { metadata: i32, hidden: i32 }
trait Reader
  region metadata
  @borrow_contract(reads: metadata)
  fn inspect(self) -> i32

impl Reader for State
  region metadata = self.metadata
  api fn inspect(self) -> i32
    self.hidden
`).map((diagnostic) => diagnostic.message),
    ).toEqual(
      expect.arrayContaining([expect.stringContaining("exceeds 'reads'")]),
    );
  });

  it("checks inherited trait default bodies against concrete mappings", () => {
    expect(
      diagnosticsFor(`
obj State { cursor: i32, hidden: i32 }
trait Advances
  region cursor
  @borrow_contract(mutates: cursor)
  fn advance(~self) -> void
    self.hidden = self.hidden + 1

impl Advances for State
  region cursor = self.cursor
`).map((diagnostic) => diagnostic.message),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("exceeds 'reads'"),
        expect.stringContaining("exceeds 'mutates'"),
      ]),
    );
  });

  it("uses declaration provenance in borrowed trait default bodies", () => {
    const source = `
obj Item { value: i32 }
obj State { source: Item }

trait View
  region source

  @borrow_contract(returns_from: source)
  fn current(~self) -> borrow Item

  @borrow_contract(returns_from: source)
  fn next(~self) -> borrow Item
    self.current()

impl View for State
  region source = deref(self.source)

  fn current(~self) -> borrow Item
    self.source
`;
    expect(diagnosticsFor(source)).toEqual([]);
  });

  it("fully borrow-checks trait default bodies", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }

fn mutate_both(~left: Box, ~right: Box) -> void
  left.value = right.value

trait InvalidDefault
  @borrow_contract()
  fn conflict(self, ~value: Box) -> i32
    mutate_both(~value, ~value)
    value.value
`),
    ).toContain("TY0048");
  });

  it("treats tail effect handlers as open retaining boundaries", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }

fn mutate(~value: Box) -> void
  value.value = value.value + 1

@intrinsic(name: "__retain_callback", uses_signature: true)
fn retain_callback(handler: fn() -> i32) -> i32
  0

eff Store
  store(tail, callback: fn() -> i32) -> i32

fn invalid(): () -> i32
  let ~box = Box { value: 0 }
  let callback = () =>
    mutate(~box)
    0
  let result =
    try
      Store::store(callback)
    Store::store(tail, callback):
      tail(retain_callback(callback))
  mutate(~box)
  result
`),
    ).toContain("TY0049");
  });

  it("identifies mutable captures passed through effect continuations", () => {
    const diagnostics = diagnosticsFor(`
obj Box { value: i32 }

fn mutate(~value: Box) -> void
  value.value = value.value + 1

eff Store
  load(tail) -> (fn() -> i32)

fn invalid(): () -> (fn() -> i32)
  let ~box = Box { value: 0 }
  let callback = () =>
    mutate(~box)
    0
  try
    Store::load()
  Store::load(tail):
    tail(callback)
`);
    const escape = diagnostics.find(
      (diagnostic) =>
        diagnostic.code === "TY0049" &&
        diagnostic.message.includes("effect continuation"),
    );

    expect(escape?.message).toContain("callback");
    expect(escape?.hints?.map((hint) => hint.message).join(" ")).toContain(
      "owned snapshot",
    );
    expect(escape?.hints?.map((hint) => hint.message).join(" ")).toContain(
      "SharedCell<T>",
    );
  });

  it("tracks ordinary aliases returned from module storage", () => {
    const result = analyzeWithRecovery(`
obj Box { value: i32 }
let box = Box { value: 0 }

fn mutate(~value: Box) -> void
  value.value = value.value + 1

fn get() -> Box
  box

fn wrapper() -> Box
  get()

fn invalid() -> i32
  let loan: borrow Box = box
  let ~returned = wrapper()
  mutate(~returned)
  loan.value
`);
    const externalEntry = Array.from(result.borrowing.callables).find(
      ([, contract]) => (contract.externalReturnedOrigins?.length ?? 0) > 0,
    );
    expect(externalEntry).toBeDefined();
    expect(externalEntry?.[1].externalReturnedOrigins).toHaveLength(1);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "TY0048",
    );
  });

  it("keeps plain external results as ordinary mutable values", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
let box = Box { value: 0 }

fn mutate(~value: Box) -> void
  value.value = value.value + 1

fn get() -> Box
  box

fn valid() -> i32
  let ~returned = get()
  mutate(~returned)
  returned.value
`),
    ).not.toContain("TY0050");
  });

  it("preserves external provenance through contextual borrow formation", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
let global = Box { value: 0 }

fn get_loan() -> Box
  global

fn get_direct() -> Box
  global

fn mutate(~value: Box) -> void
  value.value = value.value + 1

fn invalid() -> i32
  let loan: borrow Box = get_loan()
  let ~direct = get_direct()
  mutate(~direct)
  loan.value
`),
    ).toContain("TY0048");
  });

  it("propagates external returned aliases through dependency wrappers", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryModuleHost({
      files: {
        [`${root}${sep}storage.voyd`]: `
pub obj Box { api value: i32 }
let box = Box { value: 0 }

pub fn get() -> Box
  box
`,
        [`${root}${sep}main.voyd`]: `
use src::storage::{ Box, get }

fn mutate(~value: Box) -> void
  value.value = value.value + 1

fn wrapper() -> Box
  get()

fn valid() -> i32
  let ~returned = wrapper()
  mutate(~returned)
  returned.value
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
    expect([...graph.diagnostics, ...analyzed.diagnostics]).toEqual([]);
    expect(
      Array.from(
        analyzed.semantics.get("src::main")?.borrowing.callables.values() ?? [],
      ).some((contract) => (contract.externalReturnedOrigins?.length ?? 0) > 0),
    ).toBe(true);
  });

  it("seeds imported public storage as external provenance", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryModuleHost({
      files: {
        [`${root}${sep}storage.voyd`]: `
pub obj Box { api value: i32 }
pub let global = Box { value: 0 }
`,
        [`${root}${sep}main.voyd`]: `
use src::storage::{ Box, global }

fn mutate(~value: Box) -> void
  value.value = value.value + 1

fn wrapper() -> Box
  global

fn invalid() -> i32
  let loan: borrow Box = global
  let ~returned = wrapper()
  mutate(~returned)
  loan.value
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
    expect(
      [...graph.diagnostics, ...analyzed.diagnostics].map(
        (diagnostic) => diagnostic.code,
      ),
    ).toContain("TY0048");
  });

  it("includes external results for opaque callback boundaries", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
let box = Box { value: 0 }

fn mutate(~value: Box) -> void
  value.value = value.value + 1

fn invalid(getter: fn() -> Box) -> i32
  let ~returned = getter()
  let loan: borrow Box = box
  mutate(~returned)
  loan.value

fn trigger() -> i32
  invalid(() => box)
`),
    ).toContain("TY0048");
  });

  it("applies external wildcard origins to inline call results", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
let box = Box { value: 0 }

fn get() -> Box
  box

fn read(value: Box) -> i32
  value.value

fn mutate(~value: Box) -> void
  value.value = value.value + 1

fn invalid(~candidate: Box) -> i32
  let ~exclusive = candidate
  let observed = read(get())
  mutate(~exclusive)
  observed
`),
    ).toContain("TY0048");
  });

  it("keeps projected external origins distinct from fresh sibling fields", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
val Result { external: Box, fresh: Box }
let global = Box { value: 0 }

fn mutate(~value: Box) -> void
  value.value = value.value + 1

fn get() -> Result
  Result { external: global, fresh: Box { value: 0 } }

fn valid(~candidate: Box) -> i32
  let loan: borrow Box = candidate
  let result = get()
  let ~fresh = result.fresh
  mutate(~fresh)
  loan.value
`),
    ).not.toContain("TY0048");
  });

  it("keeps direct fresh sibling projections distinct from external results", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
val Result { external: Box, fresh: Box }
let global = Box { value: 0 }

fn mutate(~value: Box) -> void
  value.value = value.value + 1

fn get() -> Result
  Result { external: global, fresh: Box { value: 0 } }

fn valid(~candidate: Box) -> i32
  let loan: borrow Box = candidate
  let ~result = get()
  mutate(~result.fresh)
  loan.value
`),
    ).not.toContain("TY0048");
  });

  it("keeps helper-projected fresh fields distinct from external results", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
val Result { external: Box, fresh: Box }
let global = Box { value: 0 }

fn mutate_fresh(~result: Result) -> void
  result.fresh.value = result.fresh.value + 1

fn get() -> Result
  Result { external: global, fresh: Box { value: 0 } }

fn valid(~candidate: Box) -> i32
  let loan: borrow Box = candidate
  let ~result = get()
  mutate_fresh(~result)
  loan.value
`),
    ).not.toContain("TY0048");
  });

  it("serializes module-storage defaults without synthetic parameters", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryModuleHost({
      files: {
        [`${root}${sep}storage.voyd`]: `
pub obj Box { api value: i32 }
let global = Box { value: 0 }

pub fn get(value: Box = global) -> Box
  value
`,
        [`${root}${sep}main.voyd`]: `
use src::storage::{ get }

let selected = get()
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
    expect([...graph.diagnostics, ...analyzed.diagnostics]).toEqual([]);
    const storage = analyzed.semantics.get("src::storage");
    const exported = storage?.exports
      .get("get")
      ?.borrowing?.find(
        (entry) => entry.symbol === storage.exports.get("get")?.symbol,
      );
    const contract = exported?.contract;
    expect(contract?.parameters[0]?.defaultOrigins ?? []).toEqual([]);
    expect(
      contract?.parameters[0]?.defaultExternalReturnedOrigins ?? [],
    ).toEqual([]);
    expect(contract?.parameters[0]?.defaultExternalOrigins).toHaveLength(1);
  });

  it("applies parameter writes to omitted external defaults", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
let global = Box { value: 0 }

fn get() -> Box
  global

fn access(~left: Box, ~right: Box = global) -> void
  left.value = 1
  right.value = 2

fn invalid() -> void
  let ~candidate = get()
  access(~candidate)
`),
    ).toContain("TY0048");
  });

  it("does not alias fresh defaults with unrelated external storage", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
let global = Box { value: 0 }

fn fresh(
  values: FixedArray<Box> = __array_new<Box>(1)
) -> FixedArray<Box>
  values

fn mutate_array(~values: FixedArray<Box>) -> void
  __array_set(values, 0, Box { value: 1 })
  void

fn valid() -> i32
  let loan: borrow Box = global
  let ~values = fresh()
  mutate_array(~values)
  loan.value
`),
    ).not.toContain("TY0048");
  });

  it("does not activate chained external defaults after explicit override", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
let global = Box { value: 0 }

fn mutate(~value: Box) -> void
  value.value = value.value + 1

fn get(source: Box = global, selected: Box = source) -> Box
  selected

fn valid(~candidate: Box) -> i32
  let loan: borrow Box = candidate
  let ~returned = get(Box { value: 1 })
  mutate(~returned)
  loan.value
`),
    ).not.toContain("TY0048");
  });

  it("does not activate an upstream external default for a named override", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
let global = Box { value: 0 }

fn get(source: Box = global, selected: Box = source) -> Box
  selected

fn valid() -> i32
  let ~returned = get(selected: Box { value: 1 })
  returned.value
`),
    ).not.toContain("TY0048");
  });

  it("resolves external return provenance through omitted defaults", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
let global = Box { value: 0 }

fn mutate(~value: Box) -> void
  value.value = value.value + 1

fn get(value: Box = global) -> Box
  value

fn invalid() -> i32
  let loan: borrow Box = global
  let ~returned = get()
  mutate(~returned)
  loan.value
`),
    ).toContain("TY0048");
  });

  it("stops transitive default reads at an explicit intermediate override", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
let global = Box { value: 0 }

fn mutate(~value: Box) -> void
  value.value = value.value + 1

fn choose(
  source: Box = global,
  selected: Box = source,
  observed: i32 = selected.value
) -> i32
  observed

fn valid(~candidate: Box) -> i32
  let ~exclusive = candidate
  let observed = choose(selected: Box { value: 1 })
  mutate(~exclusive)
  observed
`),
    ).not.toContain("TY0048");
  });

  it("stops transitive default origins at an explicit intermediate override", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }

fn mutate(~value: Box) -> void
  value.value = value.value + 1

fn inspect(
  source: Box,
  middle: Box = source,
  target: Box = middle
) -> i32
  target.value

fn valid(~source: Box) -> i32
  let ~exclusive = source
  let observed = inspect(source, middle: Box { value: 1 })
  mutate(~exclusive)
  observed
`),
    ).not.toContain("TY0048");
  });

  it("resolves body access through every omitted-default edge", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }

fn mutate(~value: Box) -> void
  value.value = value.value + 1

fn inspect(
  source: Box,
  middle: Box = source,
  target: Box = middle
) -> i32
  target.value

fn invalid(~source: Box) -> i32
  let ~exclusive = source
  let observed = inspect(source)
  mutate(~exclusive)
  observed
`),
    ).toContain("TY0048");
  });

  it("does not apply dependent defaults after an explicit override", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }

fn mutate(~value: Box) -> void
  value.value = value.value + 1

fn select(source: Box, selected: Box = source) -> Box
  selected

fn valid(~source: Box) -> i32
  let loan: borrow Box = source
  let ~returned = select(source, selected: Box { value: 1 })
  mutate(~returned)
  loan.value
`),
    ).not.toContain("TY0048");
  });

  it("does not apply default-expression reads after an explicit override", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }

fn mutate(~value: Box) -> void
  value.value = value.value + 1

fn choose(source: Box, selected: i32 = source.value) -> i32
  selected

fn wrapper(source: Box) -> i32
  choose(source, 1)

fn valid(~source: Box) -> i32
  let ~exclusive = source
  let observed = wrapper(source)
  mutate(~exclusive)
  observed
`),
    ).not.toContain("TY0048");
  });

  it("abstracts private paths in unchecked trait implementation exports", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryModuleHost({
      files: {
        [`${root}${sep}storage.voyd`]: `
pub obj Box { api value: i32 }
pub obj Store { secret: Box }

pub trait Getter
  fn get(self) -> Box

impl Getter for Store
  api fn get(self) -> Box
    self.secret
`,
        [`${root}${sep}main.voyd`]: `
use src::storage::{ Getter }
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
    expect([...graph.diagnostics, ...analyzed.diagnostics]).toEqual([]);
    const serialized = Array.from(
      analyzed.semantics.get("src::storage")?.exports.values() ?? [],
    )
      .flatMap((entry) => entry.borrowing ?? [])
      .map((entry) => JSON.stringify(entry));
    expect(serialized.some((entry) => entry.includes("secret"))).toBe(false);
  });

  it("abstracts private paths in ordinary public callable exports", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryModuleHost({
      files: {
        [`${root}${sep}storage.voyd`]: `
pub obj Box { api value: i32 }
pub obj Store { secret: Box }

impl Store
  api fn get(self) -> Box
    self.secret

pub fn get_from(store: Store) -> Box
  store.secret
`,
        [`${root}${sep}main.voyd`]: `
use src::storage::{ Store }
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
    expect([...graph.diagnostics, ...analyzed.diagnostics]).toEqual([]);
    const serialized = Array.from(
      analyzed.semantics.get("src::storage")?.exports.values() ?? [],
    )
      .flatMap((entry) => entry.borrowing ?? [])
      .map((entry) => JSON.stringify(entry));
    expect(serialized.length).toBeGreaterThan(0);
    expect(serialized.some((entry) => entry.includes("secret"))).toBe(false);
  });

  it("does not redact public paths that share private field names", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryModuleHost({
      files: {
        [`${root}${sep}storage.voyd`]: `
pub obj Box { api value: i32 }
pub obj Pair { api left: Box, api right: Box }
obj Hidden { value: i32 }

impl Pair
  api fn mutate_left(~self) -> void
    self.left.value = self.left.value + 1
`,
        [`${root}${sep}main.voyd`]: `
use src::storage::{ Box, Pair }

fn valid() -> i32
  let ~pair = Pair {
    left: Box { value: 1 },
    right: Box { value: 2 }
  }
  let view: borrow Box = pair.right
  pair.mutate_left()
  view.value
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
    const serialized = Array.from(
      analyzed.semantics.get("src::storage")?.exports.values() ?? [],
    )
      .flatMap((entry) => entry.borrowing ?? [])
      .map((entry) => JSON.stringify(entry));

    expect(diagnostics).toEqual([]);
    expect(serialized.some((entry) => entry.includes('"left"'))).toBe(true);
    expect(
      serialized.some((entry) => entry.includes("voyd.summary.private")),
    ).toBe(false);
  });

  it("redacts private paths without obscuring unrelated public paths", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryModuleHost({
      files: {
        [`${root}${sep}storage.voyd`]: `
pub obj Box { api value: i32 }
pub obj Pair { api left: Box, api right: Box }
pub obj Secret { hidden: Box }

pub fn make_secret() -> Secret
  Secret { hidden: Box { value: 1 } }

pub fn mutate_left_with_secret(~pair: Pair, secret: Secret) -> void
  let adjustment = secret.hidden.value
  pair.left.value = pair.left.value + adjustment
`,
        [`${root}${sep}main.voyd`]: `
use src::storage::{
  Box,
  Pair,
  make_secret,
  mutate_left_with_secret
}

fn valid() -> i32
  let ~pair = Pair {
    left: Box { value: 1 },
    right: Box { value: 2 }
  }
  let view: borrow Box = pair.right
  mutate_left_with_secret(~pair, make_secret())
  view.value
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
    const serialized = Array.from(
      analyzed.semantics.get("src::storage")?.exports.values() ?? [],
    )
      .flatMap((entry) => entry.borrowing ?? [])
      .map((entry) => JSON.stringify(entry));

    expect([...graph.diagnostics, ...analyzed.diagnostics]).toEqual([]);
    expect(serialized.some((entry) => entry.includes('"left"'))).toBe(true);
    expect(serialized.some((entry) => entry.includes("hidden"))).toBe(false);
    expect(
      serialized.some((entry) => entry.includes("voyd.summary.private")),
    ).toBe(true);
  });

  it("redacts private paths after recursive public fields", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryModuleHost({
      files: {
        [`${root}${sep}storage.voyd`]: `
pub obj Box { api value: i32 }
pub obj Node { api next: Node, secret: Box }

impl Node
  api fn mutate_next_secret(~self) -> void
    self.next.secret.value = self.next.secret.value + 1
`,
        [`${root}${sep}main.voyd`]: `
use src::storage::{ Node }
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
    const serialized = Array.from(
      analyzed.semantics.get("src::storage")?.exports.values() ?? [],
    )
      .flatMap((entry) => entry.borrowing ?? [])
      .map((entry) => JSON.stringify(entry));

    expect([...graph.diagnostics, ...analyzed.diagnostics]).toEqual([]);
    expect(serialized.some((entry) => entry.includes("secret"))).toBe(false);
    expect(
      serialized.some((entry) => entry.includes("voyd.summary.private")),
    ).toBe(true);
  });

  it("redacts private paths in default external origins", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryModuleHost({
      files: {
        [`${root}${sep}storage.voyd`]: `
pub obj Box { api value: i32 }
pub obj Store { hidden: Box }
let global = Box { value: 0 }

fn default_store() -> Store
  Store { hidden: global }

pub fn consume(store: Store = default_store()) -> i32
  0
`,
        [`${root}${sep}main.voyd`]: `
use src::storage::{ consume }
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
    const serialized = Array.from(
      analyzed.semantics.get("src::storage")?.exports.values() ?? [],
    )
      .flatMap((entry) => entry.borrowing ?? [])
      .map((entry) => JSON.stringify(entry));

    expect([...graph.diagnostics, ...analyzed.diagnostics]).toEqual([]);
    expect(serialized.some((entry) => entry.includes("hidden"))).toBe(false);
    expect(
      serialized.some((entry) => entry.includes("voyd.summary.private")),
    ).toBe(true);
  });

  it("preserves hidden reference crossings without exposing private paths", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryModuleHost({
      files: {
        [`${root}${sep}storage.voyd`]: `
pub obj Box { api value: i32 }
pub obj Holder { hidden: Box }

impl Holder
  api fn mutate_hidden(~self) -> void
    self.hidden.value = self.hidden.value + 1

  api fn replace_hidden(~self, replacement: Box) -> void
    self.hidden = replacement

pub fn wrap(value: Box) -> Holder
  Holder { hidden: value }
`,
        [`${root}${sep}main.voyd`]: `
use src::storage::{ Box, Holder, wrap }

fn invalid(~value: Box) -> i32
  let loan: borrow Box = value
  let ~holder = wrap(value)
  holder.mutate_hidden()
  loan.value

fn valid(~value: Box) -> i32
  let loan: borrow Box = value
  let ~holder = wrap(value)
  holder.replace_hidden(Box { value: 0 })
  loan.value
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
    const serialized = Array.from(
      analyzed.semantics.get("src::storage")?.exports.values() ?? [],
    )
      .flatMap((entry) => entry.borrowing ?? [])
      .map((entry) => JSON.stringify(entry));

    expect(
      diagnostics.filter((diagnostic) => diagnostic.code === "TY0048"),
    ).toHaveLength(1);
    expect(serialized.some((entry) => entry.includes("hidden"))).toBe(false);
    expect(
      serialized.some((entry) => entry.includes("voyd.summary.private")),
    ).toBe(true);
  });

  it("does not use fresh wrappers to separate shared hidden allocations", async () => {
    const root = resolve("/proj/src");
    const storage = `
pub obj Box { api value: i32 }
pub obj Wrap { box: Box }
pub obj InlineWrap { count: i32 }

impl Wrap
  api fn bump(~self) -> void
    self.box.value = self.box.value + 1

impl InlineWrap
  api fn bump(~self) -> void
    self.count = self.count + 1

pub fn make_box() -> Box
  Box { value: 0 }

pub fn wrap(box: Box) -> Wrap
  Wrap { box }

pub fn make_inline() -> InlineWrap
  InlineWrap { count: 0 }

pub fn mutate_both(~left: Wrap, ~right: Wrap) -> void
  left.bump()
  right.bump()

pub fn mutate_inline_both(
  ~left: InlineWrap,
  ~right: InlineWrap
) -> void
  left.bump()
  right.bump()
`;
    const analyzeCaller = async (source: string) => {
      const host = createMemoryModuleHost({
        files: {
          [`${root}${sep}storage.voyd`]: storage,
          [`${root}${sep}main.voyd`]: source,
        },
        pathAdapter: createNodePathAdapter(),
      });
      const graph = await loadModuleGraph({
        entryPath: `${root}${sep}main.voyd`,
        roots: { src: root },
        host,
      });
      return { graph, analyzed: analyzeModules({ graph }) };
    };
    const invalid = await analyzeCaller(`
use src::storage::all

fn invalid() -> void
  let ~box = make_box()
  let ~left = wrap(box)
  let ~right = wrap(box)
  mutate_both(~left, ~right)
`);
    const valid = await analyzeCaller(`
use src::storage::all

fn valid() -> void
  let ~left = make_inline()
  let ~right = make_inline()
  mutate_inline_both(~left, ~right)
`);
    expect(
      [...invalid.graph.diagnostics, ...invalid.analyzed.diagnostics].some(
        (diagnostic) => diagnostic.code === "TY0048",
      ),
    ).toBe(true);
    expect([...valid.graph.diagnostics, ...valid.analyzed.diagnostics]).toEqual(
      [],
    );
  });

  it("checks nonempty default contracts against declared regions", () => {
    expect(
      diagnosticsFor(`
trait Advances
  region cursor
  region source

  @borrow_contract(mutates: source)
  fn touch_source(~self) -> void

  @borrow_contract(mutates: cursor)
  fn advance(~self) -> void
    self.touch_source()
`).map((diagnostic) => diagnostic.message),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "exceeds 'mutates' at place 'self.<region source>'",
        ),
      ]),
    );
  });

  it("rejects false disjointness and missing mappings", () => {
    const falseDisjointSource = `${namedContractPrelude}
impl ItemView for ViewState
  region cursor = self.cursor
  region source = self.cursor

  api fn next(~self) -> borrow Item
    self.source
`;
    expect(
      diagnosticsFor(falseDisjointSource).map(
        (diagnostic) => diagnostic.message,
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("falsely declares region 'cursor'"),
      ]),
    );
    const recovered = analyzeWithRecovery(falseDisjointSource);
    const next = recovered.binding.functions.find((fn) => fn.name === "next");
    expect(next).toBeDefined();
    expect(
      recovered.borrowing.namedContracts.get(next!.symbol)?.disjoint,
    ).toEqual([]);
    expect(
      diagnosticsFor(`${namedContractPrelude}
impl ItemView for ViewState
  region cursor = self.cursor

  api fn next(~self) -> borrow Item
    self.source
`).map((diagnostic) => diagnostic.message),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("no place mapping for region 'source'"),
      ]),
    );

    const recursiveSource = `
obj Node { cursor: i32, source: Node }
trait NodeView
  region cursor
  region source
  disjoint cursor, source
  @borrow_contract(reads: source, mutates: cursor)
  fn inspect(~self) -> i32

impl NodeView for Node
  region cursor = self.cursor
  region source = deref(self.source)
  api fn inspect(~self) -> i32
    self.cursor
`;
    expect(
      diagnosticsFor(recursiveSource).map((diagnostic) => diagnostic.message),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("falsely declares region 'cursor'"),
      ]),
    );
  });

  it("rejects a region declared disjoint from itself without an implementation", () => {
    expect(
      diagnosticsFor(`
trait ImpossibleView
  region source
  disjoint source, source
  @borrow_contract(reads: source)
  fn inspect(self) -> i32
`).map((diagnostic) => diagnostic.message),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "falsely declares region 'source' disjoint from itself",
        ),
      ]),
    );
  });

  it("rejects deref mappings that are not definitely allocation-backed", () => {
    expect(
      diagnosticsFor(`
obj GenericState<T> { source: T }
trait GenericView<T>
  region source
  @borrow_contract(reads: source)
  fn inspect(self) -> i32

impl<T> GenericView<T> for GenericState<T>
  region source = deref(self.source)
  api fn inspect(self) -> i32
    0
`).map((diagnostic) => diagnostic.message),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "deref(...) requires a definitely allocation-backed handle slot",
        ),
      ]),
    );

    expect(
      diagnosticsFor(`
obj Item { value: i32 }
obj MixedState { source: Item | i32 }
trait MixedView
  region source
  @borrow_contract(reads: source)
  fn inspect(self) -> i32

impl MixedView for MixedState
  region source = deref(self.source)
  api fn inspect(self) -> i32
    0
`).map((diagnostic) => diagnostic.message),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "deref(...) requires a definitely allocation-backed handle slot",
        ),
      ]),
    );

    expect(
      diagnosticsFor(`
trait Marker
  fn marker(self) -> i32

val Inline { value: i32 }
impl Marker for Inline
  api fn marker(self) -> i32
    self.value

obj GenericState<T: Marker> { source: T }
trait GenericView<T: Marker>
  region source
  @borrow_contract(reads: source)
  fn inspect(self) -> i32

impl<T: Marker> GenericView<T> for GenericState<T>
  region source = deref(self.source)
  api fn inspect(self) -> i32
    0
`).map((diagnostic) => diagnostic.message),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "deref(...) requires a definitely allocation-backed handle slot",
        ),
      ]),
    );
  });

  it("requires explicit, universally valid contract-place projections", () => {
    expect(
      diagnosticsFor(`
obj Item { value: i32 }
obj State { source: Item }
trait View
  region source
  @borrow_contract(reads: source)
  fn inspect(self) -> i32

impl View for State
  region source = self.source.value
  api fn inspect(self) -> i32
    0
`).map((diagnostic) => diagnostic.message),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "projection 'value' crosses a handle slot; use explicit deref(...)",
        ),
      ]),
    );

    expect(
      diagnosticsFor(`
obj Item { value: i32 }
obj State { source: Item }
trait View
  region source
  @borrow_contract(reads: source)
  fn inspect(self) -> i32

impl View for State
  region source = deref(deref(self.source))
  api fn inspect(self) -> i32
    0
`).map((diagnostic) => diagnostic.message),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "deref(...) requires a definitely allocation-backed handle slot",
        ),
      ]),
    );

    expect(
      diagnosticsFor(`
val WithValue { value: i32 }
val WithoutValue { other: i32 }
obj State { source: WithValue | WithoutValue }
trait View
  region source
  @borrow_contract(reads: source)
  fn inspect(self) -> i32

impl View for State
  region source = self.source.value
  api fn inspect(self) -> i32
    0
`).map((diagnostic) => diagnostic.message),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "projection 'value' must exist on every possible mapped type",
        ),
      ]),
    );
  });

  it("maps fields contributed by structural intersections", () => {
    const source = `
obj Base { base: i32 }
type Extended = Base & { extra: i32 }
trait ExtraView
  region extra
  @borrow_contract(reads: extra)
  fn inspect(self) -> i32

impl ExtraView for Extended
  region extra = self.extra
  api fn inspect(self) -> i32
    self.extra
`;
    expect(
      diagnosticsFor(source).map((diagnostic) => diagnostic.message),
    ).toEqual([]);
  });

  it("does not let a dereferenced region cover a whole-receiver read", () => {
    expect(
      diagnosticsFor(`
obj Item { value: i32 }
obj State { source: Item }
trait Reader
  region source
  @borrow_contract(reads: source)
  fn inspect(self, callback: fn(State) : () -> i32) -> i32

impl Reader for State
  region source = deref(self.source)
  api fn inspect(self, callback: fn(State) : () -> i32) -> i32
    callback(self)
`).map((diagnostic) => diagnostic.message),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("exceeds 'reads' at place 'self'"),
      ]),
    );
  });

  it("checks declaration-only trait default provenance", () => {
    const source = `
obj Item { value: i32 }
trait LeakyDefault
  region source
  @borrow_contract(returns_from: source)
  fn view(self, value: borrow Item) -> borrow Item
    value
`;
    expect(
      diagnosticsFor(source).map((diagnostic) => diagnostic.message),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "exceeds 'returns_from' at place 'parameter[1]",
        ),
      ]),
    );
  });

  it("checks access-free default contracts without an implementation", () => {
    expect(
      diagnosticsFor(`
trait Reader
  fn read(self) -> i32

  @borrow_contract()
  fn inspect(self) -> i32
    self.read()
`).map((diagnostic) => diagnostic.message),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("exceeds 'reads' at place 'self'"),
      ]),
    );
  });

  it("rejects invalid mappings and misplaced contract annotations", () => {
    expect(
      diagnosticsFor(`${namedContractPrelude}
impl ItemView for ViewState
  region cursor = deref(self.cursor)
  region source = deref(self.missing)

  api fn next(~self) -> borrow Item
    self.source
`).map((diagnostic) => diagnostic.message),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "region 'cursor' to invalid place 'deref(self.cursor)'",
        ),
        expect.stringContaining(
          "region 'source' to invalid place 'deref(self.missing)'",
        ),
      ]),
    );

    expect(
      diagnosticsFor(`
@borrow_contract(reads: source)
fn inspect(value: i32) -> i32
  value
`).map((diagnostic) => diagnostic.message),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("is not a trait method"),
      ]),
    );

    expect(
      diagnosticsFor(`
obj State { value: i32 }
trait StaticReader
  region source
  @borrow_contract(reads: source)
  fn inspect(value: State) -> i32
`).map((diagnostic) => diagnostic.message),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("has no instance 'self' receiver"),
      ]),
    );

    expect(
      diagnosticsFor(`
obj State { value: i32 }
impl State
  @borrow_contract()
  fn inspect(self) -> i32
    self.value
`).map((diagnostic) => diagnostic.message),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("is not a trait method"),
      ]),
    );

    expect(
      diagnosticsFor(`${namedContractPrelude}
impl ItemView for ViewState
  region cursor = self.cursor
  region source = deref(self.source)

  @borrow_contract(mutates: cursor, returns_from: source)
  api fn next(~self) -> borrow Item
    self.source
`).map((diagnostic) => diagnostic.message),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("implementations inherit"),
      ]),
    );
  });

  it("checks imported contracted overrides and accepts imported defaults", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryModuleHost({
      files: {
        [`${root}${sep}views.voyd`]: `
pub trait Reader
  region visible
  @borrow_contract(reads: visible)
  fn inspect(self) -> i32

pub trait PureView
  region state
  @borrow_contract()
  fn count(self) -> i32
    1
`,
        [`${root}${sep}main.voyd`]: `
use src::views::{ Reader, PureView }

obj State { visible: i32, hidden: i32 }
obj Empty {}

impl Reader for State
  region visible = self.visible
  api fn inspect(self) -> i32
    self.hidden

impl PureView for Empty
  region state = self
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

    expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual(
      expect.arrayContaining([expect.stringContaining("exceeds 'reads'")]),
    );
  });

  it("accepts an empty contract for an access-free implementation", () => {
    expect(
      diagnosticCodes(`
obj State {}
trait PureView
  @borrow_contract()
  fn count(self) -> i32

impl PureView for State
  api fn count(self) -> i32
    1
`),
    ).toEqual([]);
  });

  it("does not treat borrowed callback parameters as returned provenance", () => {
    expect(
      diagnosticCodes(`
obj Item { value: i32 }
obj State {}
trait CallbackFactory
  @borrow_contract()
  fn make(self) -> (fn(borrow Item) : () -> void)
`),
    ).toEqual([]);
  });

  it("rejects excess mutation and returned provenance", () => {
    expect(
      diagnosticsFor(`${namedContractPrelude}
impl ItemView for ViewState
  region cursor = self.cursor
  region source = deref(self.source)

  api fn next(~self) -> borrow Item
    self.source.value = self.source.value + 1
    self.source
`).map((diagnostic) => diagnostic.message),
    ).toEqual(
      expect.arrayContaining([expect.stringContaining("exceeds 'mutates'")]),
    );

    expect(
      diagnosticsFor(`
obj Item { value: i32 }
obj PairView { cursor: i32, source: Item, other: Item }
trait ItemView
  region cursor
  region source
  disjoint cursor, source
  @borrow_contract(mutates: cursor, returns_from: source)
  fn next(~self) -> borrow Item

impl ItemView for PairView
  region cursor = self.cursor
  region source = deref(self.source)
  api fn next(~self) -> borrow Item
    self.cursor = self.cursor + 1
    self.other
`).map((diagnostic) => diagnostic.message),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("exceeds 'returns_from'"),
      ]),
    );

    expect(
      diagnosticsFor(`${namedContractPrelude}
impl ItemView for ViewState
  region cursor = self.cursor
  region source = deref(self.source)

  api fn next(~self) -> borrow Item
    Item { value: 0 }
`).map((diagnostic) => diagnostic.message),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "exceeds 'returns_from' at place '<external provenance>'",
        ),
      ]),
    );
  });

  it("retains explicit borrowed results through their final use", () => {
    expect(
      diagnosticCodes(`${borrowedOptionPrelude}
fn view(value: Box) -> borrow Box
  value

fn invalid(~value: Box) -> i32
  let borrowed = view(value)
  mutate(~value)
  borrowed.value
`),
    ).toContain("TY0048");

    expect(() =>
      analyze(`${borrowedOptionPrelude}
fn view(value: Box) -> borrow Box
  value

fn valid(~value: Box) -> i32
  let borrowed = view(value)
  let result = borrowed.value
  mutate(~value)
  result
`),
    ).not.toThrow();
  });

  it("retains every possible origin of a conditional borrowed value", () => {
    expect(
      diagnosticCodes(`${borrowedOptionPrelude}
fn invalid(flag: bool, ~left: Box, ~right: Box) -> i32
  let chosen: borrow Box =
    if flag:
      left
    else:
      right
  mutate(~left)
  chosen.value
`),
    ).toContain("TY0048");
  });

  it("tracks borrows formed by local annotations and aggregate fields", () => {
    expect(
      diagnosticCodes(`${borrowedOptionPrelude}
fn invalid(~value: Box) -> i32
  let borrowed: borrow Box = value
  mutate(~value)
  borrowed.value
`),
    ).toContain("TY0048");

    expect(
      diagnosticCodes(`${borrowedOptionPrelude}
obj View { value: borrow Box }

fn invalid(~value: Box) -> i32
  let view: View = View { value }
  mutate(~value)
  view.value.value
`),
    ).toContain("TY0048");
  });

  it("retains returned object allocations without borrowing handle slots", () => {
    expect(() =>
      analyze(`${borrowedOptionPrelude}
fn view(value: Box) -> borrow Box
  value

fn valid() -> i32
  var source = Box { value: 1 }
  let borrowed = view(source)
  source = Box { value: 2 }
  borrowed.value
`),
    ).not.toThrow();

    expect(() =>
      analyze(`${borrowedOptionPrelude}
obj Holder { child: Box }

fn view(value: Box) -> borrow Box
  value

fn valid(~holder: Holder) -> i32
  let borrowed = view(holder.child)
  holder.child = Box { value: 2 }
  borrowed.value
`),
    ).not.toThrow();

    expect(
      diagnosticCodes(`${borrowedOptionPrelude}
obj Holder { child: Box }

fn view(value: Box) -> borrow Box
  value

fn invalid(~holder: Holder) -> i32
  let ~alias = holder.child
  let borrowed = view(holder.child)
  mutate(~alias)
  borrowed.value
`),
    ).toContain("TY0048");
  });

  it("prefers exact owned overloads over contextual borrow formation", () => {
    expect(() =>
      analyze(`
obj Box { value: i32 }

fn pick(value: Box) -> i32
  1

fn pick(value: borrow Box) -> i32
  2

fn selected_owned(value: Box) -> i32
  pick(value)

fn selected_borrowed(value: borrow Box) -> i32
  pick(value)
`),
    ).not.toThrow();
  });

  it("retains explicit borrowed results through generic call boundaries", () => {
    expect(
      diagnosticCodes(`${borrowedOptionPrelude}
fn view<T>(value: borrow T) -> borrow T
  value

fn invalid(~value: Box) -> i32
  let borrowed = view<Box>(value)
  mutate(~value)
  borrowed.value
`),
    ).toContain("TY0048");

    expect(
      diagnosticCodes(`
fn forward<T>(value: borrow T) -> borrow T
  value

fn mutate(~value: i32) -> void
  value = value + 1

fn invalid(~value: i32) -> i32
  let borrowed = forward<i32>(value)
  mutate(~value)
  borrowed + 1
`),
    ).toContain("TY0048");
  });

  it("treats forwarding through borrowed parameters as a shared use", () => {
    expect(
      diagnosticCodes(`${borrowedOptionPrelude}
fn view(value: Box) -> borrow Box
  value

fn forward(value: borrow Box) -> borrow Box
  value

fn invalid(~value: Box) -> void
  let borrowed = view(value)
  mutate(~value)
  let _ = forward(borrowed)
`),
    ).toContain("TY0048");

    expect(
      diagnosticCodes(`
fn overwrite(~value: i32) -> void
  value = value + 1

fn forward(value: borrow i32, ~other: i32) -> borrow i32
  overwrite(~other)
  value

fn invalid(~value: i32) -> void
  let _ = forward(value, ~value)
`),
    ).toContain("TY0048");
  });

  it("serializes retained provenance for explicit borrowed scalar results", () => {
    const result = analyze(`
fn view(value: borrow i32) -> borrow i32
  value
`);

    expect(
      Array.from(result.borrowing.callables.values()).some(
        (contract) =>
          (contract.parameters[0]?.returnedSharedOrigins?.length ?? 0) > 0,
      ),
    ).toBe(true);
  });

  it("materializes borrowed values only for bounded read operations", () => {
    expect(() =>
      analyze(`
obj Box { value: i32 }

impl Box
  fn read(self) -> i32
    self.value

fn read_scalar(value: borrow i32) -> i32
  value + 1

fn read_box(value: borrow Box) -> i32
  value.read()
`),
    ).not.toThrow();

    expect(
      diagnosticCodes(`
obj Box { value: i32 }

impl Box
  fn conceal(self) -> Box
    self

fn invalid(value: borrow Box) -> Box
  value.conceal()
`),
    ).toContain("TY0051");
  });

  it("materializes borrowed primitives in bounded value contexts", () => {
    expect(() =>
      analyze(`
fn read(value: i32) -> i32
  value

fn branch(flag: borrow bool) -> i32
  if flag:
    1
  else:
    2

fn copy(value: borrow i32) -> i32
  read(value)

fn direct(value: borrow i32) -> i32
  value
`),
    ).not.toThrow();

    expect(() =>
      analyze(`
val Out { value: i32 }
obj Holder { value: i32 }

fn local(value: borrow i32) -> i32
  let result: i32 = value
  result

fn aggregate(value: borrow i32) -> Out
  Out { value }

fn store(~holder: Holder, value: borrow i32) -> void
  holder.value = value

fn mutate(~value: i32) -> void
  value = value + 1

fn assignment(~source: i32) -> i32
  let borrowed: borrow i32 = source
  var result: i32 = 0
  result = borrowed
  mutate(~source)
  result
`),
    ).not.toThrow();
  });

  it("rejects borrowed recursion that erases to an unbounded layout", () => {
    expect(() =>
      analyze(`
type Loop = borrow Loop

fn id(value: Loop) -> Loop
  value
`),
    ).toThrow("not contractive");

    expect(
      diagnosticCodes(`
val Node { next: borrow Node }

fn id(value: Node) -> Node
  value
`).length,
    ).toBeGreaterThan(0);
  });

  it("materializes plain projected handles through concrete methods", () => {
    expect(() =>
      analyze(`
obj Child { value: i32 }
obj Parent { child: Child }

impl Parent
  fn child(self) -> Child
    self.child

fn valid(parent: borrow Parent) -> Child
  parent.child()
`),
    ).not.toThrow();
  });

  it("materializes plain projected handles through overloaded operators", () => {
    expect(() =>
      analyze(`
obj Child { value: i32 }
obj Parent { child: Child }

impl Parent
  fn '+'(self, _offset: i32) -> Child
    self.child

fn valid(parent: borrow Parent) -> Child
  parent + 0
`),
    ).not.toThrow();
  });

  it("copies plain fields out of explicitly borrowed values", () => {
    expect(() =>
      analyze(`
obj Box { value: i32 }
obj Container { child: Box }

fn read_scalar(value: borrow Box) -> i32
  value.value

fn read_handle(value: borrow Container) -> Box
  value.child
`),
    ).not.toThrow();
  });

  it("keeps copied plain projections ordinary through bindings and aggregates", () => {
    expect(() =>
      analyze(`
obj Box { value: i32 }
obj Container { child: Box }
obj Out { child: Box }
obj Holder { child: Box }
type Callback = fn() : () -> i32

fn copy(value: borrow Container) -> Out
  Out { child: value.child }

fn capture(value: borrow Holder) -> Callback
  let child = value.child
  () => child.value
`),
    ).not.toThrow();
  });

  it("copies plain callback handles from borrowed object fields", () => {
    expect(() =>
      analyze(`
type Callback = fn() : () -> i32
obj Holder { callback: Callback }

fn extract(holder: borrow Holder) -> Callback
  holder.callback
`),
    ).not.toThrow();
  });

  it("tracks Option<borrow T> only through its Some payload", () => {
    expect(
      diagnosticCodes(`${borrowedOptionPrelude}
fn some_view(value: Box) -> Option<borrow Box>
  Some<borrow Box> { value }

fn invalid(~value: Box) -> i32
  let result = some_view(value)
  mutate(~value)
  match(result)
    Some<borrow Box> { value: borrowed }:
      borrowed.value
    None:
      0
`),
    ).toContain("TY0048");

    expect(() =>
      analyze(`${borrowedOptionPrelude}
fn no_view(value: Box) -> Option<borrow Box>
  None {}

fn valid(~value: Box) -> i32
  let result = no_view(value)
  mutate(~value)
  match(result)
    Some<borrow Box> { value: borrowed }:
      borrowed.value
    None:
      0
`),
    ).not.toThrow();
  });

  it("keeps borrow Option<T> distinct from Option<borrow T>", () => {
    const result = analyze(`${borrowedOptionPrelude}
fn whole(value: Option<Box>) -> borrow Option<Box>
  value

fn payload(value: Box) -> Option<borrow Box>
  Some<borrow Box> { value }
`);
    const signatures = Array.from(
      result.typing.functions.signatures,
      ([, signature]) => signature,
    );
    const whole = signatures.find((signature) => {
      const descriptor = result.typing.arena.get(signature.returnType);
      return descriptor.kind === "borrowed";
    });
    const payload = signatures.find((signature) => {
      const descriptor = result.typing.arena.get(signature.returnType);
      return (
        descriptor.kind === "union" &&
        descriptor.members.some((member) => {
          const nominal = result.typing.arena.nominalComponent(member);
          const info =
            typeof nominal === "number"
              ? result.typing.objectsByNominal.get(nominal)
              : undefined;
          return info?.fields.some(
            (field) => result.typing.arena.get(field.type).kind === "borrowed",
          );
        })
      );
    });

    expect(whole).toBeDefined();
    expect(payload).toBeDefined();
    expect(whole?.returnType).not.toBe(payload?.returnType);
  });

  it("pattern matches borrowed aggregate unions through their inner type", () => {
    expect(() =>
      analyze(`${borrowedOptionPrelude}
fn read(option: borrow Option<i32>) -> i32
  match(option)
    Some<i32> { value }:
      value
    None:
      0
`),
    ).not.toThrow();
  });

  it("keeps plain mutable projections from borrowed patterns as values", () => {
    expect(
      diagnosticCodes(`${borrowedOptionPrelude}
obj Child { value: i32 }
obj Parent { child: Child }

impl Parent
  fn project_child(self) -> Child
    self.child

fn mutate_child(~child: Child) -> void
  child.value = child.value + 1

fn identity<T>(value: T) -> T
  value

fn valid(option: Option<borrow Parent>) -> i32
  match(option)
    Some<borrow Parent> { value: borrowed }:
      let ~child = borrowed.child
      mutate_child(~child)
      child.value
    None:
      0

fn valid_result(option: Option<borrow Parent>) -> i32
  let ~child =
    match(option)
      Some<borrow Parent> { value: borrowed }:
        borrowed.child
      None:
        Child { value: 0 }
  mutate_child(~child)
  child.value

fn valid_call(parent: borrow Parent) -> i32
  let ~child = parent.project_child()
  mutate_child(~child)
  child.value

fn valid_generic(parent: borrow Parent) -> i32
  let ~child = identity(parent.child)
  mutate_child(~child)
  child.value
`),
    ).not.toContain("TY0050");
  });

  it("preserves every borrowed layer in nested borrowed types", () => {
    const result = analyze(`${borrowedOptionPrelude}
fn nested(value: Option<borrow Box>) -> borrow Option<borrow Box>
  value
`);
    const signature = Array.from(
      result.typing.functions.signatures,
      ([, candidate]) => candidate,
    ).find(
      (candidate) =>
        result.typing.arena.get(candidate.returnType).kind === "borrowed",
    );
    expect(signature).toBeDefined();

    const entries = signature
      ? borrowedTypeEntriesInType(signature.returnType, result.typing)
      : [];
    expect(entries.some(({ path }) => path.length === 0)).toBe(true);
    expect(
      entries.some(({ path }) =>
        path.some(
          (projection) =>
            projection.kind === "field" && projection.name === "value",
        ),
      ),
    ).toBe(true);
  });

  it("rejects explicit borrowed escape and local lifetime extension", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj Holder { value: borrow Box }

fn invalid(~holder: Holder, value: borrow Box) -> void
  holder.value = value
`),
    ).toContain("TY0051");

    expect(
      diagnosticCodes(`
obj Box { value: i32 }

fn invalid() -> borrow Box
  let local = Box { value: 1 }
  local
`),
    ).toContain("TY0051");

    expect(
      diagnosticCodes(`
fn invalid(value: i32) -> borrow i32
  value
`),
    ).toContain("TY0051");

    expect(
      diagnosticCodes(`
fn invalid() -> borrow i32
  1
`),
    ).toContain("TY0051");

    expect(() =>
      analyze(`
fn valid(value: borrow i32) -> borrow i32
  value
`),
    ).not.toThrow();

    expect(() =>
      analyze(`
obj Box { value: i32 }

fn valid(owner: Box) -> borrow i32
  owner.value
`),
    ).not.toThrow();

    expect(
      diagnosticCodes(`
fn invalid(flag: bool, external: borrow i32) -> i32
  var view: borrow i32 = external
  if flag:
    let local = 1
    view = local
  view + 1
`),
    ).toContain("TY0051");
  });

  it("rejects originless borrowed parameter defaults", () => {
    expect(
      diagnosticCodes(`
fn read(value: borrow i32 = 1) -> i32
  value + 1

fn invalid() -> i32
  read()
`),
    ).toContain("TY0051");
  });

  it("requires stable storage when forming borrowed call arguments", () => {
    expect(
      diagnosticCodes(`
fn read(value: borrow i32) -> i32
  0

fn invalid() -> i32
  read(1)
`),
    ).toContain("TY0051");

    expect(
      diagnosticCodes(`
fn read(value: borrow i32) -> i32
  0

fn invalid() -> i32
  let borrowed: borrow i32 = 1
  read(borrowed)
`),
    ).toContain("TY0051");

    expect(
      diagnosticCodes(`
fn read(value: borrow i32) -> i32
  0

fn invalid(value: i32) -> i32
  var borrowed: borrow i32 = value
  borrowed = 1
  read(borrowed)
`),
    ).toContain("TY0051");

    expect(
      diagnosticCodes(`
obj View { value: borrow i32 }

fn invalid() -> i32
  let view: View = View { value: 1 }
  0
`),
    ).toContain("TY0051");

    expect(() =>
      analyze(`
fn read(value: borrow i32) -> i32
  0

fn valid() -> i32
  let value = 1
  read(value)
`),
    ).not.toThrow();

    expect(
      diagnosticCodes(`
obj View { value: borrow i32 }

fn read(view: View) -> i32
  view.value + 0

fn invalid() -> i32
  read(View { value: 1 })
`),
    ).toContain("TY0051");
  });

  it("treats explicit borrowed callable parameters as non-retaining", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
type Sink = fn(borrow Box) : () -> void

fn valid(value: Box, sink: Sink) -> void
  sink(value)
`),
    ).not.toContain("TY0051");

    expect(
      diagnosticCodes(`
obj Box { value: i32 }

fn mutate(~value: Box) -> void
  value.value = value.value + 1

fn valid(~value: borrow Box) -> i32
  mutate(~value)
  value.value
`),
    ).not.toContain("TY0051");

    expect(
      diagnosticCodes(`
obj Box { value: i32 }

impl Box
  fn set(~self, value: i32) -> void
    self.value = value

fn valid(~value: borrow Box) -> i32
  value.set(2)
  value.value
`),
    ).not.toContain("TY0051");

    expect(
      diagnosticCodes(`
obj Box { value: i32 }

fn mutate(~value: Box) -> void
  value.value = value.value + 1

fn invalid(~value: Box, storage: FixedArray<borrow Box>) -> i32
  __array_set(storage, 0, value)
  mutate(~value)
  __array_get(storage, 0).value
`),
    ).toContain("TY0051");
  });

  it("rejects opaque calls that cannot prove nested borrowed-result origins", () => {
    expect(
      diagnosticCodes(`${borrowedOptionPrelude}
type Maker = fn(Box) : () -> Option<borrow Box>

fn invalid(~value: Box, maker: Maker) -> i32
  let result = maker(value)
  mutate(~value)
  match(result)
    Some<borrow Box> { value: borrowed }:
      borrowed.value
    None:
      0
`),
    ).toContain("TY0051");
  });

  it("rejects contextual borrow formation into existing field storage", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj Holder { value: borrow Box }

fn invalid(~holder: Holder, source: Box) -> void
  holder.value = source
`),
    ).toContain("TY0051");
  });

  it("validates every branch that forms a borrowed value", () => {
    expect(
      diagnosticCodes(`
fn invalid(flag: bool, stable: borrow i32) -> borrow i32
  let chosen: borrow i32 =
    if flag:
      stable
    else:
      1
  chosen
`),
    ).toContain("TY0051");

    expect(
      diagnosticCodes(`
obj View { value: borrow i32 }

fn invalid(flag: bool, stable: borrow i32) -> View
  if flag:
    View { value: stable }
  else:
    View { value: 1 }
`),
    ).toContain("TY0051");
  });

  it("validates newly formed outer borrows independently of nested borrows", () => {
    expect(
      diagnosticCodes(`${borrowedOptionPrelude}
fn invalid(source: borrow Box) -> borrow Option<borrow Box>
  let payload: Option<borrow Box> = Some<borrow Box> { value: source }
  payload
`),
    ).toContain("TY0051");

    expect(() =>
      analyze(`${borrowedOptionPrelude}
fn read(value: borrow Option<borrow Box>) -> i32
  0

fn valid(payload: Option<borrow Box>) -> i32
  read(payload)
`),
    ).not.toThrow();
  });

  it("rejects explicit borrowed capture and module storage", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
type Callback = fn() : () -> i32

fn invalid(value: borrow Box) -> Callback
  () => value.value
`),
    ).toContain("TY0051");

    expect(
      diagnosticCodes(`
obj Box { value: i32 }
type Callback = fn() : () -> i32

fn invalid(value: borrow Box) -> Callback
  let callback = () => value.value
  callback
`),
    ).toContain("TY0051");

    expect(
      diagnosticCodes(`
obj Box { value: i32 }
let value = Box { value: 1 }
let escaped: borrow Box = value
`),
    ).toContain("TY0051");

    expect(() =>
      analyze(`
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None

let empty: Option<borrow i32> = None {}
`),
    ).not.toThrow();

    expect(() =>
      analyze(`
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None
val Holder { empty: Option<borrow i32> }

fn clear(~holder: Holder) -> void
  holder.empty = None {}

fn cleared(value: borrow i32) -> Holder
  let ~holder = Holder {
    empty: Some<borrow i32> { value }
  }
  holder.empty = None {}
  holder

let source = 1
let holder: Holder = cleared(source)
`),
    ).not.toThrow();

    expect(() =>
      analyze(`
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None
type Left = { left: Option<borrow i32> }
type Right = { right: Option<borrow i32> }
type Both = {
  left: Option<borrow i32>,
  right: Option<borrow i32>
}
obj Store { right: Right }

fn combine(left: borrow Left, right: borrow Right) -> Both
  { ...left, ...right }

fn valid(source: borrow i32, ~store: Store) -> i32
  let left: Left = {
    left: Some<borrow i32> { value: source }
  }
  let both = combine(left, store.right)
  store.right = { right: None {} }
  match(both.left)
    Some<borrow i32> { value }:
      value + 0
    None:
      0
`),
    ).not.toThrow();

    expect(
      diagnosticCodes(`
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None
val Holder {
  empty: Option<borrow i32>,
  count: i32
}

fn unsafe(value: borrow i32) -> Option<borrow i32>
  let ~a = Holder { empty: None {}, count: 0 }
  let ~b = Holder {
    empty: Some<borrow i32> { value },
    count: 0
  }
  let empty: Option<borrow i32> = None {}
  a.empty = empty
  let escaped = b.empty
  b = a
  escaped

let source = 1
let escaped: Option<borrow i32> = unsafe(source)
`),
    ).toContain("TY0051");

    expect(() =>
      analyze(`
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None

let flag = true
let empty: Option<borrow i32> =
  if flag:
    None {}
  else:
    None {}
`),
    ).not.toThrow();

    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj View { value: borrow Box }

let source = Box { value: 1 }

fn make() -> View
  View { value: source }

let escaped: View = make()
`),
    ).toContain("TY0051");

    expect(() =>
      analyze(`
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None

fn no_view() -> Option<borrow i32>
  let result: Option<borrow i32> = None {}
  result

let empty: Option<borrow i32> = no_view()
`),
    ).not.toThrow();

    expect(() =>
      analyze(`
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None
val Holder { empty: Option<borrow i32> }

fn projected() -> Option<borrow i32>
  let holder = Holder { empty: None {} }
  holder.empty

fn destructured() -> Option<borrow i32>
  let (_, empty) = (0, None {})
  empty

obj Box { value: i32 }
val BorrowHolder { empty: Option<borrow Box> }

fn selected(holder: BorrowHolder) -> Option<borrow Box>
  holder.empty
`),
    ).not.toThrow();

    expect(() =>
      analyze(`
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None
val Holder {
  count: i32,
  empty: Option<borrow i32>
}

fn no_view() -> Option<borrow i32>
  let ~holder = Holder { count: 0, empty: None {} }
  let ~alias = holder
  alias.count = 1
  holder.empty

let empty: Option<borrow i32> = no_view()
`),
    ).not.toThrow();

    expect(() =>
      analyze(`
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None

fn no_view(value: borrow i32) -> Option<borrow i32>
  return None {}
  Some<borrow i32> { value }

let source = 1
let empty: Option<borrow i32> = no_view(source)
`),
    ).not.toThrow();

    expect(() =>
      analyze(`
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None
type Pair = (borrow i32, Option<borrow i32>)

fn no_view(value: borrow i32) -> Option<borrow i32>
  let pair: Pair = (value, None {})
  let (_, empty) = pair
  empty

let source = 1
let out: Option<borrow i32> = no_view(source)
`),
    ).not.toThrow();

    expect(() =>
      analyze(`
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None

fn no_view(value: borrow i32) -> Option<borrow i32>
  var result: Option<borrow i32> = Some<borrow i32> { value }
  result = None {}
  result

let source = 1
let empty: Option<borrow i32> = no_view(source)
`),
    ).not.toThrow();

    expect(() =>
      analyze(`
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None
val Holder {
  active: borrow i32,
  empty: Option<borrow i32>
}

fn select(holder: Holder) -> Option<borrow i32>
  holder.empty

fn no_view(value: borrow i32) -> Option<borrow i32>
  let holder = Holder { active: value, empty: None {} }
  select(holder)

let source = 1
let empty: Option<borrow i32> = no_view(source)
`),
    ).not.toThrow();

    expect(() =>
      analyze(`
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None

fn rewrap(option: Option<borrow i32>) -> Option<borrow i32>
  match(option)
    Some<borrow i32> { value }:
      Some<borrow i32> { value }
    None:
      None {}

let empty: Option<borrow i32> = rewrap(None {})
`),
    ).not.toThrow();

    expect(() =>
      analyze(`
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None

fn no_view(recurse: bool) -> Option<borrow i32>
  if recurse:
    no_view(false)
  else:
    None {}

let empty: Option<borrow i32> = no_view(true)
`),
    ).not.toThrow();

    expect(() =>
      analyze(`
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None

fn inner(value: Option<borrow i32>) -> Option<borrow i32>
  value

fn middle(value: Option<borrow i32>) -> Option<borrow i32>
  inner(value)

fn no_view() -> Option<borrow i32>
  middle(None {})

let empty: Option<borrow i32> = no_view()
`),
    ).not.toThrow();

    expect(() =>
      analyze(`
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None

fn no_view(
  value: Option<borrow i32> = None {}
) -> Option<borrow i32>
  value

let empty: Option<borrow i32> = no_view()
`),
    ).not.toThrow();

    expect(
      diagnosticCodes(`
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None

let escaped: Option<borrow i32> =
  Some<borrow i32> { value: 1 }
`),
    ).toContain("TY0051");

    expect(
      diagnosticCodes(`
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None
obj Box { value: i32 }

fn mutate(~value: Box) -> void
  value.value = value.value + 1

fn view(option: Option<Box>) -> Option<borrow Box>
  match(option)
    Some<Box> { value }:
      Some<borrow Box> { value }
    None:
      None {}

fn looped(
  source: Box,
  keep_going: bool
) -> Option<borrow Box>
  var result: Option<Box> = None {}
  var candidate: Option<Box> = None {}
  while keep_going:
    result = candidate
    candidate = Some<Box> { value: source }
  view(result)

fn invalid(~source: Box, keep_going: bool) -> i32
  let borrowed = looped(source, keep_going)
  mutate(~source)
  match(borrowed)
    Some<borrow Box> { value }:
      value.value
    None:
      0
`),
    ).toContain("TY0048");

    expect(
      diagnosticCodes(`
obj View<T> { value: T }
obj Box { value: i32 }

fn identity<T>(value: T) -> T
  value

let source = Box { value: 1 }
let escaped: View<borrow Box> =
  identity<View<borrow Box>>(View<borrow Box> { value: source })
`),
    ).toContain("TY0051");

    expect(
      diagnosticCodes(`
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None

fn view(value: borrow i32) -> Option<borrow i32>
  var result: Option<borrow i32> = None {}
  while true:
    result = Some<borrow i32> { value }
    break
  result

let source = 1
let escaped: Option<borrow i32> = view(source)
`),
    ).toContain("TY0051");

    expect(
      diagnosticCodes(`
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None
val Holder { active: borrow i32 }

fn view(value: borrow i32) -> Option<borrow i32>
  let base = Holder { active: value }
  let copy = Holder { ...base }
  Some<borrow i32> { value: copy.active }

let source = 1
let escaped: Option<borrow i32> = view(source)
`),
    ).toContain("TY0051");

    expect(
      diagnosticCodes(`
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None
obj Box { value: i32 }

fn view(value: borrow Box) -> Option<borrow Box>
  Some<borrow Box> { value }

fn wrapper(value: Box) -> Option<borrow Box>
  let alias = value
  view(alias)

let source = Box { value: 1 }
let escaped: Option<borrow Box> = wrapper(source)
`),
    ).toContain("TY0051");

    expect(
      diagnosticCodes(`
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None
obj Box { value: i32 }

fn make() -> Box
  Box { value: 1 }

fn view(value: borrow Box) -> Option<borrow Box>
  Some<borrow Box> { value }

let escaped: Option<borrow Box> = view(make())
`),
    ).toContain("TY0051");

    expect(
      diagnosticCodes(`
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None

fn first(value: borrow i32, base: bool) -> Option<borrow i32>
  if base:
    Some<borrow i32> { value }
  else:
    second(value, true)

fn second(value: borrow i32, base: bool) -> Option<borrow i32>
  if base:
    first(value, true)
  else:
    None {}

let source = 1
let escaped: Option<borrow i32> = second(source, true)
`),
    ).toContain("TY0051");

    expect(
      diagnosticCodes(`
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None

fn unsafe(value: borrow i32) -> Option<borrow i32>
  var result: Option<borrow i32> = None {}
  var first = true
  while true:
    if first:
      result = Some<borrow i32> { value }
      first = false
      continue
      result = None {}
    else:
      break
  result

let source = 1
let escaped: Option<borrow i32> = unsafe(source)
`),
    ).toContain("TY0051");

    expect(
      diagnosticCodes(`
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None
val Holder { value: Option<borrow i32> }

fn unsafe(value: borrow i32) -> Option<borrow i32>
  let ~holder = Holder { value: None {} }
  holder.value = Some<borrow i32> { value }
  holder.value

let source = 1
let escaped: Option<borrow i32> = unsafe(source)
`),
    ).toContain("TY0051");

    expect(
      diagnosticCodes(`
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None

fn populate(
  ~result: Option<borrow i32>,
  value: borrow i32
) -> void
  result = Some<borrow i32> { value }

fn unsafe(value: borrow i32) -> Option<borrow i32>
  let ~result: Option<borrow i32> = None {}
  populate(~result, value)
  result

let source = 1
let escaped: Option<borrow i32> = unsafe(source)
`),
    ).toContain("TY0051");

    expect(
      diagnosticCodes(`
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None

fn unsafe(
  value: borrow i32,
  keep_going: bool
) -> Option<borrow i32>
  var result: Option<borrow i32> = None {}
  var candidate: Option<borrow i32> = None {}
  while keep_going:
    result = candidate
    candidate = Some<borrow i32> { value }
  result

let source = 1
let escaped: Option<borrow i32> = unsafe(source, false)
`),
    ).toContain("TY0051");

    expect(
      diagnosticCodes(`
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None
obj Box { value: i32 }
obj Holder { option: Option<Box> }

fn view(option: Option<Box>) -> Option<borrow Box>
  match(option)
    Some<Box> { value }:
      Some<borrow Box> { value }
    None:
      None {}

fn unsafe(source: Box) -> Option<borrow Box>
  let ~holder = Holder { option: None {} }
  let ~alias = holder
  alias.option = Some<Box> { value: source }
  view(holder.option)

let source = Box { value: 1 }
let escaped: Option<borrow Box> = unsafe(source)
`),
    ).toContain("TY0051");

    expect(
      diagnosticCodes(`
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None
obj Box { value: i32 }

fn view(option: Option<Box>) -> Option<borrow Box>
  match(option)
    Some<Box> { value }:
      Some<borrow Box> { value }
    None:
      None {}

fn unsafe(
  source: Box,
  keep_going: bool
) -> Option<borrow Box>
  var result: Option<Box> = None {}
  var candidate: Option<Box> = None {}
  while keep_going:
    result = candidate
    candidate = Some<Box> { value: source }
  view(result)

let source = Box { value: 1 }
let escaped: Option<borrow Box> = unsafe(source, false)
`),
    ).toContain("TY0051");

    expect(
      diagnosticCodes(`
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None
obj Box { value: i32 }

eff Stop
  stop(resume) -> void

fn view(option: Option<Box>) -> Option<borrow Box>
  match(option)
    Some<Box> { value }:
      Some<borrow Box> { value }
    None:
      None {}

fn unsafe(source: Box) -> Option<borrow Box>
  var candidate: Option<Box> = None {}
  try
    candidate = Some<Box> { value: source }
    Stop::stop()
    None {}
  Stop::stop(resume):
    view(candidate)

let source = Box { value: 1 }
let escaped: Option<borrow Box> = unsafe(source)
`),
    ).toContain("TY0051");

    expect(
      diagnosticCodes(`
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None
type Callback = fn() : () -> i32

let escaped: Option<borrow Callback> =
  Some<borrow Callback> { value: () => 1 }
`),
    ).toContain("TY0051");
  });

  it("allows fresh bounded aggregates containing explicit borrows", () => {
    expect(() =>
      analyze(`
obj Box { value: i32 }
obj View { value: borrow Box }
type Pair = (borrow Box, borrow Box)

fn wrap(value: Box) -> View
  View { value }

fn unwrap(value: View) -> borrow Box
  value.value

fn pair(left: Box, right: Box) -> Pair
  (left, right)
`),
    ).not.toThrow();
  });

  it("materializes ordinary read-only function arguments from borrows", () => {
    expect(() =>
      analyze(`
obj Box { value: i32 }

fn read(value: Box) -> i32
  value.value

fn valid(value: borrow Box) -> i32
  read(value)
`),
    ).not.toThrow();

    expect(
      diagnosticCodes(`
obj Box { value: i32 }

fn identity(value: Box) -> Box
  value

fn invalid(value: borrow Box) -> Box
  identity(value)
`),
    ).toContain("TY0051");

    expect(
      diagnosticCodes(`
obj Box { value: i32 }

fn invalid(value: borrow Box) -> Box
  let owned: Box = value
  owned
`),
    ).toContain("TY0027");

    expect(
      diagnosticCodes(`
trait Drawable
  fn draw(self) -> i32

val Pixel { value: i32 }

impl Drawable for Pixel
  fn draw(self) -> i32
    self.value

fn draw(shape: Drawable) -> i32
  shape.draw()

fn invalid(value: borrow Pixel) -> i32
  draw(value)
`),
    ).toSatisfy(
      (codes: readonly string[]) =>
        codes.includes("TY0045") || codes.includes("TY0027"),
    );
  });

  it("retains only nested borrowed fields in returned aggregates", () => {
    expect(() =>
      analyze(`
obj Box { value: i32 }
obj View { loan: borrow Box, owned: Box }

fn identity(value: View) -> View
  value

fn valid(source: Box) -> i32
  let ~wrapped = View {
    loan: source,
    owned: Box { value: 1 }
  }
  let returned = identity(wrapped)
  wrapped.owned = Box { value: 2 }
  returned.loan.value
`),
    ).not.toThrow();
  });

  it("routes parameters nested in returned aggregates through full facts", () => {
    const result = analyze(`
obj Box { value: i32 }
obj Inner { box: Box }
obj Outer { inner: Inner }

fn wrap(~value: Box) -> Outer
  Outer { inner: Inner { box: value } }
`);
    const wrap = result.symbols.resolveTopLevel("wrap");

    expect(capabilityFor(result, "wrap")).toBe("flow-sensitive");
    expect(
      typeof wrap === "number"
        ? result.borrowing.callables.get(wrap)?.parameters[0]?.returnedOrigins
        : undefined,
    ).not.toEqual([]);
  });

  it("does not apply future value aliases to earlier call writes", () => {
    expect(() =>
      analyze(`
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None
val Holder { empty: Option<borrow i32> }

fn clear(~holder: Holder) -> void
  holder.empty = None {}

fn valid(value: borrow i32) -> Option<borrow i32>
  let ~a = Holder { empty: None {} }
  let ~b = Holder {
    empty: Some<borrow i32> { value }
  }
  let retained = b.empty
  clear(~a)
  b = a
  retained
`),
    ).not.toThrow();
  });

  it("rejects fresh borrowed aggregates written directly into existing storage", () => {
    expect(
      diagnosticCodes(`
val View { active: borrow i32 }
obj Store { view: View }

fn invalid(~store: Store, source: borrow i32) -> void
  store.view = View { active: source }
`),
    ).toContain("TY0051");

    expect(
      diagnosticCodes(`
val View { active: borrow i32 }
obj Store { view: View }

fn invalid(~store: Store, flag: bool, source: i32) -> void
  store.view =
    if flag:
      View { active: source }
    else:
      View { active: source }
`),
    ).toContain("TY0051");

    expect(
      diagnosticCodes(`
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None
obj Store { view: Option<borrow i32> }

fn invalid(~store: Store, flag: bool, source: i32) -> void
  store.view =
    if flag:
      Some<borrow i32> { value: source }
    else:
      None {}
`),
    ).toContain("TY0051");
  });

  it("tracks borrowed fields supplied by ordered object spreads", () => {
    expect(
      diagnosticCodes(`
val Plain { active: i32 }
val View { active: borrow i32 }

fn invalid() -> View
  let source = 1
  let base = Plain { active: source }
  View { ...base }
`),
    ).toContain("TY0051");

    expect(
      diagnosticCodes(`
val Plain { active: i32 }
val View { active: borrow i32 }
obj Store { view: View }

fn invalid(~store: Store, source: i32) -> void
  let base = Plain { active: source }
  store.view = View { ...base }
`),
    ).toContain("TY0051");

    expect(
      diagnosticCodes(`
obj Box { value: i32 }
val Plain { active: Box }
val View { active: borrow Box }

fn mutate(~value: Box) -> void
  value.value = value.value + 1

fn invalid(~source: Box) -> i32
  let base = Plain { active: source }
  let view = View { ...base }
  mutate(~source)
  view.active.value
`),
    ).toContain("TY0048");

    expect(
      diagnosticCodes(`
obj Box { value: i32 }
val Active { active: borrow Box }
val Count { count: i32 }
val View { active: borrow Box, count: i32 }

fn mutate(~value: Box) -> void
  value.value = value.value + 1

fn invalid(~source: Box) -> i32
  let active = Active { active: source }
  let count = Count { count: 1 }
  let view = View { ...active, ...count }
  mutate(~source)
  view.active.value
`),
    ).toContain("TY0048");
  });

  it("handles cyclic borrowed aggregate initializers conservatively", () => {
    expect(
      diagnosticCodes(`
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None
val View { active: Option<borrow i32> }
obj Store { view: View }

fn invalid(~store: Store) -> void
  var first: Option<borrow i32> = None {}
  var second: Option<borrow i32> = None {}
  first = second
  second = first
  store.view = View { active: first }
`),
    ).toContain("TY0051");
  });

  it("rejects borrowed value-object widening to borrowed trait objects", () => {
    expect(
      diagnosticCodes(`
trait Drawable
  fn draw(self) -> i32

val Pixel { value: i32 }

impl Drawable for Pixel
  fn draw(self) -> i32
    self.value

fn invalid(value: borrow Pixel) -> borrow Drawable
  let widened: borrow Drawable = value
  widened
`),
    ).toSatisfy(
      (codes: readonly string[]) =>
        codes.includes("TY0045") || codes.includes("TY0027"),
    );
  });

  it("keeps borrowed fields in copied value containers independent", () => {
    expect(() =>
      analyze(`
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None
val Holder { empty: Option<borrow i32> }

fn valid(value: borrow i32) -> i32
  let ~holder = Holder {
    empty: Some<borrow i32> { value }
  }
  let copy = holder
  holder.empty = None {}
  match(copy.empty)
    Some<borrow i32> { value: borrowed }:
      borrowed + 0
    None:
      0
`),
    ).not.toThrow();
  });

  it("borrows tuple and structural values at their source storage", () => {
    expect(
      diagnosticCodes(`
fn invalid() -> i32
  var current = (1, 2)
  let borrowed: borrow (i32, i32) = current
  current = (3, 4)
  borrowed.0
`),
    ).toContain("TY0048");

    expect(
      diagnosticCodes(`
type Pair = { first: i32, second: i32 }

fn invalid() -> i32
  var current: Pair = { first: 1, second: 2 }
  let borrowed: borrow Pair = current
  current = { first: 3, second: 4 }
  borrowed.first
`),
    ).toContain("TY0048");
  });

  it("uses the final object provider when spreads are overridden", () => {
    expect(() =>
      analyze(`
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None
val View { active: Option<borrow i32> }

fn mutate(~value: i32) -> void
  value = value + 1

fn valid(~source: i32) -> i32
  let base = View {
    active: Some<borrow i32> { value: source }
  }
  let cleared = View {
    ...base,
    active: None {}
  }
  mutate(~source)
  match(cleared.active)
    Some<borrow i32> { value }:
      value + 0
    None:
      0
`),
    ).not.toThrow();

    expect(() =>
      analyze(`
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None
val View { active: Option<borrow i32> }

fn mutate(~value: i32) -> void
  value = value + 1

fn cleared(source: borrow i32) -> View
  let base = View {
    active: Some<borrow i32> { value: source }
  }
  View {
    ...base,
    active: None {}
  }

fn valid(~source: i32) -> i32
  let cleared_view = cleared(source)
  mutate(~source)
  match(cleared_view.active)
    Some<borrow i32> { value }:
      value + 0
    None:
      0
`),
    ).not.toThrow();

    expect(
      diagnosticCodes(`
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None
val View { active: Option<borrow i32> }

fn mutate(~value: i32) -> void
  value = value + 1

fn invalid(~source: i32) -> i32
  let base = View {
    active: Some<borrow i32> { value: source }
  }
  let retained = View {
    active: None {},
    ...base
  }
  mutate(~source)
  match(retained.active)
    Some<borrow i32> { value }:
      value + 0
    None:
      0
`),
    ).toContain("TY0048");
  });

  it("materializes plain fields when spreading explicitly borrowed values", () => {
    expect(() =>
      analyze(`
val Pair { left: i32, right: i32 }

fn copy(value: borrow Pair) -> Pair
  Pair { ...value }

fn valid() -> i32
  let ~pair = Pair { left: 1, right: 2 }
  let borrowed: borrow Pair = pair
  let copied = copy(borrowed)
  pair.left = 3
  copied.left
`),
    ).not.toThrow();

    expect(() =>
      analyze(`
obj Box { value: i32 }
val Inner { child: Box }
val Outer { inner: Inner }

fn mutate(~box: Box) -> void
  box.value = 2

fn copied(source: borrow Outer) -> Outer
  Outer { ...source }

fn valid(source: borrow Outer) -> i32
  let ~copy = copied(source)
  mutate(~copy.inner.child)
  copy.inner.child.value
`),
    ).not.toThrow();

    expect(
      diagnosticCodes(`
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None
val View { active: Option<borrow i32>, count: i32 }

fn copy(value: borrow View) -> View
  View { ...value }

fn mutate(~value: i32) -> void
  value = value + 1

fn invalid(~source: i32) -> i32
  let view = View {
    active: Some<borrow i32> { value: source },
    count: 1
  }
  let copied = copy(view)
  mutate(~source)
  match(copied.active)
    Some<borrow i32> { value }:
      value + 0
    None:
      0
`),
    ).toContain("TY0048");
  });

  it("borrows unconstrained generic values at their inline slots", () => {
    expect(
      diagnosticCodes(`
fn invalid<T>(first: T, second: T) -> bool
  var current = first
  let borrowed: borrow T = current
  current = second
  borrowed == first

pub fn main() -> bool
  invalid<i32>(1, 2)
`),
    ).toContain("TY0048");
  });

  it("treats trait-only intersections as allocation-backed handles", () => {
    expect(() =>
      analyze(`
trait Readable
  fn read(self) -> i32

trait Named
  fn name(self) -> i32

fn consume(value: borrow (Readable & Named)) -> i32
  0

fn valid(
  first: Readable & Named,
  second: Readable & Named
) -> i32
  var current = first
  let borrowed: borrow (Readable & Named) = current
  current = second
  consume(borrowed)
`),
    ).not.toThrow();
  });

  it("rejects live explicit borrows across suspending effects", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }

eff Async
  wait(resume) -> void

fn view(value: Box) -> borrow Box
  value

fn invalid(value: Box): Async -> i32
  let borrowed = view(value)
  Async::wait()
  borrowed.value
`),
    ).toContain("TY0052");
  });

  it("keeps recursive borrowed containment independent of query order", () => {
    const declarations = `
obj Empty {}
obj Box { value: i32 }
obj A { b: B | Empty, loan: borrow Box }
obj B { a: A }
`;
    const effectUse = `
eff Hold
  hold(resume, value: B) -> void

fn invalid(value: B): Hold -> void
  Hold::hold(value)
`;
    const unprimed = diagnosticCodes(`${declarations}${effectUse}`);
    const primed = diagnosticCodes(`${declarations}
fn use_a(value: A) -> void
  void

fn use_b(value: B) -> void
  void
${effectUse}`);

    expect(unprimed).toEqual(expect.arrayContaining(["TY0051", "TY0052"]));
    expect(primed).toEqual(expect.arrayContaining(["TY0051", "TY0052"]));
  });

  it("preserves projected loan provenance through recursive wrappers", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
val View { source: borrow Box }

fn wrap(source: borrow Box, depth: i32) -> View
  if depth <= 0:
    return View { source }
  wrap(source, depth - 1)

fn mutate(~value: Box) -> void
  value.value = value.value + 1

fn invalid(~value: Box) -> i32
  let first = wrap(value, 2)
  let second = wrap(value, 3)
  mutate(~value)
  first.source.value + second.source.value
`),
    ).toContain("TY0048");
  });

  it("preserves borrowed type facts in ProgramCodegenView", () => {
    const result = analyze(`
obj Box { value: i32 }

fn view(value: Box) -> borrow Box
  value
`);
    const signature = Array.from(
      result.typing.functions.signatures,
      ([, candidate]) => candidate,
    ).find(
      (candidate) =>
        result.typing.arena.get(candidate.returnType).kind === "borrowed",
    );
    expect(signature).toBeDefined();

    const program = buildProgramCodegenView([result]);
    const inner = signature
      ? program.types.getBorrowedInner(signature.returnType)
      : undefined;
    expect(inner).toBeDefined();
    expect(
      signature ? program.types.getRuntimeTypeId(signature.returnType) : -1,
    ).toBe(inner);
    expect(
      signature ? program.types.getTypeDesc(signature.returnType) : undefined,
    ).toEqual(
      inner === undefined ? undefined : program.types.getTypeDesc(inner),
    );
    const viewEntry = Array.from(result.borrowing.callables).find(
      ([, contract]) =>
        contract.parameters[0]?.returnedSharedOrigins?.length === 1,
    );
    expect(viewEntry?.[1].parameters[0]?.returnedSharedOrigins).toHaveLength(1);
  });

  it("keeps borrow contracts private from ProgramCodegenView", () => {
    const result = analyze(`
obj Box { value: i32 }

fn identity(value: Box) -> Box
  value
`);
    const identityEntry = Array.from(result.borrowing.callables).find(
      ([, contract]) =>
        (contract.parameters[0]?.returnedOrigins?.length ?? 0) > 0,
    );
    expect(identityEntry).toBeDefined();
    const protocol = identityEntry
      ? Array.from(
          buildProgramCodegenView([result]).modules.values(),
        )[0]?.callableRuntimeProtocols.get(identityEntry[0])
      : undefined;
    expect(protocol).toBeUndefined();
  });

  it("preserves explicit borrowed results across modules", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryModuleHost({
      files: {
        [`${root}${sep}views.voyd`]: `
pub obj Box { api value: i32 }

pub fn view(value: Box) -> borrow Box
  value
`,
        [`${root}${sep}main.voyd`]: `
use src::views::{ Box, view }

fn mutate(~value: Box) -> void
  value.value = value.value + 1

fn invalid(~value: Box) -> i32
  let borrowed = view(value)
  mutate(~value)
  borrowed.value
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
    const dependency = analyzed.semantics.get("src::views");
    const borrowedSignature = Array.from(
      dependency?.typing.functions.signatures ?? [],
      ([, signature]) => signature,
    ).find(
      (signature) =>
        dependency?.typing.arena.get(signature.returnType).kind === "borrowed",
    );
    const viewSummary = dependency?.exports
      .get("view")
      ?.borrowing?.find(
        (entry) => entry.symbol === dependency.exports.get("view")?.symbol,
      );

    expect(borrowedSignature).toBeDefined();
    expect(viewSummary?.contract).toBeDefined();
    expect(viewSummary?.source).toMatchObject({
      declaration: { moduleId: "src::views" },
    });
    const conflict = diagnostics.find(
      (diagnostic) =>
        diagnostic.code === "TY0048" &&
        diagnostic.message.includes("cannot mutably borrow"),
    );
    expect(conflict).toBeDefined();
    expect(conflict?.related).toContainEqual(
      expect.objectContaining({
        message: "callable borrow contract declared here",
        span: expect.objectContaining({ file: "src::views" }),
      }),
    );
  });

  it("preserves no-loan borrowed results across modules", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryModuleHost({
      files: {
        [`${root}${sep}views.voyd`]: `
pub obj Some<T> { api value: T }
pub obj None {}
pub type Option<T> = Some<T> | None

pub fn no_view() -> Option<borrow i32>
  var result: Option<borrow i32> = None {}
  result

pub fn default_view(
  value: Option<borrow i32> = None {}
) -> Option<borrow i32>
  value

pub fn chained_default_view(
  first: Option<borrow i32> = None {},
  second: Option<borrow i32> = first
) -> Option<borrow i32>
  second

pub val Holder {
  active: borrow i32,
  empty: Option<borrow i32>
}

pub fn selected_default_view(
  source: borrow i32,
  holder: Holder = Holder { active: source, empty: None {} }
) -> Option<borrow i32>
  holder.empty

pub fn selected_active_view(
  source: borrow i32,
  holder: Holder = Holder { active: source, empty: None {} }
) -> borrow i32
  holder.active
`,
        [`${root}${sep}main.voyd`]: `
use src::views::{
  Option,
  no_view,
  default_view,
  chained_default_view,
  selected_default_view
}

fn relay(source: borrow i32) -> Option<borrow i32>
  selected_default_view(source)

let source = 1
let empty: Option<borrow i32> = no_view()
let default_empty: Option<borrow i32> = default_view()
let chained_empty: Option<borrow i32> = chained_default_view()
let selected_empty: Option<borrow i32> = relay(source)
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
    const noViewContract = Array.from(
      analyzed.semantics.get("src::views")?.borrowing.callables.values() ?? [],
    ).find((contract) => contract.borrowedResult === "none");
    const selectedSummary = analyzed.semantics
      .get("src::views")
      ?.exports.get("selected_default_view")
      ?.borrowing?.find(
        (entry) =>
          entry.symbol ===
          analyzed.semantics
            .get("src::views")
            ?.exports.get("selected_default_view")?.symbol,
      );
    const selectedContract = selectedSummary?.contract;
    const activeSummary = analyzed.semantics
      .get("src::views")
      ?.exports.get("selected_active_view")
      ?.borrowing?.find(
        (entry) =>
          entry.symbol ===
          analyzed.semantics
            .get("src::views")
            ?.exports.get("selected_active_view")?.symbol,
      );
    const activeContract = activeSummary?.contract;

    expect(noViewContract?.borrowedResult).toBe("none");
    expect(selectedSummary).toBeDefined();
    expect(
      selectedContract?.parameters[1]?.defaultNoBorrowPaths,
    ).toBeUndefined();
    expect(
      activeContract?.parameters.some((parameter) =>
        parameter.returnedOrigins?.some(
          (origin) => origin.defaultNoBorrow === true,
        ),
      ),
    ).toBe(false);
    expect(diagnostics).toEqual([]);
  });

  it("does not coalesce private default no-borrow sibling paths", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryModuleHost({
      files: {
        [`${root}${sep}views.voyd`]: `
pub obj Box { api value: i32 }
pub obj Some<T> { api value: T }
pub obj None {}
pub type Option<T> = Some<T> | None

pub val Holder {
  active: Option<borrow Box>,
  empty: Option<borrow Box>
}

pub fn selected_active(
  source: borrow Box,
  holder: Holder = Holder {
    active: Some { value: source },
    empty: None {}
  }
) -> Option<borrow Box>
  holder.active
`,
        [`${root}${sep}relay.voyd`]: `
use src::views::{ Box, Option, selected_active }

pub fn relay(source: borrow Box) -> Option<borrow Box>
  selected_active(source)
`,
        [`${root}${sep}main.voyd`]: `
use src::views::{ Box, Option }
use src::relay::{ relay }

let source = Box { value: 1 }
let escaped: Option<borrow Box> = relay(source)
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

    expect(
      [...graph.diagnostics, ...analyzed.diagnostics].map(
        (diagnostic) => diagnostic.code,
      ),
    ).toContain("TY0051");
  });

  it("preserves ordinary aliases from private defaults across modules", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryModuleHost({
      files: {
        [`${root}${sep}views.voyd`]: `
pub obj Box { api value: i32 }
let global = Box { value: 0 }
pub val Holder { secret: Box }

pub fn get_global() -> Box
  global

pub fn get(
  holder: Holder = Holder { secret: global }
) -> Box
  holder.secret
`,
        [`${root}${sep}main.voyd`]: `
use src::views::{ Box, get_global, get }

fn mutate(~value: Box) -> void
  value.value = value.value + 1

fn invalid() -> i32
  let loan: borrow Box = get_global()
  let ~returned = get()
  mutate(~returned)
  loan.value
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
    const getSummary = analyzed.semantics
      .get("src::views")
      ?.exports.get("get")
      ?.borrowing?.find(
        (entry) =>
          entry.symbol ===
          analyzed.semantics.get("src::views")?.exports.get("get")?.symbol,
      );
    const contract = getSummary?.contract;

    expect(
      contract?.parameters.some((parameter) =>
        parameter.returnedOrigins?.some(
          (origin) => origin.defaultNoBorrow === true,
        ),
      ),
    ).toBe(false);
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "TY0048",
    );
  });

  it("preserves mixed borrowed and ordinary default origins across modules", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryModuleHost({
      files: {
        [`${root}${sep}views.voyd`]: `
pub obj Box { api value: i32 }
pub obj Item { api value: i32 }
pub type Mixed = borrow Item | Box

let global = Box { value: 0 }

pub fn get_global() -> Box
  global

pub val Holder { mixed: Mixed }

pub fn get(
  holder: Holder = Holder { mixed: global }
) -> Mixed
  holder.mixed
`,
        [`${root}${sep}main.voyd`]: `
use src::views::{ Box, Item, Mixed, get_global, get }

fn mutate_mixed(~value: Mixed) -> void
  match(value)
    Box:
      value.value = value.value + 1
    Item:
      void

fn invalid() -> i32
  let loan: borrow Box = get_global()
  mutate_mixed(~get())
  loan.value
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

    expect(
      [...graph.diagnostics, ...analyzed.diagnostics].map(
        (diagnostic) => diagnostic.code,
      ),
    ).toContain("TY0048");
  });

  it("propagates external writes through returned module aliases", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryModuleHost({
      files: {
        [`${root}${sep}views.voyd`]: `
pub obj Box { api value: i32 }
let global = Box { value: 0 }
pub val Holder { api value: Box }
let holder = Holder { value: global }

pub fn get_holder() -> Holder
  holder

pub fn get_global() -> Box
  global

fn mutate(~value: Box) -> void
  value.value = value.value + 1

pub fn mutate_global() -> void
  mutate(~get_global())
`,
        [`${root}${sep}main.voyd`]: `
use src::views::{ Box, get_global, mutate_global }

fn mutate_both(~left: Box, ~right: Box) -> void
  left.value = left.value + 1
  right.value = right.value + 1

fn invalid() -> i32
  let loan: borrow Box = get_global()
  mutate_global()
  loan.value

fn invalid_arguments() -> void
  mutate_both(~get_global(), ~get_global())
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
    const mutateGlobalSummary = analyzed.semantics
      .get("src::views")
      ?.exports.get("mutate_global")
      ?.borrowing?.find(
        (entry) =>
          entry.symbol ===
          analyzed.semantics.get("src::views")?.exports.get("mutate_global")
            ?.symbol,
      );
    const mutateGlobalContract = mutateGlobalSummary?.contract;

    expect(mutateGlobalContract?.externalWrite).toBe(true);
    expect(
      [...graph.diagnostics, ...analyzed.diagnostics].map(
        (diagnostic) => diagnostic.code,
      ),
    ).toContain("TY0048");
    expect(
      [...graph.diagnostics, ...analyzed.diagnostics].map(
        (diagnostic) => diagnostic.code,
      ),
    ).not.toContain("TY9999");
  });

  it("stores plain external handles in ordinary aggregates", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryModuleHost({
      files: {
        [`${root}${sep}views.voyd`]: `
pub obj Box { api value: i32 }
let global = Box { value: 0 }

pub fn get_global() -> Box
  global
`,
        [`${root}${sep}main.voyd`]: `
use src::views::{ Box, get_global }

val Holder { value: Box }

fn valid() -> i32
  let holder = Holder { value: get_global() }
  holder.value.value
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

    expect([...graph.diagnostics, ...analyzed.diagnostics]).toEqual([]);
  });

  it("allows external writes while a fresh local loan is active", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryModuleHost({
      files: {
        [`${root}${sep}views.voyd`]: `
pub obj Box { api value: i32 }
let global = Box { value: 0 }

fn mutate(~value: Box) -> void
  value.value = value.value + 1

fn get_global() -> Box
  global

pub fn mutate_global() -> void
  mutate(~get_global())
`,
        [`${root}${sep}main.voyd`]: `
use src::views::{ Box, mutate_global }

fn valid() -> i32
  let ~local = Box { value: 1 }
  let view: borrow Box = local
  mutate_global()
  view.value
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

    expect([...graph.diagnostics, ...analyzed.diagnostics]).toEqual([]);
  });

  it("preserves fresh constructor results across module boundaries", async () => {
    const root = resolve("/fresh-result/src");
    const host = createMemoryModuleHost({
      files: {
        [`${root}${sep}values.voyd`]: `
pub obj Box { api value: i32 }

pub fn make_box() -> Box
  Box { value: 0 }
`,
        [`${root}${sep}main.voyd`]: `
use src::values::{ Box, make_box }

fn mutate_both(~left: Box, ~right: Box) -> void
  left.value = left.value + 1
  right.value = right.value + 1

pub fn valid(~right: Box) -> void
  let ~left = make_box()
  left.value = 2
  mutate_both(~left, ~right)
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
    const values = analyzed.semantics.get("src::values");
    const makeBox = values?.exports.get("make_box");
    const contract = makeBox?.borrowing?.find(
      (entry) => entry.symbol === makeBox.symbol,
    )?.contract;
    const main = analyzed.semantics.get("src::main");
    const valid = main?.exports.get("valid");

    expect([...graph.diagnostics, ...analyzed.diagnostics]).toEqual([]);
    expect(contract).toBeDefined();
    expect(contract?.freshResult).toBe(true);
    expect(
      typeof valid?.symbol === "number"
        ? main?.borrowing.capabilities.get(valid.symbol)
        : undefined,
    ).toBe("transient");
    expect(
      analyzed.semantics.get("src::main")?.borrowing.runtimeIdentityGuards.size,
    ).toBe(0);
  });

  it("preserves owned aggregate projections across module boundaries", async () => {
    const root = resolve("/fresh-aggregate-result/src");
    const host = createMemoryModuleHost({
      files: {
        [`${root}${sep}values.voyd`]: `
pub obj Box { api value: i32 }
pub val Pair { api left: Box, api right: Box }

pub fn make_pair() -> Pair
  Pair {
    left: Box { value: 1 },
    right: Box { value: 2 }
  }
`,
        [`${root}${sep}main.voyd`]: `
use src::values::{ Pair, make_pair }

pub fn relay_pair() -> Pair
  let pair = make_pair()
  pair
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
    const values = analyzed.semantics.get("src::values");
    const makePair = values?.exports.get("make_pair");
    const contract = makePair?.borrowing?.find(
      (entry) => entry.symbol === makePair.symbol,
    )?.contract;
    const main = analyzed.semantics.get("src::main");
    const relayPair = main?.exports.get("relay_pair");

    expect([...graph.diagnostics, ...analyzed.diagnostics]).toEqual([]);
    expect(
      contract?.externalReturnedOrigins?.filter(
        (origin) => origin.fresh === true,
      ),
    ).toHaveLength(2);
    expect(
      typeof relayPair?.symbol === "number"
        ? main?.borrowing.capabilities.get(relayPair.symbol)
        : undefined,
    ).toBe("none");
  });

  it("tracks escaped allocations before external writes", async () => {
    const srcRoot = resolve("/proj/src");
    const stdRoot = resolve("/proj/std");
    const host = createMemoryModuleHost({
      files: {
        [`${stdRoot}${sep}views.voyd`]: `
pub obj Box { api value: i32 }
let global = Box { value: 0 }

@intrinsic(name: "__retain_callback", uses_signature: true)
fn retain_callback_id(handler: fn() -> i32) -> i32
  0

pub fn retain_callback(handler: fn() -> i32) -> i32
  retain_callback_id(handler)

fn get_global() -> Box
  global

fn mutate(~value: Box) -> void
  value.value = value.value + 1

pub fn mutate_global() -> void
  mutate(~get_global())

pub fn retain_and_mutate(handler: fn() -> i32) -> void
  let _ = retain_callback_id(handler)
  mutate_global()

pub fn retain_default_and_mutate(
  value: Box,
  handler: fn() -> i32 = () => value.value
) -> void
  let _ = retain_callback_id(handler)
  mutate_global()
`,
        [`${srcRoot}${sep}main.voyd`]: `
use std::views::{
  Box,
  retain_callback,
  mutate_global,
  retain_and_mutate,
  retain_default_and_mutate
}

val Holder { box: Box }
val ValueHolder { value: i32 }

fn invalid_after_escape() -> i32
  let ~local = Box { value: 1 }
  let callback = () => local.value
  let _ = retain_callback(callback)
  let view: borrow Box = local
  mutate_global()
  view.value

fn invalid_same_call() -> i32
  let ~local = Box { value: 1 }
  let callback = () => local.value
  let view: borrow Box = local
  retain_and_mutate(callback)
  view.value

fn invalid_projected_allocation() -> i32
  let ~local = Holder { box: Box { value: 1 } }
  let callback = () => local.box.value
  let _ = retain_callback(callback)
  let view: borrow Box = local.box
  mutate_global()
  view.value

fn invalid_retained_default() -> i32
  let ~local = Box { value: 1 }
  let view: borrow Box = local
  retain_default_and_mutate(local)
  view.value

fn invalid_mutable_reborrow() -> i32
  let ~local = Box { value: 1 }
  let callback = () => local.value
  let _ = retain_callback(callback)
  let ~current = local
  mutate_global()
  current.value

fn invalid_mutable_reassignment() -> i32
  let ~local = Box { value: 1 }
  let callback = () => local.value
  let _ = retain_callback(callback)
  let ~current = Box { value: 2 }
  current = local
  mutate_global()
  current.value

fn invalid_nested_mutable_reborrow() -> i32
  let ~local = Box { value: 1 }
  let callback = () => local.value
  let _ = retain_callback(callback)
  let (~current, ignored) = (local, 0)
  mutate_global()
  current.value

fn valid_copied_capture() -> i32
  let local = ValueHolder { value: 1 }
  let callback = () => local.value
  let _ = retain_callback(callback)
  let view: borrow ValueHolder = local
  mutate_global()
  view.value
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
    const retainAndMutateSummary = analyzed.semantics
      .get("std::views")
      ?.exports.get("retain_and_mutate")
      ?.borrowing?.find(
        (entry) =>
          entry.symbol ===
          analyzed.semantics.get("std::views")?.exports.get("retain_and_mutate")
            ?.symbol,
      );
    const retainAndMutateContract = retainAndMutateSummary?.contract;
    const retainDefaultSummary = analyzed.semantics
      .get("std::views")
      ?.exports.get("retain_default_and_mutate")
      ?.borrowing?.find(
        (entry) =>
          entry.symbol ===
          analyzed.semantics
            .get("std::views")
            ?.exports.get("retain_default_and_mutate")?.symbol,
      );
    const retainDefaultContract = retainDefaultSummary?.contract;
    const conflicts = [...graph.diagnostics, ...analyzed.diagnostics].filter(
      (diagnostic) => diagnostic.code === "TY0048",
    );

    expect(retainAndMutateContract?.externalWrite).toBe(true);
    expect(retainDefaultContract?.parameters[1]?.retained).toBe(true);
    expect(
      retainDefaultContract?.parameters[1]?.defaultOrigins?.length,
    ).toBeGreaterThan(0);
    expect(retainDefaultContract?.externalWrite).toBe(true);
    expect(conflicts).toHaveLength(7);
    expect(retainAndMutateContract?.parameters[0]?.retained).toBe(true);
  });

  it("keeps handle slots distinct from their referenced allocations", () => {
    expect(
      projectionPathsOverlap(
        [{ kind: "field", name: "source" }],
        [{ kind: "field", name: "source" }, { kind: "dereference" }],
      ),
    ).toBe(false);
    expect(
      projectionPathsOverlap(
        [{ kind: "field", name: "source" }, { kind: "dereference" }],
        [
          { kind: "field", name: "source" },
          { kind: "dereference" },
          { kind: "field", name: "value" },
        ],
      ),
    ).toBe(true);
    expect(
      projectionPathsOverlap(
        [
          { kind: "field", name: "left" },
          { kind: "dereference" },
          { kind: "field", name: "value" },
        ],
        [
          { kind: "field", name: "right" },
          { kind: "dereference" },
          { kind: "field", name: "value" },
        ],
      ),
    ).toBe(true);
    expect(
      projectionPathsOverlap(
        [],
        [
          { kind: "field", name: "source" },
          { kind: "dereference" },
          { kind: "field", name: "value" },
        ],
      ),
    ).toBe(false);
    expect(
      projectionPathCovers(
        [],
        [
          { kind: "field", name: "source" },
          { kind: "dereference" },
          { kind: "field", name: "value" },
        ],
      ),
    ).toBe(false);
    expect(
      projectionPathsOverlap(
        [
          { kind: "field", name: "left" },
          { kind: "dereference" },
          { kind: "field", name: "child" },
          { kind: "dereference" },
          { kind: "field", name: "value" },
        ],
        [
          { kind: "field", name: "right" },
          { kind: "dereference" },
          { kind: "field", name: "value" },
        ],
      ),
    ).toBe(true);
  });

  it("merges explicit read and write footprints", () => {
    const merged = mergeCallableBorrowContracts([
      {
        parameters: [
          {
            access: "shared",
            readPaths: [[{ kind: "field", name: "left" }]],
            retained: false,
            returned: false,
          },
        ],
        maySuspend: false,
      },
      {
        parameters: [
          {
            access: "mutable",
            readPaths: [],
            writePaths: [[{ kind: "field", name: "right" }]],
            retained: false,
            returned: false,
          },
        ],
        maySuspend: false,
      },
    ]);

    expect(merged?.parameters[0]?.readPaths).toEqual([
      [{ kind: "field", name: "left" }],
    ]);
    expect(merged?.parameters[0]?.writePaths).toEqual([
      [{ kind: "field", name: "right" }],
    ]);
  });

  it("preserves conditional ordinary-value retention across dispatch merges", () => {
    const parameter = {
      access: "shared" as const,
      retained: true,
      retainedUnlessBorrowed: true as const,
      returned: false,
    };
    const merged = mergeCallableBorrowContracts([
      { parameters: [parameter], maySuspend: false },
      { parameters: [parameter], maySuspend: false },
    ]);

    expect(merged?.parameters[0]).toMatchObject({
      retained: true,
      retainedUnlessBorrowed: true,
    });
    expect(
      mergeCallableBorrowContracts([
        { parameters: [parameter], maySuspend: false },
        {
          parameters: [
            {
              access: "shared",
              retained: true,
              returned: false,
            },
          ],
          maySuspend: false,
        },
      ])?.parameters[0]?.retainedUnlessBorrowed,
    ).toBeUndefined();
  });

  it("preserves borrowed-source taint when transfers widen", () => {
    const transfers = Array.from({ length: 33 }, (_entry, index) => ({
      sourceParameter: 1,
      destinationParameter: 0,
      sourcePath: [{ kind: "field" as const, name: `source_${index}` }],
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

  it("allows mutation while an ordinary alias remains live", () => {
    const codes = diagnosticCodes(`${prelude}
fn conflict(~value: Box) -> i32
  let alias = value
  mutate(~value)
  alias.value
`);

    expect(codes).not.toContain("TY0048");
  });

  it("reports both places, final use, and runtime-guard applicability", () => {
    const conflict = diagnosticsFor(`${prelude}
fn view(value: Box) -> borrow Box
  value

fn invalid(~value: Box) -> i32
  let borrowed = view(value)
  mutate(~value)
  borrowed.value
`).find(
      (diagnostic) =>
        diagnostic.code === "TY0048" &&
        diagnostic.message.includes("cannot mutably borrow"),
    );

    expect(conflict?.message).toContain("value");
    expect(conflict?.related?.map((diagnostic) => diagnostic.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("shared borrow of 'value"),
        expect.stringContaining("last use of 'borrowed'"),
      ]),
    );
    expect(conflict?.hints?.map((hint) => hint.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("No runtime identity guard can defer"),
      ]),
    );
  });

  it("scopes mutable receiver access to referenced allocation footprints", () => {
    const source = `
obj Box { value: i32 }
obj State { left: i32, right: i32 }
obj RefState { left: Box }

fn read_left(state: State) -> i32
  state.left

fn read_right(state: State) -> i32
  state.right

fn mutate_left(~state: State) -> void
  state.left = state.left + 1

fn mutate_referenced_left(~state: RefState) -> void
  state.left.value = state.left.value + 1

fn mutate_referenced_alias(~state: RefState) -> void
  let ~left = state.left
  left.value = left.value + 1

fn disjoint(readable: State, ~writable: State) -> i32
  let result = read_right(readable)
  mutate_left(~writable)
  result

fn conflicting(readable: State, ~writable: State) -> i32
  let result = read_left(readable)
  mutate_left(~writable)
  result

fn valid(~state: State) -> i32
  disjoint(state, ~state)

fn invalid(~state: State) -> i32
  conflicting(state, ~state)
`;
    const result = analyzeWithRecovery(source);
    const mutateEntry = Array.from(result.borrowing.callables).find(
      ([, contract]) =>
        contract.parameters[0]?.access === "mutable" &&
        contract.parameters[0]?.writePaths?.some(
          (path) =>
            JSON.stringify(path) ===
            JSON.stringify([
              { kind: "field", name: "left" },
              { kind: "dereference" },
              { kind: "field", name: "value" },
            ]),
        ),
    );

    expect(mutateEntry).toBeDefined();
    expect(
      Array.from(result.borrowing.callables.values()).filter((contract) =>
        contract.parameters[0]?.writePaths?.some(
          (path) =>
            JSON.stringify(path) ===
            JSON.stringify([
              { kind: "field", name: "left" },
              { kind: "dereference" },
              { kind: "field", name: "value" },
            ]),
        ),
      ),
    ).toHaveLength(2);
    expect(mutateEntry?.[1].parameters[0]?.writePaths).toContainEqual([
      { kind: "field", name: "left" },
      { kind: "dereference" },
      { kind: "field", name: "value" },
    ]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "TY0048",
    );
  });

  it("serializes SharedCell runtime writes at their physical places", () => {
    const result = analyze(`
@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> {
  __value: T,
  __borrow_state: FixedArray<i32>
}

@intrinsic(name: "__shared_cell_begin_write", uses_signature: false)
fn shared_cell_begin_write<T>(cell: SharedCell<T>): () -> i32
  __shared_cell_begin_write(cell)

@intrinsic(name: "__shared_cell_end_write", uses_signature: false)
fn shared_cell_end_write<T>(cell: SharedCell<T>): () -> void
  __shared_cell_end_write(cell)

@intrinsic(name: "__shared_cell_value", uses_signature: false)
fn shared_cell_value<T>(cell: SharedCell<T>): () -> T
  __shared_cell_value(cell)

@intrinsic(name: "__shared_cell_set_value", uses_signature: false)
fn shared_cell_set_value<T>(cell: SharedCell<T>, value: T): () -> void
  __shared_cell_set_value(cell, value)

impl SharedCell<T>
  fn with_mut(self, body: fn(~T) : () -> void): () -> void
    let status = shared_cell_begin_write(self)
    let ~value = shared_cell_value(self)
    body(~value)
    shared_cell_set_value(self, value)
    shared_cell_end_write(self)
`);
    const statePath = [
      { kind: "field", name: "__borrow_state" },
      { kind: "dereference" },
      { kind: "index", constant: 0, stable: true },
    ] as const;
    const valuePath = [{ kind: "field", name: "__value" }] as const;
    const withMutEntry = Array.from(result.borrowing.callables).find(
      ([, contract]) =>
        contract.parameters[0]?.runtimeCheckedWrites === true &&
        contract.parameters[0]?.writePaths?.some(
          (path) => JSON.stringify(path) === JSON.stringify(statePath),
        ) &&
        contract.parameters[0]?.writePaths?.some(
          (path) => JSON.stringify(path) === JSON.stringify(valuePath),
        ),
    );

    expect(withMutEntry).toBeDefined();
    expect(withMutEntry?.[1].parameters[0]?.writePaths).toEqual(
      expect.arrayContaining([statePath, valuePath]),
    );
    expect(withMutEntry?.[1].parameters[0]?.runtimeCheckedWrites).toBe(true);
  });

  it("propagates runtime-checked writes through wrappers", () => {
    const result = analyze(`
@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> {
  __value: T,
  __borrow_state: FixedArray<i32>
}

obj Wrapper { state: SharedCell<i32> }

@intrinsic(name: "__shared_cell_begin_write", uses_signature: false)
fn shared_cell_begin_write<T>(cell: SharedCell<T>): () -> i32
  __shared_cell_begin_write(cell)

@intrinsic(name: "__shared_cell_end_write", uses_signature: false)
fn shared_cell_end_write<T>(cell: SharedCell<T>): () -> void
  __shared_cell_end_write(cell)

@intrinsic(name: "__shared_cell_value", uses_signature: false)
fn shared_cell_value<T>(cell: SharedCell<T>): () -> T
  __shared_cell_value(cell)

@intrinsic(name: "__shared_cell_set_value", uses_signature: false)
fn shared_cell_set_value<T>(cell: SharedCell<T>, value: T): () -> void
  __shared_cell_set_value(cell, value)

impl SharedCell<T>
  fn with_mut(self, body: fn(~T) : () -> void): () -> void
    let status = shared_cell_begin_write(self)
    let ~value = shared_cell_value(self)
    body(~value)
    shared_cell_set_value(self, value)
    shared_cell_end_write(self)

fn update(wrapper: Wrapper) -> void
  wrapper.state.with_mut((~value) =>
    value = value + 1
  )

fn overwrite(~wrapper: Wrapper) -> void
  wrapper.state.__value = 0

fn mixed_update(~wrapper: Wrapper) -> void
  update(wrapper)
  overwrite(~wrapper)
`);
    const wrapperContract = Array.from(
      result.borrowing.callables.values(),
    ).find(
      (contract) =>
        contract.parameters[0]?.runtimeCheckedWrites === true &&
        contract.parameters[0]?.writePaths?.some(
          (path) => path[0]?.kind === "field" && path[0].name === "state",
        ),
    );

    expect(wrapperContract).toBeDefined();
    const mixedUpdate = result.symbols.resolveTopLevel("mixed_update");
    const mixedContract =
      typeof mixedUpdate === "number"
        ? result.borrowing.callables.get(mixedUpdate)
        : undefined;
    expect(mixedContract?.parameters[0]?.writePaths?.length).toBeGreaterThan(0);
    expect(mixedContract?.parameters[0]?.runtimeCheckedWrites).toBeUndefined();
  });

  it("allows mutable owned allocation aliases to escape as values", () => {
    expect(() =>
      analyze(`
obj Box { value: i32 }

fn owned() -> Box
  let ~value = Box { value: 1 }
  value.value = value.value + 1
  value
`),
    ).not.toThrow();
  });

  it("uses reaching alias definitions for allocation access after reassignment", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj Pair { left: Box }

fn invalid(~pair: Pair, ~direct: Box) -> i32
  var alias = pair.left
  alias = direct
  let ~borrow = direct
  let observed = alias.value
  borrow.value = 3
  observed
`),
    ).toContain("TY0048");
  });

  it("preserves direct allocation access across conditional alias joins", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj Pair { left: Box }

fn invalid(~direct: Box, pair: Pair, replace: bool) -> i32
  var alias = direct
  if replace:
    alias = pair.left
  let ~borrow = direct
  let observed = alias.value
  borrow.value = 3
  observed
`),
    ).toContain("TY0048");
  });

  it("summarizes each allocation origin at conditional alias joins", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj Pair { left: Box }

fn read_choice(direct: Box, pair: Pair, replace: bool) -> i32
  var alias = direct
  if replace:
    alias = pair.left
  alias.value

fn invalid(~direct: Box, pair: Pair, replace: bool) -> i32
  let ~borrow = direct
  let observed = read_choice(direct, pair, replace)
  borrow.value = 3
  observed
`),
    ).toContain("TY0048");
  });

  it("activates projected mutable handles at their allocations", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj Pair { left: Box }

fn invalid(~pair: Pair) -> i32
  let ~alias = pair.left
  pair.left.value = 3
  alias.value
`),
    ).toContain("TY0048");
  });

  it("keeps projected handle slots replaceable during allocation borrows", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj Pair { left: Box }

fn valid(~pair: Pair) -> i32
  let ~alias = pair.left
  pair.left = Box { value: 3 }
  alias.value
`),
    ).not.toContain("TY0048");
  });

  it("keeps reassignable projected handles as ordinary aliases", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj Pair { left: Box }

fn valid(~pair: Pair) -> i32
  let ~borrow = pair.left
  var alias = pair.left
  borrow.value = 3
  alias.value
`),
    ).not.toContain("TY0048");
  });

  it("does not report ordinary aliases as borrows in recovery mode", () => {
    expect(
      recoveryDiagnosticCodes(`${prelude}
fn conflict(~value: Box) -> i32
  let alias = value
  mutate(~value)
  alias.value
`),
    ).not.toContain("TY0048");
  });

  it("keeps transitive ordinary aliases independent of source slots", () => {
    expect(
      diagnosticCodes(`${prelude}
fn conflict(~value: Box) -> i32
  let first = value
  let second = first
  mutate(~value)
  second.value
`),
    ).not.toContain("TY0048");
  });

  it("keeps plain values independent through calls, storage, and capture", () => {
    expect(() =>
      analyze(`${prelude}
obj Holder { value: Box }

fn identity(value: Box) -> Box
  value

fn valid(~value: Box, ~holder: Holder) -> i32
  let alias = identity(value)
  holder.value = alias
  let read_later = () => alias.value
  mutate(~value)
  read_later() + holder.value.value
`),
    ).not.toThrow();
  });

  it("rejects active shared access through an alias during mutation", () => {
    expect(
      diagnosticCodes(`${prelude}
fn read_and_mutate(readable: Box, ~writable: Box) -> void
  read(readable)
  mutate(~writable)

fn conflict(~value: Box) -> void
  let alias = value
  read_and_mutate(alias, ~value)
`),
    ).toContain("TY0048");
  });

  it("keeps internal borrowed results active through their last use", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }

@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

@intrinsic(name: "__shared_cell_value", uses_signature: false)
fn shared_cell_value<T>(cell: SharedCell<T>): () -> T
  __shared_cell_value(cell)

fn mutate_cell(~cell: SharedCell<Box>) -> void
  cell.value = Box { value: 2 }

fn conflict(~cell: SharedCell<Box>) -> i32
  let borrowed = shared_cell_value(cell)
  mutate_cell(~cell)
  borrowed.value
`),
    ).toContain("TY0048");
  });

  it("allows shared access while an internal shared borrow remains live", () => {
    expect(() =>
      analyze(`
obj Box { value: i32 }

@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

@intrinsic(name: "__shared_cell_value", uses_signature: false)
fn shared_cell_value<T>(cell: SharedCell<T>): () -> T
  __shared_cell_value(cell)

fn valid(cell: SharedCell<Box>) -> i32
  let borrowed = shared_cell_value(cell)
  let direct = cell.value.value
  borrowed.value + direct
`),
    ).not.toThrow();
  });

  it("tracks internal borrowed provenance through effect handlers", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }

@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

@intrinsic(name: "__shared_cell_value", uses_signature: false)
fn shared_cell_value<T>(cell: SharedCell<T>): () -> T
  __shared_cell_value(cell)

eff Flag
  get(resume) -> bool

fn mutate_cell(~cell: SharedCell<Box>) -> void
  cell.value = Box { value: 2 }

fn conflict(~cell: SharedCell<Box>) -> i32
  let borrowed =
    try
      shared_cell_value(cell)
    Flag::get(resume):
      resume(true)
  mutate_cell(~cell)
  borrowed.value
`),
    ).toContain("TY0048");
  });

  it("keeps handler alternatives independent after a sibling returns", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }

@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

@intrinsic(name: "__shared_cell_value", uses_signature: false)
fn shared_cell_value<T>(cell: SharedCell<T>): () -> T
  __shared_cell_value(cell)

eff Flag
  get(resume) -> bool

eff Stop
  stop(resume) -> void

fn mutate_cell(~cell: SharedCell<Box>) -> void
  cell.value = Box { value: 2 }

fn conflict(~cell: SharedCell<Box>): (Flag, Stop) -> i32
  let borrowed = shared_cell_value(cell)
  try
    Flag::get()
    borrowed.value
  Flag::get(resume):
    return 0
  Stop::stop(resume):
    mutate_cell(~cell)
    borrowed.value
`),
    ).toContain("TY0048");
  });

  it("does not taint plain siblings of borrowed aggregate values", () => {
    expect(() =>
      analyze(`${prelude}
@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

@intrinsic(name: "__shared_cell_value", uses_signature: false)
fn shared_cell_value<T>(cell: SharedCell<T>): () -> T
  __shared_cell_value(cell)

fn valid(cell: SharedCell<Box>, ~ordinary: Box) -> i32
  let values = (shared_cell_value(cell), ordinary)
  mutate(~ordinary)
  values.1.value
`),
    ).not.toThrow();
  });

  it("preserves mixed aggregate provenance through reassignment", () => {
    expect(() =>
      analyze(`${prelude}
@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

@intrinsic(name: "__shared_cell_value", uses_signature: false)
fn shared_cell_value<T>(cell: SharedCell<T>): () -> T
  __shared_cell_value(cell)

fn valid(cell: SharedCell<Box>, ~ordinary: Box, initial: (Box, Box)) -> i32
  var values = initial
  values = (shared_cell_value(cell), ordinary)
  mutate(~ordinary)
  values.1.value
`),
    ).not.toThrow();
  });

  it("preserves plain provenance when rewrapping an aggregate sibling", () => {
    expect(() =>
      analyze(`${prelude}
obj Wrapper { value: Box }

@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

@intrinsic(name: "__shared_cell_value", uses_signature: false)
fn shared_cell_value<T>(cell: SharedCell<T>): () -> T
  __shared_cell_value(cell)

fn valid(cell: SharedCell<Box>, ~ordinary: Box) -> i32
  let mixed = (shared_cell_value(cell), ordinary)
  let rewrapped = Wrapper { value: mixed.1 }
  mutate(~ordinary)
  rewrapped.value.value
`),
    ).not.toThrow();
  });

  it("preserves plain provenance through direct aggregate projections", () => {
    expect(() =>
      analyze(`${prelude}
obj Wrapper { value: Box }

@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

@intrinsic(name: "__shared_cell_value", uses_signature: false)
fn shared_cell_value<T>(cell: SharedCell<T>): () -> T
  __shared_cell_value(cell)

fn valid(cell: SharedCell<Box>, ~ordinary: Box) -> i32
  let rewrapped =
    Wrapper { value: (shared_cell_value(cell), ordinary).1 }
  mutate(~ordinary)
  rewrapped.value.value
`),
    ).not.toThrow();
  });

  it("preserves plain provenance through nested tuple projections", () => {
    expect(() =>
      analyze(`${prelude}
@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

@intrinsic(name: "__shared_cell_value", uses_signature: false)
fn shared_cell_value<T>(cell: SharedCell<T>): () -> T
  __shared_cell_value(cell)

fn valid(cell: SharedCell<Box>, ~ordinary: Box) -> i32
  let nested = ((shared_cell_value(cell), ordinary), 0)
  let inner = nested.0
  let selected = inner.1
  mutate(~ordinary)
  selected.value
`),
    ).not.toThrow();
  });

  it("materializes internal borrowed provenance at plain wrapper returns", () => {
    expect(() =>
      analyze(`
obj Box { value: i32 }

@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

@intrinsic(name: "__shared_cell_value", uses_signature: false)
fn shared_cell_value<T>(cell: SharedCell<T>): () -> T
  __shared_cell_value(cell)

fn copied_value(cell: SharedCell<Box>) -> Box
  shared_cell_value(cell)

fn mutate_cell(~cell: SharedCell<Box>) -> void
  cell.value = Box { value: 2 }

fn valid(~cell: SharedCell<Box>) -> i32
  let copied = copied_value(cell)
  mutate_cell(~cell)
  copied.value
`),
    ).not.toThrow();
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

  it("does not report borrow lifetimes for ordinary aliases", () => {
    expect(
      diagnosticsFor(`${prelude}
fn conflict(~value: Box) -> i32
  let alias = value
  mutate(~value)
  alias.value
`),
    ).toEqual([]);
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
    ).not.toContain("TY0048");
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
    ).not.toContain("TY0048");
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

  it("does not project direct local-container writes onto stored aliases", () => {
    expect(
      diagnosticCodes(`${prelude}
obj Holder { value: Box }

fn replace(~holder: Holder, replacement: Box) -> void
  holder.value = replacement

fn stage(source: Box, replacement: Box, observer: Box) -> Box
  let ~out = Holder { value: source }
  replace(~out, replacement)
  observer

fn valid(~value: Box) -> Box
  stage(value, Box { value: 0 }, value)
`),
    ).not.toContain("TY0048");
  });

  it("does not project returned-container slot writes onto field aliases", () => {
    expect(
      diagnosticCodes(`${prelude}
obj Holder { value: Box }

fn make(value: Box) -> Holder
  Holder { value }

fn update(~holder: Holder, replacement: Box, ~value: Box) -> void
  holder.value = replacement
  value.value = value.value + 1

fn valid(~value: Box) -> void
  let ~holder = make(value)
  update(~holder, Box { value: 0 }, ~value)
`),
    ).not.toContain("TY0048");
  });

  it("resolves summarized aggregate writes through contained references", () => {
    expect(
      diagnosticCodes(`${prelude}
fn mutate_left(~pair: Pair) -> void
  pair.left.value = pair.left.value + 1

fn valid() -> i32
  let ~pair = Pair {
    left: Box { value: 1 },
    right: Box { value: 2 }
  }
  let view: borrow Box = pair.right
  mutate_left(~pair)
  view.value

fn invalid() -> i32
  let ~pair = Pair {
    left: Box { value: 1 },
    right: Box { value: 2 }
  }
  let view: borrow Box = pair.left
  mutate_left(~pair)
  view.value

fn invalid_alias(~value: Box) -> i32
  let ~pair = Pair { left: value, right: value }
  let view: borrow Box = pair.right
  mutate_left(~pair)
  view.value

fn invalid_replacement() -> i32
  let ~pair = Pair {
    left: Box { value: 1 },
    right: Box { value: 2 }
  }
  pair.left = pair.right
  let view: borrow Box = pair.right
  mutate_left(~pair)
  view.value

fn replace_left(~pair: Pair) -> void
  pair.left = pair.right

fn valid_replacement_only() -> i32
  let ~pair = Pair {
    left: Box { value: 1 },
    right: Box { value: 2 }
  }
  let view: borrow Box = pair.right
  replace_left(~pair)
  view.value

fn alias_and_mutate(~pair: Pair) -> void
  pair.left = pair.right
  pair.left.value = pair.left.value + 1

fn invalid_same_call() -> i32
  let ~pair = Pair {
    left: Box { value: 1 },
    right: Box { value: 2 }
  }
  let view: borrow Box = pair.right
  alias_and_mutate(~pair)
  view.value

fn valid_sibling_branch(flag: bool) -> i32
  let ~pair = Pair {
    left: Box { value: 1 },
    right: Box { value: 2 }
  }
  if flag:
    pair.left = pair.right
    0
  else:
    let view: borrow Box = pair.right
    mutate_left(~pair)
    view.value

fn valid_sibling_reassignment(flag: bool, value: Box) -> i32
  var pair = Pair {
    left: Box { value: 1 },
    right: Box { value: 2 }
  }
  if flag:
    pair = Pair { left: value, right: value }
    0
  else:
    let view: borrow Box = pair.right
    mutate_left(~pair)
    view.value

fn valid_fresh_reassignment(value: Box) -> i32
  var pair = Pair { left: value, right: value }
  pair = Pair {
    left: Box { value: 1 },
    right: Box { value: 2 }
  }
  let view: borrow Box = pair.right
  mutate_left(~pair)
  view.value

fn invalid_loop(flag: bool) -> i32
  let ~pair = Pair {
    left: Box { value: 1 },
    right: Box { value: 2 }
  }
  while flag:
    let view: borrow Box = pair.right
    mutate_left(~pair)
    let observed = view.value
    pair.left = pair.right
    let _ = observed
  0

fn invalid_call_loop(flag: bool) -> i32
  let ~pair = Pair {
    left: Box { value: 1 },
    right: Box { value: 2 }
  }
  while flag:
    let view: borrow Box = pair.right
    mutate_left(~pair)
    let observed = view.value
    replace_left(~pair)
    let _ = observed
  0

fn invalid_unconditional_loop(stop: bool) -> i32
  let ~pair = Pair {
    left: Box { value: 1 },
    right: Box { value: 2 }
  }
  while true:
    if stop:
      break
    let view: borrow Box = pair.right
    mutate_left(~pair)
    let observed = view.value
    replace_left(~pair)
    let _ = observed
  0

fn invalid_conditional(flag: bool, value: Box) -> i32
  var pair = Pair { left: value, right: value }
  if flag:
    pair = Pair {
      left: Box { value: 1 },
      right: Box { value: 2 }
    }
  let view: borrow Box = pair.right
  mutate_left(~pair)
  view.value

val InlinePair { left: Box, right: Box }
val Outer { pair: InlinePair }

fn mutate_outer_left(~outer: Outer) -> void
  outer.pair.left.value = outer.pair.left.value + 1

fn invalid_nested_snapshot(value: Box) -> i32
  var pair = InlinePair { left: value, right: value }
  let ~outer = Outer { pair }
  pair = InlinePair {
    left: Box { value: 1 },
    right: Box { value: 2 }
  }
  let view: borrow Box = outer.pair.right
  mutate_outer_left(~outer)
  view.value

fn invalid_nested_field_snapshot() -> i32
  let ~pair = InlinePair {
    left: Box { value: 1 },
    right: Box { value: 2 }
  }
  pair.left = pair.right
  let ~outer = Outer { pair }
  let view: borrow Box = outer.pair.right
  mutate_outer_left(~outer)
  view.value

fn invalid_nested_conditional(flag: bool, value: Box) -> i32
  var pair = InlinePair { left: value, right: value }
  if flag:
    pair = InlinePair {
      left: Box { value: 1 },
      right: Box { value: 2 }
    }
  let ~outer = Outer { pair }
  let view: borrow Box = outer.pair.right
  mutate_outer_left(~outer)
  view.value
`).filter((code) => code === "TY0048"),
    ).toHaveLength(11);
  });

  it("does not project direct local-container reads onto stored aliases", () => {
    expect(
      diagnosticCodes(`${prelude}
obj Holder { value: Box }

fn inspect(holder: Holder) -> Box
  holder.value

fn stage(source: Box, ~target: Box) -> i32
  let holder = Holder { value: source }
  mutate(~target)
  let ignored = inspect(holder)
  1

fn valid(~value: Box) -> i32
  stage(value, ~value)
`),
    ).not.toContain("TY0048");
  });

  it("allows ordinary handles passed to opaque retaining callables", () => {
    expect(
      diagnosticCodes(`${prelude}
fn invoke(~value: Box, callback: fn(Box) : () -> void) -> void
  callback(value)
`),
    ).not.toContain("TY0049");
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

  it("keeps loans produced by earlier defaults active during later defaults", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
val Holder { view: borrow Box }
let global = Box { value: 0 }

fn mutate_and_read(~value: Box) -> i32
  value.value = 1
  value.value

fn conflict(
  holder: Holder = Holder { view: global },
  ignored: i32 = mutate_and_read(~global)
) -> i32
  holder.view.value + ignored

fn main() -> i32
  conflict()
`),
    ).toContain("TY0048");
  });

  it("preserves projections when applying reference defaults", () => {
    const source = `${prelude}
obj Owner { primary: Box, secondary: Box }

fn inspect(owner: Owner, selected: Box = owner.primary) -> i32
  selected.value

fn relay(~target: Box, owner: Owner) -> i32
  mutate(~target)
  inspect(owner)
`;
    expect(
      diagnosticCodes(`${source}
fn valid(~owner: Owner) -> i32
  relay(~owner.secondary, owner)
`),
    ).not.toContain("TY0048");
    expect(
      diagnosticCodes(`${source}
fn conflict(~owner: Owner) -> i32
  relay(~owner.primary, owner)
`),
    ).toContain("TY0048");
  });

  it("maps default access paths through allocation-backed actuals", () => {
    expect(
      diagnosticCodes(`${prelude}
obj Owner { primary: Box }

fn inspect(owner: Owner, selected: Box = owner.primary) -> i32
  selected.value

fn invalid(~owner: Owner) -> i32
  let ~exclusive = owner.primary
  let observed = inspect(owner)
  mutate(~exclusive)
  observed
`),
    ).toContain("TY0048");
  });

  it("applies default expression reads only when the argument is omitted", () => {
    const source = `${prelude}
obj Owner { primary: Box }

fn inspect(owner: Owner, selected: Box = owner.primary) -> i32
  selected.value

fn relay_explicit(~target: Box, owner: Owner) -> i32
  mutate(~target)
  inspect(owner, Box { value: 0 })

fn relay_omitted(~target: Box, owner: Owner) -> i32
  mutate(~target)
  inspect(owner)
`;
    expect(
      diagnosticCodes(`${source}
fn valid(~owner: Owner) -> i32
  relay_explicit(~owner.primary, owner)
`),
    ).not.toContain("TY0048");
    expect(
      diagnosticCodes(`${source}
fn conflict(~owner: Owner) -> i32
  relay_omitted(~owner.primary, owner)
`),
    ).toContain("TY0048");
  });

  it("ends default-only reads before activating call borrows", () => {
    expect(
      diagnosticCodes(`${prelude}
obj Owner { primary: Box }

fn update(~target: Box, owner: Owner, ignored: i32 = owner.primary.value) -> void
  target.value = 1

fn valid(~owner: Owner) -> void
  update(~owner.primary, owner)
`),
    ).not.toContain("TY0048");
  });

  it("rejects overlapping accesses within one omitted default", () => {
    expect(
      diagnosticCodes(`${prelude}
fn write_pair(~left: Box, ~right: Box) -> void
  left.value = 1
  right.value = 2

fn default_mutate(~left: Box, ~right: Box) -> i32
  write_pair(~left, ~right)
  0

fn run(
  ~left: Box,
  ~right: Box,
  ignored: i32 = default_mutate(~left, ~right)
) -> i32
  ignored

fn invalid(~value: Box) -> i32
  run(~value, ~value)
`),
    ).toContain("TY0048");
  });

  it("propagates direct writes through omitted reference defaults", () => {
    expect(
      diagnosticCodes(`${prelude}
fn update(~source: Box, ~target: Box = source) -> void
  target.value = 1

fn relay(~source: Box, observer: Box) -> i32
  update(~source)
  observer.value

fn conflict(~value: Box) -> i32
  relay(~value, value)
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
    ).not.toContain("TY0048");
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
    ).not.toContain("TY0048");
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
    ).not.toContain("TY0048");
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
    ).not.toContain("TY0048");
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
    ).not.toContain("TY0048");
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
    ).not.toContain("TY0048");
  });

  it("does not turn outer aliases into loans around loops", () => {
    expect(
      diagnosticCodes(`${prelude}
fn conflict(~value: Box, should_return: bool) -> i32
  let alias = value
  while should_return:
    return 0
  mutate(~value)
  alias.value
`),
    ).not.toContain("TY0048");
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
    ).not.toContain("TY0048");
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

  it("does not downgrade handles stored through fixed-array intrinsics", () => {
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
    ).toEqual([]);
  });

  it("preserves fixed-array literal element origins", () => {
    expect(
      diagnosticCodes(`${prelude}
fn fixed(value: Box) -> FixedArray<Box>
  __array_new_fixed(value)

fn invalid(~value: Box) -> i32
  let values = fixed(value)
  mutate(~value)
  __array_get(values, 0).value
`),
    ).not.toContain("TY0048");
  });

  it("does not treat aggregate storage as reading stored references", () => {
    expect(() =>
      analyze(`${prelude}
obj Holder { value: Box }

fn aggregate_without_read(value: Box, ~same: Box) -> void
  let fixed = __array_new_fixed(value)
  let object = Holder { value }
  mutate(~same)

fn valid(~value: Box) -> void
  aggregate_without_read(value, ~value)

fn count_stored(value: Box) -> i32
  __array_len(__array_new_fixed(value))

fn inspect_identity(value: Box) -> bool
  __ref_is_null(__array_new_fixed(value))

fn valid_metadata_reads(~value: Box) -> i32
  let count = count_stored(value)
  let ignored = inspect_identity(value)
  mutate(~value)
  count
`),
    ).not.toThrow();
  });

  it("keeps distinct fixed-array literal elements disjoint", () => {
    expect(() =>
      analyze(`${prelude}
fn fixed(left: Box, right: Box) -> FixedArray<Box>
  __array_new_fixed(left, right)

fn read_second(values: FixedArray<Box>) -> i32
  __array_get(values, 1).value

fn valid(~left: Box, ~right: Box) -> i32
  let values = fixed(left, right)
  mutate(~left)
  read_second(values)
`),
    ).not.toThrow();
  });

  it("keeps dynamic fixed-array reads connected to every possible input", () => {
    expect(
      diagnosticCodes(`${prelude}
fn fixed(left: Box, right: Box) -> FixedArray<Box>
  __array_new_fixed(left, right)

fn read_dynamic(values: FixedArray<Box>, index: i32) -> i32
  __array_get(values, index).value

fn read_fixed_inputs(left: Box, right: Box, index: i32) -> i32
  read_dynamic(fixed(left, right), index)

fn inspect(
  left: Box,
  right: Box,
  index: i32,
  ~same: Box
) -> i32
  let observed = read_fixed_inputs(left, right, index)
  mutate(~same)
  observed

fn invalid(~left: Box, right: Box, index: i32) -> i32
  inspect(left, right, index, ~left)
`),
    ).toContain("TY0048");

    expect(
      diagnosticCodes(`${prelude}
fn fixed(left: Box, right: Box) -> FixedArray<Box>
  __array_new_fixed(left, right)

fn invalid_direct(~left: Box, right: Box, index: i32) -> i32
  let values = fixed(left, right)
  mutate(~left)
  __array_get(values, index).value
`),
    ).not.toContain("TY0048");
  });

  it("preserves indexed-allocation provenance at projected endpoints", () => {
    expect(
      diagnosticCodes(`${prelude}
obj Source { storage: FixedArray<Box> }
obj Holder { storage: FixedArray<Box> }

fn fixed(left: Box, right: Box) -> FixedArray<Box>
  __array_new_fixed(left, right)

fn wrap(source: Source) -> Holder
  Holder { storage: source.storage }

fn inspect(source: Source, index: i32, ~same: Box) -> i32
  let holder = wrap(source)
  let observed = __array_get(holder.storage, index).value
  mutate(~same)
  observed

fn invalid(~left: Box, right: Box, index: i32) -> i32
  inspect(Source { storage: fixed(left, right) }, index, ~left)
`),
    ).toContain("TY0048");

    expect(
      diagnosticCodes(`${prelude}
fn fixed(left: Box, right: Box) -> FixedArray<Box>
  __array_new_fixed(left, right)

fn inspect(
  { values: FixedArray<Box>, ignored: Box },
  index: i32,
  ~same: Box
) -> i32
  let observed = __array_get(values, index).value
  mutate(~same)
  observed + ignored.value

fn invalid(~left: Box, right: Box, index: i32) -> i32
  inspect({ values: fixed(left, right), ignored: right }, index, ~left)
`),
    ).toContain("TY0048");
  });

  it("keeps fixed-array identity disjoint from element mutation", () => {
    expect(
      diagnosticCodes(`${prelude}
fn fixed_length(values: FixedArray<Box>) -> i32
  __array_len(values)

fn replace_first(~values: FixedArray<Box>) -> void
  __array_set(values, 0, Box { value: 1 })
  void

fn inspect(values: FixedArray<Box>, ~same: FixedArray<Box>) -> i32
  let length = fixed_length(values)
  replace_first(~same)
  length

fn invalid(~values: FixedArray<Box>) -> i32
  inspect(values, ~values)
`),
    ).not.toContain("TY0048");
  });

  it("keeps shared-declared array writes exclusive in plain-reference callers", () => {
    expect(
      diagnosticCodes(`${prelude}
fn write(values: FixedArray<i32>) -> void
  __array_set(values, 0, 1)
  void

fn write_two(left: FixedArray<i32>, right: FixedArray<i32>) -> void
  write(left)
  write(right)

fn invalid(values: FixedArray<i32>) -> void
  write_two(values, values)
`),
    ).toContain("TY0048");
  });

  it("keeps immutable reference identity disjoint from allocation fields", () => {
    expect(
      diagnosticCodes(`${prelude}
fn is_null(value: Box) -> bool
  __ref_is_null(value)

fn inspect(value: Box, ~same: Box) -> bool
  let result = is_null(value)
  mutate(~same)
  result

fn invalid(~value: Box) -> bool
  inspect(value, ~value)
`),
    ).not.toContain("TY0048");
  });

  it("does not retain inputs through detached boundary conversion results", () => {
    expect(() =>
      analyze(`${prelude}
obj Packed { value: i32 }

@intrinsic(name: "__boundary_value_to_msgpack")
fn pack<T>(value: T) -> Packed
  __boundary_value_to_msgpack(value)

fn read_packed(value: Packed) -> i32
  value.value

fn valid(~value: Box) -> i32
  let packed = pack(value)
  mutate(~value)
  read_packed(packed)
`),
    ).not.toThrow();
  });

  it("returns only matching source values through identity conversion", () => {
    expect(
      diagnosticCodes(`${prelude}
obj Packed { value: i32 }

@intrinsic(name: "__boundary_msgpack_to_value_or_identity")
fn convert<T, U>(source: U, value: Packed) -> T
  __boundary_msgpack_to_value_or_identity<T, U>(source, value)

fn maybe_identity<T, U>(source: U, packed: Packed) -> T
  convert<T, U>(source, packed)

fn read_identity(source: Box, packed: Packed) -> Box
  maybe_identity<Box, Box>(source, packed)

fn invalid(~value: Box, packed: Packed) -> i32
  let identity = read_identity(value, packed)
  mutate(~value)
  read(identity)
`),
    ).not.toContain("TY0048");

    expect(() =>
      analyze(`${prelude}
obj Packed { value: i32 }
obj Decoded { value: i32 }

@intrinsic(name: "__boundary_msgpack_to_value_or_identity")
fn convert<T, U>(source: U, value: Packed) -> T
  __boundary_msgpack_to_value_or_identity<T, U>(source, value)

fn maybe_identity<T, U>(source: U, packed: Packed) -> T
  convert<T, U>(source, packed)

fn decode(source: Box, packed: Packed) -> Decoded
  maybe_identity<Decoded, Box>(source, packed)

fn read_decoded(value: Decoded) -> i32
  value.value

fn valid(~value: Box, packed: Packed) -> i32
  let decoded = decode(value, packed)
  mutate(~value)
  read_decoded(decoded)
`),
    ).not.toThrow();

    expect(() =>
      analyze(`
obj Box { value: i32 }
obj Packed { value: i32 }

@intrinsic(name: "__boundary_msgpack_to_value_or_identity")
fn convert<T, U>(source: U, value: Packed) -> T
  __boundary_msgpack_to_value_or_identity<T, U>(source, value)

fn maybe_identity<T, U>(source: U, packed: Packed) -> T
  convert<T, U>(source, packed)

fn mutate_packed(~value: Packed) -> void
  value.value = value.value + 1

fn choose(
  source: Box,
  packed: Packed,
  ~same: Packed
) -> Box
  let chosen = maybe_identity<Box, Box>(source, packed)
  mutate_packed(~same)
  chosen

fn valid(source: Box, ~packed: Packed) -> Box
  choose(source, packed, ~packed)
`),
    ).not.toThrow();
  });

  it("preserves conditional identity through aggregate and source projections", () => {
    expect(
      diagnosticCodes(`${prelude}
obj Packed { value: i32 }
obj Holder<T> { value: T }
obj Source<T> { value: T }

@intrinsic(name: "__boundary_msgpack_to_value_or_identity")
fn convert<T, U>(source: U, value: Packed) -> T
  __boundary_msgpack_to_value_or_identity<T, U>(source, value)

fn wrap<T, U>(source: U, packed: Packed) -> Holder<T>
  Holder<T> { value: convert<T, U>(source, packed) }

fn unwrap<T, U>(source: Source<U>, packed: Packed) -> T
  convert<T, U>(source.value, packed)

fn invalid_wrapped(~value: Box, packed: Packed) -> i32
  let holder = wrap<Box, Box>(value, packed)
  mutate(~value)
  holder.value.value

fn invalid_projected(~source: Source<Box>, packed: Packed) -> i32
  let alias = unwrap<Box, Box>(source, packed)
  mutate(~source.value)
  alias.value
`),
    ).not.toContain("TY0048");

    expect(() =>
      analyze(`${prelude}
obj Packed { value: i32 }
obj Decoded { value: i32 }
obj Holder<T> { value: T }

@intrinsic(name: "__boundary_msgpack_to_value_or_identity")
fn convert<T, U>(source: U, value: Packed) -> T
  __boundary_msgpack_to_value_or_identity<T, U>(source, value)

fn wrap<T, U>(source: U, packed: Packed) -> Holder<T>
  Holder<T> { value: convert<T, U>(source, packed) }

fn read_decoded(value: Decoded) -> i32
  value.value

fn valid(~value: Box, packed: Packed) -> i32
  let holder = wrap<Decoded, Box>(value, packed)
  mutate(~value)
  read_decoded(holder.value)
`),
    ).not.toThrow();
  });

  it("keeps conditional packed access when its decoded value is not returned", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj Packed { value: i32 }
obj Decoded { value: i32 }

@intrinsic(name: "__boundary_msgpack_to_value_or_identity")
fn convert<T, U>(source: U, value: Packed) -> T
  __boundary_msgpack_to_value_or_identity<T, U>(source, value)

fn mutate_packed(~value: Packed) -> void
  value.value = value.value + 1

fn decode_and_return_source(
  source: Box,
  packed: Packed,
  ~same: Packed
) -> Box
  let decoded = convert<Decoded, Box>(source, packed)
  let observed = decoded.value
  mutate_packed(~same)
  source

fn invalid(source: Box, ~packed: Packed) -> Box
  decode_and_return_source(source, packed, ~packed)
`),
    ).toContain("TY0048");
  });

  it("does not pair access with an unrelated conditional return", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj Packed { value: i32 }
obj Decoded { value: i32 }

@intrinsic(name: "__boundary_msgpack_to_value_or_identity")
fn convert<T, U>(source: U, value: Packed) -> T
  __boundary_msgpack_to_value_or_identity<T, U>(source, value)

fn mutate_packed(~value: Packed) -> void
  value.value = value.value + 1

fn convert_twice<T, U>(
  source: U,
  packed_a: Packed,
  packed_b: Packed,
  ~same_a: Packed
) -> T
  let decoded = convert<Decoded, U>(source, packed_a)
  let observed = decoded.value
  let result = convert<T, U>(source, packed_b)
  mutate_packed(~same_a)
  result

fn invalid(
  source: Box,
  ~packed_a: Packed,
  packed_b: Packed
) -> Box
  convert_twice<Box, Box>(
    source,
    packed_a,
    packed_b,
    ~packed_a
  )
`),
    ).toContain("TY0048");
  });

  it("converges conditional contracts through recursive wrappers", () => {
    expect(
      diagnosticCodes(`${prelude}
obj Packed { value: i32 }

@intrinsic(name: "__boundary_msgpack_to_value_or_identity")
fn convert<T, U>(source: U, value: Packed) -> T
  __boundary_msgpack_to_value_or_identity<T, U>(source, value)

fn recursive_convert<T, U>(
  source: U,
  packed: Packed,
  recurse: bool
) -> T
  if recurse:
    recursive_convert<T, U>(source, packed, false)
  else:
    convert<T, U>(source, packed)

fn invalid(~source: Box, packed: Packed) -> i32
  let alias = recursive_convert<Box, Box>(source, packed, true)
  mutate(~source)
  read(alias)
`),
    ).not.toContain("TY0048");
  });

  it("keeps an origin unconditional when any return path is unconditional", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj Other { value: i32 }
obj Packed { value: i32 }
type Choice = Box | Other

fn mutate(~value: Box) -> void
  value.value = value.value + 1

@intrinsic(name: "__boundary_msgpack_to_value_or_identity")
fn convert<T, U>(source: U, value: Packed) -> T
  __boundary_msgpack_to_value_or_identity<T, U>(source, value)

fn maybe(
  source: Box,
  packed: Packed,
  converted: bool
) -> Choice
  if converted:
    convert<Choice, Box>(source, packed)
  else:
    source

fn read_choice(value: Choice) -> i32
  match(value)
    Box:
      value.value
    Other:
      value.value

fn invalid(~source: Box, packed: Packed) -> i32
  let alias = maybe(source, packed, false)
  mutate(~source)
  read_choice(alias)
`),
    ).not.toContain("TY0048");
  });

  it("preserves identity provenance through boundary conversion wrappers", () => {
    const source = `
obj Packed { value: i32 }

@intrinsic(name: "__boundary_value_to_msgpack")
fn pack<T>(value: T) -> Packed
  __boundary_value_to_msgpack(value)

@intrinsic(name: "__boundary_msgpack_to_value")
fn unpack<T>(value: Packed) -> T
  __boundary_msgpack_to_value<T>(value)

fn wrapped_pack<T>(value: T) -> Packed
  pack(value)

fn wrapped_unpack<T>(value: Packed) -> T
  unpack<T>(value)

fn mutate_packed(~value: Packed) -> void
  value.value = value.value + 1

fn read_packed(value: Packed) -> i32
  value.value

fn invalid_pack(~value: Packed) -> i32
  let alias = wrapped_pack<Packed>(value)
  mutate_packed(~value)
  read_packed(alias)

fn invalid_unpack(~value: Packed) -> i32
  let alias = wrapped_unpack<Packed>(value)
  mutate_packed(~value)
  read_packed(alias)
`;
    expect(
      diagnosticCodes(source).filter((code) => code === "TY0048"),
    ).toHaveLength(0);
  });

  it("keeps empty mutable footprints disjoint from discriminant reads", () => {
    expect(
      diagnosticCodes(`${prelude}
obj First { value: Box }
obj Second { value: Box }
type Choice = First | Second

fn tag(value: Choice) -> i32
  match(value)
    First:
      1
    Second:
      2

fn mutate_choice(~value: Choice) -> void
  void

fn inspect(value: Choice, ~same: Choice) -> i32
  let result = tag(value)
  mutate_choice(~same)
  result

fn invalid(~value: Choice) -> i32
  inspect(value, ~value)
`),
    ).not.toContain("TY0048");

    expect(() =>
      analyze(`${prelude}
obj First { value: Box }
obj Second { value: Box }
type Choice = First | Second

fn tag(value: Choice) -> i32
  match(value)
    First:
      1
    Second:
      2

fn valid(~value: Box) -> i32
  let choice: Choice = First { value }
  let result = tag(choice)
  mutate(~value)
  result
`),
    ).not.toThrow();
  });

  it("keeps empty mutable footprints disjoint from nested scalar reads", () => {
    expect(
      diagnosticCodes(`
obj Inner { value: i32 }
obj Container { inner: Inner, values: (i32, i32) }

fn read_nested(container: Container) -> i32
  let { inner: { value: result } } = container
  result

fn read_tuple(container: Container) -> i32
  let { values: (result, ignored) } = container
  result

fn mutate_container(~container: Container) -> void
  void

fn inspect_nested(
  container: Container,
  ~same: Container
) -> i32
  let result = read_nested(container)
  mutate_container(~same)
  result

fn inspect_tuple(
  container: Container,
  ~same: Container
) -> i32
  let result = read_tuple(container)
  mutate_container(~same)
  result

fn invalid_nested(~container: Container) -> i32
  inspect_nested(container, ~container)

fn invalid_tuple(~container: Container) -> i32
  inspect_tuple(container, ~container)
`),
    ).not.toContain("TY0048");
  });

  it("keeps empty mutable footprints disjoint from captured scalar reads", () => {
    expect(
      diagnosticCodes(`
obj Inner { value: i32 }
obj Container { inner: Inner }

fn read_captured(container: Container) -> i32
  let { inner: { value: result } } = container
  let read = () => result
  read()

fn mutate_container(~container: Container) -> void
  void

fn inspect(container: Container, ~same: Container) -> i32
  let result = read_captured(container)
  mutate_container(~same)
  result

fn invalid(~container: Container) -> i32
  inspect(container, ~container)
`),
    ).not.toContain("TY0048");
  });

  it("does not borrow through unused shared parameters", () => {
    expect(() =>
      analyze(`${prelude}
fn ignore(value: Box) -> void
  void

fn valid(~value: Box) -> void
  let alias = value
  mutate(~value)
  ignore(alias)
`),
    ).not.toThrow();
  });

  it("allows mutation after retaining a copied array element", () => {
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
    ).not.toContain("TY0049");
  });

  it("keeps retained copied elements independent when returning the array", () => {
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
    ).not.toContain("TY0049");
  });

  it("allows array mutation after storing a copied element", () => {
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
    ).not.toContain("TY0049");
  });

  it("records source reads through array-copy options", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }

fn copy_and_mutate(
  source: FixedArray<Box>,
  ~same: FixedArray<Box>
) -> void
  let destination = __array_new<Box>(1)
  __array_copy(destination, {
    from: source,
    to_index: 0,
    from_index: 0,
    count: 1
  })
  mutate_array(~same)

fn mutate_array(~values: FixedArray<Box>) -> void
  __array_set(values, 0, Box { value: 1 })
  void

fn invalid(~source: FixedArray<Box>) -> void
  copy_and_mutate(source, ~source)
`),
    ).toContain("TY0048");
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
    ).not.toContain("TY0048");
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
    ).not.toContain("TY0048");
  });

  it("preserves reference provenance through tuple storage", () => {
    expect(
      diagnosticCodes(`${prelude}
fn invalid(~value: Box, other: Box) -> i32
  let values = (value, other)
  mutate(~value)
  values.0.value
`),
    ).not.toContain("TY0048");
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
    ).not.toContain("TY0048");
  });

  it("preserves aggregate provenance through destructuring", () => {
    expect(
      diagnosticCodes(`${prelude}
fn invalid(~value: Box, other: Box) -> i32
  let (alias, _) = (value, other)
  mutate(~value)
  alias.value
`),
    ).not.toContain("TY0048");
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
    ).not.toContain("TY0048");

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
    ).not.toContain("TY0048");
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
    ).not.toContain("TY0048");
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
    ).not.toContain("TY0048");
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
    ).not.toContain("TY0048");
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
    ).not.toContain("TY0048");
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
    ).not.toContain("TY0048");
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
    ).not.toContain("TY0048");
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
    const result = analyze(`${prelude}
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
`);
    const retainedEntry = Array.from(result.borrowing.callables).find(
      ([, contract]) =>
        contract.parameters.some(
          (parameter) => (parameter.retainedPaths?.length ?? 0) > 0,
        ),
    );
    expect(retainedEntry).toBeDefined();
    if (!retainedEntry) {
      return;
    }
    expect(
      retainedEntry[1].parameters.some(
        (parameter) => (parameter.retainedPaths?.length ?? 0) > 0,
      ),
    ).toBe(true);
  });

  it("does not downgrade an ordinary handle passed to a retaining call", () => {
    expect(
      diagnosticCodes(`${prelude}
obj Holder { value: Box }

fn retain(~holder: Holder, value: Box) -> void
  holder.value = value

fn invalid(~value: Box, ~holder: Holder) -> void
  retain(~holder, value)
  mutate(~value)
`),
    ).toEqual([]);
  });

  it("does not downgrade aliases retained from returned aggregates", () => {
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
    ).toEqual([]);
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
    expect(
      retainContract?.parameters[0]?.borrowedRetainedPaths,
    ).toBeUndefined();
    expect(diagnostics).toEqual([]);
  });

  it("materializes internal borrowed values across plain module returns", async () => {
    const srcRoot = resolve("/proj/src");
    const stdRoot = resolve("/proj/std");
    const host = createMemoryModuleHost({
      files: {
        [`${stdRoot}${sep}storage.voyd`]: `
pub obj Box { api value: i32 }

@intrinsic_type(type: "voyd.std.shared-cell")
pub obj SharedCell<T> { api value: T }

@intrinsic(name: "__shared_cell_value", uses_signature: false)
pub fn shared_cell_value<T>(cell: SharedCell<T>): () -> T
  __shared_cell_value(cell)

pub fn copied_value(cell: SharedCell<Box>) -> Box
  shared_cell_value(cell)
`,
        [`${srcRoot}${sep}main.voyd`]: `
use std::storage::{ Box, SharedCell, copied_value }

fn mutate_cell(~cell: SharedCell<Box>) -> void
  cell.value = Box { value: 2 }

fn valid(~cell: SharedCell<Box>) -> i32
  let copied = copied_value(cell)
  mutate_cell(~cell)
  copied.value
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

    expect(diagnostics).toEqual([]);
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
    expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
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
    expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      "TY0049",
    );
  });

  it("publishes projected access contracts across modules", async () => {
    const srcRoot = resolve("/proj/src");
    const stdRoot = resolve("/proj/std");
    const host = createMemoryModuleHost({
      files: {
        [`${stdRoot}${sep}fixed.voyd`]: `
pub obj Box { api value: i32 }

pub fn fixed(left: Box, right: Box) -> FixedArray<Box>
  __array_new_fixed(left, right)

pub fn read_second(values: FixedArray<Box>) -> i32
  __array_get(values, 1).value
`,
        [`${srcRoot}${sep}main.voyd`]: `
use std::fixed::{ Box, fixed, read_second }

fn mutate(~box: Box) -> void
  box.value = box.value + 1

pub fn valid(~left: Box, ~right: Box) -> i32
  let values = fixed(left, right)
  mutate(~left)
  read_second(values)
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
    const readExport = analyzed.semantics
      .get("std::fixed")
      ?.exports.get("read_second");
    const readContract = readExport?.borrowing?.find(
      (entry) => entry.symbol === readExport.symbol,
    )?.contract;
    expect(readContract?.parameters[0]?.readPaths).toEqual([
      [{ kind: "dereference" }, { kind: "index", constant: 1, stable: true }],
      [
        { kind: "dereference" },
        { kind: "index", constant: 1, stable: true },
        { kind: "dereference" },
        { kind: "field", name: "value" },
      ],
    ]);
    expect(diagnostics).toEqual([]);
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

  it("widens recursive external projections to a conservative root", () => {
    const result = analyze(`
obj Box { value: i32 }
obj Empty {}
obj Link {
  value: Box | Empty,
  next: Link | Empty
}
let global = Box { value: 0 }

fn chain(depth: i32) -> Link
  if depth <= 0:
    return Link { value: global, next: Empty {} }
  Link { value: Empty {}, next: chain(depth - 1) }
`);
    const recursive = Array.from(result.borrowing.callables.values()).find(
      (contract) =>
        contract.externalReturnedOrigins?.some(
          (origin) => origin.result.length === 0,
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

  it("bounds nested physical provenance across returned-origin calls", () => {
    const nestedSelection = Array.from({ length: 8 }).reduce(
      (value) => `select(${value}, true)`,
      "value",
    );

    expect(() =>
      analyze(`
obj Tree {
  value: i32,
  left: Tree,
  right: Tree
}

fn select(value: borrow Tree, choose_left: bool) -> borrow Tree
  if choose_left:
    value.left
  else:
    value.right

fn nested(value: borrow Tree) -> borrow Tree
  ${nestedSelection}
`),
    ).not.toThrow();
  });

  it("keeps widened origin families conservative", () => {
    const fields = Array.from(
      { length: 40 },
      (_entry, index) => `field_${index}`,
    );
    const selectExpression = fields
      .slice(0, -1)
      .reduceRight(
        (otherwise, field, index) =>
          `if index == ${index}:\n  value.${field}\nelse:\n  ${otherwise.replaceAll("\n", "\n  ")}`,
        `value.${fields.at(-1)}`,
      );
    const result = analyze(`
obj Box { value: i32 }
obj Wide {
  ${fields.map((field) => `${field}: Box`).join(",\n  ")}
}

fn select(value: Wide, index: i32) -> Box
  ${selectExpression.replaceAll("\n", "\n  ")}
`);
    const widened = Array.from(result.borrowing.callables.values()).find(
      (contract) =>
        contract.parameters[0]?.returnedOrigins?.some(
          (origin) => origin.source.length === 0 && origin.result.length === 0,
        ),
    );

    expect(widened).toBeDefined();
  });

  it("keeps widened aggregate origins conservative through field projection", () => {
    const fields = Array.from(
      { length: 40 },
      (_entry, index) => `field_${index}`,
    );
    const selectExpression = fields
      .slice(0, -1)
      .reduceRight(
        (otherwise, field, index) =>
          `if index == ${index}:\n  View { active: value.${field} }\nelse:\n  ${otherwise.replaceAll("\n", "\n  ")}`,
        `View { active: value.${fields.at(-1)} }`,
      );

    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj Wide {
  ${fields.map((field) => `${field}: Box`).join(",\n  ")}
}
obj View { active: borrow Box }

fn mutate(~value: Box) -> void
  value.value = value.value + 1

fn select(value: borrow Wide, index: i32) -> View
  ${selectExpression.replaceAll("\n", "\n  ")}

fn invalid(~value: Wide, index: i32) -> i32
  let view = select(value, index)
  mutate(~value.field_39)
  view.active.value
`),
    ).toContain("TY0048");
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
    expect(diagnosticCodes(source)).not.toContain("TY0048");
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
    ).not.toContain("TY0048");
  });

  it("returns a plain value from a mutable parameter", () => {
    expect(
      diagnosticCodes(`${prelude}
fn escape(~value: Box) -> Box
  value
`),
    ).not.toContain("TY0049");
  });

  it("stores a plain handle from a mutable parameter", () => {
    expect(
      diagnosticCodes(`${prelude}
obj Holder { value: Box }

fn invalid(~value: Box, ~holder: Holder) -> void
  holder.value = value
`),
    ).not.toContain("TY0049");
  });

  it("captures a plain handle from a mutable parameter", () => {
    expect(
      diagnosticCodes(`${prelude}
fn invalid(~value: Box) -> (fn() : () -> i32)
  () => value.value
`),
    ).not.toContain("TY0049");
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

  it("rejects mutable captures escaping through local reborrows", () => {
    expect(
      diagnosticCodes(`${prelude}
type Callback = fn() : () -> i32

fn make() -> Callback
  let ~value = Box { value: 0 }
  let callback = () =>
    let ~alias = value
    mutate(~alias)
    alias.value
  callback
`),
    ).toContain("TY0049");
  });

  it("rejects mutable captures reached after local alias reassignment", () => {
    expect(
      diagnosticCodes(`${prelude}
type Callback = fn() : () -> i32

fn make() -> Callback
  let ~value = Box { value: 0 }
  () =>
    let ~alias = Box { value: 1 }
    alias = value
    mutate(~alias)
    alias.value
`),
    ).toContain("TY0049");
  });

  it("keeps captured origins active while evaluating reassignment values", () => {
    expect(
      diagnosticCodes(`${prelude}
type Callback = fn() : () -> i32

fn make() -> Callback
  let ~value = Box { value: 0 }
  () =>
    let ~alias = value
    alias = alias
    mutate(~alias)
    0
`),
    ).toContain("TY0049");
  });

  it("rejects mutable captures reached through aggregate containment", () => {
    expect(
      diagnosticCodes(`${prelude}
obj Holder { value: Box }
type Callback = fn() : () -> i32

fn make() -> Callback
  let ~value = Box { value: 0 }
  () =>
    let ~holder = Holder { value }
    mutate(~holder.value)
    holder.value.value
`),
    ).toContain("TY0049");
  });

  it("allows replacing a captured reference stored in a fresh aggregate", () => {
    expect(
      diagnosticCodes(`${prelude}
obj Holder { value: Box }
type Callback = fn() : () -> i32

fn make() -> Callback
  let ~value = Box { value: 0 }
  () =>
    let ~holder = Holder { value }
    holder.value = Box { value: 1 }
    0
`),
    ).not.toContain("TY0049");
  });

  it("tracks capture aliases independently across conditional branches", () => {
    expect(
      diagnosticCodes(`${prelude}
type Callback = fn() : () -> i32

fn make(flag: bool) -> Callback
  let ~value = Box { value: 0 }
  () =>
    let ~alias = value
    if flag:
      alias = Box { value: 1 }
    else:
      mutate(~alias)
    alias.value
`),
    ).toContain("TY0049");
  });

  it("keeps captured origins across optional loop reassignments", () => {
    expect(
      diagnosticCodes(`${prelude}
type Callback = fn() : () -> i32

fn make(flag: bool) -> Callback
  let ~value = Box { value: 0 }
  () =>
    let ~alias = value
    while flag:
      alias = Box { value: 1 }
    mutate(~alias)
    alias.value
`),
    ).toContain("TY0049");
  });

  it("kills captured origins after reassignment inside an executed loop", () => {
    expect(
      diagnosticCodes(`${prelude}
type Callback = fn() : () -> i32

fn make(flag: bool) -> Callback
  let ~value = Box { value: 0 }
  () =>
    let ~alias = value
    while flag:
      alias = Box { value: 1 }
      mutate(~alias)
    0
`),
    ).not.toContain("TY0049");
  });

  it("does not apply nested-lambda reassignments to the outer closure", () => {
    expect(
      diagnosticCodes(`${prelude}
type Callback = fn() : () -> i32

fn make() -> Callback
  let ~value = Box { value: 0 }
  () =>
    let ~alias = value
    let replace = () =>
      alias = Box { value: 1 }
    mutate(~alias)
    alias.value
`),
    ).toContain("TY0049");
  });

  it("keeps pre-effect captured origins visible inside handlers", () => {
    expect(
      diagnosticCodes(`${prelude}
type Callback = fn() : () -> i32

eff Flag
  get(resume) -> bool

fn make(): Flag -> Callback
  let ~value = Box { value: 0 }
  () =>
    let ~alias = value
    try
      Flag::get()
      alias = Box { value: 1 }
    Flag::get(resume):
      mutate(~alias)
      resume(true)
    alias.value
`),
    ).toContain("TY0049");
  });

  it("does not merge fresh aliases into captured conditional branches", () => {
    expect(
      diagnosticCodes(`${prelude}
type Callback = fn() : () -> i32

fn make(flag: bool) -> Callback
  let ~value = Box { value: 0 }
  () =>
    let ~alias = value
    if flag:
      alias = Box { value: 1 }
      mutate(~alias)
    else:
      value.value
    alias.value
`),
    ).not.toContain("TY0049");
  });

  it("does not treat scalar copies in aggregates as captured aliases", () => {
    expect(() =>
      analyze(`
type Callback = fn() : () -> i32

fn make(value: i32) -> Callback
  () =>
    let ~pair = (value, 0)
    pair.0 = 1
    pair.0
`),
    ).not.toThrow();
  });

  it("allows escaping closures that mutate only fresh local objects", () => {
    expect(() =>
      analyze(`${prelude}
type Callback = fn() : () -> i32

fn make(~value: Box) -> Callback
  () =>
    let ~fresh = Box { value: value.value }
    fresh.value = fresh.value + 1
    fresh.value
`),
    ).not.toThrow();
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

  it("allows ordinary handle captures retained by callback intrinsics", () => {
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
    ).not.toContain("TY0049");
  });

  it("keeps ordinary captures plain through retaining wrappers", () => {
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
    ).not.toContain("TY0049");
  });

  it("keeps retained read-only field captures as ordinary values", () => {
    expect(
      diagnosticCodes(`${prelude}
obj Token { id: i32 }

@intrinsic(name: "__retain_callback", uses_signature: true)
fn retain_callback(handler: fn() -> i32) -> Token
  Token { id: 0 }

pub fn retain_callback_id(handler: fn() -> i32) -> i32
  retain_callback(handler).id

fn invalid() -> void
  let ~box = Box { value: 0 }
  let callback = () => box.value
  let _ = retain_callback_id(callback)
  mutate(~box)
`),
    ).not.toContain("TY0049");
  });

  it.each(["__task_spawn", "__task_detach"])(
    "allows ordinary captures retained by %s",
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
      ).not.toContain("TY0049");
    },
  );

  it("allows ordinary handle captures through spawn wrappers", () => {
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
    ).not.toContain("TY0049");
  });

  it("allows ordinary captures through generic spawn wrappers", () => {
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
    ).not.toContain("TY0049");
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

  it("rejects mutable captures returned through tuple projections", () => {
    expect(
      diagnosticCodes(`${prelude}
type Callback = fn() : () -> i32

fn make() -> Callback
  let ~value = Box { value: 0 }
  let change = () =>
    value.value = value.value + 1
    value.value
  let callbacks = (change, () => 0)
  callbacks.0
`),
    ).toContain("TY0049");
  });

  it("preserves conditionally reaching tuple capture escapes", () => {
    expect(
      diagnosticCodes(`${prelude}
type Callback = fn() : () -> i32

fn make(flag: bool) -> Callback
  let ~value = Box { value: 0 }
  let change = () =>
    value.value = value.value + 1
    value.value
  let safe = () => 0
  var callbacks = (change, safe)
  if flag:
    callbacks = (safe, safe)
  callbacks.0
`),
    ).toContain("TY0049");
  });

  it("preserves mutable capture escapes through returned tuple calls", () => {
    expect(
      diagnosticCodes(`${prelude}
type Callback = fn() : () -> i32

fn wrap(callback: Callback) -> (Callback, Callback)
  (callback, () => 0)

fn make() -> Callback
  let ~value = Box { value: 0 }
  let change = () =>
    value.value = value.value + 1
    value.value
  let callbacks = wrap(change)
  callbacks.0
`),
    ).toContain("TY0049");
  });

  it("preserves mutable capture escapes through scalar call bindings", () => {
    expect(
      diagnosticCodes(`${prelude}
type Callback = fn() : () -> i32

fn identity(callback: Callback) -> Callback
  callback

fn make() -> Callback
  let ~value = Box { value: 0 }
  let change = () =>
    value.value = value.value + 1
    value.value
  let forwarded = identity(change)
  forwarded
`),
    ).toContain("TY0049");
  });

  it("preserves capture metadata through projected call arguments", () => {
    expect(
      diagnosticCodes(`${prelude}
type Callback = fn() : () -> i32
obj Holder { callback: Callback }

fn identity(callback: Callback) -> Callback
  callback

fn make() -> Callback
  let ~value = Box { value: 0 }
  let change = () =>
    value.value = value.value + 1
    value.value
  let holder = Holder { callback: change }
  let forwarded = identity(holder.callback)
  forwarded
`),
    ).toContain("TY0049");
  });

  it("preserves capture metadata through inline aggregate arguments", () => {
    expect(
      diagnosticCodes(`${prelude}
type Callback = fn() : () -> i32

fn first(pair: (Callback, i32)) -> Callback
  pair.0

fn make() -> Callback
  let ~value = Box { value: 0 }
  let change = () =>
    value.value = value.value + 1
    value.value
  let forwarded = first((change, 0))
  forwarded
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

  it("does not turn ordinary closure captures into loans", () => {
    expect(
      diagnosticCodes(`${prelude}
fn read(value: Box) -> i32
  value.value

fn invalid(~value: Box) -> i32
  let alias = value
  let read_alias = () => read(alias)
  mutate(~value)
  read_alias()
`),
    ).not.toContain("TY0048");
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

  it("does not downgrade a handle captured by an escaping closure", () => {
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
    ).toEqual([]);
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

  it("allows ordinary handles captured by closures stored in fields", () => {
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
    ).not.toContain("TY0049");
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

  it("treats bare returns as terminal fact blocks", () => {
    expect(() =>
      analyze(`${prelude}
fn valid(~value: Box) -> void
  let ~borrow = value
  return()
  mutate(~value)
  let ignored = borrow.value
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
    ).not.toContain("TY0048");
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
    ).not.toContain("TY0048");
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
    ).not.toContain("TY0048");
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

  it("returns plain projected handles from mutable parameters", () => {
    expect(
      diagnosticCodes(`${prelude}
fn invalid(~pair: Pair) -> Box
  pair.left
`),
    ).not.toContain("TY0049");
  });

  it("preserves projected provenance through explicit mutable arguments", () => {
    expect(
      diagnosticCodes(`${prelude}
fn view(~holder: Pair) -> borrow Box
  holder.right

fn invalid(~source: Box) -> i32
  let ~holder = Pair {
    left: Box { value: 0 },
    right: source
  }
  let loan: borrow Box = view(~holder)
  mutate(~source)
  loan.value
`),
    ).toContain("TY0048");
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
    ).not.toContain("TY0049");
  });

  it("does not downgrade copied same-root projections at helper calls", () => {
    expect(
      diagnosticCodes(`${prelude}
fn invalid(~pair: Pair) -> i32
  replace_left_with_right(~pair)
  mutate(~pair.right)
  pair.left.value

fn replace_left_with_right(~pair: Pair) -> void
  pair.left = pair.right
`),
    ).toEqual([]);
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
    ).not.toContain("TY0049");
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

  it("does not downgrade ordinary handles passed to effect operations", () => {
    expect(
      diagnosticCodes(`${prelude}
eff Async
  hold(resume, value: Box) -> void

fn invalid(): Async -> void
  var value = Box { value: 0 }
  Async::hold(value)
  mutate(~value)
`),
    ).toEqual([]);
  });

  it("rejects borrowed values returned from SharedCell callbacks", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

impl SharedCell<T>
  fn with<R>(self, body: fn(borrow T) : () -> R) -> R
    body(self.value)

fn invalid(cell: SharedCell<Box>) -> borrow Box
  cell.with((value) => value)
`),
    ).toContain("TY0053");
  });

  it("resolves scoped callbacks through omitted defaults", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

impl SharedCell<T>
  fn with<R>(self, body: fn(borrow T) : () -> R) -> R
    body(self.value)

fn apply<R>(
  cell: SharedCell<Box>,
  supplied: fn(borrow Box) : () -> R,
  body: fn(borrow Box) : () -> R = supplied
) -> R
  cell.with(body)

fn invalid(cell: SharedCell<Box>) -> borrow Box
  apply(cell, (value) => value)
`),
    ).toContain("TY0053");
  });

  it("checks concrete callable defaults at scoped callback boundaries", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

impl SharedCell<T>
  fn with<R>(self, body: fn(borrow T) : () -> R) -> R
    body(self.value)

fn identity(value: borrow Box) -> borrow Box
  value

fn apply(
  cell: SharedCell<Box>,
  body: fn(borrow Box) : () -> borrow Box = identity
) -> borrow Box
  cell.with(body)

fn invalid(cell: SharedCell<Box>) -> borrow Box
  apply(cell)
`),
    ).toContain("TY0053");
  });

  it("accepts safe lambda defaults at scoped callback boundaries", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

impl SharedCell<T>
  fn with<R>(self, body: fn(borrow T) : () -> R) -> R
    body(self.value)

fn apply(
  cell: SharedCell<Box>,
  body: fn(borrow Box) : () -> Box = (_value) => Box { value: 1 }
) -> Box
  cell.with(body)

fn valid(cell: SharedCell<Box>) -> Box
  apply(cell)
`),
    ).not.toContain("TY0053");
  });

  it("resolves projected callable defaults at scoped callback boundaries", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
type Callback = fn(borrow Box) : () -> Box
obj Config { callback: Callback }
@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

impl SharedCell<T>
  fn with<R>(self, body: fn(borrow T) : () -> R) -> R
    body(self.value)

fn fresh(_value: Box) -> Box
  Box { value: 1 }

fn apply(
  cell: SharedCell<Box>,
  config: Config = Config { callback: fresh }
) -> Box
  cell.with(config.callback)

fn valid(cell: SharedCell<Box>) -> Box
  apply(cell)
`),
    ).not.toContain("TY0053");
  });

  it("stops scoped callback defaults at explicit overrides", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

impl SharedCell<T>
  fn with<R>(self, body: fn(borrow T) : () -> R) -> R
    body(self.value)

fn apply<R>(
  cell: SharedCell<Box>,
  supplied: fn(borrow Box) : () -> R,
  body: fn(borrow Box) : () -> R = supplied
) -> R
  cell.with(body)

fn valid(cell: SharedCell<Box>) -> Box
  apply(
    cell,
    (value) => value,
    body: (_value) => Box { value: 1 }
  )
`),
    ).not.toContain("TY0053");
  });

  it("resolves returned callbacks through omitted defaults", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

impl SharedCell<T>
  fn with<R>(self, body: fn(borrow T) : () -> R) -> R
    body(self.value)

fn choose<R>(
  supplied: fn(borrow Box) : () -> R,
  selected: fn(borrow Box) : () -> R = supplied
) -> (fn(borrow Box) : () -> R)
  selected

fn valid(cell: SharedCell<Box>) -> Box
  cell.with(choose((value) => Box { value: 1 }))
`),
    ).not.toContain("TY0053");
  });

  it("propagates returned default callbacks through wrappers", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

impl SharedCell<T>
  fn with<R>(self, body: fn(borrow T) : () -> R) -> R
    body(self.value)

fn choose<R>(
  supplied: fn(borrow Box) : () -> R,
  selected: fn(borrow Box) : () -> R = supplied
) -> (fn(borrow Box) : () -> R)
  selected

fn apply<R>(
  cell: SharedCell<Box>,
  supplied: fn(borrow Box) : () -> R
) -> R
  cell.with(choose(supplied))

fn invalid(cell: SharedCell<Box>) -> borrow Box
  apply(cell, (value) => value)
`),
    ).toContain("TY0053");
  });

  it("rejects fixed arrays returned from SharedCell callback values", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

impl SharedCell<T>
  fn with<R>(self, body: fn(borrow T) : () -> R) -> R
    body(self.value)

fn fixed(value: Box) -> FixedArray<Box>
  __array_new_fixed(value)

fn invalid(cell: SharedCell<Box>) -> FixedArray<Box>
  cell.with((value) => fixed(value))
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
  fn with<R>(self, body: fn(borrow T) : () -> R) -> R
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
  fn with<R>(self, body: fn(borrow T) : () -> R) -> R
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
  fn with<R>(self, body: fn(borrow T) : () -> R) -> R
    body(self.value)

fn invalid(cell: SharedCell<BoxArray>) -> Box
  cell.with((values) => __array_get(values.storage, 0))
`),
    ).toContain("TY0053");
  });

  it("allows owned scalar results from SharedCell callbacks", () => {
    expect(() =>
      analyze(`
@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

impl SharedCell<T>
  fn with<R>(self, body: fn(borrow T) : () -> R) -> R
    body(self.value)

fn valid(cell: SharedCell<i32>) -> i32
  cell.with((value) => value + 0)
`),
    ).not.toThrow();
  });

  it("rejects scalar borrows captured by callbacks returned from SharedCell", () => {
    expect(
      diagnosticCodes(`
@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

impl SharedCell<T>
  fn with<R>(self, body: fn(borrow T) : () -> R) -> R
    body(self.value)

fn valid(cell: SharedCell<i32>) -> (fn() : () -> i32)
  cell.with((value) => () => value)
`),
    ).toContain("TY0053");
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

  it("allows array elements passed to explicitly borrowed callbacks", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj BoxArray { storage: FixedArray<Box> }

@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

impl SharedCell<T>
  fn with<R>(self, body: fn(borrow T) : () -> R) -> R
    body(self.value)

fn invalid(
  cell: SharedCell<BoxArray>,
  retain: fn(borrow Box) : () -> void
) -> void
  cell.with((values) => retain(__array_get(values.storage, 0)))
`),
    ).not.toContain("TY0053");
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
  fn with<R>(self, body: fn(borrow T) : () -> R) -> R
    body(self.value)

fn invalid(cell: SharedCell<BoxArray>) -> BoxArray
  cell.with((values) => copied(values, 12))
`),
    ).toContain("TY0053");
  });

  it("propagates loans from recursive components to earlier callers", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }

fn external(self: Box, depth: i32) -> Box
  cycle_a(self, depth)

fn cycle_a(self: Box, depth: i32) -> Box
  if depth <= 0:
    return self
  cycle_b(self, depth - 1)

fn cycle_b(self: Box, depth: i32) -> Box
  if depth <= 0:
    return self
  cycle_a(self, depth - 1)

@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

impl SharedCell<T>
  fn with<R>(self, body: fn(borrow T) : () -> R) -> R
    body(self.value)

fn invalid(cell: SharedCell<Box>) -> Box
  cell.with((value) => external(value, 2))
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
  fn with<R>(self, body: fn(borrow T) : () -> R) -> R
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

  it("returns plain aggregate values across conditional invalidation", () => {
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
    ).not.toContain("TY0049");
  });

  it("keeps forward-call aggregate returns as plain values", () => {
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
    ).not.toContain("TY0049");
  });

  it("propagates scoped callback loans through higher-order wrappers", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

impl SharedCell<T>
  fn with<R>(self, body: fn(borrow T) : () -> R) -> R
    body(self.value)

fn apply(
  cell: SharedCell<Box>,
  body: fn(borrow Box) : () -> borrow Box
) -> borrow Box
  cell.with(body)

fn invalid(cell: SharedCell<Box>) -> borrow Box
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
  fn with<R>(self, body: fn(borrow T) : () -> R) -> R
    body(self.value)

fn invalid(cell: SharedCell<Box>) -> borrow Box
  let callback: fn(borrow Box) : () -> borrow Box =
    (value: borrow Box) -> borrow Box => value
  cell.with(callback)
`),
    ).toContain("TY0053");
  });

  it("allows SharedCell values passed to explicitly borrowed callbacks", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

impl SharedCell<T>
  fn with<R>(self, body: fn(borrow T) : () -> R) -> R
    body(self.value)

fn invalid(
  cell: SharedCell<Box>,
  callback: fn(borrow Box) : () -> void
) -> void
  cell.with((value) => callback(value))
`),
    ).not.toContain("TY0053");
  });

  it("rejects borrowed values returned through callable fields", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
type Callback = fn(borrow Box) : () -> borrow Box
obj Callbacks {
  body: Callback
}
@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

impl SharedCell<T>
  fn with<R>(self, body: fn(borrow T) : () -> R) -> R
    body(self.value)

fn invalid(cell: SharedCell<Box>) -> borrow Box
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
type Callback = fn(borrow Box) : () -> borrow Box
obj Callbacks {
  body: Callback
}
@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

impl SharedCell<T>
  fn with<R>(self, body: fn(borrow T) : () -> R) -> R
    body(self.value)

fn apply(cell: SharedCell<Box>, callbacks: Callbacks) -> borrow Box
  cell.with(callbacks.body)

fn invalid(cell: SharedCell<Box>) -> borrow Box
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
type Callback = fn(borrow Box) : () -> i32
obj Callbacks {
  body: Callback
}
@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

impl SharedCell<T>
  fn with<R>(self, body: fn(borrow T) : () -> R) -> R
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
  fn with<R>(self, body: fn(borrow T) : () -> R) -> R
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
  fn with<R>(self, body: fn(borrow T) : () -> R) -> R
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
  fn with<R>(self, body: fn(borrow T) : () -> R) -> R
    body(self.value)

fn invalid(cell: SharedCell<Box>, ~holder: Holder) -> void
  cell.with((value) =>
    holder.value = value
  )
`),
    ).toContain("TY0027");
  });

  it("rejects effectful SharedCell callbacks", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

impl SharedCell<T>
  fn with<R>(self, body: fn(borrow T) : () -> R) -> R
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
  fn with<R>(self, body: fn(borrow T) : () -> R) -> R
    body(self.value)

fn valid(cell: SharedCell<Box>) -> i32
  cell.with((value) => value.value)
`),
    ).not.toThrow();
  });

  it("infers aggregate results from SharedCell callbacks", () => {
    expect(() =>
      analyze(`
obj State { done: bool }
obj Plan { kind: i32 }
@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

impl SharedCell<T>
  fn with_mut<R>(self, body: fn(~value: borrow T) : () -> R) -> R
    let ~value = shared_cell_value(self)
    body(~value)

@intrinsic(name: "__shared_cell_value", uses_signature: false)
fn shared_cell_value<T>(cell: SharedCell<T>): () -> T
  __shared_cell_value(cell)

fn valid(cell: SharedCell<State>) -> i32
  let plan = cell.with_mut((~state) =>
    if state.done:
      Plan { kind: 0 }
    else:
      Plan { kind: 1 }
  )
  plan.kind
`),
    ).not.toThrow();
  });

  it("plans bounded identity guards for unknown allocation overlap", () => {
    const result = analyze(`
obj Box { value: i32 }

fn mutate_both(~left: Box, ~right: Box) -> void
  left.value = left.value + 1
  right.value = right.value + 1

fn guarded(~left: Box, ~right: Box) -> void
  mutate_both(~left, ~right)
`);
    const guards = Array.from(
      result.borrowing.runtimeIdentityGuards.values(),
    ).flat();
    expect(guards).toHaveLength(1);
    expect(guards[0]).toMatchObject({
      left: { parameter: 0 },
      right: { parameter: 1 },
    });
    const codegenGuard = Array.from(
      buildProgramCodegenView([result]).modules.values(),
    )[0]
      ? Array.from(result.borrowing.runtimeIdentityGuards.keys()).flatMap(
          (call) =>
            buildProgramCodegenView([result]).calls.getCallInfo(
              result.moduleId,
              call,
            ).identityGuards,
        )
      : [];
    expect(codegenGuard).toEqual([
      expect.objectContaining({
        left: expect.objectContaining({ parameter: 0 }),
        right: expect.objectContaining({ parameter: 1 }),
        afterDefaults: false,
      }),
    ]);
  });

  it("plans guards for stable dynamic element projections", () => {
    const result = analyze(`
obj Box { value: i32 }

@intrinsic(name: "__array_get", uses_signature: false)
fn array_get<T>(values: FixedArray<T>, index: i32) -> T
  __array_get(values, index)

fn mutate_both(~left: Box, ~right: Box) -> void
  left.value = left.value + 1
  right.value = right.value + 1

fn guarded(~values: FixedArray<Box>, left: i32, right: i32) -> void
  mutate_both(
    ~array_get(values, left),
    ~array_get(values, right)
  )
`);
    const guards = Array.from(
      result.borrowing.runtimeIdentityGuards.values(),
    ).flat();
    expect(guards).toHaveLength(1);
    expect(guards[0]?.left.place.projections).toContainEqual({
      kind: "index",
      stable: true,
    });
  });

  it("omits guards for statically distinct fixed-array elements", () => {
    const result = analyze(`
obj Box { value: i32 }

fn mutate_both(~left: Box, ~right: Box) -> void
  left.value = left.value + 1
  right.value = right.value + 1

fn distinct(~values: FixedArray<Box>) -> void
  mutate_both(
    ~__array_get(values, 0),
    ~__array_get(values, 1)
  )
`);
    expect(result.borrowing.runtimeIdentityGuards.size).toBe(0);
  });

  it("statically separates a fresh call-local allocation from an unknown root", () => {
    const result = analyze(`
obj Box { value: i32 }

fn mutate_both(~left: Box, ~right: Box) -> void
  left.value = left.value + 1
  right.value = right.value + 1

fn valid(~right: Box) -> void
  let ~left = Box { value: 0 }
  mutate_both(~left, ~right)
`);
    expect(result.borrowing.diagnostics).toEqual([]);
    expect(result.borrowing.runtimeIdentityGuards.size).toBe(0);
  });

  it("does not treat ordinary value arguments as runtime loans", () => {
    const result = analyze(`
obj Box { value: i32 }

fn mutate_and_read(~target: Box, source: Box) -> i32
  target.value = target.value + 1
  source.value

fn valid(~target: Box, source: Box) -> i32
  mutate_and_read(~target, source)
`);
    expect(result.borrowing.diagnostics).toEqual([]);
    expect(result.borrowing.runtimeIdentityGuards.size).toBe(0);
  });

  it("keeps distinct mutable inline-value locals statically disjoint", () => {
    const result = analyze(`
val Point { x: i32 }
val Ray { origin: Point, direction: Point }

fn fill(~point: Point, ~ray: Ray) -> void
  point.x = 1
  ray.direction.x = 2

fn valid() -> void
  let ~point = Point { x: 0 }
  let ~ray = Ray {
    origin: Point { x: 0 },
    direction: Point { x: 0 }
  }
  fill(point, ray)
`);
    expect(result.borrowing.diagnostics).toEqual([]);
    expect(result.borrowing.runtimeIdentityGuards.size).toBe(0);
  });

  it("statically separates loans with disjoint nominal identities", () => {
    const result = analyze(`
obj Left { value: i32 }
obj Right { value: i32 }

fn mutate_both(~left: Left, ~right: Right) -> void
  left.value = left.value + 1
  right.value = right.value + 1

fn valid(~left: Left, ~right: Right) -> void
  mutate_both(~left, ~right)
`);
    expect(result.borrowing.diagnostics).toEqual([]);
    expect(result.borrowing.runtimeIdentityGuards.size).toBe(0);
  });

  it("does not use outer nominal disjointness for nested identities", () => {
    const result = analyze(`
obj Box { value: i32 }
obj LeftHolder { box: Box }
obj RightHolder { box: Box }

fn mutate_nested(~left: LeftHolder, ~right: RightHolder) -> void
  left.box.value = left.box.value + 1
  right.box.value = right.box.value + 1

fn guarded(~left: LeftHolder, ~right: RightHolder) -> void
  mutate_nested(~left, ~right)
`);
    expect(result.borrowing.diagnostics).toEqual([]);
    expect(
      Array.from(result.borrowing.runtimeIdentityGuards.values()).flat(),
    ).toEqual([
      expect.objectContaining({
        left: expect.objectContaining({
          identity: "allocation",
          allocationPath: expect.arrayContaining([
            expect.objectContaining({ kind: "field", name: "box" }),
          ]),
        }),
        right: expect.objectContaining({
          identity: "allocation",
          allocationPath: expect.arrayContaining([
            expect.objectContaining({ kind: "field", name: "box" }),
          ]),
        }),
      }),
    ]);
  });

  it("guards possible nested aliases behind distinct outer nominals", () => {
    const result = analyze(`
obj Box { value: i32 }
obj LeftHolder { box: Box }
obj RightHolder { box: Box }

fn mutate_nested(~left: LeftHolder, ~right: RightHolder) -> void
  left.box.value = left.box.value + 1
  right.box.value = right.box.value + 1

fn invalid() -> void
  let shared = Box { value: 0 }
  let ~left = LeftHolder { box: shared }
  let ~right = RightHolder { box: shared }
  mutate_nested(~left, ~right)
`);
    expect(result.borrowing.diagnostics).toEqual([]);
    expect(result.borrowing.runtimeIdentityGuards.size).toBe(1);
  });

  it("guards nested aliases stored in distinct inline-value roots", () => {
    const result = analyze(`
obj Box { value: i32 }
val LeftHolder { box: Box }
val RightHolder { box: Box }

fn mutate_nested(~left: LeftHolder, ~right: RightHolder) -> void
  left.box.value = left.box.value + 1
  right.box.value = right.box.value + 1

fn guarded() -> void
  let shared = Box { value: 0 }
  let ~left = LeftHolder { box: shared }
  let ~right = RightHolder { box: shared }
  mutate_nested(left, right)
`);
    expect(result.borrowing.diagnostics).toEqual([]);
    expect(result.borrowing.runtimeIdentityGuards.size).toBe(1);
  });

  it("defers guards until every omitted default has been evaluated", () => {
    const result = analyze(`
obj Box { value: i32 }

fn mutate_both(
  ~left: Box,
  ~right: Box,
  marker: i32 = 0
) -> void
  left.value = left.value + marker
  right.value = right.value + marker

fn guarded(~left: Box, ~right: Box) -> void
  mutate_both(~left, ~right)
`);
    const guards = Array.from(
      result.borrowing.runtimeIdentityGuards.values(),
    ).flat();
    expect(guards).toEqual([
      expect.objectContaining({
        afterDefaults: true,
        omittedParameters: [2],
      }),
    ]);
    const view = buildProgramCodegenView([result]);
    const footprint = Array.from(view.modules.values())[0]
      ?.callableRuntimeProtocols.values()
      .find(
        (candidate) =>
          candidate.defaultIdentityGuardProtocol === "presence-conflict-bit-v1",
      );
    expect(footprint?.defaultIdentityGuardProtocol).toBe(
      "presence-conflict-bit-v1",
    );
  });

  it("rejects deferred guards when a default can mutate guarded identity", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }

fn redirect(~target: Box, replacement: Box) -> i32
  target = replacement
  0

fn mutate_both(
  ~left: Box,
  ~right: Box,
  marker: i32 = redirect(~left, right)
) -> void
  left.value = left.value + marker
  right.value = right.value + marker

fn invalid(~left: Box, ~right: Box) -> void
  mutate_both(~left, ~right)
`),
    ).toContain("TY0048");
  });

  it("rejects deferred guards when a default writes through a possible alias", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }

fn redirect(~target: Box, replacement: Box) -> i32
  target = replacement
  0

fn mutate_both(
  ~left: Box,
  ~right: Box,
  ~alias: Box,
  marker: i32 = redirect(~alias, right)
) -> void
  left.value = left.value + marker
  right.value = right.value + marker

fn invalid(~left: Box, ~right: Box) -> void
  mutate_both(~left, ~right, ~left)
`),
    ).toContain("TY0048");
  });

  it("rejects guards whose identity-bearing argument is defaulted", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }

fn mutate_both(~left: Box, ~right: Box = left) -> void
  left.value = left.value + 1
  right.value = right.value + 1

fn invalid(~left: Box) -> void
  mutate_both(~left)
`),
    ).toContain("TY0048");
  });

  it("rejects deferred guards when a default can rebind identity-producing storage", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj Holder { box: Box }

fn replace_box(~holder: Holder, replacement: Box) -> i32
  holder.box = replacement
  0

fn mutate_both(
  ~left: Box,
  ~right: Box,
  ~alias: Holder,
  marker: i32 = replace_box(~alias, right)
) -> void
  left.value = left.value + marker
  right.value = right.value + marker

fn invalid(
  ~holders: FixedArray<Holder>,
  left: i32,
  right: i32,
  alias: i32
) -> void
  mutate_both(
    ~__array_get(holders, left).box,
    ~__array_get(holders, right).box,
    ~__array_get(holders, alias)
  )
`),
    ).toContain("TY0048");
  });

  it("rejects deferred guards when a default rebinds an intermediate identity handle", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj Holder { box: Box }
obj Root { holder: Holder }

fn replace_holder(~root: Root, replacement: Holder) -> i32
  root.holder = replacement
  0

fn mutate_both(
  ~left: Root,
  ~right: Root,
  marker: i32 = replace_holder(~left, right.holder)
) -> void
  left.holder.box.value = left.holder.box.value + marker
  right.holder.box.value = right.holder.box.value + marker

fn invalid(~left: Root, ~right: Root) -> void
  mutate_both(~left, ~right)
`),
    ).toContain("TY0048");
  });

  it("rejects incomplete indexed identity for nested reference-backed slots", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj Holder { box: Box }

fn replace_both(~left: Box, ~right: Box) -> void
  left = Box { value: 1 }
  right = Box { value: 2 }

fn invalid(
  ~holders: FixedArray<Holder>,
  left: i32,
  right: i32
) -> void
  replace_both(
    ~__array_get(holders, left).box,
    ~__array_get(holders, right).box
  )
`),
    ).toContain("TY0048");
  });

  it("plans storage identity for uncertain mutable root slots", () => {
    const result = analyze(`
obj Box { value: i32 }

fn replace_both(~left: Box, ~right: Box) -> void
  left = Box { value: 1 }
  right = Box { value: 2 }

fn guarded(~left: Box, ~right: Box) -> void
  replace_both(~left, ~right)
`);
    expect(
      Array.from(result.borrowing.runtimeIdentityGuards.values()).flat(),
    ).toEqual([
      expect.objectContaining({
        left: expect.objectContaining({ identity: "storage" }),
        right: expect.objectContaining({ identity: "storage" }),
      }),
    ]);
  });

  it("rejects runtime storage guards for projected mutable slots", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }
obj Holder { box: Box }

fn replace_both(~left: Box, ~right: Box) -> void
  left = Box { value: 1 }
  right = Box { value: 2 }

fn invalid(~left: Holder, ~right: Holder) -> void
  replace_both(~left.box, ~right.box)
`),
    ).toContain("TY0048");
  });

  it("does not advertise the default guard protocol without conflicting accesses", () => {
    const result = analyze(`
pub fn identity(value: i32 = 1) -> i32
  value
`);
    expect(
      Array.from(result.borrowing.callables.values()).some(
        (contract) =>
          contract.defaultIdentityGuardProtocol === "presence-conflict-bit-v1",
      ),
    ).toBe(false);
  });

  it("plans guards for open trait dispatch", () => {
    const result = analyze(`
obj Box { value: i32 }

trait Mutator
  fn update(self, ~left: Box, ~right: Box) -> void

obj ConcreteMutator {}

impl Mutator for ConcreteMutator
  fn update(self, ~left: Box, ~right: Box) -> void
    left.value = left.value + 1
    right.value = right.value + 1

fn guarded(mutator: Mutator, ~left: Box, ~right: Box) -> void
  mutator.update(~left, ~right)
`);
    expect(
      Array.from(result.borrowing.runtimeIdentityGuards.values()).flat(),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          left: expect.objectContaining({ parameter: 1 }),
          right: expect.objectContaining({ parameter: 2 }),
        }),
      ]),
    );
  });

  it("keeps known identity conflicts as compile errors", () => {
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
  });

  it("keeps known conflicts through ordinary aliases as compile errors", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }

fn mutate_both(~left: Box, ~right: Box) -> void
  left.value = left.value + 1
  right.value = right.value + 1

fn invalid(~value: Box) -> void
  let alias = value
  mutate_both(~value, ~alias)
`),
    ).toContain("TY0048");
  });

  it("rejects runtime guards for suspending call access", () => {
    expect(
      diagnosticCodes(`
obj Box { value: i32 }

eff Async
  wait(resume) -> void

fn mutate_both(~left: Box, ~right: Box): Async -> void
  Async::wait()
  left.value = left.value + 1
  right.value = right.value + 1

fn invalid(~left: Box, ~right: Box): Async -> void
  mutate_both(~left, ~right)
`),
    ).toContain("TY0048");
  });

  it("does not advertise deferred guards for suspending callables", () => {
    const result = analyzeWithRecovery(`
obj Box { value: i32 }

eff Async
  wait(resume) -> void

fn mutate_both(
  ~left: Box,
  ~right: Box,
  marker: i32 = 0
): Async -> void
  Async::wait()
  left.value = left.value + marker
  right.value = right.value + marker

fn invalid(~left: Box, ~right: Box): Async -> void
  mutate_both(~left, ~right)
`);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "TY0052",
    );
    expect(
      Array.from(result.borrowing.callables.values()).some(
        (contract) =>
          contract.defaultIdentityGuardProtocol === "presence-conflict-bit-v1",
      ),
    ).toBe(false);
  });
});
