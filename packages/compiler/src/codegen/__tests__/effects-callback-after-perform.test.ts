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
  "effects-callback-after-perform.voyd"
);

describe("effects callback after perform", () => {
  it("resumes into callback-owning functions after a perform", async () => {
    const { module } = await compileEffectFixture({ entryPath: fixturePath });
    const parsed = parseEffectTable(module);
    const awaitOp = parsed.ops.find((op) => op.label.endsWith("Async.await"));
    if (!awaitOp) {
      throw new Error("missing Async.await op entry");
    }

    const result = await runEffectfulExport<number>({
      wasm: module,
      entryName: "main_effectful",
      handlers: {
        [`${awaitOp.opIndex}`]: (_request, value) => value,
      },
    });

    expect(result.value).toBe(7);
  });

  it("resumes lambdas that call captured callbacks after a perform", async () => {
    const { module } = await compileEffectFixture({ entryPath: fixturePath });
    const parsed = parseEffectTable(module);
    const awaitOp = parsed.ops.find((op) => op.label.endsWith("Async.await"));
    if (!awaitOp) {
      throw new Error("missing Async.await op entry");
    }

    const result = await runEffectfulExport<number>({
      wasm: module,
      entryName: "lambda_capture_main_effectful",
      handlers: {
        [`${awaitOp.opIndex}`]: (_request, value) => value,
      },
    });

    expect(result.value).toBe(7);
  });

  it("resumes generic callback helpers invoked from capturing lambdas", async () => {
    const { module } = await compileEffectFixture({ entryPath: fixturePath });
    const parsed = parseEffectTable(module);
    const awaitOp = parsed.ops.find((op) => op.label.endsWith("Async.await"));
    if (!awaitOp) {
      throw new Error("missing Async.await op entry");
    }

    const result = await runEffectfulExport<number>({
      wasm: module,
      entryName: "nested_generic_lambda_main_effectful",
      handlers: {
        [`${awaitOp.opIndex}`]: (_request, value) => value,
      },
    });

    expect(result.value).toBe(7);
  });
});
