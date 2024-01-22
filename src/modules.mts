import { resolve } from "path";
import { ParsedFiles } from "./lib/parse-directory.mjs";
import { List } from "./syntax-objects/list.mjs";
import { VoidModule } from "./syntax-objects/module.mjs";

export const resolveFileModules = (opts: {
  /** Path to the std lib directory */
  stdPath: string;
  /** Path to the user source code */
  srcPath: string;
  files: ParsedFiles;
}): VoidModule => {
  const { stdPath, srcPath, files } = opts;

  const rootModule = new VoidModule({
    name: "root",
    ast: new List({ value: [] }),
  });

  for (const [filePath, file] of Object.entries(files)) {
    const resolvedPath = filePathToModulePath(filePath, srcPath, stdPath);
    const parsedPath = resolvedPath.split("/").filter(Boolean);
    registerModule({ path: parsedPath, parentModule: rootModule, ast: file });
  }

  return rootModule;
};

const registerModule = ({
  path,
  parentModule,
  ast,
}: {
  path: string[];
  parentModule: VoidModule;
  ast: List;
}): VoidModule | undefined => {
  const [name, ...rest] = path;

  if (!name) return;

  const existingModule = parentModule.resolveChildModule(name);

  const module =
    existingModule ??
    new VoidModule({
      name,
      ast: rest.length ? new List({ value: [] }) : ast,
    });

  if (!existingModule) parentModule.pushChildModule(module);

  if (!rest.length) return;

  return registerModule({ path: rest, parentModule: module, ast });
};

const filePathToModulePath = (
  filePath: string,
  srcPath: string,
  stdPath: string
) => {
  let finalPath = filePath.startsWith(stdPath)
    ? filePath.replace(stdPath, "std")
    : filePath;

  finalPath = finalPath.startsWith(srcPath)
    ? finalPath.replace(srcPath, "src")
    : finalPath;

  finalPath = finalPath.replace(".void", "");

  return finalPath;
};
