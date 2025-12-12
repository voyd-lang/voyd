import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { codegen } from "../index.js";
import { parse } from "../../parser/index.js";
import {
  runEffectfulExport,
  parseEffectTable,
} from "./support/effects-harness.js";
import { RESUME_KIND } from "../effects/runtime-abi.js";
import { semanticsPipeline } from "../../semantics/pipeline.js";
import type { SemanticsPipelineResult } from "../../semantics/pipeline.js";
import type { SymbolId } from "../../semantics/ids.js";

const fixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-perform-harness.voyd"
);
const fixtureVirtualPath = "/proj/src/effects-perform-harness.voyd";

const markEffectful = (semantics: SemanticsPipelineResult): void => {
  const effectRow = semantics.typing.effects.internRow({
    operations: [{ name: "Log.info" }],
  });
  const resolveSymbol = (name: string): SymbolId => {
    const symbol = semantics.symbolTable.resolve(
      name,
      semantics.symbolTable.rootScope
    );
    if (typeof symbol !== "number") {
      throw new Error(`missing symbol for ${name}`);
    }
    return symbol;
  };

  ["main"].forEach((name) => {
    const symbol = resolveSymbol(name);
    const signature = semantics.typing.functions.getSignature(symbol);
    if (!signature) {
      throw new Error(`missing signature for ${name}`);
    }
    semantics.typing.functions.setSignature(symbol, {
      ...signature,
      effectRow,
    });
  });

  semantics.hir.expressions.forEach((expr) => {
    if (expr.exprKind === "call") {
      semantics.typing.effects.setExprEffect(expr.id, effectRow);
    }
  });
};

const loadSmokeModule = () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "__fixtures__", "effects-smoke.voyd"),
    "utf8"
  );
  const semantics = semanticsPipeline(
    parse(source, "/proj/src/effects-smoke.voyd")
  );
  markEffectful(semantics);
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
    expect(parsed.version).toBe(1);
    expect(parsed.namesBase64).toBe(effectTable.namesBlob);
    expect(parsed.effects).toMatchInlineSnapshot(`
      [
        {
          "id": 0,
          "label": "_proj_src_effects_smoke_voyd::Log",
          "name": "_proj_src_effects_smoke_voyd::Log",
          "ops": [
            {
              "id": 0,
              "label": "_proj_src_effects_smoke_voyd::Log.info",
              "name": "_proj_src_effects_smoke_voyd::Log.info",
              "resumeKind": 0,
            },
          ],
        },
      ]
    `);

    expect(effectTable.effects).toEqual([
      {
        id: 0,
        name: "Log",
        label: "_proj_src_effects_smoke_voyd::Log",
        ops: [
          {
            id: 0,
            name: "info",
            label: "_proj_src_effects_smoke_voyd::Log.info",
            resumeKind: RESUME_KIND.resume,
          },
        ],
      },
    ]);
  });

  it("unwraps Outcome.value from an effectful export", async () => {
    const { module } = loadSmokeModule();
    const { value, table } = await runEffectfulExport<number>({
      wasm: module,
      entryName: "main_effectful",
    });
    expect(value).toBe(8);
    expect(table.effects[0]?.label).toBe("_proj_src_effects_smoke_voyd::Log");
  });

  it("drives an effect request through a handler", async () => {
    const { module } = buildFixtureEffectModule();
    let calls = 0;
    const result = await runEffectfulExport<number>({
      wasm: module,
      entryName: "main_effectful",
      handlers: {
        "0:0:0": () => {
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
    ).rejects.toThrow(/Unhandled effect/);
  });

  it("snapshots the perform fixture via codegen", () => {
    const source = readFileSync(fixturePath, "utf8");
    const semantics = semanticsPipeline(parse(source, fixtureVirtualPath));
    const { module, effectTable } = codegen(semantics, {
      emitEffectHelpers: true,
    });
    expect(effectTable?.effects).toMatchInlineSnapshot(`
      [
        {
          "id": 0,
          "label": "_proj_src_effects_perform_harness_voyd::Log",
          "name": "Log",
          "ops": [
            {
              "id": 0,
              "label": "_proj_src_effects_perform_harness_voyd::Log.info",
              "name": "info",
              "resumeKind": 0,
            },
          ],
        },
      ]
    `);

    const parsed = parseEffectTable(module);
    expect(parsed.effects).toMatchInlineSnapshot(`
      [
        {
          "id": 0,
          "label": "_proj_src_effects_perform_harness_voyd::Log",
          "name": "_proj_src_effects_perform_harness_voyd::Log",
          "ops": [
            {
              "id": 0,
              "label": "_proj_src_effects_perform_harness_voyd::Log.info",
              "name": "_proj_src_effects_perform_harness_voyd::Log.info",
              "resumeKind": 0,
            },
          ],
        },
      ]
    `);

    const text = module.emitText();
    expect(text).toContain("struct.new $voydEffectRequest");
    expect(text).toContain("struct.new $voydOutcome");
  });
});
