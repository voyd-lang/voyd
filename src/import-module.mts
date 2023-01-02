import { File, List, ModuleInfo, resolveRootModule } from "./lib/index.mjs";
import { parse } from "./parser.mjs";
import fs from "node:fs";
import { syntaxMacros } from "./syntax-macros/index.mjs";

export type Module = { ast: List } & ModuleInfo;

export const importRootModule = (): Module => {
  const root = resolveRootModule();
  return importModule(root);
};

export const importModule = (info: ModuleInfo): Module => {
  const file = fs.readFileSync(info.path, { encoding: "utf8" });
  const parsed = parse(new File(file, info.path), { module: info });
  const ast = syntaxMacros.reduce((ast, macro) => macro(ast, info), parsed);

  return {
    ast: ast,
    ...info,
  };
};
