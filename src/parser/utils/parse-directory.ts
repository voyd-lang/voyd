import { resolve } from "node:path";
import { glob } from "glob";
import { List } from "../../syntax-objects/index.js";
import { parseFile } from "./parse-file.js";

export type ParsedFiles = { [filePath: string]: List };

export const parseDirectory = async (path: string): Promise<ParsedFiles> => {
  const files = await glob(resolve(path, "**/*.void"));

  const parsed = await Promise.all(
    files.map(async (filePath) => ({
      filePath,
      ast: await parseFile(filePath),
    }))
  );

  return parsed.reduce((acc, { filePath, ast }) => {
    acc[filePath] = ast;
    return acc;
  }, {} as ParsedFiles);
};
