# Visibility and Access Control

This document defines Voyd’s visibility model for types, members, and modules, and how package APIs are formed.

The goals are:

* **Safe by default**: nothing leaks across modules or packages unless explicitly allowed.
* **Ergonomic inside a package**: if you can see a type, you can usually use its non-private members.
* **Explicit public APIs**: only things listed in the package root (`index.voyd`) are visible to other packages.

---

## 1. Scopes and Levels

Voyd has three structural scopes:

* **Type / object** – the body of an `obj` and its `impl`s.
* **Module** – a `.voyd` file.
* **Package** – a directory tree (`src/` + `index.voyd`), imported by other packages.

On top of this, there are five effective *visibility levels* (conceptual, not all named explicitly):

| Level | Name            | Scope                                   |
| ----- | --------------- | --------------------------------------- |
| 0     | Object private  | Only the defining type/obj              |
| 1     | Module-private  | Only the defining module (file)         |
| 2     | Package-visible | Any module in the same package          |
| 3     | Public API      | Visible to other packages (via exports) |

Levels are *monotone*: you can always move “outward” by adding markers/exports, and “inward” by marking things private/protected, but not the other way around.

---

## 2. Top-Level Declarations

Top-level declarations include:

* types/objects (`obj`)
* functions (`fn`)
* type aliases, traits, etc.

### 2.1 Defaults

By default, any top-level declaration is **module-private** (level 1).

```voyd
// module_a.voyd
obj Internal { ... }       // module-private
fn helper() ...            // module-private
```

### 2.2 Package-visible (`pub`)

To make a top-level item visible to other modules in the *same package*, mark it `pub`:

```voyd
// module_a.voyd
pub obj Vec { ... }        // level 2 (package-visible)
pub fn make_vec() -> Vec { ... }  // level 2
```

Rules:

* `pub` on a top-level item:

  * makes it **package-visible (level 2)**;
  * it is *not* automatically visible to other packages.

Other modules in the same package can import these using normal `use`:

```voyd
// module_b.voyd
use src::module_a::Vec
use src::module_a::make_vec

fn f()
  let v = make_vec()   // OK
  let w: Vec = v       // OK
```

### 2.3 Public API (`pub use` in `index.voyd`)

Level 3 (public API) is controlled **exclusively** by the package root file, typically `index.voyd`.

Example:

```voyd
// pkg1/index.voyd
use src::module_a::all

pub use src::module_a::Vec
pub use src::module_a::make_vec

pub fn work() ...
```

Rules:

* Only items referenced in `pub use` (or `pub fn`, `pub obj` declared in `index.voyd` itself) are visible to other packages.
* Other packages can import using:

  ```voyd
  // pkg2/index.voyd
  use pkg::pkg1::all

  fn main()
    let v = make_vec()  // OK
    work()              // OK
  ```

---

## 3. Members: Fields and Methods

Members live inside objects (`obj`) and their `impl`s.

### 3.1 Base rule: internal visibility

Internal visibility (inside the same package) is derived from the *owning type*:

* If the type is **module-private**:

  * members default to **module-private** (level 1).
* If the type is **package-visible** (`pub obj`):

  * members default to **package-visible** (level 2):

    * any module in the same package that can see the type can also see its members.

Example:

```voyd
// module_a.voyd
pub obj Vec {
  x: i32,          // package-visible internally
  y: i32,          // package-visible internally
}
```

```voyd
// module_b.voyd
use src::module_a::Vec

fn g(v: Vec)
  v.x   // OK
  v.y   // OK
```

### 3.2 Narrowing visibility: `#`

Members can be made more restrictive than their type.

#### Object private (level 0)

Use `#` to restrict a member to the defining type only:

```voyd
pub obj Vec
  x: i32,
  #z: i32,    // private to Vec

impl Vec
  fn inc(self)
    self.x += 1      // OK
    self.z += 1      // OK
```

* `#` members are only accessible from:

  * methods in the same `obj`’s `impl`s.
