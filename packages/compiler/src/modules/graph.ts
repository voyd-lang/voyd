import {
  Form,
  InternalIdentifierAtom,
  formCallsInternal,
  isIdentifierAtom,
  isForm,
  parseBase,
} from "../parser/index.js";
import { type Diagnostic } from "../diagnostics/index.js";
import {
  collectModuleDocumentation,
  combineDocumentation,
  type ModuleDocumentation,
} from "../docs/doc-comments.js";
import { toSourceSpan } from "../semantics/utils.js";
import {
  modulePathFromFile,
  modulePathToString,
  resolveModuleFile,
} from "./path.js";
import { resolveModuleRequest } from "./resolve.js";
import { classifyTopLevelDecl } from "./use-decl.js";
import { parseUsePaths } from "./use-path.js";
import { moduleDiagnosticToDiagnostic } from "./diagnostics.js";
import type {
  ModuleDependency,
  ModuleDiagnostic,
  ModuleGraph,
  ModuleHost,
  ModuleNode,
  ModulePath,
  ModuleRoots,
} from "./types.js";
import { expandModuleMacros } from "./macro-expansion.js";
import type { SourceSpan } from "../semantics/ids.js";

type BuildGraphOptions = {
  entryPath: string;
  host: ModuleHost;
  roots: ModuleRoots;
  includeTests?: boolean;
};

type PendingDependency = {
  dependency: ModuleDependency;
  importer: string;
};

