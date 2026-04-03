---
order: 7
---

# Tasks and Time

Voyd task concurrency is same-run and same-event-loop. `task::spawn(...)` and
`task::detach(...)` create concurrent work, but they do not create parallel
threads.

## Core Task APIs

```voyd
use std::async::types::{ Cancelled }
use std::error::panic
use std::task::self as task

pub fn main(): task::TaskRuntime -> i32
  let child = task::spawn(() =>
    41
  )

  match(child.await())
    Ok { value }:
      value
    Err { error }:
      panic(error.message.as_slice())
    Cancelled:
      0
```

- `task::spawn(...)` creates an attached child task.
- `task::detach(...)` creates a detached task owned by the run.
- `task.await()` waits for `Ok`, `Err`, or `Cancelled`.
- `task::join(...)` remains available as the task-specific free-function form.
- `task::cancel(...)` requests cancellation.
- `task::yield_now()` yields cooperatively to the run scheduler.

Attached child tasks participate in structured concurrency:

- owner cancellation cancels attached children
- unobserved attached-child failures fail the owner

Detached tasks are still part of the same run, but their failures are reported
through the runtime's unhandled-task sink instead of failing the creator.

## Sequential Sleep

`time::sleep(...)` suspends the current task. It does not spawn a new task.

```voyd
use std::time::self as time

pub fn main(): time::Time -> i32
  let _ = time::sleep(250)
  1
```

## Timers

Timer helpers build on the same task model.

```voyd
use std::async::types::{ Cancelled }
use std::error::panic
use std::task::self as task
use std::time::{ Duration, Overlap }
use std::time::self as time

pub fn main(): (task::TaskRuntime, time::Time) -> i32
  let timeout = time::set_timeout(
    Duration::from_millis(5),
    () => 7
  )

  let interval = time::set_interval(
    Duration::from_millis(1000),
    Overlap::serial(),
    () => sync_once()
  )

  let _ = task::cancel<Unit>(interval)

  match(timeout.await())
    Ok { value }:
      value
    Err { error }:
      panic(error.message.as_slice())
    Cancelled:
      0

fn sync_once(): time::Time -> Unit
  let _ = time::sleep(Duration::from_millis(10))
  Unit {}
```

- `time::set_timeout(...)` returns a detached `Task<T>` for the callback result.
- `time::set_interval(...)` returns the interval driver task.
- `Overlap::serial()` waits for one callback to finish before starting the next.
- `Overlap::concurrent()` allows overlapping callback tasks.

Use `time::sleep(...)` when you want sequential suspension in the current task.
Use `set_timeout(...)` or `set_interval(...)` when you want new scheduled task
work.
