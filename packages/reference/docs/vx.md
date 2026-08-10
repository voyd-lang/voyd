---
order: 8
---

# VX

VX is Voyd's framework for interactive user interfaces. Its model-view-update
architecture is inspired by Elm. You describe the UI as typed HTML, keep
application state in a model, and handle every change through a message. VX
renders the result in a browser and can render the same views on a server.

This guide starts with a working browser app and then covers the patterns and
APIs you need as the app grows.

## Create A VX App

Install the Voyd CLI and scaffold the browser starter:

```bash
npm install -g @voyd-lang/cli
voyd bootstrap my-app --template vx-spa
cd my-app
npm install
npm run dev
```

The starter includes Vite, Tailwind CSS, Voyd compilation, the JavaScript host,
and the VX browser runtime. Its main files are:

- `src/app/model.voyd`: model definitions and initial state.
- `src/app/update.voyd`: messages and transitions.
- `src/app/ui.voyd`: views and components.
- `src/main.voyd`: the small `Program` composition entrypoint.
- `src/main.ts`: loads the compiled Wasm module and mounts the app.
- `src/style.css`: global styles and Tailwind configuration.
- `scripts/compile-voyd.mjs`: compiles Voyd and generates host adapters.

Use `npm run build` for a production build and `npm run preview` to serve that
build locally.

## Your First App

A VX application has a model, a message type, a transition function, and a view:

```voyd
use std::enums::{ enum }
use std::string::type::String
use std::vx::all

obj Model {
  name: String,
  greeting: String
}

enum Msg
  NameChanged { value: String }
  Greet

pub fn app() -> Program<Model, Msg>
  program<Model, Msg>({ init, step, view })

fn init() -> Model
  Model { name: String::init(), greeting: "Hello!" }

fn step(model: Model, msg: Msg) -> Program<Model, Msg>
  match(msg)
    Msg::NameChanged { value }:
      next(Model { name: value, greeting: model.greeting })
    Msg::Greet:
      next(Model {
        name: model.name,
        greeting: "Hello, ".concat(model.name)
      })

fn view(model: Model) -> Html<Msg>
  <main>
    <h1>{model.greeting}</h1>
    <label for="name">Name</label>
    <input
      id="name"
      value={model.name}
      on_input={(event) =>
        Msg::NameChanged { value: event.value }
      }
    />
    <button type="button" on_click={Msg::Greet {}}>Greet</button>
  </main>
```

The browser runtime calls `init`, renders `view(model)`, and waits for a message.
When the input or button produces one, VX calls `step(model, msg)`, stores the
returned model, and renders again.

The exported `app` function is the standard VX entrypoint. Most application
files import VX's public types and helpers with:

```voyd
use std::vx::all
```

## The Application Loop

VX applications are state machines:

```text
init -> Model
Model -> view -> Html<Msg>
event, command, or subscription -> Msg
Model + Msg -> step -> next Model and optional Cmd<Msg>
```

The main types are:

- `Program<Model, Msg>`: an application descriptor or transition result.
- `Html<Msg>`: virtual HTML that can produce `Msg` values.
- `Attr<Msg>`: an attribute, property, style, or event for that HTML.
- `Cmd<Msg>`: one-off work, such as a request or navigation.
- `Sub<Msg>`: an ongoing source of messages, such as a timer or global listener.

These values are opaque typed plans. Composition keeps application values and
child plans typed; VX creates its private renderer/command wire only when the
plan crosses the runtime boundary. Application code cannot read or construct a
raw MessagePack payload for these types.

Add a `subscriptions` function when the app needs ongoing outside input:

```voyd
pub fn app() -> Program<Model, Msg>
  program<Model, Msg>({ init, step, view, subscriptions })
```

If startup needs a command, return a transition from `init`:

```voyd
fn init(): TaskRuntime -> Program<Model, Msg>
  next(model: initial_model(), cmd: load_profile())
```

Otherwise, `init` can return `Model` directly. In `step`, use `next(model)` for a
pure update and `next(model:, cmd:)` when the update also starts work.

