import { defineConfig, mergeConfig } from "vitest/config";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import viteConfig from "./vite.config.js";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const timingDirectory = process.env.VOYD_TEST_TIMINGS_DIR;
const timingScope = (relative(projectRoot, process.cwd()) || "root").replace(
  /[^a-zA-Z0-9_-]+/g,
  "-",
);
const configuredMaxWorkers = Number.parseInt(
  process.env.VITEST_MAX_WORKERS ?? "",
  10,
);
const defaultMaxWorkers = process.env.CI ? 1 : undefined;

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      pool: "threads", // or: 'vmThreads'
      testTimeout: 30000,
      hookTimeout: 30000,
      maxWorkers: Number.isFinite(configuredMaxWorkers)
        ? configuredMaxWorkers
        : defaultMaxWorkers,
      reporters: timingDirectory
        ? [
            "dot",
            [
              "json",
              {
                outputFile: resolve(timingDirectory, `${timingScope}.json`),
              },
            ],
          ]
        : ["dot"],
      silent: "passed-only",
    },
  }),
);
