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
import type { CodegenOptions } from "../context.js";
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
import type { ProgramSymbolId, TypeId } from "../../semantics/ids.js";
import { specializationPolicyForOptimizationLevel } from "../../optimization-policy.js";
import { createSpecializationReservations } from "../../optimize/codegen-plan.js";

const fixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-perform.voyd",
);
const guardFixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-perform-guard.voyd",
);
const localFastPathFixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-local-fast-path.voyd",
);
const localTailControlFlowFixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-local-tail-control-flow.voyd",
);
const localTailStdlibRngFixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-local-tail-stdlib-rng.voyd",
);
const localRecursiveFastPathFixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-local-recursive-fast-path.voyd",
);
const tailResumeArgEffectfulFixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-tail-resume-arg-effectful.voyd",
);
const defaultParameterFixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-default-parameters.voyd",
);

const compileEffectFixtureWithCompilerOptimization = async (
  entryPath: string,
  codegenOptions: CodegenOptions = { effectsHostBoundary: "off" },
) => {
  const base = await compileEffectFixture({
    entryPath,
    codegenOptions,
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
    options: { ...codegenOptions, validate: true },
    optimization: {
      handlerClauseCaptures: new Map(),
      reachableFunctionInstances: undefined as never,
      reachableFunctionSymbols: undefined as never,
      reachableModuleLets: new Map(),
      usedTraitDispatchSignatures: usedTraitDispatchSignaturesFor(program),
      receiverSpecializationRequests: new Map(),
      callShapeSpecializationRequests: new Map(),
      exactParameterTypes: new Map(),
      knownParameterTypes: new Map(),
      escapeAnalysis: { origins: new Map(), parameters: new Map() },
      runtimeTypeCheckElisionFieldAccesses: new Map(),
      semanticCopyForwardingFieldAccesses: new Map(),
      codegenPlan: {
        representations: {},
        specializationPolicy:
          specializationPolicyForOptimizationLevel("release"),
        specializationReservations: createSpecializationReservations(
          specializationPolicyForOptimizationLevel("release"),
        ),
      },
    },
  });
  if (!result.wasm) {
    throw new Error("expected validated codegen to emit wasm bytes");
  }
  return { ...result, wasm: result.wasm };
};

const usedTraitDispatchSignaturesFor = (
  program: ReturnType<typeof buildProgramCodegenView>,
): Set<string> => {
  const signatures = new Set<string>();
  program.modules.forEach((moduleView, moduleId) => {
    moduleView.hir.expressions.forEach((expr, exprId) => {
      if (expr.exprKind !== "call" && expr.exprKind !== "method-call") {
        return;
      }
      const callInfo = program.calls.getCallInfo(moduleId, exprId);
      if (!callInfo.traitDispatch) {
        return;
      }
      callInfo.targets?.forEach((target) => {
        const mapping = program.traits.getTraitMethodImpl(
          target as ProgramSymbolId,
        );
        if (!mapping) {
          return;
        }
        signatures.add(`${mapping.traitSymbol}:${mapping.traitMethodSymbol}`);
      });
    });
  });
  return signatures;
};

const loadSemantics = () =>
  semanticsPipeline(
    parse(readFileSync(fixturePath, "utf8"), "/proj/src/effects-perform.voyd"),
  );

const sanitize = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_]/g, "_");

