# 17 April 2024

**Effect Calling Syntax Tentative Decision**

Use normal function call syntax with explicit scoping.

```
// An effect can be defined on its own
effect name() -> String

// A trait can be used to group effects
trait Counter
  effect bump() -> void

  // Effects that are tail resumptive (always return), can be typed as normal functions
  fn get() -> i32

///////////
// Usage
//////////

fn hi(): name -> String
  "Hi, ${name()}"

fn count_to_three(): Counter -> i32
  Counter::bump()
  Counter::bump()
  Counter::bump()
  Counter::get()

// Effect functions can be brought into the function scope with `use` to reduce visual noise
fn count_to_four(): Counter -> i32
  use Counter::{ get, bump }
  bump()
  bump()
  bump()
  bump()
  get()
```


**Effect Calling Syntax Ideas**

Problem: How should an effect be called? Should special attention be
brought to the fact that a function is an effect?

Background, given:
```
// src/throws.voyd
effect State<T>
  ctl set(val: T) -> T
  ctl get() -> T
```

Possible solutions:

1. Normal function call syntax with implicit scoping

```
fn test(): State<i32> -> i32
  set(1)
```

2. Postfix symbol like `!`, implicit scoping

```
fn test(): State<i32> -> i32
  set!(1)
```

3. Prefix symbol such as `@`

```
fn test(): State<i32> -> i32
  @set(1)
```

4. Prefix identifier such as `do`

```
fn test(): State<i32> -> i32
  do set(1)
```

5. Normal function call syntax, explicit scoping

```
fn test(): State<i32> -> i32
  State<i32>.set(1)

// Or
fn test(): State<i32> -> i32
  use State<i32>::set
  set(1)

// Or
fn test(): State<i32>::set -> i32
  set(1)

// Or
use State<i32>::set
fn test(): State<i32>::set -> i32
  set(1)
```

**Valid ways to write a function**

```
pub fn hey(there: i32) -> what
  "there"

pub fn hey(there: i32): effect -> what
  "there"

pub fn hey(there: i32): effect -> what =
  "there"

pub fn hey(there: i32) -> what =
  "there"

pub fn hey(there: i32) = "there"
```

Might replace `=` with `=>`.

To get this to work, we need to make `->` and operator.

# 24 January 2024

Effect system implementation ideas:

```ts
type Get = () => number;
type Put = (value: number) => voyd;

const loop = (n: number) => {
  if (n === 0) return;
  put(get() + 1);
  return loop(n - 1);
};

// Effect functions
const get = (state, continuation) => continuation(state, state.value);
const put = (value, state, continuation) =>
  continuation({ ...state, value }, undefined);

// Transpiled loop function
const loop2 = (
  n: number,
  state: { value: number },
  continuation: (state: { value: number }) => voyd
) => {
  if (n === 0) return continuation(state, undefined);

  return get(state, (newState, result) =>
    put(result + 1, newState, (newerState) =>
      loop2(n - 1, newerState, continuation)
    )
  );
};

// Example usage
const initialState = { value: 0 };
loop(5, initialState, (finalState, result) => {
  console.log("Final State:", finalState);
  console.log("Result:", result);
});
```

# 14 August 2023

JavaScript / TS Pivot

JavaScript should be a first-class target. WASM is going to take awhile to get where I need it and
this move will make delivering MVP features much easier. It would have the affect of also making the
language a lot more practical / pragmatic.

Ideal features:

- Can natively import js/ts files
- Can emit typescript declaration files
- Supports ES Module Syntax natively?
- Handles function overloads cleanly
- Still easily supports WASM and potentially other sources while still providing a good DX
- A `module.voyd` format for configuration and exports etc

Open questions:

- Voyd supports _both_ named parameters _and_ objects and treats each one differently. How should
  this be handled? The best I can think of is that named parameters should be treated as objects
- Need to define a standard for tagged data structures.

# 30 July 2023

## Updated Rules For Parenthetical Elision

1. (Unchanged) Any line with more than one symbol is wrapped with parenthesis (if it does not
   already have them)

   ```voyd
   add 1 2

   // Becomes
   (add 1 2)
   ```

2. (Updated) Indented lines are wrapped in a block and passed as an argument to the preceding
   function call with one less indentation level, provided:

   1. There are no empty lines between the child and the parent
   2. The first child is not a named argument
   3. The parent is not wrapped in parenthesis

   ```voyd
   add 2
     mul 4 x

   // Becomes
   (add 2 (block
     (mul 4 x)))
   ```

3. (New) Isolated named arguments, that is named arguments that are on their own line, are applied
   to the preceding function call provided:

   1. There are no empty lines separating between the two
   2. The named argument is on the same indentation level, or 1 child indentation level as the
      preceding function call.

   ```
   try
     this_throws_an_error()
   catch(e):
     print(e)

   // Becomes
   (try
     (block (this_throws_an_error))
     (named catch (lambda (e) (block
       print(e)))))

   // Another example
   if x > y
     then: 3
     else: 5

   // Becomes
   (if (x > y)
     (named then 3)
     (named else 5))
   ```

