import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss()],
  publicDir: false,
  build: {
    outDir: "public",
    emptyOutDir: false,
    manifest: false,
    rollupOptions: {
      input: "src/client.ts",
      output: {
        entryFileNames: "assets/client.js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