const NO_PRELUDE_DIRECTIVE = /(^|[\r\n])([^\S\r\n]*#!no_prelude[^\r\n]*)(?=$|[\r\n])/g;
const PRELUDE_MODULE_SEGMENTS = ["std", "prelude"] as const;
const IMPLICIT_PRELUDE_USE_DECL = (() => {
  const ast = parseBase("use std::prelude::all", "<implicit-prelude>");
  if (!formCallsInternal(ast, "ast")) {
    throw new Error("failed to parse implicit prelude import");
  }
  const entry = ast.rest[0];
  if (!isForm(entry)) {
    throw new Error("failed to parse implicit prelude use declaration");
  }
  return entry;
})();

const formatErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const buildModuleGraph = async ({
  entryPath,
  host,
  roots,
  includeTests,
}: BuildGraphOptions): Promise<ModuleGraph> => {
  const modules = new Map<string, ModuleNode>();
  const modulesByPath = new Map<string, ModuleNode>();
  const moduleDiagnostics: ModuleDiagnostic[] = [];
  const docDiagnostics: Diagnostic[] = [];
  const missingModules = new Map<string, Set<string>>();

  const hasMissingModule = (importer: string, pathKey: string): boolean =>
    missingModules.get(importer)?.has(pathKey) ?? false;

  const addMissingModule = (importer: string, pathKey: string) => {
    const entries = missingModules.get(importer);
    if (entries) {
      entries.add(pathKey);
      return;
    }
    missingModules.set(importer, new Set([pathKey]));
  };

  const hasStdPreludeModule = await supportsStdPreludeAutoImport({
    roots,
    host,
  });

  const entryFile = host.path.resolve(entryPath);
  const entryModulePath = modulePathFromFile(entryFile, roots, host.path);
  const entryModule = await loadFileModule({
    filePath: entryFile,
    modulePath: entryModulePath,
    host,
    includeTests: includeTests === true,
    hasStdPreludeModule,
  });

  addModuleTree(entryModule, modules, modulesByPath);
  docDiagnostics.push(...entryModule.diagnostics);

  const pending: PendingDependency[] = [];
  enqueueDependencies(entryModule, pending);

  const hasNestedModule = (pathKey: string): boolean => {
    const prefix = `${pathKey}::`;
    for (const key of modulesByPath.keys()) {
      if (key.startsWith(prefix)) {
        return true;
      }
    }
    for (const entry of pending) {
      const depKey = modulePathToString(entry.dependency.path);
      if (depKey.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  };

  while (pending.length) {
    const { dependency, importer } = pending.shift()!;
    const pathKey = modulePathToString(dependency.path);
    if (hasMissingModule(importer, pathKey)) {
      continue;
    }
    if (modulesByPath.has(pathKey)) {
      continue;
    }

    let resolved: Awaited<ReturnType<typeof resolveModuleFile>>;
    try {
      resolved = await resolveModuleFile(dependency.path, roots, host);
    } catch (error) {
      moduleDiagnostics.push({
        kind: "io-error",
        message: formatErrorMessage(error),
        requested: dependency.path,
        importer,
        span: dependency.span,
      });
      addMissingModule(importer, pathKey);
      continue;
    }

    if (!resolved) {
      moduleDiagnostics.push({
        kind: "missing-module",
        message: `Unable to resolve module ${pathKey}`,
        requested: dependency.path,
        importer,
        span: dependency.span,
      });
      addMissingModule(importer, pathKey);
      continue;
    }

    const resolvedPath = resolved.filePath;
    const resolvedModulePath = resolved.modulePath;
    const resolvedKey = modulePathToString(resolvedModulePath);
    if (modulesByPath.has(resolvedKey)) {
      if (hasNestedModule(pathKey)) {
        continue;
      }
      moduleDiagnostics.push({
        kind: "missing-module",
        message: `Unable to resolve module ${pathKey}`,
        requested: dependency.path,
        importer,
        span: dependency.span,
      });
      addMissingModule(importer, pathKey);
      continue;
    }
    let nextModule: LoadedModule;
    try {
      nextModule = await loadFileModule({
        filePath: resolvedPath,
        modulePath: resolvedModulePath,
        host,
        includeTests: includeTests === true,
        hasStdPreludeModule,
      });
    } catch (error) {
      moduleDiagnostics.push({
        kind: "io-error",
        message: formatErrorMessage(error),
        requested: dependency.path,
        importer,
        span: dependency.span,
      });
      addMissingModule(importer, pathKey);
      continue;
    }
    addModuleTree(nextModule, modules, modulesByPath);
    docDiagnostics.push(...nextModule.diagnostics);
    enqueueDependencies(nextModule, pending);
    if (!modulesByPath.has(pathKey) && !hasNestedModule(pathKey)) {
      moduleDiagnostics.push({
        kind: "missing-module",
        message: `Unable to resolve module ${pathKey}`,
        requested: dependency.path,
        importer,
        span: dependency.span,
      });
      addMissingModule(importer, pathKey);
    }
  }

  const baseDiagnostics = moduleDiagnostics.map(moduleDiagnosticToDiagnostic);
  const graph = {
    entry: entryModule.node.id,
    modules,
    diagnostics: [...baseDiagnostics, ...docDiagnostics],
  };
  const macroDiagnostics = expandModuleMacros(graph);
  return {
    ...graph,
    diagnostics: [...baseDiagnostics, ...docDiagnostics, ...macroDiagnostics],
  };
};

const addModuleTree = (
  root: LoadedModule,
  modules: Map<string, ModuleNode>,
  modulesByPath: Map<string, ModuleNode>,
) => {
  const allModules = [root.node, ...root.inlineModules];
  allModules.forEach((module) => {
    modules.set(module.id, module);
    modulesByPath.set(modulePathToString(module.path), module);
  });
};

const enqueueDependencies = (
  loaded: LoadedModule,
  queue: PendingDependency[],
) => {
  const modules = [loaded.node, ...loaded.inlineModules];
  modules.forEach((module) =>
    module.dependencies.forEach((dependency) =>
      queue.push({ dependency, importer: module.id }),
    ),
  );
};

type LoadedModule = {
  node: ModuleNode;
  inlineModules: ModuleNode[];
  diagnostics: readonly Diagnostic[];
};

const loadFileModule = async ({
  filePath,
  modulePath,
  host,
  includeTests,
  hasStdPreludeModule,
}: {
  filePath: string;
  modulePath: ModulePath;
  host: ModuleHost;
  includeTests: boolean;
  hasStdPreludeModule: boolean;
}): Promise<LoadedModule> => {
  const source = await host.readFile(filePath);
  const primaryParsed = parseModuleDirectives(source);
  let ast = parseBase(primaryParsed.sanitizedSource, filePath);
  let noPrelude = primaryParsed.noPrelude;
  const sourceByFile = new Map<string, string>([
    [filePath, primaryParsed.sanitizedSource],
  ]);

  if (includeTests && !isCompanionTestFile(filePath)) {
    const companionFilePath = companionFileFor(filePath);
    if (await host.fileExists(companionFilePath)) {
      const companionSource = await host.readFile(companionFilePath);
      const companionParsed = parseModuleDirectives(companionSource);
      noPrelude = noPrelude || companionParsed.noPrelude;
      const companionAst = parseBase(
        companionParsed.sanitizedSource,
        companionFilePath,
      );
      ast = mergeCompanionAst({ primary: ast, companion: companionAst });
      sourceByFile.set(companionFilePath, companionParsed.sanitizedSource);
    }
  }

  ast = injectImplicitPreludeUse({
    ast,
    modulePath,
    hasStdPreludeModule,
    noPrelude,
  });

  const info = collectModuleInfo({
    modulePath,
    ast,
    sourceByFile,
    moduleRange: { start: 0, end: source.length },
  });
  const submoduleDeps = await discoverSubmodules({
    filePath,
    modulePath,
    host,
  });

  const node: ModuleNode = {
    id: modulePathToString(modulePath),
    path: modulePath,
    origin: { kind: "file", filePath },
    ast,
    source,
    docs: info.docs,
    dependencies: [...info.dependencies, ...submoduleDeps],
  };

  return {
    node,
    inlineModules: info.inlineModules,
    diagnostics: info.diagnostics,
  };
};

type ModuleInfo = {
  dependencies: ModuleDependency[];
  inlineModules: ModuleNode[];
  docs: ModuleDocumentation;
  diagnostics: readonly Diagnostic[];
};

const VOYD_EXTENSION = ".voyd";
const TEST_COMPANION_EXTENSION = ".test.voyd";

const collectModuleInfo = ({
  modulePath,
  ast,
  sourceByFile,
  moduleRange,
}: {
  modulePath: ModulePath;
  ast: Form;
  sourceByFile: ReadonlyMap<string, string>;
  moduleRange: { start: number; end: number };
}): ModuleInfo => {
  const dependencies: ModuleDependency[] = [];
  const inlineModules: ModuleNode[] = [];
  const diagnostics: Diagnostic[] = [];
  let needsStdPkg = false;
  const entries = formCallsInternal(ast, "ast") ? ast.rest : [];
  const sourceForDocs = sourceForModuleAst({ ast, sourceByFile });
  const collectedDocs = collectModuleDocumentation({
    ast,
    source: sourceForDocs,
    moduleRange,
  });
  diagnostics.push(...collectedDocs.diagnostics);

  entries.forEach((entry) => {
    if (!isForm(entry)) return;
    const span = toSourceSpan(entry);
    const topLevelDecl = classifyTopLevelDecl(entry);

    if (topLevelDecl.kind === "use-decl") {
      const useEntries = parseUsePaths(topLevelDecl.pathExpr, span);
      const resolvedEntries = useEntries
        .filter((entryPath) => entryPath.hasExplicitPrefix)
        .map((entryPath) =>
          resolveModuleRequest(
            { segments: entryPath.moduleSegments, span: entryPath.span },
            modulePath,
            {
              anchorToSelf: entryPath.anchorToSelf === true,
              parentHops: entryPath.parentHops ?? 0,
            },
          ),
        );
      resolvedEntries.forEach((path) => {
        if (!path.segments.length && !path.packageName) return;
        dependencies.push({
          kind: "use",
          path,
          span,
        });
        if (
          modulePath.namespace !== "std" &&
          path.namespace === "std" &&
          path.segments.length === 1 &&
          path.segments[0] === "pkg"
        ) {
          needsStdPkg = true;
        }
      });
      return;
    }

    if (topLevelDecl.kind !== "inline-module-decl") {
      return;
    }

    const inline = parseInlineModuleDecl({
      decl: topLevelDecl,
      form: entry,
      parentPath: modulePath,
      sourceByFile,
      outerModuleDoc: (() => {
        const first = entry.at(0);
        const visibilityOffset =
          isIdentifierAtom(first) && first.value === "pub" ? 1 : 0;
        const nameSyntax = entry.at(visibilityOffset + 1);
        return nameSyntax
          ? collectedDocs.documentation.declarationsBySyntaxId.get(
              nameSyntax.syntaxId,
            )
          : undefined;
      })(),
    });
    inlineModules.push(inline.node, ...inline.descendants);
    diagnostics.push(...inline.diagnostics);
  });

  if (needsStdPkg) {
    const already = dependencies.some(
      (dependency) =>
        dependency.path.namespace === "std" &&
        dependency.path.segments.length === 1 &&
        dependency.path.segments[0] === "pkg",
    );
    if (!already) {
      dependencies.push({
        kind: "use",
        path: { namespace: "std", segments: ["pkg"] },
      });
    }
  }

  return {
    dependencies,
    inlineModules,
    docs: collectedDocs.documentation,
    diagnostics,
  };
};

type InlineModuleTree = {
  node: ModuleNode;
  descendants: ModuleNode[];
  diagnostics: readonly Diagnostic[];
};

const parseInlineModuleDecl = ({
  decl,
  form,
  parentPath,
  sourceByFile,
  outerModuleDoc,
}: {
  decl: Extract<
    ReturnType<typeof classifyTopLevelDecl>,
    { kind: "inline-module-decl" }
  >;
  form: Form;
  parentPath: ModulePath;
  sourceByFile: ReadonlyMap<string, string>;
  outerModuleDoc?: string;
}): InlineModuleTree => {
  const modulePath = {
    ...parentPath,
    segments: [...parentPath.segments, decl.name],
  };

  const span = toSourceSpan(form);
  const sourceForModule =
    sourceByFile.get(span.file) ??
    sourceByFile.values().next().value ??
    "";
  const ast = toModuleAst(decl.body);
  const moduleRangeStart = lineStartIndex(
    sourceForModule,
    (form.location?.startLine ?? decl.body.location?.startLine ?? 1) + 1,
  );
  const info = collectModuleInfo({
    modulePath,
    ast,
    sourceByFile,
    moduleRange: {
      start: moduleRangeStart,
      end: decl.body.location?.endIndex ?? sourceForModule.length,
    },
  });

  const node: ModuleNode = {
    id: modulePathToString(modulePath),
    path: modulePath,
    origin: {
      kind: "inline",
      parentId: modulePathToString(parentPath),
      name: decl.name,
      span,
    },
    ast,
    source: sliceSource(sourceForModule, span),
    docs: {
      ...info.docs,
      module: combineDocumentation(outerModuleDoc, info.docs.module),
    },
    dependencies: info.dependencies,
  };

  return {
    node,
    descendants: info.inlineModules,
    diagnostics: info.diagnostics,
  };
};

const toModuleAst = (block: Form): Form => {
  const body = block.rest;
  return new Form({
    elements: [new InternalIdentifierAtom("ast"), ...body],
    location: block.location,
  });
};

const sliceSource = (source: string, span: SourceSpan): string =>
  source.slice(span.start, span.end);

const sourceForModuleAst = ({
  ast,
  sourceByFile,
}: {
  ast: Form;
  sourceByFile: ReadonlyMap<string, string>;
}): string => {
  const filePath = ast.location?.filePath;
  if (filePath) {
    const source = sourceByFile.get(filePath);
    if (source !== undefined) {
      return source;
    }
  }

  return sourceByFile.values().next().value ?? "";
};

const lineStartIndex = (source: string, lineNumber: number): number => {
  if (lineNumber <= 1) {
    return 0;
  }

  let currentLine = 1;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "\n") {
      continue;
    }
    currentLine += 1;
    if (currentLine === lineNumber) {
      return index + 1;
    }
  }

  return source.length;
};

const isCompanionTestFile = (filePath: string): boolean =>
  filePath.endsWith(TEST_COMPANION_EXTENSION);

const companionFileFor = (filePath: string): string =>
  `${filePath.slice(0, -VOYD_EXTENSION.length)}${TEST_COMPANION_EXTENSION}`;

const mergeCompanionAst = ({
  primary,
  companion,
}: {
  primary: Form;
  companion: Form;
}): Form => {
  const primaryEntries = formCallsInternal(primary, "ast")
    ? primary.rest
    : primary.toArray();
  const companionEntries = formCallsInternal(companion, "ast")
    ? companion.rest
    : companion.toArray();
  const astHead = primary.first ?? new InternalIdentifierAtom("ast");

  return new Form({
    location: primary.location?.clone(),
    elements: [astHead, ...primaryEntries, ...companionEntries],
  }).toCall();
};

const parseModuleDirectives = (
  source: string,
): { sanitizedSource: string; noPrelude: boolean } => {
  let noPrelude = false;
  const sanitizedSource = source.replace(
    NO_PRELUDE_DIRECTIVE,
    (_full, prefix: string, directive: string) => {
      noPrelude = true;
      return `${prefix}${" ".repeat(directive.length)}`;
    },
  );

  return { sanitizedSource, noPrelude };
};

const hasExplicitPreludeUse = ({ ast }: { ast: Form }): boolean => {
  const entries = formCallsInternal(ast, "ast") ? ast.rest : [];
  return entries.some((entry) => {
    if (!isForm(entry)) {
      return false;
    }

    const topLevelDecl = classifyTopLevelDecl(entry);
    if (topLevelDecl.kind !== "use-decl") {
      return false;
    }

    return parseUsePaths(topLevelDecl.pathExpr, toSourceSpan(entry)).some(
      (useEntry) =>
        useEntry.selectionKind === "all" &&
        useEntry.moduleSegments.length === PRELUDE_MODULE_SEGMENTS.length &&
        useEntry.moduleSegments.every(
          (segment, index) => segment === PRELUDE_MODULE_SEGMENTS[index],
        ),
    );
  });
};

const injectImplicitPreludeUse = ({
  ast,
  modulePath,
  hasStdPreludeModule,
  noPrelude,
}: {
  ast: Form;
  modulePath: ModulePath;
  hasStdPreludeModule: boolean;
  noPrelude: boolean;
}): Form => {
  if (modulePath.namespace === "std" || noPrelude || !hasStdPreludeModule) {
    return ast;
  }
  if (!formCallsInternal(ast, "ast")) {
    return ast;
  }
  if (hasExplicitPreludeUse({ ast })) {
    return ast;
  }

  const astHead = ast.first ?? new InternalIdentifierAtom("ast");
  return new Form({
    location: ast.location?.clone(),
    elements: [astHead, IMPLICIT_PRELUDE_USE_DECL.clone(), ...ast.rest],
  }).toCall();
};

const supportsStdPreludeAutoImport = async ({
  roots,
  host,
}: {
  roots: ModuleRoots;
  host: ModuleHost;
}): Promise<boolean> => {
  if (!roots.std) {
    return false;
  }

  const resolved = await resolveModuleFile(
    { namespace: "std", segments: ["prelude"] },
    roots,
    host,
  );
  return Boolean(resolved);
};

const discoverSubmodules = async ({
  filePath,
  modulePath,
  host,
}: {
  filePath: string;
  modulePath: ModulePath;
  host: ModuleHost;
}): Promise<ModuleDependency[]> => {
  const moduleDir = filePath.endsWith(VOYD_EXTENSION)
    ? filePath.slice(0, -VOYD_EXTENSION.length)
    : filePath;
  const isDir = await host.isDirectory(moduleDir);
  if (!isDir) return [];

  const dependencies: ModuleDependency[] = [];

  const walk = async (dir: string, segments: string[]): Promise<void> => {
    const entries = await host.readDir(dir);
    for (const entry of entries) {
      const entryIsDir = await host.isDirectory(entry);
      if (entryIsDir) {
        const name = host.path.basename(entry);
        await walk(entry, [...segments, name]);
        continue;
      }

      if (!entry.endsWith(VOYD_EXTENSION)) continue;
      if (entry.endsWith(TEST_COMPANION_EXTENSION)) continue;
      const stem = host.path.basename(entry, VOYD_EXTENSION);
      dependencies.push({
        kind: "export",
        path: {
          namespace: modulePath.namespace,
          packageName: modulePath.packageName,
          segments: [...modulePath.segments, ...segments, stem],
        },
      });
    }
  };

  await walk(moduleDir, []);
  return dependencies;
};
