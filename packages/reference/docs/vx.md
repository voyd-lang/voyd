---
order: 8
---

# VX

VX is Voyd's web application framework. Inspired by Elm, it gives a Voyd program
a typed way to describe browser UI, respond to user input, run async work,
subscribe to outside events, and render the same virtual tree in the browser or
on the server.

The shape is deliberately small:

```voyd
pub fn app() -> Program<Model, Msg>
  program({ init, step, view, subscriptions })
```

`Model` is the durable state of the feature. `Msg` is the closed set of events
that can change that state. `step` receives the current model and one message,
then returns the next model plus any one-off commands. `view` turns a model into
HTML. `subscriptions` describes ongoing outside events that should be active for
the latest model.

That is the core loop:

```text
init() -> model and optional startup commands
view(model) -> virtual HTML
user event, command result, or subscription event -> Msg
step(model, Msg) -> next model and optional commands
view(next model)
subscriptions(next model) are reconciled
commands are run
```

VX code should read as a small state machine. The browser runtime owns DOM
patching, event listener lifetimes, command execution, subscription disposal,
and callback retention.

## Importing VX

Most applications import the full VX surface:

```voyd
use std::vx::all
```

The main public types are:

- `Program<Model, Msg>`: either an app descriptor or one transition result.
- `Html<Msg>`: typed virtual HTML that can dispatch `Msg`.
- `Attr<Msg>`: an attribute, property, style, or event descriptor for `Html`.
- `Cmd<Msg>`: one-off work that may dispatch a later `Msg`.
- `Sub<Msg>`: ongoing outside input that may dispatch many `Msg` values.
- `EventOptions`: browser event listener options.
- `Ref<T>` and `DomElement`: typed DOM targets for focus and scrolling commands.
- `StateHandle<T>`: a handle for restricted component-local state.

`Html<Msg>`, `Attr<Msg>`, `Cmd<Msg>`, `Sub<Msg>`, and `Program<Model, Msg>` are
typed values that cross the Wasm boundary. Application code should construct
them through the VX helpers.

Messages, models, command values, and subscription values must be
boundary-compatible data: primitives, `String`, arrays, records or objects with
public DTO fields, value objects, and enum variants made from those values. Keep
functions, trait objects, arbitrary dictionaries, DOM nodes, and recursive
object graphs out of lifecycle data.

## The App Contract

A full app usually has these pieces:

```voyd
obj Model {
  count: i32
}

enum Msg
  Increment
  Decrement

pub fn app() -> Program<Model, Msg>
  program({ init, step, view })

fn init() -> Model
  Model { count: 0 }

fn step(model: Model, msg: Msg) -> Program<Model, Msg>
  match(msg)
    Msg::Increment:
      next(Model { count: model.count + 1 })
    Msg::Decrement:
      next(Model { count: model.count - 1 })

fn view(model: Model) -> Html<Msg>
  <main>
    <button on_click={Msg::Decrement {}}>-</button>
    <span>{count_label(model.count)}</span>
    <button on_click={Msg::Increment {}}>+</button>
  </main>
```

The canonical typed VX app entrypoint is `app`. The transition function used by
the standard helpers and generated runtime descriptor is `step`.

When the local function names match the labels, prefer the struct shorthand call:

```voyd
program({ init, step, view, subscriptions })
```

The return type on `app` and the signatures of `init`, `step`, `view`, and
`subscriptions` give the compiler enough context to infer `Model` and `Msg`.
Use explicit labels when local function names differ from the program labels:

```voyd
program(
  init: initialize,
  step: handle_message,
  view: render,
  subscriptions: active_subscriptions
)
```

There are two useful `program` forms for app descriptors:

```voyd
program(
  init: fn() -> Model,
  step: fn(Model, Msg) -> Program<Model, Msg>,
  view: fn(Model) -> Html<Msg>,
  subscriptions: fn(Model) -> Sub<Msg> = ...
)
```

Use this when startup is pure and only returns the initial model.

```voyd
program(
  init: fn() -> Program<Model, Msg>,
  step: fn(Model, Msg) -> Program<Model, Msg>,
  view: fn(Model) -> Html<Msg>,
  subscriptions: fn(Model) -> Sub<Msg> = ...
)
```

Use this when startup also needs commands, for example loading data. In that
case `init` returns `next(model: initial_model, cmd: load())`.

Inside `step`, return `next`:

```voyd
next(next_model)
next(model: next_model, cmd: save_title(next_model.title))
```

`next` is a pure constructor. It only describes the transition result; command
execution, DOM patching, and subscription management happen in the runtime.

## Models And Messages

Put durable state in `Model`: server data, form data that other code needs,
URLs, selected ids, loading flags, validation errors, pending request status,
feature state, and anything you want to test as application behavior.

Use `Msg` for every event that can change that model. Prefer messages that
describe the event that occurred and leave implementation choices in `step`:

```voyd
enum Msg
  DraftChanged { value: String }
  Submit
  SaveFinished { result: Result<Todo, String> }
  CancelEdit
```

This keeps `step` readable. Each branch answers two questions:

- What is the next model?
- Is there one-off work to start?

```voyd
fn step(model: Model, msg: Msg): TaskRuntime -> Program<Model, Msg>
  match(msg)
    Msg::DraftChanged { value }:
      next(Model { draft: value, saving: model.saving })
    Msg::Submit:
      next(
        model: Model { draft: model.draft, saving: true },
        cmd: save_draft(model.draft)
      )
```

For expected failures, make the task return a `Result` and map the `Result` into
a message. If a task itself fails, the browser runtime reports the error through
its runtime error handler; application messages remain focused on domain
outcomes.

## The Step Function

`step` is the transition table for an app or feature.

```voyd
fn step(model: Model, msg: Msg) -> Program<Model, Msg>
```

It receives the current model and one message. It returns a `Program` transition
containing the next model and any command work that should begin after the model
has been accepted.

Most branches have this shape:

```voyd
Msg::DraftChanged { value }:
  next(with_draft(model, value))
Msg::Submit:
  next(model: saving_now(model), cmd: save_draft(model.draft))
```

Use `next(next_model)` for a pure state transition. Use
`next(model:, cmd:)` when the transition also starts one-off work.

Commands returned from `step` are descriptions. The runtime runs them after it
stores the next model, renders, and reconciles subscriptions. That ordering lets
`step` stay easy to test: given a model and message, it produces a transition
value.

When a branch becomes large, extract the model update into a named helper:

