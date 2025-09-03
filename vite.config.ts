import { defineConfig } from "vite";

// Build a browser-friendly ESM bundle that avoids Node-only paths.
export default defineConfig({
  build: {
    lib: {
      entry: "src/browser.ts",
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
    outDir: "dist",
    emptyOutDir: false,
  },
});