4. (New) Greedy operators (`=`, `=>`, `|>`, `<|`, `;`) get special handling.

   1. Greedy operators consume indented child blocks, rather than the parent function call

      ```
      let x =
       if (x > y)
         then: 3
         else: 5

      // Becomes
      (let (= x
        (block
          (if (> x y)
            (named then 3)
            (named else 5)))))
      ```

   2. If an expression follows a greedy operator on the same line, a new line is inserted after the
      operator and each child line has an additional level of indentation supplied.

      ```
      let z = if x > y
        then: 3
        else: 5

      // Becomes
      let z =
        if x > y
          then: 3
          else: 5

      // Which in turn becomes
      (let (=
        z
        (block
          (if
            (> z y)
            (named then 3)
            (named else 5)))))
      ```

These new rules solve a number of problems in one go.

1. Trailing named arguments no longer need special handling or a different operator
2. Greedy operator rules are simplified
3. Named arguments can now properly accept blocks

Examples of improvements:

```
// Given
accept my: "favorite" stuff:
  do_work()
  again_for_me()

// Translation before new rules
(accept
  (named my "favorite")
  (named stuff (do_work)
  (again_for_me)))

// After new rules
(accept
  (named my "favorite")
  (named stuff
    (block
      (do_work)
      (again_for_me))))
```

## Named Argument Lambda Syntax

```

// Named arguments as lambda functions
fn call(~cb: (v: i32) -> void, val: i32)
  cb(5)

// Usage without accepting the parameter
call cb(): print("hey") 5

// Short for
call
  cb: () =>
    print("hey")
  5

```

Note how `:` is not a consuming operator. There's just no way I can think of to make that work well.
It conflicts to heavily with how we define parameters. (parameters definitions would consume each
other).

# 28 July 2023

Just defined this:

When a named arguments act like a lambda function, and can take parameters:

```
fn call(cb: (v: i32) -> void)
  cb(5)

call cb(v):
  print(v)

// Equivalent to
call cb: (v) =>
  print
```

**Edit 30 July 2023** Ignore the following paragraph

Will require semi-colons to be consuming operators, which would mean that ether those shouldn't work
in parenthesis (which I think maybe should be the case anyway event though it isnt right now). Now
that I'm writing this, it may not work. but would be very nice to provide symmetry with `;` which
could do the same thing but be trailing.

# 26 July 2023

**Trailing lambda problem**

For awhile now I've been noticing an awkwardness in the language due to the lack of elegant support
for trailing arguments.

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

This can be trivially solved with macros The issue is that this is a common pattern, and the average
user shouldn't have to resort to macros almost ever.

Looking at this now, it's really not all that bad. But I'm wondering if it would be worth it to
complicate the language and add an operator that applies a line as if it were an argument to the
preceding function call:

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

Note: this assumes `do` is a greedy prefix operator. If it wasn't we could also use `do;`. Reminder
that `;` is a greedy terminating operator, so all arguments on the right are applied to do.

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

I'd also like to consider requiring parenthesis on any impure function (i.e. cannot look like a
field access)

# 20 July 2023

The previous syntax change had some problems. So I've modified the rules of the language to resolve
some of the ambiguities (among other changes).

- The `=` sign separating a function signature is now optional. It should be used only for single
  line functions.
- Effects are now on the right side of `->`. A function signature is now `fn name() -> (effect
return-type)`. This allows `->` to be treated as an operator and makes the `=` far less complex to
  implement.
- Generics are now defined with `::()`. This prevents us from needing to add hacks to the parser and
  makes the language much more predictable and uniform. Its also inline with the new FQCS
- Introduce FQCS inspired by rust
- Remove `=` from `obj` and `impl` defs.
- Objects now behave more similarly to Rust's structs. Though they are still reference types and can
  be extended, they now only define data. Traits define behavior and can only hold
  functions/methods. Methods must now be define inside of `impl`. For now, extensions must repeat
  all the items they inherit.
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
likely be in a much more usable state years ago if I didn't have this habit. But its all for fun in
the end so I guess not much harm is done.

# 8 July 2023

Expanding on the previous entry. There are multiple reasons I've made this change.

- I wanted the type system to be as simple as possible while still having the potential to match the
  power of typescript's type system (with the added bonus of run time types)
- Having both `class` and `struct` and potentially different runtime behavioral characteristics was
  not ideal.
- Structs are stupidly difficult to model in wasm in a way that is both performant and works with a
  gc system.
  - Linear memory cannot hold reference types
  - Structs could leverage multi-value, but they are a pain to work with in binaryen. We'd also have
    to be smart about how we pass them around.

# 4 July 2023

I'm changing the type system again. Heavily inspired by the paper, [Integrating Nominal and
Structural Subtyping](https://www.cs.cmu.edu/~aldrich/papers/ecoop08.pdf).

Here are the changes:

- Remove struct and class
- Add object types
  - Objects are nominal
- `type` defines a literal (structural) type (essentially an alias)
- Literal types are structural, object types are nominal
- Most user types are assumed to be heap types now. Will need new /custom syntax do define stack
  types. Do not be afraid to make these more verbose and difficult to use, that is webassembly's
  fault, not yours.

The main benefit to this change is it is much simpler to understand, will likely be more fun write
while also being more maintainable. Thee performance impact is worth the expressiveness. You can
always use the more complex stack type system when you need the performance.

# 5 Dec 2022

**Changes:**

- Greedy operators (`;`, `=`, `=>`, etc) are much smarter now.

When next expression directly follows a greedy op, child expressions of the line are treated as
arguments of that expression. When the next expression is a child expression of the line, they
become part of a block