Keep lifecycle data safe to pass across the Wasm boundary. Models, messages,
command inputs, and subscription inputs can contain primitives, strings, arrays,
boundary-safe records or objects, and enum variants made from those values. Do
not put functions, DOM nodes, trait objects, arbitrary dictionaries, or recursive
object graphs in them.

## Model And Messages

Put durable application state in `Model`: loaded data, form values, selected
ids, URLs, loading flags, validation errors, and feature state.

Use one `Msg` variant for each event that can change the model. Name messages
after what happened, not the code you intend to run:

```voyd
enum Msg
  DraftChanged { value: String }
  Submitted
  SaveFinished { result: Result<Todo, String> }
  EditCancelled
```

Then make `step` a readable transition table:

```voyd
fn step(model: Model, msg: Msg): TaskRuntime -> Program<Model, Msg>
  match(msg)
    Msg::DraftChanged { value }:
      next(with_draft(model, value))
    Msg::Submitted:
      next(model: saving(model), cmd: save_todo(model.draft))
    Msg::SaveFinished { result }:
      match(result)
        Ok { value }:
          next(saved(model, value))
        Err { error }:
          next(failed(model, error))
    Msg::EditCancelled:
      next(cancelled(model))
```

Extract model-building helpers when a branch becomes noisy. This keeps the
important decision visible in one place: message in, next state and work out.

Expected failures should normally travel through a `Result` in a result message.
Unexpected task or runtime failures are reported by the browser runtime's error
handler.

## Views And Components

A view is an ordinary function from data to `Html<Msg>`:

```voyd
fn view(model: Model) -> Html<Msg>
  <main class="page">
    <Toolbar saving={model.saving} />
    <p>{model.status}</p>
  </main>

fn Toolbar({ saving: bool }) -> Html<Msg>
  <div class="toolbar">
    <button type="button" disabled={saving} on_click={Msg::Save {}}>
      Save
    </button>
    <button type="button" on_click={Msg::Cancel {}}>Cancel</button>
  </div>
```

Components are functions. Their parameters are props, and calls use element
syntax. Prefer passing data down and emitting messages up; shared or durable
state still belongs in the parent model.

### Children And Lists

String literals and string expressions can be children:

```voyd
<p>Hello, {model.name}</p>
```

Render a list from an array and give each item a stable key:

```voyd
<ul>
  {model.todos.map((todo) =>
    <li key={todo.id}>
      <span>{todo.title}</span>
      <button
        type="button"
        on_click={Msg::Delete { id: todo.id }}
      >
        Delete
      </button>
    </li>
  )}
</ul>
```

Keys preserve DOM and component identity when items are inserted, removed, or
reordered. Use an id from the data, not the array position.

### Attributes, Properties, And Styles

Normal HTML attributes use familiar syntax:

```voyd
<button id="save" class="primary" aria-label="Save">Save</button>
```

`value`, `checked`, and `disabled` update live DOM properties, which makes them
the right choice for controlled form elements:

```voyd
<input value={model.draft} />
<input type="checkbox" checked={model.enabled} />
<button disabled={model.saving}>Save</button>
```

Built-in JSX is tag-aware. On `<option>`, `value` is an ordinary HTML attribute,
so the idiomatic selection markup remains stable across server rendering and
hydration:

```voyd
<select>
  <option value="voyd" selected={model.choice == "voyd"}>Voyd</option>
</select>
```

The compiler rejects property/tag combinations without a stable server
representation at the attribute location. For example, `<select value={...}>`
reports that selection belongs on the matching option's `selected` attribute.
`checked` is valid on `input`, and `disabled` is valid on disableable form
controls.

Names in the surrounding component do not shadow helpers inserted by HTML
syntax. A component may safely declare a property or parameter named `value`,
`checked`, `disabled`, `class`, or `attr`; generated HTML uses VX's compiler
helper identities while component names and `{expressions}` keep caller scope.

For computed attributes and lower-level helpers, use:

```voyd
id("save")
class("primary")
classes(["primary", "wide"])
role("button")
attr(name: "aria-label", value: "Save")
prop(name: "value", value: model.draft)
style(name: "display", value: "grid")
styles([("display", "grid"), ("gap", "0.5rem")])
```

