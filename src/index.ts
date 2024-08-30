import { parseFile } from "./parser/api/parse-file.js";
import { resolveSrc } from "./lib/resolve-src.js";
import { CharStream } from "./parser/char-stream.js";
import { parse } from "./parser/parser.js";
import { resolveFileModules } from "./modules.js";
import { expandRegularMacros } from "./regular-macros.js";
import { typeCheck } from "./semantics/index.js";
import binaryen from "binaryen";
import { genWasmCode } from "./wasm-code-gen.js";
import { ParsedFiles, parseDirectory } from "./parser/api/parse-directory.js";
import { stdPath, parseStd } from "./parser/api/parse-std.js";

export type ParsedModule = {
  files: ParsedFiles;
  /** Path to src directory (a folder containing index.void that acts as entry) if available */
  srcPath?: string;
  /** Path to root void file */
  indexPath: string;
};

export const compileText = async (text: string) => {
  const parsedModule = await parseText(text);
  return compileParsedModule(parsedModule);
};

export const compilePath = async (path: string) => {
  const parsedModule = await parsePath(path);
  return compileParsedModule(parsedModule);
};

export const compileParsedModule = (module: ParsedModule): binaryen.Module => {
  const moduleResolvedModule = resolveFileModules({
    ...module,
    stdPath: stdPath,
  });
  const regularMacroExpandedModule = expandRegularMacros(moduleResolvedModule);
  const typeCheckedModule = typeCheck(regularMacroExpandedModule);
  return genWasmCode(typeCheckedModule);
};

export const parseText = async (text: string): Promise<ParsedModule> => {
  return {
    files: {
      index: parse(text),
      ...(await parseStd()),
    },
    indexPath: "index",
  };
};

export const parsePath = async (path: string): Promise<ParsedModule> => {
  const src = await resolveSrc(path);

  const srcFiles = src.srcRootPath
    ? await parseDirectory(src.srcRootPath)
    : { [src.indexPath]: await parseFile(src.indexPath) };

  return {
    files: {
      ...srcFiles,
      ...(await parseStd()),
    },
    srcPath: src.srcRootPath,
    indexPath: src.indexPath,
  };
};
