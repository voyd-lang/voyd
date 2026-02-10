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

export const resolveModuleRequest = (
  request: ModuleRequest,
  importer: ModulePath,
  options: { anchorToSelf?: boolean; parentHops?: number } = {}
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
    importer.segments.length === 1 && importer.segments[0] === "pkg";
  const importerAnchorSegments = importerIsPackageRoot ? [] : importer.segments;
  const superBaseSegments =
    parentHops > 0
      ? importer.segments.slice(
          0,
          Math.max(importer.segments.length - parentHops, 0),
        )
      : [];
  const baseSegments = anchorToSelf
    ? importerIsPackageRoot
      ? []
      : importer.segments
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
}: {
  dependencyPath: ModulePath;
  entry: ModulePathMatchEntry;
  currentModulePath: ModulePath;
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
    const currentAnchorSegments =
      currentModulePath.segments.length === 1 &&
      currentModulePath.segments[0] === "pkg"
        ? []
        : currentModulePath.segments;
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
    const relativeKey = relativeSegments.join("::");
    return allEntryKeys.some((key) => key === relativeKey);
  }

  if ((entry.parentHops ?? 0) > 0) {
    const sameNamespace = dependencyPath.namespace === currentModulePath.namespace;
    const samePackage = dependencyPath.packageName === currentModulePath.packageName;
    if (!sameNamespace || !samePackage) {
      return false;
    }
    const hops = entry.parentHops ?? 0;
    const parentAnchorSegments = currentModulePath.segments.slice(
      0,
      Math.max(currentModulePath.segments.length - hops, 0),
    );
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
    const relativeKey = relativeSegments.join("::");
    return allEntryKeys.some((key) => key === relativeKey);
  }

  const depSegments = dependencyPath.segments.join("::");
  const namespacedDepKey = [dependencyPath.namespace, ...dependencyPath.segments].join(
    "::"
  );
  if (allEntryKeys.some((key) => key === depSegments || key === namespacedDepKey)) {
    return true;
  }

  if (dependencyPath.namespace === "pkg" && dependencyPath.packageName) {
    const packageKey = `${dependencyPath.namespace}::${dependencyPath.packageName}`;
    const pkgKey = [dependencyPath.packageName, ...dependencyPath.segments].join("::");
    const namespacedPkgKey = [
      dependencyPath.namespace,
      dependencyPath.packageName,
      ...dependencyPath.segments,
    ].join("::");
    if (
      allEntryKeys.some(
        (key) =>
          key === packageKey ||
          key === dependencyPath.packageName ||
          key === pkgKey ||
          key === namespacedPkgKey
      )
    ) {
      return true;
    }
  }
  return false;
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
