import { readdir, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolve as resolveImport } from "import-meta-resolve";
import {
  isVoydPackageAdapter,
  VOYD_PACKAGE_ADAPTER_ABI,
  type VoydPackageAdapter,
} from "@voyd-lang/package-adapter";
import { parseExternalRequirements } from "@voyd-lang/js-host";

type AdapterMetadata = {
  abi?: number;
  interfaces?: readonly string[];
  browser?: string;
  node?: string;
  default?: string;
};

type VoydPackageJson = {
  name?: string;
  voyd?: {
    adapter?: AdapterMetadata;
  };
};

export const loadVoydPackageAdapters = async ({
  wasm,
  startDir = process.cwd(),
}: {
  wasm: Uint8Array | WebAssembly.Module;
  startDir?: string;
}): Promise<VoydPackageAdapter[]> => {
  const module =
    wasm instanceof WebAssembly.Module
      ? wasm
      : new WebAssembly.Module(wasm as Uint8Array<ArrayBuffer>);
  const requiredInterfaces = new Set(
    parseExternalRequirements(module).functions.map((fn) => fn.interfaceId),
  );
  if (requiredInterfaces.size === 0) return [];
  const providers = await findAdapterProviders({ requiredInterfaces, startDir });
  const missing = [...requiredInterfaces].filter(
    (interfaceId) => !providers.has(interfaceId),
  );
  if (missing.length > 0) {
    throw new Error(
      `Missing installed Voyd package adapters for interfaces: ${missing.join(", ")}`,
    );
  }
  const unique = new Map<string, AdapterProvider>();
  providers.forEach((provider) => unique.set(provider.packageName, provider));
  return Promise.all(
    [...unique.values()].map((provider) => loadAdapter(provider, startDir)),
  );
};

export const findVoydPackageAdapterSpecifiers = async ({
  interfaceIds,
  startDir = process.cwd(),
}: {
  interfaceIds: readonly string[];
  startDir?: string;
}): Promise<string[]> => {
  const requiredInterfaces = new Set(interfaceIds);
  const providers = await findAdapterProviders({ requiredInterfaces, startDir });
  const missing = [...requiredInterfaces].filter(
    (interfaceId) => !providers.has(interfaceId),
  );
  if (missing.length > 0) {
    throw new Error(
      `Missing installed Voyd package adapters for interfaces: ${missing.join(", ")}`,
    );
  }
  return [...new Map(
    [...providers.values()].map((provider) => [
      provider.packageName,
      adapterSpecifier(provider, "browser"),
    ]),
  ).values()].sort();
};

type AdapterProvider = {
  packageName: string;
  packageRoot: string;
  metadata: AdapterMetadata;
};

const findAdapterProviders = async ({
  requiredInterfaces,
  startDir,
}: {
  requiredInterfaces: ReadonlySet<string>;
  startDir: string;
}): Promise<Map<string, AdapterProvider>> => {
  const providers = new Map<string, AdapterProvider>();
  const shadowedPackageNames = new Set<string>();
  for (const nodeModulesDir of collectNodeModulesDirs(startDir)) {
    const packageRoots = await listPackageRoots(nodeModulesDir);
    for (const packageRoot of packageRoots) {
      const parsed = await readPackageJson(packageRoot);
      if (!parsed?.name || shadowedPackageNames.has(parsed.name)) continue;
      shadowedPackageNames.add(parsed.name);
      const metadata = parsed?.voyd?.adapter;
      if (!metadata?.interfaces) continue;
      const matchingInterfaces = metadata.interfaces.filter((interfaceId) =>
        requiredInterfaces.has(interfaceId),
      );
      if (matchingInterfaces.length === 0) continue;
      if (metadata.abi !== VOYD_PACKAGE_ADAPTER_ABI) {
        throw new Error(
          `Voyd package adapter ${parsed.name} declares unsupported ABI ${String(metadata.abi)}; expected ${VOYD_PACKAGE_ADAPTER_ABI}`,
        );
      }
      matchingInterfaces.forEach((interfaceId) => {
        const existing = providers.get(interfaceId);
        if (existing && existing.packageName !== parsed.name) {
          throw new Error(
            `Multiple installed Voyd package adapters provide ${interfaceId}: ${existing.packageName}, ${parsed.name}`,
          );
        }
        providers.set(interfaceId, {
          packageName: parsed.name!,
          packageRoot,
          metadata,
        });
      });
    }
  }
  return providers;
};

const loadAdapter = async (
  provider: AdapterProvider,
  startDir: string,
): Promise<VoydPackageAdapter> => {
  const specifier = adapterSpecifier(provider, "node");
  const parentUrl = pathToFileURL(
    path.join(path.resolve(startDir), "__voyd_adapter_resolver.mjs"),
  ).href;
  const resolved = resolveImport(specifier, parentUrl);
  const loaded = (await import(resolved)) as {
    default?: unknown;
  };
  if (!isVoydPackageAdapter(loaded.default)) {
    throw new Error(
      `Voyd package adapter ${provider.packageName} entry ${specifier} does not default-export a VoydPackageAdapter`,
    );
  }
  return loaded.default;
};

const adapterSpecifier = (
  provider: AdapterProvider,
  runtime: "browser" | "node",
): string => {
  const entry = provider.metadata[runtime] ?? provider.metadata.default;
  if (!entry) {
    throw new Error(
      `Voyd package adapter ${provider.packageName} has no ${runtime} or default entry`,
    );
  }
  if (entry.startsWith("./")) return `${provider.packageName}/${entry.slice(2)}`;
  return entry;
};

const collectNodeModulesDirs = (startDir: string): string[] => {
  const dirs: string[] = [];
  let current = path.resolve(startDir);
  while (true) {
    dirs.push(path.join(current, "node_modules"));
    const parent = path.dirname(current);
    if (parent === current) return dirs;
    current = parent;
  }
};

const listPackageRoots = async (nodeModulesDir: string): Promise<string[]> => {
  const entries: Dirent[] = await readdir(nodeModulesDir, {
    withFileTypes: true,
  }).catch(() => [] as Dirent[]);
  const roots = await Promise.all(
    entries.map(async (entry): Promise<string[]> => {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) return [];
      const candidate = path.join(nodeModulesDir, entry.name);
      if (!entry.name.startsWith("@")) return [candidate];
      return readdir(candidate, { withFileTypes: true })
        .then((scoped) =>
          scoped
            .filter((child) => child.isDirectory() || child.isSymbolicLink())
            .map((child) => path.join(candidate, child.name)),
        )
        .catch(() => []);
    }),
  );
  return roots.flat();
};

const readPackageJson = async (
  packageRoot: string,
): Promise<VoydPackageJson | undefined> =>
  readFile(path.join(packageRoot, "package.json"), "utf8")
    .then((source) => JSON.parse(source) as VoydPackageJson)
    .catch(() => undefined);
