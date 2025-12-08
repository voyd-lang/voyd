import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "../../parser/index.js";
import { semanticsPipeline } from "../../semantics/pipeline.js";
import { codegen } from "../index.js";
import { runEffectfulExport, parseEffectTable } from "./support/effects-harness.js";

const fixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-export.voyd"
);

const buildModule = () => {
  const source = readFileSync(fixturePath, "utf8");
  const result = codegen(semanticsPipeline(parse(source, "/proj/src/effects-export.voyd")));
  if (process.env.DEBUG_EFFECTS_WAT === "1") {
    writeFileSync("debug-effects-export.wat", result.module.emitText());
  }
  return result;
};

describe("effectful exports & host boundary", () => {
  it("runs effectful main through the msgpack host loop", async () => {
    const { module } = buildModule();
    const logs: number[] = [];
    const result = await runEffectfulExport<number>({
      wasm: module,
      entryName: "main_effectful",
      handlers: {
        "0:0:1": () => 2,
        "0:1:0": (_req, msg: number) => {
          logs.push(msg);
          return 0;
        },
      },
    });
    expect(result.value).toBe(3);
    expect(logs).toEqual([2]);
  });

  it("rejects when no handler is provided", async () => {
    const { module } = buildModule();
    await expect(
      runEffectfulExport({
        wasm: module,
        entryName: "main_effectful",
      })
    ).rejects.toThrow(/Unhandled effect/);
  });

  it("traps when the buffer is too small", async () => {
    const { module } = buildModule();
    await expect(
      runEffectfulExport({
        wasm: module,
        entryName: "main_effectful",
        bufferSize: 4,
        handlers: {
          "0:0:1": () => 1,
          "0:1:0": () => 0,
        },
      })
    ).rejects.toThrow();
  });

  it("emits resumeKind and ids in the effect table", () => {
    const { module, effectTable } = buildModule();
    const parsed = parseEffectTable(module);
    expect(effectTable).toBeDefined();
    if (!effectTable) return;
    expect(parsed.effects[0]?.ops.map((op) => op.resumeKind)).toEqual([1, 0]);
    expect(effectTable.effects[0]?.ops.map((op) => op.resumeKind)).toEqual([1, 0]);
  });
});
