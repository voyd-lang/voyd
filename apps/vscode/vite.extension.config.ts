import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  ssr: {
    noExternal: true,
  },
  build: {
    ssr: path.resolve(__dirname, "src/extension.ts"),
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    target: "node16",
    rollupOptions: {
      external: ["vscode"],
      output: {
        format: "cjs",
        entryFileNames: "extension.js",
        inlineDynamicImports: true,
      },
    },
  },
});
