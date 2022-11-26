import { ModuleInfo, resolveModule, resolveRootModule } from "./lib/index.mjs";
import { AST, parse } from "./parser.mjs";
import fs from "node:fs";
import { syntaxMacros } from "./syntax-macros/index.mjs";

export type Module = { module: AST } & ModuleInfo;

export const importRootModule = (): Module => {
  const root = resolveRootModule();
  return importModule(root.moduleId, root.srcPath, true);
};

export const importModule = (
  usePath: string,
  srcPath: string,
  isRoot = false
): Module => {
  const module = resolveModule(usePath, srcPath, isRoot);
  const file = fs.readFileSync(module.path, { encoding: "utf8" });
  const ast = syntaxMacros.reduce(
    (ast, macro) => macro(ast, module),
    parse(file.split(""), { module })
  );
  return {
    module: ast,
    ...module,
  };
};
