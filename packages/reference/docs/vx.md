---
order: 8
---

# VX

VX is Voyd's UI layer for typed browser apps. A VX app is a small state
machine: `Model` is durable app state, `Msg` describes transitions, `step`
advances the model, `view` renders HTML, commands describe one-off work, and
subscriptions describe ongoing outside events.

The canonical app entrypoint is:

```voyd
pub fn app() -> Program<Model, Msg>
  program<Model, Msg>(
    init: init,
    step: step,
    view: view,
    subscriptions: subscriptions
  )
```

`step`, not `update`, handles messages:

```voyd
fn step(model: Model, message: Msg) -> Program<Model, Msg>
  match(message)
    Msg::Edit { value }:
      next<Model, Msg>(Model { title: value, saved: false })
    Msg::Save:
      next<Model, Msg>(
        model: Model { title: model.title, saved: false },
        cmd: save_title(model.title)
      )
```

`next` is a pure constructor for the `Program<Model, Msg>` returned by `step`.
It always requires the next model. Commands are returned as data; `next` does
not run work and does not manage subscriptions.

Typed lifecycle values must be boundary-compatible DTOs: primitives, `String`,
arrays, records/objects with public DTO fields, value objects, and named message
variants built from those values. Functions, trait objects, arbitrary
dictionaries, and recursive object graphs are not app-boundary DTOs.

`Cmd<Msg>` and `Sub<Msg>` are typed payload objects. `Html<Msg>`,
`Attr<Msg>`, and `Program<Model, Msg>` remain payload-compatible VX values for
the current compiler/runtime boundary; app code should construct them through
the typed helpers instead of raw `MsgPack`. The intended direction is stronger
nominal app-facing wrappers once the compiler can support them without
excessive type-checking cost.

## Views

Use HTML syntax for normal UI:

```voyd
fn view(model: Model) -> Html<Msg>
  <main>
    <input
      value={model.title}
      on_input={(event: InputEvent) -> Msg => Msg::Edit { value: event.value }}
    />
    <button on_click={Msg::Save {}}>Save</button>
  </main>
```

Components are regular functions that return `Html<Msg>`:

```voyd
fn Toolbar({ on_save: fn() -> Msg }) -> Html<Msg>
  <button on_click={on_save}>Save</button>
```

Use `keyed(key:, child:)` when list items should keep DOM identity while
reordering. If keyed children create component-local state, use
`keyed(key:, body:)` so the local state scope follows the key.

## Events

Events can send fixed messages, call closures, or pass normalized browser event
payloads:

```voyd
<button on_click={Msg::Save {}}>Save</button>
<button on_click={() -> Msg => Msg::Cancel {}}>Cancel</button>
<input on_input={(event: InputEvent) -> Msg => Msg::Edit { value: event.value }} />
```

Use `EventOptions` for browser behavior such as form submission:

```voyd
on_submit_with(
  options: EventOptions { prevent_default: true },
  message: Msg::Submit {}
)
```

## State

Durable, shared, server, URL, command, subscription, and testable business state
belongs in `Model`. Component-local state remains a restricted UI-local escape
valve for small component-owned `String`, `i32`, or serialized values:

```voyd
let (panel, set_panel) = state(initial: "closed")
<button on_click={() => set_panel("open")}>Open</button>
```

Do not use component-local state for data that other features need to read, save,
load, subscribe from, or test as application behavior.

## Commands

Commands are one-off work that eventually dispatches messages:

```voyd
Cmd<Msg>::message(Msg::Saved {})
Cmd<Msg>::delay(millis: 250i64, value: Msg::Saved {})
Cmd<Msg>::batch([first, second])
Cmd<Msg>::focus<DomElement>(editor_ref)
Cmd<Msg>::scroll_into_view<DomElement>(editor_ref)
```

Use named command constructors so `step` stays focused on state transitions.
Today, async work uses `detach` plus `Cmd.perform`; a higher-level `Cmd.task`
helper is tracked as follow-up work.

```voyd
fn save_title(title: String): TaskRuntime -> Cmd<Msg>
  let task = detach<SaveResult> do:
    api_save_title(title)
  Cmd<Msg>::perform<SaveResult>(
    task: task,
    handler: (result: SaveResult) -> Msg => Msg::Saved { result: result }
  )
```

Use `Cmd.map` when a child feature command should return parent messages.

## Subscriptions

Subscriptions are declarative ongoing listeners derived from the latest model:

```voyd
fn subscriptions(model: Model) -> Sub<Msg>
  if
    model.editing:
      keyboard_on_key_down<Msg>(key: "Escape", value: Msg::Cancel {})
    else:
      Sub<Msg>::none()
```

The runtime syncs subscriptions after each message:

