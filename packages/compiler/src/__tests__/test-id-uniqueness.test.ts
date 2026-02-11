import { describe, expect, it } from "vitest";
import { resolve, sep } from "node:path";
import { createMemoryModuleHost } from "../modules/memory-host.js";
import { createNodePathAdapter } from "../modules/node-path-adapter.js";
import { buildModuleGraph } from "../modules/graph.js";
import { analyzeModules } from "../pipeline-shared.js";
import { hashModulePath } from "../tests/ids.js";
import { TEST_ID_PREFIX } from "../tests/prefix.js";

describe("test ids", () => {
  it("prefixes test ids with module hashes to keep them unique", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryModuleHost({
      files: {
        [`${root}${sep}main.voyd`]: `test "alpha":
  1

pub use self::util::all
`,
        [`${root}${sep}main${sep}util.voyd`]: `test "beta":
  1
`,
      },
      pathAdapter: createNodePathAdapter(),
    });

    const graph = await buildModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root },
      host,
    });

    const { tests } = analyzeModules({ graph, includeTests: true });
    expect(tests).toHaveLength(2);
    const ids = tests.map((test) => test.id);
    expect(new Set(ids).size).toBe(ids.length);

    tests.forEach((test) => {
      const moduleNode = graph.modules.get(test.moduleId);
      if (!moduleNode) {
        throw new Error(`missing module ${test.moduleId}`);
      }
      const moduleHash = hashModulePath(moduleNode.path);
      expect(test.id.startsWith(`${TEST_ID_PREFIX}${moduleHash}_`)).toBe(true);
    });
  });
});
