import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.js";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      pool: "threads", // or: 'vmThreads'
      hookTimeout: 30000,
    },
  }),
);
