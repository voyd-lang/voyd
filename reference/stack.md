# Stack Memory Layout

By default, structs are stored in linear memory using stack memory allocation.

Here is they byte layout of our stack:

- 0-7 (i64) Stack pointer
- 8+ (Any) Stack

# Stack Operations

For every function call the function should:
1. Allocate memory for the return using `stack_alloc`
2. Save the return address using `stack_return_address`
3. Allocate memory as needed for all locals using `stack_alloc`
4. Write the return value to the saved return address
5. Return from the function using `stack_return`
