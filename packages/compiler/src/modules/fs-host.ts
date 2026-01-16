import { readFile, readdir, stat } from "node:fs/promises";
import type { ModuleHost } from "./types.js";
import { createNodePathAdapter } from "./node-path-adapter.js";

export const createFsModuleHost = (): ModuleHost => {
  const fileCache = new Map<string, boolean>();
  const dirCache = new Map<string, boolean>();
  const pathAdapter = createNodePathAdapter();

  const isDirectory = async (path: string): Promise<boolean> => {
    const cached = dirCache.get(path);
    if (typeof cached === "boolean") {
      return cached;
    }
    const result = await stat(path).then((info) => info.isDirectory()).catch(() => false);
    dirCache.set(path, result);
    return result;
  };

  const fileExists = async (path: string): Promise<boolean> => {
    const cached = fileCache.get(path);
    if (typeof cached === "boolean") {
      return cached;
    }
    const result = await stat(path).then((info) => info.isFile()).catch(() => false);
    fileCache.set(path, result);
    return result;
  };

  return {
    path: pathAdapter,
    readFile: (path: string) => readFile(path, "utf8"),
    readDir: (path: string) =>
      readdir(path).then((entries) =>
        entries.map((entry) => pathAdapter.join(path, entry))
      ),
    fileExists,
    isDirectory,
  };
};