These form properties have stable server representations on the elements where
HTML defines matching behavior: `value` on `input` and `textarea`, `checked` on
`input`, and `disabled` on disableable form controls. A controlled `textarea`
must render the same value as its text child. In particular, `value` on `select`
is browser-only because HTML derives its initial selection from `selected`
options. Use the explicit `prop` helper for such browser-only views; SSR rejects
property/tag combinations that would emit different server semantics. Use
`attr` for ordinary HTML attributes. Structured style values are single
declaration values and reject semicolons, exclamation marks, and control
characters; use classes for more complex styling.

HTML syntax is preferred. `text`, `fragment`, `html_element`, and `element` are
available for helpers that build trees dynamically. Dynamic HTML tag names must
be lowercase, as must names passed to `attr`; use the canonical `class` name
rather than DOM spellings such as `className`. Void elements such as `input`, `img`, and `br` cannot have
children; VX rejects those trees before rendering so browser and server output
cannot diverge.

## Events And Forms

Use a fixed message when the event payload is irrelevant:

```voyd
<button type="button" on_click={Msg::Save {}}>Save</button>
```

Use a closure when the message depends on local data:

```voyd
<button
  type="button"
  on_click={() => Msg::Select { id: todo.id }}
>
  Select
</button>
```

Use an event handler when the message depends on browser data. VX infers the
event type from the attribute:

```voyd
<input
  value={model.search}
  on_input={(event) =>
    Msg::SearchChanged { value: event.value }
  }
/>
```

The common payload types are:

- `InputEvent`: `value`, `checked`, and `input_type`.
- `SubmitEvent`: `form_keys` and `form_values`.
- `MouseEvent`: coordinates, `pointer_id`, button, wheel deltas, and modifier keys.
- `KeyboardEvent`: `key`, `code`, and modifier keys.
- `GenericEvent`: event name for events without a richer payload.

Prevent a form's browser submission with `EventOptions`:

```voyd
<form
  on_submit={on_submit_with(
    options: EventOptions { prevent_default: true },
    message: Msg::Submit {}
  )}
>
  <input
    name="title"
    value={model.draft}
    on_input={(event) =>
      Msg::DraftChanged { value: event.value }
    }
  />
  <button type="submit" disabled={model.saving}>Add</button>
</form>
```

`EventOptions` also supports `stop_propagation`, `capture`, `passive`, and
`pointer_capture`. Pointer capture is meaningful on `pointerdown`: the browser
keeps routing that pointer's move and release events to the element even after
the pointer leaves its bounds, then releases capture on `pointerup` or
`pointercancel`. Handle `pointercancel` by abandoning the active interaction.

```voyd
html_event_payload_handler<MouseEvent, Msg>(
  name: "pointerdown",
  options: EventOptions {
    prevent_default: false,
    stop_propagation: false,
    capture: false,
    passive: false,
    pointer_capture: true
  },
  handler: (event: MouseEvent) -> Msg => Msg::DragStarted {
    pointer_id: event.pointer_id,
    x: event.x,
    y: event.y
  }
)
```

Named helpers cover click, double-click, pointer, mouse, keyboard, input,
change, submit, focus, blur, scroll, wheel, drag, drop, and context-menu events.
Use `event_message` when no named helper fits.

## One-Off Work With Commands

`Cmd<Msg>` describes work that should happen after VX accepts the next model.
Return commands from `init` or `step`; do not perform browser work in `view`.

### Async Tasks

Use `Cmd.perform` for API calls, storage services, and other Voyd tasks. Map the
result back into the application as a message:

```voyd
use std::task::TaskRuntime

fn load_todos(): TaskRuntime -> Cmd<Msg>
  Cmd::perform(
    work: () => fetch_todos(),
    handler: (result) =>
      Msg::TodosLoaded { result: result }
  )
```

The function that constructs a `Cmd.perform` from `work` needs the `TaskRuntime`
effect. Handle
loading, success, and expected failure in `step`:

```voyd
Msg::Refresh:
  next(model: loading(model), cmd: load_todos())
Msg::TodosLoaded { result }:
  match(result)
    Ok { value }:
      next(loaded(model, value))
    Err { error }:
      next(failed(model, error))
```

For example, load text from an HTTP endpoint with `std::http::client`:

```voyd
use std::error::HostError
use std::http::{ HttpError, Response }
use std::http::client::self as http_client
use std::result::types::all
use std::string::type::String
use std::task::TaskRuntime

fn fetch_message(): http_client::HttpClient -> Result<String, String>
  match(http_client::get("/api/message"))
    Ok<Response> { value }:
      match(value.text())
        Ok<String> { value }:
          Ok<String> { value: value }
        Err<HttpError> { error }:
          Err<String> { error: error.message }
    Err<HostError> { error }:
      Err<String> { error: error.message }

fn load_message(): (http_client::HttpClient, TaskRuntime) -> Cmd<Msg>
  Cmd::perform(
    work: () => fetch_message(),
    handler: (result) =>
      Msg::MessageLoaded { result: result }
  )
```

List `http_client::HttpClient` and `TaskRuntime` on any `step` or helper that
constructs this command. For JSON, call `response.json()` and convert the
returned `JsonValue` into the boundary-safe application type your API expects.

### Command Reference

The built-in commands cover common browser work:

- Flow: `Cmd.none`, `Cmd.message`, `Cmd.delay`, `Cmd.batch`, and `Cmd.perform`.
- Canvas: `canvas::render` and `canvas::measure_text`.
- Clipboard: `copy_to_clipboard` and `read_clipboard`.
- Document and history: `set_document_title`, `push_url`, `replace_url`,
  `set_hash`, `navigate_back`, `navigate_forward`, and `open_url`.
- Scrolling: `scroll_window_to` and `scroll_window_by`.
- Local storage: `local_storage_set`, `local_storage_remove`, and
  `local_storage_clear`.
- Session storage: `session_storage_set`, `session_storage_remove`, and
  `session_storage_clear`.
- Element refs: `focus`, `scroll_into_view`, and `select_text`.

Batch independent effects when one transition needs several:

```voyd
Cmd::batch([
  Cmd<Msg>::set_document_title("Editing todo"),
  Cmd<Msg>::push_url("/todos/edit"),
  Cmd<Msg>::focus(editor_ref)
])
```

`Cmd.perform` accepts effectful work, an existing `Task<T>`, or a task id and
maps its typed result into `Msg`.

## Canvas Rendering And Interaction

VX Canvas keeps scene construction in Voyd and browser details in the runtime.
Build a `canvas::Frame` from typed draw operations, then return
`canvas::render(frame)` from `init` or `step`:

```voyd
use std::array::Array
use std::vx::all
use std::vx::canvas::self as canvas

fn draw_scene() -> Cmd<Msg>
  let arrow = canvas::path(
    segments: [
      canvas::path_move_to(canvas::Point { x: 0.0, y: 0.0 }),
      canvas::path_line_to(canvas::Point { x: 80.0, y: 0.0 }),
      canvas::path_line_to(canvas::Point { x: 70.0, y: -6.0 }),
      canvas::path_move_to(canvas::Point { x: 80.0, y: 0.0 }),
      canvas::path_line_to(canvas::Point { x: 70.0, y: 6.0 })
    ],
    stroke: "#77ddff",
    stroke_width: 2.0
  )
  canvas::render<Msg>(canvas::frame(
    selector: "#scene",
    width: 800.0,
    height: 450.0,
    draws: [
      canvas::save(),
      canvas::translate(x: 120.0, y: 90.0),
      canvas::rotate(0.35),
      canvas::line_dash(pattern: [6.0, 3.0]),
      canvas::composite(canvas::CompositeOperation::Lighter {}),
      arrow,
      canvas::restore()
    ]
  ))
```

Path segments cover moves, lines, quadratic and cubic Bézier curves, arcs,
tangent arcs, ellipses, rectangles, and closing a subpath. State operations
cover affine transforms, translate/rotate/scale, line dashes, compositing, and
balanced save/restore scopes. A frame with an unknown primitive, invalid field,
or unbalanced state stack is rejected before the canvas is resized or painted.

The constructors derive their MessagePack encoding from private typed records.
Their declared camel-case field names are the wire keys, absent optional values
are omitted, and the explicit frame `version` is encoded like any other field.
Callers use the typed constructors rather than assembling boundary maps.

