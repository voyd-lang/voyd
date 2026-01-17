import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "../../parser/index.js";
import { semanticsPipeline } from "../../semantics/pipeline.js";
import { codegen } from "../index.js";
import { runEffectfulExport, parseEffectTable } from "./support/effects-harness.js";

const fixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-export-multi-return.voyd"
);

const buildModule = () => {
  const source = readFileSync(fixturePath, "utf8");
  return codegen(semanticsPipeline(parse(source, "/proj/src/effects-export-multi-return.voyd")));
};

describe("effectful exports with different return types", () => {
  it("runs both i32 and void effectful exports through the host boundary", async () => {
    const { module } = buildModule();
    const parsed = parseEffectTable(module);
    const pickOp = (suffix: string) =>
      parsed.ops.find((op) => op.label.endsWith(suffix));
    const asyncOp = pickOp("Async.await");
    const noopOp = pickOp("Noop.noop");
    const asyncI64Op = pickOp("AsyncI64.await");
    const asyncF64Op = pickOp("AsyncF64.await");
    const asyncF32Op = pickOp("AsyncF32.await");
    if (!asyncOp || !noopOp || !asyncI64Op || !asyncF64Op || !asyncF32Op) {
      throw new Error("missing effect ops for multi-return test");
    }
    const handlers = {
      [`${asyncOp.opIndex}`]: () => 2,
      [`${noopOp.opIndex}`]: () => 0,
      [`${asyncI64Op.opIndex}`]: () => 40n,
      [`${asyncF64Op.opIndex}`]: () => 2.5,
      [`${asyncF32Op.opIndex}`]: () => 1.25,
    };

    const main = await runEffectfulExport<number>({
      wasm: module,
      entryName: "main_effectful",
      handlers,
    });
    expect(main.value).toBe(3);

    const done = await runEffectfulExport<null>({
      wasm: module,
      entryName: "done_effectful",
      handlers,
    });
    expect(done.value).toBeNull();

    const big = await runEffectfulExport<bigint>({
      wasm: module,
      entryName: "big_effectful",
      handlers,
    });
    expect(big.value).toBe(40n);

    const floaty = await runEffectfulExport<number>({
      wasm: module,
      entryName: "floaty_effectful",
      handlers,
    });
    expect(floaty.value).toBeCloseTo(2.5);

    const tiny = await runEffectfulExport<number>({
      wasm: module,
      entryName: "tiny_effectful",
      handlers,
    });
    expect(tiny.value).toBeCloseTo(1.25);
  });
});
