import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { codegen } from "../index.js";
import { parse } from "../../parser/index.js";
import { RESUME_KIND } from "../effects/runtime-abi.js";
import {
  runEffectfulExport,
  parseEffectTable,
} from "./support/effects-harness.js";
import binaryen from "binaryen";
import { createEffectRuntime } from "../effects/runtime-abi.js";
import { emitEffectTableSection } from "../effects/effect-table.js";
import { addEffectRuntimeHelpers } from "../effects/runtime-helpers.js";
import type { CodegenContext } from "../context.js";
import type { SemanticsPipelineResult } from "../../semantics/pipeline.js";
import { semanticsPipeline } from "../../semantics/pipeline.js";
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

  ["effectful_identity", "main"].forEach((name) => {
    const symbol = resolveSymbol(name);
    const signature = semantics.typing.functions.getSignature(symbol);
    if (!signature) {
      throw new Error(`missing signature for ${name}`);
    }
    signature.effectRow = effectRow;
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

const sanitize = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_]/g, "_");

const loadPerformSemantics = (): SemanticsPipelineResult =>
  semanticsPipeline(
    parse(readFileSync(fixturePath, "utf8"), fixtureVirtualPath)
  );

const buildFixtureEffectModule = () => {
  const semantics = loadPerformSemantics();
  const mod = new binaryen.Module();
  mod.setFeatures(binaryen.Features.All);
  const effectsRuntime = createEffectRuntime(mod);
  const outcomeValueTypes = new Map();

  const stubCtx: CodegenContext = {
    mod,
    moduleId: semantics.moduleId,
    moduleLabel: sanitize(semantics.hir.module.path),
    binding: semantics.binding,
    symbolTable: semantics.symbolTable,
    hir: semantics.hir,
    typing: semantics.typing,
    options: { optimize: false, validate: true, emitEffectHelpers: true },
    functions: new Map(),
    functionInstances: new Map(),
    itemsToSymbols: new Map(),
    structTypes: new Map(),
    fixedArrayTypes: new Map(),
    closureTypes: new Map(),
    closureFunctionTypes: new Map(),
    lambdaEnvs: new Map(),
    lambdaFunctions: new Map(),
    rtt: undefined as never,
    effectsRuntime,
    effectMir: undefined as never,
    effectLowering: undefined as never,
    outcomeValueTypes,
  };

  const effectTable = emitEffectTableSection({
    contexts: [stubCtx],
    entryModuleId: semantics.moduleId,
    mod,
  });
  addEffectRuntimeHelpers(stubCtx);

  // worker returns Outcome.effect(Log.info)
  const effectRequest = () =>
    effectsRuntime.makeEffectRequest({
      effectId: mod.i32.const(0),
      opId: mod.i32.const(0),
      resumeKind: RESUME_KIND.resume,
      args: mod.ref.null(binaryen.eqref),
      continuation: mod.ref.null(effectsRuntime.continuationType),
      tailGuard: mod.ref.null(effectsRuntime.tailGuardType),
    });

  const outcomeEffect = () => effectsRuntime.makeOutcomeEffect(effectRequest());
  const handlerParams = binaryen.createType([
    effectsRuntime.handlerFrameType,
  ]);

  mod.addFunction(
    "worker",
    handlerParams,
    effectsRuntime.outcomeType,
    [],
    outcomeEffect()
  );

  // main calls worker and forwards the outcome
  mod.addFunction(
    "emit_effect",
    handlerParams,
    effectsRuntime.outcomeType,
    [],
    mod.call(
      "worker",
      [mod.local.get(0, effectsRuntime.handlerFrameType)],
      effectsRuntime.outcomeType
    )
  );
  mod.addFunctionExport("emit_effect", "emit_effect");
  mod.validate();
  return { module: mod, effectTable };
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
      exportName: "main",
      valueType: "i32",
    });
    expect(value).toBe(8);
    expect(table.effects[0]?.label).toBe("_proj_src_effects_smoke_voyd::Log");
  });

  it("drives an effect request through a handler", async () => {
    const { module, effectTable } = buildFixtureEffectModule();
    const result = await runEffectfulExport<number>({
      wasm: module,
      exportName: "emit_effect",
      handlers: {
        "0:0:0": () => 99,
      },
    });
    expect(result.value).toBe(99);
    expect(result.table.effects[0]?.ops[0]?.resumeKind).toBe(
      RESUME_KIND.resume
    );
    expect(result.table.namesBase64).toBe(effectTable.namesBlob);
  });

  it("throws when no handler is available", async () => {
    const { module } = buildFixtureEffectModule();
    await expect(
      runEffectfulExport({
        wasm: module,
        exportName: "emit_effect",
      })
    ).rejects.toThrow(/Unhandled effect/);
  });

  it("handles an effect raised inside a callee", async () => {
    const { module } = buildFixtureEffectModule();
    let called = 0;
    const result = await runEffectfulExport<number>({
      wasm: module,
      exportName: "emit_effect",
      handlers: {
        "0:0:0": () => {
          called += 1;
          return 123;
        },
      },
    });
    expect(called).toBe(1);
    expect(result.value).toBe(123);
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
