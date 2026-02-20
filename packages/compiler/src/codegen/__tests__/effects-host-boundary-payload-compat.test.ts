import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compileEffectFixture,
  parseEffectTable,
  runEffectfulExport,
} from "./support/effects-harness.js";

const dtoShimFixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-export-dto-shim.voyd",
);

const unsupportedReturnFixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-export-object-return-unsupported.voyd",
);

describe("host boundary payload compatibility", () => {
  it("supports API-to-DTO shim wrappers for effect payloads", async () => {
    const { module } = await compileEffectFixture({ entryPath: dtoShimFixturePath });
    const parsed = parseEffectTable(module);
    const op = parsed.ops.find((entry) => entry.label.endsWith("HostBridge.take_box"));
    if (!op) {
      throw new Error("missing HostBridge.take_box op entry");
    }

    const result = await runEffectfulExport<number>({
      wasm: module,
      entryName: "main_effectful",
      handlers: {
        [`${op.opIndex}`]: (_request, raw: unknown) => (raw as number) + 1,
      },
    });

    expect(result.value).toBe(42);
  });

  it("reports unsupported effect return payloads at compile time", async () => {
    const result = await compileEffectFixture({
      entryPath: unsupportedReturnFixturePath,
      throwOnError: false,
    });
    const diagnostic = result.diagnostics.find(
      (diag) =>
        diag.code === "CG0001" &&
        diag.message.includes("HostOnly.roundtrip return value") &&
        diag.message.includes("unsupported type Box"),
    );
    expect(diagnostic).toBeDefined();
  });
});
