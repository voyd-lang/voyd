import type {
  ModuleHost,
  ModulePath,
  ModulePathAdapter,
  ModuleRoots,
} from "./types.js";

const VOYD_EXTENSION = ".voyd";

export const modulePathToString = (path: ModulePath): string => {
  const namespace = path.namespace === "pkg" && path.packageName ? `pkg:${path.packageName}` : path.namespace;
  return `${namespace}::${path.segments.join("::")}`;
};

export const modulePathFromFile = (
  filePath: string,
  roots: ModuleRoots,
  pathAdapter: ModulePathAdapter
): ModulePath => {
  const normalizedRoots = normalizeRoots(roots, pathAdapter);
  const namespace = pickNamespace(filePath, normalizedRoots, pathAdapter);
  const root = normalizedRoots[namespace];
  if (!root) {
    throw new Error(`Unable to determine root for namespace ${namespace}`);
  }
  const relativeToRoot = pathAdapter.relative(
    root,
    pathAdapter.resolve(filePath)
  );
  const normalizedRelative = relativeToRoot.replace(/\\/g, "/");
  const withoutExt = normalizedRelative.endsWith(VOYD_EXTENSION)
    ? normalizedRelative.slice(0, -VOYD_EXTENSION.length)
    : normalizedRelative;
  const rawSegments = withoutExt.split("/").filter(Boolean);

  if (namespace === "pkg") {
    const [packageName, ...segments] = rawSegments;
    return {
      namespace,
      packageName,
      segments,
    };
  }

  return {
    namespace,
    segments: rawSegments,
  };
};

export const resolveModuleFile = async (
  path: ModulePath,
  roots: ModuleRoots,
  host: ModuleHost
): Promise<string | undefined> => {
  const pathAdapter = host.path;
  const normalizedRoots = normalizeRoots(roots, pathAdapter);
  const root = await resolveRoot(path, normalizedRoots, pathAdapter);
  if (!root) return undefined;

  const packageSegments =
    path.namespace === "pkg" && path.segments.length === 0
      ? ["pkg"]
      : path.segments;
  const rootIncludesPackage =
    path.namespace === "pkg" &&
    path.packageName !== undefined &&
    pathAdapter.basename(root) === path.packageName;
  const segmentsWithPkg =
    path.namespace === "pkg" && path.packageName && !rootIncludesPackage
      ? [path.packageName, ...packageSegments]
      : packageSegments;

  const candidate = pathAdapter.join(root, ...segmentsWithPkg) + VOYD_EXTENSION;
  const exists = await host.fileExists(candidate);
  if (exists) return pathAdapter.resolve(candidate);

  const dir = pathAdapter.join(root, ...segmentsWithPkg);
  const isDir = await host.isDirectory(dir);
  if (isDir) {
    const stem = dir + VOYD_EXTENSION;
    const stemExists = await host.fileExists(stem);
    if (stemExists) return pathAdapter.resolve(stem);
  }

  for (let i = segmentsWithPkg.length - 1; i > 0; i -= 1) {
    const ancestor =
      pathAdapter.join(root, ...segmentsWithPkg.slice(0, i)) + VOYD_EXTENSION;
    const ancestorExists = await host.fileExists(ancestor);
    if (ancestorExists) return pathAdapter.resolve(ancestor);
  }

  return undefined;
};

type NormalizedRoots = Required<Pick<ModuleRoots, "src">> & ModuleRoots;

const normalizeRoots = (
  roots: ModuleRoots,
  pathAdapter: ModulePathAdapter
): NormalizedRoots => ({
  src: pathAdapter.resolve(roots.src),
  std: roots.std ? pathAdapter.resolve(roots.std) : roots.std,
  pkg: roots.pkg ? pathAdapter.resolve(roots.pkg) : roots.pkg,
  resolvePackageRoot: roots.resolvePackageRoot,
});

const pickNamespace = (
  filePath: string,
  roots: NormalizedRoots,
  pathAdapter: ModulePathAdapter
): ModulePath["namespace"] => {
  const normalized = pathAdapter.resolve(filePath);
  if (roots.std && normalized.startsWith(roots.std)) return "std";
  if (roots.src && normalized.startsWith(roots.src)) return "src";
  if (roots.pkg && normalized.startsWith(roots.pkg)) return "pkg";
  return "src";
};

const resolveRoot = async (
  path: ModulePath,
  roots: NormalizedRoots,
  pathAdapter: ModulePathAdapter
): Promise<string | undefined> => {
  if (path.namespace === "src") return roots.src;
  if (path.namespace === "std") return roots.std;
  if (path.namespace === "pkg" && path.packageName) {
    const resolved = await roots.resolvePackageRoot?.(path.packageName);
    if (resolved) return pathAdapter.resolve(resolved);
    if (roots.pkg) return pathAdapter.join(roots.pkg, path.packageName);
  }
  return undefined;
};