* They are **not** accessible:

  * from other modules,
  * from other types (even in the same module),
  * from other packages.

### 3.3 API-visible members: `api`

Members can participate in the public API if explicitly marked `api`:

```voyd
pub obj Vec {
  api x: i32,        // candidate for external API
  y: i32,            // internal-only
  #z: i32,           // object-private
}

impl Vec
  fn triple(self)
    self.x * 3       // internal-only

  api fn double(self)
    self.x * 2       // candidate for external API
```

Semantics of `api`:

* **Inside the package**:

  * `api` does **not** change internal visibility; the member is still level 2 if the type is.
* **Across packages**:

  * only `api` members can be exposed at level 3 (public API).
  * non-`api` members are never visible to other packages.

---

## 4. Making Members Public API (Level 3)

To make a *member* (field or method) visible to other packages:

1. Its **type** must be package-visible and exported.
2. The member itself must be marked `api`.
3. You must export it in the package root, or use a sugar that does so.

### 4.1 Explicit member exports

```voyd
// pkg1/module_a.voyd
pub obj Vec {
  api x: i32,
  y: i32,
  #z: i32,
}

impl Vec
  api fn double(self)
    self.x * 2

pub fn make_vec()
  Vec { x: 1, y: 2, z: 3 }

fn make_hi()
  Hi {}
```

```voyd
// pkg1/index.voyd
use src::module_a::all

// Export type and constructor
pub use src::module_a::Vec
pub use src::module_a::make_vec

// Export specific api member(s)
pub use src::module_a::Vec.double
pub use src::module_a::Vec.x

pub fn work()
  let vec = make_vec()   // OK
  vec.x                  // OK (same package)
  vec.y                  // OK
  vec.z                  // ERROR (#z, private)
  make_hi()              // ERROR, module-private in module_a

fn hi()
  ...
```

From another package:

```voyd
// pkg2/index.voyd
use pkg::pkg1::all

fn main()
  work()               // OK
  hi()                 // ERROR, not exported

  let vec = make_vec() // OK

  vec.x        // OK: `api` + exported
  vec.double() // OK: `api` + exported

  vec.y        // ERROR: not `api`
  vec.z        // ERROR: private
  vec.triple() // ERROR: not `api` (internal-only)
```
---

## 5. `use` Behavior and Levels

`use` has different behavior depending on source and destination:

### 5.1 Within a package

```voyd
use src::module_a::all
```

* Imports all **package-visible** (`pub`) items from `module_a` into the current module’s scope.
* Does **not** import:

  * module-private items (no `pub`),
  * items that are only `private`/`#` inside types.

### 5.2 From another package

```voyd
use pkg::pkg1::all
```

* Imports all **public API** (level 3) items declared via `pub` and `pub use` in `pkg1/index.voyd`.
* Types imported this way may expose `api` members that have been exported (directly or via `use api` sugar).

---

## 6. Summary of Access Rules

Given:

* Caller location:

  * same type / descendant
  * same module
  * same package (different module)
  * different package
* Declaration:

  * type `T` is module-private or `pub`
  * member annotated with `#` / `private` / `api` / nothing
  * exported or not in `index.voyd`

Access is allowed if:

1. **Type visibility**

   * Caller must be able to see the type (`T`):

     * same module, or
     * same package and `pub obj T`, or
     * other package and `T` is exported from `index.voyd`.

2. **Member internal visibility**

   * If member is `#` / `private`:

     * Caller must be within the same type.
   * Otherwise:

     * Internal visibility is at most the type’s visibility:

       * module-private if `T` is module-private.
       * package-visible if `T` is `pub`.

3. **Member external visibility (level 3)**

   * Caller is in a different package.
   * Type is exported in `index.voyd`.
   * Member is marked `api`.
   * Member is exported (directly or via `use api` sugar):

     ```voyd
     pub use src::module_a::T.member
     // or
     pub use api src::module_a::T
     ```

If any of these conditions fail, access is rejected at compile time.
