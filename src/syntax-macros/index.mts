import { ParsedFiles } from "../lib/parse-directory.mjs";
import { List } from "../syntax-objects/list.mjs";
import { surfaceLanguage } from "./surface-language/index.mjs";

export const expandSyntaxMacrosOfFiles = (files: ParsedFiles): ParsedFiles => {
  const expanded: ParsedFiles = {};

  for (const [filePath, ast] of Object.entries(files)) {
    expanded[filePath] = expandSyntaxMacros(ast);
  }

  return expanded;
};

export const expandSyntaxMacros = (ast: List): List => surfaceLanguage(ast);
