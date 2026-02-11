import {
  Form,
  InternalIdentifierAtom,
  formCallsInternal,
  isForm,
  parseBase,
} from "../parser/index.js";
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

  const entryFile = host.path.resolve(entryPath);
  const entryModulePath = modulePathFromFile(entryFile, roots, host.path);
  const entryModule = await loadFileModule({
    filePath: entryFile,
    modulePath: entryModulePath,
    host,
    includeTests: includeTests === true,
  });

  addModuleTree(entryModule, modules, modulesByPath);

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
    diagnostics: baseDiagnostics,
  };
  const macroDiagnostics = expandModuleMacros(graph);
  return { ...graph, diagnostics: [...baseDiagnostics, ...macroDiagnostics] };
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
};

const loadFileModule = async ({
  filePath,
  modulePath,
  host,
  includeTests,
}: {
  filePath: string;
  modulePath: ModulePath;
  host: ModuleHost;
  includeTests: boolean;
}): Promise<LoadedModule> => {
  const source = await host.readFile(filePath);
  let ast = parseBase(source, filePath);
  const sourceByFile = new Map<string, string>([[filePath, source]]);

  if (includeTests && !isCompanionTestFile(filePath)) {
    const companionFilePath = companionFileFor(filePath);
    if (await host.fileExists(companionFilePath)) {
      const companionSource = await host.readFile(companionFilePath);
      const companionAst = parseBase(companionSource, companionFilePath);
      ast = mergeCompanionAst({ primary: ast, companion: companionAst });
      sourceByFile.set(companionFilePath, companionSource);
    }
  }

  const info = collectModuleInfo({
    modulePath,
    ast,
    sourceByFile,
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
    dependencies: [...info.dependencies, ...submoduleDeps],
  };

  return {
    node,
    inlineModules: info.inlineModules,
  };
};

type ModuleInfo = {
  dependencies: ModuleDependency[];
  inlineModules: ModuleNode[];
};

const VOYD_EXTENSION = ".voyd";
const TEST_COMPANION_EXTENSION = ".test.voyd";

const collectModuleInfo = ({
  modulePath,
  ast,
  sourceByFile,
}: {
  modulePath: ModulePath;
  ast: Form;
  sourceByFile: ReadonlyMap<string, string>;
}): ModuleInfo => {
  const dependencies: ModuleDependency[] = [];
  const inlineModules: ModuleNode[] = [];
  let needsStdPkg = false;
  const entries = formCallsInternal(ast, "ast") ? ast.rest : [];

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
    });
    inlineModules.push(inline.node, ...inline.descendants);
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

  return { dependencies, inlineModules };
};

type InlineModuleTree = {
  node: ModuleNode;
  descendants: ModuleNode[];
};

const parseInlineModuleDecl = ({
  decl,
  form,
  parentPath,
  sourceByFile,
}: {
  decl: Extract<
    ReturnType<typeof classifyTopLevelDecl>,
    { kind: "inline-module-decl" }
  >;
  form: Form;
  parentPath: ModulePath;
  sourceByFile: ReadonlyMap<string, string>;
}): InlineModuleTree => {
  const modulePath = {
    ...parentPath,
    segments: [...parentPath.segments, decl.name],
  };

  const ast = toModuleAst(decl.body);
  const info = collectModuleInfo({ modulePath, ast, sourceByFile });
  const span = toSourceSpan(form);
  const sourceForModule =
    sourceByFile.get(span.file) ??
    sourceByFile.values().next().value ??
    "";

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
    dependencies: info.dependencies,
  };

  return { node, descendants: info.inlineModules };
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
