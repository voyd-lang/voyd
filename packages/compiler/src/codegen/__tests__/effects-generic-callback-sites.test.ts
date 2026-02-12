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
    if (!awaitOp) {
      throw new Error("missing Async.await op entry");
    }

    const seen: number[] = [];
    const result = await runEffectfulExport<number>({
      wasm: module,
      entryName: "main_effectful",
      handlers: {
        [`${awaitOp.opIndex}`]: (_request, value) => {
          seen.push(value as number);
          return value;
        },
      },
    });

    expect(result.value).toBe(6);
    expect(seen).toEqual([6, 6, 6, 5]);
  });
});
