import type { Config } from "@react-router/dev/config";

const basename = process.env.GITHUB_PAGES_BASE_PATH?.trim() || "/";

export default {
  // Config options...
  // Server-side render by default, to enable SPA mode set this to `false`
  ssr: true,
  // Pre-render all routes for static hosting on GitHub Pages
  prerender: true,
  // Avoid runtime manifest patch requests on static hosts.
  routeDiscovery: {
    mode: "initial",
  },
  // Use the repo subpath when deployed to GitHub Pages project sites.
  basename,
} satisfies Config;
