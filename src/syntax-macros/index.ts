import { ParsedFiles } from "../lib/parse-directory.js";
import { List } from "../syntax-objects/list.js";
import { surfaceLanguage } from "./surface-language/index.js";

export const expandSyntaxMacrosOfFiles = (files: ParsedFiles): ParsedFiles => {
  const expanded: ParsedFiles = {};

  for (const [filePath, ast] of Object.entries(files)) {
    expanded[filePath] = expandSyntaxMacros(ast);
  }

  return expanded;
};

export const expandSyntaxMacros = (ast: List): List => surfaceLanguage(ast);
