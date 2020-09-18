# Dream

An experimental WebAssembly language. Designed to make writing high performance
web apps fun for individuals and teams alike.

```rust
/** Find the value of the fibonacci sequence at index n */
fn fib(n: i32) -> i32 =
    if n < 2 { n }
    else { fib(n - 1) + fib(n - 2) }

/** All binary programs have a main function */
fn main() -> Void = {
    var index = 0
    while index <= 15 {

        // Print fibonacci sequence at index using UFCS.
        index.fib().print()

        // Standard call syntax is also supported.
        // i.e print(fib(index))

        index = index + 1
    }
}
```

**Disclaimer**
Dream is in it's very early stages and should not be used for production applications.
Most MVP features have not been implemented yet. The language does run and compile
though. So feel free to play around.

**Features:**
- First class WebAssembly support
- Expression oriented syntax
- UFCS
- Support for OOP and Functional paradigms
- Strongly typed, with type inference
- Macros
- Optional GC
- Simple interop with TypeScript / JavaScript
- Optional Pure and Unsafe function enforcement.

**Core values:**
- Developer satisfaction
- Predictable syntax and APIs
- First class WebAssembly support
- Play nice with others
- Fast performance
- Prefer existing standards when possible
- Quality libraries for web, server, and graphics applications.

# Getting Started

**Install**
```
npm i -g dreamc
```

**Usage**
```
dreamc path/to/code.dm
```

# Feature Support Check List
- [x] Methods
- [x] If statements
- [x] While loops
- [x] let / var statements
- [x] Dot notation
- [x] Method overloading
- [x] UFCS
- [ ] Enums
- [ ] Enums with associated values
- [ ] Type checker
- [ ] Structs
- [ ] Classes
- [ ] Match statements
- [ ] For In loops
- [ ] Anonymous structs
- [ ] Tuples
- [ ] Type aliasing
- [ ] Traits
- [ ] Macros
- [ ] Arrays, Strings, other dynamic data types
- [ ] Language server
- [ ] VSCode integration and tooling
- [ ] DOM Access
- [ ] UI Library
- [ ] Server Library
- [ ] NodeJS/Deno API bindings
- [ ] Multiple files
- [ ] ...?
