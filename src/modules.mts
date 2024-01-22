import { resolve } from "path";
import { ParsedDirectory } from "./lib/parse-directory.mjs";
import { List } from "./syntax-objects/list.mjs";
import { VoidModule } from "./syntax-objects/module.mjs";

export const resolveModules = (opts: {
  /** Path to the std lib directory */
  stdPath: string;
  /** Path to the user source code */
  srcPath: string;
  parsedFiles: ParsedDirectory;
}): VoidModule => {
  const { stdPath, srcPath, parsedFiles } = opts;

  const rootModule = new VoidModule({
    name: "root",
    ast: new List({ value: [] }),
  });

  for (const [filePath, file] of Object.entries(parsedFiles)) {
    const resolvedPath = resolveFilePath(filePath, srcPath, stdPath);
    const parsedPath = resolvedPath.split("/");
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

  if (!existingModule) parentModule.registerEntity(module);

  if (!rest.length) return;

  return registerModule({ path: rest, parentModule: module, ast });
};

const resolveFilePath = (filePath: string, srcPath: string, stdPath: string) =>
  resolve(
    filePath
      .replace(srcPath, "src")
      .replace(stdPath, "std")
      .replace(".void", "")
  );
