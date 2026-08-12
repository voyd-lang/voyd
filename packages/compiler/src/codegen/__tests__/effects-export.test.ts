import { dirname, resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  compileEffectFixture,
  runEffectfulExport,
  parseEffectTable,
} from "./support/effects-harness.js";
import { compileProgram } from "../../pipeline.js";
import { createFsModuleHost } from "../../modules/fs-host.js";

const fixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-export.voyd"
);
const dtoFixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-dto.voyd"
);
const openRowNoPerformFixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-export-open-row-no-perform.voyd"
);
const unusedGenericExternalFixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "external-generic-effect-unused.voyd",
);

const compileFixture = async (fixture: string) => {
  const result = await compileEffectFixture({ entryPath: fixture });
  if (process.env.DEBUG_EFFECTS_WAT === "1") {
    writeFileSync("debug-effects-export.wat", result.module.emitText());
  }
  return result;
};

const buildModule = () => compileFixture(fixturePath);
const buildDtoModule = () => compileFixture(dtoFixturePath);

describe("effectful exports & host boundary", () => {
  it("allows unused generic external effect declarations in ordinary builds", async () => {
    const result = await compileProgram({
      entryPath: unusedGenericExternalFixturePath,
      roots: {
        src: dirname(unusedGenericExternalFixturePath),
        std: resolve(import.meta.dirname, "../../../../std/src"),
      },
      host: createFsModuleHost(),
    });

    if (!result.success) {
      throw new Error(JSON.stringify(result.diagnostics, null, 2));
    }
    expect(result.wasm).toBeInstanceOf(Uint8Array);
  });

  it("retains selected host-provider contracts in optimized builds without typed boundary exports", async () => {
    const result = await compileProgram({
      entryPath: fixturePath,
      roots: {
        src: dirname(fixturePath),
        std: resolve(import.meta.dirname, "../../../../std/src"),
      },
      host: createFsModuleHost(),
      codegenOptions: {
        optimizationLevel: "release",
        boundaryExports: false,
        effectsHostBoundary: "selected",
        validate: true,
      },
    });

    if (!result.success) {
      throw new Error(JSON.stringify(result.diagnostics, null, 2));
    }
    expect(result.wasm).toBeInstanceOf(Uint8Array);
  });

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

  it("emits init_effects for open-row exports without performs", async () => {
    const { module } = await compileFixture(openRowNoPerformFixturePath);
    const wat = module.emitText();
    expect(wat).toContain(`(export "init_effects"`);
    await expect(
      runEffectfulExport<number>({
        wasm: module,
        entryName: "main_effectful",
      })
    ).resolves.toMatchObject({ value: 7 });
  });

  it("round-trips typed DTO values for effect handlers", async () => {
    const { module } = await buildDtoModule();
    const parsed = parseEffectTable(module);
    const roundtrip = parsed.ops.find((op) => op.label.endsWith(".roundtrip"));
    if (!roundtrip) {
      throw new Error("missing Exchange roundtrip op");
    }
    const expectedArgs = { code: 1, label: "hi", nested: [2, 3] };
    const expectedResponse = { code: 2, label: "ok", nested: [9, 10] };
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

  it("accepts typed DTO arguments on effectful exports", async () => {
    const { module } = await buildDtoModule();
    const parsed = parseEffectTable(module);
    const roundtrip = parsed.ops.find((op) => op.label.endsWith(".roundtrip"));
    if (!roundtrip) {
      throw new Error("missing Exchange roundtrip op");
    }
    const input = { code: 7, label: "input", nested: [8, 9] };
    const output = { code: 10, label: "output", nested: [11] };
    const result = await runEffectfulExport({
      wasm: module,
      entryName: "from_host",
      args: [input],
      handlers: {
        [`${roundtrip.opIndex}`]: (_req, value: unknown) => {
          expect(value).toEqual(input);
          return output;
        },
      },
    });
    expect(result.value).toEqual(output);
  });

  it("normalizes union DTOs for effect adapters and effectful results", async () => {
    const { module } = await buildDtoModule();
    const parsed = parseEffectTable(module);
    const decide = parsed.ops.find((op) => op.label.endsWith(".decide"));
    if (!decide) throw new Error("missing Exchange decide op");
    const input = {
      tag: "Accepted",
      value: { code: 1, label: "ok", nested: [2] },
    };
    const output = { tag: "Rejected", reason: "no" };
    const result = await runEffectfulExport({
      wasm: module,
      entryName: "decide_from_host",
      args: [input],
      handlers: {
        [`${decide.opIndex}`]: (_req, value: unknown) => {
          expect(value).toEqual(input);
          return output;
        },
      },
    });
    expect(result.value).toEqual(output);
  });
});
