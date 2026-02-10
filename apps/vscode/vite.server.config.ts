import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    conditions: ["development"],
  },
  ssr: {
    noExternal: true,
  },
  build: {
    ssr: path.resolve(__dirname, "../../packages/language-server/src/server.ts"),
    outDir: "dist",
    emptyOutDir: false,
    sourcemap: true,
    minify: false,
    target: "node16",
    rollupOptions: {
      output: {
        format: "cjs",
        entryFileNames: "server.js",
        inlineDynamicImports: true,
      },
    },
  },
});
