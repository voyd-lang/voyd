import { defineConfig } from "vite";
import { compileClientVoyd } from "./scripts/compile-client-voyd.mjs";

const voydClient = () => ({
  name: "voyd-client",
  async buildStart() {
    await compileClientVoyd();
  },
  configureServer(server) {
    server.watcher.add("src/client.voyd");
  },
  async handleHotUpdate(ctx) {
    if (!ctx.file.endsWith("client.voyd")) return;

    await compileClientVoyd();
    ctx.server.ws.send({ type: "full-reload" });
    return [];
  },
});

export default defineConfig({
  plugins: [voydClient()],
  publicDir: false,
  resolve: {
    conditions: ["development"],
  },
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
