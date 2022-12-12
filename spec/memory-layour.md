# Memory Layout

## Stack / Linear Memory

Structs and unboxed types are stored in linear memory using a stack.

Each datum stored on the stack has the following layout:

- Byte 0-3, i32, Size - the size of the datum it represents
- Byte 4-7, i32, Type ID - An ID of the type the datum uses
- Byte 8+, any, The data.
