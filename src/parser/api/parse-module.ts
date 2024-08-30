import { resolveSrc } from "../../lib/resolve-src.js";
import { parse } from "../parser.js";
import { ParsedFiles, parseDirectory } from "./parse-directory.js";
import { parseFile } from "./parse-file.js";
import { parseStd } from "./parse-std.js";

export type ParsedModule = {
  files: ParsedFiles;
  /** Path to src directory (a folder containing index.void that acts as entry) if available */
  srcPath?: string;
  /** Path to root void file */
  indexPath: string;
};

/** Parses void text and std lib into a module unit */
export const parseModule = async (text: string): Promise<ParsedModule> => {
  return {
    files: {
      index: parse(text),
      ...(await parseStd()),
    },
    indexPath: "index",
  };
};

/** Parses a void codebase source and std into a module unit */
export const parseModuleFromSrc = async (
  path: string
): Promise<ParsedModule> => {
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
