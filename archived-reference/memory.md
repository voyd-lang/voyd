# Memory Management in Dream

Dream hopes to strike a balance between simple semantics and the performance of a compile time
memory management system like rust. Dream will implement a simple ownership system that may improve
performance over a standard GC by a little.

However Dream does not aim to compete with rust's more advanced memory management semantics. So
if you are looking for a zero overhead management memory system. Dream is not for you.

# Call Semantics

By default, regardless of the type, a parameter is passed by value. This means that the parameter
will be a copy of the value and cannot modify it's source.

```
var x = 1

fn increase_by_1(x: Int) -> Int {
   x += 1
}

increase_by_1(x)
print(x) // 1, increase_by_1 does not mutate x
```

This is true even for structs:
```
let target = [x: 1, y: 2, z: 3]

fn raise_z(target: Target, [by val: Int]) {
   target.z += val
}

raise_z(target, by: 10)
print(target.z) // 3, raise_z does not mutate target. It creates a copy of target and modifies the copy.
```

To the idiomatic way to make raise_z useful is to return a new value:
```
let target = [x: 1, y: 2, z: 3]

fn raise_z(target: Target, [by val: Int]) -> Target {
   target.z += val
   target
}

let new_target = raise_z(target, by: 10)
print(new_target.z) // 13
```

But what if the value you want to pass is huge? Copying the value might be expensive. Instead
you can pass a reference to the value by marking it with `&`:
```
let my_large_array = $(1, 2, 3, 4, 5, 6, 7, 8, 9, 10)

fn print_array(array: &Array(Int)) {
   for i in array {
      print(i)
   }
}
```

What if you need to mutate a reference to the value? Mark it with `&mut`:
```
var my_large_array = $(1, 2, 3, 4, 5, 6, 7, 8, 9, 10)

fn set_array_val(array: &mut Array(Int), index: Int, value: Int) {
   array.set(index, value)
}

set_array_val(&mut my_large_array, 5, 20)
print(my_large_array(5)) // 20
```

# Ownership

To maintain memory safety across threads, Dream uses a (very) simple ownership system.

How simple? If a function can be executed on a separate thread, it must be a `move` function.
This means only that the function cannot have `&mut` parameters.

For example:
```
// This function takes another function and calls it on a separate thread.
// Note: this example leaves out algebraic effect annotations that might be necessary
fn execute_on_thread(threaded_fn: move Fn() -> void) {
   let thread = Thread(threaded_fn)
   thread.start()
}

fn do_something() {
   // This function does something
}

execute_on_thread(do_something)

// Passing this function wouldn't work
fn do_something_else(thing: &mut Int) {
   // This function does something else
}

execute_on_thread(do_something_else) // ERROR: do_something_else has a &mut parameter
```


# Implementation details

## GC based

For now Dream will use the standard Javascript GC. Possibly with WASM gc if that ever becomes
standardized.

The language is designed to also work with a reference counting GC in the future. This may
improve performance.

## How Structs are Stored

For the time being all structs are stored on the heap. This is to keep the language implementation
simple. However, the syntax should allow for structs to be stored in stack memory in some cases.

In the future we may add a "sized" struct type that will allow for structs to be stored in a "stack".
Either through a language annotation or a trait type.

## The stack.

We leave the stack entirely in the hands of WASM for now. This means only wasm primitives are
stack types.

# Notes

- I believe we should have simple i32, i64, f32, f64, etc types that are all stored on the standard
wasm stack. However, the standard Int type should be presumed to be a BigInt and stored on the
heap.

# Legacy Memory Docs

Below is the (at least soon to be) legacy memory docs. Phasing out for a simpler approach. For
now.

## Stack Memory Layout

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

### Allocating A Stack Frame

A new stack frame should be created for every function call.

1. Push the current `frame_pointer` to the top of the stack. This becomes the `frame_return`
   value of our new stack frame.
2. Set the `frame_pointer` to the current `stack_pointer` address
3. Set the `stack_pointer` to `stack_pointer` + new stack frame size.

### Returning from a stack frame

A stack frame should be returned (unallocated) on function return.

1. Set `stack_pointer` to the value of `frame_pointer`.
2. Set the `frame_pointer` to the value of `frame_return`.
