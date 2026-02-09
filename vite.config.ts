import { defineConfig } from "vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tsconfigPaths from "vite-tsconfig-paths";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

// Build a browser-friendly ESM bundle that avoids Node-only paths.
export default defineConfig({
  plugins: [
    tsconfigPaths({
      projects: [resolve(projectRoot, "tsconfig.typecheck.base.json")],
    }),
  ],
  test: {
    reporters: ["dot"],
    silent: "passed-only",
  },
  build: {
    lib: {
      entry: resolve(projectRoot, "packages/sdk/src/browser.ts"),
      formats: ["es"],
      fileName: () => "browser/index.js",
    },
    rollupOptions: {
      // Keep dependencies as external; consumers' bundlers will resolve them.
      // This prevents bundling large deps like binaryen by default and avoids
      // pulling in Node-only deps (glob/minipass) via optional paths.
      external: [
        /^(binaryen|@msgpack\/msgpack)$/,
        /^glob(\/.*)?$/,
        /^minipass(\/.*)?$/,
        /^path-scurry(\/.*)?$/,
        /^node:.*/, // any Node builtins referenced deep inside externals
      ],
    },
    target: "esnext",
    sourcemap: true,
    outDir: resolve(projectRoot, "packages/sdk/dist"),
    emptyOutDir: false,
  },
});
