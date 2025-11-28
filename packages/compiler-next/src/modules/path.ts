import { join, relative, resolve, sep } from "node:path";
import type { ModuleHost, ModulePath, ModuleRoots } from "./types.js";

const VOYD_EXTENSION = ".voyd";

export const modulePathToString = (path: ModulePath): string => {
  const namespace = path.namespace === "pkg" && path.packageName ? `pkg:${path.packageName}` : path.namespace;
  return `${namespace}::${path.segments.join("::")}`;
};

export const modulePathFromFile = (filePath: string, roots: ModuleRoots): ModulePath => {
  const normalizedRoots = normalizeRoots(roots);
  const namespace = pickNamespace(filePath, normalizedRoots);
  const root = normalizedRoots[namespace];
  if (!root) {
    throw new Error(`Unable to determine root for namespace ${namespace}`);
  }
  const relativePath = relative(root, resolve(filePath));
  const withoutExt = relativePath.endsWith(VOYD_EXTENSION)
    ? relativePath.slice(0, -VOYD_EXTENSION.length)
    : relativePath;
  const rawSegments = withoutExt.split(sep).filter(Boolean);

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
  const normalizedRoots = normalizeRoots(roots);
  const root = await resolveRoot(path, normalizedRoots);
  if (!root) return undefined;

  const segmentsWithPkg =
    path.namespace === "pkg" && path.packageName
      ? [path.packageName, ...path.segments]
      : path.segments;

  const candidate = join(root, ...segmentsWithPkg) + VOYD_EXTENSION;
  const exists = await host.fileExists(candidate);
  if (exists) return resolve(candidate);

  const dir = join(root, ...segmentsWithPkg);
  const isDir = await host.isDirectory(dir);
  if (isDir) {
    const stem = dir + VOYD_EXTENSION;
    const stemExists = await host.fileExists(stem);
    if (stemExists) return resolve(stem);
  }

  for (let i = segmentsWithPkg.length - 1; i > 0; i -= 1) {
    const ancestor = join(root, ...segmentsWithPkg.slice(0, i)) + VOYD_EXTENSION;
    const ancestorExists = await host.fileExists(ancestor);
    if (ancestorExists) return resolve(ancestor);
  }

  return undefined;
};

type NormalizedRoots = Required<Pick<ModuleRoots, "src">> & ModuleRoots;

const normalizeRoots = (roots: ModuleRoots): NormalizedRoots => ({
  src: resolve(roots.src),
  std: roots.std ? resolve(roots.std) : roots.std,
  pkg: roots.pkg ? resolve(roots.pkg) : roots.pkg,
  resolvePackageRoot: roots.resolvePackageRoot,
});

const pickNamespace = (filePath: string, roots: NormalizedRoots): ModulePath["namespace"] => {
  const path = resolve(filePath);
  if (roots.src && path.startsWith(roots.src)) return "src";
  if (roots.std && path.startsWith(roots.std)) return "std";
  if (roots.pkg && path.startsWith(roots.pkg)) return "pkg";
  return "src";
};

const resolveRoot = async (
  path: ModulePath,
  roots: NormalizedRoots
): Promise<string | undefined> => {
  if (path.namespace === "src") return roots.src;
  if (path.namespace === "std") return roots.std;
  if (path.namespace === "pkg" && path.packageName) {
    const resolved = await roots.resolvePackageRoot?.(path.packageName);
    if (resolved) return resolve(resolved);
    if (roots.pkg) return join(roots.pkg, path.packageName);
  }
  return undefined;
};
