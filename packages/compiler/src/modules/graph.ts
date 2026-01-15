import {
  type Expr,
  Form,
  InternalIdentifierAtom,
  formCallsInternal,
  isForm,
  isIdentifierAtom,
  parse,
} from "../parser/index.js";
import { toSourceSpan } from "../semantics/utils.js";
import {
  modulePathFromFile,
  modulePathToString,
  resolveModuleFile,
} from "./path.js";
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

  while (pending.length) {
    const { dependency, importer } = pending.shift()!;
    const pathKey = modulePathToString(dependency.path);
    if (modulesByPath.has(pathKey)) {
      continue;
    }

    const resolvedPath = await resolveModuleFile(
      dependency.path,
      roots,
      host
    );

    if (!resolvedPath) {
      moduleDiagnostics.push({
        kind: "missing-module",
        message: `Unable to resolve module ${pathKey}`,
        requested: dependency.path,
        importer,
        span: dependency.span,
      });
      continue;
    }

    const resolvedModulePath = modulePathFromFile(
      resolvedPath,
      roots,
      host.path
    );
    const nextModule = await loadFileModule({
      filePath: resolvedPath,
      modulePath: resolvedModulePath,
      host,
    });
    addModuleTree(nextModule, modules, modulesByPath);
    enqueueDependencies(nextModule, pending);
  }

  const diagnostics = moduleDiagnostics.map(moduleDiagnosticToDiagnostic);

  return { entry: entryModule.node.id, modules, diagnostics };
};

const addModuleTree = (
  root: LoadedModule,
  modules: Map<string, ModuleNode>,
  modulesByPath: Map<string, ModuleNode>
) => {
  const allModules = [root.node, ...root.inlineModules];
  allModules.forEach((module) => {
    modules.set(module.id, module);
    modulesByPath.set(modulePathToString(module.path), module);
  });
};

const enqueueDependencies = (
  loaded: LoadedModule,
  queue: PendingDependency[]
) => {
  const modules = [loaded.node, ...loaded.inlineModules];
  modules.forEach((module) =>
    module.dependencies.forEach((dependency) =>
      queue.push({ dependency, importer: module.id })
    )
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
  const ast = parse(source, filePath);

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
            modulePath
          )
        )
        .forEach((path) => {
          if (!path.segments.length && !path.packageName) return;
          dependencies.push({
            kind: "use",
            path,
            span: usePath.span ?? span,
          });
        });
      return;
    }

    const exported = parseExportMod(entry);
    if (exported) {
      exported.entries
        .map((entryPath) =>
          resolveModuleRequest(
            { segments: entryPath.path, span: entryPath.span },
            modulePath,
            { anchorToSelf: true }
          )
        )
        .forEach((path) => {
          if (!path.segments.length && !path.packageName) return;
          dependencies.push({
            kind: "export",
            path,
            span: exported.span ?? span,
          });
        });
      return;
    }

    const inline = parseInlineModule(entry, modulePath, source);
    if (inline) {
      inlineModules.push(inline.node, ...inline.descendants);
    }
  });

  return { dependencies, inlineModules };
};

type ModuleRequest = {
  segments: readonly string[];
  namespace?: ModulePath["namespace"];
  packageName?: string;
  span?: SourceSpan;
};

const parseUse = (form: Form):
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

const parseExportMod = (form: Form):
  | { entries: ReturnType<typeof parseUsePaths>; span?: SourceSpan }
  | undefined => {
  const isPub = form.calls("pub");
  const keywordIndex = isPub ? 1 : 0;

  const keyword = form.at(keywordIndex);
  const body = form.at(keywordIndex + 2);

  const keywordIsMod = isPub && isIdentifierAtom(keyword) && keyword.value === "mod";
  const hasBlockBody = isForm(body) && body.calls("block");

  if (
    (!form.calls("mod") && !keywordIsMod) ||
    hasBlockBody
  ) {
    return undefined;
  }

  const pathExpr = form.calls("mod") ? form.at(1) : form.at(keywordIndex + 1);
  const span = toSourceSpan(form);
  const entries = pathExpr ? parseUsePaths(pathExpr, span) : [];

  return { entries, span };
};

type InlineModuleTree = {
  node: ModuleNode;
  descendants: ModuleNode[];
};

const parseInlineModule = (
  form: Form,
  parentPath: ModulePath,
  source: string
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
  form: Form
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

const resolveModuleRequest = (
  request: ModuleRequest,
  importer: ModulePath,
  options: { anchorToSelf?: boolean } = {}
): ModulePath => {
  const normalized = normalizeRequest(request);
  const prefixSrcWithinPackage =
    importer.namespace === "pkg" && normalized.namespace === "src";
  const namespace = prefixSrcWithinPackage
    ? "pkg"
    : normalized.namespace ?? importer.namespace;
  const packageName =
    namespace === "pkg"
      ? normalized.packageName ?? importer.packageName
      : normalized.packageName;
  const requestedSegments =
    prefixSrcWithinPackage && normalized.segments[0] !== "src"
      ? ["src", ...normalized.segments]
      : normalized.segments;
  const normalizedSegments =
    namespace === "pkg" && requestedSegments.length === 0
      ? ["pkg"]
      : requestedSegments;

  const anchorToSelf = options.anchorToSelf ?? false;
  const importerRoot = importer.segments.at(0);
  const firstRequestSegment = normalizedSegments.at(0);
  const parentSegments = importer.segments.slice(0, -1);
  const useParentSegments =
    !anchorToSelf &&
    !normalized.namespace &&
    parentSegments.length > 0 &&
    firstRequestSegment !== importerRoot;

  const baseSegments = anchorToSelf
    ? importer.segments
    : useParentSegments
    ? parentSegments
    : [];
  const suffix = anchorToSelf
    ? firstRequestSegment === importer.segments.at(0)
      ? normalizedSegments.slice(1)
      : normalizedSegments
    : useParentSegments && firstRequestSegment === parentSegments.at(-1)
    ? normalizedSegments.slice(1)
    : normalizedSegments;

  const segments = [...baseSegments, ...suffix];

  if (namespace === "pkg") {
    return {
      namespace,
      packageName,
      segments: segments.length === 0 ? ["pkg"] : segments,
    };
  }

  return {
    namespace,
    segments,
  };
};

const normalizeRequest = (request: ModuleRequest): ModuleRequest => {
  const segments = [...request.segments];
  const first = segments.at(0);
  const namespace =
    request.namespace ??
    (first === "src" ? "src" : first === "std" ? "std" : first === "pkg" ? "pkg" : undefined);

  if (namespace && (first === "src" || first === "std" || first === "pkg")) {
    segments.shift();
  }

  const last = segments.at(-1);
  if (last === "all" || last === "self") {
    segments.pop();
  }

  const packageName = namespace === "pkg" ? request.packageName ?? segments.shift() : request.packageName;

  return {
    namespace,
    packageName,
    segments,
  };
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
