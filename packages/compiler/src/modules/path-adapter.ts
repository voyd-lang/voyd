import type { ModulePathAdapter } from "./types.js";
import {
  basename,
  dirname,
  joinPath,
  normalizePath,
  relativePath,
  resolvePath,
} from "./path-utils.js";

export const createPosixPathAdapter = (): ModulePathAdapter => ({
  resolve: resolvePath,
  join: joinPath,
  relative: relativePath,
  dirname,
  basename,
  normalize: normalizePath,
});