```voyd
Msg::Saved { result }:
  match(result)
    Ok { value }:
      next(saved(model, value))
    Err { error }:
      next(with_error(model, error))

fn saved(model: Model, todo: Todo) -> Model
  Model {
    todos: replace_todo(model.todos, todo),
    draft: model.draft,
    loading: false,
    saving: false,
    error: String::init()
  }
```

The helper name should describe the state transition. Keep command constructors
similarly named:

```voyd
Msg::Refresh:
  next(model: loading(model), cmd: load_todos())
```

This keeps the branch readable without hiding the architecture: message in,
model out, commands described.

Use effects on `step` only when constructing the returned transition needs that
effect. For example, a `step` branch that calls a helper using `Cmd.task` needs
`TaskRuntime`:

```voyd
fn step(model: Model, msg: Msg): TaskRuntime -> Program<Model, Msg>
  match(msg)
    Msg::Submit:
      next(model: saving_now(model), cmd: save_draft(model.draft))
```

The task itself completes later and returns to the app as another `Msg`.

## Views

Views are plain functions from model to `Html<Msg>`.

```voyd
fn view(model: Model) -> Html<Msg>
  <main class="editor">
    <label for="title">Title</label>
    <input
      id="title"
      value={model.title}
      on_input={(event: InputEvent) -> Msg =>
        Msg::TitleChanged { value: event.value }
      }
    />
    <button type="button" on_click={Msg::Save {}}>Save</button>
  </main>
```

VX HTML is virtual DOM. A render builds a tree of text, fragment, and element
nodes. The browser runtime compares the new tree with the previous tree and
patches real DOM nodes.

### Components

Components are ordinary functions that return `Html<Msg>`.

```voyd
fn Toolbar({ saving: bool }) -> Html<Msg>
  <div class="toolbar">
    <button type="button" disabled={saving} on_click={Msg::Save {}}>
      Save
    </button>
    <button type="button" on_click={Msg::Cancel {}}>Cancel</button>
  </div>
```

Call components with element syntax:

```voyd
fn view(model: Model) -> Html<Msg>
  <main>
    <Toolbar saving={model.saving} />
  </main>
```

Component parameters are just function parameters. Keep components mostly
presentational when possible. If a component needs to change durable app state,
pass it enough model data and let it emit parent messages.

### Children

Text children can be string literals or interpolated values:

```voyd
<p>Hello, {model.name}</p>
```

Use arrays of `Html<Msg>` for lists:

```voyd
<ul>
  {model.todos.map((todo) => <li key={todo.id}>{todo.title}</li>)}
</ul>
```

Use `key` on list children with stable identity. A key tells the renderer that
an item is the same logical item after insertion, deletion, or reordering.

### Attributes, Properties, And Styles

Most HTML syntax maps directly to attributes:

```voyd
<button id="save" class="primary" type="button">Save</button>
```

Attribute helpers return `Attr<Msg>` values. They are useful when a helper
function returns an attribute list, or when an element is built with the
lower-level constructors:

```voyd
fn SaveButton() -> Html<Msg>
  html_element(
    tag: "button",
    attrs: [
      id("save"),
      class("primary"),
      input_type("button"),
      attr(name: "aria-label", value: "Save")
    ],
    children: [text("Save")]
  )
```

The individual attribute helpers are:

```voyd
id("save")
class("primary")
classes(["primary", "wide"])
role("button")
name("title")
placeholder("Untitled")
input_type("text")
tab_index(0)
attr(name: "aria-label", value: "Save")
```

Use properties for live DOM state such as `value`, `checked`, and `disabled`:

```voyd
<input value={model.draft} />
<input type="checkbox" checked={model.enabled} />
<button disabled={model.saving}>Save</button>
```

The lower-level helpers are:

```voyd
value(model.draft)
checked(model.enabled)
disabled(model.saving)
prop(name: "value", value: model.draft)
```

Styles are explicit property/value pairs:

```voyd
style(name: "display", value: "grid")
style(name: "grid-template-columns", value: "1fr auto")
styles([("display", "grid"), ("gap", "0.5rem")])
```

The runtime validates tag names, attribute names, and CSS property names. Invalid
frames fail before malformed DOM can be produced.

### Refs

`Ref<T>` is a typed way to identify a DOM element for a later command.

```voyd
let editor = Ref<DomElement> { id: "editor" }

fn view(model: Model) -> Html<Msg>
  <input data-vx-ref="editor" value={model.draft} />
```

The helper form is clearer when building attributes manually:

```voyd
ref<DomElement>(editor)
```

Refs are looked up by `data-vx-ref`. They are useful with `Cmd.focus` and
`Cmd.scroll_into_view`.

### Lower-Level Render Constructors

HTML syntax is the normal surface. These functions are available for generated
code, interop, and advanced helpers:

```voyd
text("hello")
fragment(children)
element(tag: "section", attrs: attrs, children: children)
html_element(tag: "section", attrs: attrs, children: children)
frame(root)
```

`frame(root)` wraps a root node in the versioned VX render-frame format used by
the browser and server renderers.

## Events

Events turn browser input into messages.

Use a fixed message when the event payload can be ignored:

```voyd
<button type="button" on_click={Msg::Save {}}>Save</button>
```

Use a zero-argument closure when you need to compute the message:

```voyd
<button
  type="button"
  on_click={() -> Msg => Msg::Select { id: todo.id }}
>
  Select
</button>
```

Use a typed payload closure when the browser event contains the data:

```voyd
<input
  value={model.search}
  on_input={(event: InputEvent) -> Msg =>
    Msg::SearchChanged { value: event.value }
  }
/>
```

The standard event payload types are:

```voyd
MouseEvent {
  kind: String,
  x: f64,
  y: f64,
  client_x: f64,
  client_y: f64,
  button: i32,
  alt_key: bool,
  ctrl_key: bool,
  meta_key: bool,
  shift_key: bool,
  delta_x: f64,
  delta_y: f64
}

KeyboardEvent {
  kind: String,
  key: String,
  code: String,
  alt_key: bool,
  ctrl_key: bool,
  meta_key: bool,
  shift_key: bool
}

InputEvent {
  kind: String,
  value: String,
  checked: bool,
  input_type: String
}

SubmitEvent {
  kind: String,
  form_keys: Array<String>,
  form_values: Array<String>
}

GenericEvent {
  kind: String,
  event: String
}
```

Use `EventOptions` for browser listener behavior:

```voyd
<form
  on_submit={on_submit_with(
    options: EventOptions { prevent_default: true },
    message: Msg::Submit {}
  )}
>
  ...
</form>
```

