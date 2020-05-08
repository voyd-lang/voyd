# Dream

An experimental language targeting WebAssembly.

```
def fib(n: i32) -> i32 {
    if n < 2 { return n }
    fib(n - 2) + fib(n - 1)
}

let count = 10
print(fib(count))
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
- [ ] Dot notation
- [ ] Method overloading
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

# Task List
- [ ] Get basic dir (IR) defined, plugged into compiler
- [ ] Support and use enums
  - [ ] Can be used in match
  - [ ] Can be used in if (val === Enum.variant)
  - [ ] Can have associated fields
- [ ] Support and use structs
- [ ] Generics expansion
- [ ] Basic std lib
  - [ ] Generically defined and implemented binary expression types. Allows us to remove hard-coded