```text
message -> step(model, msg) -> Program(next_model, commands)
runtime stores next_model
runtime evaluates subscriptions(next_model)
runtime disposes disappeared or changed subscriptions
runtime starts new subscriptions
runtime runs commands
```

Unsubscribe by omission: leave a subscription out of the latest
`subscriptions(model)` result and the runtime disposes it. Stable keys identify
subscriptions; if a subscription with the same key changes descriptor fields, it
is replaced.

## Feature Composition

Feature modules should own their own `Model`, `Msg`, `step`, `view`, command
constructors, and subscriptions. Parent features delegate child work and map
messages at the command, subscription, and view boundaries:

```voyd
AppMsg::Todos { value }:
  let child = todos::step(model.todos, value)
  next<AppModel, AppMsg>(
    model: AppModel { todos: next_todos_model, session: model.session },
    cmd: child_command.map<AppMsg>(
      (msg: todos::Msg) -> AppMsg => AppMsg::Todos { value: msg }
    )
  )
```

Compose views with `map_html`, commands with `Cmd.map`, subscriptions with
`Sub.map`. Typed program-level `map_model` / `map_message` helpers are the
intended next step, but they are tracked separately because the current compiler
cannot type-check those generic DTO helper paths within budget.

## Runtime And Interop

Typed apps should export `app() -> Program<Model, Msg>`. The JavaScript host
uses `createVoydVxAppRuntime({ host })` and `mountVxApp({ container, app })`.

Raw frame rendering remains available for lower-level renderer interop through
`renderVxToString`, `renderNodeToString`, `renderMsgPackNode`, and explicit
custom lifecycle export names. Those APIs are not the default app architecture.

Versioned VX frames are strict. Malformed typed frames, invalid HTML tag names,
invalid attribute names, invalid CSS property names, malformed command or
subscription envelopes, and missing runtime handlers are reported as errors.

Server rendering does not start commands or browser subscriptions. App-level SSR
renders from an initialized model snapshot and serializes the frame for
hydration. Client hydration adopts the hydrated frame, then normal runtime
message handling evaluates `subscriptions(model)` and syncs listeners from the
current model. Commands returned by server initialization should be treated as
client/runtime work, not server-side browser effects.

## Database-Backed Todos

This example shows the recommended shape for a todos app. The database/API calls
are intentionally isolated in named command constructors; `step` only chooses
the next model and command data.

