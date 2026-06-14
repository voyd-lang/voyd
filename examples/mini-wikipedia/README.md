# mini-wikipedia

Mini Voydpedia is a server-rendered Voyd app with Tailwind assets built by Vite.
Articles are local markdown files in `data/articles`, so edits are easy to
diff, seed, back up, or delete.

## Scripts

- `npm run dev` builds the client assets, starts the Voyd SSR server, rebuilds
  assets when `src/**/*.ts` or `src/**/*.css` changes, and restarts the server
  when `src/**/*.voyd` changes.
- `npm run build` builds the Tailwind/client assets into `public/assets` and
  checks the Voyd server with optimized compilation.
- `npm start` runs the production-style SSR server.
- `npm run voyd:check` compiles only the Voyd server.
- `npm run typecheck` checks the TypeScript helper scripts and client code.

## Configuration

- `PORT` or `VOYD_WEB_PORT` changes the server port. The default is `3000`.
- `HOST` or `VOYD_WEB_HOST` changes the bind host. The default is
  `127.0.0.1`.

The article save endpoint accepts request bodies up to 64 KiB by default. Adjust
`max_body_bytes` in `src/main.voyd` if your app needs larger edits.
