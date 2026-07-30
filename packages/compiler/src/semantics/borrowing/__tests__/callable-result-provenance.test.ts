import { expect, it } from "vitest";
import { resolve, sep } from "node:path";
import { createMemoryModuleHost } from "../../../modules/memory-host.js";
import { createNodePathAdapter } from "../../../modules/node-path-adapter.js";
import { analyzeModules, loadModuleGraph } from "../../../pipeline.js";

it("propagates an imported callback result through an imported higher-order helper", async () => {
  const srcRoot = resolve("/proj/src");
  const stdRoot = resolve("/proj/std");
  const host = createMemoryModuleHost({
    files: {
      [`${stdRoot}${sep}pkg.voyd`]: `
pub use self::common
pub use self::hof
pub use self::maker
pub use std::common::{ Item, View }
pub use std::hof::{ apply }
pub use std::maker::{ create }
`,
      [`${stdRoot}${sep}common.voyd`]: `
pub obj Item { api value: i32 }

pub trait View
  region source

  @borrow_contract(returns_from: source)
  fn get(self) -> borrow Item
`,
      [`${stdRoot}${sep}hof.voyd`]: `
use std::common::{ View }

pub fn apply(factory: fn() -> View) -> View
  factory()

`,
      [`${stdRoot}${sep}maker.voyd`]: `
use std::common::{ Item, View }

obj MakerState { source: Item }

impl View for MakerState
  region source = deref(self.source)

  fn get(self) -> borrow Item
    self.source

pub fn create() -> View
  MakerState { source: Item { value: 1 } }
`,
      [`${srcRoot}${sep}main.voyd`]: `
use std::all

pub fn pass() -> View
  apply(create)

pub fn main() -> i32
  pass().get().value
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
  const main = analyzed.semantics.get("src::main");
  const passExport = Array.from(main?.exports.values() ?? []).find(
    (entry) => entry.name === "pass",
  );
  expect([...graph.diagnostics, ...analyzed.diagnostics]).toEqual([]);
  expect(
    passExport?.borrowingCoercions?.map(
      (coercion) => coercion.concrete.moduleId,
    ),
  ).toEqual(["std::maker"]);
});

it("propagates an omitted imported callback default through a higher-order helper", async () => {
  const srcRoot = resolve("/proj/src");
  const stdRoot = resolve("/proj/std");
  const host = createMemoryModuleHost({
    files: {
      [`${stdRoot}${sep}pkg.voyd`]: `
pub use self::common
pub use self::hof
pub use std::common::{ Item, View }
pub use std::hof::{ apply }
`,
      [`${stdRoot}${sep}common.voyd`]: `
pub obj Item { api value: i32 }

pub trait View
  region source

  @borrow_contract(returns_from: source)
  fn get(self) -> borrow Item
`,
      [`${stdRoot}${sep}hof.voyd`]: `
use std::common::{ Item, View }

obj DefaultState { source: Item }

impl View for DefaultState
  region source = deref(self.source)

  fn get(self) -> borrow Item
    self.source

pub fn apply(
  factory: fn() -> View = () => DefaultState {
    source: Item { value: 1 }
  }
) -> View
  factory()
`,
      [`${srcRoot}${sep}main.voyd`]: `
use std::all

pub fn pass() -> View
  apply()

pub fn main() -> i32
  pass().get().value
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
  const main = analyzed.semantics.get("src::main");
  const passExport = Array.from(main?.exports.values() ?? []).find(
    (entry) => entry.name === "pass",
  );
  expect([...graph.diagnostics, ...analyzed.diagnostics]).toEqual([]);
  expect(
    passExport?.borrowingCoercions?.map(
      (coercion) => coercion.concrete.moduleId,
    ),
  ).toEqual(["std::hof"]);
});

it("composes an imported callback-result summary into a local wrapper", async () => {
  const srcRoot = resolve("/proj/src");
  const stdRoot = resolve("/proj/std");
  const host = createMemoryModuleHost({
    files: {
      [`${stdRoot}${sep}pkg.voyd`]: `
pub use self::common
pub use self::hof
pub use std::common::{ Item, View }
pub use std::hof::{ apply }
`,
      [`${stdRoot}${sep}common.voyd`]: `
pub obj Item { api value: i32 }

pub trait View
  region source

  @borrow_contract(returns_from: source)
  fn get(self) -> borrow Item
`,
      [`${stdRoot}${sep}hof.voyd`]: `
use std::common::{ View }

pub fn apply(factory: fn() -> View) -> View
  factory()
`,
      [`${srcRoot}${sep}main.voyd`]: `
use std::all

obj LocalState { source: Item }

impl View for LocalState
  region source = deref(self.source)

  fn get(self) -> borrow Item
    self.source

pub fn relay(factory: fn() -> View) -> View
  apply(factory)

pub fn pass(owner: Item) -> View
  relay(() => LocalState { source: owner })

pub fn main() -> i32
  pass(Item { value: 1 }).get().value
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
  const main = analyzed.semantics.get("src::main");
  const relayExport = Array.from(main?.exports.values() ?? []).find(
    (entry) => entry.name === "relay",
  );
  const passExport = Array.from(main?.exports.values() ?? []).find(
    (entry) => entry.name === "pass",
  );
  expect([...graph.diagnostics, ...analyzed.diagnostics]).toEqual([]);
  expect(
    relayExport?.borrowing?.[0]?.contract.callableResultInvocations,
  ).toEqual([{ parameter: 0, source: [], callbackResult: [], result: [] }]);
  expect(
    passExport?.borrowingCoercions?.map((coercion) =>
      main?.symbols.getName(coercion.concrete.symbol),
    ),
  ).toEqual(["LocalState"]);
});

it("tracks an invoked callback parameter through an ordinary local alias", async () => {
  const srcRoot = resolve("/proj/src");
  const stdRoot = resolve("/proj/std");
  const host = createMemoryModuleHost({
    files: {
      [`${stdRoot}${sep}pkg.voyd`]: `
pub use self::common
pub use self::hof
pub use std::common::{ Item, View }
pub use std::hof::{ apply }
`,
      [`${stdRoot}${sep}common.voyd`]: `
pub obj Item { api value: i32 }

pub trait View
  region source

  @borrow_contract(returns_from: source)
  fn get(self) -> borrow Item
`,
      [`${stdRoot}${sep}hof.voyd`]: `
use std::common::{ View }

pub fn apply(factory: fn() -> View) -> View
  let alias = factory
  alias()
`,
      [`${srcRoot}${sep}main.voyd`]: `
use std::all

obj LocalState { source: Item }

impl View for LocalState
  region source = deref(self.source)

  fn get(self) -> borrow Item
    self.source

pub fn pass(owner: Item) -> View
  apply(() => LocalState { source: owner })

pub fn main() -> i32
  pass(Item { value: 1 }).get().value
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
  const hof = analyzed.semantics.get("std::hof");
  const main = analyzed.semantics.get("src::main");
  const applyExport = Array.from(hof?.exports.values() ?? []).find(
    (entry) => entry.name === "apply",
  );
  const passExport = Array.from(main?.exports.values() ?? []).find(
    (entry) => entry.name === "pass",
  );

  expect([...graph.diagnostics, ...analyzed.diagnostics]).toEqual([]);
  expect(
    applyExport?.borrowing?.[0]?.contract.callableResultInvocations,
  ).toEqual([{ parameter: 0, source: [], callbackResult: [], result: [] }]);
  expect(
    passExport?.borrowingCoercions?.map((coercion) =>
      main?.symbols.getName(coercion.concrete.symbol),
    ),
  ).toEqual(["LocalState"]);
});

it("propagates a callback result nested in an aggregate", async () => {
  const srcRoot = resolve("/proj/src");
  const stdRoot = resolve("/proj/std");
  const host = createMemoryModuleHost({
    files: {
      [`${stdRoot}${sep}pkg.voyd`]: `
pub use self::common
pub use self::hof
pub use std::common::{ Item, View, Wrapper }
pub use std::hof::{ apply }
`,
      [`${stdRoot}${sep}common.voyd`]: `
pub obj Item { api value: i32 }
pub obj Wrapper { api view: View }

pub trait View
  region source

  @borrow_contract(returns_from: source)
  fn get(self) -> borrow Item
`,
      [`${stdRoot}${sep}hof.voyd`]: `
use std::common::{ View, Wrapper }

pub fn apply(factory: fn() -> View) -> Wrapper
  Wrapper { view: factory() }
`,
      [`${srcRoot}${sep}main.voyd`]: `
use std::all

obj LocalState { source: Item }

impl View for LocalState
  region source = deref(self.source)

  fn get(self) -> borrow Item
    self.source

pub fn pass(owner: Item) -> Wrapper
  apply(() => LocalState { source: owner })

pub fn main() -> i32
  pass(Item { value: 1 }).view.get().value
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
  const main = analyzed.semantics.get("src::main");
  const passExport = Array.from(main?.exports.values() ?? []).find(
    (entry) => entry.name === "pass",
  );

  expect([...graph.diagnostics, ...analyzed.diagnostics]).toEqual([]);
  expect(
    passExport?.borrowingCoercions?.map((coercion) =>
      main?.symbols.getName(coercion.concrete.symbol),
    ),
  ).toEqual(["LocalState"]);
});

it("tracks a projected callback result", async () => {
  const srcRoot = resolve("/proj/src");
  const stdRoot = resolve("/proj/std");
  const host = createMemoryModuleHost({
    files: {
      [`${stdRoot}${sep}pkg.voyd`]: `
pub use self::common
pub use self::hof
pub use std::common::{ Item, View, Wrapper }
pub use std::hof::{ apply }
`,
      [`${stdRoot}${sep}common.voyd`]: `
pub obj Item { api value: i32 }
pub obj Wrapper { api view: View }

pub trait View
  region source

  @borrow_contract(returns_from: source)
  fn get(self) -> borrow Item
`,
      [`${stdRoot}${sep}hof.voyd`]: `
use std::common::{ View, Wrapper }

pub fn apply(factory: fn() -> Wrapper) -> View
  factory().view
`,
      [`${srcRoot}${sep}main.voyd`]: `
use std::all

obj LocalState { source: Item }

impl View for LocalState
  region source = deref(self.source)

  fn get(self) -> borrow Item
    self.source

pub fn pass(owner: Item) -> View
  apply(() => Wrapper {
    view: LocalState { source: owner }
  })

pub fn main() -> i32
  pass(Item { value: 1 }).get().value
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
  const main = analyzed.semantics.get("src::main");
  const passExport = Array.from(main?.exports.values() ?? []).find(
    (entry) => entry.name === "pass",
  );

  expect([...graph.diagnostics, ...analyzed.diagnostics]).toEqual([]);
  expect(
    passExport?.borrowingCoercions?.map((coercion) =>
      main?.symbols.getName(coercion.concrete.symbol),
    ),
  ).toEqual(["LocalState"]);
});

it("does not publish an unused imported callback result projection", async () => {
  const srcRoot = resolve("/proj/src");
  const stdRoot = resolve("/proj/std");
  const host = createMemoryModuleHost({
    files: {
      [`${stdRoot}${sep}pkg.voyd`]: `
pub use self::common
pub use self::hof
pub use self::maker
pub use std::common::{ Item, Pair, View }
pub use std::hof::{ apply }
pub use std::maker::{ create }
`,
      [`${stdRoot}${sep}common.voyd`]: `
pub obj Item { api value: i32 }
pub obj Pair { api selected: View, api ignored: View }

pub trait View
  region source

  @borrow_contract(returns_from: source)
  fn get(self) -> borrow Item
`,
      [`${stdRoot}${sep}hof.voyd`]: `
use std::common::{ Pair, View }

pub fn apply(factory: fn() -> Pair) -> View
  factory().selected
`,
      [`${stdRoot}${sep}maker.voyd`]: `
use std::common::{ Item, Pair, View }

obj UsedState { source: Item }
obj UnusedState { source: Item }

impl View for UsedState
  region source = deref(self.source)

  fn get(self) -> borrow Item
    self.source

impl View for UnusedState
  region source = deref(self.source)

  fn get(self) -> borrow Item
    self.source

pub fn create() -> Pair
  Pair {
    selected: UsedState { source: Item { value: 1 } },
    ignored: UnusedState { source: Item { value: 2 } }
  }
`,
      [`${srcRoot}${sep}main.voyd`]: `
use std::all

pub fn pass() -> View
  apply(create)

pub fn main() -> i32
  pass().get().value
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
  const maker = analyzed.semantics.get("std::maker");
  const main = analyzed.semantics.get("src::main");
  const passExport = Array.from(main?.exports.values() ?? []).find(
    (entry) => entry.name === "pass",
  );
  expect([...graph.diagnostics, ...analyzed.diagnostics]).toEqual([]);
  expect(
    passExport?.borrowingCoercions?.map((coercion) =>
      maker?.symbols.getName(coercion.concrete.symbol),
    ),
  ).toEqual(["UsedState"]);
});

it("does not publish an unused direct imported result projection", async () => {
  const srcRoot = resolve("/proj/src");
  const stdRoot = resolve("/proj/std");
  const host = createMemoryModuleHost({
    files: {
      [`${stdRoot}${sep}pkg.voyd`]: `
pub use self::common
pub use self::maker
pub use std::common::{ Item, Pair, View }
pub use std::maker::{ create }
`,
      [`${stdRoot}${sep}common.voyd`]: `
pub obj Item { api value: i32 }
pub obj Pair { api selected: View, api ignored: View }

pub trait View
  region source

  @borrow_contract(returns_from: source)
  fn get(self) -> borrow Item
`,
      [`${stdRoot}${sep}maker.voyd`]: `
use std::common::{ Item, Pair, View }

obj UsedState { source: Item }
obj UnusedState { source: Item }

impl View for UsedState
  region source = deref(self.source)

  fn get(self) -> borrow Item
    self.source

impl View for UnusedState
  region source = deref(self.source)

  fn get(self) -> borrow Item
    self.source

pub fn create() -> Pair
  Pair {
    selected: UsedState { source: Item { value: 1 } },
    ignored: UnusedState { source: Item { value: 2 } }
  }
`,
      [`${srcRoot}${sep}main.voyd`]: `
use std::all

pub fn pass() -> View
  create().selected

pub fn main() -> i32
  pass().get().value
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
  const maker = analyzed.semantics.get("std::maker");
  const main = analyzed.semantics.get("src::main");
  const passExport = Array.from(main?.exports.values() ?? []).find(
    (entry) => entry.name === "pass",
  );

  expect([...graph.diagnostics, ...analyzed.diagnostics]).toEqual([]);
  expect(
    passExport?.borrowingCoercions?.map((coercion) =>
      maker?.symbols.getName(coercion.concrete.symbol),
    ),
  ).toEqual(["UsedState"]);
});

it("keeps imported result paths correlated with overload identity", async () => {
  const srcRoot = resolve("/proj/src");
  const stdRoot = resolve("/proj/std");
  const host = createMemoryModuleHost({
    files: {
      [`${stdRoot}${sep}pkg.voyd`]: `
pub use self::api
pub use std::api::{ Item, Pair, View, choose }
`,
      [`${stdRoot}${sep}api.voyd`]: `
pub obj Item { api value: i32 }
pub obj Pair { api left: View, api right: View }

pub trait View
  region source

  @borrow_contract(returns_from: source)
  fn get(self) -> borrow Item

obj State { source: Item }
obj Other { source: Item }

impl View for State
  region source = deref(self.source)

  fn get(self) -> borrow Item
    self.source

impl View for Other
  region source = deref(self.source)

  fn get(self) -> borrow Item
    self.source

pub fn choose(value: i32) -> Pair
  Pair {
    left: State { source: Item { value } },
    right: Other { source: Item { value: 2 } }
  }

pub fn choose(value: bool) -> Pair
  Pair {
    left: Other { source: Item { value: 3 } },
    right: State {
      source: Item { value: if value then: 4 else: 5 }
    }
  }
`,
      [`${srcRoot}${sep}main.voyd`]: `
use std::all

pub fn pass() -> View
  choose(1).left

pub fn main() -> i32
  pass().get().value
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
  const passExport = Array.from(main?.exports.values() ?? []).find(
    (entry) => entry.name === "pass",
  );

  expect([...graph.diagnostics, ...analyzed.diagnostics]).toEqual([]);
  expect(
    passExport?.borrowingCoercions?.map((coercion) =>
      api?.symbols.getName(coercion.concrete.symbol),
    ),
  ).toEqual(["State"]);
});

it("keeps an omitted callback default at its aggregate result path", async () => {
  const srcRoot = resolve("/proj/src");
  const stdRoot = resolve("/proj/std");
  const host = createMemoryModuleHost({
    files: {
      [`${stdRoot}${sep}pkg.voyd`]: `
pub use self::common
pub use self::hof
pub use std::common::{ Item, View, Wrapper }
pub use std::hof::{ apply }
`,
      [`${stdRoot}${sep}common.voyd`]: `
pub obj Item { api value: i32 }
pub obj Wrapper { api view: View }

pub trait View
  region source

  @borrow_contract(returns_from: source)
  fn get(self) -> borrow Item
`,
      [`${stdRoot}${sep}hof.voyd`]: `
use std::common::{ Item, View, Wrapper }

obj DefaultState { source: Item }

impl View for DefaultState
  region source = deref(self.source)

  fn get(self) -> borrow Item
    self.source

pub fn apply(
  factory: fn() -> View = () => DefaultState {
    source: Item { value: 1 }
  }
) -> Wrapper
  Wrapper { view: factory() }
`,
      [`${srcRoot}${sep}main.voyd`]: `
use std::all

pub fn pass() -> View
  apply().view

pub fn main() -> i32
  pass().get().value
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
  const hof = analyzed.semantics.get("std::hof");
  const main = analyzed.semantics.get("src::main");
  const passExport = Array.from(main?.exports.values() ?? []).find(
    (entry) => entry.name === "pass",
  );

  expect([...graph.diagnostics, ...analyzed.diagnostics]).toEqual([]);
  expect(
    passExport?.borrowingCoercions?.map((coercion) =>
      hof?.symbols.getName(coercion.concrete.symbol),
    ),
  ).toEqual(["DefaultState"]);
});

it("keeps an omitted value default at its aggregate result path", async () => {
  const srcRoot = resolve("/proj/src");
  const stdRoot = resolve("/proj/std");
  const host = createMemoryModuleHost({
    files: {
      [`${stdRoot}${sep}pkg.voyd`]: `
pub use self::common
pub use self::api
pub use std::common::{ Item, View, Wrapper }
pub use std::api::{ wrap }
`,
      [`${stdRoot}${sep}common.voyd`]: `
pub obj Item { api value: i32 }
pub obj Wrapper { api view: View }

pub trait View
  region source

  @borrow_contract(returns_from: source)
  fn get(self) -> borrow Item
`,
      [`${stdRoot}${sep}api.voyd`]: `
use std::common::{ Item, View, Wrapper }

obj DefaultState { source: Item }

impl View for DefaultState
  region source = deref(self.source)

  fn get(self) -> borrow Item
    self.source

pub fn wrap(
  value: View = DefaultState {
    source: Item { value: 1 }
  }
) -> Wrapper
  Wrapper { view: value }
`,
      [`${srcRoot}${sep}main.voyd`]: `
use std::all

pub fn pass() -> View
  wrap().view

pub fn main() -> i32
  pass().get().value
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
  const passExport = Array.from(main?.exports.values() ?? []).find(
    (entry) => entry.name === "pass",
  );

  expect([...graph.diagnostics, ...analyzed.diagnostics]).toEqual([]);
  expect(
    passExport?.borrowingCoercions?.map((coercion) =>
      api?.symbols.getName(coercion.concrete.symbol),
    ),
  ).toEqual(["DefaultState"]);
});

it("does not expose private callback or result projections in summaries", async () => {
  const srcRoot = resolve("/proj/src");
  const stdRoot = resolve("/proj/std");
  const host = createMemoryModuleHost({
    files: {
      [`${stdRoot}${sep}pkg.voyd`]: `
pub use self::api
pub use std::api::{ Item, View, Wrapper, apply, make }
`,
      [`${stdRoot}${sep}api.voyd`]: `
pub obj Item { api value: i32 }
pub obj Wrapper { selected: View, ignored: View }

pub trait View
  region source

  @borrow_contract(returns_from: source)
  fn get(self) -> borrow Item

obj State { source: Item }
obj UnusedState { source: Item }

impl View for State
  region source = deref(self.source)

  fn get(self) -> borrow Item
    self.source

impl View for UnusedState
  region source = deref(self.source)

  fn get(self) -> borrow Item
    self.source

pub fn make() -> Wrapper
  Wrapper {
    selected: State { source: Item { value: 1 } },
    ignored: UnusedState { source: Item { value: 2 } }
  }

pub fn apply(factory: fn() -> Wrapper) -> View
  factory().selected
`,
      [`${srcRoot}${sep}main.voyd`]: `
use std::all

pub fn pass() -> View
  apply(make)

pub fn main() -> i32
  pass().get().value
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
  const passExport = Array.from(main?.exports.values() ?? []).find(
    (entry) => entry.name === "pass",
  );

  expect([...graph.diagnostics, ...analyzed.diagnostics]).toEqual([]);
  expect(
    passExport?.borrowingCoercions?.map((coercion) =>
      api?.symbols.getName(coercion.concrete.symbol),
    ),
  ).toEqual(["State"]);
  const serializedExports = JSON.stringify(
    Array.from(api?.exports.values() ?? []),
  );
  expect(serializedExports).not.toContain("selected");
  expect(serializedExports).not.toContain("ignored");
});

it("keeps imported variant result provenance narrowed by the matched arm", async () => {
  const srcRoot = resolve("/proj/src");
  const stdRoot = resolve("/proj/std");
  const host = createMemoryModuleHost({
    files: {
      [`${stdRoot}${sep}pkg.voyd`]: `
pub use self::common
pub use self::maker
pub use std::common::{ Either, Item, Left, Right, View }
pub use std::maker::{ make }
`,
      [`${stdRoot}${sep}common.voyd`]: `
pub obj Item { api value: i32 }
pub obj Left<T> { api value: T }
pub obj Right<T> { api value: T }
pub type Either<T> = Left<T> | Right<T>

pub trait View
  region source

  @borrow_contract(returns_from: source)
  fn get(self) -> borrow Item
`,
      [`${stdRoot}${sep}maker.voyd`]: `
use std::common::{ Either, Item, Left, Right, View }

obj LeftState { source: Item }
obj RightState { source: Item }

impl View for LeftState
  region source = deref(self.source)

  fn get(self) -> borrow Item
    self.source

impl View for RightState
  region source = deref(self.source)

  fn get(self) -> borrow Item
    self.source

pub fn make(flag: bool) -> Either<View>
  if flag then:
    Left<View> {
      value: LeftState { source: Item { value: 1 } }
    }
  else:
    Right<View> {
      value: RightState { source: Item { value: 2 } }
    }
`,
      [`${srcRoot}${sep}main.voyd`]: `
use std::all

obj FallbackState { source: Item }

impl View for FallbackState
  region source = deref(self.source)

  fn get(self) -> borrow Item
    self.source

pub fn choose(flag: bool) -> View
  match(make(flag))
    Left<View> { value }: value
    Right<View>: FallbackState {
      source: Item { value: 3 }
    }

pub fn main() -> i32
  choose(true).get().value
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
  const maker = analyzed.semantics.get("std::maker");
  const main = analyzed.semantics.get("src::main");
  const chooseExport = Array.from(main?.exports.values() ?? []).find(
    (entry) => entry.name === "choose",
  );

  expect([...graph.diagnostics, ...analyzed.diagnostics]).toEqual([]);
  expect(
    chooseExport?.borrowingCoercions
      ?.map((coercion) =>
        coercion.concrete.moduleId === "src::main"
          ? main?.symbols.getName(coercion.concrete.symbol)
          : maker?.symbols.getName(coercion.concrete.symbol),
      )
      .sort(),
  ).toEqual(["FallbackState", "LeftState"]);
});

it("keeps higher-order variant result provenance narrowed by the matched arm", async () => {
  const srcRoot = resolve("/proj/src");
  const stdRoot = resolve("/proj/std");
  const host = createMemoryModuleHost({
    files: {
      [`${stdRoot}${sep}pkg.voyd`]: `
pub use self::common
pub use self::hof
pub use self::maker
pub use std::common::{ Either, Item, Left, Right, View }
pub use std::hof::{ apply }
pub use std::maker::{ make }
`,
      [`${stdRoot}${sep}common.voyd`]: `
pub obj Item { api value: i32 }
pub obj Left<T> { api value: T }
pub obj Right<T> { api value: T }
pub type Either<T> = Left<T> | Right<T>

pub trait View
  region source

  @borrow_contract(returns_from: source)
  fn get(self) -> borrow Item
`,
      [`${stdRoot}${sep}maker.voyd`]: `
use std::common::{ Either, Item, Left, Right, View }

obj LeftState { source: Item }
obj RightState { source: Item }

impl View for LeftState
  region source = deref(self.source)

  fn get(self) -> borrow Item
    self.source

impl View for RightState
  region source = deref(self.source)

  fn get(self) -> borrow Item
    self.source

pub fn make() -> Either<View>
  if true then:
    Left<View> {
      value: LeftState { source: Item { value: 1 } }
    }
  else:
    Right<View> {
      value: RightState { source: Item { value: 2 } }
    }
`,
      [`${stdRoot}${sep}hof.voyd`]: `
use std::common::{ Either, Item, Left, Right, View }

obj FallbackState { source: Item }

impl View for FallbackState
  region source = deref(self.source)

  fn get(self) -> borrow Item
    self.source

pub fn apply(factory: fn() -> Either<View>) -> View
  match(factory())
    Left<View> { value }: value
    Right<View>: FallbackState {
      source: Item { value: 3 }
    }
`,
      [`${srcRoot}${sep}main.voyd`]: `
use std::all

pub fn pass() -> View
  apply(make)

pub fn main() -> i32
  pass().get().value
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
  const maker = analyzed.semantics.get("std::maker");
  const hof = analyzed.semantics.get("std::hof");
  const main = analyzed.semantics.get("src::main");
  const passExport = Array.from(main?.exports.values() ?? []).find(
    (entry) => entry.name === "pass",
  );

  expect([...graph.diagnostics, ...analyzed.diagnostics]).toEqual([]);
  expect(
    passExport?.borrowingCoercions
      ?.map((coercion) =>
        coercion.concrete.moduleId === "std::maker"
          ? maker?.symbols.getName(coercion.concrete.symbol)
          : hof?.symbols.getName(coercion.concrete.symbol),
      )
      .sort(),
  ).toEqual(["FallbackState", "LeftState"]);
});

it("keeps a higher-order result correlated with its destination variant", async () => {
  const srcRoot = resolve("/proj/src");
  const stdRoot = resolve("/proj/std");
  const host = createMemoryModuleHost({
    files: {
      [`${stdRoot}${sep}pkg.voyd`]: `
pub use self::common
pub use self::hof
pub use self::maker
pub use std::common::{ Either, Item, Left, Right, View }
pub use std::hof::{ apply }
pub use std::maker::{ make }
`,
      [`${stdRoot}${sep}common.voyd`]: `
pub obj Item { api value: i32 }
pub obj Left<T> { api value: T }
pub obj Right<T> { api value: T }
pub type Either<T> = Left<T> | Right<T>

pub trait View
  region source

  @borrow_contract(returns_from: source)
  fn get(self) -> borrow Item
`,
      [`${stdRoot}${sep}maker.voyd`]: `
use std::common::{ Item, View }

obj LeftState { source: Item }

impl View for LeftState
  region source = deref(self.source)

  fn get(self) -> borrow Item
    self.source

pub fn make() -> View
  LeftState { source: Item { value: 1 } }
`,
      [`${stdRoot}${sep}hof.voyd`]: `
use std::common::{ Either, Item, Left, Right, View }

obj RightState { source: Item }

impl View for RightState
  region source = deref(self.source)

  fn get(self) -> borrow Item
    self.source

pub fn apply(factory: fn() -> View) -> Either<View>
  if true then:
    Left<View> { value: factory() }
  else:
    Right<View> {
      value: RightState { source: Item { value: 2 } }
    }
`,
      [`${srcRoot}${sep}main.voyd`]: `
use std::all

obj FallbackState { source: Item }

impl View for FallbackState
  region source = deref(self.source)

  fn get(self) -> borrow Item
    self.source

pub fn pass() -> View
  match(apply(make))
    Left<View> { value }: value
    Right<View>: FallbackState {
      source: Item { value: 3 }
    }

pub fn main() -> i32
  pass().get().value
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
  const maker = analyzed.semantics.get("std::maker");
  const hof = analyzed.semantics.get("std::hof");
  const main = analyzed.semantics.get("src::main");
  const passExport = Array.from(main?.exports.values() ?? []).find(
    (entry) => entry.name === "pass",
  );

  expect([...graph.diagnostics, ...analyzed.diagnostics]).toEqual([]);
  expect(
    passExport?.borrowingCoercions
      ?.map((coercion) =>
        coercion.concrete.moduleId === "std::maker"
          ? maker?.symbols.getName(coercion.concrete.symbol)
          : coercion.concrete.moduleId === "std::hof"
            ? hof?.symbols.getName(coercion.concrete.symbol)
            : main?.symbols.getName(coercion.concrete.symbol),
      )
      .sort(),
  ).toEqual(["FallbackState", "LeftState"]);
});

it("composes callback provenance through a forwarding lambda", async () => {
  const srcRoot = resolve("/proj/src");
  const stdRoot = resolve("/proj/std");
  const host = createMemoryModuleHost({
    files: {
      [`${stdRoot}${sep}pkg.voyd`]: `
pub use self::common
pub use self::hof
pub use self::maker
pub use std::common::{ Item, View }
pub use std::hof::{
  apply,
  identity,
  identity_default,
  identity_imported_default,
  identity_nested_default
}
`,
      [`${stdRoot}${sep}common.voyd`]: `
pub obj Item { api value: i32 }

pub trait View
  region source

  @borrow_contract(returns_from: source)
  fn get(self) -> borrow Item
`,
      [`${stdRoot}${sep}maker.voyd`]: `
use std::common::{ Item, View }

obj ImportedDefaultState { source: Item }

impl View for ImportedDefaultState
  region source = deref(self.source)

  fn get(self) -> borrow Item
    self.source

pub fn create() -> View
  ImportedDefaultState { source: Item { value: 6 } }
`,
      [`${stdRoot}${sep}hof.voyd`]: `
use std::common::{ Item, View }
use std::maker::{ create }

obj DefaultState { source: Item }

impl View for DefaultState
  region source = deref(self.source)

  fn get(self) -> borrow Item
    self.source

pub fn apply(factory: fn() -> View) -> View
  factory()

pub fn identity(factory: fn() -> View) -> (fn() : () -> View)
  factory

pub fn identity_default(
  factory: fn() -> View = () => DefaultState {
    source: Item { value: 5 }
  }
) -> (fn() : () -> View)
  factory

pub fn identity_imported_default(
  factory: fn() -> View = create
) -> (fn() : () -> View)
  factory

pub fn identity_nested_default(
  factory: fn() -> View = identity_imported_default()
) -> (fn() : () -> View)
  factory
`,
      [`${srcRoot}${sep}main.voyd`]: `
use std::all

obj State { source: Item }
obj Wrapper { view: View }

impl View for State
  region source = deref(self.source)

  fn get(self) -> borrow Item
    self.source

pub fn relay(factory: fn() -> View) -> View
  apply(() => factory())

pub fn relay_local(factory: fn() -> View) -> View
  let adapter = () => factory()
  adapter()

pub fn relay_wrapped(factory: fn() -> View) -> View
  let adapter = () => Wrapper { view: factory() }
  adapter().view

pub fn pass(owner: Item) -> View
  relay(() => State { source: owner })

pub fn pass_local(owner: Item) -> View
  relay_local(() => State { source: owner })

pub fn pass_wrapped(owner: Item) -> View
  relay_wrapped(() => State { source: owner })

pub fn pass_returned(owner: Item) -> View
  let factory = identity(() => State { source: owner })
  factory()

pub fn pass_returned_default() -> View
  let factory = identity_default()
  factory()

pub fn pass_returned_imported_default() -> View
  let factory = identity_imported_default()
  factory()

pub fn pass_returned_nested_default() -> View
  let factory = identity_nested_default()
  factory()

pub fn pass_returned_to_hof() -> View
  apply(identity_default())

pub fn pass_returned_explicit_to_hof(owner: Item) -> View
  apply(identity(() => State { source: owner }))

pub fn main() -> i32
  pass(Item { value: 1 }).get().value +
    pass_local(Item { value: 2 }).get().value +
    pass_wrapped(Item { value: 3 }).get().value +
    pass_returned(Item { value: 4 }).get().value +
    pass_returned_default().get().value +
    pass_returned_imported_default().get().value +
    pass_returned_nested_default().get().value +
    pass_returned_to_hof().get().value +
    pass_returned_explicit_to_hof(Item { value: 7 }).get().value
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
  const hof = analyzed.semantics.get("std::hof");
  const maker = analyzed.semantics.get("std::maker");
  const main = analyzed.semantics.get("src::main");
  const relayExport = Array.from(main?.exports.values() ?? []).find(
    (entry) => entry.name === "relay",
  );
  const relayLocalExport = Array.from(main?.exports.values() ?? []).find(
    (entry) => entry.name === "relay_local",
  );
  const relayWrappedExport = Array.from(main?.exports.values() ?? []).find(
    (entry) => entry.name === "relay_wrapped",
  );
  const passExport = Array.from(main?.exports.values() ?? []).find(
    (entry) => entry.name === "pass",
  );
  const passLocalExport = Array.from(main?.exports.values() ?? []).find(
    (entry) => entry.name === "pass_local",
  );
  const passWrappedExport = Array.from(main?.exports.values() ?? []).find(
    (entry) => entry.name === "pass_wrapped",
  );
  const passReturnedExport = Array.from(main?.exports.values() ?? []).find(
    (entry) => entry.name === "pass_returned",
  );
  const passReturnedDefaultExport = Array.from(
    main?.exports.values() ?? [],
  ).find((entry) => entry.name === "pass_returned_default");
  const passReturnedImportedDefaultExport = Array.from(
    main?.exports.values() ?? [],
  ).find((entry) => entry.name === "pass_returned_imported_default");
  const passReturnedNestedDefaultExport = Array.from(
    main?.exports.values() ?? [],
  ).find((entry) => entry.name === "pass_returned_nested_default");
  const passReturnedToHofExport = Array.from(main?.exports.values() ?? []).find(
    (entry) => entry.name === "pass_returned_to_hof",
  );
  const passReturnedExplicitToHofExport = Array.from(
    main?.exports.values() ?? [],
  ).find((entry) => entry.name === "pass_returned_explicit_to_hof");

  expect([...graph.diagnostics, ...analyzed.diagnostics]).toEqual([]);
  expect(
    relayExport?.borrowing?.[0]?.contract.callableResultInvocations,
  ).toEqual([
    {
      parameter: 0,
      source: [],
      callbackResult: [],
      result: [],
    },
  ]);
  expect(
    relayLocalExport?.borrowing?.[0]?.contract.callableResultInvocations,
  ).toEqual([
    {
      parameter: 0,
      source: [],
      callbackResult: [],
      result: [],
    },
  ]);
  expect(
    relayWrappedExport?.borrowing?.[0]?.contract.callableResultInvocations,
  ).toEqual([
    {
      parameter: 0,
      source: [],
      callbackResult: [],
      result: [],
    },
  ]);
  expect(
    passExport?.borrowingCoercions?.map((coercion) =>
      main?.symbols.getName(coercion.concrete.symbol),
    ),
  ).toEqual(["State"]);
  expect(
    passLocalExport?.borrowingCoercions?.map((coercion) =>
      main?.symbols.getName(coercion.concrete.symbol),
    ),
  ).toEqual(["State"]);
  expect(
    passWrappedExport?.borrowingCoercions?.map((coercion) =>
      main?.symbols.getName(coercion.concrete.symbol),
    ),
  ).toEqual(["State"]);
  expect(
    passReturnedExport?.borrowingCoercions?.map((coercion) =>
      main?.symbols.getName(coercion.concrete.symbol),
    ),
  ).toEqual(["State"]);
  expect(
    passReturnedDefaultExport?.borrowingCoercions?.map((coercion) =>
      hof?.symbols.getName(coercion.concrete.symbol),
    ),
  ).toEqual(["DefaultState"]);
  expect(
    passReturnedImportedDefaultExport?.borrowingCoercions?.map((coercion) =>
      maker?.symbols.getName(coercion.concrete.symbol),
    ),
  ).toEqual(["ImportedDefaultState"]);
  expect(
    passReturnedNestedDefaultExport?.borrowingCoercions?.map((coercion) =>
      maker?.symbols.getName(coercion.concrete.symbol),
    ),
  ).toEqual(["ImportedDefaultState"]);
  expect(
    passReturnedToHofExport?.borrowingCoercions?.map((coercion) =>
      hof?.symbols.getName(coercion.concrete.symbol),
    ),
  ).toEqual(["DefaultState"]);
  expect(
    passReturnedExplicitToHofExport?.borrowingCoercions?.map((coercion) =>
      main?.symbols.getName(coercion.concrete.symbol),
    ),
  ).toEqual(["State"]);
});

it("widens private trait exposure reached through recursive result paths", async () => {
  const srcRoot = resolve("/proj/src");
  const stdRoot = resolve("/proj/std");
  const host = createMemoryModuleHost({
    files: {
      [`${stdRoot}${sep}pkg.voyd`]: `
pub use self::tree
pub use std::tree::{ Item, Node, None, Optional, Some, View, create }
`,
      [`${stdRoot}${sep}tree.voyd`]: `
pub obj Item { api value: i32 }

pub trait View
  region source

  @borrow_contract(returns_from: source)
  fn get(self) -> borrow Item

pub obj Some<T> { api value: T }
pub obj None {}
pub type Optional<T> = Some<T> | None

pub obj Node {
  api next?: Node,
  api view: View
}

obj State { source: Item }

impl View for State
  region source = deref(self.source)

  fn get(self) -> borrow Item
    self.source

pub fn create() -> Node
  let ~node = Node {
    view: State { source: Item { value: 9 } }
  }
  node.next = Some<Node> { value: node }
  node
`,
      [`${srcRoot}${sep}main.voyd`]: `
use std::all

pub fn extract(fallback: View) -> View
  match(create().next)
    Some<Node> { value }:
      match(value.next)
        Some<Node> { value: second }:
          second.view
        None:
          fallback
    None:
      fallback

pub fn main() -> i32
  extract(create().view).get().value
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
  const tree = analyzed.semantics.get("std::tree");
  const createExport = Array.from(tree?.exports.values() ?? []).find(
    (entry) => entry.name === "create",
  );
  const main = analyzed.semantics.get("src::main");
  const extractExport = Array.from(main?.exports.values() ?? []).find(
    (entry) => entry.name === "extract",
  );

  expect([...graph.diagnostics, ...analyzed.diagnostics]).toEqual([]);
  expect(createExport?.borrowingCoercions).toHaveLength(1);
  expect(createExport?.borrowingCoercions?.[0]?.concrete.moduleId).toBe(
    "std::tree",
  );
  expect(createExport?.borrowingCoercions?.[0]?.resultPaths).toBeUndefined();
  expect(createExport?.borrowingCoercions?.[0]?.resultType).toBeUndefined();
  expect(
    extractExport?.borrowingCoercions?.map((coercion) =>
      tree?.symbols.getName(coercion.concrete.symbol),
    ),
  ).toEqual(["State"]);
});

it("keeps acyclic values of recursive types projection precise", async () => {
  const srcRoot = resolve("/proj/src");
  const stdRoot = resolve("/proj/std");
  const host = createMemoryModuleHost({
    files: {
      [`${stdRoot}${sep}pkg.voyd`]: `
pub use self::tree
pub use std::tree::{
  Holder,
  Item,
  Node,
  View,
  create,
  create_alias,
  create_after_cycle_overwrite,
  create_equal_projection,
  create_from_consumed_old,
  create_wrapped_projection
}
`,
      [`${stdRoot}${sep}tree.voyd`]: `
pub obj Item { api value: i32 }
pub obj Some<T> { api value: T }
pub obj None {}
pub type Optional<T> = Some<T> | None

pub trait View
  region source

  @borrow_contract(returns_from: source)
  fn get(self) -> borrow Item

pub obj Node {
  api next?: Node,
  api selected: View,
  api unused: View,
  api other: View
}

pub obj Holder { api node: Node }

obj SelectedState { source: Item }
obj UnusedState { source: Item }
obj OtherState { source: Item }

impl View for SelectedState
  region source = deref(self.source)

  fn get(self) -> borrow Item
    self.source

impl View for UnusedState
  region source = deref(self.source)

  fn get(self) -> borrow Item
    self.source

impl View for OtherState
  region source = deref(self.source)

  fn get(self) -> borrow Item
    self.source

pub fn create() -> Node
  Node {
    selected: SelectedState { source: Item { value: 1 } },
    unused: UnusedState { source: Item { value: 2 } },
    other: OtherState { source: Item { value: 3 } }
  }

pub fn create_alias() -> Node
  let ~node = create()
  node.selected = node.unused
  node

fn fresh_from(previous: Node) -> Node
  let _ = previous.selected
  create()

pub fn create_from_consumed_old() -> Node
  let ~node = create_alias()
  node = fresh_from(node)
  node

pub fn create_after_cycle_overwrite() -> Node
  let ~node = create_alias()
  node.next = Some<Node> { value: node }
  node = create()
  node

pub fn create_equal_projection() -> Holder
  let ~holder = Holder { node: create() }
  holder.node = holder.node
  holder

pub fn create_wrapped_projection() -> Holder
  let ~holder = Holder { node: create() }
  holder.node = Node {
    next: holder.node.next,
    selected: holder.node.selected,
    unused: holder.node.unused,
    other: holder.node.other
  }
  holder
`,
      [`${srcRoot}${sep}main.voyd`]: `
use std::all

pub fn selected() -> View
  create().selected

pub fn selected_alias() -> View
  create_alias().selected

pub fn selected_from_consumed_old() -> View
  create_from_consumed_old().selected

pub fn selected_after_cycle_overwrite() -> View
  create_after_cycle_overwrite().selected

pub fn selected_equal_projection() -> View
  create_equal_projection().node.selected

pub fn selected_wrapped_projection() -> View
  create_wrapped_projection().node.selected
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
  const tree = analyzed.semantics.get("std::tree");
  const main = analyzed.semantics.get("src::main");
  const selectedExport = Array.from(main?.exports.values() ?? []).find(
    (entry) => entry.name === "selected",
  );
  const selectedAliasExport = Array.from(main?.exports.values() ?? []).find(
    (entry) => entry.name === "selected_alias",
  );
  const selectedFromConsumedOldExport = Array.from(
    main?.exports.values() ?? [],
  ).find((entry) => entry.name === "selected_from_consumed_old");
  const selectedAfterCycleOverwriteExport = Array.from(
    main?.exports.values() ?? [],
  ).find((entry) => entry.name === "selected_after_cycle_overwrite");
  const selectedEqualProjectionExport = Array.from(
    main?.exports.values() ?? [],
  ).find((entry) => entry.name === "selected_equal_projection");
  const selectedWrappedProjectionExport = Array.from(
    main?.exports.values() ?? [],
  ).find((entry) => entry.name === "selected_wrapped_projection");

  expect([...graph.diagnostics, ...analyzed.diagnostics]).toEqual([]);
  expect(
    selectedExport?.borrowingCoercions?.map((coercion) =>
      tree?.symbols.getName(coercion.concrete.symbol),
    ),
  ).toEqual(["SelectedState"]);
  expect(
    selectedAliasExport?.borrowingCoercions?.map((coercion) =>
      tree?.symbols.getName(coercion.concrete.symbol),
    ),
  ).toEqual(["UnusedState"]);
  expect(
    selectedFromConsumedOldExport?.borrowingCoercions?.map((coercion) =>
      tree?.symbols.getName(coercion.concrete.symbol),
    ),
  ).toEqual(["SelectedState"]);
  expect(
    selectedAfterCycleOverwriteExport?.borrowingCoercions?.map((coercion) =>
      tree?.symbols.getName(coercion.concrete.symbol),
    ),
  ).toEqual(["SelectedState"]);
  expect(
    selectedEqualProjectionExport?.borrowingCoercions?.map((coercion) =>
      tree?.symbols.getName(coercion.concrete.symbol),
    ),
  ).toEqual(["SelectedState"]);
  expect(
    selectedWrappedProjectionExport?.borrowingCoercions?.map((coercion) =>
      tree?.symbols.getName(coercion.concrete.symbol),
    ),
  ).toEqual(["SelectedState"]);
});
