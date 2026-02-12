import { resolve } from "node:path";
import { collectNodeModulesDirs } from "@voyd/sdk";

export const resolvePackageDirs = ({
  srcRoot,
  additionalPkgDirs,
}: {
  srcRoot: string;
  additionalPkgDirs: readonly string[];
}): string[] => {
  const configured = additionalPkgDirs.map((dir) => resolve(srcRoot, dir));
  const nodeModules = collectNodeModulesDirs(srcRoot);
  return Array.from(new Set([...configured, ...nodeModules]));
};
