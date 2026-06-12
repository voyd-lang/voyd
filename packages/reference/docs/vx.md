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

A VX app exports an `app` value that wires ordinary lifecycle functions into
VX:

```voyd
use std::enums::{ enum }
use std::string::type::String
use std::vx::all

obj Model {
  title: String,
  saved: bool
}

enum Msg
  Edit { value: String }
  Save
  Saved

type TextInput = {
  kind: String,
  value: String,
  checked: bool
}

pub fn app() -> Program<Model, Msg>
  program<Model, Msg>(
    init: init,
    update: update,
    view: view
  )

fn init() -> Model
  Model { title: "Draft", saved: false }

fn update(model: Model, message: Msg) -> Program<Model, Msg>
  match(message)
    Msg::Edit { value }:
      program<Model, Msg>(model: Model { title: value, saved: false })
    Msg::Save:
      program<Model, Msg>(model: Model { title: model.title, saved: false })
    Msg::Saved:
      program<Model, Msg>(model: Model { title: model.title, saved: true })

fn view(model: Model) -> Html<Msg>
  <main>
    <input
      value={model.title}
      on_input={(event: TextInput) -> Msg => Msg::Edit { value: event.value }}
    />
    <button on_click={Msg::Save {}}>Save</button>
    <p>{save_label(model.saved)}</p>
  </main>

fn save_label(saved: bool) -> String
  if saved then: "Saved" else: "Unsaved"
```

`app` is the public VX entrypoint. `init` creates the first model. `view` turns
the model into HTML. `update` receives messages from events, commands, and
subscriptions and returns the next model.

Typed lifecycle values must be boundary-compatible DTOs: primitives, `String`,
records/objects with public DTO fields, named message variants, and arrays of
boundary-compatible DTO values, including value objects. Arbitrary dictionaries,
functions, trait objects, and recursive object graphs are not part of the typed
VX boundary yet.

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
fn Toolbar({ on_save: fn() -> Msg }) -> Html<Msg>
  <button on_click={on_save}>Save</button>

fn Editor()
  <section>
    <Toolbar on_save={() => Msg::Save {}} />
  </section>
```

Components can also receive child nodes. Add a `children` parameter, then call
the component with normal opening and closing tags:

```voyd
use std::array::Array

fn Panel({ class: String, children: Array<Html<Msg>> }) -> Html<Msg>
  element(tag: "section", attrs: [attr(name: "class", value: class)], children: children)

fn Editor()
  <Panel class="editor-panel">
    <h1>Draft</h1>
    <textarea value={body}></textarea>
  </Panel>
```

Use `class`, `id`, `role`, `name`, `placeholder`, `input_type`, `value`,
`checked`, `disabled`, `style`, and `styles` for common attributes and
properties. Use `keyed(key:, child:)` when list items should keep their DOM
identity while reordering. If the keyed child creates component state, use
`keyed(key:, body:)` so the state is scoped to that key before the child is
evaluated.

## Events

Events can send a fixed message:

```voyd
<button on_click={Msg::Save {}}>Save</button>
```

They can run an inline closure:

```voyd
<button on_click={() -> Msg => Msg::Cancel {}}>
  Cancel
</button>
```

They can also receive the normalized browser event payload:

```voyd
<input
  value={title}
  on_input={(event: InputEvent) -> Msg => Msg::Edit { value: event.value }}
/>
```

Common helpers include `on_click`, `on_input`, `on_change`, `on_submit`,
`on_key_down`, `on_key_up`, mouse, pointer, focus, scroll, wheel, drag/drop, and
context menu events. HTML attributes pick the right typed helper for static
messages, passed pure callbacks, and inline pure closures. Normalized event
payload records such as `InputEvent`, `KeyboardEvent`, `MouseEvent`,
`SubmitEvent`, and `GenericEvent` are DTO-compatible and can be used directly in
typed payload callbacks.

Use `EventOptions` when the browser default should change:

```voyd
on_submit_with(
  options: EventOptions { prevent_default: true },
  message: Msg::Save {}
)
```

## State

Most app state belongs in your model. Keep form values, selected records, save
status, filters, and open panels there, then return a new model from `update`.

VX also exposes component-local state for small UI details that do not belong in
the app model:

```voyd
let (panel, set_panel) = state(initial: "closed")

