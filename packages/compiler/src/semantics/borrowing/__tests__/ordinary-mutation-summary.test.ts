import { describe, expect, it } from "vitest";
import type { ModuleGraph, ModuleNode } from "../../../modules/types.js";
import { parse } from "../../../parser/index.js";
import { analyzeModules } from "../../../pipeline.js";
import { semanticsPipeline } from "../../pipeline.js";
import type {
  CallableBorrowIndex,
  CallableBorrowIndexCall,
} from "../callable-borrow-index.js";
import type { PlaceProjection } from "../model.js";
import {
  OrdinaryParameterAccess as Access,
  extractOrdinaryMutationInput,
  ordinaryMutationSignatureUpperBound,
  solveOrdinaryMutationSummaries,
  validateOrdinaryMutationSummaryBound,
  type OrdinaryMutationCall,
  type OrdinaryMutationInput,
  type OrdinaryMutationSummary,
} from "../ordinary-mutation-summary.js";

const summary = (
  directAccesses: readonly Access[],
  flags: Partial<
    Pick<OrdinaryMutationSummary, "ambientAccess" | "reentrant" | "maySuspend">
  > & { reachableAccesses?: readonly Access[] } = {},
): OrdinaryMutationSummary => ({
  directAccesses,
  reachableAccesses: flags.reachableAccesses ?? directAccesses,
  ambientAccess: Access.Unused,
  reentrant: false,
  maySuspend: false,
  ...flags,
});

const mappedCall = ({
  target,
  access = Access.Read,
  dynamicBound,
}: {
  target: number;
  access?: Access;
  dynamicBound?: OrdinaryMutationSummary;
}): OrdinaryMutationCall => ({
  targets: [{ moduleId: "test", symbol: target }],
  arguments: [
    {
      parameter: 0,
      callerParameter: 0,
      ambientObject: false,
      mayAliasParameters: [],
      fallbackAccess: access,
    },
  ],
  ...(dynamicBound ? { dynamicBound } : {}),
  unknownTarget: false,
});

const input = ({
  symbol,
  direct,
  calls = [],
}: {
  symbol: number;
  direct: OrdinaryMutationSummary;
  calls?: readonly OrdinaryMutationCall[];
}): OrdinaryMutationInput => ({
  symbol,
  direct,
  calls,
  callEdges: calls.flatMap((call) => call.targets),
});

const analyzeStd = (source: string) => {
  const module: ModuleNode = {
    id: "std::ordinary_mutation_test",
    path: { namespace: "std", segments: ["ordinary_mutation_test"] },
    origin: {
      kind: "file",
      filePath: "ordinary-mutation-std.test.voyd",
    },
    source,
    dependencies: [],
    ast: parse(source, "ordinary-mutation-std.test.voyd"),
  };
  const graph: ModuleGraph = {
    entry: module.id,
    modules: new Map([[module.id, module]]),
    diagnostics: [],
  };
  return semanticsPipeline({ module, graph });
};

const analyzeStdModule = (moduleId: string, source: string) => {
  const module: ModuleNode = {
    id: moduleId,
    path: { namespace: "std", segments: moduleId.split("::").slice(1) },
    origin: { kind: "file", filePath: `${moduleId}.test.voyd` },
    source,
    dependencies: [],
    ast: parse(source, `${moduleId}.test.voyd`),
  };
  const graph: ModuleGraph = {
    entry: module.id,
    modules: new Map([[module.id, module]]),
    diagnostics: [],
  };
  return semanticsPipeline({ module, graph });
};