The options are `prevent_default`, `stop_propagation`, `capture`, and `passive`.

The event helper pattern is consistent:

```voyd
on_click_message(Msg::Save {})
on_click_with(options: EventOptions { prevent_default: true }, message: Msg::Save {})
event_message<InputEvent, Msg>(
  name: "input",
  message: (event: InputEvent) -> Msg => Msg::Edit { value: event.value }
)
```

The named event families are:

- Mouse: `on_click`, `on_double_click`, `on_mouse_down`, `on_mouse_up`,
  `on_mouse_move`, `on_mouse_enter`, `on_mouse_leave`.
- Pointer: `on_pointer_down`, `on_pointer_up`, `on_pointer_move`.
- Keyboard: `on_key_down`, `on_key_up`.
- Form/input: `on_input`, `on_change`, `on_submit`.
- Focus/scroll/wheel: `on_focus`, `on_blur`, `on_scroll`, `on_wheel`.
- Drag/drop/context: `on_drag_start`, `on_drag`, `on_drag_end`, `on_drop`,
  `on_context_menu`.

Each family has forms for retained handler ids, typed messages, typed event
closures, and `EventOptions`. Application code usually needs the HTML attribute
syntax, fixed typed messages, typed event closures, and the `_with` helpers for
options.

## Component-Local State

Most state belongs in `Model`. Reach for component-local state for small local
UI details outside app behavior: a small open/closed flag, an uncontrolled input
draft inside a reusable widget, or a temporary visual value.

Component-local state is intentionally restricted to small boundary-safe values,
with direct helpers for `String` and `i32`.

```voyd
fn Disclosure(): Component -> Html<Msg>
  let (panel, set_panel) = state(initial: "closed")
  <section>
    <button
      type="button"
      on_click={() => set_panel("open")}
    >
      Open
    </button>
    <p>{panel}</p>
  </section>
```

For more control, use a handle:

```voyd
fn CounterButton(): Component -> Html<Msg>
  let handle = state_handle(initial: 0)
  <button on_click={() => handle.set(handle.value + 1)}>
    Increment
  </button>
```

`StateHandle<T>` methods:

- `set(value)` replaces state and schedules the component runtime.
- `update(value)` replaces state and returns a new handle with the updated
  value.

Keep server data, shared feature data, command inputs, URL state, and testable
application behavior in `Model`.

## Commands

`Cmd<Msg>` describes one-off work. A command value is returned from `init` or
`step`, and the browser runtime handles the command after it has stored the new
model, rendered the new view, and reconciled subscriptions.

Most command constructors only build data. `Cmd.task` is the important exception:
it detaches a Voyd task while constructing the command, stores the task id in the
command, and the browser runtime later observes that task and dispatches the
mapped result. That is why any function that calls `Cmd.task` needs the
`TaskRuntime` effect.

Commands exist so state transitions stay explicit. `step` decides what should
happen next; command constructors isolate outside work from the model update.

### Command Constructors

`Cmd.none()` does nothing.

```voyd
Cmd<Msg>::none()
```

Use it when a helper has to return a command for an empty branch.

`Cmd.message(value)` queues a typed message.

```voyd
Cmd::message(Msg::Saved {})
```

Use it to split a state-machine transition into a follow-up message. Message
loops can occur if every handling of a message immediately commands the same
message again.

`Cmd.delay(millis:, value:)` dispatches a typed message after a timer.

```voyd
Cmd::delay(millis: 250i64, value: Msg::Autosave {})
```

The browser runtime clears pending delays when the app is disposed.

`Cmd.batch(values)` runs several commands.

```voyd
Cmd::batch([focus_editor(), announce_saved()])
```

The browser runtime walks command batches in order. A batch is useful when one
transition needs independent side effects, such as starting a request and moving
focus.

`Cmd.task(work:, handler:)` starts one detached Voyd task and dispatches the
handler result when the task completes.

```voyd
fn save_title(title: String): TaskRuntime -> Cmd<Msg>
  Cmd::task(
    work: () -> Result<Todo, String> => api_save_title(title),
    handler: (result: Result<Todo, String>) -> Msg =>
      Msg::SaveFinished { result: result }
  )
```

Use `Cmd.task` for API requests, database writes, and other async work. The
function that creates the task needs the `TaskRuntime` effect because the task is
detached as part of constructing the command.

`Cmd.perform` is the lower-level task command. Use it when you already have a
`Task<T>` or a task id and want to attach a retained result mapper yourself.

```voyd
Cmd::perform(
  task: task_value,
  handler: (value: Todo) -> Msg =>
    Msg::Saved { result: Ok { value: value } }
)
Cmd<Msg>::perform(task_id: task_id, handler_id: mapper_id)
```

Most application code should prefer `Cmd.task`.

`Cmd.copy_to_clipboard(value:)` copies text to the browser clipboard.

```voyd
Cmd<Msg>::copy_to_clipboard("Saved URL")
```

`Cmd.focus(target)` focuses a DOM element found by `data-vx-ref`.

```voyd
let editor = Ref<DomElement> { id: "editor" }
Cmd<Msg>::focus(editor)
```

`Cmd.scroll_into_view(target)` scrolls a DOM element found by `data-vx-ref`.

```voyd
Cmd<Msg>::scroll_into_view(editor)
```

`Cmd.set_document_title(value:)`, `Cmd.push_url(value:)`,
`Cmd.replace_url(value:)`, `Cmd.navigate_back()`, and
`Cmd.navigate_forward()` cover common document and history effects.

```voyd
Cmd::batch([
  Cmd<Msg>::set_document_title("Editing"),
  Cmd<Msg>::push_url("/todos/active")
])
```

`Cmd.runtime(kind:)` creates a host command envelope for custom browser or
application capabilities.

```voyd
Cmd<Msg>::runtime(kind: "analytics_track", value: analytics_payload(event))
```

The browser host must register a command executor for the `kind`. Use runtime
commands when the effect is app-specific or not part of VX's built-in browser
host.

`Cmd.map(handler)` lifts child commands into parent message space.

```voyd
child_cmd.map(
  (msg: ChildMsg) -> AppMsg => AppMsg::Child { value: msg }
)
```

Use `Cmd.map` when composing features. It keeps child features independent of
the parent's message type.

### Command Design

Name command constructors after the work they describe:

```voyd
fn load_todos(): TaskRuntime -> Cmd<Msg>
  Cmd::task(
    work: () -> Result<Array<Todo>, String> => api_load_todos(),
    handler: (result: Result<Array<Todo>, String>) -> Msg =>
      Msg::Loaded { result: result }
  )
```