All coordinates, dimensions, line widths, and text metrics are logical CSS
pixels. The browser host sizes the backing store using the current device pixel
ratio and applies the matching transform. Application code should never
multiply values by `devicePixelRatio`.

Text measurement is an explicit command/result contract. Store the returned
metrics in the model, then use them in a later frame:

```voyd
enum Msg
  TitleMeasured { metrics: canvas::TextMetrics }

fn measure_title(title: String) -> Cmd<Msg>
  canvas::measure_text<Msg>(
    selector: "#scene",
    value: title,
    font: "600 14px sans-serif",
    handler: (metrics: canvas::TextMetrics) -> Msg =>
      Msg::TitleMeasured { metrics }
  )
```

`canvas::frame` emits wire version 2 because paths and ordered state operations
expand the version-1 draw grammar. The browser host continues to accept and
validate version-1 frames containing lines, polylines, circles, ellipses, and
text. It accepts the expanded grammar only in version 2. Additive optional
fields may be introduced within a version, while another breaking wire change
requires a version increment. Unsupported versions and malformed frames are
rejected before the target Canvas is resized or painted. This fail-before-paint
rule makes mixed application and host versions deterministic.

## Ongoing Input With Subscriptions

`Sub<Msg>` describes listeners that should be active for the current model. VX
re-evaluates `subscriptions(model)` after every transition, starts new listeners,
and disposes listeners that disappear.

```voyd
fn subscriptions(model: Model) -> Sub<Msg>
  if
    model.editor_open:
      Sub::batch([
        keyboard_on_key_down(key: "Escape", value: Msg::CloseEditor {}),
        Sub::every(key: "autosave", millis: 5000i64, value: Msg::Autosave {})
      ])
    else:
      Sub<Msg>::none()
```

Every subscription needs stable identity. Use a key that names the logical
listener, such as `"autosave"` or `"project:".concat(model.project_id)`. A
changed key replaces the old listener.

Built-in subscriptions include:

- `Sub.every` for intervals.
- `keyboard_on_key_down` and `keyboard_on_key_up`.
- `online_status`, `window_on_resize`, and
  `document_on_visibility_change`.
- `location_on_change`, `window_on_focus`, and `window_on_blur`.
- `animation_frame` and `media_query`.
- `storage_on_change` and `broadcast_channel`.

Most helpers have a `value:` form for a fixed message and a `handler:` form for
a typed payload:

```voyd
window_on_resize(
  key: "viewport",
  handler: (size) =>
    Msg::ViewportChanged { width: size.width, height: size.height }
)
```

Use `Sub.batch` to combine listeners and `Sub.none` when none should be active.
The runtime cleans up timers and browser listeners when a subscription disappears
or the app is disposed.

## URL Routing In A SPA

Keep the current path in the model. A navigation message changes browser
history, while the location subscription updates the model for links,
back/forward navigation, and the initial page load:

```voyd
obj Model {
  path: String
}

enum Msg
  Navigate { path: String }
  LocationChanged { path: String }

fn step(model: Model, msg: Msg) -> Program<Model, Msg>
  match(msg)
    Msg::Navigate { path }:
      next(model: model, cmd: Cmd<Msg>::push_url(path))
    Msg::LocationChanged { path }:
      next(Model { path: path })

fn subscriptions(_model: Model) -> Sub<Msg>
  location_on_change(
    key: "location",
    handler: (location) =>
      Msg::LocationChanged { path: location.pathname }
  )

fn SettingsLink() -> Html<Msg>
  <a
    href="/settings"
    on_click={on_click_with(
      options: EventOptions { prevent_default: true },
      message: Msg::Navigate { path: "/settings" }
    )}
  >
    Settings
  </a>
```

`location_on_change` emits the current location when it starts, then emits again
for `push_url`, `replace_url`, hash changes, and browser back/forward navigation.
Render the page that matches `model.path`; use `replace_url` when the previous
URL should not remain in history.

## Element Refs

A `Ref<T>` identifies a rendered element for a later command:

```voyd
let editor = Ref<DomElement> { id: "editor" }

fn view(model: Model) -> Html<Msg>
  <input data-vx-ref="editor" value={model.draft} />

fn focus_editor() -> Cmd<Msg>
  Cmd<Msg>::focus(editor)
```

