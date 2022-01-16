# Memory Management in Dream

Dream hopes to strike a balance between simple semantics and the performance of a compile time
memory management system like rust. Dream will implement an ownership system that may improve
performance over a standard GC by a little.

However Dream does not aim to compete with rust's more advanced memory management semantics. So
if you are looking for a zero overhead management memory system. Dream is not for you.

# GC agnostic

For now Dream will use the standard Javascript GC. Possibly with WASM gc if that ever becomes
standardized.

The language is designed to also work with a reference counting GC in the future. This may
improve performance.

# How Structs are Stored

For the time being all structs are stored on the heap. This is to keep the language implementation
simple. However, the syntax should allow for structs to be stored in stack memory in some cases.

In the future we may add a "sized" struct type that will allow for structs to be stored in stack.
Either through a language annotation or a trait type.

# Legacy Memory Docs

Below is the (at least soon to be) legacy memory docs. Phasing out for a simpler approach. For
now.

# Stack Memory Layout

All user definable dream value types (structs, tuples, and enums) are stored in wasm linear
memory using stack based allocation.

At the time of writing, wasm only supports 32 bit memory. Until 64 bit memory addressing
is supported indexes will use i32.

The stack is layed out as followed:
- 0-3 (i32) `stack_pointer` - Points to the top of the stack, which is also the top of the stack frame.
- 4-7 (i32) `frame_pointer`. Points to the start of the active stack frame.
- 8+ (Stack Frame) Stack Frames

A stack frame uses the following structure:
- 0-3 (i32) `frame_return`. Address of the start of the preceding frame.
- 4+ (Any) Stack frame data. Where all data is actually stored.

## Allocating A Stack Frame

A new stack frame should be created for every function call.

1. Push the current `frame_pointer` to the top of the stack. This becomes the `frame_return`
   value of our new stack frame.
2. Set the `frame_pointer` to the current `stack_pointer` address
3. Set the `stack_pointer` to `stack_pointer` + new stack frame size.

## Returning from a stack frame

A stack frame should be returned (unallocated) on function return.

1. Set `stack_pointer` to the value of `frame_pointer`.
2. Set the `frame_pointer` to the value of `frame_return`.
