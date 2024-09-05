import path from "path";
import { ParsedFiles, parseDirectory } from "./parse-directory.js";
import { fileURLToPath } from "url";

export const stdPath = path.resolve(
  fileURLToPath(import.meta.url),
  "..",
  "..",
  "..",
  "..",
  "std"
);

let cache: ParsedFiles | undefined = undefined;
export const parseStd = async () => {
  if (cache) {
    return cloneParsedFiles(cache);
  }

  const parsed = await parseDirectory(stdPath);
  cache = cloneParsedFiles(parsed);
  return parsed;
};

const cloneParsedFiles = (parsed: ParsedFiles) =>
  Object.entries(parsed).reduce(
    (acc, [key, value]) => ({ ...acc, [key]: value.clone() }),
    {} as ParsedFiles
  );

// Convert the object
