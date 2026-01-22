import {
  type Expr,
  Form,
  InternalIdentifierAtom,
  formCallsInternal,
  isForm,
  isIdentifierAtom,
  parseBase,
} from "../parser/index.js";
import { toSourceSpan } from "../semantics/utils.js";
import {
  modulePathFromFile,
  modulePathToString,
  resolveModuleFile,
} from "./path.js";
import { resolveModuleRequest } from "./resolve.js";
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
};

type PendingDependency = {
  dependency: ModuleDependency;
  importer: string;
};

export const buildModuleGraph = async ({
  entryPath,
  host,
  roots,
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

    const resolvedPath = await resolveModuleFile(dependency.path, roots, host);

    if (!resolvedPath) {
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

    const resolvedModulePath = modulePathFromFile(
      resolvedPath,
      roots,
      host.path,
    );
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
    const nextModule = await loadFileModule({
      filePath: resolvedPath,
      modulePath: resolvedModulePath,
      host,
    });
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

  const diagnostics = moduleDiagnostics.map(moduleDiagnosticToDiagnostic);
  const graph = { entry: entryModule.node.id, modules, diagnostics };
  expandModuleMacros(graph);
  return graph;
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
}: {
  filePath: string;
  modulePath: ModulePath;
  host: ModuleHost;
}): Promise<LoadedModule> => {
  const source = await host.readFile(filePath);
  const ast = parseBase(source, filePath);

  const info = collectModuleInfo({
    modulePath,
    ast,
    source,
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

const collectModuleInfo = ({
  modulePath,
  ast,
  source,
}: {
  modulePath: ModulePath;
  ast: Form;
  source: string;
}): ModuleInfo => {
  const dependencies: ModuleDependency[] = [];
  const inlineModules: ModuleNode[] = [];
  let needsStdPkg = false;
  const entries = formCallsInternal(ast, "ast") ? ast.rest : [];

  entries.forEach((entry) => {
    if (!isForm(entry)) return;
    const span = toSourceSpan(entry);

    const usePath = parseUse(entry);
    if (usePath) {
      usePath.entries
        .map((entryPath) =>
          resolveModuleRequest(
            { segments: entryPath.moduleSegments, span: entryPath.span },
            modulePath,
            { anchorToSelf: entryPath.anchorToSelf === true }
          ),
        )
        .forEach((path) => {
          if (!path.segments.length && !path.packageName) return;
          dependencies.push({
            kind: "use",
            path,
            span: usePath.span ?? span,
          });
        });
      if (modulePath.namespace !== "std") {
        const hasStdImport = usePath.entries.some(
          (entryPath) => entryPath.moduleSegments.at(0) === "std",
        );
        if (hasStdImport) {
          needsStdPkg = true;
        }
      }
      return;
    }

    const inline = parseInlineModule(entry, modulePath, source);
    if (inline) {
      inlineModules.push(inline.node, ...inline.descendants);
    }
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

const parseUse = (
  form: Form,
):
  | { entries: ReturnType<typeof parseUsePaths>; span?: SourceSpan }
  | undefined => {
  if (form.calls("use")) {
    const span = toSourceSpan(form);
    return { entries: parseUsePaths(form.at(1), span), span };
  }

  const keyword = form.at(1);
  if (
    form.calls("pub") &&
    isIdentifierAtom(keyword) &&
    keyword.value === "use"
  ) {
    const span = toSourceSpan(form);
    return { entries: parseUsePaths(form.at(2), span), span };
  }

  return undefined;
};

type InlineModuleTree = {
  node: ModuleNode;
  descendants: ModuleNode[];
};

const parseInlineModule = (
  form: Form,
  parentPath: ModulePath,
  source: string,
): InlineModuleTree | undefined => {
  const match = matchInlineModule(form);
  if (!match) return undefined;

  const modulePath = {
    ...parentPath,
    segments: [...parentPath.segments, match.name],
  };

  const ast = toModuleAst(match.body);
  const info = collectModuleInfo({ modulePath, ast, source });

  const node: ModuleNode = {
    id: modulePathToString(modulePath),
    path: modulePath,
    origin: {
      kind: "inline",
      parentId: modulePathToString(parentPath),
      name: match.name,
      span: match.span,
    },
    ast,
    source: sliceSource(source, match.span),
    dependencies: info.dependencies,
  };

  return { node, descendants: info.inlineModules };
};

const matchInlineModule = (
  form: Form,
): { name: string; body: Form; span: SourceSpan } | undefined => {
  const first = form.at(0);
  const isPub = first && isIdentifierAtom(first) && first.value === "pub";
  const offset = isPub ? 1 : 0;
  const keyword = form.at(offset);
  const nameExpr = form.at(offset + 1);
  const body = form.at(offset + 2);

  if (
    !isIdentifierAtom(keyword) ||
    keyword.value !== "mod" ||
    !isIdentifierAtom(nameExpr) ||
    !isForm(body) ||
    !body.calls("block")
  ) {
    return undefined;
  }

  return { name: nameExpr.value, body, span: toSourceSpan(form) };
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
