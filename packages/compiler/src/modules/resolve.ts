import type { SourceSpan } from "../semantics/ids.js";
import type { ModulePath } from "./types.js";

export type ModuleRequest = {
  segments: readonly string[];
  namespace?: ModulePath["namespace"];
  packageName?: string;
  span?: SourceSpan;
};

export type ModulePathMatchEntry = {
  moduleSegments: readonly string[];
  path: readonly string[];
  anchorToSelf?: boolean;
  parentHops?: number;
};

const PACKAGE_ROOT_SEGMENT = "pkg";

const packageAnchorSegments = ({
  path,
  isPackageRoot,
}: {
  path: ModulePath;
  isPackageRoot: boolean;
}): readonly string[] =>
  isPackageRoot ? path.segments.slice(0, -1) : path.segments;

const parentAnchorSegmentsFor = ({
  path,
  parentHops,
  isPackageRoot,
}: {
  path: ModulePath;
  parentHops: number;
  isPackageRoot: boolean;
}): readonly string[] => {
  const base = packageAnchorSegments({ path, isPackageRoot });
  const effectiveHops = isPackageRoot
    ? Math.max(parentHops - 1, 0)
    : parentHops;
  return base.slice(0, Math.max(base.length - effectiveHops, 0));
};

const srcAliasNamespaceFor = ({
  importerNamespace,
}: {
  importerNamespace: ModulePath["namespace"];
}): ModulePath["namespace"] | undefined =>
  importerNamespace === "pkg" || importerNamespace === "std"
    ? importerNamespace
    : undefined;

const resolveRequestNamespace = ({
  requestNamespace,
  importerNamespace,
}: {
  requestNamespace?: ModulePath["namespace"];
  importerNamespace: ModulePath["namespace"];
}): ModulePath["namespace"] => {
  if (requestNamespace !== "src") {
    return requestNamespace ?? importerNamespace;
  }

  return srcAliasNamespaceFor({ importerNamespace }) ?? requestNamespace;
};

const aliasSrcEntryKey = ({
  key,
  importerNamespace,
}: {
  key: string;
  importerNamespace: ModulePath["namespace"];
}): string | undefined => {
  const aliasNamespace = srcAliasNamespaceFor({ importerNamespace });
  if (!aliasNamespace) {
    return undefined;
  }
  if (key === "src") {
    return aliasNamespace === "pkg" ? "pkg" : `${aliasNamespace}::pkg`;
  }
  if (!key.startsWith("src::")) {
    return undefined;
  }

  const keySuffix = key.slice("src::".length);
  return aliasNamespace === "pkg" ? keySuffix : `${aliasNamespace}::${keySuffix}`;
};

const srcAliasEntryKeysFor = ({
  entryKeys,
  importerNamespace,
}: {
  entryKeys: readonly string[];
  importerNamespace: ModulePath["namespace"];
}): string[] =>
  entryKeys.flatMap((key) => {
    const aliased = aliasSrcEntryKey({ key, importerNamespace });
    return aliased ? [aliased] : [];
  });

const segmentVariantsForMatching = (
  segments: readonly string[],
  options: { allowImplicitPackageRootAlias?: boolean } = {},
): readonly (readonly string[])[] =>
  options.allowImplicitPackageRootAlias !== false &&
  segments.at(-1) === PACKAGE_ROOT_SEGMENT
    ? [segments, segments.slice(0, -1)]
    : [segments];

const keyForSegments = (segments: readonly string[]): string | undefined =>
  segments.length > 0 ? segments.join("::") : undefined;

const dependencyMatchKeysFor = ({
  segments,
  namespace,
  packageName,
  includeNamespace = false,
  includePackageName = false,
  allowImplicitPackageRootAlias = true,
}: {
  segments: readonly string[];
  namespace?: ModulePath["namespace"];
  packageName?: string;
  includeNamespace?: boolean;
  includePackageName?: boolean;
  allowImplicitPackageRootAlias?: boolean;
}): readonly string[] => {
  const keys = new Set<string>();

  segmentVariantsForMatching(segments, { allowImplicitPackageRootAlias }).forEach(
    (variant) => {
      const segmentKey = keyForSegments(variant);
      if (segmentKey) {
        keys.add(segmentKey);
      }

      if (includeNamespace && namespace) {
        const namespacedKey = keyForSegments([namespace, ...variant]);
        if (namespacedKey) {
          keys.add(namespacedKey);
        }
      }

      if (!includePackageName || !packageName) {
        return;
      }

      keys.add(packageName);
      const packageKey = keyForSegments([packageName, ...variant]);
      if (packageKey) {
        keys.add(packageKey);
      }
      if (includeNamespace && namespace) {
        keys.add(`${namespace}::${packageName}`);
        const namespacedPackageKey = keyForSegments([
          namespace,
          packageName,
          ...variant,
        ]);
        if (namespacedPackageKey) {
          keys.add(namespacedPackageKey);
        }
      }
    },
  );

  return [...keys];
};

const hasMatchingEntryKey = ({
  entryKeys,
  dependencyKeys,
}: {
  entryKeys: readonly string[];
  dependencyKeys: readonly string[];
}): boolean =>
  dependencyKeys.some((dependencyKey) =>
    entryKeys.some((entryKey) => entryKey === dependencyKey),
  );

