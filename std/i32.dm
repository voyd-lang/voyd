use wasm.*

impl i32 {
    pure fn +(r: i32) -> i32 = unsafe {
        i32_add(this, r)
    }

    pure fn -(r: i32) -> i32 = unsafe {
        i32_sub(this, r)
    }

    pure fn /(r: i32) -> i32 = unsafe {
        i32_div_s(this, r)
    }

    pure fn *(r: i32) -> i32 = unsafe {
        i32_mul(this, r)
    }

    pure fn ==(r: i32) -> i32 = unsafe {
        i32_eq(this, r)
    }

    pure fn >(r: i32) -> i32 = unsafe {
        i32_gt_s(this, r)
    }

    pure fn <(r: i32) -> i32 = unsafe {
        i32_lt_s(this, r)
    }

    pure fn >=(r: i32) -> i32 = unsafe {
        i32_ge_s(this, r)
    }

    pure fn <=(r: i32) -> i32 = unsafe {
        i32_le_s(this, r)
    }

    pure fn and(r: i32) -> i32 = unsafe {
        i32_and(this, r)
    }

    pure fn or(r: i32) -> i32 = unsafe {
        i32_or(this, r)
    }
}
