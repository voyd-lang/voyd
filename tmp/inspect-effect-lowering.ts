import binaryen from "binaryen";
import { dirname, resolve } from "node:path";
import { buildModuleGraph } from "../packages/compiler/src/modules/graph.js";
import { createFsModuleHost } from "../packages/compiler/src/modules/fs-host.js";
import { analyzeModules } from "../packages/compiler/src/pipeline-shared.js";
import { monomorphizeProgram } from "../packages/compiler/src/semantics/linking.js";
import { buildProgramCodegenView } from "../packages/compiler/src/semantics/codegen-view/index.js";
import { createRttContext } from "../packages/compiler/src/codegen/rtt/index.js";
import { createEffectRuntime } from "../packages/compiler/src/codegen/effects/runtime-abi.js";
import { selectEffectsBackend } from "../packages/compiler/src/codegen/effects/codegen-backend.js";
import { createEffectsState } from "../packages/compiler/src/codegen/effects/state.js";
import { DiagnosticEmitter } from "../packages/compiler/src/diagnostics/index.js";
import { createProgramHelperRegistry } from "../packages/compiler/src/codegen/program-helpers.js";
import { buildGroupContinuationCfg } from "../packages/compiler/src/codegen/effects/continuation-cfg.js";
import type { CodegenContext } from "../packages/compiler/src/codegen/context.js";
import type { TypeId } from "../packages/compiler/src/semantics/ids.js";

const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_]/g, "_");

const main = async () => {
  const entryPath = process.argv[2];
  if (!entryPath) throw new Error("missing entry path");

  const stdRoot = resolve("/Users/drew/projects/voyd/packages/std/src");
  const host = createFsModuleHost();
  const roots = { src: dirname(entryPath), std: stdRoot };
  const graph = await buildModuleGraph({ entryPath, host, roots });
  const { semantics, diagnostics: semanticDiagnostics } = analyzeModules({ graph });
  const diagnostics = [...graph.diagnostics, ...semanticDiagnostics];

  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    throw new Error(JSON.stringify(diagnostics, null, 2));
  }

  const modules = Array.from(semantics.values());
  const monomorphized = monomorphizeProgram({ modules, semantics });
  const program = buildProgramCodegenView(modules, {
    instances: monomorphized.instances,
    moduleTyping: monomorphized.moduleTyping,
  });

  const mod = new binaryen.Module();
  mod.setFeatures(binaryen.Features.All);
  const rtt = createRttContext(mod);
  const effectsRuntime = createEffectRuntime(mod);
  const diagnosticsEmitter = new DiagnosticEmitter();
  const programHelpers = createProgramHelperRegistry();
  const structTypes = new Map();
  const structHeapTypes = new Map();
  const structuralIdCache = new Map<TypeId, TypeId | null>();
  const resolvingStructuralIds = new Set<TypeId>();
  const resolvingStructuralHeapTypes = new Set<TypeId>();
  const fixedArrayTypes = new Map();
  const moduleContexts = new Map<string, CodegenContext>();

  const codegenModules = Array.from(program.modules.values());

  const contexts: CodegenContext[] = codegenModules.map((sem) => ({
    mod,
    moduleId: sem.moduleId,
    moduleLabel: sanitize(sem.hir.module.path),
    program,
    module: sem,
    moduleContexts,
    diagnostics: diagnosticsEmitter,
    options: {
      optimize: false,
      optimizationProfile: "aggressive",
      validate: false,
      runtimeDiagnostics: true,
      emitEffectHelpers: false,
      continuationBackend: {},
      testMode: false,
      effectsHostBoundary: "off",
      linearMemoryExport: "always",
      effectsMemoryExport: "auto",
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
  }));

  contexts.forEach((ctx) => moduleContexts.set(ctx.moduleId, ctx));
  const siteCounter = { current: 0 };

  contexts.forEach((ctx) => {
    ctx.effectsBackend = selectEffectsBackend(ctx);
    ctx.effectLowering = ctx.effectsBackend.buildLowering({ ctx, siteCounter });
  });

  contexts.forEach((ctx) => {
    console.log(`MODULE ${ctx.moduleId}`);
    if (ctx.moduleId.startsWith("src::")) {
      const sourceExprs = Array.from(ctx.module.hir.expressions.values())
        .filter((expr) => expr.id <= 40)
        .map((expr) => ({
          id: expr.id,
          kind: expr.exprKind,
        }));
      console.log(JSON.stringify({ sourceExprs }, null, 2));
      console.log(
        JSON.stringify(
          {
            callArgTemps: Array.from(ctx.effectLowering.callArgTemps.entries()),
            items: Array.from(ctx.module.hir.items.values()).map((item) => ({
              id: item.id,
              kind: item.kind,
              name: "name" in item ? item.name : undefined,
              symbol: "symbol" in item ? item.symbol : undefined,
            })),
          },
          null,
          2
        )
      );
      const mainFn = Array.from(ctx.module.hir.items.values()).find(
        (item) =>
          item.kind === "function" &&
          ctx.program.symbols.getName(
            ctx.program.symbols.idOf({ moduleId: ctx.moduleId, symbol: item.symbol })
          ) === "main"
      );
      if (mainFn) {
        const mainSites = ctx.effectLowering.sites.filter((site) => {
          if (site.owner.kind !== "function") return false;
          return site.owner.symbol === mainFn.symbol;
        });
        const cfg = buildGroupContinuationCfg({
          fn: mainFn,
          groupSites: mainSites,
          ctx,
        });
        console.log(
          JSON.stringify(
            {
              cfgSitesByExpr: Array.from(ctx.module.hir.expressions.values())
                .filter((expr) => expr.id <= 40)
                .map((expr) => ({
                  exprId: expr.id,
                  kind: expr.exprKind,
                  sites: [...(cfg.sitesByExpr.get(expr.id) ?? new Set<number>())],
                }))
                .filter((entry) => entry.sites.length > 0),
              cfgSitesByStmt: Array.from(ctx.module.hir.statements.values())
                .filter((stmt) => stmt.id <= 40)
                .map((stmt) => ({
                  stmtId: stmt.id,
                  kind: stmt.kind,
                  sites: [...(cfg.sitesByStmt.get(stmt.id) ?? new Set<number>())],
                })),
            },
            null,
            2
          )
        );
      }
    }
    ctx.effectLowering.sites.forEach((site) => {
      const owner =
        site.owner.kind === "function"
          ? (ctx.program.symbols.getName(
              ctx.program.symbols.idOf({
                moduleId: ctx.moduleId,
                symbol: site.owner.symbol,
              })
            ) ?? `${site.owner.symbol}`)
          : site.owner.kind;

      console.log(
        JSON.stringify(
          {
            exprId: site.exprId,
            siteOrder: site.siteOrder,
            kind: site.kind,
            owner,
            envFields: site.envFields.map((field) => ({
              name: field.name,
              sourceKind: field.sourceKind,
              symbol: field.symbol,
              tempId: field.tempId,
              typeId: field.typeId,
            })),
          },
          null,
          2
        )
      );
    });
  });
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
