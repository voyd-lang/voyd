# `@voyd-lang/markdown`

JS-backed Markdown rendering for Voyd. The package uses `marked` to produce a
restricted static-node DTO. Raw HTML becomes text and active link and image URL
schemes are rejected. No HTML string or DOM object crosses the adapter boundary.

```bash
npm install @voyd-lang/markdown
```

Use the renderer without VX:

```voyd
use pkg::markdown::{ StaticHtml, to_static }

pub fn main() -> StaticHtml
  to_static("# Hello")
```

Or use its ordinary Voyd VX component:

```voyd
use pkg::markdown::Markdown
use std::vx::all

fn Article({ source: String }) -> Html<AppMsg>
  <article class="wiki-article">
    <Markdown source={source} />
  </article>
```

For custom browser embedding, import the adapter and pass it to the host:

```ts
import markdownAdapter from "@voyd-lang/markdown/adapter";

const host = await createVoydHost({ wasm, adapters: [markdownAdapter] });
```

The CLI and generated application registry can discover this adapter from the
package metadata automatically.

The VX wrapper converts the static DTO into ordinary VX text, fragment, element,
and attribute nodes. VX validates and diffs the result normally; there is no
`innerHTML` escape hatch.
