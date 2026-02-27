import type { ModulePath } from "../modules/types.js";

const PACKAGE_ROOT_SEGMENT = "pkg";

type PackagePathOptions = {
  sourcePackageRoot?: readonly string[];
};

export const packageIdFromPath = (
  path: ModulePath,
  options: PackagePathOptions = {},
): string => {
  if (path.namespace === "pkg") {
    return `pkg:${path.packageName ?? "unknown"}`;
  }
  if (path.namespace === "std") {
    return "std";
  }
  const sourcePackageRoot = options.sourcePackageRoot;
  if (sourcePackageRoot && sourcePackageRoot.length > 0) {
    return `local:${sourcePackageRoot.join("::")}`;
  }
  return "local";
};

export const isPackageRootModule = (
  path: ModulePath,
  options: PackagePathOptions = {},
): boolean => {
  if (path.segments.at(-1) !== PACKAGE_ROOT_SEGMENT) {
    return false;
  }
  if (path.namespace !== "src") {
    return true;
  }
  const sourcePackageRoot = options.sourcePackageRoot;
  if (!sourcePackageRoot) {
    return path.segments.length === 1;
  }
  if (path.segments.length !== sourcePackageRoot.length + 1) {
    return false;
  }
  return sourcePackageRoot.every(
    (segment, index) => path.segments[index] === segment,
  );
};

export const isSamePackage = (
  left: ModulePath | undefined,
  right: ModulePath | undefined
): boolean => {
  if (!left || !right) return false;
  return packageIdFromPath(left) === packageIdFromPath(right);
};
