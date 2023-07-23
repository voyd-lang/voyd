import { File, List, ModuleInfo, resolveRootModule } from "./lib/index.mjs";
import { parse } from "./parser.mjs";
import fs from "node:fs";
import { syntaxMacros } from "./syntax-macros/index.mjs";
import { getConfig } from "./config/index.mjs";

export type Module = { ast: List } & ModuleInfo;

export const importRootModule = (): Module => {
  const root = resolveRootModule(getConfig().index);
  return importModule(root);
};

export const importModule = (info: ModuleInfo): Module => {
  const file = fs.readFileSync(info.path, { encoding: "utf8" });
  const parsed = parse(new File(file, info.path));
  const ast = syntaxMacros.reduce((ast, macro) => macro(ast, info), parsed);

  return {
    ast: ast,
    ...info,
  };
};

export const parseFile = (path: string) => {
  const file = fs.readFileSync(path, { encoding: "utf8" });
  return parse(new File(file, path));
};
