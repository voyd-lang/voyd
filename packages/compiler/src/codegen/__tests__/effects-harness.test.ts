import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { codegen } from "../index.js";
import { parse } from "../../parser/index.js";
import {
  runEffectfulExport,
  parseEffectTable,
} from "./support/effects-harness.js";
import { semanticsPipeline } from "../../semantics/pipeline.js";
import type { SemanticsPipelineResult } from "../../semantics/pipeline.js";

const fixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-perform-harness.voyd"
);
const fixtureVirtualPath = "/proj/src/effects-perform-harness.voyd";

const loadSmokeModule = () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "__fixtures__", "effects-smoke.voyd"),
    "utf8"
  );
  const semantics = semanticsPipeline(
    parse(source, "/proj/src/effects-smoke.voyd")
  );
  return codegen(semantics, { emitEffectHelpers: true });
};

const loadPerformSemantics = (): SemanticsPipelineResult =>
  semanticsPipeline(
    parse(readFileSync(fixturePath, "utf8"), fixtureVirtualPath)
  );

const buildFixtureEffectModule = () => {
  const semantics = loadPerformSemantics();
  const result = codegen(semantics);
  if (process.env.DEBUG_EFFECTS_WAT === "1") {
    writeFileSync("debug-effects-harness.wat", result.module.emitText());
  }
  return result;
};

describe("effect table + harness", () => {
  it("emits a custom section and sidecar for effects", () => {
    const { module, effectTable } = loadSmokeModule();
    expect(effectTable).toBeDefined();
    if (!effectTable) return;

    const parsed = parseEffectTable(module);
    expect(parsed.version).toBe(2);
    expect(parsed.namesBase64).toBe(effectTable.namesBlob);
    expect(
      parsed.ops.map((op) => ({
        opIndex: op.opIndex,
        effectId: op.effectId,
        opId: op.opId,
        resumeKind: op.resumeKind,
        label: op.label,
      }))
    ).toMatchInlineSnapshot(`
      [
        {
          "effectId": "local::/proj/src/effects-smoke.voyd::Log",
          "label": "/proj/src/effects-smoke.voyd::Log.info",
          "opId": 0,
          "opIndex": 0,
          "resumeKind": 0,
        },
      ]
    `);
    parsed.ops.forEach((op) => {
      expect(typeof op.signatureHash).toBe("number");
    });

    expect(
      effectTable.ops.map((op) => ({
        opIndex: op.opIndex,
        effectId: op.effectId,
        opId: op.opId,
        resumeKind: op.resumeKind,
        label: op.label,
      }))
    ).toMatchInlineSnapshot(`
      [
        {
          "effectId": "local::/proj/src/effects-smoke.voyd::Log",
          "label": "/proj/src/effects-smoke.voyd::Log.info",
          "opId": 0,
          "opIndex": 0,
          "resumeKind": 0,
        },
      ]
    `);
    expect(effectTable.ops[0]?.effectIdHash).toBe(
      parsed.ops[0]?.effectIdHash.hex
    );
    effectTable.ops.forEach((op) => {
      expect(typeof op.signatureHash).toBe("number");
    });
  });

  it("unwraps Outcome.value from an effectful export", async () => {
    const { module } = loadSmokeModule();
    const { value, table } = await runEffectfulExport<number>({
      wasm: module,
      entryName: "main_effectful",
    });
    expect(value).toBe(8);
    expect(table.ops[0]?.label).toBe("/proj/src/effects-smoke.voyd::Log.info");
  });

  it("drives an effect request through a handler", async () => {
    const { module } = buildFixtureEffectModule();
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

  it("throws when no handler is available", async () => {
    const { module } = buildFixtureEffectModule();
    await expect(
      runEffectfulExport({
        wasm: module,
        entryName: "main_effectful",
      })
    ).rejects.toThrow(/Unhandled effect .*Log\.info/);
  });

  it("snapshots the perform fixture via codegen", () => {
    const source = readFileSync(fixturePath, "utf8");
    const semantics = semanticsPipeline(parse(source, fixtureVirtualPath));
    const { module, effectTable } = codegen(semantics, {
      emitEffectHelpers: true,
    });
    expect(
      effectTable?.ops.map((op) => ({
        opIndex: op.opIndex,
        effectId: op.effectId,
        opId: op.opId,
        resumeKind: op.resumeKind,
        label: op.label,
      }))
    ).toMatchInlineSnapshot(`
      [
        {
          "effectId": "local::/proj/src/effects-perform-harness.voyd::Log",
          "label": "/proj/src/effects-perform-harness.voyd::Log.info",
          "opId": 0,
          "opIndex": 0,
          "resumeKind": 0,
        },
      ]
    `);
    const parsed = parseEffectTable(module);
    if (effectTable?.ops[0]) {
      expect(effectTable.ops[0].effectIdHash).toBe(
        parsed.ops[0]?.effectIdHash.hex
      );
    }
    effectTable?.ops.forEach((op) => {
      expect(typeof op.signatureHash).toBe("number");
    });

    expect(
      parsed.ops.map((op) => ({
        opIndex: op.opIndex,
        effectId: op.effectId,
        opId: op.opId,
        resumeKind: op.resumeKind,
        label: op.label,
      }))
    ).toMatchInlineSnapshot(`
      [
        {
          "effectId": "local::/proj/src/effects-perform-harness.voyd::Log",
          "label": "/proj/src/effects-perform-harness.voyd::Log.info",
          "opId": 0,
          "opIndex": 0,
          "resumeKind": 0,
        },
      ]
    `);
    parsed.ops.forEach((op) => {
      expect(typeof op.signatureHash).toBe("number");
    });

    const text = module.emitText();
    expect(text).toContain("struct.new $voydEffectRequest");
    expect(text).toContain("struct.new $voydOutcome");
  });
});
