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