When building attributes manually, `ref<DomElement>(editor)` produces the same
reference attribute. Refs are intended for focus, selection, and scrolling;
application data still belongs in the model.

## Component-Local State

Use the application model by default. Component-local state is useful for small,
self-contained UI details such as whether a disclosure is open.

```voyd
fn Disclosure(): Component -> Html<Msg>
  let (state, set_state) = state(initial: "closed")
  <section>
    <button type="button" on_click={() => set_state("open")}>Open</button>
    <p>{state}</p>
  </section>
```

For direct access to the current value, use `state_handle`:

```voyd
fn CounterButton(): Component -> Html<Msg>
  let count = state_handle(initial: 0)
  <button on_click={() => count.set(count.value + 1)}>
    Increment
  </button>
```

Local state currently has direct helpers for `String` and `i32`. Keep server
data, shared feature data, URLs, command inputs, and behavior you need to test in
the application model.

## Organizing A Larger App

Give each feature its own model, messages, `step`, `view`, commands, and
subscriptions. The parent stores the feature model and wraps its messages:

```voyd
obj AppModel {
  todos: todos::Model,
  signed_in: bool
}

enum AppMsg
  Todos { value: todos::Msg }
  SignedOut
```

In the parent `step`, delegate the child message. `map_model` rebuilds the
parent model around the next child model, and `map_message` wraps messages that
the child transition's commands may produce later:

```voyd
fn step(model: AppModel, msg: AppMsg): TaskRuntime -> Program<AppModel, AppMsg>
  match(msg)
    AppMsg::Todos { value }:
      let child = todos::step(model.todos, value)
      let with_parent_model = map_model(
        child,
        (next_todos) =>
          AppModel { todos: next_todos, signed_in: model.signed_in }
      )
      map_message(
        with_parent_model,
        (child_msg) =>
          AppMsg::Todos { value: child_msg }
      )
    AppMsg::SignedOut:
      next(AppModel { todos: model.todos, signed_in: false })
```

The parent view uses `map_html` so child events become `AppMsg::Todos`:

```voyd
fn view(model: AppModel) -> Html<AppMsg>
  let to_app = (msg: todos::Msg) => AppMsg::Todos { value: msg }
  <main>
    {map_html(
      html: todos::view(model.todos),
      handler: to_app
    )}
  </main>

fn subscriptions(model: AppModel) -> Sub<AppMsg>
  todos::subscriptions(model.todos).map(
    (msg) => AppMsg::Todos { value: msg }
  )
```

Use `Cmd.map` in the same way when a parent starts a child command directly.
Together, `map_model`, `map_message`, `map_html`, `Cmd.map`, and `Sub.map` keep
feature-specific state and effects out of a single application-wide state
machine.

## Server Rendering And Hydration

The `web-ssr` starter renders VX HTML on the server and hydrates it in the
browser:

```bash
voyd bootstrap my-site --template web-ssr
```

The shared `src/app` code owns the model, transitions, and exact markup. Its
`view(model)` is called by both the server document shell and the browser
program, so you do not need a separate event-free view for server rendering.
VX automatically cleans up temporary server-rendering event handlers, including
when rendering fails. Browser event handlers remain active for the lifetime of
the mounted application. The server sends the initial model plus a structured
hydration root; the browser creates the same VX application with that model and
calls `hydrateVxApp`, preserving matching DOM and reporting mismatches in
development. Server-only routes and persistence stay under `src/server`; Wasm
loading stays in the TypeScript bridge. See [Web](./web.md) for the complete
server and hydration workflow.

## Browser Runtime Integration

The browser starter already wires the Wasm module to VX. Its `src/main.ts` uses
this setup:

```ts
import { createVoydHost } from "@voyd-lang/sdk/js-host";
import { createVoydVxAppRuntime, mountVxApp } from "@voyd-lang/vx-dom/browser";
import wasmUrl from "./generated/main.wasm?url";
import { adapters } from "./generated/voyd-adapters";

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element");

const wasm = new Uint8Array(await (await fetch(wasmUrl)).arrayBuffer());
const host = await createVoydHost({
  wasm,
  bufferSize: 256 * 1024,
  adapters,
});
const app = createVoydVxAppRuntime({ host });
const mounted = await mountVxApp({ container, app });

import.meta.hot?.dispose(() => mounted.dispose());
```