const extractWatFunction = (wat: string, namePattern: RegExp): string => {
  const header = wat.match(namePattern)?.[0];
  if (!header) {
    throw new Error(`missing Wasm function matching ${namePattern}`);
  }
  const start = wat.indexOf(header);
  let depth = 0;
  for (let index = start; index < wat.length; index += 1) {
    if (wat[index] === "(") depth += 1;
    if (wat[index] === ")") depth -= 1;
    if (depth === 0) return wat.slice(start, index + 1);
  }
  throw new Error(`unterminated Wasm function matching ${namePattern}`);
};

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
      optimizationLevel: "none",
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
      symbolsLiveAcrossSuspension: new Set(),
      callArgTemps: new Map(),
      tempTypeIds: new Map(),
      defaultParamTemps: new Map(),
    },
    outcomeValueTypes: new Map(),
    specializationPolicy: specializationPolicyForOptimizationLevel("none"),
    specializationReservations: createSpecializationReservations(
      specializationPolicyForOptimizationLevel("none"),
    ),
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
          ? (ctx.program.symbols.getName(
              ctx.program.symbols.idOf({
                moduleId: ctx.moduleId,
                symbol: site.owner.symbol,
              }),
            ) ?? `${site.owner.symbol}`)
          : "__lambda__",
      effect:
        ctx.program.symbols.getName(
          ctx.program.symbols.idOf({
            moduleId: ctx.moduleId,
            symbol: site.effectSymbol,
          }),
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
    expect(sites.every((site) => site.envFields[0]?.name === "site")).toBe(
      true,
    );
    expect(
      sites.some((site) =>
        site.envFields.some((field) => field.sourceKind === "handler"),
      ),
    ).toBe(true);
  });

  it("emits continuation env captures and effect requests in Wasm", async () => {
    const { module } = await compileEffectFixture({
      entryPath: fixturePath,
      codegenOptions: { emitEffectHelpers: true },
    });
    const text = module.emitText();
    expect(text).toContain("voydEffectRequest");
    expect(text).toContain("voydContEnvBase");
    expect(text).toContain("voydContEnv_");
    expect(text).toContain("__cont_");
  }, 60_000);

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

  it("removes the residual effect ABI from fully handled recursive call graphs", async () => {
    const unoptimized = await compileEffectFixture({
      entryPath: localRecursiveFastPathFixturePath,
      codegenOptions: { effectsHostBoundary: "off" },
    });
    const specialized = await compileEffectFixtureWithCompilerOptimization(
      localRecursiveFastPathFixturePath,
    );
    const text = specialized.module.emitText();

    const selfWorker = extractWatFunction(
      text,
      /\(func \$[^\s]*self_worker_\d+__handled[^\s]*/,
    );
    const mutualEven = extractWatFunction(
      text,
      /\(func \$[^\s]*mutual_even_\d+__handled[^\s]*/,
    );
    const mutualOdd = extractWatFunction(
      text,
      /\(func \$[^\s]*mutual_odd_\d+__handled[^\s]*/,
    );
    const residualEven = extractWatFunction(
      text,
      /\(func \$[^\s]*residual_even_\d+__handled[^\s]*/,
    );
    for (const pureSpecialization of [selfWorker, mutualEven, mutualOdd]) {
      expect(pureSpecialization).not.toContain("$voydHandlerFrame");
      expect(pureSpecialization).not.toContain("$voydOutcome");
      expect(pureSpecialization).toContain("return_call");
    }
    expect(selfWorker).toMatch(/return_call \$[^\s]*self_worker_/);
    expect(mutualEven).toMatch(/return_call \$[^\s]*mutual_odd_/);
    expect(mutualOdd).toMatch(/return_call \$[^\s]*mutual_even_/);
    expect(residualEven).toContain("$voydHandlerFrame");
    expect(residualEven).toContain("$voydOutcome");

    const unoptimizedHost = await createVoydHost({ wasm: unoptimized.wasm });
    const specializedHost = await createVoydHost({ wasm: specialized.wasm });
    for (const [entry, expected] of [
      ["self_recursive", 10001],
      ["mutually_recursive", 10001],
    ] as const) {
      await expect(unoptimizedHost.run<number>(entry)).resolves.toBe(expected);
      await expect(specializedHost.run<number>(entry)).resolves.toBe(expected);
    }
    const [unoptimizedBoundary, specializedBoundary] = await Promise.all([
      compileEffectFixture({ entryPath: localRecursiveFastPathFixturePath }),
      compileEffectFixtureWithCompilerOptimization(
        localRecursiveFastPathFixturePath,
        {},
      ),
    ]);
    for (const wasm of [unoptimizedBoundary.wasm, specializedBoundary.wasm]) {
      const result = await runEffectfulExport<number>({
        wasm,
        entryName: "residual_recursive",
        handlersByLabelSuffix: {
          "Residual::read": () => 40,
        },
      });
      expect(result.value).toBe(41);
    }
  });

  it("preserves local tail continuations through value construction and control flow", async () => {
    const compiled = await compileEffectFixture({
      entryPath: localTailControlFlowFixturePath,
      codegenOptions: { effectsHostBoundary: "off" },
    });

    const host = await createVoydHost({ wasm: compiled.wasm });
    await expect(host.run<number>("triple_sum")).resolves.toBe(6);
    await expect(host.run<number>("loop_local")).resolves.toBe(10);
    await expect(host.run<number>("match_local")).resolves.toBe(14);
  });

  it("specializes locally handled tail effects through value construction and control flow", async () => {
    const specialized = await compileEffectFixtureWithCompilerOptimization(
      localTailControlFlowFixturePath,
    );

    const text = specialized.module.emitText();
    expect(text).toMatch(/make_triple_\d+__handled/);
    expect(text).toMatch(/loop_sum_\d+__handled/);
    expect(text).toMatch(/match_value_\d+__handled/);
    expect(text).toMatch(/open_sum_\d+__handled/);
    expect(text).toMatch(
      /local_then_dynamic_\d+(?:__receiver_[^\s)]*)?__handled/,
    );

    const host = await createVoydHost({ wasm: specialized.wasm });
    await expect(host.run<number>("triple_sum")).resolves.toBe(6);
    await expect(host.run<number>("loop_local")).resolves.toBe(10);
    await expect(host.run<number>("match_local")).resolves.toBe(14);

    const hostBoundary = await compileEffectFixtureWithCompilerOptimization(
      localTailControlFlowFixturePath,
      {},
    );
    const openResult = await runEffectfulExport<number>({
      wasm: hostBoundary.wasm,
      entryName: "open_local",
      handlersByLabelSuffix: {
        "Other::bump": (_request, value) => (value as number) + 20,
      },
    });
    expect(openResult.value).toBe(26);
    const dynamicResult = await runEffectfulExport<number>({
      wasm: hostBoundary.wasm,
      entryName: "dynamic_trait_residual",
      handlersByLabelSuffix: {
        "Other::bump": (_request, value) => (value as number) + 20,
      },
    });
    expect(dynamicResult.value).toBe(27);
  });

  it("preserves mutable std value captures in static local tail handlers", async () => {
    const unoptimized = await compileEffectFixture({
      entryPath: localTailStdlibRngFixturePath,
      codegenOptions: { effectsHostBoundary: "off" },
    });
    const specialized = await compileEffectFixtureWithCompilerOptimization(
      localTailStdlibRngFixturePath,
    );
    const specializedText = specialized.module.emitText();
    expect(specializedText).toMatch(/random_triple_\d+__handled/);

    const unoptimizedHost = await createVoydHost({ wasm: unoptimized.wasm });
    const specializedHost = await createVoydHost({ wasm: specialized.wasm });
    const expectedValues = new Map([
      ["rand_plain", 0.000005046497183913701],
      ["rand_range", 0.0000025232485919568504],
      ["rand_triple_sum", 0.4670804432993078],
    ]);
    for (const [entry, expectedValue] of expectedValues) {
      const expected = await unoptimizedHost.run<number>(entry);
      expect(expected).toBe(expectedValue);
      await expect(specializedHost.run<number>(entry)).resolves.toBe(expected);
    }
  });

  it("captures effectful tail resume arguments inside handler clauses", async () => {
    const { wasm } = await compileEffectFixture({
      entryPath: tailResumeArgEffectfulFixturePath,
      codegenOptions: { effectsHostBoundary: "off" },
    });
    const host = await createVoydHost({ wasm });

    await expect(
      host.run<number>("tail_resume_arg_effectful_internal"),
    ).resolves.toBe(41);
    await expect(
      host.run<number>("effectful_resume_arg_internal"),
    ).resolves.toBe(41);
  });

  it("resumes effectful default parameter initialization before the function body", async () => {
    const { wasm } = await compileEffectFixture({
      entryPath: defaultParameterFixturePath,
      codegenOptions: { effectsHostBoundary: "off" },
    });
    const host = await createVoydHost({ wasm });

    await expect(host.run<number>("main")).resolves.toBe(78);
    await expect(host.run<number>("provided_later_default")).resolves.toBe(79);
    await expect(host.run<number>("two_effectful_defaults")).resolves.toBe(77);
    await expect(host.run<number>("default_local_capture")).resolves.toBe(42);
  });

  it("does not re-evaluate guards when resuming after a perform", async () => {
    const { module } = await compileEffectFixture({
      entryPath: guardFixturePath,
    });
    if (process.env.DEBUG_EFFECTS_WAT === "1") {
      writeFileSync("debug-effects-perform-guard.wat", module.emitText());
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
