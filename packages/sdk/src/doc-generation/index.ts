import path from "node:path";
import { analyzeModules, loadModuleGraph } from "@voyd/compiler/pipeline.js";
import type { Diagnostic } from "@voyd/compiler/diagnostics/index.js";
import type { ModuleRoots } from "@voyd/compiler/modules/types.js";
import { resolveStdRoot } from "@voyd/lib/resolve-std.js";
import { createDocumentationModel } from "./model.js";
import type {
  DocumentationGraphLike,
  DocumentationSemanticsLike,
} from "./model.js";
import { renderDocumentationHtml } from "./render-html.js";
import { renderDocumentationJson } from "./render-json.js";
import type { DocumentationModel, DocumentationOutputFormat } from "./types.js";

const hasErrorDiagnostics = (diagnostics: readonly Diagnostic[]): boolean =>
  diagnostics.some((diagnostic) => diagnostic.severity === "error");

const renderDocumentation = ({
  model,
  format,
}: {
  model: DocumentationModel;
  format: DocumentationOutputFormat;
}): string =>
  format === "json"
    ? renderDocumentationJson({ model })
    : renderDocumentationHtml({ model });

const collectNodeModulesDirs = (startDir: string): string[] => {
  const directories: string[] = [];
  let current = path.resolve(startDir);

  while (true) {
    directories.push(path.join(current, "node_modules"));
    const parent = path.dirname(current);
    if (parent === current) {
      return directories;
    }
    current = parent;
  }
};

const dedupePaths = (paths: readonly string[]): string[] =>
  Array.from(new Set(paths));

const resolveDocumentationRoots = ({
  entryPath,
  roots,
}: {
  entryPath: string;
  roots?: ModuleRoots;
}): ModuleRoots => {
  const src = roots?.src
    ? path.resolve(roots.src)
    : path.dirname(path.resolve(entryPath));
  const configuredPkgDirs = [
    ...(roots?.pkgDirs ?? []),
    ...(roots?.pkg ? [roots.pkg] : []),
  ].map((directory) => path.resolve(directory));
  const pkgDirs = dedupePaths([
    ...configuredPkgDirs,
    ...collectNodeModulesDirs(src),
  ]);

  return {
    src,
    std: roots?.std ? path.resolve(roots.std) : resolveStdRoot(),
    pkg: roots?.pkg ? path.resolve(roots.pkg) : roots?.pkg,
    pkgDirs,
    resolvePackageRoot: roots?.resolvePackageRoot,
  };
};

export const generateDocumentation = async ({
  entryPath,
  roots,
  format = "html",
}: {
  entryPath: string;
  roots?: ModuleRoots;
  format?: DocumentationOutputFormat;
}): Promise<{
  model: DocumentationModel;
  content: string;
  diagnostics: readonly Diagnostic[];
  format: DocumentationOutputFormat;
}> => {
  const graph = await loadModuleGraph({
    entryPath,
    roots: resolveDocumentationRoots({ entryPath, roots }),
  });
  const { semantics, diagnostics: semanticDiagnostics } = analyzeModules({
    graph,
  });
  const diagnostics = [...graph.diagnostics, ...semanticDiagnostics];

  if (hasErrorDiagnostics(diagnostics)) {
    throw { diagnostics: [...diagnostics] };
  }

  const model = createDocumentationModel({
    graph: graph as unknown as DocumentationGraphLike,
    semantics: semantics as unknown as ReadonlyMap<
      string,
      DocumentationSemanticsLike
    >,
  });

  return {
    model,
    content: renderDocumentation({ model, format }),
    diagnostics,
    format,
  };
};

export {
  createDocumentationModel,
  renderDocumentationHtml,
  renderDocumentationJson,
};

export type {
  DocumentationItem,
  DocumentationItemKind,
  DocumentationMember,
  DocumentationModel,
  DocumentationOutputFormat,
  DocumentationParameter,
  ModuleDocumentationSection,
} from "./types.js";
