import { describe, expect, it } from "vitest";
import { resolve, sep } from "node:path";
import { getWasmInstance } from "@voyd-lang/lib/wasm.js";
import { createCompilerDependencySnapshotCache } from "../modules/dependency-snapshot-cache.js";
import { createMemoryModuleHost } from "../modules/memory-host.js";
import { createNodePathAdapter } from "../modules/node-path-adapter.js";
import type { ModuleHost } from "../modules/types.js";
import { compileProgram, type CompileProgramResult } from "../pipeline.js";
import { monomorphizeProgram } from "../semantics/linking.js";
import { symbolRefKey } from "../semantics/typing/symbol-ref-utils.js";

const createMemoryHost = (files: Record<string, string>): ModuleHost =>
  createMemoryModuleHost({ files, pathAdapter: createNodePathAdapter() });

const expectCompileSuccess = (
  result: CompileProgramResult,
): Extract<CompileProgramResult, { success: true }> => {
  if (!result.success) {
    throw new Error(JSON.stringify(result.diagnostics, null, 2));
  }
  expect(result.success).toBe(true);
  return result;
};

describe("module codegen", () => {
  it.each([
    ["imported effect then all", "use src::effects::Store\nuse Store::all"],
    ["qualified all", "use src::effects::Store::all"],
    ["grouped qualified all", "use src::effects::{ Store::all }"],
    ["grouped selective operation", "use src::effects::{ Store::{ save } }"],
    ["qualified selective operation", "use src::effects::Store::{ save }"],
  ])(
    "executes an unqualified effect operation through %s",
    async (_name, useDecl) => {
      const root = resolve("/proj/src");
      const host = createMemoryHost({
        [`${root}${sep}main.voyd`]: `${useDecl}

pub fn main() -> i32
  try
    save(41)
  save(tail, value):
    tail(value + 1)
`,
        [`${root}${sep}effects.voyd`]: `pub eff Store
  save(tail, value: i32) -> i32
  load(tail, value: i32) -> i32
`,
      });

      const result = expectCompileSuccess(
        await compileProgram({
          entryPath: `${root}${sep}main.voyd`,
          roots: { src: root },
          host,
        }),
      );
      const instance = getWasmInstance(result.wasm!);
      expect((instance.exports.main as () => number)()).toBe(42);
    },
  );

  it("uses a local effect operation alias in calls and handler heads", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `eff Store
  save(tail, value: i32) -> i32

use Store::save as persist

pub fn main() -> i32
  try
    persist(41)
  persist(tail, value):
    tail(value + 1)
`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: `${root}${sep}main.voyd`,
        roots: { src: root },
        host,
      }),
    );
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(42);
  });

  it("keeps module wrappers and effect operations in distinct qualified namespaces", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `use src::effects
use src::effects::Store
use src::effects::Store as Files

pub fn main() -> i32
  try
    let wrapper = effects::save(1)
    let effect_value = Files::save(40)
    wrapper + effect_value
  Store::save(tail, value):
    tail(value + 1)
`,
      [`${root}${sep}effects.voyd`]: `pub eff Store
  save(tail, value: i32) -> i32

pub fn save(value: i32) -> i32
  value + 100
`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: `${root}${sep}main.voyd`,
        roots: { src: root },
        host,
      }),
    );
    const main = result.semantics?.get("src::main");
    const qualifiedCall = Array.from(main?.hir.expressions.values() ?? []).find(
      (expression) =>
        expression.exprKind === "call" && expression.effectOperation,
    );
    const handler = Array.from(main?.hir.expressions.values() ?? []).find(
      (expression) => expression.exprKind === "effect-handler",
    );
    expect(qualifiedCall?.exprKind).toBe("call");
    expect(handler?.exprKind).toBe("effect-handler");
    if (
      qualifiedCall?.exprKind === "call" &&
      handler?.exprKind === "effect-handler"
    ) {
      expect(qualifiedCall.effectOperation?.operation).toBe(
        handler.handlers[0]?.operation,
      );
      expect(qualifiedCall.effectOperation?.effect).toBe(
        handler.handlers[0]?.effect,
      );
    }

    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(142);
  });

  it("registers qualified handler operations without perform sites", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `eff Action
  unused(resume) -> i32
  used(resume) -> i32

pub fn main() -> i32
  try
    Action::used()
  Action::unused(resume):
    resume(0)
  Action::used(resume):
    resume(42)
`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: `${root}${sep}main.voyd`,
        roots: { src: root },
        host,
      }),
    );
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(42);
  });

  it("prefers a selected external operation over an unselected local handler operation", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}effects.voyd`]: `pub eff External
  save(tail, value: i32) -> i32
