# Voyd Stdlib v1 Announcement-Critical Spec (Voyd Semantics)

**Scope:** A concrete checklist of stdlib modules, types, effects, and functions that should exist before announcing Voyd as an app-y, WASM-first, embeddable scripting/plugin language.

## Constraints

- No default parameter values. Use overloads or optional params (`foo?: Bar`).
- Labeled parameters use `{ ... }`.
- Generics use `<>`.
- `type` is only for aliases.
- Nominal data uses `obj` (+ `impl` for methods).
- Sum types use unions (`A | B`), not enums.
- Type names are UpperCamelCase. Functions are snake_case.
- Paths use `::`.
- Add `///` doc comments for all public API symbols.
- Testing/linting are out of scope for this document.

---

## 0) Prelude and auto-import

### 0.1 `std::prelude`

`std::prelude` is a normal module that exports an `all` barrel containing the common surface.

**`std::prelude::all` must export**

- Core unions: `Option`, `Result`
- Core traits: `Eq`, `Ord`, `Hash`, `Default`, `Clone`, `Copy`, `Debug`, `Display`
- Iteration traits: `Sequence<>` and `Iterator<>`
- Diagnostics: `panic`, `assert`
- Formatting entrypoint: `format`

### 0.2 Auto-import rules (language behavior)

The compiler must behave as if this exists at the top of every file:

```voyd
use std::prelude::all
```

Resolution rules:

- Items in `std::prelude::all` come into scope directly (not under a `prelude` namespace).
- Normal shadowing rules apply.
- Prelude auto-import must be suppressible (`#!no_prelude` preferred).

---

## 1) Module layout (v1)

Must exist:

- `std::prelude`
- `std::optional`, `std::result`
- `std::error`
- `std::fmt`
- `std::log`
- `std::bytes`
- `std::encoding::hex`, `std::encoding::base64`
- `std::time`
- `std::random`
- `std::json`
- `std::env`
- `std::version`
- `std::fs`
- `std::path`
- `std::set`
- `std::deque`


---

## 2) Host-backed API contract

Host-dependent capabilities should be effect-backed. Public helper functions can wrap effect operations, but the source of truth is explicit `eff` contracts.

Host-backed modules in v1:

- `std::log` via `Log`
- `std::time` via `Time`
- `std::random` via `Random`
- `std::env` via `Env`
- `std::fs` via `Fs` (if filesystem ships in v1)

Rule:

- If behavior depends on host APIs, wall-clock time, randomness, environment, IO, or external side effects, expose it through an effect.
- Always use @effect attributes with well defined ID's
- Pure convenience wrappers may sit on top of effect operations.

---

## 3) Error model and diagnostics

### 3.1 Canonical error objects

Module: `std::error`

```voyd
pub obj Utf8Error {
  api message: String
}

pub obj ParseIntError {
  api message: String
}

pub obj ParseFloatError {
  api message: String
}

pub obj DecodeError {
  api message: String
}

pub obj JsonError {
  api message: String
}

pub obj HostError {
  api code: i32
  api message: String
}

pub obj IoError {
  api code: i32
  api message: String
}
```

### 3.2 `Error` trait

```voyd
pub trait Error<T>
  fn message(self) -> String
```

### 3.3 Panic

```voyd
pub fn panic({ message: StringSlice }) -> void
```

`panic` is trapping and does not return at runtime.

---

## 4) Formatting

Module: `std::fmt`

### 4.1 Traits

```voyd
pub trait Formatter
  fn write_str(self, { s: StringSlice }) -> void
  fn write_char(self, { c: i32 }) -> void

pub trait Debug<T>
  fn fmt_debug(self, { into: Formatter }) -> void

pub trait Display<T>
  fn fmt_display(self, { into: Formatter }) -> void
```

### 4.2 `format`

```voyd
pub fn format({ fmt: StringSlice, args: FmtArgs }) -> String
```

`FmtArgs` is an opaque compiler-lowered type produced by formatting lowering.

---

## 5) Logging

Module: `std::log`

### 5.1 Types (union-based)

```voyd
pub obj LogTrace {}
pub obj LogDebug {}
pub obj LogInfo {}
pub obj LogWarn {}
pub obj LogError {}

pub type LogLevel = LogTrace | LogDebug | LogInfo | LogWarn | LogError

pub obj LogString {
  api value: String
}

pub obj LogInt {
  api value: i64
}

pub obj LogFloat {
  api value: f64
}

pub obj LogBool {
  api value: bool
}

pub type LogFieldValue = LogString | LogInt | LogFloat | LogBool

pub obj LogField {
  api key: String
  api value: LogFieldValue
}

pub type LogFields = Array<LogField>
```

### 5.2 Log effect + helpers

