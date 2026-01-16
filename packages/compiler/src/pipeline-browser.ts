import { buildModuleGraph } from "./modules/graph.js";
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
  if (!options.host) {
    throw new Error("ModuleHost is required in browser builds");
  }
  return buildModuleGraph({
    entryPath: options.entryPath,
    host: options.host,
    roots: options.roots,
  });
};

export const compileProgram = (
  options: CompileProgramOptions
): Promise<CompileProgramResult> =>
  compileProgramWithLoader(options, loadModuleGraph);