`,
      [`${root}${sep}main.voyd`]: `use src::effects::External::{ save }

eff Local
  save(tail, value: i32) -> i32

pub fn main() -> i32
  try
    save(41)
  save(tail, value):
    tail(value + 1)
`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: `${root}${sep}main.voyd`,
        roots: { src: root },
        host,
      }),
    );
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(42);
  });

  it("links imported functions across modules and exports only entry functions", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `use src::util::math::all

pub fn main() -> i32
  add(10, sub(5, 2))

pub fn delta() -> i32
  sub(8, 3)`,
      [`${root}${sep}util.voyd`]:
        "pub use self::math::all\npub use self::ops::all",
      [`${root}${sep}util${sep}math.voyd`]: "pub use super::ops::math::all",
      [`${root}${sep}util${sep}ops.voyd`]: "pub use self::math::all",
      [`${root}${sep}util${sep}ops${sep}math.voyd`]: `pub fn add(a: i32, b: i32) -> i32
  a + b

pub fn sub(a: i32, b: i32) -> i32
  a - b`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: `${root}${sep}main.voyd`,
        roots: { src: root },
        host,
      }),
    );

    expect(result.wasm).toBeInstanceOf(Uint8Array);
    const instance = getWasmInstance(result.wasm!);
    const exports = instance.exports;
    const exportedFunctions = Object.entries(exports)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();

    expect(exportedFunctions).toEqual(["delta", "main"]);
    expect((exports.main as () => number)()).toBe(13);
    expect((exports.delta as () => number)()).toBe(5);
  });

  it("runs package identity guards after dependency snapshot reuse", async () => {
    const root = resolve("/imported-default-guard/src");
    const packages = resolve("/imported-default-guard/packages");
    const mainPath = `${root}${sep}main.voyd`;
    const files = {
      [mainPath]: `#!no_prelude
use pkg::guarded::all

fn guarded(~left: Box, ~right: Box) -> i32
  mutate_both(~left, ~right)

fn relay(value: Box) -> Box
  value

obj Holder { value: Box }

pub fn distinct() -> i32
  let ~left = Box { value: 1 }
  let ~right = Box { value: 10 }
  guarded(~left, ~right)

pub fn direct_distinct() -> i32
  let ~left = Box { value: 1 }
  let ~right = Box { value: 10 }
  mutate_both(~left, ~right)

pub fn overlapping() -> i32
  let ~left = Box { value: 1 }
  let ~right = Box { value: 10 }
  right = left
  guarded(~left, ~right)

pub fn direct_overlapping() -> i32
  let ~left = Box { value: 1 }
  let ~right = Box { value: 10 }
  right = left
  mutate_both(~left, ~right)

pub fn direct_initial_alias() -> i32
  let ~left = Box { value: 1 }
  var right = left
  mutate_both(~left, ~right)

pub fn relay_alias() -> i32
  let ~left = Box { value: 1 }
  let alias = relay(left)
  mutate_both(~left, ~alias)

pub fn holder_alias() -> i32
  let ~left = Box { value: 1 }
  let holder = Holder { value: left }
  mutate_both(~left, ~holder.value)

pub fn holder_write_alias() -> i32
  let ~left = Box { value: 1 }
  let ~holder = Holder { value: Box { value: 10 } }
  holder.value = left
  mutate_both(~left, ~holder.value)

pub fn tuple_alias() -> i32
  let ~left = Box { value: 1 }
  let pair = (left, Box { value: 10 })
  mutate_both(~left, ~pair.0)

