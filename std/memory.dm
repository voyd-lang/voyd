use wasm.*
use i64.*

pub unsafe fn stack_return_address() -> i64 = i64_load(0)

pub unsafe fn stack_return(addr: 164) -> Void = i64_store(0, addr)

/* Returns the address of the pushed memory */
pub unsafe fn stack_alloc(size: i64) -> i64 {
    let addr = stack_return_address()
    i64_store(0, addr + size)
    addr
}