<button on_click={() => set_panel("open")}>Open</button>
```

Component state supports typed `String` and `i32` values. Use it for small,
component-owned UI memory. Use the app model when other parts of the app need to
read or update the same value.

Use `state_handle` when you need the advanced handle API:

```voyd
let panel_state = state_handle(initial: "closed")

<button on_click={() => panel_state.set("open")}>Open</button>
```

## Commands

Commands describe work that should produce a future message:

```voyd
Cmd<Msg>::message(Msg::Saved {})
Cmd<Msg>::delay(millis: 250i64, value: Msg::Saved {})
Cmd<Msg>::batch([first, second])
Cmd<Msg>::focus<DomElement>(editor_ref)
Cmd<Msg>::scroll_into_view<DomElement>(editor_ref)
```

Use `map` when a child command needs to become a parent message:

```voyd
child_cmd.map<Msg>((message: ChildMsg) -> Msg => Msg::Child { value: message })
```

Task commands can also retain typed result mappers:

```voyd
Cmd<Msg>::perform(task: save_task, handler: (saved: SavedDraft) -> Msg => Msg::Saved { value: saved })
```

## Subscriptions

Subscriptions listen for outside events:

```voyd
pub fn subscriptions(model: Model) -> Sub<Msg>
  keyboard_on_key_down<Msg>(
    key: "Escape",
    value: Msg::Cancel {}
  )
```

Use `Sub::every` for intervals and `Sub::batch` to combine subscriptions.

```voyd
Sub<Msg>::every(key: "clock", millis: 1000i64, value: Msg::Tick {})
```

## Mounting

In the browser, compile the Voyd module, create a host, and mount:

```ts
import { createVoydHost } from "@voyd-lang/js-host";
import { createVoydVxAppRuntime, mountVxApp } from "@voyd-lang/vx-dom";

const host = await createVoydHost({ wasm });
const app = createVoydVxAppRuntime({ host });

await mountVxApp({
  container: document.getElementById("root")!,
  app,
});
```

Typed apps should export `app() -> Program<Model, Msg>`. Custom lifecycle
export names are still available for raw interop, but everyday VX apps do not
need boundary annotations or export adapters.

## Server Rendering

Use `renderVxToString` or `renderNodeToString` from `@voyd-lang/vx-dom/server`
to render HTML on the server. Use `hydrateVxApp` in the browser to attach
events without replacing matching server-rendered DOM.

## Raw MsgPack Interop

VX still uses MsgPack as its current runtime wire codec. Most apps should use
native `Model` and `Msg` types, but raw interop remains available when a custom
host boundary or dynamic payload needs it:

```voyd
use std::msgpack::MsgPack
use std::msgpack::self as msgpack
use std::vx::all

pub fn event_for_host() -> Html<MsgPack>
  element(
    tag: "button",
    attrs: [on_click_message(msgpack::make_string("host-save"))],
    children: [text("Save")]
  )

pub fn raw_command() -> Cmd<MsgPack>
  Cmd<MsgPack>::message_serialized(msgpack::make_string("host-message"))
```

Raw event helpers such as `on_click_message`, `event_payload`, and
serialized command/subscription helpers such as `message_serialized`,
`delay_serialized`, `every_serialized`, and `map_serialized` are intentionally
explicit so ordinary app code can stay typed.

## What To Reach For

- Static message: `on_click={Msg::Save {}}`
- Event payload: `on_input={(event: TextInput) -> Msg => ...}`
- Reusable component action: pass `fn() -> Msg` into a component
- App state: keep it in the model and return the next model from `update`
- Component-local UI state: use `let (value, set_value) = state(initial:)`
  inside component-runtime views for small `String` or `i32` values
- Later work: return a `Cmd`
- Outside events: return a `Sub`
- Browser mount: `createVoydVxAppRuntime` + `mountVxApp`
