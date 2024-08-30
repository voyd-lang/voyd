import path from "path";
import { parseDirectory } from "./parse-directory.js";
import { fileURLToPath } from "url";

export const stdPath = path.resolve(
  fileURLToPath(import.meta.url),
  "..",
  "..",
  "..",
  "..",
  "std"
);

export const parseStd = async () => parseDirectory(stdPath);
