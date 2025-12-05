import { describe, expect, it } from "vitest";
import { resolve, dirname, sep } from "node:path";
import {
  analyzeModules,
  compileProgram,
  loadModuleGraph,
  lowerProgram,
} from "../pipeline.js";
import type { ModuleHost } from "../modules/types.js";
import { getWasmInstance } from "@voyd/lib/wasm.js";

const createMemoryHost = (files: Record<string, string>): ModuleHost => {
  const normalized = new Map<string, string>();
  const directories = new Map<string, Set<string>>();

  const ensureDir = (dir: string) => {
    if (!directories.has(dir)) {
      directories.set(dir, new Set());
    }
  };

  const registerPath = (path: string) => {
    const directParent = dirname(path);
    ensureDir(directParent);
    directories.get(directParent)!.add(path);

    let current = directParent;
    while (true) {
      const parent = dirname(current);
      if (parent === current) break;
      ensureDir(parent);
      directories.get(parent)!.add(current);
      current = parent;
    }
  };

  Object.entries(files).forEach(([path, contents]) => {
    const full = resolve(path);
    normalized.set(full, contents);
    registerPath(full);
  });

  const isDirectoryPath = (path: string) =>
    directories.has(path) && !normalized.has(path);

  return {
    readFile: async (path: string) => {
      const resolved = resolve(path);
      const file = normalized.get(resolved);
      if (file === undefined) {
        throw new Error(`File not found: ${resolved}`);
      }
      return file;
    },
    readDir: async (path: string) => {
      const resolved = resolve(path);
      return Array.from(directories.get(resolved) ?? []);
    },
    fileExists: async (path: string) => normalized.has(resolve(path)),
    isDirectory: async (path: string) => isDirectoryPath(resolve(path)),
  };
};

describe("next pipeline API", () => {
  it("compiles a program from the module graph through codegen", async () => {
    const root = resolve("/proj/src");
    const std = resolve("/proj/std");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: "pub fn main() 1",
      [`${std}${sep}math.voyd`]: "pub fn add(a: i32, b: i32) a",
    });

    const result = await compileProgram({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root, std },
      host,
    });

    expect(result.diagnostics).toHaveLength(0);
    expect(result.wasm?.length ?? 0).toBeGreaterThan(0);
    expect(result.semantics?.has("src::main")).toBe(true);
  });

  it("orders modules topologically for lowering", async () => {
    const root = resolve("/proj/src");
    const std = resolve("/proj/std");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: "pub fn main() 1",
      [`${std}${sep}math.voyd`]: "pub fn add(a: i32, b: i32) a",
    });

    const graph = await loadModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root, std },
      host,
    });
    const { semantics } = analyzeModules({ graph });
    const { orderedModules, entry } = lowerProgram({ graph, semantics });

    expect(entry).toBe("src::main");
    expect(orderedModules).toEqual(["src::main"]);
  });

  it("exports only pkg.voyd public API entries to wasm", async () => {
    const root = resolve("/proj/src");
    const pkgPath = `${root}${sep}pkg.voyd`;
    const apiPath = `${root}${sep}api.voyd`;
    const host = createMemoryHost({
      [pkgPath]: `
use src::api::all

pub use src::api::public_fn
`,
      [apiPath]: `
pub fn public_fn() -> i32
  7

pub fn internal_fn() -> i32
  3
`,
    });

    const result = await compileProgram({
      entryPath: pkgPath,
      roots: { src: root },
      host,
    });

    expect(result.diagnostics).toHaveLength(0);
    expect(result.wasm).toBeInstanceOf(Uint8Array);

    const instance = getWasmInstance(result.wasm!);
    const exports = instance.exports as Record<string, unknown>;

    expect(typeof exports.public_fn).toBe("function");
    expect((exports.public_fn as () => number)()).toBe(7);
    expect(exports.internal_fn).toBeUndefined();
  });

  it("rejects accessing pri fields outside their object", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
pub obj SecretBox {
  pri value: i32,
}

impl SecretBox
  pub fn reveal(self) -> i32
    self.value

pub fn leak(box: SecretBox) -> i32
  box.value
`,
    });

    const result = await compileProgram({
      entryPath: mainPath,
      roots: { src: root },
      host,
    });

    expect(result.wasm).toBeUndefined();
    expect(result.diagnostics.some((diag) => diag.code === "TY0009")).toBe(
      true
    );
  });

  it("exposes only api members to other packages", async () => {
    const appRoot = resolve("/proj/app");
    const packagesRoot = resolve("/proj/pkg");
    const depRoot = `${packagesRoot}${sep}dep`;
    const mainPath = `${appRoot}${sep}main.voyd`;
    const depPkgPath = `${depRoot}${sep}pkg.voyd`;
    const depExternalPath = `${depRoot}${sep}src${sep}external.voyd`;

    const host = createMemoryHost({
      [mainPath]: `
use pkg::dep::all

pub fn main() -> i32
  let ext = make_external()
  ext.visible + ext.expose()
`,
      [depPkgPath]: `
use src::external::all

pub use src::external::External
pub use src::external::make_external
`,
      [depExternalPath]: `
pub obj External {
  api visible: i32,
  hidden: i32,
  pri secret: i32,
}

impl External
  api fn expose(self) -> i32
    self.visible + self.hidden

  fn hidden_value(self) -> i32
    self.hidden

  pri fn secret_value(self) -> i32
    self.secret

pub fn make_external() -> External
  External { visible: 2, hidden: 3, secret: 5 }
`,
    });

    const result = await compileProgram({
      entryPath: mainPath,
      roots: { src: appRoot, pkg: packagesRoot },
      host,
    });

    expect(result.diagnostics).toHaveLength(0);
    expect(result.wasm).toBeInstanceOf(Uint8Array);

    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(7);
  });

  it("blocks external access to non-api members", async () => {
    const appRoot = resolve("/proj/app");
    const packagesRoot = resolve("/proj/pkg");
    const depRoot = `${packagesRoot}${sep}dep`;
    const mainPath = `${appRoot}${sep}leak.voyd`;
    const depPkgPath = `${depRoot}${sep}pkg.voyd`;
    const depExternalPath = `${depRoot}${sep}src${sep}external.voyd`;

    const host = createMemoryHost({
      [mainPath]: `
use pkg::dep::all

pub fn leak_hidden() -> i32
  make_external().hidden
`,
      [depPkgPath]: `
use src::external::all

pub use src::external::External
pub use src::external::make_external
`,
      [depExternalPath]: `
pub obj External {
  api visible: i32,
  hidden: i32,
  pri secret: i32,
}

impl External
  api fn expose(self) -> i32
    self.visible + self.hidden

  fn hidden_value(self) -> i32
    self.hidden

  pri fn secret_value(self) -> i32
    self.secret

pub fn make_external() -> External
  External { visible: 2, hidden: 3, secret: 5 }
`,
    });

    const result = await compileProgram({
      entryPath: mainPath,
      roots: { src: appRoot, pkg: packagesRoot },
      host,
    });

    expect(result.wasm).toBeUndefined();
    expect(result.diagnostics.some((diag) => diag.code === "TY0009")).toBe(
      true
    );
  });
});
