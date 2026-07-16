import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BootstrapTemplate } from "../config/types.js";
import { webSsrLoader } from "./loaders/web-ssr.js";
import { vxSpaLoader } from "./loaders/vx-spa.js";
import type {
  BootstrapConfig,
  BootstrapContext,
  BootstrapLoader,
  BootstrapPlan,
  BootstrapResult,
  BootstrapVoydPackage,
} from "./types.js";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json") as { version: string };
const VOYD_MONOREPO_PACKAGE_NAME = "voyd-monorepo";

const loaders = new Map<BootstrapTemplate, BootstrapLoader>([
  [vxSpaLoader.id, vxSpaLoader],
  [webSsrLoader.id, webSsrLoader],
]);

const voydWorkspacePaths: Record<BootstrapVoydPackage, string> = {
  "@voyd-lang/cli": "apps/cli",
  "@voyd-lang/compiler": "packages/compiler",
  "@voyd-lang/js-host": "packages/js-host",
  "@voyd-lang/lib": "packages/lib",
  "@voyd-lang/package-adapter": "packages/package-adapter",
  "@voyd-lang/sdk": "packages/sdk",
  "@voyd-lang/std": "packages/std",
  "@voyd-lang/vx-dom": "packages/vx-dom",
  "@voyd-lang/web": "packages/web",
};

export async function runBootstrap(
  config: BootstrapConfig,
): Promise<BootstrapResult> {
  const targetDir = resolve(config.dir);
  const loader = loaders.get(config.template);
  if (!loader) {
    throw new Error(`Unknown bootstrap template: ${config.template}`);
  }

  const context = createContext({
    targetDir,
    usePublished: config.usePublished ?? false,
  });
  const plan = loader.plan(context);
  if (!config.force && !config.dryRun) {
    await assertTargetWritable(targetDir);
  }

  if (!config.dryRun) {
    await applyPlan(targetDir, plan);
  }

  return {
    targetDir,
    template: plan.template,
    dryRun: config.dryRun ?? false,
    localVoydRoot: context.localVoydRoot,
    files: plan.files.map((file) => file.path),
    nextSteps: plan.nextSteps,
  };
}

export function printBootstrapResult(result: BootstrapResult): void {
  const verb = result.dryRun ? "Would create" : "Created";
  console.log(`${verb} ${result.template} project in ${result.targetDir}`);
  if (result.localVoydRoot) {
    console.log(`Using local Voyd packages from ${result.localVoydRoot}`);
  }
  console.log("");
  result.files.forEach((file) => console.log(`  ${file}`));

  if (result.nextSteps.length === 0 || result.dryRun) {
    return;
  }

  console.log("");
  console.log("Next steps:");
  console.log(`  cd ${formatShellArg(result.targetDir)}`);
  result.nextSteps.forEach((step) => console.log(`  ${step}`));
}

const createContext = ({
  targetDir,
  usePublished,
}: {
  targetDir: string;
  usePublished: boolean;
}): BootstrapContext => {
  const localVoydRoot = usePublished ? undefined : detectLocalVoydRoot();
  return {
    targetDir,
    packageName: toPackageName(basename(targetDir)),
    voydVersion: version,
    localVoydRoot,
    voydPackageSpec: (name) => localVoydRoot
      ? pathToFileURL(resolve(localVoydRoot, voydWorkspacePaths[name])).href
      : `^${version}`,
  };
};

export const detectLocalVoydRoot = (
  moduleUrl: string = import.meta.url,
): string | undefined => {
  const moduleDir = dirname(fileURLToPath(moduleUrl));
  const candidate = resolve(moduleDir, "../../../..");
  try {
    const packageJson = JSON.parse(
      readFileSync(resolve(candidate, "package.json"), "utf8"),
    ) as { name?: unknown };
    return packageJson.name === VOYD_MONOREPO_PACKAGE_NAME
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
};

const toPackageName = (value: string): string => {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "voyd-vx-app";
};

const formatShellArg = (value: string): string =>
  `'${value.replace(/'/g, "'\\''")}'`;

const assertTargetWritable = async (targetDir: string): Promise<void> => {
  try {
    const stats = await stat(targetDir);
    if (!stats.isDirectory()) {
      throw new Error(`Bootstrap target exists and is not a directory: ${targetDir}`);
    }
  } catch (error) {
    if (isNotFoundError(error)) return;
    throw error;
  }

  const entries = await readdir(targetDir);
  if (entries.length > 0) {
    throw new Error(
      `Bootstrap target is not empty: ${targetDir}. Use --force to write the starter files anyway.`,
    );
  }
};

const applyPlan = async (
  targetDir: string,
  plan: BootstrapPlan,
): Promise<void> => {
  await mkdir(targetDir, { recursive: true });
  await Promise.all(
    plan.files.map(async (file) => {
      const targetPath = resolve(targetDir, file.path);
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, file.content);
    }),
  );
};

const isNotFoundError = (error: unknown): boolean =>
  !!error &&
  typeof error === "object" &&
  "code" in error &&
  (error as { code?: unknown }).code === "ENOENT";
