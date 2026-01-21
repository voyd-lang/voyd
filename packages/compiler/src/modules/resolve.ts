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
};

export const resolveModuleRequest = (
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
  const parentSegments = importer.segments.slice(0, -1);
  const hasExplicitNamespace = normalized.namespace !== undefined;
  const baseSegments = anchorToSelf
    ? importer.segments
    : !hasExplicitNamespace && parentSegments.length > 0
    ? parentSegments
    : [];
  const segments = [...baseSegments, ...normalizedSegments];

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

  if (entry.anchorToSelf) {
    const sameNamespace = dependencyPath.namespace === currentModulePath.namespace;
    const samePackage = dependencyPath.packageName === currentModulePath.packageName;
    if (!sameNamespace || !samePackage) {
      return false;
    }
    const hasModulePrefix =
      dependencyPath.segments.length >= currentModulePath.segments.length &&
      dependencyPath.segments
        .slice(0, currentModulePath.segments.length)
        .every((segment, index) => segment === currentModulePath.segments[index]);
    if (!hasModulePrefix) {
      return false;
    }
    const relativeSegments = dependencyPath.segments.slice(
      currentModulePath.segments.length
    );
    const relativeKey = relativeSegments.join("::");
    return entryKeys.some((key) => key === relativeKey);
  }

  const depSegments = dependencyPath.segments.join("::");
  const namespacedDepKey = [dependencyPath.namespace, ...dependencyPath.segments].join(
    "::"
  );
  if (entryKeys.some((key) => key === depSegments || key === namespacedDepKey)) {
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
      entryKeys.some(
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
  const sameNamespace = dependencyPath.namespace === currentModulePath.namespace;
  const samePackage = dependencyPath.packageName === currentModulePath.packageName;
  if (sameNamespace && samePackage) {
    const parentSegments = currentModulePath.segments.slice(0, -1);
    if (parentSegments.length > 0) {
      const hasParentPrefix =
        dependencyPath.segments.length >= parentSegments.length &&
        dependencyPath.segments
          .slice(0, parentSegments.length)
          .every((segment, index) => segment === parentSegments[index]);
      if (hasParentPrefix) {
        const relativeSegments = dependencyPath.segments.slice(
          parentSegments.length
        );
        const relativeKey = relativeSegments.join("::");
        if (entryKeys.some((key) => key === relativeKey)) {
          return true;
        }
      }
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

  const packageName =
    namespace === "pkg" ? request.packageName ?? segments.shift() : request.packageName;

  return {
    namespace,
    packageName,
    segments,
  };
};
