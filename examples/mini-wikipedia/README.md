# The Small Knowledge

A miniature, file-backed encyclopedia built as a complete Voyd + VX web
application. The server, API routes, JSON persistence, search, validation, and
interactive state machine are written in Voyd. TypeScript is limited to the
generated-Wasm build and VX hydration bridge.

## Run it

From this directory:

```sh
npm run dev
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). Create, edit, and delete
operations rewrite `data/articles.json` on the server.

## Scripts

- `npm run dev` builds the browser Wasm and assets, starts the Voyd SSR server,
  and watches the source tree.
- `npm run build` builds browser assets and checks optimized server/client
  compilation.
- `npm test` runs focused Voyd tests for JSON round-tripping, search, collection
  updates, and slug safety.
- `npm start` runs the server without the source watcher.
- `npm run typecheck` checks the small TypeScript build/hydration bridge.

`PORT` or `VOYD_WEB_PORT` changes the port. `HOST` or `VOYD_WEB_HOST` changes
the bind host.

## Architecture

- `src/wiki.voyd` owns the shared model, article collection operations, search,
  validation, and JSON codecs.
- `src/client.voyd` owns the VX state machine, UI, browser HTTP commands, and
  the shared view used by both SSR and hydration.
- `src/main.voyd` owns HTTP routes and filesystem persistence.
- `src/client.ts` is only the generic Wasm host/hydration bridge.

## Capability notes

- `std::fs` can read, write, test, and list paths, but cannot remove a file.
  The example therefore keeps articles in one JSON document so deletion is a
  real persistent operation rather than a hidden tombstone.
- VX includes URL commands and location subscriptions but no first-class
  router. Article links use normal, resilient server navigation; create/delete
  transitions update history through VX commands.
- VX intentionally renders typed virtual HTML rather than Markdown. Article
  bodies are stored as readable plain text with preserved paragraphs.
- Constructing a full `EventOptions` value for `on_submit_with` currently emits
  invalid multi-value Wasm for its boolean fields. The editor uses an explicit
  VX click message for Save instead of intercepting native form submission.
- The generic test assertion helper uses `!=`, but `String` currently only
  supports equality in this path. String assertions therefore compare
  `.equals(...)` as a boolean.
