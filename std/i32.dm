use wasm.*

impl i32 {
    pure fn +(r: i32) -> i32 = unsafe {
        i32_add(self, r)
    }

    pure fn -(r: i32) -> i32 = unsafe {
        i32_sub(self, r)
    }

    pure fn /(r: i32) -> i32 = unsafe {
        i32_div_s(self, r)
    }

    pure fn *(r: i32) -> i32 = unsafe {
        i32_mul(self, r)
    }

    pure fn ==(r: i32) -> i32 = unsafe {
        i32_eq(self, r)
    }

    pure fn >(r: i32) -> i32 = unsafe {
        i32_gt_s(self, r)
    }

    pure fn <(r: i32) -> i32 = unsafe {
        i32_lt_s(self, r)
    }

    pure fn >=(r: i32) -> i32 = unsafe {
        i32_ge_s(self, r)
    }

    pure fn <=(r: i32) -> i32 = unsafe {
        i32_le_s(self, r)
    }

    pure fn and(r: i32) -> i32 = unsafe {
        i32_and(self, r)
    }

    pure fn or(r: i32) -> i32 = unsafe {
        i32_or(self, r)
    }
}
