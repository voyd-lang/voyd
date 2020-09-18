# Dream

An experimental language targeting WebAssembly.

```rust
/** Find the value of the fibonacci sequence at index n */
fn fib(n: i32) -> i32 =
    if n < 2 { n }
    else { fib(n - 1) + fib(n - 2) }

/** All binary programs have a main function */
fn main() -> Void = {
    var index = 0
    while index <= 15 {
        // Print fibonacci sequence at index using UFCS. Also supports standard print(fib(index)) syntax.
        index.fib().print()
        index = index + 1
    }
}
```

Language Goal:
Make writing WASM apps a delight for individuals and teams alike.

Features:
- First class WebAssembly support
- Simple interop with TypeScript / JavaScript
- Expressive syntax
- Support for OOP and Functional paradigms
- Strongly typed, with type inference
- Macros
- Optional GC

Core values:
- Developer satisfaction
- Predictable syntax and APIs
- First class WebAssembly support
- Play nice with others
- Fast performance
- Prefer existing standards when possible
- Quality libraries for web, server, and graphic applications.

# CLI Installation Usage

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
