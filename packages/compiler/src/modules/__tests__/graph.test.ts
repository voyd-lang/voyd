import { describe, expect, it } from "vitest";
import { buildModuleGraph } from "../graph.js";
import type { ModuleHost } from "../types.js";
import { dirname, resolve, sep } from "node:path";

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

describe("buildModuleGraph", () => {
  it("loads dependencies via use statements and auto-discovers submodules", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: "use internal",
      [`${root}${sep}internal.voyd`]: "pub mod hey",
      [`${root}${sep}internal${sep}hey.voyd`]: "pub fn hey()\n  1",
    });

    const graph = await buildModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      host,
      roots: { src: root },
    });

    expect(graph.diagnostics).toHaveLength(0);
    expect(Array.from(graph.modules.keys())).toEqual(
      expect.arrayContaining([
        "src::main",
        "src::internal",
        "src::internal::hey",
      ])
    );
  });

  it("resolves sibling modules relative to the parent module", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}server.voyd`]: "",
      [`${root}${sep}server${sep}api.voyd`]: "use users::get_user",
      [`${root}${sep}server${sep}users${sep}get_user.voyd`]:
        "use server::fetch",
      [`${root}${sep}server${sep}fetch.voyd`]: "fn fetch()\n  1",
    });

    const graph = await buildModuleGraph({
      entryPath: `${root}${sep}server.voyd`,
      host,
      roots: { src: root },
    });

    expect(graph.diagnostics).toHaveLength(0);
    expect(Array.from(graph.modules.keys())).toEqual(
      expect.arrayContaining([
        "src::server",
        "src::server::api",
        "src::server::users::get_user",
        "src::server::fetch",
      ])
    );
  });

  it("registers inline modules and resolves imports against them", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: "use internal::nested",
      [`${root}${sep}internal.voyd`]: "mod nested\n  pub fn hi()\n    1",
    });

    const graph = await buildModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      host,
      roots: { src: root },
    });

    expect(graph.diagnostics).toHaveLength(0);
    expect(Array.from(graph.modules.keys())).toEqual(
      expect.arrayContaining([
        "src::main",
        "src::internal",
        "src::internal::nested",
      ])
    );
    const inlineModule = graph.modules.get("src::internal::nested");
    expect(inlineModule?.origin.kind).toBe("inline");
    if (inlineModule?.origin.kind === "inline") {
      expect(inlineModule.origin.parentId).toBe("src::internal");
    }
  });

  it("discovers dependencies for grouped mod declarations", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}grouped.voyd`]: "mod util::{self, helpers::math}",
      [`${root}${sep}grouped${sep}util.voyd`]: "",
      [`${root}${sep}grouped${sep}util${sep}helpers${sep}math.voyd`]: "",
    });

    const graph = await buildModuleGraph({
      entryPath: `${root}${sep}grouped.voyd`,
      host,
      roots: { src: root },
    });

    expect(graph.diagnostics).toHaveLength(0);
    expect(Array.from(graph.modules.keys())).toEqual(
      expect.arrayContaining([
        "src::grouped",
        "src::grouped::util",
        "src::grouped::util::helpers::math",
      ])
    );
  });

  it("emits structured diagnostics for missing modules", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: "use util::missing",
    });

    const graph = await buildModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      host,
      roots: { src: root },
    });

    expect(graph.diagnostics).toHaveLength(1);
    const diagnostic = graph.diagnostics[0]!;
    expect(diagnostic.code).toBe("MD0001");
    expect(diagnostic.phase).toBe("module-graph");
    expect(diagnostic.severity).toBe("error");
    expect(diagnostic.span.file).toContain("main.voyd");
    expect(diagnostic.message).toMatch(/src::util/);
  });
});
