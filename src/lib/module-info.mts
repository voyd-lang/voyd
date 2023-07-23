import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const stdPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../std"
);

export type ModuleInfo = {
  moduleId: string;
  path: string;
  srcPath: string;
  isRoot: boolean;
  workingDir: string;
  imports: ModuleImports;
};

export type ModuleImports = [ModuleInfo, string, "re-exported"?][];

export const resolveRootModule = (filePath: string): ModuleInfo => {
  const parsed = path.parse(filePath);
  const srcPath = path.resolve(parsed.dir);
  return resolveModule({
    usePath: `src/${parsed.name}`,
    srcPath,
    isRoot: true,
    workingDir: srcPath,
  });
};

export const resolveModule = ({
  usePath,
  srcPath,
  isRoot,
  workingDir,
}: {
  usePath: string;
  srcPath: string;
  workingDir: string;
  isRoot?: boolean;
}): ModuleInfo => {
  const modulePath = getModulePath({ usePath, srcPath, workingDir });
  const parsed = path.parse(modulePath);
  const prefix = parsed.dir.includes(stdPath)
    ? parsed.dir.replace(stdPath, "std")
    : parsed.dir.replace(srcPath, "src");
  return {
    moduleId: `${prefix}/${parsed.name}`,
    path: modulePath,
    srcPath,
    isRoot: isRoot ?? false,
    workingDir: parsed.dir,
    imports: [],
  };
};

export const getModulePath = ({
  usePath,
  srcPath,
  workingDir,
}: {
  workingDir: string;
  usePath: string;
  srcPath: string;
}): string => {
  const split = usePath.split("/");
  const prefix = split.reduce((partialPath, part, index, arr) => {
    if (part === "src") return srcPath;
    if (part === "super") return path.resolve(partialPath, "../");
    if (part === "dir") return path.resolve(partialPath, "./");
    if (part === "std") return stdPath;
    // We check the last item to see if its a file or folder later
    if (index === split.length - 1) return partialPath;
    return path.resolve(partialPath, part);
  }, workingDir);
  const moduleName = split.pop();
  const filePath = path.resolve(prefix, `${moduleName}.void`);
  return existsSync(filePath) ? filePath : path.resolve(prefix, "index.void");
};
