# mini-wikipedia

Mini Voydpedia is a server-rendered Voyd app with a hydrated Voyd client module
and Tailwind assets built by Vite. Articles are local markdown files in
`data/articles`, so edits are easy to diff, seed, back up, or delete.

The browser TypeScript entrypoint only loads the compiled Voyd client wasm and
hydrates the server-rendered form. Routing, article lookup, rendering, client
editor state, client save behavior, and filesystem writes all live in Voyd:
`src/main.voyd` for the server and `src/client.voyd` for the browser.

## Scripts

- `npm run dev` builds the client assets, starts the Voyd SSR server, rebuilds
  assets when `src/client.voyd`, `src/**/*.ts`, or `src/**/*.css` changes, and
  restarts the server when other `src/**/*.voyd` files change.
- `npm run build` builds the Tailwind/client assets into `public/assets` and
  checks the Voyd server and client with optimized compilation.
- `npm start` runs the production-style SSR server.
- `npm run voyd:check` compiles the Voyd server and browser module.
- `npm run typecheck` checks the TypeScript helper scripts and wasm hydration
  entrypoint.

## Configuration

- `PORT` or `VOYD_WEB_PORT` changes the server port. The default is `3000`.
- `HOST` or `VOYD_WEB_HOST` changes the bind host. The default is
  `127.0.0.1`.

Article form posts accept request bodies up to 64 KiB by default. Adjust
`max_body_bytes` in `src/main.voyd` if your app needs larger edits.
