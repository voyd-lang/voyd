import { basename, dirname, resolve } from "node:path";

const SOURCE_ROOT_DIR = "src";

const detectSrcRoot = (targetPath: string): string => {
  let current = resolve(targetPath);
  while (true) {
    if (basename(current) === SOURCE_ROOT_DIR) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return resolve(targetPath);
    }
    current = parent;
  }
};

export const detectSrcRootForPath = (targetPath: string): string => {
  const resolved = resolve(targetPath);
  return resolved.endsWith(".voyd")
    ? detectSrcRoot(dirname(resolved))
    : detectSrcRoot(resolved);
};