pub fn branch_alias() -> i32
  let ~left = Box { value: 1 }
  let ~right = Box { value: 10 }
  let alias = if true then: left else: right
  mutate_both(~left, ~alias)
`,
      [`${packages}${sep}guarded${sep}src${sep}pkg.voyd`]: `#!no_prelude
pub use src::mutate::all
`,
      [`${packages}${sep}guarded${sep}src${sep}mutate.voyd`]: `#!no_prelude
pub obj Box { api value: i32 }

pub fn mutate_both(
  ~left: Box,
  ~right: Box,
  increment: i32 = 2
) -> i32
  left.value = left.value + increment
  right.value = right.value + increment
  left.value + right.value
`,
    };
    const dependencySnapshotCache = createCompilerDependencySnapshotCache();
    const first = expectCompileSuccess(
      await compileProgram({
        entryPath: mainPath,
        roots: { src: root, pkgDirs: [packages] },
        host: createMemoryHost(files),
        dependencySnapshotCache,
      }),
    );
    const firstPackageInterface = first.semantics?.get("pkg:guarded::mutate")
      ?.exports.packageSemanticInterface;
    const firstDeclaration = firstPackageInterface?.exports.find(
      (entry) => entry.name === "mutate_both",
    )?.declarations[0];
    expect(firstDeclaration?.ordinaryMutationSummaryId).toBeDefined();
    expect(firstDeclaration?.defaultIdentityGuardProtocol).toBe(
      "presence-conflict-bit-v1",
    );
    expect(Object.keys(firstDeclaration ?? {}).sort()).toEqual([
      "defaultIdentityGuardProtocol",
      "key",
      "ordinaryMutationSummaryId",
      "signature",
      "value",
    ]);
    expect(firstDeclaration).not.toHaveProperty("borrowContract");
    expect(firstPackageInterface).not.toHaveProperty("borrowContracts");
    expect(JSON.stringify(firstPackageInterface)).not.toContain(
      "borrow_contract",
    );
    const firstInstance = getWasmInstance(first.wasm!);
    expect((firstInstance.exports.distinct as () => number)()).toBe(15);
    expect((firstInstance.exports.direct_distinct as () => number)()).toBe(15);
    expect(
      first.semantics?.get("src::main")?.borrowing.runtimeIdentityGuards.size,
    ).toBeGreaterThan(0);
    expect(() =>
      (firstInstance.exports.overlapping as () => number)(),
    ).toThrow();
    expect(() =>
      (firstInstance.exports.direct_overlapping as () => number)(),
    ).toThrow();
    expect(() =>
      (firstInstance.exports.direct_initial_alias as () => number)(),
    ).toThrow();
    [
      "relay_alias",
      "holder_alias",
      "holder_write_alias",
      "tuple_alias",
      "branch_alias",
    ].forEach((name) =>
      expect(() => (firstInstance.exports[name] as () => number)()).toThrow(),
    );
    const dependencySnapshot = dependencySnapshotCache.dependency;
    expect(dependencySnapshot).toBeDefined();

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: mainPath,
        roots: { src: root, pkgDirs: [packages] },
        host: createMemoryHost({
          ...files,
          [mainPath]: `${files[mainPath]}\nfn edit_marker() -> i32\n  0\n`,
        }),
        dependencySnapshotCache,
      }),
    );
    const instance = getWasmInstance(result.wasm!);

    expect((instance.exports.distinct as () => number)()).toBe(15);
    expect((instance.exports.direct_distinct as () => number)()).toBe(15);
    expect(() => (instance.exports.overlapping as () => number)()).toThrow();
    expect(() =>
      (instance.exports.direct_overlapping as () => number)(),
    ).toThrow();
    expect(() =>
      (instance.exports.direct_initial_alias as () => number)(),
    ).toThrow();
    [
      "relay_alias",
      "holder_alias",
      "holder_write_alias",
      "tuple_alias",
      "branch_alias",
    ].forEach((name) =>
      expect(() => (instance.exports[name] as () => number)()).toThrow(),
    );
    expect(dependencySnapshotCache.dependency).toBe(dependencySnapshot);

    const packageInterface = result.semantics?.get("pkg:guarded::mutate")
      ?.exports.packageSemanticInterface;
    const declaration = packageInterface?.exports.find(
      (entry) => entry.name === "mutate_both",
    )?.declarations[0];
    expect(declaration?.defaultIdentityGuardProtocol).toBe(
      "presence-conflict-bit-v1",
    );
    expect(declaration).not.toHaveProperty("borrowContract");
    expect(packageInterface).not.toHaveProperty("borrowContracts");
    expect(JSON.stringify(packageInterface)).not.toContain("borrow_contract");
  });

  it("supports dot calls to imported instance methods without importing the member", async () => {
    const root = resolve("/proj/src");
    const std = resolve("/proj/std");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `use std::{ Box }

