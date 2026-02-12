import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compileEffectFixture,
  parseEffectTable,
  runEffectfulExport,
} from "./support/effects-harness.js";

const fixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-generic-callback-sites.voyd"
);

describe("effects generic callback continuation sites", () => {
  it("specializes continuation env types per instance across callback-owning functions", async () => {
    const { module } = await compileEffectFixture({ entryPath: fixturePath });
    const parsed = parseEffectTable(module);
    const awaitOp = parsed.ops.find((op) => op.label.endsWith("Async.await"));
    const tapOp = parsed.ops.find((op) => op.label.endsWith("Trace.tap"));
    if (!awaitOp || !tapOp) {
      throw new Error("missing Async.await or Trace.tap op entry");
    }

    const seenAsync: number[] = [];
    const seenTrace: number[] = [];
    const result = await runEffectfulExport<number>({
      wasm: module,
      entryName: "main_effectful",
      handlers: {
        [`${awaitOp.opIndex}`]: (_request, value) => {
          seenAsync.push(value as number);
          return value;
        },
        [`${tapOp.opIndex}`]: (_request, value) => {
          seenTrace.push(value as number);
          return value;
        },
      },
    });

    expect(result.value).toBe(10);
    expect(seenAsync).toEqual([6, 6, 6, 5]);
    expect(seenTrace).toEqual([4, 4, 4, 4]);
  });
});
