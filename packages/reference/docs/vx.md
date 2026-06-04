---
order: 8
---

# VX

VX is Voyd's UI layer for browser apps. You write views in Voyd, keep app
state in Voyd, and let the JavaScript host mount, patch, hydrate, and connect
the real DOM.

Use VX when you want:

- HTML-like Voyd views
- state updates through an `update` function
- DOM events as Voyd messages
- commands for work that happens later
- subscriptions for browser or timer events
- server rendering and browser hydration

## A Small App

A VX app usually has three exported functions:

```voyd
use std::dict::Dict
use std::msgpack::MsgPack
use std::msgpack::self as msgpack
use std::vx::all

pub fn init() -> MsgPack
  msgpack::make_string("Draft")

pub fn update(model: MsgPack, message: MsgPack) -> MsgPack
  message

pub fn view(model: MsgPack) -> MsgPack
  <main>
    <input
      value={as_string(model)}
      on_input={(payload: MsgPack) -> MsgPack => input_value(payload)}
    />
    <button on_click={msgpack::make_string("Saved")}>Save</button>
  </main>

fn input_value(payload: MsgPack) -> MsgPack
  match(msgpack::unpack_map(payload))
    Ok<Dict<String, MsgPack>> { value }:
      match(value.get("value"))
        Some<MsgPack> { value }:
          value
        None:
          msgpack::make_string("")
    Err:
      msgpack::make_string("")

fn as_string(payload: MsgPack) -> String
  match(msgpack::unpack_string(payload))
    Ok { value }:
      value
    Err:
      "".to_string()
```

`init` creates the first model. `view` turns the model into HTML. `update`
receives messages from events, commands, and subscriptions and returns the next
model.

## Views

Use HTML syntax for normal UI:

```voyd
<section class="editor">
  <h1>{title}</h1>
  <textarea value={body}></textarea>
</section>
```

Built-in elements lower to VX nodes. Components are regular Voyd functions:

```voyd
fn Toolbar({ on_save: fn() -> MsgPack })
  element(
    tag: "button",
    attrs: [on_click(on_save)],
    children: [text("Save")]
  )

fn Editor()
  <section>
    {Toolbar(on_save: () -> MsgPack => msgpack::make_string("save"))}
  </section>
```

Use `class`, `id`, `role`, `name`, `placeholder`, `input_type`, `value`,
`checked`, `disabled`, `style`, and `styles` for common attributes and
properties. Use `keyed(key:, child:)` when list items should keep their DOM
identity while reordering.

## Events

Events can send a fixed message:

```voyd
<button on_click={msgpack::make_string("save")}>Save</button>
```

They can run an inline closure:

```voyd
<button on_click={() -> MsgPack => msgpack::make_string("cancel")}>
  Cancel
</button>
```

They can also receive the normalized browser event payload:

```voyd
<input
  value={title}
  on_input={(payload: MsgPack) -> MsgPack => title_changed(payload)}
/>
```

Common helpers include `on_click`, `on_input`, `on_change`, `on_submit`,
`on_key_down`, `on_key_up`, mouse, pointer, focus, scroll, wheel, drag/drop, and
context menu events. Payload helpers use the `_payload` suffix, for example
`on_input_payload`.

Use `EventOptions` when the browser default should change:

```voyd
on_submit_with(
  options: EventOptions { prevent_default: true },
  message: msgpack::make_string("save")
)
```

## State

Most app state belongs in your model. Keep form values, selected records, save
status, filters, and open panels there, then return a new model from `update`.

VX also exposes a lower-level component effect for local serialized state:

```voyd
let (value, handle) = state(
  id: 1,
  initial: msgpack::make_string("closed")
)

handle.set(msgpack::make_string("open"))
```

Use model state for browser apps today. Treat component-local state as a
component-runtime primitive for small UI-only details, not as a replacement for
the app model.

## Commands

Commands describe work that should produce a future message:

```voyd
Cmd<MsgPack>::message(msgpack::make_string("saved"))
Cmd<MsgPack>::delay(millis: 250i64, value: msgpack::make_string("saved"))
Cmd<MsgPack>::batch([first, second])
Cmd<MsgPack>::focus<DomElement>(editor_ref)
Cmd<MsgPack>::scroll_into_view<DomElement>(editor_ref)
```

Use `map` when a child command needs to become a parent message:

```voyd
child_cmd.map<MsgPack>((payload: MsgPack) -> MsgPack => payload)
```

## Subscriptions

Subscriptions listen for outside events:

```voyd
pub fn subscriptions(model: MsgPack) -> MsgPack
  keyboard_on_key_down<MsgPack>(
    key: "Escape",
    value: msgpack::make_string("cancel")
  ).payload
```

Use `Sub::every` for intervals and `Sub::batch` to combine subscriptions.

## Mounting

In the browser, compile the Voyd module, create a host, adapt the Voyd exports,
and mount:

```ts
import { createVoydHost } from "@voyd-lang/js-host";
import { createVoydVxAppRuntime, mountVxApp } from "@voyd-lang/vx-dom/browser";

const host = await createVoydHost({ wasm });
const app = createVoydVxAppRuntime({
  host,
  exports: { subscriptions: "subscriptions" },
});

await mountVxApp({
  container: document.getElementById("root")!,
  app,
});
```

By default the adapter looks for `init`, `update`, and `view`. Add
`subscriptions` when your app exports one, or rename any export explicitly:

```ts
createVoydVxAppRuntime({
  host,
  exports: {
    init: "start",
    update: "step",
    view: "render",
    subscriptions: "listen",
  },
});
```

## Server Rendering

Use `renderVxToString` or `renderNodeToString` from `@voyd-lang/vx-dom/server`
to render HTML on the server. Use `hydrateVxApp` in the browser to attach
events without replacing matching server-rendered DOM.

## What To Reach For

- Static message: `on_click={msgpack::make_string("save")}`
- Event payload: `on_input={(payload: MsgPack) -> MsgPack => ...}`
- Reusable component action: pass `fn() -> MsgPack` into a component
- App state: keep it in the model and return the next model from `update`
- Component-local UI state: use model fields in browser apps; use
  `state(id:, initial:)` only in component-runtime code
- Later work: return a `Cmd`
- Outside events: return a `Sub`
- Browser mount: `createVoydVxAppRuntime` + `mountVxApp`