pub fn main() -> i32
  Box { value: 7 }.get()
`,
      [`${std}${sep}pkg.voyd`]: "pub use std::box::{ Box }",
      [`${std}${sep}box.voyd`]: `pub obj Box {
  api value: i32
}

impl Box
  api fn get(self) -> i32
    self.value
`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: `${root}${sep}main.voyd`,
        roots: { src: root, std },
        host,
      }),
    );

    expect(result.wasm).toBeInstanceOf(Uint8Array);
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(7);
  });

  it("runs trait dispatch for imported upcasts through package re-exports", async () => {
    const root = resolve("/proj/src");
    const std = resolve("/proj/std");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `use std::all

fn consume(~seq: Sequence) -> i32
  seq.measure()

pub fn main() -> i32
  consume(~make_array(41)) + 1
`,
      [`${std}${sep}pkg.voyd`]: `pub use self::array::{ Array, make_array }
pub use self::traits::sequence::{ Sequence }
`,
      [`${std}${sep}array.voyd`]: `use std::traits::sequence::all

pub obj Array {
  value: i32
}

pub fn make_array(value: i32) -> Array
  Array { value }

impl Sequence for Array
  fn measure(~self) -> i32
    self.value
`,
      [`${std}${sep}traits${sep}sequence.voyd`]: `pub trait Sequence
  fn measure(~self) -> i32
`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: `${root}${sep}main.voyd`,
        roots: { src: root, std },
        host,
      }),
    );

    expect(result.wasm).toBeInstanceOf(Uint8Array);
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(42);
  });

  it("links imported generic instantiations across modules", async () => {
    const root = resolve("/proj/src");
    const std = resolve("/proj/std");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `use std::util::all

pub fn main() -> i32
  id(5)`,
      [`${std}${sep}pkg.voyd`]: "pub use std::util::all",
      [`${std}${sep}util.voyd`]: `pub fn id<T>(value: T): () -> T
  value`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: `${root}${sep}main.voyd`,
        roots: { src: root, std },
        host,
      }),
    );

    expect(result.wasm).toBeInstanceOf(Uint8Array);
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(5);

    const utilSemantics = result.semantics?.get("std::util");
    expect(utilSemantics).toBeDefined();
    if (!utilSemantics) {
      return;
    }
    const idSymbol = utilSemantics.symbols.resolveTopLevel("id");
    expect(typeof idSymbol).toBe("number");
    if (typeof idSymbol !== "number") {
      return;
    }
    const monomorphized = monomorphizeProgram({
      modules: Array.from(result.semantics?.values() ?? []),
      semantics: result.semantics ?? new Map(),
    });
    const instantiations = monomorphized.moduleTyping
      .get("std::util")
      ?.functionInstantiationInfo.get(
        symbolRefKey({ moduleId: utilSemantics.moduleId, symbol: idSymbol }),
      );
    expect(instantiations?.size ?? 0).toBeGreaterThan(0);
  });

  it("uses the instantiated representation for imported generic match payloads", async () => {
    const root = resolve("/proj/src");
    const std = resolve("/proj/std");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `use std::util::all

obj Arguments { left: i32, right: i32 }

pub fn main() -> i32
  match(wrap<Arguments>(Arguments { left: 20, right: 22 }))
    Wrapped<Arguments> { value }:
      value.left + value.right
    Empty:
      0`,
      [`${std}${sep}pkg.voyd`]: "pub use std::util::all",
      [`${std}${sep}util.voyd`]: `pub obj Wrapped<T> { api value: T }
