import type { Config } from "@react-router/dev/config";

export default {
  // Config options...
  // Server-side render by default, to enable SPA mode set this to `false`
  ssr: true,
  // Pre-render all routes for static hosting on GitHub Pages
  prerender: true,
} satisfies Config;
