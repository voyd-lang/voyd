import path from "node:path";
import type { ModulePathAdapter } from "./types.js";

export const createNodePathAdapter = (): ModulePathAdapter => ({
  resolve: path.resolve,
  join: path.join,
  relative: path.relative,
  dirname: path.dirname,
  basename: path.basename,
  normalize: path.normalize,
});
