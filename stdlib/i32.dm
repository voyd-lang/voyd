
declare type i32

impl i32 {
    pure fn +(r: i32) = unsafe {
        i32_add(self, r)
    }

    pure fn -(r: i32) = unsafe {
        i32_sub(self, r)
    }

    pure fn /(r: i32) = unsafe {
        i32_div_s(self, r)
    }

    pure fn *(r: i32) = unsafe {
        i32_mul(self, r)
    }

    pure fn ==(r: i32) = unsafe {
        i32_eq(self, r)
    }

    pure fn >(r: i32) = unsafe {
        i32_gt_s(self, r)
    }

    pure fn <(r: i32) = unsafe {
        i32_lt_s(self, r)
    }

    pure fn >=(r: i32) = unsafe {
        i32_ge_s(self, r)
    }

    pure fn <=(r: i32) = unsafe {
        i32_le_s(self, r)
    }

    pure fn and(r: i32) = unsafe {
        i32_and(self, r)
    }

    pure fn or(r: i32) = unsafe {
        i32_or(self, r)
    }
}

declare unsafe fn i32_clz(value: i32) -> i32
declare unsafe fn i32_ctz(value: i32) -> i32
declare unsafe fn i32_popcnt(value: i32) -> i32
declare unsafe fn i32_eqz(value: i32) -> i32
declare unsafe fn i32_add(left: i32, right: i32) -> i32
declare unsafe fn i32_sub(left: i32, right: i32) -> i32
declare unsafe fn i32_mul(left: i32, right: i32) -> i32
declare unsafe fn i32_div_s(left: i32, right: i32) -> i32
declare unsafe fn i32_div_u(left: i32, right: i32) -> i32
declare unsafe fn i32_rem_s(left: i32, right: i32) -> i32
declare unsafe fn i32_rem_u(left: i32, right: i32) -> i32
declare unsafe fn i32_and(left: i32, right: i32) -> i32
declare unsafe fn i32_or(left: i32, right: i32) -> i32
declare unsafe fn i32_xor(left: i32, right: i32) -> i32
declare unsafe fn i32_shl(left: i32, right: i32) -> i32
declare unsafe fn i32_shr_u(left: i32, right: i32) -> i32
declare unsafe fn i32_shr_s(left: i32, right: i32) -> i32
declare unsafe fn i32_rotl(left: i32, right: i32) -> i32
declare unsafe fn i32_rotr(left: i32, right: i32) -> i32
declare unsafe fn i32_eq(left: i32, right: i32) -> i32
declare unsafe fn i32_ne(left: i32, right: i32) -> i32
declare unsafe fn i32_lt_s(left: i32, right: i32) -> i32
declare unsafe fn i32_lt_u(left: i32, right: i32) -> i32
declare unsafe fn i32_le_s(left: i32, right: i32) -> i32
declare unsafe fn i32_le_u(left: i32, right: i32) -> i32
declare unsafe fn i32_gt_s(left: i32, right: i32) -> i32
declare unsafe fn i32_gt_u(left: i32, right: i32) -> i32
declare unsafe fn i32_ge_s(left: i32, right: i32) -> i32
declare unsafe fn i32_ge_u(left: i32, right: i32) -> i32
