import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import binaryen from "binaryen";
import { createVoydHost } from "@voyd-lang/js-host";
import { parse } from "../../parser/parser.js";
import { semanticsPipeline } from "../../semantics/pipeline.js";
import { createRttContext } from "../rtt/index.js";
import { createEffectRuntime } from "../effects/runtime-abi.js";
import { selectEffectsBackend } from "../effects/codegen-backend.js";
import { createEffectsState } from "../effects/state.js";
import type { CodegenContext } from "../context.js";
import {
  compileEffectFixture,
  runEffectfulExport,
  parseEffectTable,
} from "./support/effects-harness.js";
import { buildProgramCodegenView } from "../../semantics/codegen-view/index.js";
import { monomorphizeProgram } from "../../semantics/linking.js";
import { codegenProgram } from "../codegen.js";
import { DiagnosticEmitter } from "../../diagnostics/index.js";
import { createProgramHelperRegistry } from "../program-helpers.js";
import type { TypeId } from "../../semantics/ids.js";

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
const localFastPathFixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-local-fast-path.voyd"
);

const compileEffectFixtureWithCompilerOptimization = async (
  entryPath: string,
) => {
  const base = await compileEffectFixture({
    entryPath,
    codegenOptions: { effectsHostBoundary: "off" },
  });
  const modules = Array.from(base.semantics.values());
  const monomorphized = monomorphizeProgram({
    modules,
    semantics: base.semantics,
  });
  const program = buildProgramCodegenView(modules, {
    instances: monomorphized.instances,
    moduleTyping: monomorphized.moduleTyping,
  });
  const result = codegenProgram({
    program,
    entryModuleId: base.entryModuleId,
    options: { validate: true, effectsHostBoundary: "off" },
    optimization: {
      handlerClauseCaptures: new Map(),
      reachableFunctionInstances: undefined as never,
      reachableFunctionSymbols: undefined as never,
      reachableModuleLets: new Map(),
      usedTraitDispatchSignatures: new Set(),
      codegenPlan: {
        representations: {
          scalarObjectLocals: new Map(),
        },
      },
    },
  });
  if (!result.wasm) {
    throw new Error("expected validated codegen to emit wasm bytes");
  }
  return { ...result, wasm: result.wasm };
};

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
  const programHelpers = createProgramHelperRegistry();
  const structTypes = new Map();
  const structHeapTypes = new Map();
  const structuralIdCache = new Map<TypeId, TypeId | null>();
  const resolvingStructuralIds = new Set<TypeId>();
  const resolvingStructuralHeapTypes = new Set<TypeId>();
  const fixedArrayTypes = new Map();
  const moduleContexts = new Map<string, CodegenContext>();
  const ctx: CodegenContext = {
    mod,
    moduleId: semantics.moduleId,
    moduleLabel: sanitize(semantics.hir.module.path),
    program,
    module: moduleView,
    moduleContexts,
    diagnostics,
    options: {
      optimize: false,
      optimizationProfile: "aggressive",
      validate: true,
      runtimeDiagnostics: true,
      emitEffectHelpers: false,
      continuationBackend: {},
      testMode: false,
      effectsHostBoundary: "off",
      linearMemoryExport: "always",
      effectsMemoryExport: "auto",
      boundaryExports: false,
      testScope: "all",
    },
    programHelpers,
    functions: new Map(),
    functionInstances: new Map() as any,
    moduleLetGetters: new Map(),
    itemsToSymbols: new Map(),
    structTypes,
    structHeapTypes,
    abiBoxTypes: new Map(),
    structuralIdCache,
    resolvingStructuralIds,
    resolvingStructuralHeapTypes,
    fixedArrayTypes,
    closureTypes: new Map(),
    functionRefTypes: new Map(),
    recursiveBinders: new Map(),
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
      callArgTemps: new Map(),
      tempTypeIds: new Map(),
    },
    outcomeValueTypes: new Map(),
  };
  moduleContexts.set(ctx.moduleId, ctx);
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
          ? ctx.program.symbols.getName(
              ctx.program.symbols.idOf({
                moduleId: ctx.moduleId,
                symbol: site.owner.symbol,
              })
            ) ?? `${site.owner.symbol}`
          : "__lambda__",
      effect:
        ctx.program.symbols.getName(
          ctx.program.symbols.idOf({
            moduleId: ctx.moduleId,
            symbol: site.effectSymbol,
          })
        ) ?? `${site.effectSymbol}`,
      envFields: site.envFields.map((field) => ({
        name: field.name,
        sourceKind: field.sourceKind,
      })),
    }));
};

describe("effect perform lowering", { timeout: 60_000 }, () => {
  it("records liveness and continuation layouts for perform sites", () => {
    const sites = buildLoweringSnapshot();
    expect(sites.length).toBeGreaterThan(0);
    expect(sites.map((site) => site.effect)).toContain("await");
    expect(sites.every((site) => site.envFields[0]?.name === "site")).toBe(true);
    expect(
      sites.some((site) =>
        site.envFields.some((field) => field.sourceKind === "handler")
      )
    ).toBe(true);
  });

  it(
    "emits continuation env captures and effect requests in Wasm",
    async () => {
      const { module } = await compileEffectFixture({
        entryPath: fixturePath,
        codegenOptions: { emitEffectHelpers: true },
      });
      const text = module.emitText();
      expect(text).toContain("voydEffectRequest");
      expect(text).toContain("voydContEnvBase");
      expect(text).toContain("voydContEnv_");
      expect(text).toContain("__cont_");
    },
    60_000,
  );

  it("specializes simple locally handled tail effects in optimized builds", async () => {
    const unoptimized = await compileEffectFixture({
      entryPath: localFastPathFixturePath,
      codegenOptions: { effectsHostBoundary: "off" },
    });
    const specialized = await compileEffectFixtureWithCompilerOptimization(
      localFastPathFixturePath,
    );

    const unoptimizedText = unoptimized.module.emitText();
    const specializedText = specialized.module.emitText();

    expect(unoptimizedText).not.toContain("__handled_");
    expect(specializedText).toContain("__handled_");
    expect(specializedText).not.toContain("__handler_fast_");

    const host = await createVoydHost({ wasm: specialized.wasm });
    await expect(host.run<number>("direct_local")).resolves.toBe(7);
    await expect(host.run<number>("helper_local")).resolves.toBe(10);
    await expect(host.run<number>("big_local")).resolves.toBe(45);
  });

  it("does not re-evaluate guards when resuming after a perform", async () => {
    const { module } = await compileEffectFixture({ entryPath: guardFixturePath });
    if (process.env.DEBUG_EFFECTS_WAT === "1") {
      writeFileSync(
        "debug-effects-perform-guard.wat",
        module.emitText()
      );
    }
    const parsed = parseEffectTable(module);
    const hitOp = parsed.ops.find((op) => op.label.endsWith("Log.hit"));
    const awaitOp = parsed.ops.find((op) => op.label.endsWith("Async.await"));
    if (!hitOp || !awaitOp) {
      throw new Error("missing Log.hit or Async.await op entry");
    }
    let guardHits = 0;
    const result = await runEffectfulExport<number>({
      wasm: module,
      entryName: "main_effectful",
      handlers: {
        [`${hitOp.opIndex}`]: () => {
          guardHits += 1;
          return true;
        },
        [`${awaitOp.opIndex}`]: () => 10,
      },
    });
    expect(guardHits).toBe(1);
    expect(result.value).toBe(1);
  });
});
