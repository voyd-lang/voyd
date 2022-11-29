# Dream

An experimental WebAssembly language. Designed to make writing high performance
web apps fun for individuals and teams alike.

https://justforfunnoreally.dev/

```dm
; Find the value of the fibonacci sequence at index n
fn fib(n:i32) -> i32
    if (n < 2)
        n
        fib(n - 1) + fib(n - 2)

; All binary programs have a main function
fn main() -> Void
    var index = 0
    for num in range(15)
        ; Print fibonacci sequence at index using UFCS.
        num.fib().print()
```

**Disclaimer**
Dream is in it's very early stages and should not be used for production applications.
Most MVP features have not been implemented yet. The language does run and compile
though. So feel free to play around.

**Core values:**

- Developer satisfaction
- Predictability
- Balance between performance and simplicity. Zero-Cost abstractions is a non-goal.
- First class WebAssembly support
- Play nice with others
- Fast performance
- Prefer existing standards when possible
- Quality libraries for web, server, and graphics applications.

**Features:**

- [x] Fn syntax
- [x] Primitive `macro`
- [x] Infix support
- [x] Standard function notation
- [x] Parenthetical elision
- [x] UFCS (dot notation)
- [ ] Variables
- [x] If statements
- [x] WASM code generation
- [x] Function overloading
- [ ] Booleans
- [ ] Tail recursion
- [ ] Generics
- [ ] Modules 🚧
- [ ] Std library
- [ ] Type checking
- [ ] Type inference
- [ ] Match statements
- [ ] Loops
- [ ] Algebraic data types
- [ ] Algebraic effects
- [ ] GC
- [ ] Classes / Box structs
- [ ] Traits
- [ ] String literals 🚧
- [ ] Struct literals 🚧
- [ ] Tuple literals 🚧
- [ ] Array literals 🚧
- [ ] Named arguments
- [ ] Rest parameters
- [ ] WASM module function exports
- [ ] Access control (public / private etc)
- [x] Comments
- [ ] Scoping / (Namespacing?)
- [ ] Syntax Highlighting
- [ ] Language Sever Protocol
- [ ] Website
- [ ] Debugger

# Getting Started

**Install**

```
npm i -g dreamc
```

**Usage**

```
dreamc path/to/code.dm
```

# Documentation

To get a feel of the language, check out the [overview.md file](./overview.md).

For an in depth language guide, check out the [reference folder](./reference).
