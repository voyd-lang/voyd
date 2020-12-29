use i32.*
use wasm.*

pub unsafe fn stack_return_address() -> i32 = i32_load(0)

pub unsafe fn stack_return(addr: i32) -> Void = i32_store(0, addr)

/* Returns the address of the pushed memory */
pub unsafe fn stack_alloc(size: i32) -> i32 {
    let addr = stack_return_address()
    let new_addr = addr + size
    ensure_mem_is_at_least(new_addr)
    i32_store(0, new_addr)
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
