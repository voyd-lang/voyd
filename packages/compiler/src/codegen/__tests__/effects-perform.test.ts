import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import binaryen from "binaryen";
import { parse } from "../../parser/parser.js";
import { semanticsPipeline } from "../../semantics/pipeline.js";
import { codegen } from "../index.js";
import { createRttContext } from "../rtt/index.js";
import { createEffectRuntime } from "../effects/runtime-abi.js";
import { selectEffectsBackend } from "../effects/codegen-backend.js";
import { createEffectsState } from "../effects/state.js";
import type { CodegenContext } from "../context.js";
import { runEffectfulExport } from "./support/effects-harness.js";
import { buildProgramCodegenView } from "../../semantics/codegen-view/index.js";
import { DiagnosticEmitter } from "../../diagnostics/index.js";

const fixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-perform.voyd"
);
const guardFixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-perform-guard.voyd"
);

const loadSemantics = () =>
  semanticsPipeline(parse(readFileSync(fixturePath, "utf8"), "/proj/src/effects-perform.voyd"));

const sanitize = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_]/g, "_");

const buildLoweringSnapshot = () => {
  const semantics = loadSemantics();
  const program = buildProgramCodegenView([semantics]);
  const moduleView = program.modules.get(semantics.moduleId);
  if (!moduleView) {
    throw new Error("missing module view");
  }
  const mod = new binaryen.Module();
  mod.setFeatures(binaryen.Features.All);
  const rtt = createRttContext(mod);
  const effectsRuntime = createEffectRuntime(mod);
  const diagnostics = new DiagnosticEmitter();
  const ctx: CodegenContext = {
    mod,
    moduleId: semantics.moduleId,
    moduleLabel: sanitize(semantics.hir.module.path),
    program,
    module: moduleView,
    diagnostics,
    options: {
      optimize: false,
      validate: true,
      emitEffectHelpers: false,
      continuationBackend: {},
    },
    functions: new Map(),
    functionInstances: new Map() as any,
    itemsToSymbols: new Map(),
    structTypes: new Map(),
    fixedArrayTypes: new Map(),
    closureTypes: new Map(),
    functionRefTypes: new Map(),
    runtimeTypeRegistry: new Map(),
    runtimeTypeIds: { byKey: new Map(), nextId: { value: 1 } },
    lambdaEnvs: new Map(),
    lambdaFunctions: new Map(),
    rtt,
    effectsRuntime,
    effectsBackend: undefined as any,
    effectsState: createEffectsState(),
    effectLowering: {
      sitesByExpr: new Map(),
      sites: [],
      argsTypes: new Map(),
      callArgTemps: new Map(),
      tempTypeIds: new Map(),
    },
    outcomeValueTypes: new Map(),
  };
  ctx.effectsBackend = selectEffectsBackend(ctx);
  ctx.effectLowering = ctx.effectsBackend.buildLowering({
    ctx,
    siteCounter: { current: 0 },
  });
  return ctx.effectLowering.sites
    .filter((site) => site.kind === "perform")
    .map((site) => ({
      siteOrder: site.siteOrder,
      function:
        site.owner.kind === "function"
          ? ctx.program.symbols.getLocalName(ctx.moduleId, site.owner.symbol) ??
            `${site.owner.symbol}`
          : "__lambda__",
      effect: ctx.program.symbols.getLocalName(ctx.moduleId, site.effectSymbol) ??
        `${site.effectSymbol}`,
      envFields: site.envFields.map((field) => ({
        name: field.name,
        sourceKind: field.sourceKind,
      })),
    }));
};

describe("effect perform lowering", () => {
  it("records liveness and continuation layouts for perform sites", () => {
    const sites = buildLoweringSnapshot();
    expect(sites.length).toBeGreaterThan(0);
    expect(sites.map((site) => site.effect)).toContain("Async");
    expect(sites.every((site) => site.envFields[0]?.name === "site")).toBe(true);
    expect(
      sites.some((site) =>
        site.envFields.some((field) => field.sourceKind === "handler")
      )
    ).toBe(true);
  });

  it("emits continuation env captures and effect requests in Wasm", () => {
    const { module } = codegen(loadSemantics(), { emitEffectHelpers: true });
    const text = module.emitText();
    expect(text).toContain("voydEffectRequest");
    expect(text).toContain("voydContEnvBase");
    expect(text).toContain("voydContEnv_");
    expect(text).toContain("__cont_");
  });

  it("does not re-evaluate guards when resuming after a perform", async () => {
    const semantics = semanticsPipeline(
      parse(readFileSync(guardFixturePath, "utf8"), "/proj/src/effects-perform-guard.voyd")
    );
    const { module } = codegen(semantics);
    if (process.env.DEBUG_EFFECTS_WAT === "1") {
      writeFileSync(
        "debug-effects-perform-guard.wat",
        module.emitText()
      );
    }
    let guardHits = 0;
    const result = await runEffectfulExport<number>({
      wasm: module,
      entryName: "main_effectful",
      handlers: {
        "0:0:0": () => {
          guardHits += 1;
          return true;
        },
        "1:0:0": () => 10,
      },
    });
    expect(guardHits).toBe(1);
    expect(result.value).toBe(1);
  });
});
