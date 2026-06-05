import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { compileVoyd } from "./scripts/compile-voyd.mjs";

const voyd = () => ({
  name: "voyd",
  async buildStart() {
    await compileVoyd();
  },
  configureServer(server) {
    server.watcher.add("src");
  },
  async handleHotUpdate(ctx) {
    if (!ctx.file.endsWith(".voyd")) return;

    await compileVoyd();
    ctx.server.ws.send({ type: "full-reload" });
    return [];
  },
});

export default defineConfig({
  plugins: [voyd(), tailwindcss()],
});
