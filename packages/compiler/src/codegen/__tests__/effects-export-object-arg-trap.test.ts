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
  "effects-export-object-arg-trap.voyd"
);

describe("effectful exports with non-i32 args", () => {
  it("passes object arguments through the typed host boundary", async () => {
    const { module } = await compileEffectFixture({ entryPath: fixturePath });
    const op = parseEffectTable(module).ops.find((entry) =>
      entry.label.endsWith("HostOnly.poke"),
    );
    if (!op) throw new Error("missing HostOnly.poke op entry");

    const result = await runEffectfulExport<number>({
      wasm: module,
      entryName: "main",
      handlers: {
        [`${op.opIndex}`]: (_request, box: unknown) => {
          expect(box).toEqual({ v: 1 });
          return 42;
        },
      },
    });

    expect(result.value).toBe(42);
  });
});