Then `step` stays focused on transitions:

```voyd
Msg::Refresh:
  next(model: loading(model), cmd: load_todos())
```

This is the main VX habit: isolate outside work in command constructors and keep
model changes visible in `step`.

## Subscriptions

`Sub<Msg>` describes ongoing outside input. A subscription can dispatch many
messages over time: timer ticks, global keyboard shortcuts, browser connection
state, WebSocket messages, host events, or any other listener managed by the
runtime.

The `subscriptions` function is part of the app contract:

```voyd
fn subscriptions(model: Model) -> Sub<Msg>
  ...
```

VX calls it after `init` and after every `step`. The returned value is the full
set of listeners that should be active for the current model. When the model
changes, VX compares the latest subscription set with the previous one and
updates the running listeners.

```text
init or step produces a model
view renders that model
subscriptions(model) returns the active subscription set
VX starts new listeners
VX disposes listeners that disappeared
VX replaces listeners whose descriptor changed
```

This makes subscriptions model-driven. Editing mode can enable an Escape key
listener. Leaving editing mode removes it:

```voyd
fn subscriptions(model: Model) -> Sub<Msg>
  if
    model.editing_id.len() > 0:
      keyboard_on_key_down(key: "Escape", value: Msg::CancelEdit {})
    else:
      Sub<Msg>::none()
```

The subscription value is data. Creating the value only describes the listener.
The browser runtime attaches, updates, and disposes the listener after it has
accepted the latest model.

### Keys And Identity

Every active subscription needs a stable key. The runtime uses the subscription
kind plus key, and any message mapping chain, as its identity. Use ids that
represent the logical listener, such as `"clock"`, `"escape"`, or
`"todo:" + todo.id`.

A stable key lets VX keep the same listener alive across renders. If the key
changes, VX treats the next descriptor as a different listener.

```voyd
Sub::every(key: "clock", millis: 1000i64, value: Msg::Tick {})
```

The string `"clock"` means "the app's clock listener." It should stay the same
even though the model changes after each tick.

Use model data in a key when the listener really belongs to one model entity:

```voyd
Sub::runtime(
  kind: "todo_status",
  key: "todo:" + model.selected_id
)
```

When `selected_id` changes, the old selected-todo listener is disposed and a new
selected-todo listener starts.

### Empty And Batch

`Sub.none()` creates an empty subscription set.

```voyd
Sub<Msg>::none()
```

Use it when a model state has no outside input to listen to.

`Sub.batch(values)` combines several subscriptions into one value. This is the
normal shape once a screen has more than one active listener:

```voyd
fn subscriptions(model: Model) -> Sub<Msg>
  if
    model.editing_id.len() > 0:
      Sub::batch([
        Sub::every(key: "clock", millis: 1000i64, value: Msg::Tick {}),
        keyboard_on_key_down(key: "Escape", value: Msg::CancelEdit {})
      ])
    else:
      Sub::every(key: "clock", millis: 1000i64, value: Msg::Tick {})
```

`Sub.batch` can contain `Sub.none()` values. Empty children are ignored by the
runtime.

### Intervals

`Sub.every(key:, millis:, value:)` dispatches a typed message at an interval.

```voyd
Sub::every(key: "autosave", millis: 5000i64, value: Msg::Autosave {})
```

Use intervals for polling, clocks, debounced reminders, and periodic autosave
checks. The `value` is the message dispatched on every tick.

```voyd
enum Msg
  Tick
  Autosave

fn subscriptions(model: Model) -> Sub<Msg>
  Sub::batch([
    Sub::every(key: "clock", millis: 1000i64, value: Msg::Tick {}),
    Sub::every(key: "autosave", millis: 5000i64, value: Msg::Autosave {})
  ])
```

A message produced by an interval goes through the same `step` function as a
button click or command result:

```voyd
fn step(model: Model, msg: Msg): TaskRuntime -> Program<Model, Msg>
  match(msg)
    Msg::Tick:
      next(Model { ticks: model.ticks + 1 })
    Msg::Autosave:
      next(model: model, cmd: save_draft(model.draft))
```

### Keyboard

Keyboard helpers subscribe to global browser keyboard events:

```voyd
keyboard_on_key_down(key: "Escape", value: Msg::CancelEdit {})
keyboard_on_key_up(key: "Enter", value: Msg::Submit {})
```

The `key` parameter is both the browser key filter and the stable key for the
subscription. The dispatched `value` is a typed message.

Use the `handler` form when the app needs the normalized keyboard payload:

```voyd
keyboard_on_key_down(
  key: "Escape",
  handler: (event: KeyboardEvent) -> Msg =>
    Msg::KeyPressed { key: event.key, code: event.code }
)
```

The handler receives the same `KeyboardEvent` payload shape used by typed DOM
keyboard event handlers.

Keyboard subscriptions are especially useful for mode-dependent shortcuts:

```voyd
fn subscriptions(model: Model) -> Sub<Msg>
  if
    model.modal_open:
      keyboard_on_key_down(key: "Escape", value: Msg::CloseModal {})
    else:
      Sub<Msg>::none()
```

### Browser State Subscriptions

The default browser runtime host also exposes subscriptions for common window
and document state:

```voyd
online_status(
  key: "network",
  handler: (online: bool) -> Msg =>
    Msg::OnlineChanged { online: online }
)

window_on_resize(
  key: "viewport",
  handler: (size: WindowSize) -> Msg =>
    Msg::ViewportChanged { width: size.width, height: size.height }
)

document_on_visibility_change(
  key: "visibility",
  handler: (visibility: DocumentVisibility) -> Msg =>
    Msg::VisibilityChanged { hidden: visibility.hidden }
)
```

Each helper also has a fixed-message form with `value:` when the app only needs
to know that the event happened.

### Runtime Subscriptions

`Sub.runtime_payload(kind:, key:, handler:)` creates a host subscription
envelope and maps incoming host payloads through a typed handler.

```voyd
enum Msg
  OnlineChanged { online: bool }

fn subscriptions(model: Model) -> Sub<Msg>
  Sub::runtime_payload(
    kind: "online_status",
    key: "network",
    handler: (online: bool) -> Msg =>
      Msg::OnlineChanged { online: online }
  )
```

The browser host must register a subscription runner for the `kind` through
`runtimeHost.subscriptions`. The runner receives the subscription descriptor and
a `context` with `dispatch`, `signal`, and `reportError`.

