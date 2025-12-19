import type { ModulePath } from "../modules/types.js";

export const packageIdFromPath = (path: ModulePath): string => {
  if (path.namespace === "pkg") {
    return `pkg:${path.packageName ?? "unknown"}`;
  }
  if (path.namespace === "std") {
    return "std";
  }
  return "local";
};

export const isPackageRootModule = (path: ModulePath): boolean =>
  path.segments.length === 1 && path.segments[0] === "pkg";

export const isSamePackage = (
  left: ModulePath | undefined,
  right: ModulePath | undefined
): boolean => {
  if (!left || !right) return false;
  return packageIdFromPath(left) === packageIdFromPath(right);
};
