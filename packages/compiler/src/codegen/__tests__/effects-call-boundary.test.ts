import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compileEffectFixture,
  runEffectfulExport,
  type EffectHandler,
  parseEffectTable,
} from "./support/effects-harness.js";

const fixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-call-boundary.voyd"
);

describe("effects call boundary", () => {
  it("resumes into caller after effectful call", async () => {
    const { module } = await compileEffectFixture({ entryPath: fixturePath });
    const parsed = parseEffectTable(module);
    const awaitOp = parsed.ops.find((op) => op.label.endsWith("Async.await"));
    if (!awaitOp) {
      throw new Error("missing Async.await op entry");
    }

    const handler: EffectHandler = (_request, ...args) => args[0] as number;
    const handlers: Record<string, EffectHandler> = {
      [`${awaitOp.opIndex}`]: handler,
    };

    const outer = await runEffectfulExport<number>({
      wasm: module,
      entryName: "outer_effectful",
      handlers,
    });
    expect(outer.value).toBe(8);

    const twice = await runEffectfulExport<number>({
      wasm: module,
      entryName: "outer_twice_effectful",
      handlers,
    });
    expect(twice.value).toBe(5);

    const nested = await runEffectfulExport<number>({
      wasm: module,
      entryName: "outer_nested_effectful",
      handlers,
    });
    expect(nested.value).toBe(18);
  });
});
