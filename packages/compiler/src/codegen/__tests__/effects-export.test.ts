import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  compileEffectFixture,
  runEffectfulExport,
  parseEffectTable,
} from "./support/effects-harness.js";

const fixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-export.voyd"
);
const msgpackFixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-msgpack.voyd"
);

const compileFixture = async (fixture: string) => {
  const result = await compileEffectFixture({ entryPath: fixture });
  if (process.env.DEBUG_EFFECTS_WAT === "1") {
    writeFileSync("debug-effects-export.wat", result.module.emitText());
  }
  return result;
};

const buildModule = () => compileFixture(fixturePath);
const buildMsgpackModule = () => compileFixture(msgpackFixturePath);

describe("effectful exports & host boundary", () => {
  it("runs effectful main through the msgpack host loop", async () => {
    const { module } = await buildModule();
    const parsed = parseEffectTable(module);
    const awaitOp = parsed.ops.find((op) => op.label.endsWith(".await"));
    const logOp = parsed.ops.find((op) => op.label.endsWith(".log"));
    if (!awaitOp || !logOp) {
      throw new Error("missing Async ops in effect table");
    }
    const logs: number[] = [];
    const result = await runEffectfulExport<number>({
      wasm: module,
      entryName: "main_effectful",
      handlers: {
        [`${awaitOp.opIndex}`]: () => 2,
        [`${logOp.opIndex}`]: (_req, msg: unknown) => {
          const value = typeof msg === "number" ? msg : Number(msg);
          logs.push(value);
          return 0;
        },
      },
    });
    expect(result.value).toBe(3);
    expect(logs).toEqual([2]);
  });

  it("traps when the buffer is too small", async () => {
    const { module } = await buildModule();
    const parsed = parseEffectTable(module);
    const awaitOp = parsed.ops.find((op) => op.label.endsWith(".await"));
    const logOp = parsed.ops.find((op) => op.label.endsWith(".log"));
    if (!awaitOp || !logOp) {
      throw new Error("missing Async ops in effect table");
    }
    await expect(
      runEffectfulExport({
        wasm: module,
        entryName: "main_effectful",
        bufferSize: 4,
        handlers: {
          [`${awaitOp.opIndex}`]: () => 1,
          [`${logOp.opIndex}`]: () => 0,
        },
      })
    ).rejects.toThrow();
  });

  it("emits resumeKind and ids in the effect table", async () => {
    const { module, effectTable } = await buildModule();
    const parsed = parseEffectTable(module);
    const asyncParsed = parsed.ops.filter((op) => op.effectId.endsWith("::Async"));
    const asyncTable = effectTable?.ops.filter((op) =>
      op.effectId.endsWith("::Async")
    );
    expect(effectTable).toBeDefined();
    if (!effectTable) return;
    expect(asyncParsed.map((op) => op.resumeKind)).toEqual([1, 0]);
    expect(asyncTable?.map((op) => op.resumeKind)).toEqual([1, 0]);
  });

  it("round-trips msgpack values for effect handlers", async () => {
    const { module } = await buildMsgpackModule();
    const parsed = parseEffectTable(module);
    const roundtrip = parsed.ops.find((op) => op.label.endsWith(".roundtrip"));
    if (!roundtrip) {
      throw new Error("missing Exchange roundtrip op");
    }
    const expectedArgs = [1, "hi", [2, 3]];
    const expectedResponse = [true, "ok", [9, 10]];
    const result = await runEffectfulExport({
      wasm: module,
      entryName: "main_effectful",
      handlers: {
        [`${roundtrip.opIndex}`]: (_req, value: unknown) => {
          expect(value).toEqual(expectedArgs);
          return expectedResponse;
        },
      },
    });
    expect(result.value).toEqual(expectedResponse);
  });
});