Report runtime failures through the mount-level `onError` hook:

```ts
const mounted = await mountVxApp({
  container,
  app,
  onError: (error, context) => {
    console.error(`VX ${context.phase} failed`, error);
  },
});
```

`createVoydVxAppRuntime` uses the exported `app` function by default. For a
legacy or custom module, you can name lifecycle exports explicitly:

```ts
const app = createVoydVxAppRuntime({
  host,
  exports: {
    init: "init",
    step: "step",
    view: "view",
    subscriptions: "subscriptions",
  },
});
```

### Custom Host Capabilities

Define typed custom host work as a versioned effect or external package
interface. VX commands are a closed set of typed constructors, so application
payloads cannot enter the renderer through a raw command name or encoded value.
The resulting adapter can still be installed alongside the VX runtime:

```ts
const mounted = await mountVxApp({
  container,
  app,
  runtimeHost: {
    commands: {
      // Typed built-in command overrides, when needed.
    },
  },
});
```

By default, `mountVxApp` installs the standard browser commands and
subscriptions, then applies typed `runtimeHost` overrides. Set
`runtimeHostMode: "explicit"` when an embedder needs an exact capability set:

```ts
const mounted = await mountVxApp({
  container,
  app,
  runtimeHostMode: "explicit",
  runtimeHost: {
    commands: {
      analytics_track: async (command) => {
        await analytics.track(command.value);
      },
    },
  },
});
```

Explicit mode installs only the supplied commands, subscriptions, and error
handler. Omitting `runtimeHost` in explicit mode provides no external
capabilities. Structural VX commands such as `none`, `message`, `batch`, and
`map` remain available, while any unknown external capability fails with the
normal missing-handler error.

For an ongoing custom host listener, define a versioned effect or external
package whose operations use typed DTOs. Raw subscription names and encoded
configuration values are not part of the VX application API.

Built-in browser listeners remain available through typed constructors:

```voyd
broadcast_channel<String, Msg>(
  name: "project-updates",
  handler: (message: String) -> Msg =>
    Msg::SocketMessage { value: message }
)
```

Use `Cmd.perform` when work should produce a typed Voyd result. Use runtime commands
and built-in subscriptions for capabilities owned by the browser. Put custom
capabilities behind typed effect or external adapters.

Runtime errors are reported with a phase such as `init`, `dispatch`, `render`,
`subscriptions`, `commands`, or `dispose`. Use `mountVxApp({ onError })` or
`runtimeHost.onError` when you need monitoring or user-facing recovery.

## Testing A VX App

Put pure state changes in a helper and test them with Voyd's test syntax:

```voyd
use std::enums::{ enum }
use std::test::assertions::all

obj Counter {
  count: i32
}

enum CounterMsg
  Increment

fn update(model: Counter, msg: CounterMsg) -> Counter
  match(msg)
    CounterMsg::Increment:
      Counter { count: model.count + 1 }

test "increment updates the count":
  let result = update(Counter { count: 1 }, CounterMsg::Increment {})
  assert(result.count, eq: 2)
```

Run tests in the starter with:

```bash
npx voyd test ./src
```

Most behavior can stay outside a browser:

- Make `step` wrap a tested update helper with `next(...)`.
- Test validation and result handling as pure functions.
- Verify subscriptions appear only for the model states that need them.
- Test command constructors when their descriptor is part of your integration
  contract.

Add a smaller number of browser tests for behavior that depends on rendering:
mount the app, interact with the DOM, and assert what the user sees. This keeps
most tests fast while still protecting the Wasm, runtime, and DOM boundary.

## Production Checklist

Before shipping a VX app:

- Build with `npm run build` and serve the generated assets over HTTPS.
- Dispose mounted apps during hot reload or page teardown.
- Use stable keys for dynamic lists and subscriptions.
- Represent loading and expected failures in the model.
- Keep secrets and trusted authorization decisions on the server.
- Report runtime errors from the JavaScript host.
- Test keyboard access, focus behavior, and semantic HTML as you would in any
  web application.
