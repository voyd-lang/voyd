// NOTE: Browser integration relies on the browser pipeline entry and the in-memory
// module host. Node-only filesystem hosts remain in @voyd/compiler/modules/fs-host.
import binaryen from "binaryen";
import {
  analyzeModules,
  emitProgram,
  loadModuleGraph,
} from "@voyd/compiler/pipeline-browser.js";
import { codegenErrorToDiagnostic } from "@voyd/compiler/codegen/diagnostics.js";
import type { CodegenOptions } from "@voyd/compiler/codegen/context.js";
import { DiagnosticError, formatDiagnostic } from "@voyd/compiler/diagnostics/index.js";
import { createMemoryModuleHost } from "@voyd/compiler/modules/memory-host.js";
import type { ModuleRoots } from "@voyd/compiler/modules/types.js";

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
  const host = createMemoryModuleHost({
    files: normalizeFileMap(module.files),
  });
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
    throw new DiagnosticError(error);
  }

  try {
    const result = await emitProgram({
      graph,
      semantics,
      codegenOptions: options.codegenOptions,
      entryModuleId: options.entryModuleId,
    });
    const codegenError = result.diagnostics.find(
      (diagnostic) => diagnostic.severity === "error"
    );
    if (codegenError) {
      throw new DiagnosticError(codegenError);
    }
    return result.module;
  } catch (errorThrown) {
    if (errorThrown instanceof DiagnosticError) {
      throw errorThrown;
    }
    const diagnostic = codegenErrorToDiagnostic(errorThrown, {
      moduleId: options.entryModuleId ?? graph.entry,
    });
    throw new DiagnosticError(diagnostic);
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
