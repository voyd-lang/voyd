import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path, { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

const hasStdSourceLayout = (rootPath: string): boolean =>
  existsSync(path.join(rootPath, "pkg.voyd"));

export const resolveStdRoot = (): string => {
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