pub obj Empty {}
pub type GenericResult<T> = Wrapped<T> | Empty

pub fn wrap<T>(value: T) -> GenericResult<T>
  Wrapped<T> { value }`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: `${root}${sep}main.voyd`,
        roots: { src: root, std },
        host,
      }),
    );

    expect(result.wasm).toBeInstanceOf(Uint8Array);
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(42);
  });

  it("links multiple imported generic instantiations across modules", async () => {
    const root = resolve("/proj/src");
    const std = resolve("/proj/std");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `use std::util::all

pub fn main() -> i32
  let x = id(1.0)
  id(5)`,
      [`${std}${sep}pkg.voyd`]: "pub use std::util::all",
      [`${std}${sep}util.voyd`]: `pub fn id<T>(value: T): () -> T
  value`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: `${root}${sep}main.voyd`,
        roots: { src: root, std },
        host,
      }),
    );

    expect(result.wasm).toBeInstanceOf(Uint8Array);
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(5);
  });

  it("specializes imported generic match patterns for each caller instance", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `use src::outer::rewrap
use src::result::{ GenericError, GenericOk }

obj Age { age: i32 }
obj Score { score: i32 }

pub fn main() -> i32
  let age = match(rewrap<Age>(Age { age: 20 }))
    GenericOk<Age> { value }:
      value.age
    GenericError:
      0
  let score = match(rewrap<Score>(Score { score: 22 }))
    GenericOk<Score> { value }:
      value.score
    GenericError:
      0
  age + score`,
      [`${root}${sep}outer.voyd`]: `use src::result::{ GenericError, GenericOk, GenericResult, wrap }

pub fn rewrap<T>(value: T) -> GenericResult<T>
  match(wrap<T>(value))
    GenericOk<T> { value }:
      GenericOk<T> { value }
    GenericError:
      GenericError {}`,
      [`${root}${sep}result.voyd`]: `pub obj GenericOk<T> { api value: T }
pub obj GenericError {}
pub type GenericResult<T> = GenericOk<T> | GenericError

pub fn wrap<T>(value: T) -> GenericResult<T>
  GenericOk<T> { value }`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: `${root}${sep}main.voyd`,
        roots: { src: root },
        host,
      }),
    );

    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(42);
  });

  it("runs generic overloads across modules", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `use src::util::assertions::all

pub fn main() -> i32
  let a = assert(5, eq: 5)
  let b = assert(true)
  a + b`,
      [`${root}${sep}util.voyd`]: "pub use self::assertions::all",
      [`${root}${sep}util${sep}assertions.voyd`]: `pub fn assert(cond: boolean) -> i32
  if cond then: 1 else: 0

pub fn assert<T>(value: T, { eq expected: T }) -> i32
  if value == expected then: 1 else: 0

pub fn assert<T>(value: T, { neq expected: T }) -> i32
  if value != expected then: 1 else: 0`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: `${root}${sep}main.voyd`,
        roots: { src: root },
        host,
      }),
    );

    expect(result.wasm).toBeInstanceOf(Uint8Array);
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(2);
  });

  it("supports reassigning structural object fields", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `pub fn main() -> i32
  let ~o = { a: 1 }
  o.a = 3
  o.a`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: `${root}${sep}main.voyd`,
        roots: { src: root },
        host,
      }),
    );

    expect(result.wasm).toBeInstanceOf(Uint8Array);
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(3);
  });

  it("supports reassigning nested structural object fields", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `pub fn main() -> i32
  let ~o = { a: { b: 1 } }
  o.a.b = 3
  o.a.b`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: `${root}${sep}main.voyd`,
        roots: { src: root },
        host,
      }),
    );

    expect(result.wasm).toBeInstanceOf(Uint8Array);
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(3);
  });

  it("runs nominal constructor overloads across modules", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `use src::animal_e2e::Animal

pub fn main() -> i32
  let a = Animal { name: 1 }
  let b = Animal { nombre: 2 }
  let c = Animal(3)
  a.id + b.id + c.id + a.name + b.name + c.name`,
      [`${root}${sep}animal_e2e.voyd`]: `pub obj Animal {
  id: i32,
  name: i32
}

