import { existsSync } from "node:fs";
import path from "node:path";

export type ModuleInfo = {
  moduleId: string;
  path: string;
  srcPath: string;
  isRoot: boolean;
};

export const resolveRootModule = (): ModuleInfo => {
  const filePath = process.argv[2];
  const parsed = path.parse(filePath);
  const srcPath = path.resolve(parsed.dir);
  return resolveModule(`src/${parsed.name}`, srcPath, true);
};

export const resolveModule = (
  usePath: string,
  srcPath: string,
  isRoot = false
): ModuleInfo => {
  const modulePath = getModulePath(usePath, srcPath);
  const parsed = path.parse(modulePath);
  return {
    moduleId: `${parsed.dir.replace(srcPath, "src")}/${parsed.name}`,
    path: modulePath,
    srcPath,
    isRoot,
  };
};

export const getModulePath = (usePath: string, srcPath: string): string => {
  const split = usePath.split("/");
  const parts = split.map((v, index, arr) => {
    if (v === "src") return srcPath;
    if (v === "super") return path.resolve(srcPath, "../");
    if (v === "dir") return path.resolve(srcPath, "./");
    // We check the last item to see if its a file or folder later
    if (index === arr.length - 1) return "";
    return v;
  });
  const moduleName = split.pop();
  const prefix = path.resolve(...parts);
  const filePath = path.resolve(prefix, `${moduleName}.dm`);
  return existsSync(filePath) ? filePath : path.resolve(prefix, "index.dm");
};
