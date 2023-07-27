# 26 July 2023

**Trailing lambda problem**

For awhile now I've been noticing an awkwardness in the language due
to the lack of elegant support for trailing arguments.

Take, for example, a hypothetical if/else or try/catch implementation (assume no macros).

```
if x < 3
  then:
    bloop()
    bleep()
  else:
    blop()

try
  this:
    can_throw()
  catch:
    ball()
```

This can be trivially solved with macros The issue is that this is a common pattern, and the average user shouldn't have to resort to macros almost ever.

Looking at this now, it's really not all that bad. But I'm wondering
if it would be worth it to complicate the language and add an operator that applies a line as if it were an argument to the preceding function call:

```
if x < 3 do
  bleep()
-else:
  bloop()

try do
  can_throw()
-catch:
  ball()

// Or

if x < 3 do
  bleep()
\else:
  bloop()

try do
  can_throw()
\catch: do // Should : be implicit?
  ball()

// Or

try do
  can_throw()
,catch: do // Should : be implicit?
  ball()
```

Note: this assumes `do` is a greedy prefix operator. If it wasn't
we could also use `do;`. Reminder that `;` is a greedy terminating operator, so all arguments on the right are applied to do.

**Other**

- Since effects abstract the concept of return, we no longer need to treat blocks as separate from
  functions. `block` can become `do` and `do` can be an alias for `() =>`
- If `:` were a greedy operator, it would implicitly `block` (i.e. `do`)
- Need to experiment.
- I really like how Koka uses a single letter for generics in the type definition for parameters
  that accept a function. Though I'm not a fan of single letter generics in the general sense,
  they're not great at communicating intention. Still worth considering.

# 25 July 2023

TODO: Investigate go like co-routines for use in the language.

# 24 July 2023

Memory semantics.

- Objects are pass by reference
- Everything else is pass by value
- Mutable variables cannot be captured by closures (Inspired by Koka)
- Objects are immutable by default
- There can only ever be one reference to a mutable entity
- Object dereferences are automatic

An object can be marked as mutable with `::mut`:

```
obj Point { x: Int, y: Int, z: Int }
let p = Point::mut { x: 1, y: 2, z: 3}
let p2 = p // Error!

fn square(p: Point::mut)
  p.x = p.x.square
  p.y = p.y.square
  p.z = p.z.square

impl Point
  fn square(self::mut)
    self.x = self.x.square
    self.y = self.y.square
    self.z = self.z.square

// Possible alternative for implicit self
impl Point::mut
  fn square()
    x = x.square
    y = y.square
    z = z.square
```

I'd also like to consider requiring parenthesis on any impure function (i.e. cannot look like a field access)

# 20 July 2023

The previous syntax change had some problems. So I've modified the rules of the language to
resolve some of the ambiguities (among other changes).

- The `=` sign separating a function signature is now optional. It should be used only for single
  line functions.
- Effects are now on the right side of `->`. A function signature is now `fn name() -> (effect return-type)`.
  This allows `->` to be treated as an operator and makes the `=` far less complex to implement.
- Generics are now defined with `::()`. This prevents us from needing to add hacks to the parser
  and makes the language much more predictable and uniform. Its also inline with the new FQCS
- Introduce FQCS inspired by rust
- Remove `=` from `obj` and `impl` defs.
- Objects now behave more similarly to Rust's structs. Though they are still reference types and
  can be extended, they now only define data. Traits define behavior and can only hold functions/methods. Methods must now be define
  inside of `impl`. For now, extensions must repeat all the items they inherit.
- Add Fully Qualified Call Syntax (FQCS) inspired by rust. Makes it possible to impl multiple traits
  with a method that has the same signature

Now all thats left is to:

- Decide casing convention once and for all
  - Native types lowercase? (i32 vs I32)
  - CamelCase?
- Decide on type spacing rules `a:i32` vs `a: i32`

# 9 July 2023

I'm making yet another major change to the syntax. All declaration statements will separate the
signature from the definition using an `=`. This is to improve syntactic consistency across the
language. I.E. Why do some declarations (`type`, `let`, etc) use an `=` while others (fn, obj, etc)
do not. It has the added bonus of making more complex `let` and `type` definitions easier to support
while also making single line functions more readable.

```
// Old syntax
fn add(a: i32, b: i32) -> i32
  a + b

// New syntax
fn add(a: i32, b: i32) -> i32 =
  a + b

// Looks a lot better when we use type inference
fn add(a: i32, b: i32) = a + b
```

I have an obscenely long history of making major syntax changes to this language. While this has
been substantially reduced in the last year, it is still an ongoing problem. This language would
likely be in a much more usable state years ago if I didn't have this habit. But its all for fun
in the end so I guess not much harm is done.

# 8 July 2023

Expanding on the previous entry. There are multiple reasons I've made this change.

- I wanted the type system to be as simple as possible while still having the potential to match
  the power of typescript's type system (with the added bonus of run time types)
- Having both `class` and `struct` and potentially different runtime behavioral characteristics was
  not ideal.
- Structs are stupidly difficult to model in wasm in a way that is both performant and works with a gc system.
  - Linear memory cannot hold reference types
  - Structs could leverage multi-value, but they are a pain to work with in binaryen. We'd also have to be smart about how we pass them around.

# 4 July 2023

I'm changing the type system again. Heavily inspired by the paper, [Integrating Nominal and Structural Subtyping](https://www.cs.cmu.edu/~aldrich/papers/ecoop08.pdf).

Here are the changes:

- Remove struct and class
- Add object types
  - Objects are nominal
- `type` defines a literal (structural) type (essentially an alias)
- Literal types are structural, object types are nominal
- Most user types are assumed to be heap types now. Will need new /custom syntax do define stack types. Do not be afraid to make these more verbose and difficult to use, that is webassembly's fault, not yours.

The main benefit to this change is it is much simpler to understand, will likely be more fun write while also being more maintainable. Thee performance impact is worth the expressiveness. You can always use the more complex stack type system when you need the performance.

# 5 Dec 2022

**Changes:**

- Greedy operators (`;`, `=`, `=>`, etc) are much smarter now.

When next expression directly follows a greedy op, child expressions of the line are treated as
arguments of that expression. When the next expression is a child expression of the line, they become
part of a block
