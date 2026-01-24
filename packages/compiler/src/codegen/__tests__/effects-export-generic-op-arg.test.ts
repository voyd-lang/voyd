import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compileEffectFixture,
  runEffectfulExport,
  parseEffectTable,
} from "./support/effects-harness.js";

const fixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-export-generic-op-arg.voyd"
);

const buildModule = () => compileEffectFixture({ entryPath: fixturePath });

describe("effectful exports with generic effect args", () => {
  it("encodes concrete args for generic effect operations", async () => {
    const { module } = await buildModule();
    const parsed = parseEffectTable(module);
    const takeOp = parsed.ops.find((op) => op.label.endsWith("Box.take"));
    if (!takeOp) {
      throw new Error("missing Box.take op entry");
    }
    const handlers = {
      [`${takeOp.opIndex}`]: (_request: unknown, ...args: unknown[]) =>
        (args[0] as number) + 1,
    };

    const result = await runEffectfulExport<number>({
      wasm: module,
      entryName: "main_effectful",
      handlers,
    });

    expect(result.value).toBe(42);
  });
});