export const resolveModuleRequest = (
  request: ModuleRequest,
  importer: ModulePath,
  options: {
    anchorToSelf?: boolean;
    parentHops?: number;
    importerIsPackageRoot?: boolean;
  } = {}
): ModulePath => {
  const normalized = normalizeRequest(request);
  const namespace = resolveRequestNamespace({
    requestNamespace: normalized.namespace,
    importerNamespace: importer.namespace,
  });
  const packageName =
    namespace === "pkg"
      ? normalized.packageName ?? importer.packageName
      : normalized.packageName;
  const normalizedSegments =
    namespace === "pkg" && normalized.segments.length === 0
      ? ["pkg"]
      : normalized.segments;

  const anchorToSelf = options.anchorToSelf ?? false;
  const parentHops = options.parentHops ?? 0;
  const importerIsPackageRoot =
    options.importerIsPackageRoot ??
    (importer.namespace !== "src" &&
      importer.segments.at(-1) === PACKAGE_ROOT_SEGMENT);
  const importerAnchorSegments = packageAnchorSegments({
    path: importer,
    isPackageRoot: importerIsPackageRoot,
  });
  const superBaseSegments =
    parentHops > 0
      ? parentAnchorSegmentsFor({
          path: importer,
          parentHops,
          isPackageRoot: importerIsPackageRoot,
        })
      : [];
  const baseSegments = anchorToSelf
    ? importerAnchorSegments
    : parentHops > 0
    ? superBaseSegments
    : [];
  const segments = [...(anchorToSelf ? importerAnchorSegments : baseSegments), ...normalizedSegments];

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

export const matchesDependencyPath = ({
  dependencyPath,
  entry,
  currentModulePath,
  currentModuleIsPackageRoot = false,
  allowImplicitPackageRootAlias = true,
}: {
  dependencyPath: ModulePath;
  entry: ModulePathMatchEntry;
  currentModulePath: ModulePath;
  currentModuleIsPackageRoot?: boolean;
  allowImplicitPackageRootAlias?: boolean;
}): boolean => {
  const entryKeys = [
    entry.moduleSegments.length > 0 ? entry.moduleSegments.join("::") : undefined,
    entry.path.length > 0 ? entry.path.join("::") : undefined,
  ].filter((value): value is string => Boolean(value));
  const srcAliasEntryKeys = srcAliasEntryKeysFor({
    entryKeys,
    importerNamespace: currentModulePath.namespace,
  });
  const allEntryKeys = [...entryKeys, ...srcAliasEntryKeys];
  if (entry.moduleSegments.length === 1 && entry.moduleSegments[0] === "std") {
    allEntryKeys.push("std::pkg");
  }

  if (entry.anchorToSelf) {
    const sameNamespace = dependencyPath.namespace === currentModulePath.namespace;
    const samePackage = dependencyPath.packageName === currentModulePath.packageName;
    if (!sameNamespace || !samePackage) {
      return false;
    }
    const currentAnchorSegments = packageAnchorSegments({
      path: currentModulePath,
      isPackageRoot: currentModuleIsPackageRoot,
    });
    const hasModulePrefix =
      dependencyPath.segments.length >= currentAnchorSegments.length &&
      dependencyPath.segments
        .slice(0, currentAnchorSegments.length)
        .every((segment, index) => segment === currentAnchorSegments[index]);
    if (!hasModulePrefix) {
      return false;
    }
    const relativeSegments = dependencyPath.segments.slice(
      currentAnchorSegments.length
    );
    return hasMatchingEntryKey({
      entryKeys: allEntryKeys,
      dependencyKeys: dependencyMatchKeysFor({
        segments: relativeSegments,
        allowImplicitPackageRootAlias,
      }),
    });
  }

  if ((entry.parentHops ?? 0) > 0) {
    const sameNamespace = dependencyPath.namespace === currentModulePath.namespace;
    const samePackage = dependencyPath.packageName === currentModulePath.packageName;
    if (!sameNamespace || !samePackage) {
      return false;
    }
    const hops = entry.parentHops ?? 0;
    const parentAnchorSegments = parentAnchorSegmentsFor({
      path: currentModulePath,
      parentHops: hops,
      isPackageRoot: currentModuleIsPackageRoot,
    });
    const hasParentPrefix =
      dependencyPath.segments.length >= parentAnchorSegments.length &&
      dependencyPath.segments
        .slice(0, parentAnchorSegments.length)
        .every((segment, index) => segment === parentAnchorSegments[index]);
    if (!hasParentPrefix) {
      return false;
    }
    const relativeSegments = dependencyPath.segments.slice(
      parentAnchorSegments.length,
    );
    return hasMatchingEntryKey({
      entryKeys: allEntryKeys,
      dependencyKeys: dependencyMatchKeysFor({
        segments: relativeSegments,
        allowImplicitPackageRootAlias,
      }),
    });
  }

  return hasMatchingEntryKey({
    entryKeys: allEntryKeys,
    dependencyKeys: dependencyMatchKeysFor({
      segments: dependencyPath.segments,
      namespace: dependencyPath.namespace,
      packageName:
        dependencyPath.namespace === "pkg"
          ? dependencyPath.packageName
          : undefined,
      includeNamespace: true,
      includePackageName:
        dependencyPath.namespace === "pkg" &&
        typeof dependencyPath.packageName === "string",
    }),
  });
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

  if (namespace === "std" && segments.length === 0) {
    segments.push("pkg");
  }

  const packageName =
    namespace === "pkg" ? request.packageName ?? segments.shift() : request.packageName;

  if (namespace === "pkg" && packageName === "std") {
    const stdSegments = segments.length === 0 ? ["pkg"] : segments;
    return {
      namespace: "std",
      segments: stdSegments,
    };
  }

  return {
    namespace,
    packageName,
    segments,
  };
};
