import type {
  ModuleHost,
  ModulePath,
  ModulePathAdapter,
  ModuleRoots,
} from "./types.js";

const VOYD_EXTENSION = ".voyd";
const PACKAGE_SOURCE_DIR = "src";

export type ResolvedModuleFile = {
  filePath: string;
  modulePath: ModulePath;
};

export const modulePathToString = (path: ModulePath): string => {
  const namespace =
    path.namespace === "pkg" && path.packageName
      ? `pkg:${path.packageName}`
      : path.namespace;
  return `${namespace}::${path.segments.join("::")}`;
};

export const modulePathFromFile = (
  filePath: string,
  roots: ModuleRoots,
  pathAdapter: ModulePathAdapter
): ModulePath => {
  const normalizedRoots = normalizeRoots(roots, pathAdapter);
  const resolvedFilePath = pathAdapter.resolve(filePath);

  if (
    normalizedRoots.std &&
    isWithinRoot({
      candidate: resolvedFilePath,
      root: normalizedRoots.std,
      pathAdapter,
    })
  ) {
    return {
      namespace: "std",
      segments: toModuleSegments(
        pathAdapter.relative(normalizedRoots.std, resolvedFilePath),
      ),
    };
  }

  const packagePath = modulePathFromPackageFile({
    filePath: resolvedFilePath,
    roots: normalizedRoots,
    pathAdapter,
  });
  if (packagePath) {
    return packagePath;
  }

  return {
    namespace: "src",
    segments: toModuleSegments(
      pathAdapter.relative(normalizedRoots.src, resolvedFilePath),
    ),
  };
};

export const resolveModuleFile = async (
  path: ModulePath,
  roots: ModuleRoots,
  host: ModuleHost
): Promise<ResolvedModuleFile | undefined> => {
  const pathAdapter = host.path;
  const normalizedRoots = normalizeRoots(roots, pathAdapter);
  const requestedSegments =
    path.namespace === "pkg" && path.segments.length === 0
      ? ["pkg"]
      : path.segments;

  if (path.namespace === "src") {
    const resolved = await resolveFromRoot({
      root: normalizedRoots.src,
      requestedSegments,
      host,
    });
    if (!resolved) return undefined;
    return {
      filePath: resolved.filePath,
      modulePath: { namespace: "src", segments: resolved.segments },
    };
  }

  if (path.namespace === "std") {
    if (!normalizedRoots.std) return undefined;
    const resolved = await resolveFromRoot({
      root: normalizedRoots.std,
      requestedSegments,
      host,
    });
    if (!resolved) return undefined;
    return {
      filePath: resolved.filePath,
      modulePath: { namespace: "std", segments: resolved.segments },
    };
  }

  if (!path.packageName) return undefined;

  const packageSourceRoots = await resolvePackageSourceRoots({
    packageName: path.packageName,
    roots: normalizedRoots,
    host,
  });

  for (const root of packageSourceRoots) {
    const resolved = await resolveFromRoot({
      root,
      requestedSegments,
      host,
    });
    if (!resolved) continue;
    return {
      filePath: resolved.filePath,
      modulePath: {
        namespace: "pkg",
        packageName: path.packageName,
        segments: resolved.segments,
      },
    };
  }

  return undefined;
};

type NormalizedRoots = Required<Pick<ModuleRoots, "src">> &
  Omit<ModuleRoots, "pkgDirs"> & {
    pkgDirs: readonly string[];
  };

const normalizeRoots = (
  roots: ModuleRoots,
  pathAdapter: ModulePathAdapter
): NormalizedRoots => {
  const pkgDirs = dedupePaths(
    [roots.pkg, ...(roots.pkgDirs ?? [])]
      .filter((dir): dir is string => Boolean(dir))
      .map((dir) => pathAdapter.resolve(dir)),
  );

  return {
    src: pathAdapter.resolve(roots.src),
    std: roots.std ? pathAdapter.resolve(roots.std) : roots.std,
    pkg: roots.pkg ? pathAdapter.resolve(roots.pkg) : roots.pkg,
    pkgDirs,
    resolvePackageRoot: roots.resolvePackageRoot,
  };
};

const dedupePaths = (paths: readonly string[]): string[] =>
  Array.from(new Set(paths));

