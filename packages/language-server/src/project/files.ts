import path, { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { access, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { URI } from "vscode-uri";
import { createFsModuleHost } from "@voyd/compiler/modules/fs-host.js";
import { createMemoryModuleHost } from "@voyd/compiler/modules/memory-host.js";
import { createNodePathAdapter } from "@voyd/compiler/modules/node-path-adapter.js";
import type { ModuleHost, ModuleRoots } from "@voyd/compiler/modules/types.js";

const require = createRequire(import.meta.url);

const dedupe = <T>(values: readonly T[]): T[] => Array.from(new Set(values));

const fsExists = async (targetPath: string): Promise<boolean> =>
  access(targetPath)
    .then(() => true)
    .catch(() => false);

const collectNodeModulesDirs = (startDir: string): string[] => {
  const dirs: string[] = [];
  let current = path.resolve(startDir);

  while (true) {
    dirs.push(path.join(current, "node_modules"));
    const parent = path.dirname(current);
    if (parent === current) {
      return dirs;
    }
    current = parent;
  }
};

const hasStdSourceLayout = (rootPath: string): boolean =>
  existsSync(path.join(rootPath, "pkg.voyd"));

const resolveStdRoot = (): string => {
  const envRoot = process.env.VOYD_STD_ROOT;
  if (envRoot) {
    const resolvedEnvRoot = path.resolve(envRoot);
    if (hasStdSourceLayout(resolvedEnvRoot)) {
      return resolvedEnvRoot;
    }
  }

  const packageJsonPath = require.resolve("@voyd/std/package.json");
  const packageRoot = dirname(packageJsonPath);
  const srcRoot = join(packageRoot, "src");
  return hasStdSourceLayout(srcRoot) ? srcRoot : packageRoot;
};

export const normalizeFilePath = (filePath: string): string => path.resolve(filePath);

export const toFileUri = (filePath: string): string =>
  URI.file(path.resolve(filePath)).toString();

export const toFilePath = (uri: string): string => URI.parse(uri).fsPath;

export const collectVoydFiles = async (root: string): Promise<string[]> => {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        return collectVoydFiles(fullPath);
      }
      return fullPath.endsWith(".voyd") ? [fullPath] : [];
    }),
  );
  return nested.flat();
};

export const resolveEntryPath = async (filePath: string): Promise<string> => {
  const resolvedFile = path.resolve(filePath);
  let current = path.dirname(resolvedFile);

  while (true) {
    const pkgEntry = path.join(current, "pkg.voyd");
    if (await fsExists(pkgEntry)) {
      return pkgEntry;
    }

    const mainEntry = path.join(current, "main.voyd");
    if (await fsExists(mainEntry)) {
      return mainEntry;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return resolvedFile;
    }
    current = parent;
  }
};

export const resolveModuleRoots = (entryPath: string): ModuleRoots => {
  const src = path.dirname(entryPath);
  return {
    src,
    std: resolveStdRoot(),
    pkgDirs: dedupe(collectNodeModulesDirs(src)),
  };
};

export const createOverlayModuleHost = ({
  openDocuments,
}: {
  openDocuments: ReadonlyMap<string, string>;
}): ModuleHost => {
  const primary = createMemoryModuleHost({
    files: Object.fromEntries(openDocuments.entries()),
    pathAdapter: createNodePathAdapter(),
  });
  const fallback = createFsModuleHost();

  return {
    path: primary.path,
    readFile: async (filePath: string) =>
      (await primary.fileExists(filePath))
        ? primary.readFile(filePath)
        : fallback.readFile(filePath),
    readDir: async (dirPath: string) => {
      const [primaryDir, fallbackDir] = await Promise.all([
        primary.isDirectory(dirPath),
        fallback.isDirectory(dirPath),
      ]);

      if (!primaryDir && !fallbackDir) {
        return [];
      }

      const [primaryEntries, fallbackEntries] = await Promise.all([
        primaryDir ? primary.readDir(dirPath) : Promise.resolve([]),
        fallbackDir ? fallback.readDir(dirPath) : Promise.resolve([]),
      ]);

      return dedupe([...primaryEntries, ...fallbackEntries]);
    },
    fileExists: async (filePath: string) =>
      (await primary.fileExists(filePath)) || fallback.fileExists(filePath),
    isDirectory: async (dirPath: string) =>
      (await primary.isDirectory(dirPath)) || fallback.isDirectory(dirPath),
  };
};
