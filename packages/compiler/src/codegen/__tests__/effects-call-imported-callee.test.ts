import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compileEffectFixture,
  parseEffectTable,
  runEffectfulExport,
} from "./support/effects-harness.js";
import { wasmBufferSource } from "./support/wasm-utils.js";

const fixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-call-imported-callee",
  "pkg.voyd",
);

describe("effects call imported callee", () => {
  it("compiles direct imported effect-op performs with effectful args", async () => {
    const { module } = await compileEffectFixture({ entryPath: fixturePath });
    const parsed = parseEffectTable(module);
    const awaitOp = parsed.ops.find((op) => op.label.endsWith("Async.await"));
    if (!awaitOp) {
      throw new Error("missing Async.await op entry");
    }
    expect(awaitOp.opIndex).toBeGreaterThanOrEqual(0);
  });

  it("compiles handlers for imported effect ops used by imported callees", async () => {
    const { wasm } = await compileEffectFixture({ entryPath: fixturePath });
    const instance = new WebAssembly.Instance(
      new WebAssembly.Module(wasmBufferSource(wasm)),
      {},
    );
    const target = instance.exports
      .handle_imported_effectful_call as CallableFunction;

    expect(target()).toBe(15);
  });

  it("compiles and runs directly performed imported overloaded operations", async () => {
    const { module } = await compileEffectFixture({ entryPath: fixturePath });
    const parsed = parseEffectTable(module);
    const awaitOps = parsed.ops.filter((op) =>
      op.label.endsWith("Async.await"),
    );
    expect(awaitOps).toHaveLength(2);

    const { value } = await runEffectfulExport<number>({
      wasm: module,
      entryName: "perform_imported_overloads",
      handlers: Object.fromEntries(
        awaitOps.map((op) => [
          `${op.opIndex}`,
          (_request, value: unknown) => (typeof value === "boolean" ? 20 : 10),
        ]),
      ),
    });
    expect(value).toBe(30);
  });
});
