import { describe, expect, it } from "vitest";
import { resolve, sep } from "node:path";
import { createMemoryModuleHost } from "../memory-host.js";
import { createNodePathAdapter } from "../node-path-adapter.js";
import type { ModuleHost } from "../types.js";
import { buildModuleGraph } from "../graph.js";

const createMemoryHost = (files: Record<string, string>): ModuleHost =>
  createMemoryModuleHost({ files, pathAdapter: createNodePathAdapter() });

describe("expandModuleMacros diagnostics", () => {
  it("reports @serializer macro errors as module-graph diagnostics", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: [
        '@serializer("msgpack", encode, decode)',
        '@serializer("msgpack", encode, decode)',
        "pub type Foo = i32",
      ].join("\n"),
    });

    const graph = await buildModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      host,
      roots: { src: root },
    });

    const diagnostic = graph.diagnostics.find((entry) => entry.code === "MD0003");
    expect(diagnostic).toBeTruthy();
    expect(diagnostic?.message).toMatch(/serializer/i);
    expect(diagnostic?.message).toMatch(/duplicate/i);
    expect(diagnostic?.span.file).toContain("main.voyd");
  });
});

