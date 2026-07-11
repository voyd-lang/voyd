import { resolve, sep } from "node:path";
import { createMemoryModuleHost } from "../../modules/memory-host.js";
import { createNodePathAdapter } from "../../modules/node-path-adapter.js";
import {
  analyzeModules,
  loadModuleGraph,
  lowerProgram,
} from "../../pipeline.js";
import { monomorphizeProgram } from "../../semantics/linking.js";
import { buildProgramCodegenView } from "../../semantics/codegen-view/index.js";
import { optimizeProgram } from "../pipeline.js";
import type { ModuleHost } from "../../modules/types.js";
import type { CodegenOptions } from "../../codegen/context.js";
import type { HirModuleLet } from "../../semantics/hir/index.js";

export const createMemoryHost = (files: Record<string, string>): ModuleHost =>
  createMemoryModuleHost({ files, pathAdapter: createNodePathAdapter() });

export const buildOptimized = async ({
  files,
  stdFiles = {},
  entryFile = "main.voyd",
  includeTests = false,
  optimizeOptions,
  transformProgram,
}: {
  files: Record<string, string>;
  stdFiles?: Record<string, string>;
  entryFile?: string;
  includeTests?: boolean;
  optimizeOptions?: CodegenOptions;
  transformProgram?: (
    program: ReturnType<typeof buildProgramCodegenView>,
  ) => void;
}) => {
  const srcRoot = resolve("/proj/src");
  const stdRoot = resolve("/proj/std");
  const host = createMemoryHost({
    ...Object.fromEntries(
      Object.entries(files).map(([fileName, source]) => [
        `${srcRoot}${sep}${fileName}`,
        source,
      ]),
    ),
    ...Object.fromEntries(
      Object.entries(stdFiles).map(([fileName, source]) => [
        `${stdRoot}${sep}${fileName}`,
        source,
      ]),
    ),
  });
  const entryPath = `${srcRoot}${sep}${entryFile}`;
  const graph = await loadModuleGraph({
    entryPath,
    roots: { src: srcRoot, std: stdRoot },
    host,
    includeTests,
  });
  const { semantics, diagnostics, tests } = analyzeModules({
    graph,
    includeTests,
    testScope: optimizeOptions?.testScope,
  });
  const firstError = [...graph.diagnostics, ...diagnostics].find(
    (diagnostic) => diagnostic.severity === "error",
  );
  if (firstError) {
    throw new Error(`${firstError.code}: ${firstError.message}`);
  }
  const { orderedModules, entry } = lowerProgram({ graph, semantics });
  const modules = orderedModules
    .map((id) => semantics.get(id))
    .filter((value): value is NonNullable<typeof value> => Boolean(value));
  const monomorphized = monomorphizeProgram({ modules, semantics });
  const program = buildProgramCodegenView(modules, {
    instances: monomorphized.instances,
    moduleTyping: monomorphized.moduleTyping,
  });
  transformProgram?.(program);
  const optimized = optimizeProgram({
    program,
    modules,
    entryModuleId: entry,
    options: optimizeOptions,
  });

  return {
    entryModuleId: entry,
    optimized,
    tests,
  };
};

export const findFunction = ({
  moduleId,
  name,
  program,
}: {
  moduleId: string;
  name: string;
  program: ReturnType<typeof buildProgramCodegenView>;
}) =>
  Array.from(program.modules.get(moduleId)?.hir.items.values() ?? []).find(
    (item) =>
      item.kind === "function" &&
      program.symbols.getName(
        program.symbols.idOf({ moduleId, symbol: item.symbol }),
      ) === name,
  );

export const findModuleLet = ({
  moduleId,
  name,
  program,
}: {
  moduleId: string;
  name: string;
  program: ReturnType<typeof buildProgramCodegenView>;
}) =>
  Array.from(program.modules.get(moduleId)?.hir.items.values() ?? []).find(
    (item): item is HirModuleLet =>
      item.kind === "module-let" &&
      program.symbols.getName(
        program.symbols.idOf({ moduleId, symbol: item.symbol }),
      ) === name,
  );

export const findObjectNominal = ({
  moduleId,
  name,
  program,
}: {
  moduleId: string;
  name: string;
  program: ReturnType<typeof buildProgramCodegenView>;
}) => {
  const item = Array.from(
    program.modules.get(moduleId)?.hir.items.values() ?? [],
  ).find(
    (candidate) =>
      candidate.kind === "object" &&
      program.symbols.getName(
        program.symbols.idOf({ moduleId, symbol: candidate.symbol }),
      ) === name,
  );
  return item?.kind === "object"
    ? program.objects.getTemplate(
        program.symbols.idOf({ moduleId, symbol: item.symbol }),
      )?.nominal
    : undefined;
};

export const getFunctionBodyValueExpr = ({
  moduleId,
  symbol,
  program,
}: {
  moduleId: string;
  symbol: number;
  program: ReturnType<typeof buildProgramCodegenView>;
}) => {
  const moduleView = program.modules.get(moduleId);
  const item = Array.from(moduleView?.hir.items.values() ?? []).find(
    (candidate) => candidate.kind === "function" && candidate.symbol === symbol,
  );
  if (!item || item.kind !== "function") {
    return undefined;
  }
  const body = moduleView?.hir.expressions.get(item.body);
  return body?.exprKind === "block" && typeof body.value === "number"
    ? moduleView?.hir.expressions.get(body.value)
    : body;
};