```ts
await mountVxApp({
  container,
  app,
  runtimeHost: {
    subscriptions: {
      online_status: (subscription, context) => {
        const dispatch = () => {
          void context.dispatch({
            kind: "subscription",
            subscriptionKind: "online_status",
            key: String(subscription.key),
            payload: navigator.onLine,
          });
        };

        window.addEventListener("online", dispatch);
        window.addEventListener("offline", dispatch);
        dispatch();

        return () => {
          window.removeEventListener("online", dispatch);
          window.removeEventListener("offline", dispatch);
        };
      },
    },
  },
});
```

The runner returns an optional disposer that VX calls when the subscription
disappears or is replaced. In this example, the host dispatches a `bool` payload
and the Voyd `handler` closure turns that payload into `Msg::OnlineChanged`.

Use `Sub.runtime_configured(kind:, key:, value:, handler:)` when the host runner
needs configuration:

```voyd
Sub::runtime_configured(
  kind: "websocket",
  key: "project:" + model.project_id,
  value: websocket_config(model.project_id),
  handler: (message: String) -> Msg =>
    Msg::SocketMessage { value: message }
)
```

The `value` field is sent to the host in the subscription descriptor. It is
configuration for starting the listener, such as a channel name, URL, or topic.
Data from the listener reaches Voyd when the host runner calls
`context.dispatch`.

The lower-level composition form is still available:

```voyd
Sub<String>::runtime(kind: "websocket", key: "project:" + model.project_id)
  .map((message: String) -> Msg => Msg::SocketMessage { value: message })
```

### Mapping Child Subscriptions

`Sub.map(handler)` lifts child subscriptions into parent message space. Use it
when a feature module owns its own `Msg` type:

```voyd
fn subscriptions(model: AppModel) -> Sub<AppMsg>
  todos::subscriptions(model.todos).map(
    (msg: todos::Msg) -> AppMsg => AppMsg::Todos { value: msg }
  )
```

Mapping becomes part of subscription identity. The runtime keeps mapped child
subscriptions separate from unmapped subscriptions with the same kind and key.

### Choosing The Shape

Start with `Sub.none()`. Add a subscription when the app needs ongoing input
from outside the current message. Keep the subscription constructor close to the
feature that handles its messages:

```voyd
obj Model {
  editing_id: String
}

enum Msg
  StartEdit { id: String }
  CancelEdit

fn subscriptions(model: Model) -> Sub<Msg>
  if
    model.editing_id.len() > 0:
      keyboard_on_key_down(key: "Escape", value: Msg::CancelEdit {})
    else:
      Sub<Msg>::none()

fn step(model: Model, msg: Msg) -> Program<Model, Msg>
  match(msg)
    Msg::StartEdit { id }:
      next(Model { editing_id: id })
    Msg::CancelEdit:
      next(Model { editing_id: String::init() })
```

When `StartEdit` sets `editing_id`, the next subscription pass starts the Escape
listener. When `CancelEdit` clears `editing_id`, the next subscription pass
disposes it.

## Feature Composition

Large VX apps should be built from features. A feature can own its own `Model`,
`Msg`, `step`, `view`, command constructors, and subscriptions. The parent app
stores the child model and wraps child messages in a parent message variant.

In a `todos` module, the feature can define a small state machine:

```voyd
obj Model {
  items: Array<Todo>,
  draft: String,
  saving: bool,
  error: String
}

enum Msg
  DraftChanged { value: String }
  Submit
  Created { result: Result<Todo, String> }

pub fn step(model: Model, msg: Msg): TaskRuntime -> Program<Model, Msg>
  match(msg)
    Msg::DraftChanged { value }:
      next(with_draft(model, value))
    Msg::Submit:
      next(model: saving_now(model), cmd: create_todo(model.draft))
    Msg::Created { result }:
      match(result)
        Ok { value }:
          next(adding(model, value))
        Err { error }:
          next(with_error(model, error))
```

The parent model keeps the feature model as a field:

```voyd
obj AppModel {
  todos: todos::Model,
  session: Session
}

enum AppMsg
  Todos { value: todos::Msg }
  SignedOut
```

When a child message arrives, delegate to the child `step`, then lift the child
transition into the parent app:

```voyd
AppMsg::Todos { value }:
  let child = todos::step(model.todos, value)
  let with_model = map_model(
    child,
    (next_todos: todos::Model) -> AppModel =>
      AppModel { todos: next_todos, session: model.session }
  )
  map_message(
    with_model,
    (child_msg: todos::Msg) -> AppMsg =>
      AppMsg::Todos { value: child_msg }
  )
```

`map_model` replaces the child transition model with a parent model. The mapper
receives the next `todos::Model`, then rebuilds `AppModel` with the existing
parent state around it.

`map_message` lifts every child message inside the child transition into the
parent message type. That includes messages produced later by child commands and
subscriptions.

Views, commands, and subscriptions have matching mappers:

```voyd
fn view(model: AppModel) -> Html<AppMsg>
  let handler_id = retain_typed_message_mapper(
    (msg: todos::Msg) -> AppMsg => AppMsg::Todos { value: msg }
  )
  <main>
    {map_html(
      html: todos::view(model.todos),
      handler_id: handler_id
    )}
  </main>

fn app_subscriptions(model: AppModel) -> Sub<AppMsg>
  todos::subscriptions(model.todos).map(
    (msg: todos::Msg) -> AppMsg => AppMsg::Todos { value: msg }
  )

fn load_todos_for_app(): TaskRuntime -> Cmd<AppMsg>
  todos::load_todos().map(
    (msg: todos::Msg) -> AppMsg => AppMsg::Todos { value: msg }
  )
```

Use the mapper that matches the value being composed:

- `map_html(html:, handler_id:)` lifts child HTML after you retain a message
  mapper with `retain_typed_message_mapper`.
- `Cmd.map` lifts child commands.
- `Sub.map` lifts child subscriptions.
- `map_model` lifts the model inside a child `Program`.
- `map_message` lifts messages inside a child `Program`.

This is the main tool for keeping feature state local. A todos feature can grow
its own loading flags, edit form, persistence commands, and keyboard
subscriptions while the parent app only knows that todos has a model field and a
message wrapper.

## Runtime And Interop

The default browser path is:

```ts
import { createVoydHost } from "@voyd-lang/sdk/js-host";
import { createVoydVxAppRuntime, mountVxApp } from "@voyd-lang/vx-dom/browser";

const host = await createVoydHost({
  wasm,
  bufferSize: 256 * 1024,
});

const app = createVoydVxAppRuntime({ host });
const mounted = await mountVxApp({
  container: document.getElementById("root")!,
  app,
});
```

