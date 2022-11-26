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
  const parts = usePath.split("/").map((v, index, arr) => {
    if (v === "src") return srcPath;
    if (v === "super") return "../";
    if (index === arr.length - 1) return `${v}.dm`;
    return v;
  });
  return path.resolve(...parts);
};