```voyd
@effect(id: "std::log::Log")
pub eff Log
  emit(tail, level: LogLevel, message: String, fields?: LogFields) -> void

pub fn trace({ message: StringSlice }): Log -> void
pub fn trace({ message: StringSlice, fields: LogFields }): Log -> void

pub fn debug({ message: StringSlice }): Log -> void
pub fn debug({ message: StringSlice, fields: LogFields }): Log -> void

pub fn info({ message: StringSlice }): Log -> void
pub fn info({ message: StringSlice, fields: LogFields }): Log -> void

pub fn warn({ message: StringSlice }): Log -> void
pub fn warn({ message: StringSlice, fields: LogFields }): Log -> void

pub fn error({ message: StringSlice }): Log -> void
pub fn error({ message: StringSlice, fields: LogFields }): Log -> void
```

`Log::emit` is host-backed.

---

## 6) Bytes and buffers

Module: `std::bytes`

Use `i32` byte values (`0..255`) for v1 compatibility with current std internals.

```voyd
pub type Byte = i32

pub obj Bytes {}

impl Bytes
  api fn len(self) -> i32
  api fn is_empty(self) -> bool
  api fn get(self, { at: i32 }) -> Option<Byte>
  api fn at(self, { at: i32 }) -> Byte
  api fn slice(self, { range: Range }) -> Bytes
  api fn to_array(self) -> Array<Byte>

pub obj ByteBuffer {}

impl ByteBuffer
  api fn init() -> ByteBuffer
  api fn with_capacity({ bytes: i32 }) -> ByteBuffer

  api fn len(self) -> i32
  api fn is_empty(self) -> bool
  api fn capacity(self) -> i32

  api fn as_bytes(self) -> Bytes

  api fn push(~self, { value: Byte }) -> void
  api fn extend(~self, { bytes: Bytes }) -> void
  api fn clear(~self) -> void
```

---

## 7) Encoding

### 7.1 Hex

Module: `std::encoding::hex`

```voyd
pub fn encode({ bytes: Bytes }) -> String
pub fn decode({ s: StringSlice }) -> Result<Bytes, DecodeError>
```

### 7.2 Base64

Module: `std::encoding::base64`

```voyd
pub fn encode({ bytes: Bytes }) -> String
pub fn decode({ s: StringSlice }) -> Result<Bytes, DecodeError>
```

---

## 8) Time (host-backed)

Module: `std::time`

### 8.1 Types

```voyd
pub obj Duration {}

impl Duration
  api fn from_millis({ ms: i64 }) -> Duration
  api fn from_secs({ s: i64 }) -> Duration
  api fn as_millis(self) -> i64
  api fn as_secs(self) -> i64

pub obj Instant {}

impl Instant
  api fn now(): Time -> Instant
  api fn elapsed(self): Time -> Duration

pub obj SystemTime {}

impl SystemTime
  api fn now(): Time -> SystemTime
  api fn unix_millis(self): Time -> i64
```

### 8.2 Time effect + sleep

```voyd
@effect(id: "std::time::Time")
pub eff Time
  monotonic_now_millis(tail) -> i64
  system_now_millis(tail) -> i64
  sleep_millis(tail, ms: i64) -> Result<void, HostError>

pub fn sleep({ duration: Duration }): Time -> Result<void, HostError>
```

All operations in `Time` are host-backed.

---

## 9) Random (host-backed)

Module: `std::random`

```voyd
@effect(id: "std::random::Random")
pub eff Random
  next_i64(tail) -> i64
  fill_bytes(tail, len: i32) -> Array<Byte>

pub fn next_i64(): Random -> i64
pub fn fill_bytes({ buf: ~ByteBuffer, len: i32 }): Random -> void

pub fn random_bool(): Random -> bool
pub fn random_int({ range: Range }): Random -> i32
```

All operations in `Random` are host-backed.

---

## 10) JSON

Module: `std::json`

### 10.1 `JsonValue` (union)

```voyd
pub obj JsonNull {}

pub obj JsonBool {
  api value: bool
}

pub obj JsonNumber {
  api value: f64
}

pub obj JsonString {
  api value: String
}

pub obj JsonArray {
  api value: Array<JsonValue>
}

pub obj JsonObject {
  api value: Dict<String, JsonValue>
}

pub type JsonValue = JsonNull | JsonBool | JsonNumber | JsonString | JsonArray | JsonObject
```

### 10.2 Parse/stringify

```voyd
pub fn parse({ s: StringSlice }) -> Result<JsonValue, JsonError>

pub fn stringify({ value: JsonValue }) -> String
pub fn stringify_pretty({ value: JsonValue }) -> String
```

---

## 11) Env/config (host-backed)

Module: `std::env`

```voyd
@effect(id: "std::env::Env")
pub eff Env
  get(tail, key: String) -> Option<String>
  set(tail, key: String, value: String) -> Result<void, HostError>

pub fn get({ key: StringSlice }): Env -> Option<String>
pub fn get_bool({ key: StringSlice }): Env -> Option<bool>
pub fn get_int({ key: StringSlice }): Env -> Option<i32>

pub fn set({ key: StringSlice, value: StringSlice }): Env -> Result<void, HostError>
```

