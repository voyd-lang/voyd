import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import compression from "vite-plugin-compression";
// Some environments import CJS default slightly differently. Normalize below.
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [
    tailwindcss(),
    reactRouter(),
    tsconfigPaths(),
    // Pre-compress assets for better load times (serves .gz and .br)
    compression({ algorithm: "gzip", ext: ".gz" }),
    compression({ algorithm: "brotliCompress", ext: ".br" }),
  ],
  resolve: {
    // Keep symlinked packages under node_modules path
    preserveSymlinks: true,
    alias: [
      // Avoid bundling Node-only deps pulled via optional paths in `voyd`
      { find: /^glob(\/.*)?$/, replacement: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "stubs/glob.ts") },
      { find: /^node:fs$/, replacement: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "stubs/node-fs.ts") },
      { find: /^node:path$/, replacement: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "stubs/node-path.ts") },
    ],
  },
  optimizeDeps: {
    // Ensure binaryen (voyd's dependency) is pre-bundled by Vite
    include: ["binaryen"],
    esbuildOptions: {
      supported: {
        "top-level-await": true,
      },
    },
  },
  esbuild: {
    supported: {
      "top-level-await": true, //browsers can handle top-level-await features
    },
  },
  worker: {
    // Needed when worker graph has code-splitting (e.g. dynamic imports)
    format: "es",
    rollupOptions: {
      output: {
        // Split large deps (e.g. binaryen) out of the worker entry
        manualChunks(id) {
          if (id.includes("node_modules/binaryen")) return "binaryen";
          if (id.includes("node_modules/@msgpack")) return "msgpack";
          if (id.includes("node_modules/@voyd")) return "voyd-lib";
        },
      },
    },
  },
});
