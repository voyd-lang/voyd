import path, { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { access, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { URI } from "vscode-uri";
import { createFsModuleHost } from "@voyd/compiler/modules/fs-host.js";
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

const resolveStdRootFromPackage = (): string | undefined => {
  try {
    const packageJsonPath = require.resolve("@voyd/std/package.json");
    const packageRoot = dirname(packageJsonPath);
    const srcRoot = join(packageRoot, "src");
    return hasStdSourceLayout(srcRoot) ? srcRoot : packageRoot;
  } catch {
    return undefined;
  }
};

const resolveStdRoot = (): string => {
  const envRoot = process.env.VOYD_STD_ROOT;
  const resolvedEnvRoot = envRoot ? path.resolve(envRoot) : undefined;
  if (resolvedEnvRoot && hasStdSourceLayout(resolvedEnvRoot)) {
    return resolvedEnvRoot;
  }

  const packageRoot = resolveStdRootFromPackage();
  if (packageRoot) {
    return packageRoot;
  }

  if (resolvedEnvRoot) {
    return resolvedEnvRoot;
  }

  return path.resolve(process.cwd(), "node_modules", "@voyd", "std", "src");
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

const resolveSrcRootFromEntry = (entryPath: string): string => {
  const fallback = path.dirname(path.resolve(entryPath));
  let current = fallback;

  while (true) {
    if (path.basename(current) === "src") {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return fallback;
    }
    current = parent;
  }
};

export const resolveModuleRoots = (entryPath: string): ModuleRoots => {
  const src = resolveSrcRootFromEntry(entryPath);
  return {
    src,
    std: resolveStdRoot(),
    pkgDirs: dedupe(collectNodeModulesDirs(src)),
  };
};

export const createOverlayModuleHost = ({
  openDocuments,
  fallbackHost,
}: {
  openDocuments: ReadonlyMap<string, string>;
  fallbackHost?: ModuleHost;
}): ModuleHost => {
  const pathAdapter = createNodePathAdapter();
  const fallback = fallbackHost ?? createFsModuleHost();
  const resolvePath = (targetPath: string): string => pathAdapter.resolve(targetPath);
  const openFilesInDir = (dirPath: string): string[] => {
    const normalizedDir = resolvePath(dirPath);
    const prefix = `${normalizedDir}${path.sep}`;
    return Array.from(openDocuments.keys()).filter(
      (filePath) =>
        filePath.startsWith(prefix) &&
        pathAdapter.dirname(filePath) === normalizedDir,
    );
  };

  return {
    path: pathAdapter,
    readFile: async (filePath: string) =>
      openDocuments.get(resolvePath(filePath)) ?? fallback.readFile(filePath),
    readDir: async (dirPath: string) => {
      const openEntries = openFilesInDir(dirPath);
      const [primaryDir, fallbackDir] = await Promise.all([
        Promise.resolve(openEntries.length > 0),
        fallback.isDirectory(dirPath),
      ]);

      if (!primaryDir && !fallbackDir) {
        return [];
      }

      const fallbackEntries = await (fallbackDir
        ? fallback.readDir(dirPath)
        : Promise.resolve([]));
      return dedupe([...openEntries, ...fallbackEntries]);
    },
    fileExists: async (filePath: string) =>
      openDocuments.has(resolvePath(filePath)) || fallback.fileExists(filePath),
    isDirectory: async (dirPath: string) =>
      openFilesInDir(dirPath).length > 0 || fallback.isDirectory(dirPath),
  };
};
