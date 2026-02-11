import { buildModuleGraph } from "./modules/graph.js";
import { createFsModuleHost } from "./modules/fs-host.js";
import type { ModuleGraph } from "./modules/types.js";
import {
  compileProgramWithLoader,
  type CompileProgramOptions,
  type CompileProgramResult,
  type LoadModulesOptions,
} from "./pipeline-shared.js";

export * from "./pipeline-shared.js";

export const loadModuleGraph = async (
  options: LoadModulesOptions
): Promise<ModuleGraph> => {
  const host = options.host ?? createFsModuleHost();
  return buildModuleGraph({
    entryPath: options.entryPath,
    host,
    roots: options.roots,
    includeTests: options.includeTests,
  });
};

export const compileProgram = (
  options: CompileProgramOptions
): Promise<CompileProgramResult> =>
  compileProgramWithLoader(options, loadModuleGraph);
