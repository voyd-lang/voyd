# Effects

Effects are resumable exceptions. AKA exceptions on steroids, AKA exceptions
that are actually enjoyable to work with.

Effects provide a number benefits to the language, library authors, and users:
- Type-safe error handling
- Type-safe dependency injection
- Type-safe mocking and testing
- Delimited continuations
- And more!

Effects are a powerful language abstraction. They allow for features like async/await, exceptions, generators, and coroutines to be implemented **IN THE LANGUAGE**, rather than the implementation. Many features that are traditionally implemented in the compiler can be implemented as libraries in Voyd. This allows for more flexibility and control over the behavior of these features. It also saves users from having to wait for the language to be updated to get new features. No more waiting on endless bikeshedding discussions about the syntax of async/await!

Voyd's effect system takes heavy inspiration from:
- [Koka Language](https://koka-lang.github.io), which largely inspired the effects syntax
- [Effeckt Language](https://effekt-lang.org/)
- The paper ["Structured Asynchrony with Algebraic Effects" by Daan Leijen"](https://www.microsoft.com/en-us/research/wp-content/uploads/2017/05/asynceffects-msr-tr-2017-21.pdf)


## Defining Effects

```voyd
effect Exception
  // An effect that may be resumed by the handler
  ctl throw(msg: String) -> void

// Effects with one control can be defined concisely as
effect ctl throw(msg: String) -> void

effect State
  // Tail resumptive effect, guaranteed to resume exactly once.
  // Are defined like normal functions
  fn get() -> Int
  fn set(x: Int) -> void

// Tail resumptive effects with one function can be defined concisely as
effect fn get() -> Int
```

## Using Effects

```voyd
effect Async
  ctl resolve(int: i32) -> void
  ctl reject(msg: String) -> void

fn asyncTask(num: i32): Async -> Int
  if num > 0
    Async::resolve(num)
  else
    Async::reject("Number must be positive")

fn main()
  try
    asyncTask(1)
  with: {
    ctl resolve(num) -> void
      println("Resolved: " + num)
    ctl reject(msg) -> void
      println("Rejected: " + msg)
  }

// Effects are also inferred
fn asyncTask(num: i32) -> Int // Inferred to be Async -> Int
  if num > 0
    Async::resolve(num)
  else
    Async::reject("Number must be positive")

// A use statement can may the function a little cleaner
use Async::{resolve, reject}

fn asyncTask(num: i32) -> Int
  if num > 0
    resolve(num)
  else
    reject("Number must be positive")
```