const toModuleSegments = (value: string): string[] => {
  const normalized = value.replace(/\\/g, "/");
  const withoutExt = normalized.endsWith(VOYD_EXTENSION)
    ? normalized.slice(0, -VOYD_EXTENSION.length)
    : normalized;
  return withoutExt.split("/").filter(Boolean);
};

const isWithinRoot = ({
  candidate,
  root,
  pathAdapter,
}: {
  candidate: string;
  root: string;
  pathAdapter: ModulePathAdapter;
}): boolean => {
  const relative = pathAdapter.relative(root, candidate).replace(/\\/g, "/");
  return (
    relative === "" ||
    (!relative.startsWith("..") && !relative.startsWith("/"))
  );
};

const modulePathFromPackageFile = ({
  filePath,
  roots,
  pathAdapter,
}: {
  filePath: string;
  roots: NormalizedRoots;
  pathAdapter: ModulePathAdapter;
}): ModulePath | undefined => {
  const packageRoots = [...roots.pkgDirs].sort((left, right) =>
    right.length - left.length,
  );

  for (const packageRoot of packageRoots) {
    if (!isWithinRoot({ candidate: filePath, root: packageRoot, pathAdapter })) {
      continue;
    }

    const relative = pathAdapter.relative(packageRoot, filePath);
    const parts = relative.replace(/\\/g, "/").split("/").filter(Boolean);
    const packageName = parts[0];
    if (!packageName || parts.length < 2) {
      continue;
    }

    const moduleParts =
      parts[1] === PACKAGE_SOURCE_DIR && parts.length > 2
        ? parts.slice(2)
        : parts.slice(1);
    const segments = toModuleSegments(moduleParts.join("/"));
    if (segments.length === 0) {
      continue;
    }

    return {
      namespace: "pkg",
      packageName,
      segments,
    };
  }

  return undefined;
};

const resolvePackageSourceRoots = async ({
  packageName,
  roots,
  host,
}: {
  packageName: string;
  roots: NormalizedRoots;
  host: ModuleHost;
}): Promise<readonly string[]> => {
  const pathAdapter = host.path;
  const candidates: string[] = [];

  if (packageName === "std" && roots.std) {
    candidates.push(roots.std);
  }

  const resolvedFromHook = await roots.resolvePackageRoot?.(packageName);
  if (resolvedFromHook) {
    const normalized = pathAdapter.resolve(resolvedFromHook);
    candidates.push(
      ...packageSourceRootCandidates({
        packageRoot: normalized,
        pathAdapter,
      }),
    );
  }

  roots.pkgDirs.forEach((packagesDir) => {
    const packageRoot = pathAdapter.join(packagesDir, packageName);
    candidates.push(
      ...packageSourceRootCandidates({
        packageRoot,
        pathAdapter,
      }),
    );
  });

  return dedupePaths(candidates);
};

const packageSourceRootCandidates = ({
  packageRoot,
  pathAdapter,
}: {
  packageRoot: string;
  pathAdapter: ModulePathAdapter;
}): string[] => {
  const normalizedPackageRoot = pathAdapter.resolve(packageRoot);
  const sourceRoot = pathAdapter.join(normalizedPackageRoot, PACKAGE_SOURCE_DIR);
  if (pathAdapter.basename(normalizedPackageRoot) === PACKAGE_SOURCE_DIR) {
    return [normalizedPackageRoot];
  }
  return [sourceRoot, normalizedPackageRoot];
};

const resolveFromRoot = async ({
  root,
  requestedSegments,
  host,
}: {
  root: string;
  requestedSegments: readonly string[];
  host: ModuleHost;
}): Promise<{ filePath: string; segments: string[] } | undefined> => {
  for (let length = requestedSegments.length; length > 0; length -= 1) {
    const candidateSegments = requestedSegments.slice(0, length);
    const candidateFile =
      host.path.join(root, ...candidateSegments) + VOYD_EXTENSION;
    const exists = await host.fileExists(candidateFile);
    if (!exists) {
      continue;
    }
    return {
      filePath: host.path.resolve(candidateFile),
      segments: [...candidateSegments],
    };
  }
  return undefined;
};