impl Animal
  pub fn init({ name: i32 }) -> Animal
    Animal { id: 0, name }

  pub fn init({ nombre: i32 }) -> Animal
    Animal { id: 1, name: nombre }

  pub fn init(value: i32) -> Animal
    Animal { id: 2, name: value }`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: `${root}${sep}main.voyd`,
        roots: { src: root },
        host,
      }),
    );

    expect(result.wasm).toBeInstanceOf(Uint8Array);
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(9);
  });

  it("reads module-level lets from local scope", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `let base = 40
pub let addend = 2

pub fn main() -> i32
  base + addend`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: `${root}${sep}main.voyd`,
        roots: { src: root },
        host,
      }),
    );

    expect(result.wasm).toBeInstanceOf(Uint8Array);
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(42);
  });

  it("reads imported pub lets across modules", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `use src::constants::all

pub fn main() -> i32
  answer + 1`,
      [`${root}${sep}constants.voyd`]: `pub let answer = 41`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: `${root}${sep}main.voyd`,
        roots: { src: root },
        host,
      }),
    );

    expect(result.wasm).toBeInstanceOf(Uint8Array);
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(42);
  });

  it("supports expression initializers for module-level lets", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `let a = 1

fn foo() -> i32
  7

let b = foo()
let c = if b > 4 then: 4 else: b

pub fn main() -> i32
  a + c`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: `${root}${sep}main.voyd`,
        roots: { src: root },
        host,
      }),
    );

    expect(result.wasm).toBeInstanceOf(Uint8Array);
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(5);
  });

  it("keeps string constructor dependencies reachable for module-let initializers without a prelude new_string export", async () => {
    const root = resolve("/proj/src");
    const std = resolve("/proj/std");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `let greeting = "hello"

pub fn main() -> i32
  1`,
      [`${std}${sep}prelude.voyd`]: `pub std::string::String`,
      [`${std}${sep}string.voyd`]: `pub obj String {}
pub obj FixedArray<T> {}

@intrinsic(name: "__string_new", uses_signature: true)
pub fn new_string(from_bytes: FixedArray<i32>): () -> String
  String {}
`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: `${root}${sep}main.voyd`,
        roots: { src: root, std },
        host,
      }),
    );

    expect(result.wasm).toBeInstanceOf(Uint8Array);
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(1);
  });

  it("keeps array constructor dependencies reachable for module-let initializers without a prelude new_array_unchecked export", async () => {
    const root = resolve("/proj/src");
    const std = resolve("/proj/std");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `let values = [1, 2, 3]

pub fn main() -> i32
  1`,
      [`${std}${sep}prelude.voyd`]: `pub std::array::Array`,
      [`${std}${sep}array.voyd`]: `pub obj FixedArray<T> {}
pub obj Array<T> {
  storage: FixedArray<T>
}

pub fn new_array_unchecked<T>({ from source: FixedArray<T> }) -> Array<T>
  Array<T> { storage: source }
`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: `${root}${sep}main.voyd`,
        roots: { src: root, std },
        host,
      }),
    );

    expect(result.wasm).toBeInstanceOf(Uint8Array);
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(1);
  });

  it("supports module-let initializers that reference imported module lets", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `use src::alpha::all

pub fn main() -> i32
  plus_one`,
      [`${root}${sep}alpha.voyd`]: `use src::zeta::all

pub let plus_one = base + 1`,
      [`${root}${sep}zeta.voyd`]: `pub let base = 41`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: `${root}${sep}main.voyd`,
        roots: { src: root },
        host,
      }),
    );

    expect(result.wasm).toBeInstanceOf(Uint8Array);
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(42);
  });

  it("keeps method call targets reachable from module-let initializers", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `obj Box {
  value: i32
}

impl Box
  fn get(self) -> i32
    self.value

let computed = Box { value: 7 }.get()

pub fn main() -> i32
  computed`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: `${root}${sep}main.voyd`,
        roots: { src: root },
        host,
      }),
    );

    expect(result.wasm).toBeInstanceOf(Uint8Array);
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(7);
  });
});
