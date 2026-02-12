import path from "node:path";
import binaryen from "binaryen";
import { createFsModuleHost } from "@voyd/compiler/modules/fs-host.js";
import { createMemoryModuleHost } from "@voyd/compiler/modules/memory-host.js";
import { createNodePathAdapter } from "@voyd/compiler/modules/node-path-adapter.js";
import type { ModuleHost, ModuleRoots } from "@voyd/compiler/modules/types.js";
import { loadModuleGraph } from "@voyd/compiler/pipeline.js";
import { resolveStdRoot } from "@voyd/lib/resolve-std.js";
import { compileWithLoader } from "./shared/compile.js";
import { runWithHandlers } from "./shared/host.js";
import { createCompileResult } from "./shared/result.js";
import type { CompileArtifactsSuccess } from "./shared/compile.js";
import {
  createUnexpectedDiagnostic,
  diagnosticsFromUnknownError,
} from "./shared/diagnostics.js";
import type { CompileOptions, CompileResult, VoydSdk } from "./shared/types.js";

const DEFAULT_ENTRY = "index.voyd";
const DEFAULT_VIRTUAL_ROOT = ".voyd";
const RUNTIME_BINARYEN_FEATURES =
  binaryen.Features.GC |
  binaryen.Features.ReferenceTypes |
  binaryen.Features.TailCall |
  binaryen.Features.Multivalue |
  binaryen.Features.BulkMemory |
  binaryen.Features.SignExt |
  binaryen.Features.MutableGlobals |
  binaryen.Features.ExtendedConst;

export const createSdk = (): VoydSdk => ({
  compile: compileSdk,
  run: runWithHandlers,
});

const compileSdk = async (options: CompileOptions): Promise<CompileResult> => {
  if (!options.entryPath && options.source === undefined) {
    return {
      success: false,
      diagnostics: [
        createUnexpectedDiagnostic({
          message: "compile requires entryPath or source",
          file: "<sdk>",
        }),
      ],
    };
  }

  const entryName = options.entryPath ?? DEFAULT_ENTRY;

  try {
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

    const testScope = options.testScope ?? (options.source ? "entry" : "all");
    const result = await compileWithLoader({
      entryPath,
      roots,
      host,
      includeTests: options.includeTests,
      testsOnly: options.testsOnly,
      testScope,
      loadModuleGraph,
    });

    if (!result.success) {
      return result;
    }

    const finalized = finalizeCompile({ options, result });
    return createCompileResult(finalized);
  } catch (error) {
    return {
      success: false,
      diagnostics: diagnosticsFromUnknownError({
        error,
        fallbackFile: entryName,
      }),
    };
  }
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
    if (path.isAbsolute(entryPath)) {
      return path.dirname(path.resolve(entryPath));
    }
    return path.resolve(process.cwd());
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
  pkgDirs: resolvePackageDirs({ roots, srcRoot }),
  resolvePackageRoot: roots?.resolvePackageRoot,
});

const resolvePackageDirs = ({
  roots,
  srcRoot,
}: {
  roots?: ModuleRoots;
  srcRoot: string;
}): string[] => {
  const configured = [
    ...(roots?.pkgDirs ?? []),
    ...(roots?.pkg ? [roots.pkg] : []),
  ].map((dir) => path.resolve(dir));
  const nodeModulesDirs = collectNodeModulesDirs(srcRoot);
  return dedupePaths([...configured, ...nodeModulesDirs]);
};

export const collectNodeModulesDirs = (startDir: string): string[] => {
  const dirs: string[] = [];
  let current = path.resolve(startDir);
  while (true) {
    dirs.push(path.join(current, "node_modules"));
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return dirs;
};

const dedupePaths = (paths: readonly string[]): string[] =>
  Array.from(new Set(paths));

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
  result: CompileArtifactsSuccess;
}): CompileArtifactsSuccess => {
  if (!options.optimize && !options.emitWasmText) {
    return result;
  }

  const module = binaryen.readBinary(result.wasm);
  module.setFeatures(RUNTIME_BINARYEN_FEATURES);
  if (options.optimize) {
    binaryen.setShrinkLevel(3);
    binaryen.setOptimizeLevel(3);
    module.optimize();
  }

  const wasm = options.optimize ? emitBinary(module) : result.wasm;
  const wasmText = options.emitWasmText ? module.emitText() : undefined;
  let testsWasm = result.testsWasm;
  if (options.optimize && result.testsWasm) {
    const testsModule = binaryen.readBinary(result.testsWasm);
    testsModule.setFeatures(RUNTIME_BINARYEN_FEATURES);
    testsModule.optimize();
    testsWasm = emitBinary(testsModule);
  }

  const updated = { ...result, wasm, testsWasm };
  return wasmText ? { ...updated, wasmText } : updated;
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
  EffectsInfo,
  EffectContinuation,
  EffectContinuationCall,
  EffectHandler,
  HostProtocolTable,
  ModuleRoots,
  RunOptions,
  SignatureHash,
  TestCase,
  TestCollection,
  TestEvent,
  TestInfo,
  TestReporter,
  TestResult,
  TestRunOptions,
  TestRunSummary,
  VoydSdk,
} from "./shared/types.js";
