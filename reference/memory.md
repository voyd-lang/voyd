# Stack Memory Layout

All user definable dream value types (structs, tuples, and enums) are stored in wasm linear
memory using stack based allocation.

At the time of writing, wasm only supports 32 bit memory. Until 64 bit memory addressing
is supported indexes will use i32.

The stack is layed out as followed:
- 0-3 (i32) Stack Pointer. Points to the top of the stack, which is also the top of the stack frame.
- 4-7 (i32) Frame Pointer. Points to the start of the active stack frame.
- 8+ (Stack Frame) Stack Frames

A stack frame uses the following structure:
- 0-3 (i32) Frame return address. Address of the start of the preceding frame.
- 4+ (Any) Stack frame data. Where all data is actually stored.

## Allocating A Stack Frame

A new stack frame should be created on scope entry.

1. Save the current frame pointer as the `frame_return_address`
2. Set the frame pointer to the current stack pointer address
3. push the value of `frame_return_address` to the top of the stack

## Returning from a stack frame

A stack frame should be returned (unallocated) on scope exit

1. Save the current frame pointer value as `stack_return_address`
2. Set the frame pointer to the value of the `frame_return_address` located at the start of the stack frame.
3. Set the stack pointer to the value of `stack_return_address`.
