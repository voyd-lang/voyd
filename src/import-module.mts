import { ModuleInfo, resolveModule, resolveRootModule } from "./lib/index.mjs";
import { AST, parse } from "./parser.mjs";
import fs from "node:fs";
import { syntaxMacros } from "./syntax-macros/index.mjs";

export type Module = { ast: AST } & ModuleInfo;

export const importRootModule = (): Module => {
  const root = resolveRootModule();
  return importModule(root);
};

export const importModule = (info: ModuleInfo): Module => {
  const file = fs.readFileSync(info.path, { encoding: "utf8" });
  const ast = syntaxMacros.reduce(
    (ast, macro) => macro(ast, info),
    parse(file.split(""), { module: info })
  );
  return {
    ast: ast,
    ...info,
  };
};
