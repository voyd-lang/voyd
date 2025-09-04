import { processSemantics } from "./semantics/index.js";
import binaryen from "binaryen";
import { codegen } from "./codegen.js";
import { parse } from "./parser/parser.js";
import { parseStd } from "./parser/utils/parse-std.js";
import type { List } from "./syntax-objects/list.js";

export const compile = async (text: string) => {
  const parsedModule = await browserParseModule(text);
  return compileParsedModule(parsedModule);
};

export const compileParsedModule = (module: ParsedModule): binaryen.Module => {
  const typeCheckedModule = processSemantics(module);
  return codegen(typeCheckedModule);
};

// Minimal browser-friendly version of parseModule
export type ParsedModule = {
  files: { [filePath: string]: List };
  indexPath: string;
};

export const browserParseModule = async (text: string): Promise<ParsedModule> => {
  return {
    files: {
      index: parse(text),
      ...(await parseStd()),
    },
    indexPath: "index",
  };
};
