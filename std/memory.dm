use i32.*
use wasm.*

// Returns the stack pointer
pub unsafe fn stack_frame_start() -> i32 {
    // Save the active frame address
    let frame_return_addr = get_frame_pointer()

    // Allocate the new frame
    let frame_start_addr = stack_alloc(4)
    set_frame_pointer(frame_start_addr)

    // Save the frame return address to the start of the new frame
    i32_store(frame_start_addr, frame_return_addr)

    // Return the stack pointer
    get_stack_pointer()
}

// Returns the stack pointer
pub unsafe fn stack_frame_return() -> i32 {
    let stack_return_addr = get_frame_pointer()

    // The frame return pointer is actually stored at the same location of the stack_return_addr
    set_frame_pointer(i32_load(stack_return_addr))
    set_stack_pointer(stack_return_addr)

    stack_return_addr
}

pub unsafe fn get_stack_pointer() -> i32 = i32_load(0)
pub unsafe fn get_frame_pointer() -> i32 = i32_load(4)
pub unsafe fn set_stack_pointer(val: i32) -> i32 = i32_store(0, val)
pub unsafe fn set_frame_pointer(val: i32) -> i32 = i32_store(4, val)

/* Returns the address of the pushed memory */
pub unsafe fn stack_alloc(size: i32) -> i32 {
    let addr = get_stack_pointer()
    let new_addr = addr + size
    ensure_mem_is_at_least(new_addr)
    set_stack_pointer(new_addr)
    addr
}

pub unsafe fn stack_copy(src: i32, dest: i32, size: i32) -> Void {
    var bytes_written = 0

    while bytes_written < size {
        i32_store8(
            src + dest,
            i32_load8_u(dest + bytes_written)
        )
        bytes_written = bytes_written + 1
    }
}

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
