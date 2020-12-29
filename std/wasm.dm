pub type i32 = wasm_type [id: "i32", size: 4]
pub type i64 = wasm_type [id: "i64", size: 8]

pub declare type Void

pub declare unsafe fn i32_clz(value: i32) -> i32
pub declare unsafe fn i32_ctz(value: i32) -> i32
pub declare unsafe fn i32_popcnt(value: i32) -> i32
pub declare unsafe fn i32_eqz(value: i32) -> i32
pub declare unsafe fn i32_add(left: i32, right: i32) -> i32
pub declare unsafe fn i32_sub(left: i32, right: i32) -> i32
pub declare unsafe fn i32_mul(left: i32, right: i32) -> i32
pub declare unsafe fn i32_div_s(left: i32, right: i32) -> i32
pub declare unsafe fn i32_div_u(left: i32, right: i32) -> i32
pub declare unsafe fn i32_rem_s(left: i32, right: i32) -> i32
pub declare unsafe fn i32_rem_u(left: i32, right: i32) -> i32
pub declare unsafe fn i32_and(left: i32, right: i32) -> i32
pub declare unsafe fn i32_or(left: i32, right: i32) -> i32
pub declare unsafe fn i32_xor(left: i32, right: i32) -> i32
pub declare unsafe fn i32_shl(left: i32, right: i32) -> i32
pub declare unsafe fn i32_shr_u(left: i32, right: i32) -> i32
pub declare unsafe fn i32_shr_s(left: i32, right: i32) -> i32
pub declare unsafe fn i32_rotl(left: i32, right: i32) -> i32
pub declare unsafe fn i32_rotr(left: i32, right: i32) -> i32
pub declare unsafe fn i32_eq(left: i32, right: i32) -> i32
pub declare unsafe fn i32_ne(left: i32, right: i32) -> i32
pub declare unsafe fn i32_lt_s(left: i32, right: i32) -> i32
pub declare unsafe fn i32_lt_u(left: i32, right: i32) -> i32
pub declare unsafe fn i32_le_s(left: i32, right: i32) -> i32
pub declare unsafe fn i32_le_u(left: i32, right: i32) -> i32
pub declare unsafe fn i32_gt_s(left: i32, right: i32) -> i32
pub declare unsafe fn i32_gt_u(left: i32, right: i32) -> i32
pub declare unsafe fn i32_ge_s(left: i32, right: i32) -> i32
pub declare unsafe fn i32_ge_u(left: i32, right: i32) -> i32
pub declare unsafe fn i32_load(index: i32) -> Void
pub declare unsafe fn i32_load8_u(index: i32) -> Void
pub declare unsafe fn i32_store(index: i32, value: i32) -> Void
pub declare unsafe fn i32_store8(index: i32, value: i32) -> Void

pub declare unsafe fn i64_clz(value: i64) -> i64
pub declare unsafe fn i64_ctz(value: i64) -> i64
pub declare unsafe fn i64_popcnt(value: i64) -> i64
pub declare unsafe fn i64_eqz(value: i64) -> i64
pub declare unsafe fn i64_add(left: i64, right: i64) -> i64
pub declare unsafe fn i64_sub(left: i64, right: i64) -> i64
pub declare unsafe fn i64_mul(left: i64, right: i64) -> i64
pub declare unsafe fn i64_div_s(left: i64, right: i64) -> i64
pub declare unsafe fn i64_div_u(left: i64, right: i64) -> i64
pub declare unsafe fn i64_rem_s(left: i64, right: i64) -> i64
pub declare unsafe fn i64_rem_u(left: i64, right: i64) -> i64
pub declare unsafe fn i64_and(left: i64, right: i64) -> i64
pub declare unsafe fn i64_or(left: i64, right: i64) -> i64
pub declare unsafe fn i64_xor(left: i64, right: i64) -> i64
pub declare unsafe fn i64_shl(left: i64, right: i64) -> i64
pub declare unsafe fn i64_shr_u(left: i64, right: i64) -> i64
pub declare unsafe fn i64_shr_s(left: i64, right: i64) -> i64
pub declare unsafe fn i64_rotl(left: i64, right: i64) -> i64
pub declare unsafe fn i64_rotr(left: i64, right: i64) -> i64
pub declare unsafe fn i64_eq(left: i64, right: i64) -> i64
pub declare unsafe fn i64_ne(left: i64, right: i64) -> i64
pub declare unsafe fn i64_lt_s(left: i64, right: i64) -> i64
pub declare unsafe fn i64_lt_u(left: i64, right: i64) -> i64
pub declare unsafe fn i64_le_s(left: i64, right: i64) -> i64
pub declare unsafe fn i64_le_u(left: i64, right: i64) -> i64
pub declare unsafe fn i64_gt_s(left: i64, right: i64) -> i64
pub declare unsafe fn i64_gt_u(left: i64, right: i64) -> i64
pub declare unsafe fn i64_ge_s(left: i64, right: i64) -> i64
pub declare unsafe fn i64_ge_u(left: i64, right: i64) -> i64
pub declare unsafe fn i64_load(index: i64) -> Void
pub declare unsafe fn i64_store(index: i64, value: i64) -> Void

pub declare unsafe fn mem_size() -> i32
pub declare unsafe fn mem_grow(pages: i32) -> i32
pub declare unsafe fn panic() -> Void

pub declare fn print(val: i32) -> Void
