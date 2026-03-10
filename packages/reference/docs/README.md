---
order: 0
---

# Voyd

Voyd is a high performance WebAssembly language with an emphasis on full stack web development.

```rust
fn fib(n: i32) -> i32
  if n < 2:
    n
  else:
    fib(n - 1) + fib(n - 2)

pub fn main()
  fib(10)
```

**Features**:

- Functional
- Hybrid Nominal & Structural type system
- Algebraic effects
- First class wasm support
- Macros and language extensions
- Uniform function call syntax

**Guiding Principles**:

- Fun to write _and_ read.
- Predictability
- Hackability
- Balance a great developer experience with performance
- Play nice with others

## Getting Started

**Install**

```bash
npm i -g @voyd-lang/cli
```

**Usage Examples**

```bash
# Run the exported main function
voyd --run script.voyd

# Compile a directory (containing an index.voyd) to webassembly
voyd --emit-wasm src > output.wasm

# Compile to optimized WebAssembly
voyd --emit-wasm --opt src > output.wasm
```

**Requirements**

Currently requires node v22

```bash
# Or nvm
fnm install v22
```