`createVoydVxAppRuntime` looks for an exported `app` by default. If you are
using custom exports, pass them explicitly:

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

Use `runtimeHost` to add custom commands and subscriptions:

```ts
await mountVxApp({
  container,
  app,
  runtimeHost: {
    commands: {
      copy_to_clipboard: async (command) => {
        if (typeof command.value === "string") {
          await navigator.clipboard.writeText(command.value);
        }
      },
    },
    subscriptions: {
      online_status: (subscription, context) => {
        const dispatch = () =>
          context.dispatch({
            kind: "subscription",
            subscriptionKind: "online_status",
            key: String(subscription.key),
            payload: navigator.onLine,
          });
        window.addEventListener("online", dispatch);
        window.addEventListener("offline", dispatch);
        dispatch();
        return () => {
          window.removeEventListener("online", dispatch);
          window.removeEventListener("offline", dispatch);
        };
      },
    },
  },
});
```

Command handlers receive the command descriptor that Voyd produced. The
descriptor always has `type: "cmd"` and `kind`; constructors that take input put
that input in `value` after boundary encoding. A handler may be synchronous or
async. Unknown command kinds, thrown errors, and rejected promises are reported
through the runtime error handler with `phase: "commands"`. Runtime commands are
best for fire-and-forget host effects. Use `Cmd.task` when the work should
produce a typed result message through Voyd's task runtime.

Subscription runners receive the subscription descriptor that Voyd produced. The
descriptor always has `type: "sub"`, `kind`, and a stable `key`; optional
configuration is in `value`. A runner starts the listener and returns an
optional disposer. VX calls the disposer when the descriptor disappears, when the
same kind/key is replaced by a changed descriptor, and when the app is disposed.

Send data back by calling `context.dispatch`:

```ts
context.dispatch({
  kind: "subscription",
  subscriptionKind: String(subscription.kind),
  key: String(subscription.key),
  payload: nextValue,
});
```

The `payload` becomes the input to the Voyd `handler:` or `Sub.map` closure. If
the dispatched message includes `value`, VX treats it as a fixed message and the
payload is still available to custom runtime code but is not passed to the Voyd
mapper. `context.signal` is aborted during teardown, and `context.reportError`
reports asynchronous listener failures with `phase: "subscriptions"`.

The built-in browser runtime host already handles:

- Commands: `delay`, `task`, `copy_to_clipboard`, `focus`,
  `scroll_into_view`, `set_document_title`, `push_url`, `replace_url`,
  `navigate_back`, `navigate_forward`.
- Subscriptions: `interval`, `keyboard`, `online_status`, `window_resize`,
  `visibility_change`.

Lower-level renderer APIs are available for integration work:

- `createVxDomRenderer(container)` returns a renderer that can render, hydrate,
  dispose, and expose a snapshot.
- `renderVxToString(...)` renders a VX frame or Wasm component to HTML on the
  server.
- `renderNodeToString(vnode)` renders an already-normalized node.

Server rendering produces a frame and hydration data. Browser commands and
browser subscriptions begin on the client after hydration, through normal message
handling and `subscriptions(model)`.

Runtime errors are reported by phase: `init`, `dispatch`, `render`,
`subscriptions`, `commands`, or `dispose`. Malformed frames, invalid tag names,
invalid attributes, invalid CSS names, unknown command kinds, unknown
subscription kinds, and malformed envelopes are errors.

## Testing VX Code

The easiest tests target pure pieces:

- `step` with a model and message.
- model helper functions such as `with_error` or `adding`.
- command constructors by checking the command structure when the boundary matters.
- subscriptions by checking they appear and disappear for the right model states.

Prefer one integration test at the public boundary for browser behavior: mount
the app, dispatch events, and assert the DOM or runtime messages. Keep
state-machine assertions at one layer.

## Guide: Database-Backed Todos

The rest of this page builds a todos app in pieces, then shows the complete file.
The example is a vehicle for the VX shape: model data is durable, messages
describe events, `step` chooses the next model, commands isolate outside work,
subscriptions describe ambient input, and the view renders the current model.

### 1. Data And State

Start with the data the app owns.

```voyd
obj Todo {
  id: String,
  title: String,
  done: bool
}

obj Model {
  todos: Array<Todo>,
  draft: String,
  editing_id: String,
  editing_title: String,
  loading: bool,
  saving: bool,
  error: String
}
```

This model is intentionally explicit. It tracks the list, the new-todo draft,
the edit form, and UI state for loading, saving, and errors. A richer app might
use `Option<String>` for `editing_id`; this example keeps strings to stay focused
on VX.

### 2. Messages

Every way the model can change becomes a message.

```voyd
enum Msg
  Load
  Loaded { result: Result<Array<Todo>, String> }
  DraftChanged { value: String }
  Submit
  Created { result: Result<Todo, String> }
  StartEdit { id: String, title: String }
  EditChanged { value: String }
  SaveEdit
  Saved { result: Result<Todo, String> }
  Delete { id: String }
  Deleted { result: Result<String, String> }
  CancelEdit
```

The async result messages carry `Result`. That makes expected persistence
failures part of the state machine and keeps runtime exceptions for unexpected
runtime failures.

### 3. Entrypoint And Startup

The app should load todos immediately, so `init` returns a `Program` with an
initial model and a command.

```voyd
pub fn app() -> Program<Model, Msg>
  program({ init, step, view, subscriptions })

fn init(): TaskRuntime -> Program<Model, Msg>
  next(
    model: Model {
      todos: Array<Todo>::init(),
      draft: String::init(),
      editing_id: String::init(),
      editing_title: String::init(),
      loading: true,
      saving: false,
      error: String::init()
    },
    cmd: load_todos()
  )
```

`init` has a `TaskRuntime` effect because `load_todos` uses `Cmd.task`.

### 4. Transitions

`step` is the center of the app. Database work is represented as command data.

