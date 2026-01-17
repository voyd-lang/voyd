import path from "node:path";
import binaryen from "binaryen";
import { createFsModuleHost } from "@voyd/compiler/modules/fs-host.js";
import { createMemoryModuleHost } from "@voyd/compiler/modules/memory-host.js";
import { createNodePathAdapter } from "@voyd/compiler/modules/node-path-adapter.js";
import type { ModuleHost, ModuleRoots } from "@voyd/compiler/modules/types.js";
import { loadModuleGraph } from "@voyd/compiler/pipeline.js";
import { resolveStdRoot } from "@voyd/lib/resolve-std.js";
import { compileWithLoader } from "./shared/compile.js";
import { createHost, runWithHandlers } from "./shared/host.js";
import type { CompileOptions, CompileResult, VoydSdk } from "./shared/types.js";

const DEFAULT_ENTRY = "index.voyd";
const DEFAULT_VIRTUAL_ROOT = ".voyd";

export const createSdk = (): VoydSdk => ({
  compile: compileSdk,
  createHost,
  run: runWithHandlers,
});

const compileSdk = async (options: CompileOptions): Promise<CompileResult> => {
  if (!options.entryPath && options.source === undefined) {
    throw new Error("compile requires entryPath or source");
  }

  const entryName = options.entryPath ?? DEFAULT_ENTRY;
  const srcRoot = resolveSrcRoot({
    roots: options.roots,
    entryPath: entryName,
    source: options.source,
  });
  const entryPath = resolveEntryPath({ entryPath: entryName, srcRoot });
  const roots = resolveRoots({ roots: options.roots, srcRoot });
  const host = options.source
    ? createOverlayModuleHost({
        primary: createMemoryModuleHost({
          files: buildMemoryFiles({
            entryPath,
            source: options.source,
            files: options.files ?? {},
            srcRoot,
          }),
          pathAdapter: createNodePathAdapter(),
        }),
        fallback: createFsModuleHost(),
      })
    : createFsModuleHost();

  const result = await compileWithLoader({
    entryPath,
    roots,
    host,
    includeTests: options.includeTests,
    loadModuleGraph,
  });

  return finalizeCompile({ options, result });
};

const resolveSrcRoot = ({
  roots,
  entryPath,
  source,
}: {
  roots?: ModuleRoots;
  entryPath: string;
  source?: string;
}): string => {
  if (roots?.src) {
    return path.resolve(roots.src);
  }

  if (!source) {
    return path.dirname(path.resolve(entryPath));
  }

  if (path.isAbsolute(entryPath)) {
    return path.dirname(path.resolve(entryPath));
  }

  return path.resolve(process.cwd(), DEFAULT_VIRTUAL_ROOT);
};

const resolveEntryPath = ({
  entryPath,
  srcRoot,
}: {
  entryPath: string;
  srcRoot: string;
}): string => {
  const normalized = ensureVoydExtension(entryPath);
  const resolved = path.isAbsolute(normalized)
    ? normalized
    : path.join(srcRoot, normalized);
  return path.resolve(resolved);
};

const resolveRoots = ({
  roots,
  srcRoot,
}: {
  roots?: ModuleRoots;
  srcRoot: string;
}): ModuleRoots => ({
  src: srcRoot,
  std: roots?.std ? path.resolve(roots.std) : resolveStdRoot(),
  pkg: roots?.pkg ? path.resolve(roots.pkg) : roots?.pkg,
  resolvePackageRoot: roots?.resolvePackageRoot,
});

const buildMemoryFiles = ({
  entryPath,
  source,
  files,
  srcRoot,
}: {
  entryPath: string;
  source: string;
  files: Record<string, string>;
  srcRoot: string;
}): Record<string, string> => ({
  ...normalizeFiles({ files, srcRoot }),
  [entryPath]: source,
});

const normalizeFiles = ({
  files,
  srcRoot,
}: {
  files: Record<string, string>;
  srcRoot: string;
}): Record<string, string> =>
  Object.fromEntries(
    Object.entries(files).map(([filePath, source]) => [
      resolveFilePath({ filePath, srcRoot }),
      source,
    ])
  );

const resolveFilePath = ({
  filePath,
  srcRoot,
}: {
  filePath: string;
  srcRoot: string;
}): string => {
  const normalized = ensureVoydExtension(filePath);
  const resolved = path.isAbsolute(normalized)
    ? normalized
    : path.join(srcRoot, normalized);
  return path.resolve(resolved);
};

const ensureVoydExtension = (value: string): string =>
  value.endsWith(".voyd") ? value : `${value}.voyd`;

const finalizeCompile = ({
  options,
  result,
}: {
  options: CompileOptions;
  result: CompileResult;
}): CompileResult => {
  if (!options.optimize && !options.emitWasmText) {
    return result;
  }

  const module = binaryen.readBinary(result.wasm);
  if (options.optimize) {
    binaryen.setShrinkLevel(3);
    binaryen.setOptimizeLevel(3);
    module.optimize();
  }

  const wasm = options.optimize ? emitBinary(module) : result.wasm;
  const wasmText = options.emitWasmText ? module.emitText() : undefined;

  return wasmText ? { ...result, wasm, wasmText } : { ...result, wasm };
};

const emitBinary = (module: binaryen.Module): Uint8Array => {
  const emitted = module.emitBinary();
  if (emitted instanceof Uint8Array) return emitted;
  return (
    (emitted as { output?: Uint8Array }).output ??
    (emitted as { binary?: Uint8Array }).binary ??
    new Uint8Array()
  );
};

const createOverlayModuleHost = ({
  primary,
  fallback,
}: {
  primary: ModuleHost;
  fallback: ModuleHost;
}): ModuleHost => ({
  path: primary.path,
  readFile: async (filePath: string) =>
    (await primary.fileExists(filePath))
      ? primary.readFile(filePath)
      : fallback.readFile(filePath),
  readDir: async (dirPath: string) => {
    const [primaryDir, fallbackDir] = await Promise.all([
      primary.isDirectory(dirPath),
      fallback.isDirectory(dirPath),
    ]);

    if (!primaryDir && !fallbackDir) {
      return [];
    }

    const [primaryEntries, fallbackEntries] = await Promise.all([
      primaryDir ? primary.readDir(dirPath) : Promise.resolve([]),
      fallbackDir ? fallback.readDir(dirPath) : Promise.resolve([]),
    ]);

    return Array.from(new Set([...primaryEntries, ...fallbackEntries]));
  },
  fileExists: async (filePath: string) =>
    (await primary.fileExists(filePath)) || fallback.fileExists(filePath),
  isDirectory: async (dirPath: string) =>
    (await primary.isDirectory(dirPath)) || fallback.isDirectory(dirPath),
});

export type {
  CompileOptions,
  CompileResult,
  EffectHandler,
  HostInitOptions,
  ModuleRoots,
  RunOptions,
  VoydHost,
  VoydSdk,
} from "./shared/types.js";
