import { createPosixPathAdapter } from "./path-adapter.js";
import type { ModuleHost, ModulePathAdapter } from "./types.js";

export const createMemoryModuleHost = ({
  files,
  pathAdapter = createPosixPathAdapter(),
}: {
  files: Record<string, string>;
  pathAdapter?: ModulePathAdapter;
}): ModuleHost => {
  const normalized = new Map<string, string>();
  const directories = new Map<string, Set<string>>();

  const ensureDir = (dir: string) => {
    if (!directories.has(dir)) {
      directories.set(dir, new Set());
    }
  };

  const normalizePath = (path: string) => pathAdapter.resolve(path);

  const registerPath = (path: string) => {
    const directParent = pathAdapter.dirname(path);
    ensureDir(directParent);
    directories.get(directParent)!.add(path);

    let current = directParent;
    while (true) {
      const parent = pathAdapter.dirname(current);
      if (parent === current) break;
      ensureDir(parent);
      directories.get(parent)!.add(current);
      current = parent;
    }
  };

  Object.entries(files).forEach(([path, contents]) => {
    const full = normalizePath(path);
    normalized.set(full, contents);
    registerPath(full);
  });

  const isDirectoryPath = (path: string) =>
    directories.has(path) && !normalized.has(path);

  return {
    path: pathAdapter,
    readFile: async (path: string) => {
      const resolved = normalizePath(path);
      const file = normalized.get(resolved);
      if (file === undefined) {
        throw new Error(`File not found: ${resolved}`);
      }
      return file;
    },
    readDir: async (path: string) => {
      const resolved = normalizePath(path);
      return Array.from(directories.get(resolved) ?? []);
    },
    fileExists: async (path: string) => normalized.has(normalizePath(path)),
    isDirectory: async (path: string) => isDirectoryPath(normalizePath(path)),
  };
};