```voyd
fn step(model: Model, msg: Msg): TaskRuntime -> Program<Model, Msg>
  match(msg)
    Msg::Load:
      next(model: loading(model), cmd: load_todos())
    Msg::Loaded { result }:
      match(result)
        Ok { value }:
          next(with_todos(model, value))
        Err { error }:
          next(with_error(model, error))
    Msg::DraftChanged { value }:
      next(with_draft(model, value))
    Msg::Submit:
      next(model: saving_now(model), cmd: create_todo(model.draft))
    Msg::Created { result }:
      match(result)
        Ok { value }:
          next(adding(model, value))
        Err { error }:
          next(with_error(model, error))
    Msg::StartEdit { id, title }:
      next(start_edit(model, id, title))
    Msg::EditChanged { value }:
      next(with_edit(model, value))
    Msg::SaveEdit:
      next(
        model: saving_now(model),
        cmd: save_todo(model.editing_id, model.editing_title)
      )
    Msg::Saved { result }:
      match(result)
        Ok { value }:
          next(replacing(model, value))
        Err { error }:
          next(with_error(model, error))
    Msg::Delete { id }:
      next(model: saving_now(model), cmd: delete_todo(id))
    Msg::Deleted { result }:
      match(result)
        Ok { value }:
          next(removing(model, value))
        Err { error }:
          next(with_error(model, error))
    Msg::CancelEdit:
      next(cancel_edit(model))
```

This example is pessimistic: it waits for persistence to succeed before changing
the todo list. An optimistic version would update the list before returning the
command and roll back if a result message reports failure.

### 5. Command Constructors

Each persistence operation gets a named command constructor.

```voyd
fn load_todos(): TaskRuntime -> Cmd<Msg>
  Cmd::task(
    work: () -> Result<Array<Todo>, String> => Ok { value: db_load_todos() },
    handler: (result: Result<Array<Todo>, String>) -> Msg =>
      Msg::Loaded { result: result }
  )

fn create_todo(title: String): TaskRuntime -> Cmd<Msg>
  Cmd::task(
    work: () -> Result<Todo, String> => Ok { value: db_create_todo(title) },
    handler: (result: Result<Todo, String>) -> Msg =>
      Msg::Created { result: result }
  )
```

Keep command constructors small. If an operation needs retries, authentication,
or richer error mapping, keep that detail inside the command constructor or the
API layer it calls. `step` should still read as a transition table.

### 6. Subscriptions

While editing, Escape should cancel the edit. Outside edit mode, the app returns
an empty subscription set.

```voyd
fn subscriptions(model: Model) -> Sub<Msg>
  if
    model.editing_id.len() > 0:
      keyboard_on_key_down(key: "Escape", value: Msg::CancelEdit {})
    else:
      Sub<Msg>::none()
```

The runtime starts the keyboard subscription when editing begins and disposes it
when editing ends.

### 7. View

The view is split into a form, a list, and one row component.

```voyd
fn view(model: Model) -> Html<Msg>
  <main>
    <form on_submit={on_submit_with(options: EventOptions { prevent_default: true }, message: Msg::Submit {})}>
      <input value={model.draft} on_input={(event: InputEvent) -> Msg => Msg::DraftChanged { value: event.value }} />
      <button type="submit" disabled={model.saving}>Add</button>
    </form>
    <ul>
      {model.todos.map((todo) =>
        <TodoRow key={todo.id} todo={todo} model={model} />
      )}
    </ul>
  </main>
```

`TodoRow` renders either a read-only row or the edit controls:

```voyd
fn TodoRow({ todo: Todo, model: Model }) -> Html<Msg>
  if editing_todo(model, todo):
    <li>
      <input
        value={model.editing_title}
        on_input={(event: InputEvent) -> Msg => Msg::EditChanged { value: event.value }}
      />
      <button type="button" on_click={Msg::SaveEdit {}}>Save</button>
      <button type="button" on_click={Msg::CancelEdit {}}>Cancel</button>
    </li>
  else:
    <li>
      <span>{todo.title}</span>
      <button type="button" on_click={Msg::StartEdit { id: todo.id, title: todo.title }}>Edit</button>
      <button type="button" on_click={Msg::Delete { id: todo.id }}>Delete</button>
    </li>
```

### Complete Example

