import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

export const resolveStdRoot = (): string => {
  const packageJsonPath = require.resolve("@voyd/std/package.json");
  const packageRoot = dirname(packageJsonPath);
  const srcRoot = join(packageRoot, "src");
  return existsSync(srcRoot) ? srcRoot : packageRoot;
};