```voyd
use std::array::Array
use std::enums::{ enum }
use std::result::types::all
use std::string::type::String
use std::task::{ TaskRuntime, detach }
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
  program<Model, Msg>(
    init: init,
    step: step,
    view: view,
    subscriptions: subscriptions
  )

fn init(): TaskRuntime -> Program<Model, Msg>
  next<Model, Msg>(
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
      next<Model, Msg>(model: loading(model), cmd: load_todos())
    Msg::Loaded { result }:
      match(result)
        Ok<Array<Todo>> { value }:
          next<Model, Msg>(with_todos(model, value))
        Err<String> { error }:
          next<Model, Msg>(with_error(model, error))
    Msg::DraftChanged { value }:
      next<Model, Msg>(with_draft(model, value))
    Msg::Submit:
      next<Model, Msg>(model: saving_now(model), cmd: create_todo(model.draft))
    Msg::Created { result }:
      match(result)
        Ok<Todo> { value }:
          next<Model, Msg>(adding(model, value))
        Err<String> { error }:
          next<Model, Msg>(with_error(model, error))
    Msg::StartEdit { id, title }:
      next<Model, Msg>(start_edit(model, id, title))
    Msg::EditChanged { value }:
      next<Model, Msg>(with_edit(model, value))
    Msg::SaveEdit:
      next<Model, Msg>(
        model: saving_now(model),
        cmd: save_todo(model.editing_id, model.editing_title)
      )
    Msg::Saved { result }:
      match(result)
        Ok<Todo> { value }:
          next<Model, Msg>(replacing(model, value))
        Err<String> { error }:
          next<Model, Msg>(with_error(model, error))
    Msg::Delete { id }:
      next<Model, Msg>(model: saving_now(model), cmd: delete_todo(id))
    Msg::Deleted { result }:
      match(result)
        Ok<String> { value }:
          next<Model, Msg>(removing(model, value))
        Err<String> { error }:
          next<Model, Msg>(with_error(model, error))
    Msg::CancelEdit:
      next<Model, Msg>(cancel_edit(model))

fn load_todos(): TaskRuntime -> Cmd<Msg>
  let task = detach<Array<Todo>> do:
    db_load_todos()
  Cmd<Msg>::perform<Array<Todo>>(
    task: task,
    handler: (todos: Array<Todo>) -> Msg => Msg::Loaded { result: Ok<Array<Todo>> { value: todos } }
  )

fn create_todo(title: String): TaskRuntime -> Cmd<Msg>
  let task = detach<Todo> do:
    db_create_todo(title)
  Cmd<Msg>::perform<Todo>(
    task: task,
    handler: (todo: Todo) -> Msg => Msg::Created { result: Ok<Todo> { value: todo } }
  )

fn save_todo(id: String, title: String): TaskRuntime -> Cmd<Msg>
  let task = detach<Todo> do:
    db_save_todo(id, title)
  Cmd<Msg>::perform<Todo>(
    task: task,
    handler: (todo: Todo) -> Msg => Msg::Saved { result: Ok<Todo> { value: todo } }
  )

fn delete_todo(id: String): TaskRuntime -> Cmd<Msg>
  let task = detach<String> do:
    db_delete_todo(id)
  Cmd<Msg>::perform<String>(
    task: task,
    handler: (deleted_id: String) -> Msg => Msg::Deleted { result: Ok<String> { value: deleted_id } }
  )

fn subscriptions(model: Model) -> Sub<Msg>
  if
    model.editing_id.len() > 0:
      keyboard_on_key_down<Msg>(key: "Escape", value: Msg::CancelEdit {})
    else:
      Sub<Msg>::none()

fn view(model: Model) -> Html<Msg>
  <main>
    <form on_submit={on_submit_with(options: EventOptions { prevent_default: true }, message: Msg::Submit {})}>
      <input value={model.draft} on_input={(event: InputEvent) -> Msg => Msg::DraftChanged { value: event.value }} />
      <button type="submit">Add</button>
    </form>
    <ul>
      {model.todos.map<Html<Msg>>((todo: Todo) -> Html<Msg> =>
        keyed(key: todo.id, child: <TodoRow todo={todo} model={model} />)
      )}
    </ul>
  </main>

fn TodoRow({ todo: Todo, model: Model }) -> Html<Msg>
  if editing_todo(model, todo):
    <li>
      <input
        value={model.editing_title}
        on_input={(event: InputEvent) -> Msg => Msg::EditChanged { value: event.value }}
      />
      <button on_click={Msg::SaveEdit {}}>Save</button>
      <button on_click={Msg::CancelEdit {}}>Cancel</button>
    </li>
  else:
    <li>
      <span>{todo.title}</span>
      <button on_click={Msg::StartEdit { id: todo.id, title: todo.title }}>Edit</button>
      <button on_click={Msg::Delete { id: todo.id }}>Delete</button>
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
  Model { todos: model.todos, draft: draft, editing_id: model.editing_id, editing_title: model.editing_title, loading: model.loading, saving: model.saving, error: model.error }

fn saving_now(model: Model) -> Model
  Model { todos: model.todos, draft: model.draft, editing_id: model.editing_id, editing_title: model.editing_title, loading: false, saving: true, error: String::init() }

fn with_error(model: Model, error: String) -> Model
  Model { todos: model.todos, draft: model.draft, editing_id: model.editing_id, editing_title: model.editing_title, loading: false, saving: false, error: error }

fn adding(model: Model, todo: Todo) -> Model
  let ~todos = model.todos
  todos.push(todo)
  Model { todos: todos, draft: String::init(), editing_id: model.editing_id, editing_title: model.editing_title, loading: false, saving: false, error: String::init() }

fn start_edit(model: Model, id: String, title: String) -> Model
  Model { todos: model.todos, draft: model.draft, editing_id: id, editing_title: title, loading: model.loading, saving: model.saving, error: model.error }

fn with_edit(model: Model, title: String) -> Model
  Model { todos: model.todos, draft: model.draft, editing_id: model.editing_id, editing_title: title, loading: model.loading, saving: model.saving, error: model.error }

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
  Model { todos: todos, draft: model.draft, editing_id: String::init(), editing_title: String::init(), loading: false, saving: false, error: String::init() }

fn removing(model: Model, id: String) -> Model
  let ~todos = Array<Todo>::init()
  var index = 0
  while index < model.todos.len():
    let current = model.todos.at(index)
    if current.id != id:
      todos.push(current)
    index = index + 1
  Model { todos: todos, draft: model.draft, editing_id: model.editing_id, editing_title: model.editing_title, loading: false, saving: false, error: String::init() }

fn cancel_edit(model: Model) -> Model
  Model { todos: model.todos, draft: model.draft, editing_id: String::init(), editing_title: String::init(), loading: model.loading, saving: false, error: String::init() }

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

The example uses a pessimistic persistence strategy: UI enters loading/saving
states immediately, then updates the durable todo list only after the command
returns a result message. Optimistic updates use the same architecture, but
`step` changes the model before returning the command and rolls back on failure.