`Env::get` / `Env::set` are host-backed. `get_bool` and `get_int` are parsing helpers on top of `get`.

---

## 12) Filesystem (optional v1, effect interface acceptable)

Modules: `std::fs` and optionally `std::path`

### 12.1 `Path`

```voyd
pub obj Path {}

impl Path
  api fn new({ s: StringSlice }) -> Path
  api fn as_string(self) -> String

  api fn join(self, { child: StringSlice }) -> Path
  api fn parent(self) -> Option<Path>
  api fn file_name(self) -> Option<String>
```

### 12.2 `Fs` effect + wrappers

```voyd
@effect(id: "std::fs::Fs")
pub eff Fs
  read_bytes(tail, path: Path) -> Result<Bytes, IoError>
  read_string(tail, path: Path) -> Result<String, IoError>
  write_bytes(tail, path: Path, bytes: Bytes) -> Result<void, IoError>
  write_string(tail, path: Path, s: String) -> Result<void, IoError>
  exists(tail, path: Path) -> bool
  list_dir(tail, path: Path) -> Result<Array<Path>, IoError>

pub fn read_bytes({ path: Path }): Fs -> Result<Bytes, IoError>
pub fn read_string({ path: Path }): Fs -> Result<String, IoError>

pub fn write_bytes({ path: Path, bytes: Bytes }): Fs -> Result<void, IoError>
pub fn write_string({ path: Path, s: StringSlice }): Fs -> Result<void, IoError>

pub fn exists({ path: Path }): Fs -> bool
pub fn list_dir({ path: Path }): Fs -> Result<Array<Path>, IoError>
```

All `Fs` operations are host-backed.

---

## 13) Version info

Module: `std::version`

Prefer zero-arg functions for now (unless compile-time constants are stabilized in surface syntax):

```voyd
pub fn std_version() -> String
pub fn language_version() -> String
```

Below is a **drop-in addition** to your spec that:

* Adds **`std::set`** and **`std::deque`** to the **Module layout (v1)** list.
* Defines their **public API** using your Voyd semantics (`obj` + `impl`, unions only via `type` aliases).
* Uses `::` paths, `{ ... }` labeled params, `<>` generics, optional params `?:`.
* Includes `///` doc comments for every **new** public API symbol (module, obj, impl methods, functions).

## 14) Set

Module: `std::set`

```voyd
/// A hash-based set of unique values.
///
/// Intended for membership tests, deduplication, and tracking “seen” values.
/// Requires element hashing and equality.
///
/// NOTE: Trait bounds are not expressible in this doc’s syntax; implement as
/// `T: Eq<T> + Hash<T>` (or the equivalent constraint mechanism in Voyd).
pub obj Set<T> {}

impl Set<T>
  /// Create an empty set.
  api fn init() -> Set<T>

  /// Number of elements in the set.
  api fn len(self) -> i32

  /// Returns true if the set contains no elements.
  api fn is_empty(self) -> bool

  /// Returns true if `value` is present in the set.
  api fn contains(self, { value: T }) -> bool

  /// Inserts `value` into the set.
  ///
  /// Returns true if the value was not already present.
  api fn insert(~self, { value: T }) -> bool

  /// Removes `value` from the set.
  ///
  /// Returns true if the value was present.
  api fn remove(~self, { value: T }) -> bool

  /// Removes all values from the set.
  api fn clear(~self) -> void

  /// Returns a lazy sequence of values in the set.
  ///
  /// Iteration order is unspecified.
  api fn values(self) -> Sequence<T>
```

## 15) Deque

Module: `std::deque`

```voyd
/// A double-ended queue.
///
/// Supports efficient pushes/pops at both ends.
/// Useful for work queues, BFS, buffering, and sliding windows.
pub obj Deque<T> {}

impl Deque<T>
  /// Create an empty deque.
  api fn init() -> Deque<T>

  /// Number of elements in the deque.
  api fn len(self) -> i32

  /// Returns true if the deque contains no elements.
  api fn is_empty(self) -> bool

  /// Push a value onto the front of the deque.
  api fn push_front(~self, { value: T }) -> void

  /// Push a value onto the back of the deque.
  api fn push_back(~self, { value: T }) -> void

  /// Pop a value from the front of the deque.
  api fn pop_front(~self) -> Option<T>

  /// Pop a value from the back of the deque.
  api fn pop_back(~self) -> Option<T>

  /// Peek the front value without removing it.
  api fn front(self) -> Option<T>

  /// Peek the back value without removing it.
  api fn back(self) -> Option<T>

  /// Removes all values from the deque.
  api fn clear(~self) -> void
```