```voyd
use std::array::Array
use std::enums::{ enum }
use std::result::types::all
use std::string::type::String
use std::task::TaskRuntime
use std::vx::all

obj Todo {
  id: String,
  title: String,
  done: bool
}

obj Model {
  todos: Array<Todo>,
  draft: String,
  editing_id: String,
  editing_title: String,
  loading: bool,
  saving: bool,
  error: String
}

enum Msg
  Load
  Loaded { result: Result<Array<Todo>, String> }
  DraftChanged { value: String }
  Submit
  Created { result: Result<Todo, String> }
  StartEdit { id: String, title: String }
  EditChanged { value: String }
  SaveEdit
  Saved { result: Result<Todo, String> }
  Delete { id: String }
  Deleted { result: Result<String, String> }
  CancelEdit

pub fn app() -> Program<Model, Msg>
  program({ init, step, view, subscriptions })

fn init(): TaskRuntime -> Program<Model, Msg>
  next(
    model: Model {
      todos: Array<Todo>::init(),
      draft: String::init(),
      editing_id: String::init(),
      editing_title: String::init(),
      loading: true,
      saving: false,
      error: String::init()
    },
    cmd: load_todos()
  )

fn step(model: Model, msg: Msg): TaskRuntime -> Program<Model, Msg>
  match(msg)
    Msg::Load:
      next(model: loading(model), cmd: load_todos())
    Msg::Loaded { result }:
      match(result)
        Ok { value }:
          next(with_todos(model, value))
        Err { error }:
          next(with_error(model, error))
    Msg::DraftChanged { value }:
      next(with_draft(model, value))
    Msg::Submit:
      next(model: saving_now(model), cmd: create_todo(model.draft))
    Msg::Created { result }:
      match(result)
        Ok { value }:
          next(adding(model, value))
        Err { error }:
          next(with_error(model, error))
    Msg::StartEdit { id, title }:
      next(start_edit(model, id, title))
    Msg::EditChanged { value }:
      next(with_edit(model, value))
    Msg::SaveEdit:
      next(
        model: saving_now(model),
        cmd: save_todo(model.editing_id, model.editing_title)
      )
    Msg::Saved { result }:
      match(result)
        Ok { value }:
          next(replacing(model, value))
        Err { error }:
          next(with_error(model, error))
    Msg::Delete { id }:
      next(model: saving_now(model), cmd: delete_todo(id))
    Msg::Deleted { result }:
      match(result)
        Ok { value }:
          next(removing(model, value))
        Err { error }:
          next(with_error(model, error))
    Msg::CancelEdit:
      next(cancel_edit(model))

fn load_todos(): TaskRuntime -> Cmd<Msg>
  Cmd::task(
    work: () -> Result<Array<Todo>, String> =>
      Ok { value: db_load_todos() },
    handler: (result: Result<Array<Todo>, String>) -> Msg =>
      Msg::Loaded { result: result }
  )

fn create_todo(title: String): TaskRuntime -> Cmd<Msg>
  Cmd::task(
    work: () -> Result<Todo, String> =>
      Ok { value: db_create_todo(title) },
    handler: (result: Result<Todo, String>) -> Msg =>
      Msg::Created { result: result }
  )

fn save_todo(id: String, title: String): TaskRuntime -> Cmd<Msg>
  Cmd::task(
    work: () -> Result<Todo, String> =>
      Ok { value: db_save_todo(id, title) },
    handler: (result: Result<Todo, String>) -> Msg =>
      Msg::Saved { result: result }
  )

fn delete_todo(id: String): TaskRuntime -> Cmd<Msg>
  Cmd::task(
    work: () -> Result<String, String> =>
      Ok { value: db_delete_todo(id) },
    handler: (result: Result<String, String>) -> Msg =>
      Msg::Deleted { result: result }
  )

fn subscriptions(model: Model) -> Sub<Msg>
  if
    model.editing_id.len() > 0:
      keyboard_on_key_down(key: "Escape", value: Msg::CancelEdit {})
    else:
      Sub<Msg>::none()

fn view(model: Model) -> Html<Msg>
  <main>
    <form on_submit={on_submit_with(options: EventOptions { prevent_default: true }, message: Msg::Submit {})}>
      <input value={model.draft} on_input={(event: InputEvent) -> Msg => Msg::DraftChanged { value: event.value }} />
      <button type="submit" disabled={model.saving}>Add</button>
    </form>

    <ul>
      {model.todos.map((todo) =>
        <TodoRow key={todo.id} todo={todo} model={model} />
      )}
    </ul>

    {loading_status(model)}
    {error_status(model)}
  </main>

fn loading_status(model: Model) -> Html<Msg>
  if model.loading:
    <p>Loading...</p>
  else:
    <span></span>

fn error_status(model: Model) -> Html<Msg>
  if model.error.len() > 0:
    <p role="alert">{model.error}</p>
  else:
    <span></span>

fn TodoRow({ todo: Todo, model: Model }) -> Html<Msg>
  if editing_todo(model, todo):
    <li>
      <input
        value={model.editing_title}
        on_input={(event: InputEvent) -> Msg => Msg::EditChanged { value: event.value }}
      />
      <button type="button" on_click={Msg::SaveEdit {}}>Save</button>
      <button type="button" on_click={Msg::CancelEdit {}}>Cancel</button>
    </li>
  else:
    <li>
      <span>{todo.title}</span>
      <button type="button" on_click={Msg::StartEdit { id: todo.id, title: todo.title }}>Edit</button>
      <button type="button" on_click={Msg::Delete { id: todo.id }}>Delete</button>
    </li>

fn loading(model: Model) -> Model
  Model {
    todos: model.todos,
    draft: model.draft,
    editing_id: model.editing_id,
    editing_title: model.editing_title,
    loading: true,
    saving: false,
    error: String::init()
  }

fn with_todos(model: Model, todos: Array<Todo>) -> Model
  Model {
    todos: todos,
    draft: model.draft,
    editing_id: model.editing_id,
    editing_title: model.editing_title,
    loading: false,
    saving: false,
    error: String::init()
  }

fn with_draft(model: Model, draft: String) -> Model
  Model {
    todos: model.todos,
    draft: draft,
    editing_id: model.editing_id,
    editing_title: model.editing_title,
    loading: model.loading,
    saving: model.saving,
    error: model.error
  }

fn saving_now(model: Model) -> Model
  Model {
    todos: model.todos,
    draft: model.draft,
    editing_id: model.editing_id,
    editing_title: model.editing_title,
    loading: false,
    saving: true,
    error: String::init()
  }

fn with_error(model: Model, error: String) -> Model
  Model {
    todos: model.todos,
    draft: model.draft,
    editing_id: model.editing_id,
    editing_title: model.editing_title,
    loading: false,
    saving: false,
    error: error
  }

fn adding(model: Model, todo: Todo) -> Model
  let ~todos = model.todos
  todos.push(todo)
  Model {
    todos: todos,
    draft: String::init(),
    editing_id: model.editing_id,
    editing_title: model.editing_title,
    loading: false,
    saving: false,
    error: String::init()
  }

fn start_edit(model: Model, id: String, title: String) -> Model
  Model {
    todos: model.todos,
    draft: model.draft,
    editing_id: id,
    editing_title: title,
    loading: model.loading,
    saving: model.saving,
    error: model.error
  }

fn with_edit(model: Model, title: String) -> Model
  Model {
    todos: model.todos,
    draft: model.draft,
    editing_id: model.editing_id,
    editing_title: title,
    loading: model.loading,
    saving: model.saving,
    error: model.error
  }

fn replacing(model: Model, todo: Todo) -> Model
  let ~todos = Array<Todo>::init()
  var index = 0
  while index < model.todos.len():
    let current = model.todos.at(index)
    if current.id == todo.id:
      todos.push(todo)
    else:
      todos.push(current)
    index = index + 1
  Model {
    todos: todos,
    draft: model.draft,
    editing_id: String::init(),
    editing_title: String::init(),
    loading: false,
    saving: false,
    error: String::init()
  }

fn removing(model: Model, id: String) -> Model
  let ~todos = Array<Todo>::init()
  var index = 0
  while index < model.todos.len():
    let current = model.todos.at(index)
    if current.id != id:
      todos.push(current)
    index = index + 1
  Model {
    todos: todos,
    draft: model.draft,
    editing_id: model.editing_id,
    editing_title: model.editing_title,
    loading: false,
    saving: false,
    error: String::init()
  }

fn cancel_edit(model: Model) -> Model
  Model {
    todos: model.todos,
    draft: model.draft,
    editing_id: String::init(),
    editing_title: String::init(),
    loading: model.loading,
    saving: false,
    error: String::init()
  }

fn editing_todo(model: Model, todo: Todo) -> bool
  model.editing_id == todo.id

fn db_load_todos() -> Array<Todo>
  let ~todos = Array<Todo>::init()
  todos.push(Todo { id: "1", title: "Ship VX", done: false })
  todos

fn db_create_todo(title: String) -> Todo
  Todo { id: title, title: title, done: false }

fn db_save_todo(id: String, title: String) -> Todo
  Todo { id: id, title: title, done: false }

fn db_delete_todo(id: String) -> String
  id
```

The same structure scales beyond todos. Add features by giving each feature its
own model, messages, view, commands, and subscriptions. Let parents compose those
pieces with the VX mapping helpers. Keep outside work behind commands and
subscriptions, and keep durable behavior visible in `step`.
