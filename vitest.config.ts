import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "threads", // or: 'vmThreads'
  },
});
