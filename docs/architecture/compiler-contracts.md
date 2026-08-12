# Compiler Contracts and Registered Implementations

Status: Current
Scope: compiler and standard-library integration

## Purpose

Compiler contracts give source declarations stable, compiler-owned roles without
making source names, module paths, or structural lookalikes part of compiler
semantics. They are reserved toolchain metadata, not user-extensible macros.

The mechanism has two annotations:

- `@compiler_contract` identifies a declaration whose meaning and shape are
  defined by the compiler.
- `@compiler_impl` registers a stable, versioned implementation of a
  compiler-contract trait.

## Contract declarations

A contract ID is globally stable and owned by the compiler. The compiler's
contract registry defines which declaration kind, generic parameters, members,
signatures, and effects are valid for that ID.

An ordinary function may fill a singular compiler role:

```voyd
@compiler_contract(id: "voyd.std.example.operation")
fn compiler_operation(value: i32) -> bool
  // ...
```

A trait may define a family of selectable implementations:

```voyd
@compiler_contract(id: "voyd.std.example-provider")
trait ExampleProvider<Input, Output>
  fn transform(value: Input) -> Output
```

The annotation attaches to the declaration, not to imported aliases. Unknown
IDs, invalid targets, duplicate providers for a singular role, and declarations
that do not match the registered contract are compile-time errors.

## Registered implementations

`@compiler_impl` may annotate only an implementation of a
`@compiler_contract` trait:

```voyd
obj DefaultExampleProvider {}

@compiler_impl(id: "voyd.std.example.default", version: 1)
impl ExampleProvider<String, Bytes> for DefaultExampleProvider
  fn transform(value: String) -> Bytes
    // ...
```

The implemented trait supplies the contract ID. The annotation supplies the
implementation ID and version. The stable identity is therefore:

```text
(contract ID, implementation ID, implementation version)
```

An implementation ID identifies the implementation, so it must not repeat the
trait's contract ID merely to restate that relationship. A selected identity
must resolve to exactly one linked implementation. Selection is exact; the
compiler does not substitute another version or infer an implementation from a
type or method name.

The compiler resolves concrete methods through semantic trait-implementation
metadata. It never searches for members by their source spelling. Generic trait
arguments and method specializations are taken from the resolved implementation
and exposed through `ProgramCodegenView` before code generation.

Each compiler contract may impose additional rules, such as package ownership,
a stateless implementation target, required secondary trait implementations,
or build-time selection. Those rules belong to the contract's compiler-side
specification rather than to the general annotation.

## Compatibility

Changing a contract ID or its compiler-defined meaning is a compiler/library
compatibility change. Renaming or moving a conforming declaration is not.

For a registered implementation, the version changes when behavior covered by
the contract becomes incompatible. Contract-specific protocol versions remain
separate from unrelated compiler or runtime ABI versions.
