import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compileEffectFixture,
  runEffectfulExport,
  parseEffectTable,
} from "./support/effects-harness.js";

const fixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-perform-harness.voyd"
);
const smokeFixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-smoke.voyd"
);

const loadSmokeModule = () =>
  compileEffectFixture({
    entryPath: smokeFixturePath,
    codegenOptions: { emitEffectHelpers: true },
  });

const buildFixtureEffectModule = () => compileEffectFixture({ entryPath: fixturePath });

const maybeWriteWat = (tag: string, module: { emitText: () => string }) => {
  if (process.env.DEBUG_EFFECTS_WAT !== "1") return;
  writeFileSync(tag, module.emitText());
};

const findLogInfoOp = (
  ops: { label: string; effectId: string }[]
): { label: string; effectId: string } | undefined =>
  ops.find((op) => op.label.endsWith("Log.info"));

const RUNTIME_DIAGNOSTICS_SECTION = "voyd.runtime_diagnostics";

describe("effect table + harness", () => {
  it("emits a custom section and sidecar for effects", async () => {
    const { module, effectTable } = await loadSmokeModule();
    expect(effectTable).toBeDefined();
    if (!effectTable) return;
    maybeWriteWat("debug-effects-harness.wat", module);

    const parsed = parseEffectTable(module);
    expect(parsed.version).toBe(2);
    expect(parsed.namesBase64).toBe(effectTable.namesBlob);
    const parsedLogOp = findLogInfoOp(parsed.ops);
    if (!parsedLogOp) {
      throw new Error("missing Log.info op entry");
    }
    parsed.ops.forEach((op) => {
      expect(typeof op.signatureHash).toBe("number");
    });

    const tableLogOp = findLogInfoOp(effectTable.ops);
    if (!tableLogOp) {
      throw new Error("missing Log.info op entry in effect table");
    }
    expect(tableLogOp.label).toBe(parsedLogOp.label);
    expect(tableLogOp.effectId).toBe(parsedLogOp.effectId);
    expect(effectTable.ops[0]?.effectIdHash).toBe(
      parsed.ops[0]?.effectIdHash.hex
    );
    effectTable.ops.forEach((op) => {
      expect(typeof op.signatureHash).toBe("number");
    });
  }, 30_000);

  it("emits runtime trap diagnostics function metadata", async () => {
    const { wasm } = await loadSmokeModule();
    const wasmBuffer =
      wasm.buffer instanceof ArrayBuffer &&
      wasm.byteOffset === 0 &&
      wasm.byteLength === wasm.buffer.byteLength
        ? wasm.buffer
        : wasm.slice().buffer;
    const wasmModule = new WebAssembly.Module(wasmBuffer);
    const sections = WebAssembly.Module.customSections(
      wasmModule,
      RUNTIME_DIAGNOSTICS_SECTION
    );
    expect(sections.length).toBeGreaterThan(0);
    const payload = new TextDecoder().decode(new Uint8Array(sections[0]!));
    const parsed = JSON.parse(payload) as {
      version: number;
      functions: Array<{
        wasmName: string;
        moduleId: string;
        functionName: string;
        span: {
          file: string;
          start: number;
          end: number;
          startLine?: number;
          startColumn?: number;
        };
      }>;
    };
    expect(parsed.version).toBe(1);
    expect(parsed.functions.length).toBeGreaterThan(0);
    const main = parsed.functions.find((entry) => entry.functionName === "main");
    expect(main).toBeDefined();
    expect(main?.moduleId).toContain("src::effects-smoke");
    expect(main?.span.file).toContain("effects-smoke.voyd");
    expect(main?.span.startLine).toBeGreaterThan(0);
    expect(main?.span.startColumn).toBeGreaterThan(0);
  });

  it("unwraps Outcome.value from an effectful export", async () => {
    const { module } = await loadSmokeModule();
    const parsed = parseEffectTable(module);
    const op = parsed.ops[0];
    if (!op) {
      throw new Error("missing effect op entry");
    }
    const { value, table } = await runEffectfulExport<number>({
      wasm: module,
      entryName: "main_effectful",
      handlers: {
        [`${op.opIndex}`]: () => 0,
      },
    });
    expect(value).toBe(8);
    expect(findLogInfoOp(table.ops)).toBeDefined();
  });

  it("drives an effect request through a handler", async () => {
    const { module } = await buildFixtureEffectModule();
    const parsed = parseEffectTable(module);
    const op = parsed.ops.find((entry) => entry.label.endsWith("Log.info"));
    if (!op) {
      throw new Error("missing Log.info op entry");
    }
    let calls = 0;
    const result = await runEffectfulExport<number>({
      wasm: module,
      entryName: "main_effectful",
      handlers: {
        [`${op.opIndex}`]: () => {
          calls += 1;
          return 99;
        },
      },
    });
    expect(calls).toBe(1);
    expect(result.value).toBe(0);
  });

  it("runs effectful exports when effectsMemoryExport is off", async () => {
    const { module } = await compileEffectFixture({
      entryPath: smokeFixturePath,
      codegenOptions: { effectsMemoryExport: "off" },
    });
    const parsed = parseEffectTable(module);
    const op = parsed.ops[0];
    if (!op) {
      throw new Error("missing effect op entry");
    }
    const { value } = await runEffectfulExport<number>({
      wasm: module,
      entryName: "main_effectful",
      handlers: {
        [`${op.opIndex}`]: () => 0,
      },
    });
    expect(value).toBe(8);
  });

  it("throws when a performed op has no handler", async () => {
    const { module } = await buildFixtureEffectModule();
    await expect(
      runEffectfulExport({
        wasm: module,
        entryName: "main_effectful",
      })
    ).rejects.toThrow(/Unhandled effect/);
  });

  it("snapshots the perform fixture via codegen", async () => {
    const { module, effectTable } = await compileEffectFixture({
      entryPath: fixturePath,
      codegenOptions: { emitEffectHelpers: true },
    });
    const tableLogOp = findLogInfoOp(effectTable?.ops ?? []);
    if (!tableLogOp) {
      throw new Error("missing Log.info op entry in effect table");
    }
    const parsed = parseEffectTable(module);
    const parsedLogOp = findLogInfoOp(parsed.ops);
    if (!parsedLogOp) {
      throw new Error("missing Log.info op entry");
    }
    expect(tableLogOp.label).toBe(parsedLogOp.label);
    expect(tableLogOp.effectId).toBe(parsedLogOp.effectId);
    if (effectTable?.ops[0]) {
      expect(effectTable.ops[0].effectIdHash).toBe(
        parsed.ops[0]?.effectIdHash.hex
      );
    }
    effectTable?.ops.forEach((op) => {
      expect(typeof op.signatureHash).toBe("number");
    });

    parsed.ops.forEach((op) => {
      expect(typeof op.signatureHash).toBe("number");
    });

    const text = module.emitText();
    expect(text).toContain("struct.new $voydEffectRequest");
    expect(text).toContain("struct.new $voydOutcome");
  });
});
