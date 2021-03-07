use i32.*
use wasm.*

/*
Allocate a stack frame for a function call

@param size - Size in bytes to allocate.
@returns pointer to the allocated memory.
*/
pub unsafe fn stack_alloc(size: i32) -> i32 {
    let stack_pointer = get_stack_pointer()
    let frame_return = get_frame_pointer()

    // Push frame_return to top of stack
    i32_store(stack_pointer, frame_return)

    // Set frame_pointer to current stack_pointer value
    set_frame_pointer(stack_pointer)

    // Update stack_pointer
    let frame_return_storage_size = 4
    let new_stack_pointer = stack_pointer + frame_return_storage_size + size
    ensure_mem_is_at_least(new_stack_pointer)
    set_stack_pointer(new_stack_pointer)

    // Return the address of the memory
    stack_pointer + frame_return_storage_size
}

/*
Free memory of current stack frame for a function exit.
*/
pub unsafe fn stack_return() -> Void {
    let frame_pointer = get_frame_pointer()
    let frame_return = i32_load(frame_pointer)
    set_stack_pointer(frame_pointer)
    set_frame_pointer(frame_return)
}

pub unsafe fn memcpy(src: i32, dest: i32, size: i32) -> Void {
    var bytes_written = 0

    while bytes_written < size {
        i32_store8(
            dest + bytes_written,
            i32_load8_u(src + bytes_written)
        )
        bytes_written = bytes_written + 1
    }
}

pub unsafe fn get_stack_pointer() -> i32 = i32_load(0)
pub unsafe fn get_frame_pointer() -> i32 = i32_load(4)
pub unsafe fn set_stack_pointer(val: i32) -> i32 = i32_store(0, val)
pub unsafe fn set_frame_pointer(val: i32) -> i32 = i32_store(4, val)

/* Ensure memory is at lest the passed size in bytes */
fn unsafe ensure_mem_is_at_least(size: i32) -> Void {
    let cur_size = mem_size() * 65536
    let needed_mem = size - cur_size

    var pages_needed = 0
    while pages_needed * 65536 < needed_mem {
        pages_needed = pages_needed + 1
    }

    if pages_needed <= 0 { return }
    let result = mem_grow(pages_needed)
    if result < 0 { panic() }
}
