import path from "node:path";

const SOURCE_ROOT_DIR = "src";

const detectSrcRoot = (targetPath: string): string => {
  const resolvedTarget = path.resolve(targetPath);
  let current = resolvedTarget;

  while (true) {
    if (path.basename(current) === SOURCE_ROOT_DIR) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return resolvedTarget;
    }

    current = parent;
  }
};

export const detectSrcRootForPath = (targetPath: string): string => {
  const resolvedTarget = path.resolve(targetPath);
  return resolvedTarget.endsWith(".voyd")
    ? detectSrcRoot(path.dirname(resolvedTarget))
    : detectSrcRoot(resolvedTarget);
};
