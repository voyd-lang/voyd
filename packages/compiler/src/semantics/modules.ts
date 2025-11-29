import type { ParsedModule } from "../parser/utils/parse-module.js";
import { stdPath } from "../parser/utils/parse-std.js";
import { List } from "../syntax-objects/list.js";
import { RootModule, VoydModule } from "../syntax-objects/module.js";

/** Registers submodules of a parsed module for future import resolution */
export const registerModules = (opts: ParsedModule): VoydModule => {
  const { srcPath, files } = opts;

  const rootModule = new RootModule({});

  for (const [filePath, file] of Object.entries(files)) {
    const resolvedPath = filePathToModulePath(
      filePath,
      srcPath ?? opts.indexPath
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
  parentModule: VoydModule;
  ast: List;
  isIndex?: boolean;
}): VoydModule | undefined => {
  const [name, ...rest] = path;

  if (!name) return;

  const existingModule = parentModule.resolveEntity(name);

  if (existingModule && !existingModule.isModule()) {
    throw new Error(
      `Cannot register module ${name} because it is already registered as ${existingModule.syntaxType}`
    );
  }

  if (!existingModule && (name === "index" || name === "mod")) {
    parentModule.value = ast.toArray();
    registerDefaultImports(parentModule);
    parentModule.getAllEntities().forEach((e) => {
      if (e.isModule()) parentModule.push(e);
    });
    return;
  }

  const module =
    existingModule ??
    new VoydModule({
      ...(!rest.length ? { ...ast.metadata, value: ast.toArray() } : {}),
      name,
      isIndex,
    });

  if (!existingModule) {
    parentModule.push(module);
    registerDefaultImports(module);
  }

  if (!existingModule && (module.name.is("src") || module.name.is("std"))) {
    parentModule.registerExport(module);
  }

  if (existingModule && !rest.length) {
    module.unshift(...ast.toArray().reverse());
  }

  if (!rest.length) return;

  return registerModule({ path: rest, parentModule: module, ast });
};

const filePathToModulePath = (filePath: string, srcPath: string) => {
  let finalPath = filePath.startsWith(stdPath)
    ? filePath.replace(stdPath, "std")
    : filePath;

  finalPath = finalPath.startsWith(srcPath)
    ? finalPath.replace(srcPath, "src")
    : finalPath;

  finalPath = finalPath.replace(".voyd", "");

  return finalPath;
};

const registerDefaultImports = (module: VoydModule) => {
  module.unshift(new List(["use", ["::", "root", "all"]]));
  const mod = module.resolveModule("std");
  if (mod) return;
  module.unshift(new List(["use", ["::", "std", "all"]]));
};
