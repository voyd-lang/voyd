import { describe, expect, it } from "vitest";
import { parseBase } from "../../parser/index.js";
import { getModuleSccGroups } from "../scc.js";
import { modulePathToString } from "../path.js";
import type { ModuleGraph, ModuleNode, ModulePath } from "../types.js";

describe("getModuleSccGroups", () => {
  it("returns dependencies before dependents for acyclic graphs", () => {
    const graph = buildGraph({
      modules: [
        { id: "src::main", dependencies: ["src::util"] },
        { id: "src::util", dependencies: ["src::leaf"] },
        { id: "src::leaf", dependencies: [] },
      ],
    });

    const groups = getModuleSccGroups({ graph });

    expect(groups).toEqual([
      { moduleIds: ["src::leaf"], cyclic: false },
      { moduleIds: ["src::util"], cyclic: false },
      { moduleIds: ["src::main"], cyclic: false },
    ]);
  });

  it("groups cyclic modules into a single SCC", () => {
    const graph = buildGraph({
      modules: [
        { id: "src::main", dependencies: ["src::a"] },
        { id: "src::a", dependencies: ["src::b"] },
        { id: "src::b", dependencies: ["src::a"] },
      ],
    });

    const groups = getModuleSccGroups({ graph });

    expect(groups).toEqual([
      { moduleIds: ["src::a", "src::b"], cyclic: true },
      { moduleIds: ["src::main"], cyclic: false },
    ]);
  });

  it("marks self-looped modules as cyclic", () => {
    const graph = buildGraph({
      modules: [{ id: "src::self_loop", dependencies: ["src::self_loop"] }],
    });

    const groups = getModuleSccGroups({ graph });

    expect(groups).toEqual([
      { moduleIds: ["src::self_loop"], cyclic: true },
    ]);
  });
});

const buildGraph = ({
  modules,
}: {
  modules: ReadonlyArray<{ id: string; dependencies: readonly string[] }>;
}): ModuleGraph => {
  const nodes = new Map<string, ModuleNode>(
    modules.map(({ id, dependencies }) => {
      const path = modulePathFromId(id);
      return [
        id,
        {
          id,
          path,
          origin: {
            kind: "file",
            filePath: `/proj/${id.replaceAll("::", "/")}.voyd`,
          },
          ast: parseBase("", `/proj/${id.replaceAll("::", "/")}.voyd`),
          source: "",
          dependencies: dependencies.map((dependencyId) => ({
            kind: "use",
            path: modulePathFromId(dependencyId),
          })),
        },
      ] as const;
    }),
  );

  return {
    entry: modules[0]?.id ?? "src::main",
    modules: nodes,
    diagnostics: [],
  };
};

const modulePathFromId = (id: string): ModulePath => {
  const [namespace, ...segments] = id.split("::");
  if (namespace !== "src" && namespace !== "std" && namespace !== "pkg") {
    throw new Error(`Unsupported namespace for test module id: ${id}`);
  }
  const path: ModulePath = { namespace, segments };
  if (modulePathToString(path) !== id) {
    throw new Error(`Invalid module id for test path conversion: ${id}`);
  }
  return path;
};
