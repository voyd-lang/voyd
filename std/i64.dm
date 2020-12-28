use wasm.*

impl i64 {
    pure fn +(r: i64) -> i64 = unsafe {
        i64_add(this, r)
    }

    pure fn -(r: i64) -> i64 = unsafe {
        i64_sub(this, r)
    }

    pure fn /(r: i64) -> i64 = unsafe {
        i64_div_s(this, r)
    }

    pure fn *(r: i64) -> i64 = unsafe {
        i64_mul(this, r)
    }

    pure fn ==(r: i64) -> i64 = unsafe {
        i64_eq(this, r)
    }

    pure fn >(r: i64) -> i64 = unsafe {
        i64_gt_s(this, r)
    }

    pure fn <(r: i64) -> i64 = unsafe {
        i64_lt_s(this, r)
    }

    pure fn >=(r: i64) -> i64 = unsafe {
        i64_ge_s(this, r)
    }

    pure fn <=(r: i64) -> i64 = unsafe {
        i64_le_s(this, r)
    }

    pure fn and(r: i64) -> i64 = unsafe {
        i64_and(this, r)
    }

    pure fn or(r: i64) -> i64 = unsafe {
        i64_or(this, r)
    }
}
