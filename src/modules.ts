import { ParsedFiles } from "./lib/parse-directory.js";
import { List } from "./syntax-objects/list.js";
import { VoidModule } from "./syntax-objects/module.js";

export const resolveFileModules = (opts: {
  /** Path to the std lib directory */
  stdPath: string;
  /** Path to the user source code root folder */
  srcPath?: string;
  /** Path to the entry index file, which determines what is exported from the package */
  indexPath: string;
  files: ParsedFiles;
}): VoidModule => {
  const { stdPath, srcPath, files } = opts;

  const rootModule = new VoidModule({ name: "root" });

  for (const [filePath, file] of Object.entries(files)) {
    const resolvedPath = filePathToModulePath(
      filePath,
      srcPath ?? opts.indexPath,
      stdPath
    );

    const parsedPath = resolvedPath.split("/").filter(Boolean);

    registerModule({
      path: parsedPath,
      parentModule: rootModule,
      ast: file.slice(1), // Skip the first element (ast)
      isIndex: filePath === opts.indexPath,
    });
  }

  return rootModule;
};

const registerModule = ({
  path,
  parentModule,
  ast,
  isIndex,
}: {
  path: string[];
  parentModule: VoidModule;
  ast: List;
  isIndex?: boolean;
}): VoidModule | undefined => {
  const [name, ...rest] = path;

  if (!name) return;

  const existingModule = parentModule.resolveChildEntity(name);

  if (existingModule && !existingModule.isModule()) {
    throw new Error(
      `Cannot register module ${name} because it is already registered as ${existingModule.syntaxType}`
    );
  }

  if (!existingModule && name === "index") {
    parentModule.push(...ast.toArray());
    return;
  }

  const module =
    existingModule ??
    new VoidModule({
      ...(!rest.length ? { ...ast.metadata, value: ast.toArray() } : {}),
      name,
      isIndex,
    });
  module.isExported = true;

  if (!existingModule) parentModule.push(module);

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
