import path from "node:path";
import net from "node:net";
import binaryen from "binaryen";
import { createFsModuleHost } from "@voyd-lang/compiler/modules/fs-host.js";
import { createMemoryModuleHost } from "@voyd-lang/compiler/modules/memory-host.js";
import { createNodePathAdapter } from "@voyd-lang/compiler/modules/node-path-adapter.js";
import type { ModuleHost, ModuleRoots } from "@voyd-lang/compiler/modules/types.js";
import { loadModuleGraph } from "@voyd-lang/compiler/pipeline.js";
import { resolveStdRoot } from "@voyd-lang/lib/resolve-std.js";
import { compileWithLoader } from "./shared/compile.js";
import {
  createHost,
  registerHandlers,
  registerHandlersByLabelSuffix,
  runWithHandlers,
} from "./shared/host.js";
import { createCompileResult } from "./shared/result.js";
import type { CompileArtifactsSuccess } from "./shared/compile.js";
import {
  createUnexpectedDiagnostic,
  diagnosticsFromUnknownError,
} from "./shared/diagnostics.js";
import { detectSrcRootForPath } from "./shared/source-root.js";
import type {
  CompileOptions,
  CompileResult,
  DefaultAdapterOptions,
  ServeWebAppOptions,
  ServeWebAppResult,
  VoydSdk,
} from "./shared/types.js";

export { detectSrcRootForPath } from "./shared/source-root.js";

const DEFAULT_ENTRY = "index.voyd";
const DEFAULT_VIRTUAL_ROOT = ".voyd";

export const createSdk = (): VoydSdk => ({
  compile: compileSdk,
  run: runWithHandlers,
  serveWebApp,
});

export const serveWebApp = async (
  options: ServeWebAppOptions,
): Promise<ServeWebAppResult> => {
  const result = await compileSdk(options);
  if (!result.success) {
    return result;
  }

  const {
    entryName = "main",
    host = "127.0.0.1",
    port,
    readinessTimeoutMs = 5_000,
    run = {},
  } = options;
  const previousPort = process.env.VOYD_WEB_PORT;
  const previousHost = process.env.VOYD_WEB_HOST;
  process.env.VOYD_WEB_PORT = String(port);
  process.env.VOYD_WEB_HOST = host;
  const hostRuntime = await createHost({
    wasm: result.wasm,
    imports: run.imports,
    bufferSize: run.bufferSize,
    defaultAdapters: webAppDefaultAdapters(run.defaultAdapters),
  });
  if (run.handlersByLabelSuffix) {
    registerHandlersByLabelSuffix({
      host: hostRuntime,
      handlersByLabelSuffix: run.handlersByLabelSuffix,
    });
  }
  if (run.handlers) {
    registerHandlers({ host: hostRuntime, handlers: run.handlers });
  }

  const started = hostRuntime.runManaged(entryName, run.args);
  const closed = started.outcome
    .then((outcome) => {
      if (outcome.kind === "value") {
        return outcome.value;
      }
      if (outcome.kind === "failed") {
        throw outcome.error;
      }
      return undefined;
    })
    .finally(() => {
      restoreEnv("VOYD_WEB_PORT", previousPort);
      restoreEnv("VOYD_WEB_HOST", previousHost);
    });
  const ready = waitForTcpPort({ host, port, timeoutMs: readinessTimeoutMs });
  const close = (reason: unknown = "serveWebApp closed"): Promise<unknown> => {
    started.cancel(reason);
    return closed;
  };

  try {
    await Promise.race([
      ready,
      closed.then(() => {
        throw new Error("web app exited before it was ready");
      }),
    ]);
  } catch (error) {
    started.cancel(error);
    await closed.catch(() => undefined);
    throw error;
  }

  return {
    success: true,
    result,
    host,
    port,
    url: `http://${host}:${port}`,
    ready,
    closed,
    running: closed,
    close,
  };
};

const webAppDefaultAdapters = (
  defaultAdapters: boolean | DefaultAdapterOptions | undefined,
): boolean | DefaultAdapterOptions => {
  if (defaultAdapters === false) {
    return false;
  }
  if (defaultAdapters === undefined || defaultAdapters === true) {
    return { runtime: "node" };
  }
  return { runtime: "node", ...defaultAdapters };
};

const waitForTcpPort = async ({
  host,
  port,
  timeoutMs,
}: {
  host: string;
  port: number;
  timeoutMs: number;
}): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      await probeTcpPort({ host, port });
      return;
    } catch (error) {
      lastError = error;
      await delay(25);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`timed out waiting for ${host}:${port}`);
};

const probeTcpPort = ({ host, port }: { host: string; port: number }): Promise<void> =>
  new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    socket.once("connect", () => {
      socket.end();
      resolve();
    });
    socket.once("error", reject);
    socket.setTimeout(1_000, () => {
      socket.destroy(new Error(`timed out connecting to ${host}:${port}`));
    });
  });

const delay = (millis: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, millis));

const restoreEnv = (key: string, value: string | undefined): void => {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
};

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
    const entryPath = resolveEntryPath({
      entryPath: entryName,
      srcRoot,
      source: options.source,
    });
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
    const runtimeDiagnostics = resolveRuntimeDiagnostics({
      runtimeDiagnostics: options.runtimeDiagnostics,
    });
    const result = await compileWithLoader({
      entryPath,
      roots,
      host,
      includeTests: options.includeTests,
      testsOnly: options.testsOnly,
      testScope,
      optimize: options.optimize,
      runtimeDiagnostics,
      loadModuleGraph,
      boundaryExports: options.boundaryExports,
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

const resolveRuntimeDiagnostics = ({
  runtimeDiagnostics,
}: {
  runtimeDiagnostics?: boolean;
}): boolean => runtimeDiagnostics ?? false;

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
    return detectSrcRootForPath(entryPath);
  }

  if (path.isAbsolute(entryPath)) {
    return detectSrcRootForPath(entryPath);
  }

  return path.resolve(process.cwd(), DEFAULT_VIRTUAL_ROOT);
};

const resolveEntryPath = ({
  entryPath,
  srcRoot,
  source,
}: {
  entryPath: string;
  srcRoot: string;
  source?: string;
}): string => {
  const normalized = ensureVoydExtension(entryPath);
  const resolved = path.isAbsolute(normalized)
    ? normalized
    : source === undefined
    ? path.resolve(normalized)
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
  if (!options.emitWasmText) {
    return result;
  }

  const module = binaryen.readBinary(result.wasm);
  const wasmText = options.emitWasmText ? module.emitText() : undefined;

  return wasmText ? { ...result, wasmText } : result;
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
  DefaultAdapterOptions,
  EffectsInfo,
  EffectContinuation,
  EffectContinuationCall,
  EffectHandler,
  HostProtocolTable,
  ModuleRoots,
  RunOptions,
  ServeWebAppOptions,
  ServeWebAppResult,
  ServeWebAppSuccessResult,
  SignatureHash,
  TestCase,
  TestCollection,
  TestEvent,
  TestInfo,
  TestReporter,
  TestResult,
  TestRunOptions,
  TestRunSummary,
  VoydRuntimeDiagnostics,
  VoydRuntimeError,
  VoydSdk,
} from "./shared/types.js";
