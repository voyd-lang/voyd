// NOTE: Browser integration needs a proper portability layer. The current pipeline
// still pulls in Node-only APIs (e.g. node:path) via module graph/build logic.
// Plan: define compiler-level interfaces for the patterns we use (path handling,
// module IO, etc.), provide a Node-backed implementation for CLI/tests, and add
// a browser implementation (URL-style paths + in-memory host). Then expose a
// browser-friendly entrypoint in @voyd/compiler so @voyd/browser-compiler stays thin.
import binaryen from "binaryen";
import { analyzeModules, emitProgram, loadModuleGraph } from "@voyd/compiler/pipeline.js";
import { codegenErrorToDiagnostic } from "@voyd/compiler/codegen/diagnostics.js";
import type { CodegenOptions } from "@voyd/compiler/codegen/context.js";
import { formatDiagnostic } from "@voyd/compiler/diagnostics/index.js";
import type { ModuleHost, ModuleRoots } from "@voyd/compiler/modules/types.js";

const STD_ROOT = "/std";
const SRC_ROOT = "/src";
const DEFAULT_ENTRY = "index.voyd";

const STD_SOURCES = import.meta.glob<string>("/packages/std/src/**/*.voyd", {
  as: "raw",
  eager: true,
});

export type BrowserCompileOptions = {
  entryPath?: string;
  files?: Record<string, string>;
  roots?: ModuleRoots;
  codegenOptions?: CodegenOptions;
  entryModuleId?: string;
};

export type ParsedModule = {
  files: Record<string, string>;
  entryPath: string;
  roots?: ModuleRoots;
};

export const compile = async (
  text: string,
  options: BrowserCompileOptions = {}
): Promise<binaryen.Module> => {
  const parsedModule = await browserParseModule(text, options);
  return compileParsedModule(parsedModule, options);
};

export const compileParsedModule = async (
  module: ParsedModule,
  options: BrowserCompileOptions = {}
): Promise<binaryen.Module> => {
  const roots = normalizeRoots(module.roots);
  const host = createMemoryHost(normalizeFileMap(module.files));
  const entryPath = normalizeEntryPath(module.entryPath, roots);
  const graph = await loadModuleGraph({
    entryPath,
    host,
    roots,
  });
  const { semantics, diagnostics: semanticDiagnostics } = analyzeModules({ graph });
  const diagnostics = [...graph.diagnostics, ...semanticDiagnostics];
  const error = diagnostics.find((diag) => diag.severity === "error");
  if (error) {
    throw new Error(formatDiagnostic(error));
  }

  try {
    const result = await emitProgram({
      graph,
      semantics,
      codegenOptions: options.codegenOptions,
      entryModuleId: options.entryModuleId,
    });
    return result.module;
  } catch (errorThrown) {
    const diagnostic = codegenErrorToDiagnostic(errorThrown, {
      moduleId: options.entryModuleId ?? graph.entry,
    });
    throw new Error(formatDiagnostic(diagnostic));
  }
};

export const browserParseModule = async (
  text: string,
  options: BrowserCompileOptions = {}
): Promise<ParsedModule> => {
  const roots = normalizeRoots(options.roots);
  const entryPath = normalizeEntryPath(
    options.entryPath ?? DEFAULT_ENTRY,
    roots
  );
  const stdFiles = buildStdFiles(roots.std ?? STD_ROOT);
  const extraFiles = normalizeSourceFiles(options.files ?? {}, roots.src);

  return {
    files: {
      ...stdFiles,
      ...extraFiles,
      [entryPath]: text,
    },
    entryPath,
    roots,
  };
};

const normalizeRoots = (roots?: ModuleRoots): ModuleRoots => ({
  src: normalizePath(roots?.src ?? SRC_ROOT),
  std: normalizePath(roots?.std ?? STD_ROOT),
  pkg: roots?.pkg ? normalizePath(roots.pkg) : roots?.pkg,
  resolvePackageRoot: roots?.resolvePackageRoot,
});

const normalizeEntryPath = (entryPath: string, roots: ModuleRoots): string =>
  normalizeFilePath(entryPath, roots.src);

const normalizeSourceFiles = (
  files: Record<string, string>,
  srcRoot: string
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(files).map(([path, source]) => [
      normalizeFilePath(path, srcRoot),
      source,
    ])
  );

const normalizeFileMap = (
  files: Record<string, string>
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(files).map(([path, source]) => [normalizePath(path), source])
  );

const buildStdFiles = (stdRoot: string): Record<string, string> => {
  const normalizedRoot = normalizePath(stdRoot);
  return Object.fromEntries(
    Object.entries(STD_SOURCES).map(([path, source]) => [
      `${normalizedRoot}/${toStdRelativePath(path)}`,
      source,
    ])
  );
};

const toStdRelativePath = (path: string): string => {
  const normalized = normalizePath(path);
  const marker = "/packages/std/src/";
  const index = normalized.indexOf(marker);
  if (index >= 0) {
    return normalized.slice(index + marker.length);
  }
  return normalized.replace(/^\/+/, "");
};

const normalizeFilePath = (filePath: string, root: string): string => {
  const normalized = filePath.replace(/\\/g, "/");
  if (normalized.startsWith("/")) {
    const withExt = normalized.endsWith(".voyd")
      ? normalized
      : `${normalized}.voyd`;
    return normalizePath(withExt);
  }
  const withExt = normalized.endsWith(".voyd")
    ? normalized
    : `${normalized}.voyd`;
  return normalizePath(`${root}/${withExt}`);
};

const normalizePath = (value: string): string => {
  const normalized = value.replace(/\\/g, "/");
  if (normalized === "/") return normalized;
  const trimmed = normalized.replace(/\/+$/, "");
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
};

const createMemoryHost = (files: Record<string, string>): ModuleHost => {
  const normalized = new Map<string, string>();
  const directories = new Map<string, Set<string>>();

  const ensureDir = (dir: string) => {
    if (!directories.has(dir)) {
      directories.set(dir, new Set());
    }
  };

  const dirname = (path: string) => {
    const normalizedPath = normalizePath(path);
    const slash = normalizedPath.lastIndexOf("/");
    if (slash <= 0) return "/";
    return normalizedPath.slice(0, slash);
  };

  const registerPath = (path: string) => {
    const directParent = dirname(path);
    ensureDir(directParent);
    directories.get(directParent)!.add(path);

    let current = directParent;
    while (true) {
      const parent = dirname(current);
      if (parent === current) break;
      ensureDir(parent);
      directories.get(parent)!.add(current);
      current = parent;
    }
  };

  Object.entries(files).forEach(([path, contents]) => {
    const full = normalizePath(path);
    normalized.set(full, contents);
    registerPath(full);
  });

  const isDirectoryPath = (path: string) =>
    directories.has(path) && !normalized.has(path);

  return {
    readFile: async (path: string) => {
      const resolved = normalizePath(path);
      const file = normalized.get(resolved);
      if (file === undefined) {
        throw new Error(`File not found: ${resolved}`);
      }
      return file;
    },
    readDir: async (path: string) => {
      const resolved = normalizePath(path);
      return Array.from(directories.get(resolved) ?? []);
    },
    fileExists: async (path: string) => normalized.has(normalizePath(path)),
    isDirectory: async (path: string) => isDirectoryPath(normalizePath(path)),
  };
};