describe("ordinary mutation summaries", () => {
  it("uses an exact local SharedCell closure instead of publishing an unknown callback", () => {
    const result = analyzeStd(`
@intrinsic_type(type: "voyd.std.shared-cell")
obj SharedCell<T> { value: T }

impl<T> SharedCell<T>
  fn with<R>(self, body: fn(value: Borrow<T>) : () -> R) -> R
    body(self.value)

  fn with_mut<R>(self, body: fn(~value: Borrow<T>) : () -> R) -> R
    let ~value = self.value
    body(~value)

obj State { ok: bool }
obj Wrapper { state: SharedCell<State>, count: i32 }

impl Wrapper
  fn is_ok(self) -> bool
    self.state.with((state) => state.ok)

  fn invoke(self, body: fn(value: Borrow<State>) : () -> bool) -> bool
    self.state.with(body)

  fn increment(~self) -> bool
    let ok = self.is_ok()
    self.count = self.count + 1
    ok

  fn update_and_increment(~self) -> void
    self.state.with_mut((~state) -> void => state.ok = false)
    self.count = self.count + 1
`);
    const functions = new Map(
      Array.from(result.hir.items.values()).flatMap((item) =>
        item.kind === "function"
          ? [
              [
                result.binding.symbolTable.getSymbol(item.symbol).name,
                item,
              ] as const,
            ]
          : [],
      ),
    );
    const isOk = result.borrowing.ordinaryMutationSummaries.get(
      functions.get("is_ok")!.symbol,
    );
    const invoke = result.borrowing.ordinaryMutationSummaries.get(
      functions.get("invoke")!.symbol,
    );

    expect(result.diagnostics).toHaveLength(0);
    expect(isOk?.reentrant).toBe(false);
    expect(invoke?.reentrant).toBe(true);
  });

  it("propagates direct and reachable modes independently", () => {
    const directOnly = summary([Access.Write], {
      reachableAccesses: [Access.Unused],
    });
    const reachableOnly = summary([Access.Read], {
      reachableAccesses: [Access.Write],
      ambientAccess: Access.Read,
    });
    const directCaller = input({
      symbol: 1,
      direct: summary([Access.Unused], {
        reachableAccesses: [Access.Unused],
      }),
      calls: [mappedCall({ target: 2, dynamicBound: directOnly })],
    });
    const reachableCaller = input({
      symbol: 3,
      direct: summary([Access.Unused], {
        reachableAccesses: [Access.Unused],
      }),
      calls: [mappedCall({ target: 4, dynamicBound: reachableOnly })],
    });
    const result = solveOrdinaryMutationSummaries({
      inputs: new Map([
        [directCaller.symbol, directCaller],
        [reachableCaller.symbol, reachableCaller],
      ]),
      moduleId: "test",
      recordMetrics: false,
    });

    expect(result.summaries.get(1)).toEqual(directOnly);
    expect(result.summaries.get(3)).toEqual(reachableOnly);
  });

  it("uses the refined O(parameters) solver bound", () => {
    const callee = input({
      symbol: 2,
      direct: summary([Access.Write, Access.Read], {
        reachableAccesses: [Access.Read, Access.Write],
        ambientAccess: Access.Write,
        reentrant: true,
        maySuspend: true,
      }),
    });
    const caller = input({
      symbol: 1,
      direct: summary([Access.Unused, Access.Unused], {
        reachableAccesses: [Access.Unused, Access.Unused],
      }),
      calls: [mappedCall({ target: callee.symbol })],
    });
    const result = solveOrdinaryMutationSummaries({
      inputs: new Map([
        [caller.symbol, caller],
        [callee.symbol, callee],
      ]),
      moduleId: "test",
      recordMetrics: false,
    });

    // C + H(callee) for the single caller -> callee edge.
    expect(result.metrics.solverEvaluationBound).toBe(14);
    expect(result.metrics.summaryEvaluations).toBeLessThanOrEqual(14);
    expect(result.metrics.strictSummaryAscents).toBe(1);
  });

  it("distinguishes direct field rebinding from reachable child mutation", () => {
    const result = semanticsPipeline(
      parse(
        `obj Child { value: i32 }
obj Parent { child: Child }

fn replace_child(~parent: Parent, next: Child) -> void
  parent.child = next

fn update_child(~parent: Parent) -> void
  parent.child.value = parent.child.value + 1
`,
        "ordinary-direct-reachable-summary.test.voyd",
      ),
    );
    const functions = new Map(
      Array.from(result.hir.items.values()).flatMap((item) =>
        item.kind === "function"
          ? [
              [
                result.binding.symbolTable.getSymbol(item.symbol).name,
                item.symbol,
              ] as const,
            ]
          : [],
      ),
    );

    expect(result.diagnostics).toHaveLength(0);
    expect(
      result.borrowing.ordinaryMutationSummaries.get(
        functions.get("replace_child")!,
      ),
    ).toEqual(
      summary([Access.Write, Access.Unused], {
        reachableAccesses: [Access.Unused, Access.Unused],
      }),
    );
    expect(
      result.borrowing.ordinaryMutationSummaries.get(
        functions.get("update_child")!,
      ),
    ).toEqual(
      summary([Access.Read], {
        reachableAccesses: [Access.Write],
      }),
    );
  });

  it("treats an allocation parameter's leading dereference as direct", () => {
    const indexed = (
      projections: readonly PlaceProjection[],
    ): CallableBorrowIndex =>
      ({
        symbol: 1,
        parameters: [
          {
            symbol: 10,
            parameter: 0,
            defaulted: false,
            access: "mutable",
            allocationBacked: true,
          },
        ],
        parameterPlaces: new Map([[10, { parameter: 0, path: [] }]]),
        accesses: [
          {
            exprId: 2,
            kind: "write",
            place: { root: 10, projections },
          },
        ],
        calls: [],
        directCallEdges: [],
        ambientObjectCaptures: [],
        directAmbientObjectRoots: [],
        mutableAliasSourceRoots: new Set(),
        rootReboundParameters: new Set(),
        flags: {
          hasMutableParameter: true,
          hasAmbientObjectCapture: false,
          hasSuspension: false,
          hasModuleStorageAccess: false,
          hasDefaultArgument: false,
          hasDefaultBorrowFlow: false,
          hasRuntimeCheckedReceiverWrites: false,
        },
      }) as CallableBorrowIndex;
    const direct = extractOrdinaryMutationInput(
      indexed([{ kind: "dereference" }, { kind: "index", stable: true }]),
    ).direct;
    const reachable = extractOrdinaryMutationInput(
      indexed([
        { kind: "dereference" },
        { kind: "index", stable: true },
        { kind: "dereference" },
        { kind: "field", name: "value" },
      ]),
    ).direct;

    expect(direct).toEqual(
      summary([Access.Write], { reachableAccesses: [Access.Unused] }),
    );
    expect(reachable).toEqual(
      summary([Access.Read], { reachableAccesses: [Access.Write] }),
    );
  });

  it("uses the declaration bound for generic static trait dispatch", () => {
    const result = semanticsPipeline(
      parse(
        `obj Value { value: i32 }
obj Wrapper<T> { value: Value }

trait Provider<T>
  fn provide(): () -> Value

trait Consumer<T>
  fn consume(): () -> Value

impl<T: Provider<T>> Consumer<Wrapper<T>> for Wrapper<T>
  fn consume() -> Value
    call_provider<T>()

fn call_provider<T: Provider<T>>() -> Value
  T::provide()
`,
        "ordinary-static-trait-bound.test.voyd",
      ),
    );

    expect(result.diagnostics).toHaveLength(0);
  });

  it("allows unknown callback work declared by an explicit open trait row", () => {
    const result = semanticsPipeline(
      parse(
        `obj Value { value: i32 }

trait Provider<T>
  fn provide(self, run: fn() : (open) -> T) : (open) -> T

  fn documentation(self) -> Value
    Value { value: 0 }

impl Provider<Value> for Value
  fn provide(self, run: fn() : (open) -> Value) : (open) -> Value
    self
    run()
`,
        "ordinary-explicit-open-trait-bound.test.voyd",
      ),
    );

    expect(result.diagnostics).toHaveLength(0);
  });

  it("keeps direct local allocations separate from owned inputs", () => {
    const source = `obj Store<T> { value: T }

impl<T> Store<T>
  fn copied(self) -> Store<T>
    Store<T> { value: self.value }

  fn replace(~self, value: T) -> void
    self.value = value

fn replaced<T>(source: Store<T>, value: T) -> Store<T>
  let ~copy = Store<T> { value: source.value }
  copy.value = value
  copy
`;
    const module: ModuleNode = {
      id: "src::ordinary_fresh_generic_storage",
      path: {
        namespace: "src",
        segments: ["ordinary_fresh_generic_storage"],
      },
      origin: {
        kind: "file",
        filePath: "ordinary-fresh-generic-storage.test.voyd",
      },
      source,
      dependencies: [],
      ast: parse(source, "ordinary-fresh-generic-storage.test.voyd"),
    };
    const graph: ModuleGraph = {
      entry: module.id,
      modules: new Map([[module.id, module]]),
      diagnostics: [],
    };
    const result = semanticsPipeline({ module, graph });
    const replaced = Array.from(result.hir.items.values()).find(
      (item) =>
        item.kind === "function" &&
        result.binding.symbolTable.getSymbol(item.symbol).name === "replaced",
    );

    expect(
      replaced?.kind === "function"
        ? result.borrowing.ordinaryMutationSummaries?.get(replaced.symbol)
            ?.directAccesses
        : undefined,
    ).not.toContain(Access.Write);
    expect(result.diagnostics).toHaveLength(0);
  });

  it("keeps direct fresh-wrapper mutation local but rejects helper access to retained children", () => {
    const direct = semanticsPipeline(
      parse(
        `obj Child { value: i32 }
obj Wrapper { child: Child, cursor: i32 }

fn mutate_wrapper(source: Child) -> i32
  let ~wrapper = Wrapper { child: source, cursor: 0 }
  wrapper.cursor = wrapper.cursor + 1
  wrapper.cursor
`,
        "ordinary-direct-outer-allocation.test.voyd",
      ),
    );
    const analyzeAccess = (access: "read" | "write") => () =>
      semanticsPipeline(
        parse(
          `obj Child { value: i32 }
obj Wrapper { child: Child, cursor: i32 }

fn access_child(${access === "write" ? "~" : ""}wrapper: Wrapper) -> i32
  ${access === "write" ? "wrapper.child.value = wrapper.child.value + 1" : "void"}
  wrapper.child.value

fn invalid(~source: Child) -> i32
  let ~wrapper = Wrapper { child: source, cursor: 0 }
  access_child(${access === "write" ? "~" : ""}wrapper)
`,
          `ordinary-retained-child-${access}.test.voyd`,
        ),
      );

    expect(direct.diagnostics).toHaveLength(0);
    expect(analyzeAccess("read")).toThrow(/TY0048/);
    expect(analyzeAccess("write")).toThrow(/TY0048|TY0055/);
  });

  it("does not retain compiler-known stable slices through fresh wrappers", () => {
    const stable = analyzeStd(`obj Backing { value: i32 }
@intrinsic_type(type: "voyd.std.string-slice")
obj StableSlice { source: Backing, start: i32, len: i32 }
obj State { slice: StableSlice }
obj Cursor { source: StableSlice, index: i32 }

fn advance(~cursor: Cursor) -> void
  cursor.index = cursor.index + 1

fn valid(~state: State) -> i32
  let ~cursor = Cursor { source: state.slice, index: 0 }
  advance(~cursor)
  state.slice.len

fn advance_at(source: StableSlice, index: i32) -> i32
  let ~cursor = Cursor { source, index }
  advance(~cursor)
  index
`);
    const lookalike = () =>
      semanticsPipeline(
        parse(
          `obj Backing { value: i32 }
obj SliceLookalike { source: Backing, start: i32, len: i32 }
obj State { slice: SliceLookalike }
obj Cursor { source: SliceLookalike, index: i32 }

fn advance(~cursor: Cursor) -> void
  cursor.index = cursor.index + 1

fn invalid(~state: State) -> i32
  let ~cursor = Cursor { source: state.slice, index: 0 }
  advance(~cursor)
  state.slice.len
`,
          "ordinary-slice-lookalike-wrapper.test.voyd",
        ),
      );

    expect(stable.diagnostics).toHaveLength(0);
    expect(lookalike).toThrow(/TY0048|TY0055/);
  });

  it("downgrades only the canonical std Array iterator cursor step", () => {
    const iteratorSource = (
      iteratorName: string,
    ) => `@intrinsic_type(type: "voyd.std.array")
obj Array<T> { item: T }
obj ${iteratorName}<T> { source: Array<T>, index: i32 }

impl<T> Array<T>
  fn iter(self) -> ${iteratorName}<T>
    ${iteratorName}<T> { source: self, index: 0 }

impl<T> ${iteratorName}<T>
  fn next(~self) -> T
    self.index = self.index + 1
    self.source.item

fn read_after_step(~source: Array<i32>) -> i32
  let ~cursor = source.iter()
  cursor.next()
  source.item
`;

    expect(
      analyzeStdModule("std::array", iteratorSource("ArrayIterator"))
        .diagnostics,
    ).toHaveLength(0);
    expect(() =>
      analyzeStdModule("std::evil", iteratorSource("EvilIterator")),
    ).toThrow(/TY0048|TY0055/);
  });

  it("keeps caller-local sibling paths precise and rejects the same projected path", () => {
    const source = `obj Leaf { value: i32 }
obj State { out: Leaf, parser: Leaf }

fn read(value: Leaf) -> i32
  value.value

fn mutate(~value: Leaf) -> void
  value.value = value.value + 1

fn touch_and_read(~left: Leaf, right: Leaf) -> i32
  left.value = left.value + 1
  right.value

fn valid(~state: State) -> i32
  mutate(~state.out)
  read(state.parser)

fn invalid(~state: State) -> i32
  touch_and_read(~state.out, state.out)
`;
    const valid = semanticsPipeline(
      parse(
        source.replace(/fn invalid[\s\S]*/, ""),
        "ordinary-local-sibling-paths.test.voyd",
      ),
    );

    expect(valid.diagnostics).toHaveLength(0);
    expect(() =>
      semanticsPipeline(parse(source, "ordinary-local-same-path.test.voyd")),
    ).toThrow(/TY0048/);
  });

  it("collapses retained origins to the whole parameter for imported summaries", () => {
    const dependency: ModuleNode = {
      id: "src::ordinary_imported_retained_dependency",
      path: {
        namespace: "src",
        segments: ["ordinary_imported_retained_dependency"],
      },
      origin: {
        kind: "file",
        filePath: "ordinary-imported-retained-dependency.test.voyd",
      },
      source: "",
      dependencies: [],
      ast: parse(
        `pub obj Child { api value: i32 }
pub obj Wrapper { api child: Child, api cursor: i32 }

pub fn read_wrapper(wrapper: Wrapper) -> i32
  wrapper.child.value
`,
        "ordinary-imported-retained-dependency.test.voyd",
      ),
    };
    const consumer: ModuleNode = {
      id: "src::ordinary_imported_retained_consumer",
      path: {
        namespace: "src",
        segments: ["ordinary_imported_retained_consumer"],
      },
      origin: {
        kind: "file",
        filePath: "ordinary-imported-retained-consumer.test.voyd",
      },
      source: "",
      dependencies: [{ kind: "use", path: dependency.path }],
      ast: parse(
        `use src::ordinary_imported_retained_dependency::{ Child, Wrapper, read_wrapper }

fn invalid(~child: Child) -> i32
  let wrapper = Wrapper { child, cursor: 0 }
  read_wrapper(wrapper)
`,
        "ordinary-imported-retained-consumer.test.voyd",
      ),
    };
    const graph: ModuleGraph = {
      entry: consumer.id,
      modules: new Map([
        [dependency.id, dependency],
        [consumer.id, consumer],
      ]),
      diagnostics: [],
    };
    const dependencyResult = semanticsPipeline({ module: dependency, graph });

    expect(() =>
      semanticsPipeline({
        module: consumer,
        graph,
        exports: new Map([[dependency.id, dependencyResult.exports]]),
        dependencies: new Map([[dependency.id, dependencyResult]]),
      }),
    ).toThrow(/TY0048/);
  });

  it("keeps assigned retained-child origins across helper boundaries", () => {
    const analyzeAccess = (access: "read" | "write") => () =>
      semanticsPipeline(
        parse(
          `obj Child { value: i32 }
obj Wrapper { child: Child, cursor: i32 }

fn access_child(${access === "write" ? "~" : ""}wrapper: Wrapper) -> i32
  ${access === "write" ? "wrapper.child.value = wrapper.child.value + 1" : "void"}
  wrapper.child.value

fn indirect(child: Child) -> i32
  let ~wrapper = Wrapper { child: Child { value: 0 }, cursor: 0 }
  wrapper.child = child
  access_child(${access === "write" ? "~" : ""}wrapper)

fn invalid(~child: Child) -> i32
  let alias = child
  let observed = indirect(alias)
  child.value + observed
`,
          `ordinary-assigned-retained-child-${access}.test.voyd`,
        ),
      );

    expect(analyzeAccess("read")).toThrow(/TY0048/);
    expect(analyzeAccess("write")).toThrow(/TY0048|TY0055/);
  });

  it("converges loop-carried retained-child origins before publishing summaries", () => {
    expect(() =>
      semanticsPipeline(
        parse(
          `obj Child { value: i32 }
obj Wrapper { child: Child }

fn read_wrapper(wrapper: Wrapper) -> i32
  wrapper.child.value

fn indirect(child: Child) -> i32
  let ~first = Wrapper { child: Child { value: 0 } }
  let ~second = Wrapper { child: Child { value: 0 } }
  var count = 0
  while count < 2:
    first = second
    second = Wrapper { child }
    count = count + 1
  read_wrapper(first)

fn invalid(~child: Child) -> i32
  let alias = child
  let observed = indirect(alias)
  child.value + observed
`,
          "ordinary-loop-carried-retained-child.test.voyd",
        ),
      ),
    ).toThrow(/TY0048/);
  });

  it("keeps scalar-only imported constructor results independent at the caller", () => {
    const dependency: ModuleNode = {
      id: "src::fresh_factory",
      path: { namespace: "src", segments: ["fresh_factory"] },
      origin: {
        kind: "file",
        filePath: "ordinary-imported-fresh-factory.test.voyd",
      },
      source: "",
      dependencies: [],
      ast: parse(
        `pub obj Box { value: i32 }

impl Box
  api fn make(value: i32) -> Box
    Box { value }

  api fn bump(~self) -> void
    self.value = self.value + 1
`,
        "ordinary-imported-fresh-factory.test.voyd",
      ),
    };
    const consumer: ModuleNode = {
      id: "src::fresh_consumer",
      path: { namespace: "src", segments: ["fresh_consumer"] },
      origin: {
        kind: "file",
        filePath: "ordinary-imported-fresh-consumer.test.voyd",
      },
      source: "",
      dependencies: [{ kind: "use", path: dependency.path }],
      ast: parse(
        `use src::fresh_factory::Box

obj Input { value: i32 }

fn build(input: Input) -> Box
  let ~out = Box::make(input.value)
  out.bump()
  out
`,
        "ordinary-imported-fresh-consumer.test.voyd",
      ),
    };
    const graph: ModuleGraph = {
      entry: consumer.id,
      modules: new Map([
        [dependency.id, dependency],
        [consumer.id, consumer],
      ]),
      diagnostics: [],
    };
    const dependencyResult = semanticsPipeline({ module: dependency, graph });
    const result = semanticsPipeline({
      module: consumer,
      graph,
      exports: new Map([[dependency.id, dependencyResult.exports]]),
      dependencies: new Map([[dependency.id, dependencyResult]]),
    });
    const build = Array.from(result.hir.items.values()).find(
      (item) =>
        item.kind === "function" &&
        result.binding.symbolTable.getSymbol(item.symbol).name === "build",
    );

    expect(result.diagnostics).toHaveLength(0);
    expect(build?.kind).toBe("function");
    expect(
      build?.kind === "function"
        ? result.borrowing.ordinaryMutationSummaries?.get(build.symbol)
            ?.directAccesses
        : undefined,
    ).toEqual([Access.Read]);
    dependencyResult.exports.packageSemanticInterface?.ordinaryMutationSummaries.forEach(
      ({ summary: exported }) =>
        expect(Object.keys(exported).sort()).toEqual([
          "ambientAccess",
          "directAccesses",
          "maySuspend",
          "reachableAccesses",
          "reentrant",
        ]),
    );
  });

  it("does not infer returned freshness for an imported Array copy", () => {
    const dependency: ModuleNode = {
      id: "std::ordinary_array_copy",
      path: { namespace: "std", segments: ["ordinary_array_copy"] },
      origin: {
        kind: "file",
        filePath: "ordinary-imported-array-copy.test.voyd",
      },
      source: "",
      dependencies: [],
      ast: parse(
        `obj DependencyPaddingA { value: i32 }
obj DependencyPaddingB { value: i32 }

obj Some<T> { value: T }
obj None {}
type Optional<T> = Some<T> | None

@intrinsic_type(type: "voyd.std.array")
pub obj Array<T> { value: T }

impl<T> Array<T>
  api fn copied(self, add_capacity?: i32) -> Array<T>
    Array<T> { value: self.value }

  api fn replace(~self, value: T) -> void
    self.value = value
`,
        "ordinary-imported-array-copy.test.voyd",
      ),
    };
    const consumer: ModuleNode = {
      id: "src::ordinary_array_copy_consumer",
      path: {
        namespace: "src",
        segments: ["ordinary_array_copy_consumer"],
      },
      origin: {
        kind: "file",
        filePath: "ordinary-imported-array-copy-consumer.test.voyd",
      },
      source: "",
      dependencies: [{ kind: "use", path: dependency.path }],
      ast: parse(
        `use std::ordinary_array_copy::Array

obj CallerPaddingA { value: i32 }
obj CallerPaddingB { value: i32 }

fn replaced<T>(source: Array<T>, value: T) -> Array<T>
  let ~copy = source.copied()
  copy.replace(value)
  copy
`,
        "ordinary-imported-array-copy-consumer.test.voyd",
      ),
    };
    const graph: ModuleGraph = {
      entry: consumer.id,
      modules: new Map([
        [dependency.id, dependency],
        [consumer.id, consumer],
      ]),
      diagnostics: [],
    };
    const dependencyResult = semanticsPipeline({ module: dependency, graph });
    expect(() =>
      semanticsPipeline({
        module: consumer,
        graph,
        exports: new Map([[dependency.id, dependencyResult.exports]]),
        dependencies: new Map([[dependency.id, dependencyResult]]),
      }),
    ).toThrow(/TY0055/);
  });

  it("separates disjoint call results from identities reachable through mutable inputs", () => {
    const dependency: ModuleNode = {
      id: "src::ordinary_result_identity",
      path: { namespace: "src", segments: ["ordinary_result_identity"] },
      origin: {
        kind: "file",
        filePath: "ordinary-result-identity-dependency.test.voyd",
      },
      source: "",
      dependencies: [],
      ast: parse(
        `pub obj Counter { api value: i32 }
pub obj Token { api value: i32 }
pub obj Holder { api value: i32, api token: Token }

pub fn fresh_token(source: Counter) -> Token
  Token { value: source.value }

pub fn retained_token(source: Holder) -> Token
  source.token

pub fn bump(~source: Holder) -> void
  source.value = source.value + 1
`,
        "ordinary-result-identity-dependency.test.voyd",
      ),
    };
    const graphFor = (consumer: ModuleNode): ModuleGraph => ({
      entry: consumer.id,
      modules: new Map([
        [dependency.id, dependency],
        [consumer.id, consumer],
      ]),
      diagnostics: [],
    });
    const analyzeConsumer = (source: string, id: string) => {
      const consumer: ModuleNode = {
        id,
        path: { namespace: "src", segments: [id.slice("src::".length)] },
        origin: { kind: "file", filePath: `${id}.test.voyd` },
        source,
        dependencies: [{ kind: "use", path: dependency.path }],
        ast: parse(source, `${id}.test.voyd`),
      };
      return analyzeModules({ graph: graphFor(consumer) });
    };

    expect(
      analyzeConsumer(
        `use src::ordinary_result_identity::{ Counter, fresh_token }

fn consume(~source: Counter) -> i32
  let token = fresh_token(source)
  source.value = source.value + 1
  token.value
`,
        "src::ordinary_disjoint_result_consumer",
      ).diagnostics,
    ).toHaveLength(0);

    expect(
      analyzeConsumer(
        `use src::ordinary_result_identity::{ Holder, bump, retained_token }

fn consume(~source: Holder) -> i32
  let token = retained_token(source)
  bump(~source)
  token.value
`,
        "src::ordinary_retained_result_consumer",
      ).diagnostics.map((diagnostic) => diagnostic.code),
    ).toContain("TY0048");
  });

  it("does not use transitive local result freshness for safety", () => {
    expect(() =>
      semanticsPipeline(
        parse(
          `obj Box { value: i32 }

impl Box
  fn copied(self) -> Box
    Box { value: self.value }

  fn increment(~self) -> void
    self.value = self.value + 1

  fn incremented(self) -> Box
    let ~copy = self.copied()
    copy.increment()
    copy

  fn copied_again(self) -> Box
    self.incremented()

  fn mutate_after_copy(~self) -> Box
    let copy = self.copied_again()
    self.value = self.value + 1
    copy
`,
          "ordinary-fresh-method-result.test.voyd",
        ),
      ),
    ).toThrow(/TY0055/);
  });

  it("keeps sibling projected places disjoint during local mutable access", () => {
    const result = semanticsPipeline(
      parse(
        `val Pair { left: i32, right: i32 }

fn update_right(~value: i32) -> i32
  value = 7
  9

fn update_pair() -> i32
  let ~pair = Pair { left: 1, right: 2 }
  let ~left = pair.left
  let ~right = pair.right
  left = update_right(~right)
  pair.left * 10 + pair.right
`,
        "ordinary-local-sibling-projections.test.voyd",
      ),
    );

    expect(result.diagnostics).toHaveLength(0);
  });

  it("proves disjoint allocation types inside structural arguments without forgetting retained aliases", () => {
    const diagnosticsFor = (source: string, id: string) => {
      const module: ModuleNode = {
        id,
        path: { namespace: "src", segments: [id.slice("src::".length)] },
        origin: { kind: "file", filePath: `${id}.test.voyd` },
        source,
        dependencies: [],
        ast: parse(source, `${id}.test.voyd`),
      };
      return analyzeModules({
        graph: {
          entry: module.id,
          modules: new Map([[module.id, module]]),
          diagnostics: [],
        },
      }).diagnostics.map((diagnostic) => diagnostic.code);
    };

    const unrelated = diagnosticsFor(
      `obj Buffer<T> { value: T }
obj Other { value: i32 }
type Context = { other: Other }

fn read_other(other: Other) -> i32
  other.value

fn touch(~buffer: Buffer<i32>, context: Context) -> i32
  buffer.value = buffer.value + 1
  read_other(context.other) + buffer.value

fn invoke(~buffer: Buffer<i32>, context: Context) -> i32
  touch(~buffer, context)
`,
      "src::ordinary_structural_disjoint_allocation",
    );
    const retained = diagnosticsFor(
      `obj Buffer<T> { value: T }
type Context = { buffer: Buffer<i32> }

fn read_buffer(buffer: Buffer<i32>) -> i32
  buffer.value

fn touch(~buffer: Buffer<i32>, context: Context) -> i32
  buffer.value = buffer.value + 1
  read_buffer(context.buffer) + buffer.value

fn invoke(~buffer: Buffer<i32>, context: Context) -> i32
  touch(~buffer, context)
`,
      "src::ordinary_structural_retained_allocation",
    );

    expect(unrelated).not.toContain("TY0048");
    expect(retained).toContain("TY0048");
  });

  it("plans addressable storage for mutable local alias sources", () => {
    const result = semanticsPipeline(
      parse(
        `val Counter { value: i32 }

fn update() -> i32
  var value = Counter { value: 1 }
  let ~alias = value
  alias.value = 9
  value.value
`,
        "ordinary-local-mutable-alias-storage.test.voyd",
      ),
    );
    const addressableNames = Array.from(
      result.borrowing.mutableStorageSymbols,
    ).map((symbol) => result.binding.symbolTable.getSymbol(symbol).name);

    expect(result.diagnostics).toHaveLength(0);
    expect(addressableNames).toContain("value");
  });

  it("records an immutable object-handle capture as ambient access", () => {
    const result = semanticsPipeline(
      parse(
        `obj Box { value: i32 }

fn reader(value: Box) -> (fn() -> i32)
  () => value.value
`,
        "ordinary-object-capture.test.voyd",
      ),
    );
    const lambda = Array.from(result.hir.expressions.values()).find(
      (expression) => expression.exprKind === "lambda",
    );
    const summary = lambda
      ? result.borrowing.ordinaryMutationSummaries?.get(-1 - lambda.id)
      : undefined;

    expect(summary?.ambientAccess).toBe(Access.Read);
  });

  it("does not classify synthetic match binders as module storage", () => {
    const result = semanticsPipeline(
      parse(
        `obj Sink { value: i32 }
obj Item { value: i32 }
obj Empty {}
type Event = Item | Empty

fn append(~sink: Sink, event: Event) -> void
  event.match(value)
    Item:
      sink.value = value.value
    Empty:
      void
`,
        "ordinary-match-binder.test.voyd",
      ),
    );
    const append = Array.from(result.hir.items.values()).find(
      (item) =>
        item.kind === "function" &&
        result.binding.symbolTable.getSymbol(item.symbol).name === "append",
    );
    const appendSummary =
      append?.kind === "function"
        ? result.borrowing.ordinaryMutationSummaries?.get(append.symbol)
        : undefined;

    expect(result.diagnostics).toHaveLength(0);
    expect(appendSummary).toEqual(
      summary([Access.Write, Access.Unused], {
        reachableAccesses: [Access.Unused, Access.Unused],
      }),
    );
  });

  it("collapses projections while keeping physical intrinsic writes within signature bounds", () => {
    const arraySet = ({
      exprId,
      root,
    }: {
      exprId: number;
      root: number;
    }): CallableBorrowIndexCall => ({
      exprId,
      span: { file: "test.voyd", start: 0, end: 1 },
      targets: [],
      arguments: [
        {
          parameter: 0,
          expression: exprId + 1,
          place: { root, projections: [{ kind: "field", name: "items" }] },
        },
      ],
      intrinsic: true,
      intrinsicBoundary: true,
      intrinsicName: "__array_set",
      formsExplicitBorrow: false,
      returnsBorrowed: false,
      resultUse: "ignored",
      maySuspend: false,
    });
    const index = {
      symbol: 1,
      parameters: [
        { symbol: 10, parameter: 0, defaulted: false, access: "owned" },
        { symbol: 20, parameter: 1, defaulted: false, access: "mutable" },
        { symbol: 30, parameter: 2, defaulted: false, access: "mutable" },
      ],
      parameterPlaces: new Map([
        [10, { parameter: 0, path: [] }],
        [20, { parameter: 1, path: [] }],
        [30, { parameter: 2, path: [] }],
      ]),
      accesses: [
        {
          exprId: 2,
          kind: "read",
          place: {
            root: 10,
            projections: [
              { kind: "field", name: "profile" },
              { kind: "field", name: "count" },
            ],
          },
        },
        {
          exprId: 3,
          kind: "write",
          place: {
            root: 30,
            projections: [
              { kind: "field", name: "profile" },
              { kind: "field", name: "count" },
            ],
          },
        },
      ],
      calls: [
        arraySet({ exprId: 30, root: 10 }),
        arraySet({ exprId: 40, root: 20 }),
      ],
      directCallEdges: [],
      flags: {
        hasModuleStorageAccess: true,
        hasCapture: false,
        hasSuspension: true,
      },
    } as unknown as CallableBorrowIndex;

    expect(extractOrdinaryMutationInput(index).direct).toEqual(
      summary([Access.Read, Access.Write, Access.Write], {
        reachableAccesses: [Access.Unused, Access.Unused, Access.Unused],
        maySuspend: true,
      }),
    );
  });

  it("solves recursive dependencies and reevaluates only affected SCC callers", () => {
    const second = input({
      symbol: 2,
      direct: summary([Access.Write], {
        ambientAccess: Access.Write,
        maySuspend: true,
      }),
      calls: [mappedCall({ target: 1 })],
    });
    const first = input({
      symbol: 1,
      direct: summary([Access.Unused]),
      calls: [mappedCall({ target: 2 })],
    });
    const result = solveOrdinaryMutationSummaries({
      inputs: new Map([
        [second.symbol, second],
        [first.symbol, first],
      ]),
      moduleId: "test",
      recordMetrics: false,
    });

    expect(result.summaries.get(1)).toEqual(
      summary([Access.Write], {
        ambientAccess: Access.Write,
        maySuspend: true,
      }),
    );
    expect(result.metrics).toEqual({
      callableCount: 2,
      callEdgeCount: 2,
      strictSummaryAscents: 1,
      dependencyEnqueues: 1,
      summaryEvaluations: 3,
      sccBodyVisits: 3,
      solverEvaluationBound: 18,
      solverBoundUsage: 3,
      sccReevaluations: 1,
      retainedSummaryBytes: 16,
      ordinaryProjectionFamilies: 0,
      ordinaryWidenings: 0,
    });
  });

  it("propagates uncertain local aliases only to reference-capable parameters", () => {
    const caller = extractOrdinaryMutationInput({
      symbol: 1,
      parameters: [
        { symbol: 10, parameter: 0, defaulted: false, access: "owned" },
        {
          symbol: 20,
          parameter: 1,
          defaulted: false,
          access: "owned",
          referenceCapable: true,
        },
        {
          symbol: 30,
          parameter: 2,
          defaulted: false,
          access: "mutable",
          referenceCapable: true,
        },
      ],
      parameterPlaces: new Map([
        [10, { parameter: 0, path: [] }],
        [20, { parameter: 1, path: [] }],
        [30, { parameter: 2, path: [] }],
      ]),
      accesses: [],
      calls: [
        {
          exprId: 40,
          span: { file: "test.voyd", start: 0, end: 1 },
          targets: [{ moduleId: "test", symbol: 2 }],
          arguments: [
            {
              parameter: 0,
              expression: 41,
              place: { root: 99, projections: [] },
              referenceCapable: true,
            },
          ],
          intrinsic: false,
          intrinsicBoundary: false,
          formsExplicitBorrow: false,
          returnsBorrowed: false,
          resultUse: "ignored",
          maySuspend: false,
        },
      ],
      directCallEdges: [{ moduleId: "test", symbol: 2 }],
      flags: {
        hasModuleStorageAccess: false,
        hasCapture: false,
        hasSuspension: false,
      },
    } as unknown as CallableBorrowIndex);
    const callee = input({
      symbol: 2,
      direct: summary([Access.Write]),
    });
    const result = solveOrdinaryMutationSummaries({
      inputs: new Map([
        [caller.symbol, caller],
        [callee.symbol, callee],
      ]),
      moduleId: "test",
      recordMetrics: false,
    });

    expect(result.summaries.get(caller.symbol)?.directAccesses).toEqual([
      Access.Unused,
      Access.Read,
      Access.Read,
    ]);
    expect(result.summaries.get(caller.symbol)?.reachableAccesses).toEqual([
      Access.Unused,
      Access.Write,
      Access.Write,
    ]);
  });

  it("uses a dynamic declaration bound instead of concrete implementations", () => {
    const dynamicBound = summary([Access.Read]);
    const caller = input({
      symbol: 1,
      direct: summary([Access.Unused]),
      calls: [mappedCall({ target: 2, dynamicBound })],
    });
    const implementation = input({
      symbol: 2,
      direct: summary([Access.Write]),
    });
    const result = solveOrdinaryMutationSummaries({
      inputs: new Map([
        [caller.symbol, caller],
        [implementation.symbol, implementation],
      ]),
      moduleId: "test",
      recordMetrics: false,
    });

    expect(result.summaries.get(caller.symbol)?.directAccesses).toEqual([
      Access.Read,
    ]);
  });

  it("uses the finite declaration bound through open trait dispatch", () => {
    const result = semanticsPipeline(
      parse(
        `obj Box { value: i32 }

trait Reader
  fn read(self) -> i32

impl Reader for Box
  fn read(self) -> i32
    self.value

fn read_dynamic(reader: Reader) -> i32
  reader.read()
`,
        "ordinary-open-trait-summary.test.voyd",
      ),
    );
    const readDynamic = Array.from(result.hir.items.values()).find(
      (item) =>
        item.kind === "function" &&
        result.binding.symbolTable.getSymbol(item.symbol).name ===
          "read_dynamic",
    );

    expect(result.diagnostics).toHaveLength(0);
    expect(
      readDynamic?.kind === "function"
        ? result.borrowing.ordinaryMutationSummaries?.get(readDynamic.symbol)
        : undefined,
    ).toEqual(
      summary([Access.Read], {
        ambientAccess: Access.Write,
        reentrant: true,
        maySuspend: true,
      }),
    );
  });

  it("keeps explicit closed pure trait rows non-suspending", () => {
    const result = semanticsPipeline(
      parse(
        `obj Box { value: i32 }

trait Reader
  fn read(self): () -> i32

impl Reader for Box
  fn read(self): () -> i32
    self.value

fn read_dynamic(reader: Reader): () -> i32
  reader.read()
`,
        "ordinary-closed-pure-trait-summary.test.voyd",
      ),
    );
    const reader = Array.from(result.hir.items.values()).find(
      (item) => item.kind === "trait",
    );
    const readDynamic = Array.from(result.hir.items.values()).find(
      (item) =>
        item.kind === "function" &&
        result.binding.symbolTable.getSymbol(item.symbol).name ===
          "read_dynamic",
    );

    expect(result.diagnostics).toHaveLength(0);
    expect(
      reader?.kind === "trait"
        ? result.borrowing.ordinaryMutationSummaries.get(
            reader.methods[0]!.symbol,
          )
        : undefined,
    ).toEqual(
      summary([Access.Read], {
        ambientAccess: Access.Write,
        reentrant: true,
      }),
    );
    expect(
      readDynamic?.kind === "function"
        ? result.borrowing.ordinaryMutationSummaries.get(readDynamic.symbol)
        : undefined,
    ).toEqual(
      summary([Access.Read], {
        ambientAccess: Access.Write,
        reentrant: true,
      }),
    );
  });

  it("uses only the selected same-name trait overload bound", () => {
    const result = semanticsPipeline(
      parse(
        `eff Tick
  wait(tail) -> i32

obj Box { value: i32 }

trait Runner
  fn run(self, { pure value: i32 }): () -> i32
  fn run(self, { effectful value: i32 }): Tick -> i32

impl Runner for Box
  fn run(self, { pure value: i32 }): () -> i32
    self.value + value

  fn run(self, { effectful value: i32 }): Tick -> i32
    self.value + value + Tick::wait()

fn run_pure(runner: Runner): () -> i32
  runner.run(pure: 1)

fn run_effectful(runner: Runner): Tick -> i32
  runner.run(effectful: 1)
`,
        "ordinary-selected-trait-overload-summary.test.voyd",
      ),
    );
    const functions = new Map(
      Array.from(result.hir.items.values()).flatMap((item) =>
        item.kind === "function"
          ? [
              [
                result.binding.symbolTable.getSymbol(item.symbol).name,
                item,
              ] as const,
            ]
          : [],
      ),
    );

    expect(result.diagnostics).toHaveLength(0);
    expect(
      result.borrowing.ordinaryMutationSummaries.get(
        functions.get("run_pure")!.symbol,
      ),
    ).toEqual(
      summary([Access.Read], {
        ambientAccess: Access.Write,
        reentrant: true,
      }),
    );
    expect(
      result.borrowing.ordinaryMutationSummaries.get(
        functions.get("run_effectful")!.symbol,
      ),
    ).toEqual(
      summary([Access.Read], {
        ambientAccess: Access.Write,
        reentrant: true,
        maySuspend: true,
      }),
    );
  });

  it("keeps local trait defaults on the finite declaration bound", () => {
    const result = semanticsPipeline(
      parse(
        `obj Box { value: i32 }

trait Reader
  fn read(self) -> i32

  fn read_twice(self) -> i32
    self.read() + self.read()

impl Reader for Box
  fn read(self) -> i32
    self.value

fn read_dynamic(reader: Reader) -> i32
  reader.read_twice()
`,
        "ordinary-local-trait-default-summary.test.voyd",
      ),
    );

    expect(result.diagnostics).toHaveLength(0);
  });

  it("preserves declared suspension through plain trait dispatch", () => {
    const result = semanticsPipeline(
      parse(
        `eff Tick
  wait(tail) -> i32

obj Box { value: i32 }

trait Runner
  fn run(self): Tick -> i32

impl Runner for Box
  fn run(self): Tick -> i32
    self.value + Tick::wait()

fn run_dynamic(runner: Runner): Tick -> i32
  runner.run()
`,
        "ordinary-effectful-trait-summary.test.voyd",
      ),
    );
    const runDynamic = Array.from(result.hir.items.values()).find(
      (item) =>
        item.kind === "function" &&
        result.binding.symbolTable.getSymbol(item.symbol).name ===
          "run_dynamic",
    );

    expect(result.diagnostics).toHaveLength(0);
    expect(
      runDynamic?.kind === "function"
        ? result.borrowing.ordinaryMutationSummaries?.get(runDynamic.symbol)
        : undefined,
    ).toEqual(
      summary([Access.Read], {
        ambientAccess: Access.Write,
        reentrant: true,
        maySuspend: true,
      }),
    );
  });

  it("still enforces local exclusive liveness under an open trait bound", () => {
    expect(() =>
      semanticsPipeline(
        parse(
          `obj Box { value: i32 }

let ambient = Box { value: 1 }

trait Reader
  fn read(self, ~value: Box) -> i32

impl Reader for Box
  fn read(self, ~value: Box) -> i32
    value.value = value.value + ambient.value
    value.value
`,
          "ordinary-trait-ambient-bound.test.voyd",
        ),
      ),
    ).toThrow(/TY0055/);
  });

  it("preserves conservative open-trait bounds across imports", () => {
    const dependency: ModuleNode = {
      id: "src::ordinary_trait_bound_dependency",
      path: {
        namespace: "src",
        segments: ["ordinary_trait_bound_dependency"],
      },
      origin: {
        kind: "file",
        filePath: "ordinary-trait-bound-dependency.test.voyd",
      },
      source: "",
      dependencies: [],
      ast: parse(
        `pub trait Reader
  fn read(self) -> i32
`,
        "ordinary-trait-bound-dependency.test.voyd",
      ),
    };
    const consumer: ModuleNode = {
      id: "src::ordinary_trait_bound_consumer",
      path: {
        namespace: "src",
        segments: ["ordinary_trait_bound_consumer"],
      },
      origin: {
        kind: "file",
        filePath: "ordinary-trait-bound-consumer.test.voyd",
      },
      source: "",
      dependencies: [{ kind: "use", path: dependency.path }],
      ast: parse(
        `use src::ordinary_trait_bound_dependency::Reader

obj Box { value: i32 }

let ambient = Box { value: 1 }

impl Reader for Box
  fn read(self) -> i32
    self.value
    ambient.value
`,
        "ordinary-trait-bound-consumer.test.voyd",
      ),
    };
    const graph: ModuleGraph = {
      entry: consumer.id,
      modules: new Map([
        [dependency.id, dependency],
        [consumer.id, consumer],
      ]),
      diagnostics: [],
    };
    const dependencyResult = semanticsPipeline({ module: dependency, graph });

    const result = semanticsPipeline({
      module: consumer,
      graph,
      exports: new Map([[dependency.id, dependencyResult.exports]]),
      dependencies: new Map([[dependency.id, dependencyResult]]),
    });

    expect(result.diagnostics).toHaveLength(0);
  });

  it("keeps fallback imported open receivers conservative while preserving suspension", () => {
    const dependency: ModuleNode = {
      id: "src::ordinary_trait_effect_dependency",
      path: {
        namespace: "src",
        segments: ["ordinary_trait_effect_dependency"],
      },
      origin: {
        kind: "file",
        filePath: "ordinary-trait-effect-dependency.test.voyd",
      },
      source: "",
      dependencies: [],
      ast: parse(
        `pub eff Tick
  wait(tail) -> i32

pub trait Runner
  fn run(self, { pure value: i32 }): () -> i32
  fn run(self, { effectful value: i32 }): Tick -> i32
`,
        "ordinary-trait-effect-dependency.test.voyd",
      ),
    };
    const consumer: ModuleNode = {
      id: "src::ordinary_trait_effect_consumer",
      path: {
        namespace: "src",
        segments: ["ordinary_trait_effect_consumer"],
      },
      origin: {
        kind: "file",
        filePath: "ordinary-trait-effect-consumer.test.voyd",
      },
      source: "",
      dependencies: [{ kind: "use", path: dependency.path }],
      ast: parse(
        `use src::ordinary_trait_effect_dependency::{ Runner, Tick }

obj Box { value: i32 }

impl Runner for Box
  fn run(self, { pure value: i32 }): () -> i32
    self.value + value

  fn run(self, { effectful value: i32 }): Tick -> i32
    self.value + value + Tick::wait()

fn run_pure(runner: Runner): () -> i32
  runner.run(pure: 1)

fn run_effectful(runner: Runner): Tick -> i32
  runner.run(effectful: 1)
`,
        "ordinary-trait-effect-consumer.test.voyd",
      ),
    };
    const graph: ModuleGraph = {
      entry: consumer.id,
      modules: new Map([
        [dependency.id, dependency],
        [consumer.id, consumer],
      ]),
      diagnostics: [],
    };
    const dependencyResult = semanticsPipeline({ module: dependency, graph });
    const result = semanticsPipeline({
      module: consumer,
      graph,
      exports: new Map([[dependency.id, dependencyResult.exports]]),
      dependencies: new Map([[dependency.id, dependencyResult]]),
    });
    const functions = new Map(
      Array.from(result.hir.items.values()).flatMap((item) =>
        item.kind === "function"
          ? [
              [
                result.binding.symbolTable.getSymbol(item.symbol).name,
                item,
              ] as const,
            ]
          : [],
      ),
    );

    expect(result.diagnostics).toHaveLength(0);
    expect(
      result.borrowing.ordinaryMutationSummaries.get(
        functions.get("run_pure")!.symbol,
      ),
    ).toEqual(
      summary([Access.Read], {
        ambientAccess: Access.Write,
        reentrant: true,
      }),
    );
    expect(
      result.borrowing.ordinaryMutationSummaries.get(
        functions.get("run_effectful")!.symbol,
      ),
    ).toEqual(
      summary([Access.Read], {
        ambientAccess: Access.Write,
        reentrant: true,
        maySuspend: true,
      }),
    );
  });

  it("reports implementation effects outside a declaration upper bound", () => {
    const declaration = ordinaryMutationSignatureUpperBound({
      signature: {
        parameters: [{ bindingKind: "immutable-ref" }],
      } as unknown as Parameters<
        typeof ordinaryMutationSignatureUpperBound
      >[0]["signature"],
    });
    const violations = validateOrdinaryMutationSummaryBound({
      symbol: 7,
      implementation: summary([Access.Write], {
        reentrant: true,
      }),
      declaration,
    });

    expect(violations).toEqual([
      {
        kind: "parameter-access",
        symbol: 7,
        parameter: 0,
        access: "direct",
        actual: Access.Write,
        allowed: Access.Read,
      },
      {
        kind: "parameter-access",
        symbol: 7,
        parameter: 0,
        access: "reachable",
        actual: Access.Write,
        allowed: Access.Read,
      },
      { kind: "unknown-callback", symbol: 7 },
    ]);
  });
});
